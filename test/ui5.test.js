import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate, indexFeed, previewFromUi5Yaml, recommend, normaliseStatus, parseQuarter, readManifest, versionFromUi5Yaml, versionsFromHtml } from '../src/checks/ui5.js';
import { selectChecks } from '../src/checks/index.js';
import { scan } from '../src/cli.js';
import { teamsPayload } from '../src/notifiers/webhook.js';
import { describeFiles, groupFindings, recommendations } from '../src/report.js';

const fixture = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const feed = JSON.parse(await readFile(fixture('versionoverview.json'), 'utf8'));
const index = indexFeed(feed);
const now = new Date('2026-10-11T00:00:00Z');
const policy = { now, requireLts: true, warnDays: 180, maintenanceDate: 'eomm' };
const hosts = ['ui5.sap.com', 'sapui5.hana.ondemand.com'];
const run = (kind, version, opts = {}) => evaluate({ kind, file: 'f', version }, index, { ...policy, ...opts });
const sev = (findings) => findings.map((f) => f.severity);

test('parses quarters to the last day of the quarter', () => {
  assert.equal(parseQuarter('Long-term Maintenance, Q4/2030').toISOString().slice(0, 10), '2030-12-31');
  assert.equal(parseQuarter('Q1/2027').toISOString().slice(0, 10), '2027-03-31');
  assert.equal(parseQuarter('To Be Determined'), null);
});

test('normalises inconsistent status casing', () => {
  assert.equal(normaliseStatus('Out of Maintenance'), 'out-of-maintenance');
  assert.equal(normaliseStatus('Out of maintenance'), 'out-of-maintenance');
  assert.equal(normaliseStatus('Maintenance'), 'maintenance');
});

test('latest LTS patch is ok', () => {
  assert.deepEqual(sev(run('framework', '1.148.12')), ['ok']);
});

test('older patch of a supported LTS only yields an info', () => {
  const f = run('framework', '1.148.11');
  assert.deepEqual(sev(f), ['info']);
  assert.equal(f[0].details.latest, '1.148.12');
});

test('lts flag alone is not enough: 1.108 is out of maintenance', () => {
  assert.ok(sev(run('framework', '1.108.56')).includes('error'));
});

test('uses the SAP BTP end-of-maintenance date by default; the other date is a setting', () => {
  const msg = (opts) => run('framework', '1.108.56', opts).find((f) => f.severity === 'error').message;
  assert.equal(msg({}), 'UI5 1.108 is out of maintenance (ended 2025-12-31).');
  // a date that is still in the future is never quoted as "ended"
  assert.equal(msg({ maintenanceDate: 'eom' }), 'UI5 1.108 is out of maintenance.');
  // 1.120: BTP date Q4/2026 is inside the warning window, the other date (Q4/2030) is not
  const soon = run('framework', '1.120.52');
  assert.deepEqual(sev(soon), ['warn']);
  assert.match(soon[0].message, /reaches end of maintenance on 2026-12-31 \(82 days\)/);
  assert.deepEqual(sev(run('framework', '1.120.52', { maintenanceDate: 'eom' })), ['ok']);
  assert.deepEqual(sev(run('framework', '1.120.52', { maintenanceDate: 'earliest' })), ['warn']);
});

test('a passed end date the feed status has not caught up with is a warning, not an error', () => {
  const f = run('framework', '1.136.23');
  assert.deepEqual(sev(f), ['warn']);
  assert.match(f[0].message, /passed its end of maintenance date \(2026-09-30\)/);
  assert.deepEqual(sev(run('framework', '1.136.23', { maintenanceDate: 'eom' })), ['ok']);
  assert.deepEqual(sev(run('framework', '1.145.3', { requireLts: false })), ['warn']);
});

test('recommends the long-term version with the longest maintenance, never a downgrade', () => {
  assert.equal(recommend(index, policy).key, '1.148');
  // with the other date, 1.136 (Q4/2032) outlasts 1.148 (Q3/2027)
  assert.equal(recommend(index, { ...policy, maintenanceDate: 'eom' }).key, '1.136');
  assert.equal(recommend(index, { ...policy, now: new Date('2040-01-01') }), null);
  const old = run('framework', '1.120.52')[0];
  assert.equal(old.recommendation, 'UI5 1.148 is in long-term maintenance until 2027-09-30');
  assert.doesNotMatch(old.message, /Recommended/); // shown once per report, not in every message
  assert.equal(old.details.recommended, '1.148');
  // 1.152 is newer than the recommended 1.148: no advice to go backwards
  const newer = run('framework', '1.152.0')[0];
  assert.equal(newer.recommendation, undefined);
  assert.equal(newer.details, undefined);
  // unknown and skipped versions get the advice too
  assert.match(run('framework', '1.50.0')[0].recommendation, /^UI5 1\.148 is/);
});

