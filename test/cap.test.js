import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { detect, evaluate, indexPackage, registryLocation } from '../src/checks/cap.js';
import { scan } from '../src/cli.js';
import { resolveSettings } from '../src/settings.js';

const fixture = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const doc = async (file) => JSON.parse(await readFile(fixture(`npm/${file}.json`), 'utf8'));
const cds = indexPackage(await doc('@sap__cds'));
const mtxs = indexPackage(await doc('@sap__cds-mtxs'));
// On this date @sap/cds 10 is current (first released 2026-07-02), 9 is the previous major,
// and 8 and older are marked unsupported on npm.
const now = new Date('2026-10-11T00:00:00Z');
const policy = { now, warnDays: 180, maintenanceMonths: 12 };
const judge = (usage, opts = {}, pkg = cds) => evaluate({ name: pkg.name, file: 'package.json', ...usage }, pkg, { ...policy, ...opts });
const sev = (findings) => findings.map((f) => f.severity);

test('reads the registry data: current major, its first release, support flags', () => {
  assert.equal(cds.currentMajor, 10);
  assert.equal(cds.currentSince.toISOString().slice(0, 10), '2026-07-02');
  assert.equal(cds.latest.node, '>=22');
  assert.ok(cds.versions.find((v) => v.version === '8.9.10').unsupported);
  assert.ok(!cds.versions.find((v) => v.version === '9.9.3').unsupported);
  assert.equal(indexPackage({ versions: { '1.0.0': {} } }), null); // no "latest" tag
  assert.equal(indexPackage({ 'dist-tags': { latest: '2.0.0-beta.1' }, versions: { '2.0.0-beta.1': {} } }), null);
});

test('builds registry URLs for scoped packages, and file names for a local folder', () => {
  assert.equal(registryLocation('https://registry.npmjs.org/', '@sap/cds').url, 'https://registry.npmjs.org/@sap%2Fcds');
  assert.match(registryLocation('some/folder', '@sap/cds').file, /some\/folder\/@sap__cds\.json$/);
});

test('current major is ok', () => {
  const f = judge({ range: '^10' });
  assert.deepEqual(sev(f), ['ok']);
  assert.equal(f[0].message, '@sap/cds "^10" (resolves to 10.1.1) is on the current major version.');
  assert.equal(f[0].recommendation, undefined);
  assert.deepEqual(sev(judge({ range: 'latest' })), ['ok']);
  assert.deepEqual(sev(judge({ range: '>=8' })), ['ok']); // npm would install the newest match
});

test('a version SAP marked unsupported is an error, from a range or a lockfile', () => {
  const ranged = judge({ range: '^8' });
  assert.deepEqual(sev(ranged), ['error']);
  assert.equal(ranged[0].message, '@sap/cds "^8" (resolves to 8.9.10) is no longer supported: SAP has marked it as unsupported on npm.');
  assert.equal(ranged[0].recommendation, '@sap/cds 10 is the current major version; it needs Node.js >=22');
  assert.equal(ranged[0].source, 'range');
  const locked = judge({ range: '^8', installed: '8.9.4' });
  assert.equal(locked[0].message, '@sap/cds 8.9.4 is no longer supported: SAP has marked it as unsupported on npm.');
  assert.equal(locked[0].source, 'lockfile');
  assert.equal(locked[0].version, '8.9.4');
});

test('the lockfile wins over the range', () => {
  // the range would allow 10, but 9 is what is installed
  assert.deepEqual(sev(judge({ range: '>=9', installed: '9.4.4' })), ['info']);
  assert.deepEqual(sev(judge({ range: '^9', installed: '9.99.0' })), ['warn']); // not in the registry
});

test('two or more majors behind is an error even when the version is not flagged', () => {
  // @sap/cds-mtxs 2.7.7 is not marked unsupported on npm, but 4 is current
  const f = judge({ range: '^2' }, {}, mtxs);
  assert.deepEqual(sev(f), ['error']);
  assert.match(f[0].message, /resolves to 2\.7\.7\) is 2 major versions behind\. Only the current major \(4\) and the one before it are supported\./);
});

