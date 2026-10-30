import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate, indexSchedule, parseRange, parseVersionFile, recommendLine } from '../src/checks/node.js';
import { scan } from '../src/cli.js';

const fixture = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const schedule = JSON.parse(await readFile(fixture('node-schedule.json'), 'utf8'));
const lines = indexSchedule(schedule);
// On this date: 18 and 20 are past end of life, 22 is in maintenance, 24 is the active
// LTS, 26 is released but not yet LTS, 25 (non-LTS) is past end of life.
const now = new Date('2026-10-11T00:00:00Z');
const policy = { now, requireLts: true, warnDays: 180 };

const range = (text, opts = {}) => evaluate({ source: 'engines', file: 'package.json', text, spec: { kind: 'range', intervals: parseRange(text) } }, lines, { ...policy, ...opts });
const sev = (findings) => findings.map((f) => f.severity);
const majors = (text) => lines.filter((l) => parseRange(text).some(([lo, hi]) => (lo[0] < l.major + 1) && (hi[0] > l.major || (hi[0] === l.major && (hi[1] > 0 || hi[2] > 0))))).map((l) => l.major);

test('reads the schedule and ignores lines before 1.0', () => {
  assert.deepEqual(lines.map((l) => l.major), [16, 18, 20, 21, 22, 23, 24, 25, 26, 27]);
  assert.equal(lines.find((l) => l.major === 22).codename, 'jod');
  assert.equal(recommendLine(lines, now).major, 24);
  assert.equal(recommendLine(lines, new Date('2026-11-01T00:00:00Z')).major, 26);
});

test('understands npm-style ranges', () => {
  assert.deepEqual(majors('20'), [20]);
  assert.deepEqual(majors('20.x'), [20]);
  assert.deepEqual(majors('v22.3.0'), [22]);
  assert.deepEqual(majors('^20.11.0'), [20]);
  assert.deepEqual(majors('~22.1'), [22]);
  assert.deepEqual(majors('>=22'), [22, 23, 24, 25, 26, 27]);
  assert.deepEqual(majors('>20'), [21, 22, 23, 24, 25, 26, 27]);
  assert.deepEqual(majors('>=18 <21'), [18, 20]);
  assert.deepEqual(majors('<=20'), [16, 18, 20]);
  assert.deepEqual(majors('>= 20 < 23'), [20, 21, 22]);
  assert.deepEqual(majors('18 - 20'), [18, 20]);
  assert.deepEqual(majors('^20.11.0 || >=22.0.0'), [20, 22, 23, 24, 25, 26, 27]);
  assert.deepEqual(majors('>=16 <17 || >=18 <19 || >=20'), [16, 18, 20, 21, 22, 23, 24, 25, 26, 27]);
  assert.deepEqual(majors('*'), lines.map((l) => l.major));
  assert.equal(parseRange('twenty'), null);
  assert.equal(parseRange('>=20 || nonsense'), null);
  assert.deepEqual(parseRange('>=22 <20'), []);
});

test('error when every allowed version is past end of life', () => {
  const f = range('^20');
  assert.deepEqual(sev(f), ['error']);
  assert.equal(f[0].message, '"^20" only allows Node.js 20, which reached end of life on 2026-04-30.');
  assert.equal(f[0].recommendation, 'Node.js 24 is supported until 2028-04-30');
  assert.equal(f[0].details.recommended, '24');
  assert.deepEqual(sev(range('>=16 <19')), ['error']);
});

test('warning when the range still starts at an end-of-life version', () => {
  const f = range('>=18');
  assert.deepEqual(sev(f), ['warn']);
  assert.equal(f[0].message, '">=18" still allows Node.js 18, which reached end of life on 2025-04-30.');
  assert.equal(f[0].action, 'Raise the lowest version "engines.node" allows to 22');
  // end-of-life odd releases in the middle of an open range are not worth a warning
  assert.deepEqual(sev(range('>=22')), ['ok']);
});

