import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

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

/** The first line npm wrote about what went wrong. */
const reasonOf = (err) => (String(err.stderr ?? '').split('\n').find((l) => /\berr(or)?\b/i.test(l)) ?? err.message).replace(/^npm (error|ERR!)\s*/i, '').trim();

/**
 * Brings the package-lock.json next to each changed package.json up to date, by running npm
 * in a temporary folder that holds only package.json, package-lock.json and .npmrc. `files`
 * are the group's changed files (path -> text), `read(path)` gives the others as they are
 * (null when missing). Returns { files } with the lockfiles added, { skipped } with the
 * lockfiles that could not be brought up to date and why, and for "audit" { unfixed }: the
 * changes npm did not carry out. A package.json is only changed with its lockfile then, as
 * a raised range without the lockfile to match would make "npm ci" fail.
 */
export async function refreshLockfiles(group, files, read, { run = npm, timeoutSeconds = 300 } = {}) {
  const out = new Map(files);
  const skipped = [];
  const unfixed = [];
  const at = (dir, name) => (dir === '.' ? name : `${dir}/${name}`);
  for (const dir of [...new Set(group.changes.map((c) => posix.dirname(c.file)))].sort()) {
    const lockPath = at(dir, 'package-lock.json');
    const here = group.changes.filter((c) => posix.dirname(c.file) === dir);
    const giveUp = (reason) => {
      skipped.push({ file: lockPath, reason });
      if (group.lockfile !== 'audit') return;
      out.delete(at(dir, 'package.json'));
      unfixed.push(...here);
    };
    const lock = await read(lockPath);
    if (lock == null) {
      // a package of a workspace has its lockfile further up, which npm can only update with all of it
      let top = null;
      for (let up = dir; up !== '.' && top == null; ) {
        up = posix.dirname(up);
        if (await read(at(up, 'package-lock.json')) != null) top = up;
      }
      if (top != null) giveUp(`the lockfile in ${top === '.' ? 'the top folder' : top} covers the whole workspace, so run "npm install" there yourself`);
      else if (group.lockfile === 'audit') giveUp('there is no package-lock.json');
      continue;
    }
    const manifest = out.get(at(dir, 'package.json')) ?? await read(at(dir, 'package.json'));
    let workspaces;
    try {
      workspaces = JSON.parse(manifest ?? 'null')?.workspaces;
    } catch { /* checked below */ }
    if (manifest == null || workspaces) {
      giveUp(manifest == null ? 'there is no package.json next to it' : `it covers npm workspaces, so run "npm install" in ${dir === '.' ? 'the top folder' : dir} yourself`);
      continue;
    }
    const npmrc = await read(at(dir, '.npmrc'));
    const tmp = await mkdtemp(join(tmpdir(), 'stack-sentinel-'));
    try {
      await writeFile(join(tmp, 'package.json'), manifest);
      await writeFile(join(tmp, 'package-lock.json'), lock);
      if (npmrc != null) await writeFile(join(tmp, '.npmrc'), npmrc);
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
      // a raised range is kept only when npm moved the package it was raised for
      const kept = here.filter((c) => !left.some((l) => l.finding.fix.name === c.finding.fix.name) && c.finding.fix.kind === 'npm-audit');
      if (group.lockfile === 'audit' && kept.length === 0) {
        out.delete(at(dir, 'package.json'));
        unfixed.push(...here.filter((c) => !left.includes(c)));
        continue;
      }
      for (const [name, before] of [['package-lock.json', lock], ['package.json', out.get(at(dir, 'package.json')) ?? manifest]]) {
        const after = await readFile(join(tmp, name), 'utf8');
        if (after !== before) out.set(at(dir, name), after);
      }
    } catch (err) {
      giveUp(`npm could not update it: ${reasonOf(err)}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  return { files: out, skipped, unfixed };
}
