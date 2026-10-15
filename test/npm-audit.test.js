import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bulkRequest, evaluate, firstFixedVersion, installedPackages } from '../src/checks/npm-audit.js';
import { scan } from '../src/cli.js';

const fixture = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
// A trimmed real lockfile, and the registry's real answer for it on 2026-10-13.
const lock = JSON.parse(await readFile(fixture('audit-app/package-lock.json'), 'utf8'));
const advisories = JSON.parse(await readFile(fixture('npm-advisories.json'), 'utf8'));
const policy = { reportFrom: 'moderate', warnAt: 'high', errorAt: 'critical' };
const packages = installedPackages(lock);
const byName = (findings, name) => findings.find((f) => f.details.package === name);

test('reads installed packages from lockfile versions 1 to 3', () => {
  assert.ok(packages.some((p) => p.name === 'lodash' && p.version === '4.17.20' && !p.dev));
  assert.ok(packages.some((p) => p.name === 'jest' && p.dev));
  assert.ok(!packages.some((p) => p.name === 'audit-demo')); // the project itself
  const v1 = installedPackages({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0', dev: true } } } } });
  assert.deepEqual(v1, [{ name: 'a', version: '1.0.0', dev: false }, { name: 'b', version: '2.0.0', dev: true }]);
  const workspace = installedPackages({ packages: { '': {}, 'packages/app': { version: '1.0.0' }, 'node_modules/app': { link: true }, 'node_modules/@sap/cds': { version: '10.1.1' } } });
  assert.deepEqual(workspace.map((p) => p.name), ['@sap/cds']);
  assert.deepEqual(bulkRequest([{ name: 'a', version: '1.0.0' }, { name: 'a', version: '1.0.0' }, { name: 'a', version: '2.0.0' }]), { a: ['1.0.0', '2.0.0'] });
});

test('severity follows the worst advisory: critical is an error, high a warning, moderate info', () => {
  const findings = evaluate('package-lock.json', packages, advisories, policy);
  assert.equal(byName(findings, 'minimist').severity, 'error');
  assert.equal(byName(findings, 'lodash').severity, 'warn');
  assert.equal(byName(findings, 'express').severity, 'info');
  assert.match(byName(findings, 'minimist').message, /^minimist 1\.2\.5 has a known vulnerability, the worst critical: Prototype Pollution in minimist\.$/);
  assert.match(byName(findings, 'lodash').message, /^lodash 4\.17\.20 has \d+ known vulnerabilities, the worst high: .*; and \d+ more\.$/);
  assert.ok(byName(findings, 'lodash').details.advisories.every((a) => a.url.startsWith('https://github.com/advisories/')));
});

test('development-only packages are reported as info at most', () => {
  const braces = evaluate('package-lock.json', packages, advisories, policy).filter((f) => f.details.package === 'braces');
  assert.ok(braces.length > 0);
  assert.ok(braces.every((f) => f.severity === 'info' && /\(development dependency\)/.test(f.message)));
  // a package installed both for development and at runtime counts as runtime
  const both = evaluate('l', [{ name: 'lodash', version: '4.17.20', dev: true }, { name: 'lodash', version: '4.17.20', dev: false }], advisories, policy);
  assert.deepEqual(both.map((f) => f.severity), ['warn']);
});

test('the thresholds are settings', () => {
  const strict = evaluate('l', packages, advisories, { reportFrom: 'moderate', warnAt: 'moderate', errorAt: 'high' });
  assert.equal(byName(strict, 'lodash').severity, 'error');
  assert.equal(byName(strict, 'express').severity, 'warn');
  const quiet = evaluate('l', packages, advisories, { reportFrom: 'critical', warnAt: 'critical', errorAt: 'critical' });
  assert.deepEqual(quiet.map((f) => f.details.package), ['minimist']);
});

test('the action names the first version past every advisory', () => {
  assert.equal(firstFixedVersion([4, 17, 20], [{ vulnerable_versions: '<4.17.21' }, { vulnerable_versions: '>=4.0.0 <=4.17.23' }]), '4.17.24');
  assert.equal(firstFixedVersion([1, 2, 5], [{ vulnerable_versions: '<0.2.4 || >=1.0.0 <1.2.6' }]), '1.2.6');
  assert.equal(firstFixedVersion([1, 0, 0], [{ vulnerable_versions: '>=0.0.0' }]), null);
  const findings = evaluate('apps/orders/package-lock.json', packages, advisories, policy);
  assert.equal(byName(findings, 'minimist').action, 'Update minimist to 1.2.6 or later (run "npm audit fix" in apps/orders)');
  const unfixed = evaluate('package-lock.json', [{ name: 'x', version: '1.0.0', dev: false }], { x: [{ title: 't', severity: 'high', vulnerable_versions: '*' }] }, policy);
  assert.match(unfixed[0].action, /^No fixed version of x is known yet/);
});

test('scans every lockfile, asks the registry once per lockfile, and reports a clean one as ok', async () => {
  const asked = [];
  const report = await scan({
    root: fixture('audit-app'), now: new Date('2026-10-13T00:00:00Z'), config: { checks: ['npm-audit'] },
    postJsonImpl: async (url, body) => { asked.push([url, Object.keys(body).length]); return advisories; },
  });
  assert.deepEqual(asked, [['https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', 8]] /* 8 package names, braces in two versions */);
  assert.equal(report.status, 'error');

  const clean = await scan({
    root: fixture('audit-app'), config: { checks: ['npm-audit'] }, postJsonImpl: async () => ({}),
  });
  assert.deepEqual(clean.findings.map((f) => [f.severity, f.message]), [['ok', 'No known vulnerabilities of moderate severity or above in 9 installed packages.']]);

  const none = await scan({ root: fixture('node-app'), config: { checks: ['npm-audit'] }, postJsonImpl: async () => { throw new Error('must not be asked'); } });
  assert.deepEqual(none.findings, []);

  const broken = await scan({ root: fixture('audit-app'), config: { checks: ['npm-audit'] }, postJsonImpl: async () => [1] });
  assert.match(broken.findings[0].message, /Check failed to run: the registry gave an unexpected answer/);
});
