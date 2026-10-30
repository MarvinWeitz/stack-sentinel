import { access, readFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { daysUntil, fmt } from '../feed.js';
import { parseRange, satisfies } from './node.js';

const CHECK = 'cap-version';

// ---------- registry data ----------

const parts = (version) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; // pre-releases are ignored
};
const byVersion = (a, b) => a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2];

/**
 * Turns an npm registry document into what the check needs. SAP marks every CAP version
 * it no longer supports as deprecated on npm, so that flag is the support status.
 */
export function indexPackage(doc) {
  const versions = [];
  for (const [version, meta] of Object.entries(doc?.versions ?? {})) {
    const p = parts(version);
    if (!p) continue;
    versions.push({
      version, parts: p,
      unsupported: Boolean(meta?.deprecated),
      node: meta?.engines?.node ?? null,
      published: doc.time?.[version] ? new Date(doc.time[version]) : null,
    });
  }
  versions.sort(byVersion);
  const latest = versions.find((v) => v.version === doc?.['dist-tags']?.latest) ?? null;
  if (!latest) return null;
  const currentMajor = latest.parts[0];
  // The current major's first release starts the clock for the previous major.
  const firstOfCurrent = versions.filter((v) => v.parts[0] === currentMajor && v.published).sort((a, b) => a.published - b.published)[0];
  return { name: doc.name, versions, latest, currentMajor, currentSince: firstOfCurrent?.published ?? null };
}

