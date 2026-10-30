import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseBuildTimestamp } from '../src/checks/ui5.js';
import { scan } from '../src/cli.js';
import { refreshLockfiles } from '../src/fix/npm.js';

const fixture = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const now = new Date('2026-10-11T00:00:00Z');
const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString().replace(/\D/g, '').slice(0, 12);

test('reads sap-ui-version.json build timestamps', () => {
  assert.equal(parseBuildTimestamp('202610191230').toISOString(), '2026-10-19T12:30:00.000Z');
  assert.equal(parseBuildTimestamp('2026-10-19T12:30:00Z').toISOString(), '2026-10-19T12:30:00.000Z');
  assert.equal(parseBuildTimestamp(undefined), null);
});

test('minReleaseAgeDays: a UI5 patch is recommended only once it was built that many days ago', async () => {
  const built = { '1.148.12': daysAgo(3), '1.148.11': daysAgo(30), '1.120.52': daysAgo(40) };
  const asked = [];
  const fetchJsonImpl = async (url) => {
    asked.push(url);
    const version = /\/(\d+\.\d+\.\d+)\/resources\/sap-ui-version\.json$/.exec(url)?.[1];
    if (!version) throw new Error(`unexpected ${url}`);
    if (!built[version]) throw new Error(`HTTP 404 from ${url}`);
    return { version, buildTimestamp: built[version] };
  };
  const config = (days) => ({ checks: ['ui5-version'], minReleaseAgeDays: days, ui5: { feed: fixture('versionoverview.json') } });
  const actions = (report) => report.findings.filter((f) => f.fix).map((f) => f.fix.to);

  const plain = await scan({ root: fixture('app'), now, config: config(0), fetchJsonImpl });
  assert.deepEqual(asked, []);
  assert.ok(actions(plain).includes('1.148.12'));

  const held = await scan({ root: fixture('app'), now, config: config(7), fetchJsonImpl });
  assert.ok(!actions(held).includes('1.148.12'));
  assert.ok(actions(held).includes('1.148.11'), JSON.stringify(held.findings));
  assert.ok(asked.some((u) => u === 'https://ui5.sap.com/1.148.12/resources/sap-ui-version.json'));

  // a CDN that cannot be reached makes the check fail visibly, rather than guess
  const down = await scan({ root: fixture('app'), now, config: config(7), fetchJsonImpl: async () => { throw new Error('HTTP 503'); } });
  assert.match(down.findings[0].message, /Check failed to run: could not read when UI5 1\.\d+\.\d+ was built: HTTP 503/);
});

test('minReleaseAgeDays: npm only picks releases published before the cutoff', async () => {
  const disk = { 'package-lock.json': `${JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } })}\n` };
  const seen = [];
  const run = async (args, cwd) => {
    seen.push(args);
    if (args[0] === 'view') return '["1.0.5"]';
    if (args[0] === 'audit') await writeFile(join(cwd, 'package-lock.json'), await readFile(join(cwd, 'package-lock.json'), 'utf8'));
    return '';
  };
  const audit = { file: 'package-lock.json', finding: { fix: { kind: 'npm-audit', name: 'a', to: '1.0.5' } } };
  const raise = { file: 'package.json', finding: { fix: { kind: 'npm-dependency', name: 'a', from: '1.0.0', to: '1.0.5' } } };
  const before = new Date('2026-10-04T00:00:00Z');
  await refreshLockfiles({ lockfile: 'audit', changes: [audit, raise] }, new Map([['package.json', '{"dependencies":{"a":"1.0.0"}}']]), async (f) => disk[f] ?? null, { run, before });
  assert.deepEqual(seen.map((a) => [a[0], a.at(-1)]), [
    ['view', '--before=2026-10-04T00:00:00.000Z'],
    ['install', '--before=2026-10-04T00:00:00.000Z'],
    ['audit', '--before=2026-10-04T00:00:00.000Z'],
  ]);
});
