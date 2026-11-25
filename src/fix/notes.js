/**
 * Release notes for a fix pull request, so whoever reviews it sees what changes without
 * looking it up. UI5 gets links to its change log and to the changes between the old and
 * the new version in UI5 Lib Diff; Node.js gets a link to its change log; npm packages get the
 * advisories they fix and, when the package's repository is on GitHub, the release notes
 * published there between the old and the new version. Nothing here may stop a pull request:
 * whatever cannot be read becomes a link.
 */

const exact = (v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? ''))?.slice(1).map(Number) ?? null;
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const MAX_RELEASES = 5;
const MAX_BODY = 1500;

/**
 * Text taken from someone else's repository must not notify people or link issues there:
 * @mentions and #references are broken with a zero-width space, and GitHub links go through
 * redirect.github.com, which GitHub does not count as a reference (Dependabot does the same).
 */
export function quote(text, max = MAX_BODY) {
  const cut = text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')} …` : text;
  return cut
    .replace(/https?:\/\/github\.com\//g, 'https://redirect.github.com/')
    .replace(/(^|[^\w`/])@([A-Za-z0-9][\w-]*)/g, '$1@\u200b$2')
    .replace(/(^|[^&])#(\d+)\b/g, '$1#\u200b$2');
}

/** "git+https://github.com/lodash/lodash.git" -> { owner, repo }, or null for anything not on GitHub. */
export function githubRepository(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/].*)?$/.exec(url ?? '') ?? /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url ?? '');
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** The version a release tag names, for `name`: "v4.18.0", "4.18.0", "lodash@4.18.0"; null for another package's tag. */
export function tagVersion(tag, name) {
  const m = /^(?:(.+)@)?v?(\d+\.\d+\.\d+)$/.exec(String(tag ?? '').trim());
  if (!m) return null;
  return !m[1] || m[1] === name || m[1] === name.split('/').pop() ? m[2] : null;
}

/** GitHub release notes of `name` after `from`, up to and including `to`, newest first. */
async function githubReleases(name, from, to, { fetchJson, registry }) {
  const meta = await fetchJson(`${registry.replace(/\/+$/, '')}/${name.replace('/', '%2F')}/latest`);
  const repo = githubRepository(meta?.repository);
  if (!repo) return { link: `https://www.npmjs.com/package/${name}?activeTab=versions`, releases: [] };
  const link = `https://redirect.github.com/${repo.owner}/${repo.repo}/releases`;
  const list = await fetchJson(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100`);
  const [lo, hi] = [exact(from), exact(to)];
  const releases = (Array.isArray(list) ? list : [])
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({ version: tagVersion(r.tag_name, name), body: String(r.body ?? '').trim(), url: r.html_url }))
    .filter((r) => r.version && lo && hi && compare(exact(r.version), lo) > 0 && compare(exact(r.version), hi) <= 0)
    .sort((a, b) => compare(exact(b.version), exact(a.version)));
  return { link, releases };
}

/** "1.120" and "1.136.x" as the release UI5 Lib Diff can show: "1.120.0", "1.136.0". */
const diffVersion = (v) => {
  const m = /^(\d+)\.(\d+)(?:\.(\d+|x))?$/.exec(String(v ?? ''));
  return m ? `${m[1]}.${m[2]}.${m[3] && m[3] !== 'x' ? m[3] : 0}` : null;
};

/**
 * A link to the changes between two UI5 versions in UI5 Lib Diff (ui5-lib-diff.marianzeis.de),
 * which lists the features, fixes and deprecations of every release in between; null when
 * `to` is not later than `from`. `ui5Type` is "SAPUI5" or "OpenUI5".
 */
export function ui5DiffLink(from, to, ui5Type = 'SAPUI5') {
  const [a, b] = [diffVersion(from), diffVersion(to)];
  if (!a || !b || compare(exact(a), exact(b)) >= 0) return null;
  const query = new URLSearchParams({ versionFrom: a, versionTo: b, ui5Type });
  return { from: a, to: b, ui5Type, url: `https://ui5-lib-diff.marianzeis.de/?${query}` };
}

/**
 * The "Release notes" part of a pull request description, as lines; empty when there is
 * nothing to say. `withBodies: false` gives links only (Azure DevOps allows 4000 characters
 * in a description). `fetchJson` reads the registry and the GitHub API.
 */
export async function releaseNotes(group, applied, { fetchJson, registry = 'https://registry.npmjs.org', withBodies = true } = {}) {
  const lines = [];
  if (group.id === 'ui5') {
    const targets = [...new Set(applied.map((c) => c.finding.fix.to))].sort();
    for (const t of targets) {
      lines.push(t.endsWith('.x')
        ? `- [SAPUI5 change log](https://ui5.sap.com/#/releasenotes.html) for ${t}`
        : `- [SAPUI5 ${t} change log](https://ui5.sap.com/${t}/#/releasenotes.html)`);
    }
    const diffs = new Map();
    for (const { finding } of applied) {
      const diff = ui5DiffLink(finding.version, finding.fix.to, finding.fix.ui5Type);
      if (diff) diffs.set(diff.url, diff);
    }
    const order = (x, y) => x.ui5Type.localeCompare(y.ui5Type) || compare(exact(x.from), exact(y.from)) || compare(exact(x.to), exact(y.to));
    for (const d of [...diffs.values()].sort(order)) {
      lines.push(`- [Changes in ${d.ui5Type} from ${d.from} to ${d.to}](${d.url}) (UI5 Lib Diff)`);
    }
  } else if (group.id === 'node') {
    const majors = [...new Set(applied.map((c) => /\d+/.exec(c.finding.fix.to)?.[0]).filter(Boolean))].sort((a, b) => a - b);
    for (const m of majors) lines.push(`- [Node.js ${m} change log](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V${m}.md)`);
  } else if (group.id === 'cap') {
    lines.push('- [CAP release notes](https://cap.cloud.sap/docs/releases/)');
  } else if (group.id === 'npm-audit') {
    const seen = new Set();
    for (const { finding } of applied.filter((c) => c.finding.fix.kind === 'npm-audit')) {
      const { name, to } = finding.fix;
      if (seen.has(`${name}@${finding.version}`)) continue;
      seen.add(`${name}@${finding.version}`);
      lines.push(`**${name}** ${finding.version} → ${to}`);
      const advisories = finding.details?.advisories ?? [];
      if (advisories.length) lines.push('');
      for (const a of advisories) {
        const id = /GHSA-[\w-]+$/i.exec(a.url ?? '')?.[0] ?? a.id;
        lines.push(`- ${a.severity}: ${quote(String(a.title ?? ''), 200)}${a.url ? ` ([${id}](${a.url}))` : ''}`);
      }
      let found = { link: `https://www.npmjs.com/package/${name}?activeTab=versions`, releases: [] };
      if (fetchJson) {
        try {
          found = await githubReleases(name, finding.version, to, { fetchJson, registry });
        } catch { /* a link is enough */ }
      }
      const shown = withBodies ? found.releases.filter((r) => r.body).slice(0, MAX_RELEASES) : [];
      for (const r of shown) {
        lines.push('', `<details><summary>${name} ${r.version}</summary>`, '', quote(r.body), '', '</details>');
      }
      const more = shown.length > 0 && found.releases.length > shown.length;
      if (shown.length === 0 || more) lines.push('', `[${more ? 'All release notes' : 'Release notes'}](${found.link})`);
      lines.push('');
    }
    while (lines.at(-1) === '') lines.pop();
  }
  return lines.length ? ['', '### Release notes', '', ...lines] : [];
}