test('non-LTS maintenance version warns, unless requireLts is off', () => {
  assert.deepEqual(sev(run('framework', '1.152.0')), ['warn']);
  assert.deepEqual(sev(run('framework', '1.152.0', { requireLts: false })), ['ok']);
});

test('approaching end of maintenance warns inside the window', () => {
  const soon = new Date('2027-06-01T00:00:00Z');
  const f = evaluate({ kind: 'framework', file: 'f', version: '1.148.12' }, index, { ...policy, now: soon });
  assert.ok(f.some((x) => x.severity === 'warn' && /end of maintenance/.test(x.message)));
});

test('skipped and unknown versions are errors', () => {
  assert.deepEqual(sev(run('framework', '1.137.0')), ['error']);
  assert.deepEqual(sev(run('framework', '1.50.0')), ['error']);
});

test('CDN bootstrap: removed patch and passed provisioning date are errors', () => {
  assert.ok(run('bootstrap', '1.108.45').some((f) => /removed from the SAP CDN/.test(f.message) && f.severity === 'error'));
  assert.ok(run('bootstrap', '1.120.33').some((f) => /end of cloud provisioning/.test(f.message) && f.severity === 'error'));
  // extended_eocp takes precedence over eocp
  assert.ok(run('bootstrap', '1.120.2').some((f) => /will be removed from the CDN/.test(f.message) && f.severity === 'warn'));
});

test('minUI5Version is a floor: reported as info at most, and the message names it', () => {
  const f = run('minUI5Version', '1.96.0');
  assert.deepEqual(sev(f), ['info']);
  assert.equal(f[0].message, 'minUI5Version 1.96 is out of maintenance.');
  assert.equal(f[0].action, 'Raise minUI5Version to 1.148.0');
  assert.deepEqual(sev(run('minUI5Version', '1.148.0')), ['ok']);
});

test('local test pages are reported as info at most', async () => {
  const testPage = evaluate({ kind: 'bootstrap', file: 'test/flpSandbox.html', version: '1.108.45', testPage: true }, index, policy);
  assert.deepEqual(sev(testPage), ['info', 'info']);
  assert.equal(testPage[1].message, 'Local test page: UI5 1.108.45 has been removed from the SAP CDN.');
  const report = await scan({ root: fixture('test-pages'), now, fetchJsonImpl: async () => feed });
  assert.deepEqual(report.findings.map((f) => [f.file, f.severity]).sort(), [
    ['app/fiori-apps.html', 'info'],        // loads the launchpad sandbox
    ['webapp/index.html', 'warn'],          // a real page: still a warning
    ['webapp/test/unitTests.qunit.html', 'info'],
  ]);
  assert.match(report.findings.find((f) => f.file === 'app/fiori-apps.html').message, /^Local test page loads UI5 from the CDN without a version/);
  // both ways of recognising a test page are settings
  const strict = await scan({ root: fixture('test-pages'), now, config: { ui5: { testPagePattern: '^none$', testPageContent: '^none$' } }, fetchJsonImpl: async () => feed });
  assert.deepEqual(strict.findings.map((f) => f.severity), ['warn', 'warn', 'warn']);
});

test('Work Zone pin: wildcard patch is checked by minor, exact patch like a CDN load', () => {
  assert.deepEqual(sev(run('workzone', '1.148.x')), ['ok']);
  assert.deepEqual(sev(run('workzone', '1.148.*')), ['ok']);
  assert.ok(sev(run('workzone', '1.108.x')).includes('error'));
  assert.ok(run('workzone', '1.108.45').some((f) => /removed from the SAP CDN/.test(f.message) && f.severity === 'error'));
});

