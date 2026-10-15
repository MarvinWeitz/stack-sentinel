// Contract tests against the real feeds (SAP's UI5 version overview, the Node.js release
// schedule, the Cloud Foundry Node.js buildpack manifest, the npm registry and its
// vulnerability service). Not part of `npm test`, because it needs
// network access and fails when a publisher changes its feed: run it with `npm run test:live`.
// Its job is to tell us the feed changed before the scanner quietly reports nonsense.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { indexPackage, registryLocation } from '../src/checks/cap.js';
import { parseBuildpackManifest } from '../src/checks/cf-node.js';
import { indexSchedule, recommendLine } from '../src/checks/node.js';
import { indexFeed, normaliseStatus, parseQuarter } from '../src/checks/ui5.js';
import { makeFetchJson, makeFetchText, makePostJson, scan } from '../src/cli.js';
import { resolveSettings } from '../src/settings.js';

const settings = resolveSettings({ env: process.env }).values;
const feed = await makeFetchJson(settings.timeoutSeconds)(settings.ui5.feed);

test('feed has the expected top-level shape', () => {
  assert.ok(Array.isArray(feed.versions) && feed.versions.length > 50, 'versions list');
  assert.ok(Array.isArray(feed.patches) && feed.patches.length > 100, 'patches list');
});

test('every version entry has a known status and readable dates', () => {
  for (const v of feed.versions) {
    assert.equal(typeof v.version, 'string');
    assert.notEqual(normaliseStatus(v.support), 'unknown', `unrecognised status "${v.support}" on ${v.version}`);
    assert.equal(typeof v.lts, 'boolean', `lts on ${v.version}`);
    for (const field of ['eom', 'eomm', 'eocp']) {
      const text = v[field];
      if (!text || normaliseStatus(v.support) === 'skipped') continue;
      assert.ok(parseQuarter(text), `${field} "${text}" on ${v.version} is not a quarter`);
    }
  }
});

test('every patch entry has a version and a readable date', () => {
  for (const p of feed.patches) {
    assert.match(p.version, /^\d+\.\d+\.\d+/);
    assert.ok(parseQuarter(p.eocp) || /to be determined/i.test(p.eocp), `eocp "${p.eocp}" on ${p.version}`);
  }
});

test('the index finds at least one long-term version in maintenance, with patches', () => {
  const index = indexFeed(feed);
  const lts = [...index.minors].filter(([, m]) => m.lts && m.status === 'maintenance');
  assert.ok(lts.length >= 1, 'no long-term maintenance version found');
  for (const [key, m] of lts) {
    assert.ok(index.latestPatch.has(key), `no patches for ${key}`);
    assert.ok(m.eomm || m.eom, `no end-of-maintenance date for ${key}`);
  }
  assert.ok(index.fallback, 'catch-all "*" entry');
});

test('the Node.js release schedule has the expected format', async () => {
  const schedule = await makeFetchJson(settings.timeoutSeconds)(settings.node.feed);
  const keys = Object.keys(schedule);
  assert.ok(keys.length > 20, 'release lines');
  for (const key of keys) {
    assert.match(key, /^v\d+(\.\d+)?$/, `unexpected key ${key}`);
    for (const field of ['start', 'end']) assert.match(schedule[key][field], /^\d{4}-\d{2}-\d{2}$/, `${field} on ${key}`);
  }
  const lines = indexSchedule(schedule);
  assert.ok(lines.length > 15);
  const now = new Date();
  assert.ok(lines.some((l) => l.end > now), 'no supported release line');
  const rec = recommendLine(lines, now);
  assert.ok(rec && rec.codename, 'no active long-term support line with a codename');
});

test('the Cloud Foundry buildpack manifest has the expected format', async () => {
  const buildpack = parseBuildpackManifest(await makeFetchText(settings.timeoutSeconds)(settings.cf.feed));
  assert.ok(buildpack.versions.length >= 1, 'no Node.js versions listed');
  assert.match(buildpack.defaultRange ?? '', /^\d+\.x$/, 'default Node.js version');
  for (const [major] of buildpack.versions) {
    assert.ok(buildpack.removal.has(major), `no removal date for the shipped Node.js ${major} line`);
  }
});

test('the npm registry still flags unsupported CAP versions the way the check expects', async () => {
  const fetchJson = makeFetchJson(settings.timeoutSeconds);
  for (const name of settings.cap.packages) {
    const pkg = indexPackage(await fetchJson(registryLocation(settings.cap.registry, name).url));
    assert.ok(pkg, `${name}: no usable "latest" version`);
    assert.ok(pkg.currentSince instanceof Date, `${name}: no release date for the current major`);
    assert.ok(!pkg.latest.unsupported, `${name}: the latest version is flagged unsupported`);
    const old = pkg.versions.filter((v) => v.parts[0] <= pkg.currentMajor - 3);
    assert.ok(old.length > 0 && old.filter((v) => v.unsupported).length / old.length > 0.9,
      `${name}: versions three or more majors back are no longer flagged unsupported`);
  }
});

test('the npm vulnerability service still answers in the format the check expects', async () => {
  const url = `${settings.audit.registry.replace(/\/+$/, '')}/-/npm/v1/security/advisories/bulk`;
  const answer = await makePostJson(settings.timeoutSeconds)(url, { minimist: ['1.2.5'] });
  const advisory = answer.minimist?.find((a) => a.severity === 'critical');
  assert.ok(advisory, 'the long-known critical advisory for minimist 1.2.5 is missing');
  for (const field of ['id', 'url', 'title', 'severity', 'vulnerable_versions']) assert.ok(advisory[field], `advisory without ${field}`);
});

test('a scan with the real feeds runs end to end', async () => {
  for (const dir of ['app', 'node-app', 'cf-app', 'cap-app', 'audit-app']) {
    const root = fileURLToPath(new URL(`../test/fixtures/${dir}`, import.meta.url));
    const report = await scan({ root, settings });
    assert.ok(!report.findings.some((f) => f.source === 'check'), `a check failed to run on ${dir}`);
    assert.ok(report.findings.length > 0, `no findings for ${dir}`);
  }
});
