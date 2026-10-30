import { DAY } from './feed.js';

/**
 * Ignore rules: findings a team has looked at and decided to live with, for now. They live
 * in the config file's "ignore" list, so the decision is reviewed like any other change.
 * A rule names what it matches by one or more of these fields; all that are given must match:
 *   check     a check id
 *   file      regex on the finding's file
 *   package   an npm package name
 *   version   the version the finding is about, exactly
 *   advisory  a GitHub advisory id (GHSA-...) or the npm advisory number
 *   message   regex on the finding's message
 * and can carry `until` (YYYY-MM-DD, the last day it applies) and a `reason`.
 */
const MATCHERS = ['file', 'package', 'version', 'advisory', 'message'];
const FIELDS = ['check', ...MATCHERS, 'until', 'reason'];

/** What a rule matches, for messages: "GHSA-xxxx in lodash", "ui5-version in ^legacy/". */
export function describeRule(rule) {
  const parts = [rule.advisory, rule.package && `${rule.package}${rule.version ? ` ${rule.version}` : ''}`,
    !rule.package && rule.version && `version ${rule.version}`, rule.file && `files matching ${rule.file}`,
    rule.message && `messages matching ${rule.message}`].filter(Boolean);
  return `${rule.check ? `${rule.check}: ` : ''}${parts.join(', ')}`;
}

/**
 * Checks the "ignore" list and splits it into the rules that apply on `now` and the ones whose
 * `until` has passed. A rule that cannot be read stops the run, like any other invalid setting.
 */
export function parseIgnoreRules(raw, now) {
  if (raw === undefined || raw === null) return { active: [], expired: [] };
  if (!Array.isArray(raw)) throw new Error('Invalid value for "ignore" in the config file: expected a list of rules');
  const active = [];
  const expired = [];
  raw.forEach((rule, i) => {
    const fail = (why) => {
      throw new Error(`Invalid ignore rule ${i + 1} in the config file: ${why}`);
    };
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('expected an object');
    const unknown = Object.keys(rule).filter((k) => !FIELDS.includes(k));
    if (unknown.length) fail(`unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} (use ${FIELDS.join(', ')})`);
    for (const k of FIELDS) if (rule[k] !== undefined && (typeof rule[k] !== 'string' || !rule[k].trim())) fail(`"${k}" must be text`);
    // a rule for a whole check is what skipChecks is for, and would hide new findings unseen
    if (!MATCHERS.some((k) => rule[k])) fail(`name what it ignores with at least one of ${MATCHERS.join(', ')}`);
    if (rule.advisory && rule.message) fail('"advisory" and "message" cannot be combined');
    for (const k of ['file', 'message']) {
      try {
        if (rule[k]) new RegExp(rule[k]);
      } catch {
        fail(`"${k}" is not a valid regular expression`);
      }
    }
    let end = null;
    if (rule.until) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rule.until);
      const day = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      if (!day || day.toISOString().slice(0, 10) !== rule.until) fail('"until" must be a date as YYYY-MM-DD');
      end = new Date(day.getTime() + DAY);
    }
    const parsed = { ...rule, index: i };
    (end && end <= now ? expired : active).push(parsed);
  });
  return { active, expired };
}

/** The npm package a finding is about, if any. */
const packageOf = (f) => f.details?.package ?? f.fix?.name ?? null;

/** Does an advisory rule name this advisory? npm gives a number and a GitHub advisory link. */
export const namesAdvisory = (rule, advisory) => {
  const want = rule.advisory.trim().toLowerCase();
  return String(advisory.id) === want || String(advisory.url ?? '').toLowerCase().endsWith(`/${want}`);
};

function matches(rule, f) {
  if (rule.check && rule.check !== f.check) return false;
  if (rule.file && !(f.file && new RegExp(rule.file).test(f.file))) return false;
  if (rule.package && rule.package !== packageOf(f)) return false;
  if (rule.version && rule.version !== f.version) return false;
  if (rule.message && !new RegExp(rule.message).test(f.message)) return false;
  // advisories are matched by the npm-audit check itself, one at a time (see advisoryFilter)
  return !rule.advisory;
}

/**
 * For the npm-audit check, which leaves out ignored advisories one at a time, so that a
 * package is judged by the advisories that remain: the rule that ignores an advisory against
 * package `name` in lockfile `file`, if any. Only advisory rules whose other fields fit count.
 */
export function advisoryFilter(rules) {
  const byAdvisory = rules.filter((r) => r.advisory && (!r.check || r.check === 'npm-audit'));
  if (byAdvisory.length === 0) return undefined;
  return ({ name, version }, advisory, file) => byAdvisory.find((r) => namesAdvisory(r, advisory)
    && (!r.package || r.package === name) && (!r.version || r.version === version) && (!r.file || new RegExp(r.file).test(file)));
}

/**
 * Takes the ignored findings out of `findings`. Returns { findings, ignored, notes }: ignored
 * findings carry `ignoredBy` ({ reason, until }); notes are info findings about rules that
 * expired, or that match nothing although every check they could match ran cleanly.
 */
export function applyIgnores(findings, { active, expired }, { ran, failed }) {
  const used = new Set();
  const kept = [];
  const ignored = [];
  for (const f of findings) {
    // advisories the npm-audit check left out count as uses of their rules; a finding whose
    // advisories it left out entirely comes marked with those rules
    for (const a of f.details?.ignoredAdvisories ?? []) used.add(a.rule);
    const { ignoredByRules, ...finding } = f;
    const marked = (ignoredByRules ?? []).map((i) => active.find((r) => r.index === i)).filter(Boolean);
    for (const r of marked) used.add(r.index);
    const rule = marked[0] ?? (f.source === 'check' ? null : active.find((r) => matches(r, f)));
    if (!rule) {
      kept.push(finding);
      continue;
    }
    used.add(rule.index);
    ignored.push({ ...finding, ignoredBy: { ...(rule.reason ? { reason: rule.reason } : {}), ...(rule.until ? { until: rule.until } : {}) } });
  }
  const note = (rule, message) => ({ check: 'ignore', severity: 'info', source: 'config', message, action: `Remove the rule from "ignore" in the config file${rule.until ? ', or move its date' : ''}` });
  const notes = [
    ...expired.map((r) => note(r, `The ignore rule for ${describeRule(r)} ended on ${r.until}${r.reason ? ` (${r.reason})` : ''}, so what it matches is reported again.`)),
    ...active.filter((r) => !used.has(r.index) && (r.check ? ran.includes(r.check) && !failed.has(r.check) : failed.size === 0))
      .map((r) => note(r, `The ignore rule for ${describeRule(r)} matches no finding.`)),
  ];
  return { findings: kept, ignored, notes };
}