test('previous major: info until 180 days before the estimated end of life, then a warning', () => {
  const early = judge({ range: '^9' });
  assert.deepEqual(sev(early), ['info']);
  assert.match(early[0].message, /is on the previous major version, which gets critical fixes only until about 2027-07-02, 12 months after version 10 was released\.$/);
  assert.equal(early[0].recommendation, '@sap/cds 10 is the current major version; it needs Node.js >=22');

  const window = judge({ range: '^9' }, { now: new Date('2027-02-01T00:00:00Z') });
  assert.deepEqual(sev(window), ['warn']);
  assert.match(window[0].message, /Estimated end of life: 2027-07-02 \(152 days\), 12 months after version 10 was released\.$/);
  assert.equal(window[0].details.daysLeft, 152);

  const late = judge({ range: '^9' }, { now: new Date('2027-08-01T00:00:00Z') });
  assert.deepEqual(sev(late), ['warn']);
  assert.match(late[0].message, /estimated end of life \(2027-07-02, .*\) has passed\./);

  // both numbers are settings
  assert.deepEqual(sev(judge({ range: '^9' }, { warnDays: 300 })), ['warn']);
  assert.match(judge({ range: '^9' }, { maintenanceMonths: 6 })[0].message, /Estimated end of life: 2027-01-02/);
});

test('a range that matches nothing is a warning', () => {
  assert.deepEqual(sev(judge({ range: '^99' })), ['warn']);
});

test('detects CAP dependencies, reads lockfiles, and skips non-registry references', async () => {
  const cfg = resolveSettings({}).values.cap;
  const files = ['package.json', 'package-lock.json', 'services/fresh/package.json', 'services/legacy/package.json', 'tools/package.json'];
  const usages = await detect(fixture('cap-app'), files, cfg);
  assert.deepEqual(usages.map((u) => [u.file, u.name, u.range, u.installed]), [
    ['package.json', '@sap/cds', '^9', '9.4.4'],
    ['package.json', '@sap/cds-dk', '^8', '8.9.11'],            // from devDependencies
    ['package.json', '@sap/cds-mtxs', '^2', null],              // not in the lockfile
    ['services/fresh/package.json', '@sap/cds', '^10', null],   // the root lockfile has 9.4.4, which does not fit ^10
    ['services/legacy/package.json', '@sap/cds', '^7', '7.9.5'], // installed inside the workspace folder
    // tools/package.json points at a git repository: skipped
  ]);
});

test('scans a project end to end from a local copy of the registry', async () => {
  const report = await scan({
    root: fixture('cap-app'), now,
    config: { checks: ['cap-version'], cap: { registry: fixture('npm') } },
    fetchJsonImpl: async () => { throw new Error('network must not be used'); },
  });
  assert.deepEqual(report.findings.map((f) => [f.file, f.severity, f.version]), [
    ['package.json', 'error', '8.9.11'],
    ['package.json', 'error', '2.7.7'],
    ['services/legacy/package.json', 'error', '7.9.5'],
    ['package.json', 'info', '9.4.4'],
    ['services/fresh/package.json', 'ok', '10.1.1'],
  ]);
});

test('asks the registry once per package, and only for packages the project uses', async () => {
  const asked = [];
  const report = await scan({
    root: fixture('cap-app'), now, config: { checks: ['cap-version'] },
    fetchJsonImpl: async (url) => {
      asked.push(url);
      return doc(decodeURIComponent(url.split('/').pop()).replace('/', '__'));
    },
  });
  assert.deepEqual(asked.sort(), ['https://registry.npmjs.org/@sap%2Fcds', 'https://registry.npmjs.org/@sap%2Fcds-dk', 'https://registry.npmjs.org/@sap%2Fcds-mtxs']);
  assert.equal(report.status, 'error');

  const none = await scan({
    root: fixture('node-app'), now, config: { checks: ['cap-version'] },
    fetchJsonImpl: async () => { throw new Error('registry must not be asked'); },
  });
  assert.deepEqual(none.findings, []);
});

test('unusable registry data fails the check visibly', async () => {
  const report = await scan({
    root: fixture('cap-app'), now, config: { checks: ['cap-version'] },
    fetchJsonImpl: async () => ({ error: 'not found' }),
  });
  assert.match(report.findings[0].message, /Check failed to run: the registry data for @sap\/cds has no usable "latest" version/);
});
