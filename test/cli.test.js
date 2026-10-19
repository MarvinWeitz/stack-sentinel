// End-to-end tests: run the real command against a local HTTP server that plays
// both SAP's feed and the webhook receiver. No outside network is used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const bin = path('../bin/stack-sentinel.js');
const feed = await readFile(path('./fixtures/versionoverview.json'), 'utf8');
const nodeSchedule = await readFile(path('./fixtures/node-schedule.json'), 'utf8');
const buildpackManifest = await readFile(path('./fixtures/buildpack-manifest.yml'), 'utf8');
const npmAdvisories = await readFile(path('./fixtures/npm-advisories.json'), 'utf8');

let server;
let base;
let posts = [];
let policy = '{}'; // what the fake policy host serves at /policy

before(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/feed') return res.writeHead(200, { 'content-type': 'application/json' }).end(feed);
    if (req.method === 'GET' && req.url === '/node') return res.writeHead(200, { 'content-type': 'application/json' }).end(nodeSchedule);
    if (req.method === 'GET' && req.url.startsWith('/npm/')) {
      const name = decodeURIComponent(req.url.slice(5)).replace('/', '__');
      return readFile(path(`./fixtures/npm/${name}.json`), 'utf8').then(
        (body) => res.writeHead(200, { 'content-type': 'application/json' }).end(body),
        () => res.writeHead(404).end('{}'),
      );
    }
    if (req.method === 'GET' && req.url === '/policy') return res.writeHead(200, { 'content-type': 'application/json' }).end(policy);
    if (req.method === 'GET' && req.url === '/cf') return res.writeHead(200, { 'content-type': 'text/plain' }).end(buildpackManifest);
    // Uptime Kuma 1.x: push addresses answer GET only; an unknown or paused monitor gives a JSON 404
    if (req.url.startsWith('/api/push/')) {
      posts.push({ url: req.url, method: req.method });
      if (req.method !== 'GET') return res.writeHead(404, { 'content-type': 'text/html' }).end(`<pre>Cannot ${req.method} ${req.url}</pre>`);
      if (!req.url.startsWith('/api/push/good')) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"ok":false,"msg":"Monitor not found or not active."}');
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    }
    if (req.method === 'POST' && req.url.endsWith('/-/npm/v1/security/advisories/bulk')) {
      req.resume();
      return req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(npmAdvisories));
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        posts.push({ url: req.url, body: JSON.parse(body) });
        res.writeHead(req.url.endsWith('-broken') ? 500 : 202).end();
      });
      return;
    }
    res.writeHead(500).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** Runs the CLI with a clean environment, so settings on the developer's machine cannot leak in. */
