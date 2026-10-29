import { atLeast } from '../severity.js';
import { applyFix } from './edits.js';

/**
 * Fixes are grouped by what they change, one pull request per group. A group's id is part of
 * its branch name, which never changes, so every run finds the pull request an earlier run
 * opened for it. `check` is the check whose findings fill the group.
 */
export const GROUPS = [
  { id: 'ui5', checks: ['ui5-version'], kinds: /^ui5-/ },
  { id: 'node', checks: ['node-version', 'cf-node-version'], kinds: /^node-/ },
  { id: 'npm-overrides', checks: ['npm-audit'], kinds: /^npm-override-/ },
];

/** "1.136.11" -> [1, 136, 11]; "1.136.x" -> [1, 136, Infinity]. */
const parts = (v) => String(v).split('.').map((p) => (p === 'x' ? Infinity : Number(p) || 0));
const newer = (a, b) => {
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

/**
 * The fixes a report's findings carry, grouped. One place in a file can be named by several
 * findings (a line out of maintenance, and a patch removed from the CDN); the one that moves
 * furthest wins, unless another is binding (what the Cloud Foundry buildpack ships wins over
 * the newest Node.js release). Findings below `fixOn`, and groups not in `only` (ids), are left out.
 * Returns [{ id, check, title, signature, changes: [{ file, finding }] }].
 */
export function planFixes(findings, { fixOn = 'info', only = GROUPS.map((g) => g.id) } = {}) {
  const groups = [];
  for (const def of GROUPS.filter((g) => only.includes(g.id))) {
    const byPlace = new Map();
    for (const f of findings) {
      if (!f.fix || !f.file || !def.kinds.test(f.fix.kind) || !atLeast(f.severity, fixOn)) continue;
      const place = JSON.stringify([f.file, f.fix.kind, f.version ?? null, f.fix.path ?? null, f.fix.host ?? null]);
      const seen = byPlace.get(place);
      const wins = !seen || (Boolean(f.fix.binding) !== Boolean(seen.fix.binding) ? Boolean(f.fix.binding)
        : f.fix.to && seen.fix.to && newer(f.fix.to.replace(/^\D+/, ''), seen.fix.to.replace(/^\D+/, '')));
      if (wins) byPlace.set(place, f);
    }
    if (byPlace.size === 0) continue;
    const changes = [...byPlace.values()].map((finding) => ({ file: finding.file, finding }))
      .sort((a, b) => a.file.localeCompare(b.file));
    groups.push({ id: def.id, checks: def.checks, ...describe(def.id, changes), changes });
  }
  return groups;
}

/** Title, and a signature of what the group moves to: a closed pull request with the same signature was declined. */
function describe(id, changes) {
  if (id === 'ui5') {
    const targets = [...new Set(changes.map((c) => c.finding.fix.to))].sort();
    const lines = [...new Set(targets.map((t) => t.split('.').slice(0, 2).join('.')))];
    const exact = targets.filter((t) => !t.endsWith('.x'));
    const title = lines.length > 1 ? 'Update UI5 versions'
      : exact.length === 1 ? `Update UI5 to ${exact[0]}` : `Update UI5 to ${lines[0]}`;
    return { title, signature: `ui5 ${targets.join(' ')}` };
  }
  if (id === 'node') {
    const targets = [...new Set(changes.map((c) => c.finding.fix.to))].sort();
    const majors = [...new Set(targets.map((t) => /\d+/.exec(t)[0]))];
    return { title: majors.length === 1 ? `Move Node.js to ${majors[0]}` : 'Update Node.js versions', signature: `node ${targets.join(' ')}` };
  }
  const keys = changes.map((c) => `${c.file}:${c.finding.fix.path.join('>')}`).sort();
  const n = changes.length;
  return { title: `Remove ${n} unneeded npm override${n === 1 ? '' : 's'}`, signature: `npm-overrides ${keys.join(' ')}` };
}

/**
 * Applies a group's changes to the files as `read(file)` returns them (null for a missing
 * file). Returns { files: Map(file -> new text), applied: [change], skipped: [{ change, reason }] }.
 * Files that end up as they were are left out of `files`.
 */
export async function applyGroup(group, read) {
  const texts = new Map();
  const before = new Map();
  const applied = [];
  const skipped = [];
  for (const change of group.changes) {
    if (!texts.has(change.file)) {
      const text = await read(change.file);
      texts.set(change.file, text);
      before.set(change.file, text);
    }
    const text = texts.get(change.file);
    const result = text == null ? { skipped: 'file not found' } : applyFix(text, change.finding);
    if (result.skipped) {
      skipped.push({ change, reason: result.skipped });
      continue;
    }
    texts.set(change.file, result.text);
    applied.push(change);
  }
  const files = new Map([...texts].filter(([file, text]) => text != null && text !== before.get(file)));
  return { files, applied, skipped };
}

const MARKER = 'stack-sentinel-fix';

/** The hidden line in a pull request description that says what it moves to. */
export const marker = (group) => `<!-- ${MARKER}: ${group.signature} -->`;
export const readMarker = (body) => new RegExp(`<!-- ${MARKER}: (.*?) -->`).exec(body ?? '')?.[1] ?? null;

/** Pull request description: what changes where, and why. */
export function pullRequestBody(group, applied, report) {
  const rows = applied.map(({ file, finding }) => {
    const from = finding.version ? `\`${finding.version}\`` : 'not set';
    const what = finding.fix.to ? `${from} → \`${finding.fix.to}\`` : 'removed';
    return `| \`${file}\` | ${what} | ${finding.message.replace(/\|/g, '\\|')} |`;
  });
  const why = [...new Set(applied.map((c) => c.finding.recommendation).filter(Boolean))];
  const after = group.id === 'npm-overrides' ? ['', 'Run `npm install` afterwards to check that the lockfile still agrees.'] : [];
  return [
    `stack-sentinel found ${applied.length === 1 ? 'a version' : 'versions'} to change in ${report.project}.`,
    '',
    '| File | Change | Finding |',
    '| --- | --- | --- |',
    ...rows,
    ...(why.length ? ['', ...why.map((w) => `${w}.`)] : []),
    ...after,
    '',
    '---',
    `Opened by [stack-sentinel](https://github.com/cbs-consulting/stack-sentinel) ${report.toolVersion}${report.links?.run ? ` in [this run](${report.links.run})` : ''}. `
      + 'Each run updates this pull request while the findings remain, and closes it when they are gone. '
      + 'Close it without merging to skip these versions; a newer version opens a new one.',
    marker(group),
  ].join('\n');
}
