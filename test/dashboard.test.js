import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DASHBOARD_MARKER, dashboardBlocks, toHtml, toMarkdown, updateDashboard } from '../src/dashboard.js';
import { azureProvider } from '../src/fix/azure.js';
import { githubProvider } from '../src/fix/github.js';
import { teamsPayload } from '../src/notifiers/webhook.js';

function fakeFetch(routes) {
  const seen = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    seen.push([method, url, init.body ? JSON.parse(init.body) : undefined, init.headers]);
    const route = routes.find(([m, re]) => m === method && re.test(url));
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const [, , answer, status = 200] = route;
    return new Response(JSON.stringify(typeof answer === 'function' ? answer(url) : answer), { status });
  };
  return { impl, seen };
}

const report = {
  tool: 'stack-sentinel', toolVersion: '1.0.0', project: 'o/r', generatedAt: '2026-10-30T06:17:00.000Z', status: 'error',
  summary: { error: 1, warn: 1, info: 0, ok: 1 },
  checks: { run: ['ui5-version', 'npm-audit', 'license'], skipped: ['cap-version'] },
  links: { run: 'https://ci/run/1' },
  findings: [
    { check: 'ui5-version', severity: 'error', file: 'ui5.yaml', message: 'UI5 1.108 is out of maintenance.', action: 'Set framework.version to 1.148.13' },
    { check: 'license', severity: 'warn', file: 'package-lock.json', message: 'gpl-lib 1.0.0 is licensed under GPL-3.0 | <b>x</b>.' },
    { check: 'npm-audit', severity: 'ok', file: 'package-lock.json', message: 'No known vulnerabilities.' },
  ],
  ignored: [{ check: 'npm-audit', severity: 'error', file: 'package-lock.json', message: 'minimist 1.2.5 is vulnerable.', ignoredBy: { reason: 'build only', until: '2026-12-31' } }],
  pullRequests: [
    { group: 'ui5', title: 'Update UI5 to 1.148.13', action: 'updated', url: 'https://pr/1', autoMerge: true },
    { group: 'cap', title: 'Upgrade @sap/cds to 10', action: 'skipped', reason: '5 stack-sentinel pull requests are already open (fix.maxPullRequests)' },
  ],
};

