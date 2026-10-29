import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { daysUntil, fmt, loadFeed } from '../feed.js';

const CHECK = 'node-version';

// ---------- schedule ----------

/**
 * Turns the Node.js release schedule ({ "v22": { start, lts, maintenance, end, codename } })
 * into a list of release lines, oldest first. Lines before 1.0 are ignored.
 */
export function indexSchedule(schedule) {
  const lines = [];
  for (const [key, v] of Object.entries(schedule ?? {})) {
    const m = /^v(\d+)$/.exec(key);
    if (!m || !v?.start || !v?.end) continue;
    const date = (text) => (text ? new Date(`${text}T23:59:59Z`) : null);
    lines.push({
      major: Number(m[1]),
      start: new Date(`${v.start}T00:00:00Z`),
      lts: v.lts ? new Date(`${v.lts}T00:00:00Z`) : null,
      maintenance: date(v.maintenance),
      end: date(v.end),
      codename: (v.codename || '').toLowerCase(),
    });
  }
  return lines.sort((a, b) => a.major - b.major);
}

/** The newest long-term support line that has already entered LTS and is not past end of life. */
export function recommendLine(lines, now) {
  const active = lines.filter((l) => l.lts && l.lts <= now && l.end > now);
  return active.length ? active[active.length - 1] : null;
}

// ---------- version ranges ----------

const INF = [Infinity, 0, 0];
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** "18", "18.1", "v18.1.2", "18.x" -> { parts: [18, 1, 2], given: how many were written } */
function parsePartial(text) {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+].*)?$/.exec(text);
  if (!m) return null;
  const nums = [];
  for (const part of m.slice(1, 4)) {
    if (part === undefined || /[xX*]/.test(part)) break;
    nums.push(Number(part));
  }
  return { parts: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], given: nums.length };
}

/** The version just above everything a partial version covers: 18 -> 19.0.0, 18.1 -> 18.2.0. */
function ceiling({ parts, given }) {
  if (given === 0) return INF;
  if (given === 1) return [parts[0] + 1, 0, 0];
  if (given === 2) return [parts[0], parts[1] + 1, 0];
  return [parts[0], parts[1], parts[2] + 1];
}

/** One comparator such as ">=18", "^20.1", "~18.2", "22.x" as a half-open interval [lo, hi). */
function comparatorInterval(token) {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  const p = m && parsePartial(m[2]);
  if (!p) return null;
  switch (m[1]) {
    case '>=': return [p.parts, INF];
    case '>': return [ceiling(p), INF];
    case '<': return [[0, 0, 0], p.parts];
    case '<=': return [[0, 0, 0], ceiling(p)];
    case '^':
      if (p.given === 0) return [[0, 0, 0], INF];
      return [p.parts, p.parts[0] > 0 ? [p.parts[0] + 1, 0, 0] : ceiling({ parts: p.parts, given: Math.min(p.given, 2) })];
    case '~': return [p.parts, ceiling({ parts: p.parts, given: Math.min(p.given, 2) })];
    default: return [p.parts, ceiling(p)];
  }
}

/**
 * Parses an npm-style version range into intervals (one per "||" alternative).
 * Returns null when any part cannot be understood.
 */
export function parseRange(range) {
  const out = [];
  for (const alternative of String(range).split('||')) {
    let lo = [0, 0, 0];
    let hi = INF;
    const text = alternative.trim().replace(/\s+-\s+/g, '\u0000').replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
    for (const token of text === '' ? ['*'] : text.split(/\s+/)) {
      let interval;
      if (token.includes('\u0000')) {
        const [from, to] = token.split('\u0000').map(parsePartial);
        interval = from && to ? [from.parts, ceiling(to)] : null;
      } else {
        interval = comparatorInterval(token);
      }
      if (!interval) return null;
      if (cmp(interval[0], lo) > 0) lo = interval[0];
      if (cmp(interval[1], hi) < 0) hi = interval[1];
    }
    if (cmp(lo, hi) < 0) out.push([lo, hi]);
  }
  return out;
}