test('warning inside the window before end of life, info while in maintenance', () => {
  assert.deepEqual(sev(range('22.x')), ['info']);
  assert.match(range('22.x')[0].message, /Node\.js 22 is in maintenance until 2027-04-30; Node\.js 24 is the current/);
  const late = range('22.x', { now: new Date('2027-01-15T00:00:00Z') });
  assert.deepEqual(sev(late), ['warn']);
  assert.match(late[0].message, /reach end of life by 2027-04-30 \(106 days\)\.$/);
  assert.equal(late[0].recommendation, 'Node.js 26 is supported until 2029-04-30');
  assert.equal(range('24.x')[0].recommendation, undefined); // already on the recommended line
  assert.deepEqual(sev(range('24.x')), ['ok']);
});

test('non-LTS release lines warn unless the policy is off; unreleased ones match nothing', () => {
  const before = { now: new Date('2026-03-01T00:00:00Z') }; // 25 is still supported here
  assert.ok(range('25', before).some((f) => /not a long-term support release/.test(f.message) && f.severity === 'warn'));
  assert.ok(!range('25', { ...before, requireLts: false }).some((f) => /not a long-term/.test(f.message)));
  assert.deepEqual(sev(range('27')), ['warn']);
  assert.match(range('27')[0].message, /matches no released Node\.js version/);
});

test('version files: numbers, codenames, lts and latest aliases, comments', () => {
  assert.deepEqual(parseVersionFile('v22.3.0\n').text, 'v22.3.0');
  assert.deepEqual(parseVersionFile('# comment\n\n20 # trailing\n').text, '20');
  assert.deepEqual(parseVersionFile('lts/*').spec, { kind: 'lts-latest' });
  assert.deepEqual(parseVersionFile('lts/Jod').spec, { kind: 'codename', name: 'jod' });
  assert.deepEqual(parseVersionFile('node').spec, { kind: 'latest' });
  assert.equal(parseVersionFile('\n\n'), null);
  assert.equal(parseVersionFile('banana').spec, null);
  const file = (text) => evaluate({ source: 'version-file', file: '.nvmrc', ...parseVersionFile(text) }, lines, policy);
  assert.deepEqual(sev(file('lts/*')), ['ok']);
  assert.deepEqual(sev(file('lts/iron')), ['error']); // iron = 20
  assert.deepEqual(sev(file('lts/unknown')), ['warn']);
  assert.deepEqual(sev(file('node')), ['warn']);
  assert.deepEqual(sev(evaluate({ source: 'version-file', file: '.nvmrc', ...parseVersionFile('node') }, lines, { ...policy, requireLts: false })), ['info']);
});

test('scans a project: engines in several package.json files and a version file', async () => {
  const report = await scan({
    root: fixture('node-app'), now,
    config: { checks: ['node-version'], node: { feed: fixture('node-schedule.json') } },
    fetchJsonImpl: async () => { throw new Error('network must not be used'); },
  });
  assert.deepEqual(report.checks, { run: ['node-version'], skipped: ['ui5-version', 'cf-node-version', 'cap-version', 'npm-audit', 'license'] });
  assert.deepEqual(report.findings.map((f) => [f.file, f.source, f.severity]), [
    ['package.json', 'engines', 'error'],
    ['router/package.json', 'engines', 'warn'],
    ['.nvmrc', 'version-file', 'info'],
  ]);
  // tools/package.json declares nothing and is not at the root: no finding for it
});

test('a root package.json without a Node.js version gets an info, and needs no schedule', async () => {
  const report = await scan({
    root: fixture('node-app/tools'), now, config: { checks: ['node-version'] },
    fetchJsonImpl: async () => { throw new Error('schedule must not be loaded'); },
  });
  assert.deepEqual(report.findings.map((f) => [f.source, f.severity]), [['project', 'info']]);
});

test('an unreadable version is a warning, and a broken schedule fails the check visibly', async () => {
  const bad = await scan({
    root: fixture('node-app'), now,
    config: { checks: ['node-version'], node: { feed: 'https://example.invalid/schedule.json' } },
    fetchJsonImpl: async () => ({ unexpected: true }),
  });
  assert.equal(bad.status, 'error');
  assert.match(bad.findings[0].message, /Check failed to run: the Node\.js release schedule has no usable entries/);
});

test('actions say what to change in the place the version was found', () => {
  assert.equal(range('^20')[0].action, 'Set "engines.node" to "^24"');
  const file = evaluate({ source: 'version-file', file: '.nvmrc', ...parseVersionFile('20') }, lines, policy);
  assert.equal(file[0].action, 'Change it to "24"');
  assert.equal(range('24.x')[0].action, undefined); // nothing to change
});