test('reads the Work Zone pin and BTP marker from manifest.json', () => {
  const m = readManifest(JSON.stringify({
    'sap.cloud': { service: 'demo' },
    'sap.platform.cf': { ui5VersionNumber: '1.136.x' },
    'sap.ui5': { dependencies: { minUI5Version: '1.120.0' } },
  }));
  assert.deepEqual(m, { minUI5Version: '1.120.0', pinned: '1.136.x', btp: true });
  assert.equal(readManifest('{"sap.app":{}}').btp, false);
  assert.equal(readManifest('not json'), null);
});

test('detects versions in ui5.yaml and bootstrap URLs', () => {
  assert.equal(versionFromUi5Yaml('framework:\n  name: SAPUI5\n  version: "1.120.5"\n'), '1.120.5');
  assert.equal(versionFromUi5Yaml('metadata:\n  version: "9.9.9"\n'), null);
  assert.deepEqual(versionsFromHtml('<script src="https://sapui5.hana.ondemand.com/1.84.3/resources/sap-ui-core.js">', hosts), ['1.84.3']);
  assert.deepEqual(versionsFromHtml('<script src="https://ui5.sap.com/resources/sap-ui-core.js">', hosts), [null]);
  const own = '<script src="https://cdn.customer.example/1.120.5/resources/sap-ui-core.js">';
  assert.deepEqual(versionsFromHtml(own, hosts), []);
  assert.deepEqual(versionsFromHtml(own, ['cdn.customer.example']), ['1.120.5']);
  assert.deepEqual(versionsFromHtml(own.replace('cdn.customer.example', 'cdnXcustomer.example'), ['cdn.customer.example']), []);
});

test('scan produces a report for the fixture app, including a probe', async () => {
  const report = await scan({
    root: fixture('app'),
    now,
    config: { project: 'demo', ui5: { probes: [{ name: 'DEV system', url: 'https://example.invalid/sap-ui-version.json' }] } },
    fetchJsonImpl: async (url) => (url.includes('sap-ui-version') ? { version: '1.136.12' } : feed),
  });
  assert.equal(report.project, 'demo');
  assert.equal(report.status, 'error');
  assert.equal(report.findings[0].severity, 'error');
  assert.ok(report.findings.some((f) => f.source === 'deployed' && f.version === '1.136.12'));
  assert.ok(report.findings.some((f) => f.source === 'minUI5Version' && f.severity === 'info'));
  const card = teamsPayload(report, 'warn', 2);
  assert.equal(card.attachments[0].content.type, 'AdaptiveCard');
  assert.ok(card.attachments[0].content.body.some((b) => /^…and \d+ more\.$/.test(b.text)));
});

test('BTP app without a pin warns under the LTS policy, info otherwise', async () => {
  const cfg = (requireLts) => ({ root: fixture('btp-app'), now, config: { ui5: { requireLts } }, fetchJsonImpl: async () => feed });
  const strict = await scan(cfg(true));
  assert.deepEqual(strict.findings.map((f) => [f.source, f.severity]), [['workzone', 'warn']]);
  assert.equal(strict.findings[0].recommendation, 'UI5 1.148 is in long-term maintenance until 2027-09-30');
  const relaxed = await scan(cfg(false));
  assert.deepEqual(relaxed.findings.map((f) => f.severity), ['info']);
});

test('a feed outage surfaces as an error instead of a green report', async () => {
  const report = await scan({
    root: fixture('app'), now,
    fetchJsonImpl: async () => { throw new Error('HTTP 503'); },
  });
  assert.equal(report.status, 'error');
  assert.match(report.findings[0].message, /Check failed to run/);
});

test('check selection: only, skip, typos and empty selections', () => {
  const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const ids = (settings) => selectChecks(settings, all).selected.map((c) => c.id);
  assert.deepEqual(ids({}), ['a', 'b', 'c']);
  assert.deepEqual(ids({ checks: ['a', 'c'] }), ['a', 'c']);
  assert.deepEqual(ids({ checks: ['a', 'b'], skipChecks: ['a'] }), ['b']);
  assert.deepEqual(selectChecks({ skipChecks: ['a', 'b'] }, all).skipped, ['a', 'b']);
  assert.throws(() => selectChecks({ checks: ['ui5'] }, all), /Unknown check\(s\): ui5/);
  assert.throws(() => selectChecks({ skipChecks: ['a', 'b', 'c'] }, all), /nothing to run/);
});

