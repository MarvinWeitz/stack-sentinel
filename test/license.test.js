import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judge, parseExpression } from '../src/checks/license.js';
import { scan } from '../src/cli.js';

const fixture = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const policy = (license = {}) => ({ checks: ['license'], license });
const summary = (report) => report.findings.map((f) => [f.severity, f.details?.package ?? null]);

test('reads SPDX expressions, and nothing that is not one', () => {
  assert.deepEqual(parseExpression('MIT'), { id: 'MIT' });
  assert.deepEqual(parseExpression('(MIT OR Apache-2.0)'), { op: 'or', left: { id: 'MIT' }, right: { id: 'Apache-2.0' } });
  assert.deepEqual(parseExpression('MIT AND (BSD-2-Clause OR ISC)'),
    { op: 'and', left: { id: 'MIT' }, right: { op: 'or', left: { id: 'BSD-2-Clause' }, right: { id: 'ISC' } } });
  assert.deepEqual(parseExpression('GPL-2.0-only WITH Classpath-exception-2.0'), { id: 'GPL-2.0-only' });
  for (const text of ['SEE LICENSE IN LICENSE', 'UNLICENSED', '', null, '(MIT', 'MIT OR', 'Custom: proprietary']) {
    assert.equal(parseExpression(text), null, String(text));
  }
});

test('OR takes the best choice, AND the worst; -only and -or-later match the plain id', () => {
  const p = { allow: [], deny: ['GPL-3.0'] };
  assert.equal(judge(parseExpression('GPL-3.0-or-later'), p).verdict, 'denied');
  assert.equal(judge(parseExpression('MIT OR GPL-3.0'), p).verdict, 'ok');
  assert.deepEqual(judge(parseExpression('MIT AND GPL-3.0+'), p), { verdict: 'denied', ids: ['GPL-3.0+'] });
  const listed = { allow: ['MIT', 'ISC'], deny: [] };
  assert.equal(judge(parseExpression('Apache-2.0'), listed).verdict, 'not-allowed');
  assert.equal(judge(parseExpression('mit'), listed).verdict, 'ok');
});

test('the default policy: strong copyleft is an error, a package without an SPDX license is info, development packages info at most', async () => {
  const report = await scan({ root: fixture('license-app'), config: policy() });
  assert.deepEqual(summary(report), [
    ['error', 'gpl-lib'], ['error', 'both'],
    ['info', '@sap/cds'], ['info', 'nothing'], ['info', 'dev-gpl'],
  ]);
  const gpl = report.findings.find((f) => f.details.package === 'gpl-lib');
  assert.equal(gpl.message, 'gpl-lib 1.0.0 is licensed under GPL-3.0-or-later; GPL-3.0-or-later is on the deny list (license.deny).');
  assert.equal(report.findings.find((f) => f.details.package === '@sap/cds').message,
    '@sap/cds 9.4.0 declares "SEE LICENSE IN LICENSE", which is not an SPDX license expression.');
});

test('an allow list makes every other license a warning; unknown licenses can be made warnings or left out', async () => {
  const report = await scan({ root: fixture('license-app'), config: policy({ allow: ['MIT', 'BSD-3-Clause'], deny: [], unknown: 'ok' }) });
  assert.deepEqual(summary(report), [['warn', 'gpl-lib'], ['warn', 'both'], ['info', 'dev-gpl']]);
  const strict = await scan({ root: fixture('license-app'), config: policy({ unknown: 'warn' }) });
  assert.equal(strict.findings.find((f) => f.details.package === 'nothing').severity, 'warn');
  // what is approved can be ignored like any other finding
  const ignored = await scan({ root: fixture('license-app'), config: { ...policy(), ignore: [{ check: 'license', package: 'gpl-lib', reason: 'approved by legal' }] } });
  assert.equal(ignored.ignored[0].details.package, 'gpl-lib');
});

test('a clean lockfile is ok, and lockfile version 1 says it records no licenses', async () => {
  const clean = await scan({ root: fixture('license-app'), config: policy({ deny: [], unknown: 'ok' }) });
  assert.deepEqual(clean.findings.map((f) => [f.severity, f.message]), [['ok', 'The licenses of all 9 installed packages meet the license policy.']]);
  const root = await mkdtemp(join(tmpdir(), 'sentinel-license-'));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0' } } }));
  const v1 = await scan({ root, config: policy() });
  await rm(root, { recursive: true });
  assert.deepEqual(v1.findings.map((f) => [f.severity, f.message]), [['info', 'The lockfile does not record licenses (lockfile version 1).']]);
});
