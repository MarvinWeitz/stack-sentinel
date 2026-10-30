import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { applyFix } from './edits.js';

const INSTALL = ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'];

/**
 * How a group brings a lockfile up to date: "install" makes it agree with a changed
 * package.json, "audit" then also moves vulnerable packages to fixed versions the ranges
 * allow. Neither installs packages or runs their scripts. `check: false` means a failing
 * command still leaves a usable lockfile (npm audit fix fails while anything is left unfixed).
 */
const COMMANDS = {
  install: [{ args: INSTALL }],
  audit: [{ args: INSTALL }, { args: ['audit', 'fix', '--package-lock-only', '--ignore-scripts', '--no-fund'], check: false }],
};

/** Runs npm in `cwd`. npm.cmd on Windows only starts through a shell; the arguments are fixed. */
export function npm(args, cwd, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, timeout: timeoutSeconds * 1000, shell: process.platform === 'win32', maxBuffer: 16 << 20 },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
  });
}

const older = (a, b) => {
  const [pa, pb] = [a, b].map((v) => String(v).split(/[.+-]/).slice(0, 3).map((n) => Number(n) || 0));
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
};

/** The versions of `name` a lockfile still holds that are older than `to`. */
function stillOlder(lockText, name, to) {
  const packages = JSON.parse(lockText).packages ?? {};
  return Object.entries(packages)
    .filter(([path, p]) => (path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)) && p.version && older(p.version, to) < 0)
    .map(([, p]) => p.version);
}

/** Every version of `name` a lockfile holds, oldest first. */
function versionsIn(lockText, name) {
  const packages = JSON.parse(lockText).packages ?? {};
  return Object.entries(packages)
    .filter(([path, p]) => (path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)) && p.version)
    .map(([, p]) => p.version).sort(older);
}

/**
 * The first fixed version an advisory names need not be published (lodash's says 4.17.24,
 * the next release was 4.18.0), so a raised range is moved to the oldest release at or
 * above it that the registry has, keeping its style. Null when npm cannot tell.
 */
async function published(run, spec, name, cwd, timeoutSeconds) {
  const base = spec.replace(/^[\^~]/, '');
  try {
    const out = JSON.parse(await run(['view', `${name}@>=${base}`, 'version', '--json'], cwd, timeoutSeconds) ?? 'null');
    const first = Array.isArray(out) ? out[0] : out;
    return typeof first === 'string' ? spec.replace(base, first) : null;
  } catch {
    return null;
  }
}

/** The first line npm wrote about what went wrong. */
const reasonOf = (err) => (String(err.stderr ?? '').split('\n').find((l) => /\berr(or)?\b/i.test(l)) ?? err.message).replace(/^npm (error|ERR!)\s*/i, '').trim();

/**
 * The folder whose package-lock.json covers `dir`: `dir` itself, or a folder above it whose
 * lockfile lists `dir` as one of its npm workspaces. Null when none does.
 */
async function lockfileFolder(dir, read, at) {
  for (let up = dir; ; up = posix.dirname(up)) {
    const lock = await read(at(up, 'package-lock.json'));
    if (lock != null) {
      if (up === dir) return up;
      const below = up === '.' ? dir : posix.relative(up, dir);
      try {
        return JSON.parse(lock).packages?.[below] ? up : null;
      } catch {
        return null;
      }
    }
    if (up === '.') return null;
  }
}

/** The workspace folders a lockfile lists, relative to it: its packages outside node_modules. */
const workspacesOf = (lockText) => Object.keys(JSON.parse(lockText).packages ?? {})
  .filter((path) => path !== '' && !path.split('/').includes('node_modules'));

/**
 * Brings the package-lock.json that covers each changed package.json up to date, by running
 * npm in a temporary folder that holds only that lockfile, .npmrc and the package.json files
 * it covers: the project's, and each npm workspace's. `files` are the group's changed files
 * (path -> text), `read(path)` gives the others as they are (null when missing). Returns
 * { files } with the lockfiles added, { skipped } with the lockfiles that could not be
 * brought up to date and why, and for "audit" { unfixed }: the changes npm did not carry
 * out. A package.json is only changed with its lockfile then, as a raised range without the
 * lockfile to match would make "npm ci" fail.
 */
