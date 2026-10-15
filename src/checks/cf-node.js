import { access, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { daysUntil, fmt, loadFeed } from '../feed.js';
import { parseRange, satisfies } from './node.js';

const CHECK = 'cf-node-version';

// ---------- small YAML readers ----------
// The files read here have a regular shape, so a full YAML parser is not needed.

const indentOf = (line) => line.length - line.trimStart().length;
const scalar = (text) => text.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
const isNoise = (line) => line.trim() === '' || line.trim().startsWith('#') || line.trim() === '---';

/**
 * Reads the list of maps under a top-level key:
 *   key:
 *     - name: a        ->  [{ indent, fields: { name: 'a', type: 'x' }, text: '<all lines of the item>' }]
 *       type: x
 * Only the item's own scalar keys go into `fields`; nested content stays available in `text`.
 */
export function readList(yaml, key) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*(#.*)?$`).test(l));
  if (start === -1) return [];
  const items = [];
  let listIndent = null;
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isNoise(line)) continue;
    const indent = indentOf(line);
    const dash = /^(\s*)-\s+(.*)$/.exec(line);
    if (listIndent === null) {
      if (!dash) break; // not a list
      listIndent = indent;
    }
    if (indent < listIndent || (indent === listIndent && !dash)) break; // next top-level key
    if (dash && indent === listIndent) {
      current = { fields: {}, text: '', keyIndent: indent + 2 };
      items.push(current);
      const first = /^([\w.-]+):\s*(.*)$/.exec(dash[2]);
      if (first && scalar(first[2]) !== '') current.fields[first[1]] = scalar(first[2]);
    } else if (current) {
      const pair = /^\s*([\w.-]+):\s*(.*)$/.exec(line);
      if (pair && indent === current.keyIndent && scalar(pair[2]) !== '') current.fields[pair[1]] = scalar(pair[2]);
    }
    if (current) current.text += `${line}\n`;
  }
  return items;
}

