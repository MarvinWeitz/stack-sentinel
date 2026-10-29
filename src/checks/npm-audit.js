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

/**
 * The dependency graph a package-lock.json describes: which installed copy every declared
 * dependency resolves to, found the way Node.js finds it (the nearest node_modules folder
 * upwards). manifest is the project's package.json, needed only for lockfile version 1,
 * which does not record the project's own dependencies.
 * Returns { nodes, roots, parents }: nodes by lockfile path as { path, name, version, bundled },
 * roots the paths of the project and its workspace folders, and parents by the path of the
 * installed copy as [{ from, range, dev }], dev when declared under devDependencies.
 */
export function dependencyGraph(lock, manifest) {
  const nodes = new Map();
  const roots = new Set();
  const links = new Set();
  const declared = (meta, withDev) => [
    ...Object.entries({ ...meta?.peerDependencies, ...meta?.optionalDependencies, ...meta?.dependencies })
      .map(([name, range]) => ({ name, range, dev: false })),
    ...Object.entries(withDev ? meta?.devDependencies ?? {} : {}).map(([name, range]) => ({ name, range, dev: true })),
  ];
  if (lock?.packages) {
    for (const [path, meta] of Object.entries(lock.packages)) {
      if (meta?.link) { links.add(path); continue; }
      const installed = path.includes('node_modules/');
      if (!installed) roots.add(path);
      const name = installed ? meta?.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length) : meta?.name;
      nodes.set(path, { path, name, version: meta?.version, bundled: meta?.inBundle === true, requires: declared(meta, !installed) });
    }
  } else {
    // lockfile version 1: the nesting of "dependencies" is the folder layout
    roots.add('');
    nodes.set('', { path: '', name: manifest?.name, version: manifest?.version, bundled: false, requires: declared(manifest, true) });
    const walk = (deps, prefix) => {
      for (const [name, meta] of Object.entries(deps ?? {})) {
        const path = `${prefix}node_modules/${name}`;
        const requires = Object.entries(meta?.requires ?? {}).map(([dep, range]) => ({ name: dep, range, dev: false }));
        nodes.set(path, { path, name, version: meta?.version, bundled: meta?.bundled === true, requires });
        walk(meta?.dependencies, `${path}/`);
      }
    };
    walk(lock?.dependencies, '');
  }
  const resolve = (from, name) => {
    for (let dir = from; ; dir = posix.dirname(dir) === '.' ? '' : posix.dirname(dir)) {
      const path = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
      if (links.has(path)) return null; // a workspace folder, which is a root of its own
      if (nodes.has(path) && !roots.has(path)) return path;
      if (!dir) return null;
    }
  };
  const parents = new Map();
  for (const node of nodes.values()) {
    for (const dep of node.requires) {
      const to = resolve(node.path, dep.name);
      if (!to) continue; // not installed: optional, a peer nobody provides, or trimmed away
      if (!parents.has(to)) parents.set(to, []);
      parents.get(to).push({ from: node.path, range: dep.range, dev: dep.dev });
    }
  }
  return { nodes, roots, parents };
}

/**
 * How the given installed copies (lockfile paths) are reached from the project: for every
 * direct dependency they come in through, the shortest chain of paths from it down to one
 * of them, nearest first. Returns [{ root, dev, chain }]; a chain of one means the copy is
 * itself a direct dependency.
 */
