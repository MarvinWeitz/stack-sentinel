import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS, describeSettings, envName, resolveSettings } from '../src/settings.js';

test('flag beats environment beats config beats default', () => {
  const r = (sources) => resolveSettings(sources);
  assert.equal(r({}).values.ui5.warnDays, 180);
  assert.equal(r({ config: { ui5: { warnDays: 90 } } }).values.ui5.warnDays, 90);
  assert.equal(r({ env: { SENTINEL_UI5_WARN_DAYS: '30' }, config: { ui5: { warnDays: 90 } } }).values.ui5.warnDays, 30);
  const all = r({ cli: { checks: 'c' }, env: { SENTINEL_CHECKS: 'a' }, config: { checks: ['b'] } });
  assert.deepEqual(all.values.checks, ['c']);
  assert.equal(all.sources.checks, 'flag');
  assert.equal(r({}).sources['ui5.warnDays'], 'default');
});

test('an empty environment variable counts as not set', () => {
  // Azure DevOps hands over an undefined variable as its own unexpanded text
  assert.equal(resolveSettings({ env: { SENTINEL_HEARTBEAT_URL: '$(SENTINEL_HEARTBEAT_URL)' } }).values.heartbeat, undefined);
  assert.deepEqual(resolveSettings({ env: { SENTINEL_CHECKS: '' }, config: { checks: ['b'] } }).values.checks, ['b']);
});

test('values are converted and validated per type', () => {
  const v = resolveSettings({ env: {
    SENTINEL_UI5_REQUIRE_LTS: 'false', SENTINEL_SCAN_EXCLUDE: 'node_modules, vendor', SENTINEL_SCAN_MAX_DEPTH: '3',
  } }).values;
  assert.equal(v.ui5.requireLts, false);
  assert.deepEqual(v.scan.exclude, ['node_modules', 'vendor']);
  assert.equal(v.scan.maxDepth, 3);
  assert.throws(() => resolveSettings({ env: { SENTINEL_UI5_WARN_DAYS: 'soon' } }), /SENTINEL_UI5_WARN_DAYS: expected a whole number/);
  assert.throws(() => resolveSettings({ cli: { 'fail-on': 'fatal' } }), /--fail-on: expected one of/);
  assert.throws(() => resolveSettings({ config: { ui5: { yamlPattern: '(' } } }), /valid regular expression/);
  assert.throws(() => resolveSettings({ config: { ui5: { requireLts: 'maybe' } } }), /"ui5.requireLts" in the config file/);
});

test('the webhook URL is never read from the config file and is masked in output', () => {
  assert.equal(resolveSettings({ config: { webhook: 'https://x' } }).sources.webhook, 'default');
  const resolved = resolveSettings({ env: { SENTINEL_WEBHOOK_URL: 'https://secret.example/abc' } });
  assert.equal(resolved.values.webhook, 'https://secret.example/abc');
  assert.ok(!describeSettings(resolved).join('\n').includes('secret.example'));
});

test('the heartbeat URL is treated like the webhook URL: not from config, masked', () => {
  assert.equal(resolveSettings({ config: { heartbeat: 'https://x' } }).values.heartbeat, undefined);
  const resolved = resolveSettings({ cli: { heartbeat: 'https://ping.example/secret-id' } });
  assert.equal(resolved.values.heartbeat, 'https://ping.example/secret-id');
  assert.ok(!describeSettings(resolved).join('\n').includes('secret-id'));
});

test('unrelated config content such as probes is kept', () => {
  const probes = [{ name: 'x', url: 'https://x' }];
  assert.deepEqual(resolveSettings({ config: { ui5: { probes } } }).values.ui5.probes, probes);
});

test('environment variable names are derived from the key and unique', () => {
  const names = SETTINGS.map(envName);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('SENTINEL_SKIP_CHECKS') && names.includes('SENTINEL_UI5_CDN_HOSTS') && names.includes('SENTINEL_NOTIFY_MAX_FINDINGS'));
});

test('a shared config ranks between the project config file and the defaults', () => {
  const shared = { ui5: { warnDays: 270, requireLts: false }, notifyOn: 'error' };
  const plain = resolveSettings({ shared });
  assert.equal(plain.values.ui5.warnDays, 270);
  assert.equal(plain.sources['ui5.warnDays'], 'shared');
  assert.equal(plain.sources['node.warnDays'], 'default');

  const project = resolveSettings({ shared, config: { ui5: { warnDays: 90 } } });
  assert.equal(project.values.ui5.warnDays, 90);            // the project wins
  assert.equal(project.sources['ui5.warnDays'], 'config');
  assert.equal(project.values.ui5.requireLts, false);       // and still gets the rest
  assert.equal(project.values.notifyOn, 'error');

  assert.equal(resolveSettings({ shared, env: { SENTINEL_NOTIFY_ON: 'info' } }).values.notifyOn, 'info');
  assert.throws(() => resolveSettings({ shared: { ui5: { warnDays: 'soon' } } }), /"ui5.warnDays" in the shared config: expected a whole number/);
});

test('shared config: content that is not a setting is merged, secrets are never read from it', () => {
  const shared = { webhook: 'https://x', heartbeat: 'https://y', ui5: { probes: [{ name: 'shared', url: 'https://a' }] } };
  const a = resolveSettings({ shared });
  assert.equal(a.values.webhook, undefined);
  assert.equal(a.values.heartbeat, undefined);
  assert.deepEqual(a.values.ui5.probes, shared.ui5.probes);
  // lists are replaced, not combined
  const own = [{ name: 'own', url: 'https://b' }];
  assert.deepEqual(resolveSettings({ shared, config: { ui5: { probes: own } } }).values.ui5.probes, own);
});