/** The parts of the buildpack manifest this check uses. */
export function parseBuildpackManifest(yaml) {
  const version = (text) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text ?? '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const shipped = new Map();
  for (const item of readList(yaml, 'dependencies')) {
    if (item.fields.name === 'node' && version(item.fields.version)) shipped.set(item.fields.version, version(item.fields.version));
  }
  const removal = new Map(); // major -> Date the line leaves the buildpack
  for (const item of readList(yaml, 'dependency_deprecation_dates')) {
    const major = /^(\d+)\./.exec(item.fields.version_line ?? '');
    if (item.fields.name === 'node' && major && /^\d{4}-\d{2}-\d{2}$/.test(item.fields.date ?? '')) {
      removal.set(Number(major[1]), new Date(`${item.fields.date}T23:59:59Z`));
    }
  }
  const def = readList(yaml, 'default_versions').find((i) => i.fields.name === 'node');
  const versions = [...shipped.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return { versions, removal, defaultRange: def?.fields.version ?? null };
}

// ---------- which package.json files are deployed as Node.js apps ----------

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The package.json a module is built from. A module path often points at build output that
 * is not in the repository (CAP's gen/srv), so fall back to the closest package.json above it.
 */
async function packageFor(root, descriptorDir, modulePath, exact = false) {
  let dir = posix.normalize(posix.join(descriptorDir, modulePath || '.')).replace(/\/+$/, '') || '.';
  if (dir.startsWith('..')) return null; // outside the scanned project
  for (;;) {
    const candidate = dir === '.' ? 'package.json' : `${dir}/package.json`;
    if (await exists(join(root, candidate))) return candidate;
    if (dir === '.' || exact) return null;
    dir = posix.dirname(dir);
  }
}

/** Node.js modules of an mta.yaml / applications of a Cloud Foundry manifest.yml. */
export function nodeModules(yaml, nodeTypes) {
  const usesNodeBuildpack = (item) => /buildpacks?:\s*(?:\n\s*-\s*)?\S*nodejs/.test(item.text);
  const mta = readList(yaml, 'modules')
    .filter((m) => m.fields.path && (nodeTypes.includes(m.fields.type) || usesNodeBuildpack(m)))
    .map((m) => ({ name: m.fields.name, path: m.fields.path, source: 'mta' }));
  const apps = readList(yaml, 'applications')
    // without an explicit buildpack Cloud Foundry detects it; a package.json decides that later
    .filter((a) => usesNodeBuildpack(a) || !/buildpacks?:/.test(a.text))
    .map((a) => ({ name: a.fields.name, path: a.fields.path ?? '.', source: 'cf-manifest', exact: !usesNodeBuildpack(a) }));
  return [...mta, ...apps];
}

export async function detect(root, files, cfg) {
  const descriptorRe = new RegExp(cfg.descriptorPattern);
  const targets = new Map(); // package.json path -> { source, modules: [names] }
  let descriptors = 0;
  for (const file of files.filter((f) => descriptorRe.test(f))) {
    const modules = nodeModules(await readFile(join(root, file), 'utf8'), cfg.nodeModuleTypes);
    if (modules.length) descriptors++;
    for (const mod of modules) {
      const pkg = await packageFor(root, posix.dirname(file), mod.path, mod.exact);
      if (!pkg) continue;
      if (!targets.has(pkg)) targets.set(pkg, { source: mod.source, modules: [] });
      if (mod.name && !targets.get(pkg).modules.includes(mod.name)) targets.get(pkg).modules.push(mod.name);
    }
  }
  const usages = [];
  for (const [file, target] of targets) {
    let json;
    try {
      json = JSON.parse(await readFile(join(root, file), 'utf8'));
    } catch {
      continue;
    }
    const range = typeof json?.engines?.node === 'string' ? json.engines.node.trim() : '';
    usages.push({ file, source: target.source, modules: target.modules, range: range || null });
  }
  return { usages, descriptors };
}

// ---------- evaluation ----------

const show = (v) => v.join('.');
const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

export function evaluate(usage, buildpack, { now, warnDays }) {
  const base = { check: CHECK, source: usage.source, file: usage.file, ...(usage.range ? { version: usage.range } : {}) };
  const findings = [];
  const add = (severity, message, details) => findings.push({ ...base, severity, message, ...(details ? { details } : {}) });
  const ships = `The current Cloud Foundry Node.js buildpack ships ${list(buildpack.versions.map(show))}.`;
  // The line to move to: the shipped one that stays in the buildpack longest.
  const majors = [...new Set(buildpack.versions.map((v) => v[0]))];
  const target = majors.sort((a, b) => (buildpack.removal.get(b) ?? 0) - (buildpack.removal.get(a) ?? 0) || b - a)[0];

  let range = usage.range;
  if (!range) {
    if (!buildpack.defaultRange) return findings;
    add('info', `No Node.js version is declared ("engines.node"), so Cloud Foundry uses the buildpack default, ${buildpack.defaultRange}.`);
    findings.at(-1).action = `Declare the version in package.json, e.g. "engines": { "node": "^${target}" }`;
    range = buildpack.defaultRange;
  }
  const what = usage.range ? `"${usage.range}"` : `The buildpack default ${range}`;
  const intervals = parseRange(range);
  if (!intervals) {
    add('warn', `Could not understand the Node.js version "${range}".`);
    return findings;
  }

  const matching = buildpack.versions.filter((v) => satisfies(intervals, v));
  if (matching.length === 0) {
    // An exact version is the usual cause: the buildpack keeps only the newest patch of each line.
    const exact = /^v?=?\s*(\d+)\.\d+\.\d+$/.exec(range);
    const sameLine = exact && buildpack.versions.some((v) => v[0] === Number(exact[1]));
    add('error', `${what} matches no Node.js version in the Cloud Foundry buildpack, so staging fails. ${ships}`,
      { shipped: buildpack.versions.map(show) });
    findings.at(-1).action = sameLine
      ? `Use a range such as "${exact[1]}.x" instead of an exact version`
      : `Set "engines.node" to "^${target}"`;
    return findings;
  }

  // Cloud Foundry picks the newest matching version; the line that stays longest decides the deadline.
  const picked = matching.at(-1);
  const ends = [...new Set(matching.map((v) => v[0]))].map((major) => buildpack.removal.get(major)).filter(Boolean);
  const lastEnd = ends.length ? new Date(Math.max(...ends)) : null;
  if (lastEnd) {
    const days = daysUntil(lastEnd, now);
    if (days < 0) {
      add('warn', `${what} resolves to Node.js ${show(picked)}, which was due to leave the Cloud Foundry buildpack on ${fmt(lastEnd)}.`);
      if (target > picked[0]) findings.at(-1).action = `Set "engines.node" to "^${target}"`;
    } else if (days <= warnDays) {
      add('warn', `${what} resolves to Node.js ${show(picked)}, which leaves the Cloud Foundry buildpack on ${fmt(lastEnd)} (${days} days). After that, staging fails.`, { daysLeft: days });
      if (target > picked[0]) findings.at(-1).action = `Set "engines.node" to "^${target}"`;
    }
  }
  if (!findings.some((f) => f.severity !== 'info') && usage.range) {
    add('ok', `${what} resolves to Node.js ${show(picked)} in the Cloud Foundry buildpack.`, { resolved: show(picked) });
  }
  return findings;
}

// ---------- check entry point ----------

export const cfNodeCheck = {
  id: CHECK,
  description: 'Node.js apps deployed to Cloud Foundry ask for a version the buildpack ships',
  async run(ctx) {
    const cfg = ctx.config.cf;
    const { usages } = await detect(ctx.root, ctx.files, cfg);
    // Nothing is deployed to Cloud Foundry as a Node.js app: the check does not apply.
    if (usages.length === 0) return [];
    const buildpack = await loadFeed(cfg.feed, async (url) => parseBuildpackManifest(await ctx.fetchText(url)), parseBuildpackManifest);
    if (buildpack.versions.length === 0) throw new Error('the buildpack manifest lists no Node.js versions');
    const opts = { now: ctx.now, warnDays: cfg.warnDays };
    return usages.flatMap((usage) => evaluate(usage, buildpack, opts));
  },
};
