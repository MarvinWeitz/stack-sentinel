import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CHECK = 'license';

/**
 * The licenses of the packages a package-lock.json installs, as npm recorded them (lockfile
 * versions 2 and 3 carry a "license" per package; version 1 does not). Returns
 * [{ name, version, dev, license }], license being null when none is recorded.
 */
export function licensedPackages(lock) {
  const out = [];
  for (const [path, meta] of Object.entries(lock?.packages ?? {})) {
    if (!path || meta?.link || !meta?.version) continue;
    const name = meta.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!name || name === path) continue; // a workspace folder, not an installed package
    // old package.json files give { type } or a "licenses" list instead of an expression
    const raw = meta.license ?? meta.licenses;
    const license = typeof raw === 'string' ? raw
      : Array.isArray(raw) ? raw.map((l) => l?.type ?? l).filter((l) => typeof l === 'string').join(' OR ') || null
        : typeof raw?.type === 'string' ? raw.type : null;
    out.push({ name, version: meta.version, dev: meta.dev === true || meta.devOptional === true, license: license?.trim() || null });
  }
  return out;
}

/** "GPL-3.0-or-later" -> "gpl-3.0", "Apache-2.0" -> "apache-2.0": what lists are compared on. */
const base = (id) => id.toLowerCase().replace(/(-only|-or-later|\+)$/, '');

/**
 * Parses an SPDX license expression ("MIT", "(MIT OR Apache-2.0)", "GPL-2.0-only WITH
 * Classpath-exception-2.0", "MIT AND Zlib") into a tree: { id } | { op: 'and' | 'or', left, right }.
 * Null for anything that is not one: "SEE LICENSE IN LICENSE", "UNLICENSED", free text.
 */
export function parseExpression(text) {
  const tokens = String(text ?? '').match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const id = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;
  function primary() {
    const t = tokens[i++];
    if (t === '(') {
      const inner = or();
      if (tokens[i++] !== ')') throw new Error('unbalanced');
      return inner;
    }
    if (!t || !id.test(t) || /^(and|or|with)$/i.test(t) || /^(unlicensed|see)$/i.test(t)) throw new Error('not an id');
    const node = { id: t };
    if (/^with$/i.test(tokens[i] ?? '')) i += 2; // an exception widens what is allowed, never narrows it
    return node;
  }
  function and() {
    let left = primary();
    while (/^and$/i.test(tokens[i] ?? '')) {
      i++;
      left = { op: 'and', left, right: primary() };
    }
    return left;
  }
  function or() {
    let left = and();
    while (/^or$/i.test(tokens[i] ?? '')) {
      i++;
      left = { op: 'or', left, right: and() };
    }
    return left;
  }
  try {
    const tree = or();
    return i === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

/**
 * Judges a parsed expression against the policy: 'ok', 'not-allowed' (an allow list is set and
 * the license is not on it) or 'denied'. With OR the package may be used under the best of
 * the choices, with AND it must meet all of them. Returns { verdict, ids }: the ids that decide it.
 */
export function judge(tree, { allow, deny }) {
  const RANK = { ok: 0, 'not-allowed': 1, denied: 2 };
  const allowed = new Set(allow.map(base));
  const denied = new Set(deny.map(base));
  const walk = (node) => {
    if (node.id) {
      const verdict = denied.has(base(node.id)) ? 'denied' : allowed.size && !allowed.has(base(node.id)) ? 'not-allowed' : 'ok';
      return { verdict, ids: [node.id] };
    }
    const [a, b] = [walk(node.left), walk(node.right)];
    if (node.op === 'or') return RANK[a.verdict] <= RANK[b.verdict] ? a : b;
    if (a.verdict === b.verdict) return { verdict: a.verdict, ids: [...a.ids, ...b.ids] };
    return RANK[a.verdict] > RANK[b.verdict] ? a : b;
  };
  return walk(tree);
}

/** Findings for one lockfile's packages. cfg: { allow, deny, unknown }. */
export function evaluate(lockfile, packages, cfg) {
  const findings = [];
  // A package can be installed several times; it counts as development-only if every copy is.
  const unique = new Map();
  for (const p of packages) {
    const key = `${p.name}@${p.version}`;
    const known = unique.get(key);
    unique.set(key, { ...p, dev: known ? known.dev && p.dev : p.dev });
  }
  const checked = unique.size;
  for (const pkg of unique.values()) {
    // a package used only for development is not shipped with the app
    const cap = (severity) => (pkg.dev && severity !== 'ok' ? 'info' : severity);
    const label = `${pkg.name} ${pkg.version}${pkg.dev ? ' (development dependency)' : ''}`;
    const common = { check: CHECK, source: 'lockfile', file: lockfile, version: pkg.version, details: { package: pkg.name, license: pkg.license } };
    const tree = parseExpression(pkg.license);
    if (!tree) {
      if (cfg.unknown === 'ok') continue;
      const what = pkg.license ? `"${pkg.license}", which is not an SPDX license expression` : 'no license';
      findings.push({ ...common, severity: cap(cfg.unknown), message: `${label} declares ${what}.`,
        action: `Read the license of ${pkg.name} and allow or replace it` });
      continue;
    }
    const { verdict, ids } = judge(tree, cfg);
    if (verdict === 'ok') continue;
    const named = ids.join(' and ');
    findings.push(verdict === 'denied'
      ? { ...common, severity: cap('error'), message: `${label} is licensed under ${pkg.license}; ${named} is on the deny list (license.deny).`,
        action: `Replace ${pkg.name}, or get the license approved and ignore it` }
      : { ...common, severity: cap('warn'), message: `${label} is licensed under ${pkg.license}; ${named} is not on the allow list (license.allow).`,
        action: `Get ${named} approved and add it to license.allow, or replace ${pkg.name}` });
  }
  if (findings.length === 0 && checked > 0) {
    findings.push({ check: CHECK, severity: 'ok', source: 'lockfile', file: lockfile, message: `The licenses of all ${checked} installed packages meet the license policy.` });
  }
  return findings;
}

export const licenseCheck = {
  id: CHECK,
  description: 'Installed npm packages (from package-lock.json) have licenses the license policy allows',
  async run(ctx) {
    const cfg = ctx.config.license;
    const lockRe = new RegExp(cfg.lockfilePattern);
    const findings = [];
    for (const lockfile of ctx.files.filter((f) => lockRe.test(f))) {
      let lock;
      try {
        lock = JSON.parse(await readFile(join(ctx.root, lockfile), 'utf8'));
      } catch {
        findings.push({ check: CHECK, severity: 'warn', source: 'lockfile', file: lockfile, message: 'The lockfile could not be read as JSON.' });
        continue;
      }
      if (!lock.packages) {
        findings.push({ check: CHECK, severity: 'info', source: 'lockfile', file: lockfile,
          message: 'The lockfile does not record licenses (lockfile version 1).', action: 'Run "npm install" with npm 7 or later to write lockfile version 3' });
        continue;
      }
      findings.push(...evaluate(lockfile, licensedPackages(lock), cfg));
    }
    return findings;
  },
};