export function trace(graph, targets) {
  const next = new Map(targets.map((t) => [t, null]));
  const queue = [...targets];
  const seen = new Set();
  const found = [];
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    for (const { from, dev } of graph.parents.get(path) ?? []) {
      if (graph.roots.has(from)) {
        const key = `${from}\u0000${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const chain = [path];
        while (next.get(chain.at(-1))) chain.push(next.get(chain.at(-1)));
        found.push({ root: from, dev, chain });
      } else if (!next.has(from)) {
        next.set(from, path);
        queue.push(from);
      }
    }
  }
  return found;
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
 * cfg: { reportFrom, warnAt, errorAt } as advisory severities. graph (from dependencyGraph)
 * is optional; with it, findings say which direct dependencies bring a package in, and the
 * action takes the version ranges along the way into account.
 */
export function evaluate(lockfile, packages, advisories, cfg, graph) {
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
    const origin = graph ? explain(graph, lockfile, pkg) : null;
    const fixed = firstFixedVersion(version, hits);
    findings.push({
      check: CHECK,
      severity,
      source: 'lockfile',
      file: lockfile,
      version: pkg.version,
      message: `${pkg.name} ${pkg.version}${devNote} has ${count}, the worst ${worst.severity}: ${titles.slice(0, 2).join('; ')}${titles.length > 2 ? `; and ${titles.length - 2} more` : ''}.${origin?.message ?? ''}`,
      action: origin ? graphFixAction(origin, pkg, fixed, lockfile) : fixAction(pkg, version, hits, lockfile),
      ...(origin && fixed ? lockfileFix(origin, pkg, fixed, lockfile) : {}),
      details: {
        package: pkg.name,
        severity: worst.severity,
        advisories: hits.map((a) => ({ id: a.id, title: a.title, severity: a.severity, url: a.url, vulnerableVersions: a.vulnerable_versions })),
        ...(origin ? { introducedBy: origin.introducedBy } : {}),
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

const folder = (lockfile) => (posix.dirname(lockfile) === '.' ? 'the project folder' : posix.dirname(lockfile));
const manifestOf = (lockfile, root) => posix.join(posix.dirname(lockfile), root, 'package.json');
const list = (items) => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, 2).join(', ')} and ${items.length - 2} more`);
const unique = (items) => [...new Set(items)];

/** Where the installed copies of a vulnerable package sit in the graph, and what brings them in. */
function explain(graph, lockfile, pkg) {
  const label = (path) => `${graph.nodes.get(path).name} ${graph.nodes.get(path).version}`;
  const targets = [...graph.nodes.values()]
    .filter((n) => !graph.roots.has(n.path) && n.name === pkg.name && n.version === pkg.version)
    .map((n) => n.path);
  const routes = trace(graph, targets);
  const via = routes.filter((r) => r.chain.length > 1);
  const direct = routes.length > via.length;
  let message = '';
  if (via.length > 0) {
    const others = via.length - 1;
    message = ` It ${direct ? 'is also pulled in' : 'comes in'} through ${via[0].chain.map(label).join(' → ')}`
      + `${others ? `, and through ${others} other direct ${others === 1 ? 'dependency' : 'dependencies'}` : ''}.`;
  }
  const introducedBy = routes.map((r) => {
    const head = graph.nodes.get(r.chain[0]);
    return {
      package: head.name, version: head.version, dev: r.dev, manifest: manifestOf(lockfile, r.root),
      chain: r.chain.map((p) => `${graph.nodes.get(p).name}@${graph.nodes.get(p).version}`),
    };
  });
  return { graph, targets, routes, label, message, introducedBy };
}

/** The new range for a package.json that asks for `range`, in the same style: exact, ~ or ^. */
const raisedRange = (range, fixed) => (/^\d/.test(range) ? fixed : /^~/.test(range) ? `~${fixed}` : `^${fixed}`);

/**
 * What "npm audit fix" can do on its own, as a fix for the fix pull requests: move the
 * package within the ranges that ask for it, after raising the ranges the project's own
 * package.json sets. Nothing when a dependency's own range, a bundled copy or npm
 * workspaces stand in the way; those need a person.
 */
function lockfileFix({ graph, targets }, pkg, fixed, lockfile) {
  if (graph.roots.size !== 1 || targets.some((t) => graph.nodes.get(t).bundled)) return {};
  const raise = [];
  for (const path of targets) {
    for (const edge of graph.parents.get(path) ?? []) {
      const range = parseRange(edge.range);
      if (!range || satisfies(range, parts(fixed))) continue;
      if (!graph.roots.has(edge.from)) return {};
      if (!raise.some((r) => r.from === edge.range)) raise.push({ manifest: manifestOf(lockfile, edge.from), from: edge.range, to: raisedRange(edge.range, fixed) });
    }
  }
  return { fix: { kind: 'npm-audit', name: pkg.name, to: fixed, ...(raise.length ? { raise } : {}) } };
}

/**
 * The action, knowing the graph: "npm audit fix" when every package that asks for the
 * vulnerable one allows the fixed version; otherwise who stands in the way and what to
 * change instead.
 */
function graphFixAction({ graph, targets, label }, pkg, fixed, lockfile) {
  const where = folder(lockfile);
  // the direct dependencies, by name, that the given installed copies come in through
  const owners = (paths) => unique(trace(graph, paths).map((r) => graph.nodes.get(r.chain[0]).name));
  if (!fixed) {
    const others = owners(targets).filter((name) => name !== pkg.name);
    return `No fixed version of ${pkg.name} is known yet; check the advisories, and consider replacing it`
      + `${others.length ? ` or ${list(others)}, which bring${others.length === 1 ? 's' : ''} it in` : ''}`;
  }
  const bundlers = unique(targets.filter((t) => graph.nodes.get(t).bundled).map((t) => t.slice(0, t.lastIndexOf('/node_modules/'))));
  if (bundlers.length > 0) {
    const names = unique(bundlers.map((b) => graph.nodes.get(b).name));
    const through = owners(bundlers).filter((name) => !names.includes(name));
    return `${pkg.name} is bundled inside ${list(bundlers.map(label))}, so only a release of ${list(names)} that bundles `
      + `${pkg.name} ${fixed} or later fixes it${through.length ? ` (${list(names)} comes in through ${list(through)})` : ''}`;
  }
  const target = parts(fixed);
  const blockers = [];
  for (const path of targets) {
    for (const edge of graph.parents.get(path) ?? []) {
      const range = parseRange(edge.range);
      if (range && !satisfies(range, target) && !blockers.some((b) => b.from === edge.from && b.range === edge.range)) blockers.push(edge);
    }
  }
  if (blockers.length === 0) {
    // nothing pins it: the declared ranges allow the fix, and only the lockfile is out of date
    const allowing = unique(targets.flatMap((t) => (graph.parents.get(t) ?? [])
      .map((e) => (graph.roots.has(e.from) ? manifestOf(lockfile, e.from) : label(e.from)))));
    if (allowing.length === 0) return `Update ${pkg.name} to ${fixed} or later (run "npm audit fix" in ${where})`;
    return `Update ${pkg.name} to ${fixed} or later: ${list(allowing)} already ${allowing.length === 1 ? 'allows' : 'allow'} it, `
      + `so only the lockfile is out of date (run "npm audit fix" in ${where})`;
  }
  const who = blockers.map((b) => `${graph.roots.has(b.from) ? manifestOf(lockfile, b.from) : label(b.from)} (asks for "${b.range}")`);
  const fromManifest = unique(blockers.filter((b) => graph.roots.has(b.from)).map((b) => manifestOf(lockfile, b.from)));
  const inner = blockers.filter((b) => !graph.roots.has(b.from)).map((b) => b.from);
  const steps = [];
  if (fromManifest.length) steps.push(`raise it in ${list(fromManifest)}`);
  if (inner.length) {
    const askers = unique(inner.map((p) => graph.nodes.get(p).name));
    const top = owners(inner);
    const update = top.length ? top : askers;
    steps.push(update.every((name) => askers.includes(name))
      ? `update ${list(update)} to a release that allows it`
      : `update ${list(update)} to a release whose dependencies allow it`);
  }
  const force = inner.length ? ` (or force it with an "overrides" entry in ${manifestOf(lockfile, '')})` : '';
  return `Update ${pkg.name} to ${fixed} or later, which ${list(who)} ${blockers.length === 1 ? 'does' : 'do'} not allow: `
    + `${steps.join(' and ')}${force}, then run "npm install" in ${where}`;
}

function fixAction(pkg, version, hits, lockfile) {
  const where = folder(lockfile);
  const fixed = firstFixedVersion(version, hits);
  if (!fixed) return `No fixed version of ${pkg.name} is known yet; check the advisories, and consider replacing it`;
  return `Update ${pkg.name} to ${fixed} or later (run "npm audit fix" in ${where})`;
}

/**
 * The entries of a package.json "overrides" field: plain ones ("pkg": "spec", also with a
 * "pkg@range" key) and those scoped one level under a parent ("parent": { "pkg": "spec" },
 * where "." is the parent itself). Returns [{ name, parent, key, path }]; key names the entry
 * for the action, e.g. "proxy-addr" or "express" > "proxy-addr", and path is where it sits
 * in "overrides", e.g. ["express", "proxy-addr"].
 */
export function overrideEntries(overrides) {
  const nameOf = (key) => (key.lastIndexOf('@') > 0 ? key.slice(0, key.lastIndexOf('@')) : key);
  const out = [];
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (typeof value === 'string') {
      out.push({ name: nameOf(key), parent: null, key: `"${key}"`, path: [key] });
    } else if (value && typeof value === 'object') {
      for (const [child, spec] of Object.entries(value)) {
        if (typeof spec !== 'string') continue; // deeper nesting is not judged
        if (child === '.') out.push({ name: nameOf(key), parent: null, key: `"${key}"`, path: [key, child] });
        else out.push({ name: nameOf(child), parent: nameOf(key), key: `"${child}" under "${key}"`, path: [key, child] });
      }
    }
  }
  return out;
}

/**
 * Overrides that no longer do anything: the package is not installed any more, or every
 * package that asks for it already allows the version installed, so removing the override
 * changes nothing. The lockfile records the ranges packages declare themselves, before any
 * override, which is what makes this visible. One info finding per such override.
 */
export function unneededOverrides(lockfile, graph, overrides) {
  const manifest = manifestOf(lockfile, '');
  const label = (path) => (graph.roots.has(path) ? manifestOf(lockfile, path) : `${graph.nodes.get(path).name} ${graph.nodes.get(path).version}`);
  // is the installed copy at path reached through a package with this name?
  const below = (path, name) => {
    const seen = new Set([path]);
    const queue = [path];
    for (let i = 0; i < queue.length; i++) {
      for (const { from } of graph.parents.get(queue[i]) ?? []) {
        if (graph.roots.has(from) || seen.has(from)) continue;
        if (graph.nodes.get(from).name === name) return true;
        seen.add(from);
        queue.push(from);
      }
    }
    return false;
  };
  const findings = [];
  for (const entry of overrideEntries(overrides)) {
    const base = {
      check: CHECK, severity: 'info', source: 'overrides', file: manifest,
      details: { override: entry.key, package: entry.name },
      fix: { kind: 'npm-override-remove', path: entry.path },
    };
    const remove = `Remove ${entry.key} from "overrides" in ${manifest}, then run "npm install" in ${folder(lockfile)}`;
    const targets = [...graph.nodes.values()]
      .filter((n) => !graph.roots.has(n.path) && n.name === entry.name && (!entry.parent || below(n.path, entry.parent)))
      .map((n) => n.path);
    if (targets.length === 0) {
      const where = entry.parent ? ` below ${entry.parent}` : '';
      findings.push({ ...base, message: `The override for ${entry.name}${where} in ${manifest} is unused: ${entry.name} is not installed${where}.`, action: remove });
      continue;
    }
    const asks = [];
    let needed = false;
    for (const path of targets) {
      const version = parts(graph.nodes.get(path).version);
      for (const edge of graph.parents.get(path) ?? []) {
        const range = parseRange(edge.range);
        if (!version || !range || !satisfies(range, version)) needed = true; // unreadable ranges count as needed
        if (!asks.some((a) => a.from === edge.from && a.range === edge.range)) asks.push(edge);
      }
    }
    if (needed || asks.length === 0) continue;
    const versions = unique(targets.map((t) => graph.nodes.get(t).version));
    const who = asks.map((a) => `${label(a.from)} (asks for "${a.range}")`);
    findings.push({
      ...base,
      message: `The override for ${entry.name} in ${manifest} is no longer needed: ${list(who)} already `
        + `${asks.length === 1 ? 'allows' : 'allow'} the installed ${list(versions)}.`,
      action: remove,
      details: { ...base.details, versions, askedBy: asks.map((a) => ({ by: label(a.from), range: a.range })) },
    });
  }
  return findings;
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
      // the project's package.json: its "overrides", and for lockfile version 1 what the project itself asks for
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(ctx.root, posix.dirname(lockfile), 'package.json'), 'utf8'));
      } catch { /* none, or unreadable: nothing to say about overrides */ }
      const graph = dependencyGraph(lock, manifest);
      const found = evaluate(lockfile, packages, advisories, cfg, graph);
      if (found.length === 0) {
        const unique = new Set(packages.map((p) => `${p.name}@${p.version}`)).size;
        const scope = cfg.reportFrom === 'info' ? 'No known vulnerabilities' : `No known vulnerabilities of ${cfg.reportFrom} severity or above`;
        findings.push({ check: CHECK, severity: 'ok', source: 'lockfile', file: lockfile, message: `${scope} in ${unique} installed packages.` });
      }
      findings.push(...found, ...unneededOverrides(lockfile, graph, manifest?.overrides));
    }
    return findings;
  },
};