export async function refreshLockfiles(group, files, read, { run = npm, timeoutSeconds = 300 } = {}) {
  const out = new Map(files);
  const skipped = [];
  const unfixed = [];
  const at = (dir, name) => (dir === '.' ? name : `${dir}/${name}`);
  const byRoot = new Map();
  for (const change of group.changes) {
    const dir = posix.dirname(change.file);
    const root = await lockfileFolder(dir, read, at);
    if (root == null) {
      // without a lockfile there is nothing to update; a vulnerable package is only fixed in one
      if (group.lockfile === 'audit') {
        skipped.push({ file: at(dir, 'package-lock.json'), reason: 'there is no package-lock.json' });
        unfixed.push(change);
        out.delete(at(dir, 'package.json'));
      }
      continue;
    }
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(change);
  }
  for (const [root, here] of [...byRoot].sort(([a], [b]) => a.localeCompare(b))) {
    const lockPath = at(root, 'package-lock.json');
    const lock = await read(lockPath);
    let folders;
    try {
      folders = ['.', ...workspacesOf(lock)];
    } catch {
      skipped.push({ file: lockPath, reason: 'it could not be read as JSON' });
      continue;
    }
    // every package.json the lockfile covers, as the group changed it
    const manifests = new Map();
    for (const folder of folders) {
      const path = at(root === '.' ? folder : folder === '.' ? root : `${root}/${folder}`, 'package.json');
      const text = out.get(path) ?? await read(path);
      if (text != null) manifests.set(folder, { path, text, before: text });
    }
    const giveUp = (reason) => {
      skipped.push({ file: lockPath, reason });
      if (group.lockfile !== 'audit') return;
      for (const m of manifests.values()) if (files.has(m.path)) out.delete(m.path);
      unfixed.push(...here);
    };
    if (!manifests.has('.')) {
      giveUp('there is no package.json next to it');
      continue;
    }
    const npmrc = await read(at(root, '.npmrc'));
    const tmp = await mkdtemp(join(tmpdir(), 'stack-sentinel-'));
    try {
      if (npmrc != null) await writeFile(join(tmp, '.npmrc'), npmrc);
      for (const c of here.filter((h) => h.finding.fix.kind === 'npm-dependency')) {
        const m = [...manifests.values()].find((v) => v.path === c.file);
        const spec = m && await published(run, c.finding.fix.to, c.finding.fix.name, tmp, timeoutSeconds);
        const moved = spec && spec !== c.finding.fix.to ? applyFix(m.text, { fix: { ...c.finding.fix, from: c.finding.fix.to, to: spec } }) : {};
        if (!moved.text) continue;
        m.text = moved.text;
        c.finding = { ...c.finding, fix: { ...c.finding.fix, to: spec } };
      }
      for (const [folder, m] of manifests) {
        await mkdir(join(tmp, folder), { recursive: true });
        await writeFile(join(tmp, folder, 'package.json'), m.text);
      }
      await writeFile(join(tmp, 'package-lock.json'), lock);
      for (const { args, check = true } of COMMANDS[group.lockfile]) {
        try {
          await run(args, tmp, timeoutSeconds);
        } catch (err) {
          if (check) throw err;
        }
      }
      const next = await readFile(join(tmp, 'package-lock.json'), 'utf8');
      const left = here.filter((c) => c.finding.fix.kind === 'npm-audit' && stillOlder(next, c.finding.fix.name, c.finding.fix.to).length > 0);
      unfixed.push(...left);
      // the pull request says which version npm moved it to, not the advisory's lower bound
      for (const c of here.filter((h) => h.finding.fix.kind === 'npm-audit' && !left.includes(h))) {
        const now = versionsIn(next, c.finding.fix.name)[0];
        if (now) c.finding = { ...c.finding, fix: { ...c.finding.fix, to: now } };
      }
      // a raised range is kept only when npm moved the package it was raised for
      if (group.lockfile === 'audit' && !here.some((c) => c.finding.fix.kind === 'npm-audit' && !left.includes(c))) {
        for (const m of manifests.values()) if (files.has(m.path)) out.delete(m.path);
        unfixed.push(...here.filter((c) => !left.includes(c)));
        continue;
      }
      if (next !== lock) out.set(lockPath, next);
      for (const [folder, m] of manifests) {
        const after = await readFile(join(tmp, folder, 'package.json'), 'utf8');
        if (after !== m.before) out.set(m.path, after);
      }
    } catch (err) {
      giveUp(`npm could not update it: ${reasonOf(err)}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  return { files: out, skipped, unfixed };
}