test('the dashboard lists findings, fix pull requests and ignored findings, as Markdown and as HTML', () => {
  const md = toMarkdown(dashboardBlocks(report));
  assert.match(md, /^🔴 \*\*ERROR\*\*: 1 error\(s\), 1 warning\(s\), 0 info\. Scanned on 2026-10-30 in \[this run\]\(https:\/\/ci\/run\/1\)\./);
  assert.match(md, /\| 🔴 error \| UI5 1\.108 is out of maintenance\. \| ui5\.yaml \| Set framework\.version to 1\.148\.13 \|/);
  assert.match(md, /GPL-3\.0 \\\| <b>x<\/b>/); // a pipe in a message does not break the table
  assert.match(md, /- \[Update UI5 to 1\.148\.13\]\(https:\/\/pr\/1\) \(merges by itself once its checks pass\)/);
  assert.match(md, /### Not opened\n\n- Upgrade @sap\/cds to 10: 5 stack-sentinel pull requests are already open/);
  assert.match(md, /\| minimist 1\.2\.5 is vulnerable\. \| package-lock\.json \| build only \| 2026-12-31 \|/);
  assert.match(md, /Checks run: ui5-version, npm-audit, license; skipped: cap-version\. 1 place is up to date\./);
  assert.ok(md.endsWith(DASHBOARD_MARKER));

  const html = toHtml(dashboardBlocks(report));
  assert.match(html, /<p>🔴 <b>ERROR<\/b>: .* in <a href="https:\/\/ci\/run\/1">this run<\/a>\.<\/p>/);
  assert.match(html, /<td>gpl-lib 1\.0\.0 is licensed under GPL-3\.0 \| &lt;b&gt;x&lt;\/b&gt;\.<\/td>/); // text is escaped
  assert.match(html, /<li><a href="https:\/\/pr\/1">Update UI5 to 1\.148\.13<\/a>/);
});

test('GitHub: one labelled issue, created once and then kept up to date', async () => {
  let issues = [];
  const { impl, seen } = fakeFetch([
    ['GET', /\/issues\?state=open&labels=stack-sentinel/, () => issues],
    ['POST', /\/repos\/o\/r\/issues$/, { number: 7, html_url: 'https://gh/issues/7' }],
    ['PATCH', /\/issues\/7$/, {}],
  ]);
  const gh = githubProvider({ repository: 'o/r', token: 't', fetchImpl: impl });
  const settings = { title: 'stack-sentinel: {project}', label: 'stack-sentinel' };
  assert.deepEqual(await updateDashboard(report, gh, settings), { action: 'created', url: 'https://gh/issues/7' });
  const created = seen.find(([m]) => m === 'POST')[2];
  assert.equal(created.title, 'stack-sentinel: o/r');
  assert.deepEqual(created.labels, ['stack-sentinel']);
  // a pull request or another issue with the label is not the dashboard
  issues = [{ number: 3, pull_request: {}, body: DASHBOARD_MARKER }, { number: 5, body: 'something else' }, { number: 7, title: 'stack-sentinel: o/r', body: created.body, html_url: 'https://gh/issues/7' }];
  assert.deepEqual(await updateDashboard(report, gh, settings), { action: 'unchanged', url: 'https://gh/issues/7' });
  assert.deepEqual(await updateDashboard({ ...report, generatedAt: '2026-11-06T06:17:00.000Z' }, gh, settings), { action: 'updated', url: 'https://gh/issues/7' });
  assert.match(seen.at(-1)[2].body, /Scanned on 2026-11-06/);
});

test('GitHub: a token without "issues: write" gets told so', async () => {
  const { impl } = fakeFetch([['GET', /\/issues\?/, []], ['POST', /\/issues$/, { message: 'Resource not accessible by integration' }, 403]]);
  const gh = githubProvider({ repository: 'o/r', token: 't', fetchImpl: impl });
  await assert.rejects(updateDashboard(report, gh, { title: 't', label: 'l' }), /HTTP 403: Resource not accessible by integration\. The dashboard needs "issues: write"/);
});

test('Azure DevOps: a tagged work item, found by its title with WIQL, and an HTML description', async () => {
  let found = [];
  const { impl, seen } = fakeFetch([
    ['POST', /\/_apis\/wit\/wiql\?/, () => ({ workItems: found })],
    ['GET', /\/_apis\/wit\/workitems\/12\?/, { id: 12, fields: { 'System.Title': 'stack-sentinel: o/r', 'System.Description': '<p>old</p>' }, _links: { html: { href: 'https://az/wi/12' } } }],
    ['POST', /\/_apis\/wit\/workitems\/\$Task\?/, { id: 12, _links: { html: { href: 'https://az/wi/12' } } }],
    ['PATCH', /\/_apis\/wit\/workitems\/12\?/, {}],
  ]);
  const az = azureProvider({ collectionUri: 'https://dev.azure.com/org/', project: 'P', repositoryId: 'r', token: 't', fetchImpl: impl });
  const settings = { title: 'stack-sentinel: {project}', label: 'stack-sentinel' };
  assert.deepEqual(await updateDashboard(report, az, settings), { action: 'created', url: 'https://az/wi/12' });
  const [, url, ops, headers] = seen.find(([m, u]) => m === 'POST' && u.includes('$Task'));
  assert.ok(url.startsWith('https://dev.azure.com/org/P/_apis/wit/workitems/$Task?api-version=7.1'));
  assert.equal(headers['content-type'], 'application/json-patch+json');
  assert.deepEqual(ops.map((o) => [o.path, typeof o.value === 'string' && o.value.slice(0, 20)]), [
    ['/fields/System.Title', 'stack-sentinel: o/r'], ['/fields/System.Description', '<p>🔴 <b>ERROR</b>: '], ['/fields/System.Tags', 'stack-sentinel'],
  ]);
  assert.match(seen[0][2].query, /\[System\.Tags\] CONTAINS 'stack-sentinel' AND \[System\.Title\] = 'stack-sentinel: o\/r'/);
  found = [{ id: 12 }];
  assert.deepEqual(await updateDashboard(report, az, settings), { action: 'updated', url: 'https://az/wi/12' });
  assert.equal(seen.at(-1)[0], 'PATCH');
});

test('the Teams card links the dashboard', () => {
  const card = teamsPayload({ ...report, dashboard: { action: 'updated', url: 'https://gh/issues/7' } }, 'warn', 25);
  assert.ok(card.attachments[0].content.actions.some((a) => a.title === 'Open dashboard' && a.url === 'https://gh/issues/7'));
});
