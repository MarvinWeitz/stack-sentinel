import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/cli.js';
import { applyFix } from '../src/fix/edits.js';
import { githubProvider } from '../src/fix/github.js';
import { azureProvider } from '../src/fix/azure.js';
import { applyFixes, detectProvider, openPullRequests } from '../src/fix/index.js';
import { applyGroup, marker, planFixes, pullRequestBody, readMarker } from '../src/fix/plan.js';
import { teamsPayload } from '../src/notifiers/webhook.js';
import { resolveSettings } from '../src/settings.js';

const fixture = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const now = new Date('2026-10-11T00:00:00Z');
const ui5Config = { checks: ['ui5-version'], ui5: { feed: fixture('versionoverview.json') } };
const offline = async () => { throw new Error('network must not be used'); };
const ui5Report = (root) => scan({ root: fixture(root), now, config: ui5Config, fetchJsonImpl: offline });
const finding = (fix, version, file = 'f') => ({ check: 'x', severity: 'warn', file, version, message: 'm', fix });

// ---------- edits ----------

test('ui5.yaml: changes framework.version and the preview version, keeping quotes and comments', () => {
  const yaml = 'framework:\n  name: SAPUI5\n  version: "1.120.51" # pinned\n';
  assert.equal(applyFix(yaml, finding({ kind: 'ui5-framework', to: '1.148.12' }, '1.120.51')).text, 'framework:\n  name: SAPUI5\n  version: "1.148.12" # pinned\n');
  assert.match(applyFix(yaml, finding({ kind: 'ui5-framework', to: '1.148.12' }, '1.120.50')).skipped, /not found/);
  const preview = 'server:\r\n  customMiddleware:\r\n    - name: fiori-tools-proxy\r\n      configuration:\r\n        ui5:\r\n          version: 1.120.51\r\n';
  assert.equal(applyFix(preview, finding({ kind: 'ui5-preview', to: '1.148.12' }, '1.120.51')).text, preview.replace('1.120.51', '1.148.12'));
});

test('bootstrap: rewrites the version in the URL, or adds one where none is set', () => {
  const html = '<script src="https://ui5.sap.com/1.108.45/resources/sap-ui-core.js"></script>';
  assert.equal(applyFix(html, finding({ kind: 'ui5-bootstrap', to: '1.148.12', host: 'ui5.sap.com' }, '1.108.45')).text,
    '<script src="https://ui5.sap.com/1.148.12/resources/sap-ui-core.js"></script>');
  const latest = '<script src="https://sapui5.hana.ondemand.com/resources/sap-ui-core.js"></script>';
  assert.equal(applyFix(latest, finding({ kind: 'ui5-bootstrap', to: '1.148.12', host: 'sapui5.hana.ondemand.com' }, undefined)).text,
    '<script src="https://sapui5.hana.ondemand.com/1.148.12/resources/sap-ui-core.js"></script>');
  assert.ok(applyFix(latest, finding({ kind: 'ui5-bootstrap', to: '1.148.12', host: 'ui5.sap.com' }, undefined)).skipped);
});

test('manifest.json: changes or adds the Work Zone pin, and checks the result still reads', () => {
  const pinned = '{\n  "sap.platform.cf": { "ui5VersionNumber": "1.120.x" }\n}\n';
  assert.equal(applyFix(pinned, finding({ kind: 'ui5-workzone', to: '1.148.x' }, '1.120.x')).text, pinned.replace('1.120.x', '1.148.x'));
  const missing = '{\n\t"sap.app": { "id": "a" },\n\t"sap.cloud": { "service": "a" }\n}\n';
  const added = applyFix(missing, finding({ kind: 'ui5-workzone-missing', to: '1.148.x' })).text;
  assert.equal(added, '{\n\t"sap.app": { "id": "a" },\n\t"sap.cloud": { "service": "a" },\n\t"sap.platform.cf": {\n\t\t"ui5VersionNumber": "1.148.x"\n\t}\n}\n');
  const block = '{\n  "sap.platform.cf": {\n    "oAuthScopes": []\n  }\n}';
  assert.deepEqual(JSON.parse(applyFix(block, finding({ kind: 'ui5-workzone-missing', to: '1.148.x' })).text)['sap.platform.cf'], { ui5VersionNumber: '1.148.x', oAuthScopes: [] });
  const empty = '{ "sap.platform.cf": {} }';
  assert.deepEqual(JSON.parse(applyFix(empty, finding({ kind: 'ui5-workzone-missing', to: '1.148.x' })).text)['sap.platform.cf'], { ui5VersionNumber: '1.148.x' });
  assert.ok(applyFix('not json', finding({ kind: 'ui5-workzone-missing', to: '1.148.x' })).skipped);
});