test('report records which checks ran and defaults the project to the folder name', async () => {
  const report = await scan({ root: fixture('btp-app'), now, fetchJsonImpl: async () => feed });
  assert.deepEqual(report.checks, { run: ['ui5-version', 'node-version', 'cf-node-version', 'cap-version', 'npm-audit', 'license'], skipped: [] });
  assert.equal(report.project, 'btp-app');
});

test('the feed can be a local file, and file patterns and excludes are settings', async () => {
  const noNetwork = async () => { throw new Error('network must not be used'); };
  const base = { ui5: { feed: fixture('versionoverview.json') } };
  const all = await scan({ root: fixture('app'), now, config: base, fetchJsonImpl: noNetwork });
  assert.deepEqual([...new Set(all.findings.map((f) => f.source))].sort(), ['bootstrap', 'framework', 'minUI5Version']);
  const noWebapp = await scan({ root: fixture('app'), now, config: { ...base, scan: { exclude: ['webapp'] } }, fetchJsonImpl: noNetwork });
  assert.deepEqual([...new Set(noWebapp.findings.map((f) => f.source))], ['framework']);
  const noYaml = await scan({ root: fixture('app'), now, config: { ui5: { ...base.ui5, yamlPattern: '^nothing$' } }, fetchJsonImpl: noNetwork });
  assert.ok(!noYaml.findings.some((f) => f.source === 'framework'));
});

test('reads the Fiori tools preview version from ui5.yaml', async () => {
  const yaml = (name) => readFile(fixture(`fiori-app/app1/${name}`), 'utf8');
  // the version of the proxy's ui5 block, not the one of another middleware further down
  assert.deepEqual(previewFromUi5Yaml(await yaml('ui5.yaml')), { version: '1.120.51' });
  // no version in the ui5 block means "latest"; the backend's version must not be picked up
  assert.deepEqual(previewFromUi5Yaml(await yaml('ui5-mock.yaml')), { version: null });
  assert.equal(previewFromUi5Yaml('framework:\n  version: "1.120.0"\n'), null);
  assert.deepEqual(previewFromUi5Yaml('    - name: fiori-tools-proxy\n      configuration:\n        ui5:\n          version: ""\n'), { version: null });
});

test('scans a Fiori tools project: preview versions, dotted yaml names, and no feed for info-only projects', async () => {
  const report = await scan({ root: fixture('fiori-app'), now, fetchJsonImpl: async () => feed });
  const of = (source) => report.findings.filter((f) => f.source === source);
  assert.deepEqual(of('preview').map((f) => [f.file, f.severity, f.version]).sort(), [
    ['app1/ui5-mock.yaml', 'info', undefined],
    ['app1/ui5.yaml', 'info', '1.120.51'],
    ['app1/ui5.yaml', 'warn', '1.120.51'],
  ]);
  assert.ok(!of('preview').some((f) => 'local' in f), 'internal marker must not leak into the report');
  assert.equal(of('preview').find((f) => !f.version).recommendation, undefined);
  assert.deepEqual(of('framework').map((f) => f.file), ['app2/ui5.local.yaml']);

  const infoOnly = await scan({
    root: fixture('fiori-app'), now,
    config: { ui5: { yamlPattern: 'ui5-mock\\.yaml$', manifestPattern: '^none$' } },
    fetchJsonImpl: async () => { throw new Error('feed must not be loaded'); },
  });
  assert.deepEqual(infoOnly.findings.map((f) => f.severity), ['info']);
});

test('identical findings are grouped across files for display', async () => {
  const report = await scan({ root: fixture('fiori-app'), now, fetchJsonImpl: async () => feed });
  const groups = groupFindings(report.findings);
  const floor = groups.find((g) => /^minUI5Version 1\.108 is out of maintenance/.test(g.message));
  assert.deepEqual(floor.files, ['app1/webapp/manifest.json', 'app2/webapp/manifest.json']);
  assert.ok(groups.length < report.findings.length);
  assert.equal(groups[0].severity, 'error');
  assert.equal(describeFiles([]), '');
  assert.equal(describeFiles(['a']), 'a');
  assert.equal(describeFiles(['a', 'b']), '2 files: a, b');
  assert.equal(describeFiles(['a', 'b', 'c', 'd', 'e']), '5 files: a, b, c and 2 more');
  const card = teamsPayload(report, 'info', 25).attachments[0].content.body.map((b) => b.text).join('\n');
  assert.match(card, /_\(2 files: app1\/webapp\/manifest\.json, app2\/webapp\/manifest\.json\)_/);
});