/** Does the range allow this exact version, given as [major, minor, patch]? */
export const satisfies = (intervals, version) => intervals.some(([lo, hi]) => cmp(lo, version) <= 0 && cmp(version, hi) < 0);

/** Does the range allow any version of this major release line? */
const allowsMajor = (intervals, major) =>
  intervals.some(([lo, hi]) => cmp(lo, [major + 1, 0, 0]) < 0 && cmp(hi, [major, 0, 0]) > 0);

// ---------- evaluation ----------

/**
 * Judges one declared Node.js requirement.
 * spec: { kind: 'range', intervals } | { kind: 'codename', name } | { kind: 'latest' } | { kind: 'lts-latest' }
 */
export function evaluate(usage, lines, opts) {
  const findings = judge(usage, lines, opts);
  const rec = recommendLine(lines, opts.now);
  for (const f of findings) {
    if (!f.details?.recommended) continue;
    f.recommendation = `Node.js ${rec.major} is supported until ${fmt(rec.end)}`;
    if (f.action) continue;
    const versionFile = usage.source === 'version-file';
    f.action = versionFile ? `Change it to "${rec.major}"` : `Set "engines.node" to "^${rec.major}"`;
    f.fix = versionFile ? { kind: 'node-version-file', to: String(rec.major) } : { kind: 'node-engines', to: `^${rec.major}` };
  }
  return findings;
}

function judge(usage, lines, { now, requireLts, warnDays }) {
  const base = { check: CHECK, source: usage.source, file: usage.file, version: usage.text };
  const findings = [];
  const add = (severity, message, details) => findings.push({ ...base, severity, message, ...(details ? { details } : {}) });
  const rec = recommendLine(lines, now);
  const recDetails = (belowMajor) => (rec && rec.major > belowMajor ? { recommended: String(rec.major) } : undefined);
  const what = `"${usage.text}"`;

  if (usage.spec.kind === 'lts-latest') {
    add('ok', `${what} follows the latest Node.js long-term support release.`);
    return findings;
  }
  if (usage.spec.kind === 'latest') {
    add(requireLts ? 'warn' : 'info', `${what} follows the latest Node.js release, which is not always a long-term support release.`, recDetails(-1));
    return findings;
  }

  let intervals = usage.spec.intervals;
  if (usage.spec.kind === 'codename') {
    const line = lines.find((l) => l.codename === usage.spec.name);
    if (!line) {
      add('warn', `Could not understand the Node.js version ${what}.`);
      return findings;
    }
    intervals = [[[line.major, 0, 0], [line.major + 1, 0, 0]]];
  }
  const released = lines.filter((l) => l.start <= now);
  const allowed = released.filter((l) => allowsMajor(intervals, l.major));
  if (allowed.length === 0) {
    add('warn', `${what} matches no released Node.js version.`, recDetails(-1));
    return findings;
  }
  const supported = allowed.filter((l) => l.end > now);
  const lowest = allowed[0];
  const newest = allowed[allowed.length - 1];

  if (supported.length === 0) {
    add('error', `${what} only allows Node.js ${newest.major}, which reached end of life on ${fmt(newest.end)}.`, recDetails(newest.major));
    return findings;
  }

  // The best line the range allows decides how long the project is safe without a change.
  const best = supported.reduce((a, b) => (b.end > a.end ? b : a));
  const ltsAllowed = supported.filter((l) => l.lts);

  if (lowest.end <= now) {
    const first = supported[0];
    add('warn', `${what} still allows Node.js ${lowest.major}, which reached end of life on ${fmt(lowest.end)}.`);
    findings.at(-1).action = `Raise the lowest version "engines.node" allows to ${first.major}`;
    // only a plain lower bound can be raised without rewriting the range
    if (usage.source === 'engines' && /^>=\s*\d+(\.\d+){0,2}$/.test(usage.text)) findings.at(-1).fix = { kind: 'node-engines', to: `>=${first.major}` };
  }
  if (requireLts && ltsAllowed.length === 0) {
    add('warn', `${what} only allows Node.js ${best.major}, which is not a long-term support release.`, recDetails(best.major));
  }
  const days = daysUntil(best.end, now);
  if (days <= warnDays) {
    add('warn', `${what} only allows Node.js versions that reach end of life by ${fmt(best.end)} (${days} days).`, { daysLeft: days, ...recDetails(best.major) });
  } else if (best.maintenance && best.maintenance <= now && rec && rec.major > best.major) {
    add('info', `Node.js ${best.major} is in maintenance until ${fmt(best.end)}; Node.js ${rec.major} is the current long-term support release.`, { recommended: String(rec.major) });
  }

  if (findings.length === 0) add('ok', `${what} allows a supported Node.js version (${best.major}, until ${fmt(best.end)}).`);
  return findings;
}