function run(args, env = {}) {
  posts = [];
  return new Promise((done) => {
    execFile(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH, SENTINEL_UI5_FEED: `${base}/feed`, SENTINEL_NODE_FEED: `${base}/node`, SENTINEL_CF_FEED: `${base}/cf`, SENTINEL_CAP_REGISTRY: `${base}/npm`, SENTINEL_AUDIT_REGISTRY: `${base}/npm`, ...env } },
      (err, stdout, stderr) => done({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('reports findings, exits 1 and posts a Teams card', async () => {
  const r = await run([path('./fixtures/app')], { SENTINEL_WEBHOOK_URL: `${base}/hook` });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /UI5 1\.108 is out of maintenance/);
  assert.match(r.stdout, /removed from the SAP CDN/);
  assert.equal(r.stdout.match(/UI5 1\.148 is in long-term maintenance/g).length, 1);
  assert.match(r.stdout, /^  UI5 1\.148 is in long-term maintenance until 2027-09-30\.$/m);
  // each finding line is followed by what to change there
  assert.match(r.stdout, /\(ui5\.yaml\)\n {10}→ Set framework\.version to 1\.148\.12$/m);
  assert.match(r.stdout, /\(webapp\/manifest\.json\)\n {10}→ Raise minUI5Version to 1\.148\.0$/m);
  assert.equal(posts.length, 1);
  const card = posts[0].body.attachments[0].content;
  assert.equal(card.type, 'AdaptiveCard');
  assert.ok(card.body.some((b) => /out of maintenance/.test(b.text)));
});

test('--format json posts the raw report, --json prints it, --fail-on never exits 0', async () => {
  const r = await run([path('./fixtures/app'), '--json', '--format', 'json', '--fail-on', 'never', '--webhook', `${base}/hook`, '--project', 'Customer A']);
  assert.equal(r.code, 0);
  const printed = JSON.parse(r.stdout);
  assert.equal(printed.project, 'Customer A');
  assert.match(printed.toolVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(printed.status, 'error');
  assert.deepEqual(posts[0].body.findings, printed.findings);
});

test('nothing is posted below the notify threshold', async () => {
  const r = await run([path('./fixtures/btp-app')], { SENTINEL_WEBHOOK_URL: `${base}/hook`, SENTINEL_UI5_REQUIRE_LTS: 'false' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\[info \]/);
  assert.equal(posts.length, 0);
});

test('an unreachable feed is reported as an error finding and still notifies', async () => {
  const r = await run([path('./fixtures/app')], { SENTINEL_UI5_FEED: `${base}/missing`, SENTINEL_WEBHOOK_URL: `${base}/hook` });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Check failed to run: HTTP 500/);
  assert.equal(posts.length, 1);
});

test('tool failures exit 2: failing webhook, unknown check, invalid setting', async () => {
  const hook = await run([path('./fixtures/app')], { SENTINEL_WEBHOOK_URL: `${base}/hook-broken` });
  assert.equal(hook.code, 2);
  assert.match(hook.stderr, /Webhook responded with HTTP 500/);
  const check = await run([path('./fixtures/app')], { SENTINEL_CHECKS: 'ui5' });
  assert.equal(check.code, 2);
  assert.match(check.stderr, /Unknown check\(s\): ui5/);
  const setting = await run([path('./fixtures/app'), '--fail-on', 'fatal']);
  assert.equal(setting.code, 2);
  assert.equal(posts.length, 0);
});

test('a project without stack files says nothing was checked', async () => {
  const r = await run([path('../src')]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /nothing was checked/);
});

test('--version prints the package version', async () => {
  const pkg = JSON.parse(await readFile(path('../package.json'), 'utf8'));
  const r = await run(['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test('README usage and pipeline examples install from the stable branch by default', async () => {
  const readme = await readFile(path('../README.md'), 'utf8');
  const installs = [...readme.matchAll(/npx(?: --yes)? github:cbs-consulting\/stack-sentinel(#[\w.]+)?/g)].map((m) => m[1]);
  assert.ok(installs.length > 0);
  assert.deepEqual([...new Set(installs)], ['#stable']);
  for (const file of ['../examples/github-actions.yml', '../examples/azure-pipelines.yml']) {
    const text = await readFile(path(file), 'utf8');
    assert.match(text, /(SENTINEL_SOURCE:.*|SENTINEL_SOURCE:-)github:cbs-consulting\/stack-sentinel#stable['"}]/, `${file} does not default to #stable`);
  }
});

test('this repository runs the GitHub pipeline example on itself, unchanged', async () => {
  // so the example customers copy is one that is known to run
  assert.equal(await readFile(path('../.github/workflows/stack-sentinel.yml'), 'utf8'), await readFile(path('../examples/github-actions.yml'), 'utf8'));
});

test('text output shows one line per problem with the affected files', async () => {
  const r = await run([path('./fixtures/fiori-app'), '--fail-on', 'never']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\[info \] minUI5Version 1\.108 is out of maintenance \(ended 2025-12-31\)\.\s+\(2 files: app1\/webapp\/manifest\.json, app2\/webapp\/manifest\.json\)/);
});

test('runs both checks, and each can be switched off', async () => {
  const both = await run([path('./fixtures/node-app'), '--json', '--fail-on', 'never']);
  const report = JSON.parse(both.stdout);
  assert.deepEqual(report.checks.run, ['ui5-version', 'node-version', 'cf-node-version', 'cap-version', 'npm-audit']);
  assert.ok(report.findings.some((f) => f.check === 'node-version' && f.severity === 'error'));

  const skipped = await run([path('./fixtures/node-app')], { SENTINEL_SKIP_CHECKS: 'node-version' });
  assert.equal(skipped.code, 0);
  assert.match(skipped.stdout, /checks run: ui5-version, cf-node-version, cap-version, npm-audit · skipped: node-version/);
  assert.match(skipped.stdout, /nothing was checked/);
});

test('--list-checks names every check', async () => {
  const r = await run(['--list-checks']);
  assert.match(r.stdout, /^ui5-version /m);
  assert.match(r.stdout, /^node-version /m);
  assert.match(r.stdout, /^cf-node-version /m);
  assert.match(r.stdout, /^cap-version /m);
  assert.match(r.stdout, /^npm-audit /m);
});

test('the Cloud Foundry check downloads the buildpack manifest and reports alongside the Node.js check', async () => {
  const r = await run([path('./fixtures/cf-app'), '--json', '--fail-on', 'never']);
  const report = JSON.parse(r.stdout);
  const messages = (check) => report.findings.filter((f) => f.check === check).map((f) => f.message).join('\n');
  assert.match(messages('cf-node-version'), /"\^20" matches no Node\.js version in the Cloud Foundry buildpack/);
  assert.match(messages('node-version'), /"\^20" only allows Node\.js 20, which reached end of life/);
});

test('the CAP check asks the registry over HTTP and reports unsupported versions', async () => {
  const r = await run([path('./fixtures/cap-app'), '--checks', 'cap-version']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /@sap\/cds 7\.9\.5 is no longer supported/);
  assert.match(r.stdout, /^ {10}→ Upgrade @sap\/cds to "\^10" in package\.json$/m);
  assert.match(r.stdout, /^  @sap\/cds 10 is the current major version; it needs Node\.js >=22\.$/m);
});

test('a heartbeat is sent after every completed run, with the outcome but no findings', async () => {
  // clean project: no Teams card, but the heartbeat still goes out
  const clean = await run([path('../src')], { SENTINEL_WEBHOOK_URL: `${base}/hook`, SENTINEL_HEARTBEAT_URL: `${base}/beat` });
  assert.equal(clean.code, 0);
  assert.deepEqual(posts.map((p) => p.url), ['/beat']);
  const beat = posts[0].body;
  assert.deepEqual(Object.keys(beat).sort(), ['checks', 'generatedAt', 'project', 'status', 'summary', 'tool', 'toolVersion']);
  assert.equal(beat.status, 'ok');
  assert.equal(beat.project, 'src');

  // project with findings: card first, heartbeat last, and the exit code still reflects the findings
  const findings = await run([path('./fixtures/app')], { SENTINEL_WEBHOOK_URL: `${base}/hook`, SENTINEL_HEARTBEAT_URL: `${base}/beat` });
  assert.equal(findings.code, 1);
  assert.deepEqual(posts.map((p) => p.url), ['/hook', '/beat']);
  assert.equal(posts[1].body.status, 'error');
  assert.ok(posts[1].body.summary.error > 0);
  assert.equal(posts[1].body.findings, undefined);
});

test('no heartbeat when the report could not be delivered; a failing heartbeat exits 2', async () => {
  const undelivered = await run([path('./fixtures/app')], { SENTINEL_WEBHOOK_URL: `${base}/hook-broken`, SENTINEL_HEARTBEAT_URL: `${base}/beat` });
  assert.equal(undelivered.code, 2);
  assert.deepEqual(posts.map((p) => p.url), ['/hook-broken']);

  const badBeat = await run([path('../src')], { SENTINEL_HEARTBEAT_URL: `${base}/beat-broken` });
  assert.equal(badBeat.code, 2);
  assert.match(badBeat.stderr, /Heartbeat address responded with HTTP 500/);

  const invalid = await run([path('./fixtures/app')], { SENTINEL_CHECKS: 'nope', SENTINEL_HEARTBEAT_URL: `${base}/beat` });
  assert.equal(invalid.code, 2);
  assert.equal(posts.length, 0); // the run never completed
});

test('a shared config from a URL changes policy for the project; the project can still override it', async () => {
  // the BTP fixture app normally gets a warning (no version pinned) and would notify
  const normal = await run([path('./fixtures/btp-app')], { SENTINEL_WEBHOOK_URL: `${base}/hook` });
  assert.match(normal.stdout, /\[warn \]/);
  assert.equal(posts.length, 1);

  policy = JSON.stringify({ ui5: { requireLts: false } });
  const relaxed = await run([path('./fixtures/btp-app')], { SENTINEL_WEBHOOK_URL: `${base}/hook`, SENTINEL_SHARED_CONFIG: `${base}/policy` });
  assert.equal(relaxed.code, 0);
  assert.match(relaxed.stdout, /\[info \]/);
  assert.equal(posts.length, 0);

  // an environment variable in the pipeline beats the shared file
  const overridden = await run([path('./fixtures/btp-app')], { SENTINEL_SHARED_CONFIG: `${base}/policy`, SENTINEL_UI5_REQUIRE_LTS: 'true' });
  assert.match(overridden.stdout, /\[warn \]/);
});

test('--show-config names the shared config and marks what came from it', async () => {
  policy = JSON.stringify({ ui5: { warnDays: 270 }, webhook: 'https://not-read.example' });
  const r = await run([path('./fixtures/btp-app'), '--show-config', '--shared-config', `${base}/policy`]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(`^Shared config: ${base}/policy$`, 'm'));
  assert.match(r.stdout, /^ui5\.warnDays\s+270\s+\[shared\]$/m);
  assert.match(r.stdout, /^webhook\s+\(not set\)\s+\[default\]$/m);
  assert.match((await run([path('./fixtures/btp-app'), '--show-config'])).stdout, /^Shared config: \(none\)$/m);
});

test('the project config file can name the shared config, relative to itself', async () => {
  const r = await run([path('./fixtures/shared-app/project'), '--show-config']);
  assert.match(r.stdout, /^Shared config: \.\.\/policy\.json$/m);
  assert.match(r.stdout, /^ui5\.requireLts\s+false\s+\[shared\]$/m);
  assert.match(r.stdout, /^ui5\.warnDays\s+365\s+\[config\]$/m); // the project's own value wins over 30
  assert.match(r.stdout, /^notifyOn\s+"error"\s+\[shared\]$/m);
  assert.match(r.stdout, /^project\s+"Customer A \/ Orders"\s+\[config\]$/m);
});

test('a shared config that cannot be used stops the run with exit code 2', async () => {
  const missing = await run([path('./fixtures/btp-app')], { SENTINEL_SHARED_CONFIG: `${base}/nowhere`, SENTINEL_HEARTBEAT_URL: `${base}/beat` });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Cannot read the shared config .*\/nowhere: HTTP 500/);
  assert.equal(posts.length, 0); // no scan, so no heartbeat either

  policy = '[1, 2]';
  const notObject = await run([path('./fixtures/btp-app')], { SENTINEL_SHARED_CONFIG: `${base}/policy` });
  assert.equal(notObject.code, 2);
  assert.match(notObject.stderr, /is not a JSON object/);

  policy = JSON.stringify({ failOn: 'sometimes' });
  const invalid = await run([path('./fixtures/btp-app')], { SENTINEL_SHARED_CONFIG: `${base}/policy` });
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /"failOn" in the shared config: expected one of/);

  const noFile = await run([path('./fixtures/btp-app'), '--shared-config', 'does-not-exist.json']);
  assert.equal(noFile.code, 2);
});

test('says why no notification was sent, and sends one for a clean project when asked', async () => {
  const noAddress = await run([path('./fixtures/app'), '--fail-on', 'never']);
  assert.match(noAddress.stderr, /no notification sent, because no webhook address is set \(SENTINEL_WEBHOOK_URL or --webhook\)/);

  // an empty secret, as CI passes it when the secret does not exist, counts as no address
  const emptySecret = await run([path('../src')], { SENTINEL_WEBHOOK_URL: '', SENTINEL_NOTIFY_ON: 'ok' });
  assert.match(emptySecret.stderr, /no webhook address is set/);
  assert.equal(posts.length, 0);

  const below = await run([path('../src')], { SENTINEL_WEBHOOK_URL: `${base}/hook` });
  assert.match(below.stderr, /no notification sent, because the status "ok" is below notify-on "warn"\. Set SENTINEL_NOTIFY_ON=ok/);
  assert.equal(posts.length, 0);

  const forced = await run([path('../src')], { SENTINEL_WEBHOOK_URL: `${base}/hook`, SENTINEL_NOTIFY_ON: 'ok' });
  assert.equal(forced.code, 0);
  assert.match(forced.stderr, /notification sent\./);
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.attachments[0].content.body[0].text, /🟢 stack-sentinel: src/);
});

test('links back to the pipeline run: detected, shown, and posted as card buttons', async () => {
  const github = { GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'customer/orders', GITHUB_RUN_ID: '99' };
  const r = await run([path('./fixtures/app'), '--json', '--fail-on', 'never'], { ...github, SENTINEL_WEBHOOK_URL: `${base}/hook` });
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.links, { run: 'https://github.com/customer/orders/actions/runs/99', repository: 'https://github.com/customer/orders' });
  const card = posts[0].body.attachments[0].content;
  assert.deepEqual(card.actions.map((a) => [a.type, a.title, a.url]), [
    ['Action.OpenUrl', 'Open pipeline run', 'https://github.com/customer/orders/actions/runs/99'],
    ['Action.OpenUrl', 'Open repository', 'https://github.com/customer/orders'],
  ]);

  const text = await run([path('./fixtures/app'), '--fail-on', 'never'], github);
  assert.match(text.stdout, /^  run: https:\/\/github\.com\/customer\/orders\/actions\/runs\/99$/m);

  // a setting wins over detection, for other CI systems
  const custom = await run([path('./fixtures/app'), '--json', '--fail-on', 'never', '--run-url', 'https://ci.example/run/7'], github);
  assert.equal(JSON.parse(custom.stdout).links.run, 'https://ci.example/run/7');

  // outside a pipeline: no links, no buttons
  const local = await run([path('./fixtures/app'), '--json', '--fail-on', 'never'], { SENTINEL_WEBHOOK_URL: `${base}/hook` });
  assert.equal(JSON.parse(local.stdout).links, undefined);
  assert.equal(posts[0].body.attachments[0].content.actions, undefined);
});

test('the shared config in use is named in the output, the report and the card', async () => {
  policy = JSON.stringify({ notifyOn: 'info' });
  const text = await run([path('./fixtures/btp-app')], { SENTINEL_SHARED_CONFIG: `${base}/policy` });
  assert.match(text.stdout, new RegExp(`^  shared config: ${base}/policy$`, 'm'));

  const json = await run([path('./fixtures/btp-app'), '--json'], { SENTINEL_SHARED_CONFIG: `${base}/policy`, SENTINEL_WEBHOOK_URL: `${base}/hook` });
  assert.equal(JSON.parse(json.stdout).sharedConfig, `${base}/policy`);
  const card = posts[0].body.attachments[0].content.body.map((b) => b.text);
  assert.equal(card.at(-1), `Shared config: ${base}/policy`);

  const none = await run([path('./fixtures/btp-app'), '--json']);
  assert.equal(JSON.parse(none.stdout).sharedConfig, undefined);
});

test('the vulnerability check asks the registry over HTTP and reports with actions', async () => {
  const r = await run([path('./fixtures/audit-app'), '--checks', 'npm-audit']);
  assert.equal(r.code, 1); // minimist has a critical advisory
  assert.match(r.stdout, /\[error\] minimist 1\.2\.5 has a known vulnerability, the worst critical/);
  assert.match(r.stdout, /→ Update minimist to 1\.2\.6 or later \(run "npm audit fix" in the project folder\)/);
});

test('a heartbeat service that only accepts GET: the error says why, and GET can be chosen', async () => {
  const kuma = `${base}/api/push/good?status=up&msg=OK&ping=`;
  const post = await run([path('../src')], { SENTINEL_HEARTBEAT_URL: kuma });
  assert.equal(post.code, 2);
  assert.match(post.stderr, /Heartbeat address responded with HTTP 404: Cannot POST \/api\/push\/good.*set SENTINEL_HEARTBEAT_METHOD=GET/);

  const get = await run([path('../src')], { SENTINEL_HEARTBEAT_URL: kuma, SENTINEL_HEARTBEAT_METHOD: 'GET' });
  assert.equal(get.code, 0);
  assert.match(get.stderr, /heartbeat sent\./);
  assert.deepEqual(posts.map((p) => [p.method, p.url]), [['GET', '/api/push/good?status=up&msg=OK&ping=']]);

  // a paused monitor or a wrong token: the service's own explanation is shown
  const paused = await run([path('../src')], { SENTINEL_HEARTBEAT_URL: `${base}/api/push/paused`, SENTINEL_HEARTBEAT_METHOD: 'GET' });
  assert.equal(paused.code, 2);
  assert.match(paused.stderr, /HTTP 404: \{"ok":false,"msg":"Monitor not found or not active\."\}/);

  // a stray line break pasted into the secret does not break the address
  const pasted = await run([path('../src')], { SENTINEL_HEARTBEAT_URL: `${kuma}\n`, SENTINEL_HEARTBEAT_METHOD: 'GET' });
  assert.equal(pasted.code, 0);
});
