import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bulkRequest, dependencyGraph, evaluate, firstFixedVersion, installedPackages, overrideEntries, trace, unneededOverrides } from '../src/checks/npm-audit.js';
import { scan } from '../src/cli.js';

const fixture = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
// A trimmed real lockfile (dependencies listed only among the packages kept), and the
// registry's real answer for it on 2026-10-13.
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

// A made-up project: web brings in vuln through router, which pins it below the fix, and
// through a cycle that would allow it; tool has its own, newer copy nested; web bundles packed.
const made = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'made', dependencies: { web: '^1.0.0', lib: '^1.0.0' }, devDependencies: { tool: '^1.0.0' } },
    'node_modules/web': { version: '1.0.0', dependencies: { router: '^1.0.0', 'cycle-a': '1.0.0', packed: '1.0.0' }, bundleDependencies: ['packed'] },
    'node_modules/web/node_modules/packed': { version: '1.0.0', inBundle: true },
    'node_modules/router': { version: '1.0.0', dependencies: { vuln: '~1.0.0' } },
    'node_modules/cycle-a': { version: '1.0.0', dependencies: { 'cycle-b': '1.0.0' } },
    'node_modules/cycle-b': { version: '1.0.0', dependencies: { 'cycle-a': '1.0.0', vuln: '^1.0.0' } },
    'node_modules/vuln': { version: '1.0.0' },
    'node_modules/lib': { version: '1.0.0', dependencies: { loose: '^2.0.0' } },
    'node_modules/loose': { version: '2.0.0' },
    'node_modules/tool': { version: '1.0.0', dev: true, dependencies: { vuln: '^2.0.0' } },
    'node_modules/tool/node_modules/vuln': { version: '2.0.0', dev: true },
  },
};
const madeAdvisories = {
  vuln: [{ title: 'v', severity: 'high', vulnerable_versions: '<1.1.0' }],
  packed: [{ title: 'p', severity: 'high', vulnerable_versions: '<1.0.1' }],
  loose: [{ title: 'l', severity: 'high', vulnerable_versions: '<2.0.5' }],
};
const madeFindings = (lockfile = 'package-lock.json') => {
  const graph = dependencyGraph(made);
  return evaluate(lockfile, installedPackages(made), madeAdvisories, policy, graph);
};

test('the graph resolves dependencies the way Node.js does, and traces copies back to direct dependencies', () => {
  const graph = dependencyGraph(made);
  // tool finds its nested copy first, so the hoisted vuln 1.0.0 is not tool's
  assert.deepEqual(graph.parents.get('node_modules/tool/node_modules/vuln').map((e) => e.from), ['node_modules/tool']);
  assert.deepEqual(graph.parents.get('node_modules/vuln').map((e) => e.from).sort(), ['node_modules/cycle-b', 'node_modules/router']);
  // the shortest chain per direct dependency, through the cycle without looping
  assert.deepEqual(trace(graph, ['node_modules/vuln']), [{ root: '', dev: false, chain: ['node_modules/web', 'node_modules/router', 'node_modules/vuln'] }]);
  assert.deepEqual(trace(graph, ['node_modules/tool']), [{ root: '', dev: true, chain: ['node_modules/tool'] }]);
});

test('a finding says which direct dependency brings the package in', () => {
  const vuln = byName(madeFindings(), 'vuln');
  assert.match(vuln.message, / It comes in through web 1\.0\.0 → router 1\.0\.0 → vuln 1\.0\.0\.$/);
  assert.deepEqual(vuln.details.introducedBy, [
    { package: 'web', version: '1.0.0', dev: false, manifest: 'package.json', chain: ['web@1.0.0', 'router@1.0.0', 'vuln@1.0.0'] },
  ]);
});

