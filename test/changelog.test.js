import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = (p) => new URL(`../${p}`, import.meta.url);
const changelog = await readFile(root('CHANGELOG.md'), 'utf8');
const { version } = JSON.parse(await readFile(root('package.json'), 'utf8'));

// The text under "## <heading> - <date>" up to the next "## ". The Release workflow cuts
// out the release notes the same way.
const section = (heading) => {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.split(' ')[0] === '##' && l.split(' ')[1] === heading);
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
};

test('the version in package.json has a changelog entry', () => {
  assert.match(changelog, new RegExp(`^## ${version.replaceAll('.', '\\.')} - \\d{4}-\\d{2}-\\d{2}$`, 'm'),
    `CHANGELOG.md has no entry for ${version}. Rename "Unreleased" to "${version} - YYYY-MM-DD", or add a section with that heading.`);
  assert.ok(section(version), `The entry for ${version} in CHANGELOG.md is empty.`);
});