test('package.json: removes an override and what is left empty, only in the layout npm writes', () => {
  const pkg = (o) => `${JSON.stringify({ name: 'a', overrides: o }, null, 2)}\n`;
  const remove = (text, path) => applyFix(text, finding({ kind: 'npm-override-remove', path }));
  assert.equal(remove(pkg({ a: '1', b: '2' }), ['a']).text, pkg({ b: '2' }));
  assert.equal(remove(pkg({ x: { b: '2' } }), ['x', 'b']).text, `${JSON.stringify({ name: 'a' }, null, 2)}\n`);
  assert.equal(remove(pkg({ x: { '.': '1', b: '2' } }), ['x', '.']).text, pkg({ x: { b: '2' } }));
  assert.match(remove(pkg({ b: '2' }), ['a']).skipped, /not there/);
  assert.match(remove('{ "overrides": { "a": "1" } }', ['a']).skipped, /laid out/);
});

// ---------- planning ----------

test('groups fixes per kind; the change that moves furthest wins for one place', async () => {
  const report = await ui5Report('app');
  const groups = planFixes(report.findings);
  assert.deepEqual(groups.map((g) => [g.id, g.title]), [['ui5', 'Update UI5 to 1.148.12']]);
  // ui5.yaml has a newer patch (1.120.52) and a line to leave (1.148.12): one change, to 1.148.12
  assert.deepEqual(groups[0].changes.map((c) => [c.file, c.finding.fix.to]), [['ui5.yaml', '1.148.12'], ['webapp/index.html', '1.148.12']]);
  // minUI5Version is never changed
  assert.ok(!report.findings.some((f) => f.source === 'minUI5Version' && f.fix));
  assert.deepEqual(planFixes(report.findings, { fixOn: 'error' })[0].changes.map((c) => c.file), ['webapp/index.html']);
  assert.deepEqual(planFixes(report.findings, { only: ['npm-overrides'] }), []);
  assert.equal(readMarker(`x\n${marker(groups[0])}`), 'ui5 1.148.12');
});

test('applies a group to the files as given and reports what did not apply', async () => {
  const report = await ui5Report('app');
  const [group] = planFixes(report.findings);
  const { files, skipped } = await applyGroup(group, async (file) => (file === 'ui5.yaml' ? 'framework:\n  version: 1.120.0\n' : readFile(fixture(`app/${file}`), 'utf8')));
  assert.deepEqual([...files.keys()], ['webapp/index.html']);
  assert.deepEqual(skipped.map((s) => [s.change.file, s.reason]), [['ui5.yaml', 'version 1.120.51 not found']]);
  const body = pullRequestBody(group, group.changes, { ...report, links: { run: 'https://run' } });
  assert.match(body, /\| `ui5\.yaml` \| `1\.120\.51` → `1\.148\.12` \|/);
  assert.match(body, /UI5 1\.148 is in long-term maintenance until 2027-09-30\./);
  assert.match(body, /<!-- stack-sentinel-fix: ui5 1\.148\.12 -->$/);
});

test('unneeded npm overrides become their own group', async () => {
  const report = await scan({
    root: fixture('audit-overrides'), now, config: { checks: ['npm-audit'] },
    postJsonImpl: async () => ({}),
  });
  const groups = planFixes(report.findings);
  assert.deepEqual(groups.map((g) => g.title), ['Remove 2 unneeded npm overrides']);
  const { files } = await applyGroup(groups[0], (file) => readFile(fixture(`audit-overrides/${file}`), 'utf8'));
  assert.equal(JSON.parse(files.get('package.json')).overrides, undefined);
});