test('the action names what stands in the way of the fix', () => {
  const findings = madeFindings('apps/orders/package-lock.json');
  // router pins vuln below the fix: web has to move, or an override forces it
  assert.equal(byName(findings, 'vuln').action, 'Update vuln to 1.1.0 or later, which router 1.0.0 (asks for "~1.0.0") does not allow: '
    + 'update web to a release whose dependencies allow it (or force it with an "overrides" entry in apps/orders/package.json), '
    + 'then run "npm install" in apps/orders');
  // lib's range already allows the fix: the lockfile is only stale
  assert.equal(byName(findings, 'loose').action, 'Update loose to 2.0.5 or later: lib 1.0.0 already allows it, so only the lockfile is out of date (run "npm audit fix" in apps/orders)');
  // a bundled copy can only be replaced by the package that bundles it
  assert.equal(byName(findings, 'packed').action, 'packed is bundled inside web 1.0.0, so only a release of web that bundles packed 1.0.1 or later fixes it');
  // a direct dependency pinned in package.json
  const pinned = { lockfileVersion: 3, packages: { '': { dependencies: { vuln: '1.0.0' } }, 'node_modules/vuln': { version: '1.0.0' } } };
  const [direct] = evaluate('package-lock.json', installedPackages(pinned), madeAdvisories, policy, dependencyGraph(pinned));
  assert.equal(direct.action, 'Update vuln to 1.1.0 or later, which package.json (asks for "1.0.0") does not allow: raise it in package.json, then run "npm install" in the project folder');
  assert.doesNotMatch(direct.message, /comes in through/);
});

test('workspaces and lockfile version 1 are traced too', () => {
  const workspaces = {
    lockfileVersion: 3,
    packages: {
      '': { workspaces: ['packages/app'] },
      'node_modules/app': { link: true, resolved: 'packages/app' },
      'packages/app': { name: 'app', version: '1.0.0', dependencies: { router: '^1.0.0' } },
      'node_modules/router': { version: '1.0.0', dependencies: { vuln: '~1.0.0' } },
      'node_modules/vuln': { version: '1.0.0' },
    },
  };
  const [ws] = evaluate('package-lock.json', installedPackages(workspaces), madeAdvisories, policy, dependencyGraph(workspaces));
  assert.equal(ws.details.introducedBy[0].manifest, 'packages/app/package.json');
  assert.match(ws.action, /update router to a release that allows it \(or force it with an "overrides" entry in package\.json\)/);

  const v1 = { lockfileVersion: 1, dependencies: { router: { version: '1.0.0', requires: { vuln: '~1.0.0' }, dependencies: { vuln: { version: '1.0.0' } } } } };
  const graph = dependencyGraph(v1, { dependencies: { router: '^1.0.0' } });
  const [old] = evaluate('package-lock.json', installedPackages(v1), madeAdvisories, policy, graph);
  assert.deepEqual(old.details.introducedBy[0].chain, ['router@1.0.0', 'vuln@1.0.0']);
});

test('reads plain and scoped overrides', () => {
  assert.deepEqual(overrideEntries({ a: '1.0.0', '@s/b@^1': '1.2.0', c: { '.': '2.0.0', d: '3.0.0', e: { f: '1.0.0' } } }), [
    { name: 'a', parent: null, key: '"a"', path: ['a'] },
    { name: '@s/b', parent: null, key: '"@s/b@^1"', path: ['@s/b@^1'] },
    { name: 'c', parent: null, key: '"c"', path: ['c', '.'] },
    { name: 'd', parent: 'c', key: '"d" under "c"', path: ['c', 'd'] },
  ]);
  assert.deepEqual(overrideEntries(undefined), []);
});