test('each recommendation is shown once per report, in text and in the Teams card', async () => {
  const report = await scan({ root: fixture('app'), now, fetchJsonImpl: async () => feed });
  assert.deepEqual(recommendations(report.findings), ['UI5 1.148 is in long-term maintenance until 2027-09-30']);
  assert.ok(report.findings.filter((f) => f.recommendation).length > 1, 'several findings carry it');
  const texts = teamsPayload(report, 'warn', 25).attachments[0].content.body.map((b) => b.text);
  assert.equal(texts.filter((t) => /UI5 1\.148 is in long-term maintenance/.test(t)).length, 1);
  assert.equal(texts.at(-1), 'UI5 1.148 is in long-term maintenance until 2027-09-30.'); // at the end of the card
  // every finding line with an action is followed by it
  const removed = texts.findIndex((t) => /1\.108\.45 has been removed/.test(t));
  assert.equal(texts[removed + 1], '→ Load a fixed version: https://ui5.sap.com/1.148.12/resources/sap-ui-core.js');
  // a recommendation only attached to findings below the threshold is left out of the card
  const quiet = { ...report, findings: report.findings.map((f) => ({ ...f, severity: 'info' })) };
  assert.ok(!teamsPayload(quiet, 'warn', 25).attachments[0].content.body.some((b) => /long-term maintenance until/.test(b.text)));
  assert.deepEqual(recommendations([{ message: 'x' }]), []);
});

test('the action depends on where the version was found', async () => {
  const action = (kind, version, extra = {}) => evaluate({ kind, file: 'f', version, ...extra }, index, policy)[0].action;
  assert.equal(action('framework', '1.148.12'), undefined); // supported and current: nothing to do
  assert.equal(action('framework', '1.120.52'), 'Set framework.version to 1.148.12'); // maintenance ends within the window
  assert.equal(action('framework', '1.108.56'), 'Set framework.version to 1.148.12');
  assert.equal(action('preview', '1.108.56'), 'Set the version in the fiori-tools-proxy ui5 block to 1.148.12');
  assert.equal(action('bootstrap', '1.108.56', { host: 'sapui5.hana.ondemand.com' }), 'Load a fixed version: https://sapui5.hana.ondemand.com/1.148.12/resources/sap-ui-core.js');
  assert.equal(action('workzone', '1.108.x'), 'Set "sap.platform.cf".ui5VersionNumber to 1.148.x');
  assert.equal(action('minUI5Version', '1.96.0'), 'Raise minUI5Version to 1.148.0');
  assert.equal(action('deployed', '1.108.56'), 'Upgrade the system to UI5 1.148');
  // a patch problem on a line that is still maintained: move to that line's newest patch
  const passed = evaluate({ kind: 'bootstrap', file: 'f', version: '1.120.33' }, index, policy);
  assert.equal(passed.find((f) => /cloud provisioning/.test(f.message)).action, 'Load a fixed version: https://ui5.sap.com/1.120.52/resources/sap-ui-core.js');
  // an unpinned BTP app is told exactly what to add
  const btp = await scan({ root: fixture('btp-app'), now, fetchJsonImpl: async () => feed });
  assert.equal(btp.findings[0].action, 'Add "sap.platform.cf": { "ui5VersionNumber": "1.148.x" } to the manifest');
  // the same problem in two kinds of places is shown twice, each with its own fix
  const groups = groupFindings([
    { severity: 'error', message: 'UI5 1.108 is out of maintenance.', file: 'a/ui5.yaml', action: 'Set framework.version to 1.148.12' },
    { severity: 'error', message: 'UI5 1.108 is out of maintenance.', file: 'b/ui5.yaml', action: 'Set framework.version to 1.148.12' },
    { severity: 'error', message: 'UI5 1.108 is out of maintenance.', file: 'c/index.html', action: 'Load a fixed version: x' },
  ]);
  assert.deepEqual(groups.map((g) => [g.files.length, g.action]), [[2, 'Set framework.version to 1.148.12'], [1, 'Load a fixed version: x']]);
});