test('fix mode "apply" changes the scanned files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-fix-'));
  try {
    await cp(fixture('app'), dir, { recursive: true });
    const report = await scan({ root: dir, now, config: ui5Config, fetchJsonImpl: offline });
    const [result] = await applyFixes(report, dir, { fixOn: 'info' });
    assert.deepEqual(result.files, ['ui5.yaml', 'webapp/index.html']);
    assert.match(await readFile(join(dir, 'ui5.yaml'), 'utf8'), /version: "1\.148\.12"/);
    const again = await scan({ root: dir, now, config: ui5Config, fetchJsonImpl: offline });
    assert.deepEqual(planFixes(again.findings), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- pull requests ----------

/** A provider that keeps branches and pull requests in memory. */
function fakeProvider(files, prs = []) {
  const branches = new Map();
  const calls = [];
  return {
    calls, branches, prs,
    defaultBranch: async () => 'main',
    readFile: async (branch, path) => files[path] ?? null,
    findPullRequests: async (prefix) => prs.filter((p) => p.branch.startsWith(prefix)),
    async writeBranch(branch, base, changed) {
      const content = JSON.stringify([...changed]);
      const before = branches.get(branch);
      branches.set(branch, content);
      calls.push(['write', branch]);
      return before === content ? 'unchanged' : before ? 'updated' : 'created';
    },
    async createPullRequest({ branch, title, body }) {
      const pr = { id: prs.length + 1, branch, state: 'open', title, body, url: `https://pr/${prs.length + 1}` };
      prs.push(pr);
      calls.push(['create', title]);
      return pr;
    },
    async updatePullRequest(pr, { title, body }) {
      Object.assign(pr, { title, body });
      calls.push(['update', pr.id]);
    },
    async closePullRequest(pr) {
      pr.state = 'closed';
      calls.push(['close', pr.id]);
    },
  };
}

// the fixture sits inside this repository, so its files are named from the repository's top
const appFiles = async () => ({
  'test/fixtures/app/ui5.yaml': await readFile(fixture('app/ui5.yaml'), 'utf8'),
  'test/fixtures/app/webapp/index.html': await readFile(fixture('app/webapp/index.html'), 'utf8'),
});
const opts = (provider) => ({ provider, fixOn: 'info', branchPrefix: 'stack-sentinel/', maxPullRequests: 5 });

test('opens one pull request per group, and the next run updates it instead of opening another', async () => {
  const report = await ui5Report('app');
  const provider = fakeProvider(await appFiles());
  const first = await openPullRequests(report, fixture('app'), opts(provider));
  assert.deepEqual(first.map((r) => [r.action, r.title, r.url]), [['created', 'Update UI5 to 1.148.12', 'https://pr/1']]);
  assert.deepEqual([...provider.branches.keys()], ['stack-sentinel/ui5']);
  const second = await openPullRequests({ ...report, links: { run: 'https://run/2' } }, fixture('app'), opts(provider));
  assert.deepEqual(second.map((r) => r.action), ['unchanged']);
  assert.equal(provider.prs.length, 1);
  assert.match(provider.prs[0].body, /https:\/\/run\/2/); // the description follows the latest run
});

test('a pull request closed without merging is not opened again for the same versions', async () => {
  const report = await ui5Report('app');
  const provider = fakeProvider(await appFiles(), [
    { id: 7, branch: 'stack-sentinel/ui5', state: 'closed', title: 'Update UI5 to 1.148.12', body: '<!-- stack-sentinel-fix: ui5 1.148.12 -->', url: 'https://pr/7' },
  ]);
  const [result] = await openPullRequests(report, fixture('app'), opts(provider));
  assert.equal(result.action, 'skipped');
  assert.match(result.reason, /closed without merging/);
  provider.prs[0].body = '<!-- stack-sentinel-fix: ui5 1.148.11 -->'; // declined an older version
  assert.equal((await openPullRequests(report, fixture('app'), opts(provider)))[0].action, 'created');
});

test('closes a pull request whose findings are gone, unless its check did not run cleanly', async () => {
  const stale = () => [{ id: 3, branch: 'stack-sentinel/ui5', state: 'open', title: 'Update UI5', body: '', url: 'https://pr/3' }];
  const clean = { project: 'p', toolVersion: '0', checks: { run: ['ui5-version'], skipped: [] }, findings: [] };
  const provider = fakeProvider({}, stale());
  assert.deepEqual((await openPullRequests(clean, fixture('app'), opts(provider))).map((r) => r.action), ['closed']);
  // a kind of fix that was turned off leaves its pull request alone
  assert.deepEqual(await openPullRequests(clean, fixture('app'), { ...opts(fakeProvider({}, stale())), only: ['npm-overrides'] }), []);
  const broken = { ...clean, findings: [{ check: 'ui5-version', severity: 'error', source: 'check', message: 'Check failed to run: offline' }] };
  for (const report of [broken, { ...clean, checks: { run: [], skipped: ['ui5-version'] } }]) {
    const p = fakeProvider({}, stale());
    assert.deepEqual(await openPullRequests(report, fixture('app'), opts(p)), []);
  }
});

test('opens no more than fix.maxPullRequests, and skips a group whose changes do not apply', async () => {
  const report = await ui5Report('app');
  const full = fakeProvider(await appFiles(), [{ id: 1, branch: 'stack-sentinel/other', state: 'open', title: 'x', body: '', url: 'https://pr/1' }]);
  const [limited] = await openPullRequests(report, fixture('app'), { ...opts(full), maxPullRequests: 1 });
  assert.match(limited.reason, /already open/);
  const [none] = await openPullRequests(report, fixture('app'), opts(fakeProvider({})));
  assert.match(none.reason, /none of the changes apply/);
});

test('paths are relative to the repository when the scanned folder is inside it', async () => {
  const report = await ui5Report('app');
  const provider = fakeProvider({});
  const read = [];
  provider.readFile = async (branch, path) => { read.push(path); return null; };
  await openPullRequests(report, fixture('app'), opts(provider));
  assert.deepEqual(read, ['test/fixtures/app/ui5.yaml', 'test/fixtures/app/webapp/index.html']);
});

/** Records requests and answers them from `routes`: [method, path regex, response]. */
function fakeFetch(routes) {
  const seen = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    seen.push([method, url, init.body ? JSON.parse(init.body) : undefined, init.headers]);
    const route = routes.find(([m, re]) => m === method && re.test(url));
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const [, , answer, status = 200] = route;
    return new Response(status === 204 ? null : JSON.stringify(typeof answer === 'function' ? answer(url) : answer), { status });
  };
  return { impl, seen };
}

test('GitHub: commits through the Git data API and force-moves the branch onto the latest base', async () => {
  const { impl, seen } = fakeFetch([
    ['GET', /\/git\/ref\/heads\/main$/, { object: { sha: 'base' } }],
    ['GET', /\/git\/commits\/base$/, { tree: { sha: 'basetree' } }],
    ['POST', /\/git\/trees$/, { sha: 'newtree' }],
    ['GET', /\/git\/ref\/heads\/stack-sentinel\/ui5$/, { object: { sha: 'old' } }],
    ['GET', /\/git\/commits\/old$/, { tree: { sha: 'oldtree' } }],
    ['POST', /\/git\/commits$/, { sha: 'new' }],
    ['PATCH', /\/git\/refs\/heads\/stack-sentinel\/ui5$/, {}],
  ]);
  const gh = githubProvider({ repository: 'o/r', token: 't', fetchImpl: impl });
  assert.equal(await gh.writeBranch('stack-sentinel/ui5', 'main', new Map([['ui5.yaml', 'x']]), 'Update UI5'), 'updated');
  assert.deepEqual(seen.find(([m, u]) => m === 'POST' && u.endsWith('/git/commits'))[2], { message: 'Update UI5', tree: 'newtree', parents: ['base'] });
  assert.deepEqual(seen.at(-1)[2], { sha: 'new', force: true });
  assert.equal(seen[0][3].authorization, 'Bearer t');
});

test('GitHub: finds this repository\'s pull requests by branch, and explains a refused pull request', async () => {
  const { impl } = fakeFetch([
    ['GET', /\/pulls\?state=all/, [
      { number: 2, state: 'closed', merged_at: null, title: 't', body: null, html_url: 'u2', head: { ref: 'stack-sentinel/ui5', repo: { full_name: 'o/r' } } },
      { number: 3, state: 'open', title: 't', body: 'b', html_url: 'u3', head: { ref: 'stack-sentinel/ui5', repo: { full_name: 'fork/r' } } },
      { number: 4, state: 'open', title: 't', body: 'b', html_url: 'u4', head: { ref: 'feature', repo: { full_name: 'o/r' } } },
    ]],
    ['POST', /\/pulls$/, { message: 'GitHub Actions is not permitted to create or approve pull requests.' }, 403],
  ]);
  const gh = githubProvider({ repository: 'o/r', token: 't', fetchImpl: impl });
  assert.deepEqual(await gh.findPullRequests('stack-sentinel/'), [{ id: 2, branch: 'stack-sentinel/ui5', state: 'closed', title: 't', body: '', url: 'u2' }]);
  await assert.rejects(gh.createPullRequest({ branch: 'b', baseBranch: 'main', title: 't', body: '' }), /HTTP 403: GitHub Actions is not permitted.*Allow GitHub Actions to create and approve pull requests/);
});

test('Azure DevOps: pushes a new branch from the base, and a commit on top of an open one', async () => {
  const { impl, seen } = fakeFetch([
    ['GET', /\/refs\?filter=heads%2Fmain/, { value: [{ name: 'refs/heads/main', objectId: 'base' }] }],
    ['GET', /\/refs\?filter=heads%2Fstack-sentinel%2Fui5/, (url) => ({ value: seen.some(([m]) => m === 'POST') ? [{ name: 'refs/heads/stack-sentinel/ui5', objectId: 'head' }] : [] })],
    ['GET', /\/items\?/, { content: 'old' }],
    ['POST', /\/pushes\?/, {}],
  ]);
  const az = azureProvider({ collectionUri: 'https://dev.azure.com/org', project: 'P', repositoryId: 'r', token: 't', fetchImpl: impl });
  const files = new Map([['app/ui5.yaml', 'new']]);
  assert.equal(await az.writeBranch('stack-sentinel/ui5', 'main', files, 'Update UI5'), 'created');
  const push = (i) => seen.filter(([m, u]) => m === 'POST' && u.includes('/pushes'))[i][2];
  assert.deepEqual(push(0).refUpdates, [{ name: 'refs/heads/stack-sentinel/ui5', oldObjectId: '0'.repeat(40) }]);
  assert.deepEqual(push(0).commits[0].parents, ['base']);
  assert.deepEqual(push(0).commits[0].changes, [{ changeType: 'edit', item: { path: '/app/ui5.yaml' }, newContent: { content: 'new', contentType: 'rawtext' } }]);
  assert.equal(await az.writeBranch('stack-sentinel/ui5', 'main', files, 'Update UI5', { open: true }), 'updated');
  assert.deepEqual(push(1).commits[0].parents, ['head']);
  assert.equal(await az.writeBranch('stack-sentinel/ui5', 'main', new Map([['app/ui5.yaml', 'old']]), 'Update UI5', { open: true }), 'unchanged');
  assert.ok(seen.every(([, u]) => u.startsWith('https://dev.azure.com/org/P/_apis/git/repositories/r') && u.includes('api-version=7.1')));
});

test('picks the platform from the pipeline\'s variables, and says what is missing', () => {
  assert.equal(detectProvider({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' }, {}).platform, 'github');
  assert.throws(() => detectProvider({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r' }, {}), /GITHUB_TOKEN/);
  const azure = { TF_BUILD: 'True', SYSTEM_COLLECTIONURI: 'https://dev.azure.com/org/', SYSTEM_TEAMPROJECT: 'P', BUILD_REPOSITORY_ID: 'r', BUILD_REPOSITORY_PROVIDER: 'TfsGit' };
  assert.equal(detectProvider(azure, { token: 'x' }).platform, 'azure-devops');
  assert.throws(() => detectProvider(azure, {}), /System\.AccessToken/);
  assert.throws(() => detectProvider({ ...azure, BUILD_REPOSITORY_PROVIDER: 'GitHub' }, { token: 'x' }), /Azure Repos only/);
  assert.throws(() => detectProvider({}, {}), /GitHub Actions and Azure DevOps only/);
});

test('the Teams card links the fix pull requests', () => {
  const report = {
    project: 'p', status: 'warn', toolVersion: '0', generatedAt: now.toISOString(), summary: { error: 0, warn: 1, info: 0, ok: 0 },
    checks: { run: [], skipped: [] }, findings: [],
    pullRequests: [{ title: 'Update UI5 to 1.148.12', action: 'created', url: 'https://pr/1' }, { title: 'Old', action: 'closed', url: 'https://pr/0' }],
  };
  const texts = teamsPayload(report, 'warn', 25).attachments[0].content.body.map((b) => b.text);
  assert.ok(texts.includes('[Update UI5 to 1.148.12](https://pr/1) (new)'));
  assert.ok(!texts.some((t) => t.includes('https://pr/0')));
});

test('fix.groups accepts only known kinds of fix', async () => {
  assert.deepEqual(resolveSettings({ env: { SENTINEL_FIX_GROUPS: 'ui5' } }).values.fix.groups, ['ui5']);
  assert.deepEqual(resolveSettings({}).values.fix.groups, ['ui5', 'node', 'npm-overrides']);
  assert.throws(() => resolveSettings({ env: { SENTINEL_FIX_GROUPS: 'ui5,cap' } }), /expected a list of ui5, node, npm-overrides/);
});

test('Node.js: changes "engines.node" and version files, keeping the rest of the file', () => {
  const pkg = '{\n  "name": "a",\n  "engines": { "npm": ">=9", "node": "^20" }\n}\n';
  assert.equal(applyFix(pkg, finding({ kind: 'node-engines', to: '^24' }, '^20')).text, pkg.replace('"^20"', '"^24"'));
  assert.match(applyFix(pkg, finding({ kind: 'node-engines', to: '^24' }, '^18')).skipped, /not found once/);
  // "node" outside "engines" is not touched
  assert.ok(applyFix('{ "scripts": { "node": "^20" } }', finding({ kind: 'node-engines', to: '^24' }, '^20')).skipped);
  assert.equal(applyFix('# pinned for CI\nlts/jod\n', finding({ kind: 'node-version-file', to: '24' }, 'lts/jod')).text, '# pinned for CI\n24\n');
  assert.equal(applyFix('v20.11.0 # keep\n', finding({ kind: 'node-version-file', to: '24' }, 'v20.11.0')).text, '24 # keep\n');
});

test('Node.js: one pull request for both checks; what Cloud Foundry ships wins', async () => {
  const report = await scan({
    root: fixture('cf-app'), now,
    config: { checks: ['node-version', 'cf-node-version'], node: { feed: fixture('node-schedule.json') }, cf: { feed: fixture('buildpack-manifest.yml') } },
    fetchJsonImpl: offline, fetchTextImpl: offline,
  });
  const [group] = planFixes(report.findings);
  assert.equal(group.id, 'node');
  assert.deepEqual(group.changes.map((c) => [c.file, c.finding.version, c.finding.fix.to]), [
    ['app/orders/package.json', '20.1.0', '^24'],
    ['db/package.json', undefined, '^24'], // deployed with no version: pinned to the line the buildpack keeps longest
    ['package.json', '^20', '^24'],
    ['router/package.json', '>=18', '>=22'], // only a plain lower bound is raised
    // node-version would move it to ^24; the buildpack's fix keeps the line and drops the exact version
    ['tools/api/package.json', '22.11.0', '22.x'],
  ]);
  assert.equal(group.title, 'Update Node.js versions');
  const { files, skipped } = await applyGroup(group, (file) => readFile(fixture(`cf-app/${file}`), 'utf8'));
  assert.equal(JSON.parse(files.get('tools/api/package.json')).engines.node, '22.x');
  assert.deepEqual(skipped.map((s) => [s.change.file, s.reason]), [['db/package.json', 'package.json is not laid out the way npm writes it']]);
  const added = applyFix('{\n  "name": "db",\n  "engines": {\n    "npm": ">=10"\n  }\n}\n', finding({ kind: 'node-engines-missing', to: '^24' }));
  assert.equal(added.text, '{\n  "name": "db",\n  "engines": {\n    "npm": ">=10",\n    "node": "^24"\n  }\n}\n');
  assert.deepEqual(planFixes(report.findings, { only: ['ui5'] }), []);
});

test('Node.js in CI files and Dockerfiles: found in the steps that set it up, and changed there', async () => {
  const report = await scan({
    root: fixture('node-ci'), now, config: { checks: ['node-version'], node: { feed: fixture('node-schedule.json') } },
    fetchJsonImpl: offline,
  });
  assert.deepEqual(report.findings.map((f) => [f.file, f.source, f.version, f.severity]), [
    ['.github/workflows/ci.yml', 'ci', '20', 'error'],
    ['Dockerfile', 'container', '20', 'error'],
    ['azure-pipelines.yml', 'ci', '20.x', 'error'],
    ['azure-pipelines.yml', 'ci', '18', 'error'],
    ['Dockerfile', 'container', 'lts', 'ok'],
  ]); // the matrix expression, Python's versionSpec and a digest pin are not read
  const [group] = planFixes(report.findings);
  const { files } = await applyGroup(group, (file) => readFile(fixture(`node-ci/${file}`), 'utf8'));
  assert.match(files.get('.github/workflows/ci.yml'), /node-version: 24 # what production runs\n/);
  assert.match(files.get('.github/workflows/ci.yml'), /python-version: "3\.12"/);
  assert.match(files.get('azure-pipelines.yml'), /versionSpec: "3\.12"[\s\S]*versionSpec: "24\.x"[\s\S]*version: "24"/);
  assert.equal(files.get('Dockerfile'), 'FROM --platform=linux/amd64 node:24-alpine AS build\nWORKDIR /app\nFROM docker.io/library/node:24-alpine\nFROM node:lts-slim\nFROM node@sha256:0000\n');
});

test('GitHub: workflow files the token may not change are left out, and the rest still goes through', async () => {
  // a repository of its own, so .github/workflows is at its top
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-workflows-'));
  try {
    await cp(fixture('node-ci'), dir, { recursive: true });
    await mkdir(join(dir, '.git'));
    const report = await scan({ root: dir, now, config: { checks: ['node-version'], node: { feed: fixture('node-schedule.json') } }, fetchJsonImpl: offline });
    const files = {};
    for (const f of ['.github/workflows/ci.yml', 'azure-pipelines.yml', 'Dockerfile']) files[f] = await readFile(join(dir, f), 'utf8');
    const provider = fakeProvider(files);
    provider.platform = 'github';
    const write = provider.writeBranch;
    provider.writeBranch = async (branch, base, changed, ...rest) => {
      if ([...changed.keys()].some((f) => f.startsWith('.github/workflows/'))) throw Object.assign(new Error('HTTP 403'), { status: 403 });
      return write(branch, base, changed, ...rest);
    };
    const [result] = await openPullRequests(report, dir, opts(provider));
    assert.equal(result.action, 'created');
    assert.deepEqual(JSON.parse(provider.branches.get('stack-sentinel/node')).map(([f]) => f).sort(), ['Dockerfile', 'azure-pipelines.yml']);
    assert.match(provider.prs[0].body, /Not changed: `\.github\/workflows\/ci\.yml`\. GitHub lets only a token with the "Workflows" permission/);
    // any other failure of one group is reported, and the other groups go on
    provider.writeBranch = async () => { throw new Error('HTTP 500'); };
    const failed = await openPullRequests(report, dir, opts(provider));
    assert.deepEqual(failed.map((r) => [r.action, r.reason]), [['failed', 'HTTP 500']]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a local Fiori preview without a version is pinned to what the app builds with', async () => {
  const yaml = 'server:\n  customMiddleware:\n    - name: fiori-tools-proxy\n      configuration:\n        ui5:\n          path:\n            - /resources\n          url: https://ui5.sap.com\n';
  assert.equal(applyFix(yaml, finding({ kind: 'ui5-preview-missing', to: '1.148.12' })).text, yaml.replace('ui5:\n', 'ui5:\n          version: 1.148.12\n'));
  assert.equal(applyFix(yaml.replace('url: https', 'version: ""\n          url: https'), finding({ kind: 'ui5-preview-missing', to: '1.148.12' })).text,
    yaml.replace('url: https', 'version: "1.148.12"\n          url: https'));
  assert.ok(applyFix(yaml.replace('url:', 'version: 1.120.0\n          url:'), finding({ kind: 'ui5-preview-missing', to: '1.148.12' })).skipped);
  const report = await scan({ root: fixture('fiori-app'), now, config: ui5Config, fetchJsonImpl: offline });
  const note = report.findings.find((f) => f.file === 'app1/ui5-mock.yaml');
  // app1 builds with nothing pinned in its own folder, so the recommended version is used
  assert.deepEqual(note.fix, { kind: 'ui5-preview-missing', to: '1.148.12' });
});