test('an override is reported when it no longer does anything', () => {
  const lockOf = (range) => ({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { express: '^5.0.0', other: '^1.0.0' } },
      'node_modules/express': { version: '5.2.1', dependencies: { 'proxy-addr': range } },
      'node_modules/other': { version: '1.0.0' },
      'node_modules/proxy-addr': { version: '2.0.8' },
    },
  });
  const check = (range, overrides) => unneededOverrides('apps/orders/package-lock.json', dependencyGraph(lockOf(range)), overrides);

  // express's own range already allows what the override forced
  const [loose] = check('^2.0.7', { 'proxy-addr': '^2.0.8' });
  assert.equal(loose.severity, 'info');
  assert.equal(loose.message, 'The override for proxy-addr in apps/orders/package.json is no longer needed: express 5.2.1 (asks for "^2.0.7") already allows the installed 2.0.8.');
  assert.equal(loose.action, 'Remove "proxy-addr" from "overrides" in apps/orders/package.json, then run "npm install" in apps/orders');
  assert.deepEqual(loose.details.askedBy, [{ by: 'express 5.2.1', range: '^2.0.7' }]);
  assert.equal(check('^2.0.7', { express: { 'proxy-addr': '^2.0.8' } }).length, 1);

  // express still pins the vulnerable version: the override is doing its job
  assert.deepEqual(check('2.0.7', { 'proxy-addr': '^2.0.8' }), []);
  assert.deepEqual(check('git+https://example.com/proxy-addr.git', { 'proxy-addr': '^2.0.8' }), []);

  // nothing installed to override, at all or below the given parent
  const [gone] = check('2.0.7', { 'left-pad': '1.3.0' });
  assert.match(gone.message, /^The override for left-pad in apps\/orders\/package\.json is unused: left-pad is not installed\.$/);
  const [elsewhere] = check('2.0.7', { other: { 'proxy-addr': '^2.0.8' } });
  assert.match(elsewhere.message, /is unused: proxy-addr is not installed below other\.$/);
  assert.equal(elsewhere.action, 'Remove "proxy-addr" under "other" from "overrides" in apps/orders/package.json, then run "npm install" in apps/orders');
});

test('a scan reads the overrides from the package.json next to the lockfile', async () => {
  const report = await scan({ root: fixture('audit-overrides'), config: { checks: ['npm-audit'] }, postJsonImpl: async () => ({}) });
  assert.deepEqual(report.findings.map((f) => [f.severity, f.source, f.message]), [
    ['info', 'overrides', 'The override for proxy-addr in package.json is no longer needed: express 5.2.1 (asks for "^2.0.7") already allows the installed 2.0.8.'],
    ['info', 'overrides', 'The override for path-to-regexp in package.json is unused: path-to-regexp is not installed.'],
    ['ok', 'lockfile', 'No known vulnerabilities of moderate severity or above in 2 installed packages.'],
  ]);
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

test('a fix for the fix pull requests only where npm can do it alone, after raising the project\'s own range', () => {
  const findings = madeFindings('apps/orders/package-lock.json');
  assert.deepEqual(byName(findings, 'loose').fix, { kind: 'npm-audit', name: 'loose', to: '2.0.5' });
  assert.equal(byName(findings, 'vuln').fix, undefined); // router stands in the way
  assert.equal(byName(findings, 'packed').fix, undefined); // bundled
  const pinned = (range) => ({ lockfileVersion: 3, packages: { '': { dependencies: { vuln: range } }, 'node_modules/vuln': { version: '1.0.0' } } });
  const fixOf = (range) => evaluate('a/package-lock.json', installedPackages(pinned(range)), madeAdvisories, policy, dependencyGraph(pinned(range)))[0].fix;
  assert.deepEqual(fixOf('1.0.0'), { kind: 'npm-audit', name: 'vuln', to: '1.1.0', raise: [{ manifest: 'a/package.json', from: '1.0.0', to: '1.1.0' }] });
  assert.equal(fixOf('~1.0.0').raise[0].to, '~1.1.0');
  assert.equal(fixOf('>=1.0.0 <1.1.0').raise[0].to, '^1.1.0');
  const workspaces = { lockfileVersion: 3, packages: { '': { workspaces: ['p'] }, p: { name: 'p', version: '1.0.0', dependencies: { vuln: '^1.0.0' } }, 'node_modules/vuln': { version: '1.0.0' } } };
  assert.equal(evaluate('package-lock.json', installedPackages(workspaces), madeAdvisories, policy, dependencyGraph(workspaces))[0].fix, undefined);
});
