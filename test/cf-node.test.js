import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate, nodeModules, parseBuildpackManifest, readList } from '../src/checks/cf-node.js';
import { scan } from '../src/cli.js';

const fixture = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const manifestText = await readFile(fixture('buildpack-manifest.yml'), 'utf8');
const buildpack = parseBuildpackManifest(manifestText);
const now = new Date('2026-10-11T00:00:00Z');
const types = ['nodejs', 'approuter.nodejs', 'javascript.nodejs', 'hdb'];
const judge = (range, opts = {}) => evaluate({ file: 'package.json', source: 'mta', modules: ['srv'], range }, buildpack, { now, warnDays: 180, ...opts });
const sev = (findings) => findings.map((f) => f.severity);

test('reads shipped versions, removal dates and the default from the buildpack manifest', () => {
  assert.deepEqual(buildpack.versions, [[22, 23, 3], [24, 21, 0]]); // listed once per stack, python ignored
  assert.equal(buildpack.defaultRange, '22.x');
  assert.equal(buildpack.removal.get(22).toISOString().slice(0, 10), '2027-04-30');
  assert.equal(buildpack.removal.get(24).toISOString().slice(0, 10), '2028-04-30');
  assert.deepEqual(parseBuildpackManifest('nothing: here\n').versions, []);
});

test('reads lists of maps from YAML, ignoring comments and nested content', () => {
  const yaml = 'a: 1\nmodules:\n  # comment\n  - name: one\n  # between\n    type: "nodejs"   # trailing\n    requires:\n      - name: nested\n        type: other\n  - name: two\n    path: \'x/y\'\nresources:\n  - name: three\n';
  const items = readList(yaml, 'modules');
  assert.deepEqual(items.map((i) => i.fields), [{ name: 'one', type: 'nodejs' }, { name: 'two', path: 'x/y' }]);
  assert.deepEqual(readList(yaml, 'absent'), []);
  assert.deepEqual(readList('modules: none\n', 'modules'), []);
});

test('finds the Node.js modules of an mta.yaml and the apps of a manifest.yml', async () => {
  const mta = nodeModules(await readFile(fixture('cf-app/mta.yaml'), 'utf8'), types);
  assert.deepEqual(mta.map((m) => [m.name, m.path]), [['demo-srv', 'gen/srv'], ['demo-router', 'router'], ['demo-db-deployer', 'db']]);
  const apps = nodeModules(await readFile(fixture('cf-app/tools/manifest.yml'), 'utf8'), types);
  assert.deepEqual(apps.map((a) => [a.name, a.path, a.exact]), [['demo-api', 'api', false], ['demo-static', 'missing', true]]);
  assert.deepEqual(nodeModules('applications:\n  - name: py\n    buildpacks:\n      - python_buildpack\n', types), []);
});

test('error when the range matches nothing the buildpack ships', () => {
  const old = judge('^20');
  assert.deepEqual(sev(old), ['error']);
  assert.equal(old[0].message, '"^20" matches no Node.js version in the Cloud Foundry buildpack, so staging fails. The current Cloud Foundry Node.js buildpack ships 22.23.3 and 24.21.0.');
  assert.deepEqual(old[0].details.shipped, ['22.23.3', '24.21.0']);
  // supported by the Node.js project, but not shipped by the buildpack yet
  assert.deepEqual(sev(judge('26')), ['error']);
  assert.deepEqual(sev(judge('>=26')), ['error']);
  // an exact version of a shipped line gets a hint
  assert.equal(judge('22.11.0')[0].action, 'Use a range such as "22.x" instead of an exact version');
  assert.equal(judge('20.1.0')[0].action, 'Set "engines.node" to "^24"'); // 20 is not shipped at all
  assert.equal(old[0].action, 'Set "engines.node" to "^24"');
});

test('resolves to the newest matching version, like Cloud Foundry does', () => {
  assert.equal(judge('>=18')[0].message, '">=18" resolves to Node.js 24.21.0 in the Cloud Foundry buildpack.');
  assert.equal(judge('^22')[0].details.resolved, '22.23.3');
  assert.deepEqual(sev(judge('22.23.3')), ['ok']);
});

test('warns before the last matching line leaves the buildpack', () => {
  const soon = judge('22.x', { now: new Date('2027-01-15T00:00:00Z') });
  assert.deepEqual(sev(soon), ['warn']);
  assert.match(soon[0].message, /leaves the Cloud Foundry buildpack on 2027-04-30 \(106 days\)\. After that, staging fails\./);
  // 24 stays longer, so a range that also allows it is fine
  assert.deepEqual(sev(judge('>=22', { now: new Date('2027-01-15T00:00:00Z') })), ['ok']);
  assert.deepEqual(sev(judge('22.x', { now: new Date('2027-06-01T00:00:00Z') })), ['warn']);
});

test('no declared version means the buildpack default, reported as info', () => {
  const none = judge(null);
  assert.deepEqual(sev(none), ['info']);
  assert.match(none[0].message, /uses the buildpack default, 22\.x\./);
  const late = judge(null, { now: new Date('2027-01-15T00:00:00Z') });
  assert.deepEqual(sev(late), ['info', 'warn']);
  assert.match(late[1].message, /^The buildpack default 22\.x resolves to Node\.js 22\.23\.3, which leaves/);
  assert.deepEqual(sev(judge('banana')), ['warn']);
});

test('scans a project: only deployed Node.js modules are judged', async () => {
  const report = await scan({
    root: fixture('cf-app'), now,
    config: { checks: ['cf-node-version'], cf: { feed: fixture('buildpack-manifest.yml') } },
    fetchTextImpl: async () => { throw new Error('network must not be used'); },
  });
  assert.deepEqual(report.findings.map((f) => [f.file, f.source, f.severity]), [
    ['package.json', 'mta', 'error'],            // demo-srv: gen/srv is build output, so the root package.json counts
    ['tools/api/package.json', 'cf-manifest', 'error'],
    ['db/package.json', 'mta', 'info'],
    ['router/package.json', 'mta', 'ok'],
  ]);
  // app/orders is an html5 module, and tools/missing has no package.json: neither is judged
});

test('does not apply, and needs no manifest, when nothing is deployed to Cloud Foundry', async () => {
  const report = await scan({
    root: fixture('node-app'), now, config: { checks: ['cf-node-version'] },
    fetchTextImpl: async () => { throw new Error('manifest must not be loaded'); },
  });
  assert.deepEqual(report.findings, []);
});

test('loads the manifest from a URL as text, and a manifest without Node.js fails visibly', async () => {
  const ok = await scan({
    root: fixture('cf-app'), now, config: { checks: ['cf-node-version'] },
    fetchTextImpl: async () => manifestText,
  });
  assert.equal(ok.findings.filter((f) => f.severity === 'error').length, 2);
  const broken = await scan({
    root: fixture('cf-app'), now, config: { checks: ['cf-node-version'] },
    fetchTextImpl: async () => 'language: nodejs\n',
  });
  assert.match(broken.findings[0].message, /Check failed to run: the buildpack manifest lists no Node\.js versions/);
});
