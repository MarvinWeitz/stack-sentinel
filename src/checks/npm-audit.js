import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parseRange, satisfies } from './node.js';

const CHECK = 'npm-audit';
const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
const level = (severity) => Math.max(0, LEVELS.indexOf(severity));

const parts = (version) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/**
 * The installed packages a package-lock.json describes (lockfile versions 1 to 3).
 * Returns [{ name, version, dev }]; linked workspace folders and the project itself are skipped.
 */
export function installedPackages(lock) {
  const out = [];
  if (lock?.packages) {
    for (const [path, meta] of Object.entries(lock.packages)) {
      if (!path || meta?.link || !meta?.version) continue;
      const name = meta.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (!name || name === path) continue; // a workspace folder, not an installed package
      out.push({ name, version: meta.version, dev: meta.dev === true || meta.devOptional === true });
    }
    return out;
  }
  // lockfile version 1: nested "dependencies"
  const walk = (deps) => {
    for (const [name, meta] of Object.entries(deps ?? {})) {
      if (meta?.version && parts(meta.version)) out.push({ name, version: meta.version, dev: meta.dev === true });
      walk(meta?.dependencies);
    }
  };
  walk(lock?.dependencies);
  return out;
}

/** Asks the registry which of the given versions have known vulnerabilities. */
export function bulkRequest(packages) {
  const body = {};
  for (const { name, version } of packages) {
    body[name] ??= [];
    if (!body[name].includes(version)) body[name].push(version);
  }
  return body;
}

/**
 * Turns the registry's answer into one finding per vulnerable installed package.
 * cfg: { reportFrom, warnAt, errorAt } as advisory severities.
 */
export function evaluate(lockfile, packages, advisories, cfg) {
  const findings = [];
  // A package can be installed several times; it counts as development-only if every copy is.
  const unique = new Map();
  for (const p of packages) {
    const key = `${p.name}@${p.version}`;
    const known = unique.get(key);
    unique.set(key, { name: p.name, version: p.version, dev: known ? known.dev && p.dev : p.dev });
  }
  for (const pkg of unique.values()) {
    const version = parts(pkg.version);
    if (!version) continue;
    const hits = (advisories[pkg.name] ?? []).filter((a) => {
      const range = parseRange(a.vulnerable_versions ?? '');
      return range ? satisfies(range, version) : false;
    });
    if (hits.length === 0) continue;
    const worst = hits.reduce((a, b) => (level(b.severity) > level(a.severity) ? b : a));
    if (level(worst.severity) < level(cfg.reportFrom)) continue;

    let severity = level(worst.severity) >= level(cfg.errorAt) ? 'error'
      : level(worst.severity) >= level(cfg.warnAt) ? 'warn' : 'info';
    // development-only packages are not part of the deployed app
    if (pkg.dev && severity !== 'info') severity = 'info';

    const titles = [...new Set(hits.map((a) => a.title))];
    const count = hits.length === 1 ? 'a known vulnerability' : `${hits.length} known vulnerabilities`;
    const devNote = pkg.dev ? ' (development dependency)' : '';
    findings.push({
      check: CHECK,
      severity,
      source: 'lockfile',
      file: lockfile,
      version: pkg.version,
      message: `${pkg.name} ${pkg.version}${devNote} has ${count}, the worst ${worst.severity}: ${titles.slice(0, 2).join('; ')}${titles.length > 2 ? `; and ${titles.length - 2} more` : ''}.`,
      action: fixAction(pkg, version, hits, lockfile),
      details: {
        package: pkg.name,
        severity: worst.severity,
        advisories: hits.map((a) => ({ id: a.id, title: a.title, severity: a.severity, url: a.url, vulnerableVersions: a.vulnerable_versions })),
      },
    });
  }
  return findings;
}

/**
 * The lowest version that leaves every matching advisory behind, from the advisories' own
 * ranges: the upper end of the range the installed version falls in. Null when an
 * advisory has no upper end, meaning no fixed version is known.
 */
export function firstFixedVersion(version, hits) {
  let fixed = [0, 0, 0];
  for (const advisory of hits) {
    const intervals = parseRange(advisory.vulnerable_versions ?? '') ?? [];
    const containing = intervals.find((interval) => satisfies([interval], version));
    if (!containing) continue;
    const hi = containing[1];
    if (hi[0] === Infinity) return null;
    if (hi[0] > fixed[0] || (hi[0] === fixed[0] && (hi[1] > fixed[1] || (hi[1] === fixed[1] && hi[2] > fixed[2])))) fixed = hi;
  }
  return fixed.join('.');
}

function fixAction(pkg, version, hits, lockfile) {
  const where = posix.dirname(lockfile) === '.' ? 'the project folder' : posix.dirname(lockfile);
  const fixed = firstFixedVersion(version, hits);
  if (!fixed) return `No fixed version of ${pkg.name} is known yet; check the advisories, and consider replacing it`;
  return `Update ${pkg.name} to ${fixed} or later (run "npm audit fix" in ${where})`;
}

// ---------- check entry point ----------

export const npmAuditCheck = {
  id: CHECK,
  description: 'Installed npm packages (from package-lock.json) have no known vulnerabilities',
  async run(ctx) {
    const cfg = ctx.config.audit;
    const lockRe = new RegExp(cfg.lockfilePattern);
    const lockfiles = ctx.files.filter((f) => lockRe.test(f));
    if (lockfiles.length === 0) return [];
    const url = `${cfg.registry.replace(/\/+$/, '')}/-/npm/v1/security/advisories/bulk`;
    const findings = [];
    for (const lockfile of lockfiles) {
      let lock;
      try {
        lock = JSON.parse(await readFile(join(ctx.root, lockfile), 'utf8'));
      } catch {
        findings.push({ check: CHECK, severity: 'warn', source: 'lockfile', file: lockfile, message: 'The lockfile could not be read as JSON.' });
        continue;
      }
      const packages = installedPackages(lock);
      if (packages.length === 0) continue;
      const advisories = await ctx.postJson(url, bulkRequest(packages));
      if (!advisories || typeof advisories !== 'object' || Array.isArray(advisories)) {
        throw new Error('the registry gave an unexpected answer about vulnerabilities');
      }
      const found = evaluate(lockfile, packages, advisories, cfg);
      if (found.length === 0) {
        const unique = new Set(packages.map((p) => `${p.name}@${p.version}`)).size;
        const scope = cfg.reportFrom === 'info' ? 'No known vulnerabilities' : `No known vulnerabilities of ${cfg.reportFrom} severity or above`;
        findings.push({ check: CHECK, severity: 'ok', source: 'lockfile', file: lockfile, message: `${scope} in ${unique} installed packages.` });
      }
      findings.push(...found);
    }
    return findings;
  },
};
