// The agent skill and the plugin manifests that let the cbs Agentic Marketplace list it.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SETTINGS, envName } from '../src/settings.js';

const root = (p) => new URL(`../${p}`, import.meta.url);
const pkg = JSON.parse(await readFile(root('package.json'), 'utf8'));
const skill = await readFile(root('skills/stack-sentinel/SKILL.md'), 'utf8');

// Variables the pipeline examples read themselves, and those the CLI reads outside SETTINGS.
const PIPELINE_VARIABLES = ['SENTINEL_SOURCE', 'SENTINEL_PATH', 'SENTINEL_CONFIG', 'SENTINEL_SHARED_CONFIG', 'SENTINEL_FIX_TOKEN'];

test('the skill has frontmatter that follows the Agent Skills standard', () => {
  const front = skill.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(front, 'SKILL.md starts with a --- frontmatter block');
  const field = (name) => front[1].match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1];
  assert.equal(field('name'), 'stack-sentinel', 'name equals the folder name');
  assert.equal(field('license'), pkg.license);
  const description = field('description');
  assert.ok(description && description.length <= 1024, 'description has 1 to 1024 characters');
  assert.doesNotMatch(description, /[<>]/);
});

test('the skill names only settings and flags the tool has', async () => {
  const known = new Set([...SETTINGS.map(envName), ...PIPELINE_VARIABLES]);
  const used = new Set(skill.match(/\bSENTINEL_[A-Z0-9_]*[A-Z0-9]\b/g));
  assert.ok(used.size > 5);
  for (const name of used) assert.ok(known.has(name), `SKILL.md names "${name}", which is no setting`);

  const { stdout: help } = await promisify(execFile)(process.execPath, [fileURLToPath(root('bin/stack-sentinel.js')), '--help']);
  const flags = new Set(skill.match(/(?<![\w-])--[a-z][a-z-]*/g));
  for (const flag of ['--yes', '--body']) flags.delete(flag); // npx's and gh's own
  assert.ok(flags.size > 2);
  for (const flag of flags) assert.match(help, new RegExp(`^\\s+(-\\w, )?${flag}\\b`, 'm'), `SKILL.md names "${flag}", which is no flag`);
});

test('the skill installs the latest npm release', () => {
  const installs = [...skill.matchAll(/npx(?: --yes)? (@cbs-consulting\/stack-sentinel\S*)/g)].map((m) => m[1]);
  assert.ok(installs.length > 0);
  assert.deepEqual([...new Set(installs)], ['@cbs-consulting/stack-sentinel@latest']);
});

test('both plugin manifests match the package', async () => {
  for (const file of ['plugin.json', '.claude-plugin/plugin.json']) {
    const manifest = JSON.parse(await readFile(root(file), 'utf8'));
    assert.equal(manifest.name, 'stack-sentinel', file);
    assert.equal(manifest.version, pkg.version, `${file}: raise "version" with package.json`);
    assert.equal(manifest.license, pkg.license, file);
  }
  const { $schema } = JSON.parse(await readFile(root('plugin.json'), 'utf8'));
  assert.match($schema, /^https:\/\/agent-plugins\.org\/schemas\/1\.\d+\.\d+\/plugin\.schema\.json$/);
});