/** Where a package's registry document lives: a registry URL, or a file in a local folder. */
export function registryLocation(registry, name) {
  if (/^https?:\/\//i.test(registry)) return { url: `${registry.replace(/\/+$/, '')}/${name.replace('/', '%2F')}` };
  return { file: resolve(registry, `${name.replace('/', '__')}.json`) };
}

// ---------- evaluation ----------

const addMonths = (date, months) => {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};

/**
 * Judges one use of a package.
 * usage: { name, file, range, installed } — `installed` is the exact version from a lockfile.
 */
export function evaluate(usage, pkg, { now, warnDays, maintenanceMonths }) {
  const base = { check: CHECK, source: usage.installed ? 'lockfile' : 'range', file: usage.file, details: { package: pkg.name } };
  const findings = [];
  const recommendation = `${pkg.name} ${pkg.currentMajor} is the current major version${pkg.latest.node ? `; it needs Node.js ${pkg.latest.node}` : ''}`;
  const add = (severity, message, extra = {}) => findings.push({ ...base, severity, message, ...extra, details: { ...base.details, ...extra.details } });
  const move = { recommendation, action: `Upgrade ${pkg.name} to "^${pkg.currentMajor}" in package.json`, details: { recommended: String(pkg.currentMajor) },
    fix: { kind: 'cap-upgrade', name: pkg.name, from: usage.range, to: `^${pkg.currentMajor}` } };

  // The lockfile says what is installed; without one, npm would pick the newest match of the range.
  let used;
  let label;
  if (usage.installed) {
    used = pkg.versions.find((v) => v.version === usage.installed);
    label = `${pkg.name} ${usage.installed}`;
    if (!used) {
      add('warn', `${label} is installed, but the registry does not list that version.`);
      return findings;
    }
  } else {
    if (['latest', '*', 'x', ''].includes(usage.range)) used = pkg.latest;
    else {
      const intervals = parseRange(usage.range);
      if (!intervals) return findings;
      used = pkg.versions.filter((v) => satisfies(intervals, v.parts)).at(-1);
    }
    if (!used) {
      add('warn', `"${usage.range}" matches no published version of ${pkg.name}.`, move);
      return findings;
    }
    label = `${pkg.name} "${usage.range}" (resolves to ${used.version})`;
  }
  base.version = used.version;

  const major = used.parts[0];
  const behind = pkg.currentMajor - major;
  if (used.unsupported) {
    add('error', `${label} is no longer supported: SAP has marked it as unsupported on npm.`, behind > 0 ? move : {});
  } else if (behind >= 2) {
    add('error', `${label} is ${behind} major versions behind. Only the current major (${pkg.currentMajor}) and the one before it are supported.`, move);
  } else if (behind === 1) {
    const what = `${label} is on the previous major version, which gets critical fixes only`;
    if (!pkg.currentSince) {
      add('info', `${what}.`, move);
    } else {
      // CAP's policy: the previous major is maintained for at most twelve months after a new one.
      const end = addMonths(pkg.currentSince, maintenanceMonths);
      const days = daysUntil(end, now);
      const basis = `${maintenanceMonths} months after version ${pkg.currentMajor} was released`;
      if (days < 0) add('warn', `${what}. Its estimated end of life (${fmt(end)}, ${basis}) has passed.`, move);
      else if (days <= warnDays) add('warn', `${what}. Estimated end of life: ${fmt(end)} (${days} days), ${basis}.`, { ...move, details: { ...move.details, daysLeft: days } });
      else add('info', `${what} until about ${fmt(end)}, ${basis}.`, move);
    }
  } else {
    add('ok', `${label} is on the current major version.`);
  }
  return findings;
}

// ---------- detection ----------

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The exact installed version from the closest package-lock.json at or above `dir`. */
async function installedVersion(root, dir, name) {
  for (let lockDir = dir; ; lockDir = posix.dirname(lockDir)) {
    const lockPath = join(root, lockDir, 'package-lock.json');
    if (await exists(lockPath)) {
      const lock = await readJson(lockPath);
      const below = lockDir === '.' ? dir : posix.relative(lockDir, dir);
      const nested = below && below !== '.' ? `${below}/node_modules/${name}` : null;
      return lock?.packages?.[nested]?.version          // installed inside a workspace folder
        ?? lock?.packages?.[`node_modules/${name}`]?.version // hoisted, or a single-package lockfile
        ?? lock?.dependencies?.[name]?.version             // lockfile version 1
        ?? null;
    }
    if (lockDir === '.') return null;
  }
}

export async function detect(root, files, cfg) {
  const packageRe = new RegExp(cfg.packagePattern);
  const usages = [];
  for (const file of files.filter((f) => packageRe.test(f))) {
    const json = await readJson(join(root, file));
    if (!json) continue;
    for (const name of cfg.packages) {
      const range = json.dependencies?.[name] ?? json.devDependencies?.[name];
      if (typeof range !== 'string') continue;
      const open = ['latest', '*', 'x', ''].includes(range.trim());
      const intervals = open ? null : parseRange(range.trim());
      if (!open && !intervals) continue; // not from the registry: a git URL, file: or workspace: reference
      let installed = await installedVersion(root, posix.dirname(file), name);
      // A lockfile further up may describe a different package; trust it only if it fits the range.
      if (installed && intervals && parts(installed) && !satisfies(intervals, parts(installed))) installed = null;
      usages.push({ name, file, range: range.trim(), installed });
    }
  }
  return usages;
}

// ---------- check entry point ----------

export const capCheck = {
  id: CHECK,
  description: 'CAP (Node.js) packages are on a major version SAP still supports',
  async run(ctx) {
    const cfg = ctx.config.cap;
    const usages = await detect(ctx.root, ctx.files, cfg);
    const opts = { now: ctx.now, warnDays: cfg.warnDays, maintenanceMonths: cfg.maintenanceMonths };
    const findings = [];
    const cache = new Map();
    for (const usage of usages) {
      if (!cache.has(usage.name)) {
        const where = registryLocation(cfg.registry, usage.name);
        const doc = where.url ? await ctx.fetchJson(where.url) : JSON.parse(await readFile(where.file, 'utf8'));
        const pkg = indexPackage(doc);
        if (!pkg) throw new Error(`the registry data for ${usage.name} has no usable "latest" version`);
        cache.set(usage.name, pkg);
      }
      findings.push(...evaluate(usage, cache.get(usage.name), opts));
    }
    return findings;
  },
};
