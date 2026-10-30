import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubRepository, quote, releaseNotes, tagVersion } from '../src/fix/notes.js';

test('text from other repositories notifies nobody and links no issues there', () => {
  const out = quote('Thanks @alice (#123, owner/repo#9) see https://github.com/x/y/pull/4 and a@b.c, &#35;');
  assert.equal(out, 'Thanks @​alice (#​123, owner/repo#​9) see https://redirect.github.com/x/y/pull/4 and a@b.c, &#35;');
  assert.equal(quote('one two three', 9), 'one two …');
});

test('finds the GitHub repository and the version a release tag names', () => {
  for (const url of ['git+https://github.com/lodash/lodash.git', 'git://github.com/lodash/lodash', 'github:lodash/lodash', 'https://github.com/lodash/lodash/tree/main/packages/x']) {
    assert.deepEqual(githubRepository({ url }), { owner: 'lodash', repo: 'lodash' }, url);
  }
  assert.equal(githubRepository({ url: 'https://gitlab.com/a/b.git' }), null);
  assert.equal(tagVersion('v4.18.0', 'lodash'), '4.18.0');
  assert.equal(tagVersion('lodash@4.18.0', 'lodash'), '4.18.0');
  assert.equal(tagVersion('@scope/pkg@1.0.0', '@scope/pkg'), '1.0.0');
  assert.equal(tagVersion('other@1.0.0', 'lodash'), null);
  assert.equal(tagVersion('nightly', 'lodash'), null);
});

const audit = (fix, extra = {}) => ({
  file: 'package-lock.json',
  finding: {
    version: '4.17.20', fix: { kind: 'npm-audit', name: 'lodash', ...fix },
    details: { advisories: [{ id: 1, severity: 'high', title: 'Prototype pollution in @lodash', url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm' }] },
    ...extra,
  },
});

test('npm packages: the advisories, and the GitHub release notes between the two versions', async () => {
  const asked = [];
  const fetchJson = async (url) => {
    asked.push(url);
    if (url === 'https://registry.npmjs.org/lodash/latest') return { repository: { url: 'git+https://github.com/lodash/lodash.git' } };
    if (url.startsWith('https://api.github.com/repos/lodash/lodash/releases')) {
      return [
        { tag_name: '4.18.1', body: 'too new' }, { tag_name: 'v4.18.0', body: 'Fixes #12 by @bob' }, { tag_name: 'v4.17.21', body: 'Security fix' },
        { tag_name: '4.17.20', body: 'what is installed' }, { tag_name: 'v4.18.0-rc.1', body: 'pre', prerelease: true },
      ];
    }
    throw new Error(`unexpected ${url}`);
  };
  const lines = await releaseNotes({ id: 'npm-audit' }, [audit({ to: '4.18.0' })], { fetchJson });
  assert.deepEqual(lines, [
    '', '### Release notes', '',
    '**lodash** 4.17.20 → 4.18.0', '',
    '- high: Prototype pollution in @​lodash ([GHSA-35jh-r3h4-6jhm](https://github.com/advisories/GHSA-35jh-r3h4-6jhm))',
    '', '<details><summary>lodash 4.18.0</summary>', '', 'Fixes #​12 by @​bob', '', '</details>',
    '', '<details><summary>lodash 4.17.21</summary>', '', 'Security fix', '', '</details>',
  ]);
  assert.equal(asked.length, 2);

  // links only where descriptions are short, and a link when nothing can be read
  const short = await releaseNotes({ id: 'npm-audit' }, [audit({ to: '4.18.0' })], { fetchJson, withBodies: false });
  assert.equal(short.at(-1), '[Release notes](https://redirect.github.com/lodash/lodash/releases)');
  const failing = await releaseNotes({ id: 'npm-audit' }, [audit({ to: '4.18.0' })], { fetchJson: async () => { throw new Error('HTTP 403'); } });
  assert.equal(failing.at(-1), '[Release notes](https://www.npmjs.com/package/lodash?activeTab=versions)');
  // a range raised in package.json is part of the same move, not another package
  const raised = { file: 'package.json', finding: { version: '4.17.20', fix: { kind: 'npm-dependency', name: 'lodash', to: '4.18.0' } } };
  assert.equal((await releaseNotes({ id: 'npm-audit' }, [audit({ to: '4.18.0' }), raised], { fetchJson })).filter((l) => l.startsWith('**')).length, 1);
});

test('UI5, Node.js and CAP: links to their change logs', async () => {
  const change = (to) => ({ finding: { fix: { to } } });
  assert.deepEqual(await releaseNotes({ id: 'ui5' }, [change('1.148.12'), change('1.148.x'), change('1.148.12')]), [
    '', '### Release notes', '',
    '- [SAPUI5 1.148.12 change log](https://ui5.sap.com/1.148.12/#/releasenotes.html)',
    '- [SAPUI5 change log](https://ui5.sap.com/#/releasenotes.html) for 1.148.x',
  ]);
  assert.deepEqual((await releaseNotes({ id: 'node' }, [change('^24'), change('22.x'), change('24')])).slice(3), [
    '- [Node.js 22 change log](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V22.md)',
    '- [Node.js 24 change log](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V24.md)',
  ]);
  assert.equal((await releaseNotes({ id: 'cap' }, [change('^9')])).length, 4);
  assert.deepEqual(await releaseNotes({ id: 'npm-overrides' }, [change(undefined)]), []);
});
