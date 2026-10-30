import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/cli.js';
import { parseIgnoreRules } from '../src/ignore.js';

const fixture = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const advisories = JSON.parse(await readFile(fixture('npm-advisories.json'), 'utf8'));
const now = new Date('2026-10-13T12:00:00Z');
const audit = (ignore) => scan({ root: fixture('audit-app'), now, config: { checks: ['npm-audit'], ignore }, postJsonImpl: async () => advisories });
const about = (report, name) => report.findings.find((f) => f.details?.package === name);

test('an ignored advisory takes its package out of the report, with the rule\'s reason and date', async () => {
  const before = await audit();
  assert.equal(about(before, 'minimist').severity, 'error');
  const report = await audit([{ advisory: 'GHSA-xvch-5gv4-984h', until: '2026-12-31', reason: 'only used by a build script' }]);
  assert.equal(about(report, 'minimist'), undefined);
  assert.deepEqual(report.ignored.map((f) => [f.details.package, f.ignoredBy]), [['minimist', { reason: 'only used by a build script', until: '2026-12-31' }]]);
  assert.ok(report.summary.error < before.summary.error);
  // the npm advisory number works too, and so does a rule that names the package
  assert.equal(about(await audit([{ advisory: '1097678' }]), 'minimist'), undefined);
  assert.equal(about(await audit([{ check: 'npm-audit', package: 'minimist' }]), 'minimist'), undefined);
});

test('a package is judged by the advisories that are not ignored', async () => {
  const report = await audit([{ advisory: 'GHSA-35jh-r3h4-6jhm' }, { advisory: 'ghsa-r5fr-rjxr-66jc', package: 'lodash' }]);
  const lodash = about(report, 'lodash');
  assert.equal(lodash.severity, 'info'); // the two high ones are ignored, moderate ones are left
  assert.equal(lodash.details.advisories.length, 3);
  assert.deepEqual(lodash.details.ignoredAdvisories.map((a) => a.id), [1106913, 1115806]);
  assert.equal(report.ignored, undefined);
  assert.ok(!report.findings.some((f) => f.check === 'ignore'), 'both rules count as used');
});

test('a rule past its date stops applying and says so; a rule that matches nothing says so', async () => {
  const report = await audit([
    { advisory: 'GHSA-xvch-5gv4-984h', until: '2026-10-12', reason: 'waiting for a release' },
    { check: 'npm-audit', package: 'left-pad' },
  ]);
  assert.equal(about(report, 'minimist').severity, 'error');
  assert.deepEqual(report.findings.filter((f) => f.check === 'ignore').map((f) => [f.severity, f.message]), [
    ['info', 'The ignore rule for GHSA-xvch-5gv4-984h ended on 2026-10-12 (waiting for a release), so what it matches is reported again.'],
    ['info', 'The ignore rule for npm-audit: left-pad matches no finding.'],
  ]);
  // the last day still counts
  assert.equal(about(await audit([{ advisory: 'GHSA-xvch-5gv4-984h', until: '2026-10-13' }]), 'minimist'), undefined);
  // a rule for a check that failed to run is not called unused
  const failed = await scan({ root: fixture('audit-app'), now, config: { checks: ['npm-audit'], ignore: [{ check: 'npm-audit', package: 'left-pad' }] }, postJsonImpl: async () => [1] });
  assert.ok(!failed.findings.some((f) => f.check === 'ignore'));
});

test('findings of any check can be ignored by file, version or message', async () => {
  const config = (ignore) => ({ checks: ['ui5-version'], ui5: { feed: fixture('versionoverview.json') }, ignore });
  const plain = await scan({ root: fixture('app'), now, config: config() });
  const target = plain.findings.find((f) => f.severity !== 'ok');
  assert.ok(target);
  for (const rule of [{ file: `^${target.file.replace(/\./g, '\\.')}$` }, { check: 'ui5-version', version: target.version }, { message: 'UI5' }]) {
    const report = await scan({ root: fixture('app'), now, config: config([rule]) });
    assert.ok(report.ignored.some((f) => f.message === target.message), JSON.stringify(rule));
    assert.ok(!report.findings.some((f) => f.message === target.message));
  }
});

test('rules that cannot be read stop the run', () => {
  const bad = (rule, why) => assert.throws(() => parseIgnoreRules([rule], now), why);
  assert.throws(() => parseIgnoreRules({}, now), /expected a list/);
  bad({ check: 'npm-audit' }, /at least one of file, package/);
  bad({ package: 'lodash', untill: '2027-01-01' }, /unknown field untill/);
  bad({ package: 'lodash', until: '2027-02-30' }, /YYYY-MM-DD/);
  bad({ package: 'lodash', until: 'next year' }, /YYYY-MM-DD/);
  bad({ file: '(' }, /"file" is not a valid regular expression/);
  bad({ advisory: 'GHSA-1', message: 'x' }, /cannot be combined/);
  bad({ package: 7 }, /"package" must be text/);
});