// ---------- detection ----------

/** Reads a .nvmrc / .node-version file into a spec. Returns null for an empty file. */
export function parseVersionFile(text) {
  const value = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).find(Boolean);
  if (!value) return null;
  const lower = value.toLowerCase();
  if (['node', 'latest', 'current', 'stable'].includes(lower)) return { text: value, spec: { kind: 'latest' } };
  if (['lts/*', 'lts', '--lts'].includes(lower)) return { text: value, spec: { kind: 'lts-latest' } };
  const named = /^lts\/(.+)$/.exec(lower);
  if (named) return { text: value, spec: { kind: 'codename', name: named[1] } };
  const intervals = parseRange(value);
  return { text: value, spec: intervals ? { kind: 'range', intervals } : null };
}

export async function detect(root, files, cfg) {
  const usages = [];
  const notes = [];
  const packageRe = new RegExp(cfg.packagePattern);
  const versionFileRe = new RegExp(cfg.versionFilePattern);
  const unparsed = (source, file, text) => notes.push({
    check: CHECK, severity: 'warn', source, file, version: text,
    message: `Could not understand the Node.js version "${text}".`,
  });

  let rootPackage = null; // { declares: boolean }
  let rootVersionFile = false;
  for (const file of files) {
    const atRoot = !file.includes('/');
    if (versionFileRe.test(file)) {
      const parsed = parseVersionFile(await readFile(join(root, file), 'utf8'));
      if (!parsed) continue;
      if (atRoot) rootVersionFile = true;
      if (parsed.spec) usages.push({ source: 'version-file', file, ...parsed });
      else unparsed('version-file', file, parsed.text);
    } else if (packageRe.test(file)) {
      let json;
      try {
        json = JSON.parse(await readFile(join(root, file), 'utf8'));
      } catch {
        continue;
      }
      const range = json?.engines?.node;
      if (atRoot) rootPackage = { file, declares: typeof range === 'string' && range.trim() !== '' };
      if (typeof range !== 'string' || range.trim() === '') continue;
      const intervals = parseRange(range);
      if (intervals) usages.push({ source: 'engines', file, text: range.trim(), spec: { kind: 'range', intervals } });
      else unparsed('engines', file, range.trim());
    }
  }
  if (rootPackage && !rootPackage.declares && !rootVersionFile) {
    notes.push({
      check: CHECK, severity: 'info', source: 'project', file: rootPackage.file,
      message: 'No Node.js version is declared ("engines.node" in package.json), so the runtime is whatever the platform defaults to.',
      action: 'Add "engines": { "node": "..." } to package.json with the version the project is tested on',
    });
  }
  return { usages, notes };
}

// ---------- check entry point ----------

export const nodeCheck = {
  id: CHECK,
  description: 'The Node.js versions a project allows are supported',
  async run(ctx) {
    const cfg = ctx.config.node;
    const { usages, notes } = await detect(ctx.root, ctx.files, cfg);
    // The schedule is only needed when a version was declared.
    if (usages.length === 0) return notes;
    const lines = indexSchedule(await loadFeed(cfg.feed, ctx.fetchJson));
    if (lines.length === 0) throw new Error('the Node.js release schedule has no usable entries');
    const opts = { now: ctx.now, requireLts: cfg.requireLts, warnDays: cfg.warnDays };
    return [...notes, ...usages.flatMap((usage) => evaluate(usage, lines, opts))];
  },
};
