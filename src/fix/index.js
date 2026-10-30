import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { azureProvider } from './azure.js';
import { githubProvider } from './github.js';
import { releaseNotes } from './notes.js';
import { refreshLockfiles } from './npm.js';
import { GROUPS, applyGroup, describe, onlyPatches, planFixes, pullRequestBody, readMarker } from './plan.js';

/** Changes the files in the scanned folder itself. Returns [{ group, files, skipped }]. */
export async function applyFixes(report, root, { fixOn, only, runNpm, before }) {
  const results = [];
  const read = (file) => readFile(join(root, file), 'utf8').catch(() => null);
  for (let group of planFixes(report.findings, { fixOn, only })) {
    let { files, applied, skipped } = await applyGroup(group, read);
    const notes = skipped.map((s) => `${s.change.file}: ${s.reason}`);
    if (group.lockfile && applied.length) {
      const refreshed = await refreshLockfiles({ ...group, changes: applied }, files, read, { run: runNpm, before });
      files = refreshed.files;
      notes.push(...refreshed.skipped.map((s) => `${s.file}: ${s.reason}`),
        ...refreshed.unfixed.filter((c) => c.finding.fix.kind === 'npm-audit').map((c) => `${c.file}: npm did not move ${c.finding.fix.name} to ${c.finding.fix.to}${heldBack(before)}`));
      const moved = applied.filter((c) => !refreshed.unfixed.includes(c));
      if (moved.length) group = { ...group, title: describe(group.id, moved).title };
    }
    for (const [file, text] of files) await writeFile(join(root, file), text);
    results.push({ group: group.id, title: group.title, files: [...files.keys()], skipped: notes });
  }
  return results;
}

/** The repository's top folder: the nearest folder above `root` with a .git in it. */
function repositoryRoot(root) {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return root;
  }
}

/**
 * The platform to open pull requests on, from the variables the pipeline sets. The token is
 * SENTINEL_FIX_TOKEN when set, else the pipeline's own: GITHUB_TOKEN on GitHub Actions,
 * SYSTEM_ACCESSTOKEN on Azure DevOps.
 */
export function detectProvider(env, { token, timeoutSeconds, workItemType }) {
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY) {
    const auth = token ?? env.GITHUB_TOKEN;
    if (!auth) throw new Error('Fix pull requests and the dashboard need a token: pass GITHUB_TOKEN (or SENTINEL_FIX_TOKEN) to the step.');
    return githubProvider({ apiUrl: env.GITHUB_API_URL, repository: env.GITHUB_REPOSITORY, token: auth, timeoutSeconds });
  }
  if (env.TF_BUILD === 'True' && env.SYSTEM_COLLECTIONURI) {
    if (env.BUILD_REPOSITORY_PROVIDER && env.BUILD_REPOSITORY_PROVIDER !== 'TfsGit') {
      throw new Error(`Pull requests can be opened in Azure Repos only, not in a ${env.BUILD_REPOSITORY_PROVIDER} repository.`);
    }
    const auth = token ?? env.SYSTEM_ACCESSTOKEN;
    if (!auth) throw new Error('Fix pull requests and the dashboard need a token: map $(System.AccessToken) to SYSTEM_ACCESSTOKEN in the step\'s env.');
    return azureProvider({
      collectionUri: env.SYSTEM_COLLECTIONURI, project: env.SYSTEM_TEAMPROJECT, repositoryId: env.BUILD_REPOSITORY_ID, token: auth, timeoutSeconds, workItemType,
    });
  }
  throw new Error('Fix pull requests and the dashboard work on GitHub Actions and Azure DevOps only. Use --fix apply (SENTINEL_FIX_MODE=apply) to change the files instead.');
}

/** Why npm may not have moved a package, when releases after `before` were left out. */
const heldBack = (before) => (before ? ` (only releases published before ${before.toISOString().slice(0, 10)} were used: minReleaseAgeDays)` : '');

const STALE = 'stack-sentinel no longer finds anything to change here, so this pull request is closed.';
const WORKFLOWS = 'GitHub lets only a token with the "Workflows" permission change files in .github/workflows, and GITHUB_TOKEN cannot have it. '
  + 'To have them changed too, set SENTINEL_FIX_TOKEN to a token with "Contents", "Pull requests" and "Workflows" write access.';

/** Commits one group's changes to its branch and opens or updates its pull request. */
async function writeGroup(group, { provider, branch, baseBranch, open, inRepo, report, log, autoMerge = 'off', runNpm, before, fetchJson, registry }) {
  // the edits are made to the default branch as it is now, not to the files the scan saw
  const read = (file) => provider.readFile(baseBranch, file);
  let { files, applied, skipped } = await applyGroup({ ...group, changes: group.changes.map((c) => ({ ...c, file: inRepo(c.file) })) }, read);
  for (const s of skipped) log(`not changed: ${s.change.file}: ${s.reason}`);
  let written;
  const notes = [];
  if (group.lockfile && applied.length) {
    const refreshed = await refreshLockfiles({ ...group, changes: applied }, files, read, { run: runNpm, before });
    files = refreshed.files;
    for (const s of refreshed.skipped) {
      log(`not changed: ${s.file}: ${s.reason}`);
      notes.push(`Not changed: \`${s.file}\`, because ${s.reason}.`);
    }
    for (const c of refreshed.unfixed.filter((u) => u.finding.fix.kind === 'npm-audit')) {
      log(`not changed: ${c.file}: npm did not move ${c.finding.fix.name} to ${c.finding.fix.to}${heldBack(before)}`);
      notes.push(`Not changed: ${c.finding.fix.name} in \`${c.file}\`, because npm did not move it to ${c.finding.fix.to}${heldBack(before)}: see the finding for what stands in the way.`);
    }
    applied = applied.filter((c) => !refreshed.unfixed.includes(c));
    // the advisory names the lowest fixed version; the title names the one npm moved to
    if (applied.length) group = { ...group, title: describe(group.id, applied).title };
  }
  if (files.size === 0) return { action: 'skipped', more: { reason: 'none of the changes apply to the default branch' } };
  try {
    written = await provider.writeBranch(branch, baseBranch, files, group.title, { open: Boolean(open) });
  } catch (err) {
    // GitHub refuses the whole commit when it touches a workflow file the token may not change
    const workflow = (file) => provider.platform === 'github' && /^\.github\/workflows\//.test(file);
    if (err.status !== 403 || ![...files.keys()].some(workflow)) throw err;
    const left = [...files.keys()].filter(workflow);
    log(`not changed: ${left.join(', ')}: ${WORKFLOWS}`);
    files = new Map([...files].filter(([file]) => !workflow(file)));
    applied = applied.filter((c) => !workflow(c.file));
    if (files.size === 0) return { action: 'skipped', more: { reason: WORKFLOWS } };
    notes.push(`Not changed: ${left.map((f) => `\`${f}\``).join(', ')}. ${WORKFLOWS}`);
    written = await provider.writeBranch(branch, baseBranch, files, group.title, { open: Boolean(open) });
  }
  const merge = autoMerge === 'all' || (autoMerge === 'patch' && onlyPatches(applied));
  // Azure DevOps allows 4000 characters in a description: links only there
  const changes = await releaseNotes(group, applied, { fetchJson, registry, withBodies: provider.platform !== 'azure-devops' });
  const body = pullRequestBody(group, applied, report,
    merge ? [...notes, 'Auto-merge is on: this pull request is merged once its required checks pass (fix.autoMerge).'] : notes, changes);
  let pr = open;
  let action = 'created';
  if (open) {
    if (written !== 'unchanged' || open.title !== group.title || open.body !== body) await provider.updatePullRequest(open, { title: group.title, body });
    action = written === 'unchanged' ? 'unchanged' : 'updated';
  } else {
    pr = await provider.createPullRequest({ branch, baseBranch, title: group.title, body, draft: group.draft });
  }
  const more = open ? {} : { url: pr.url };
  // a refused auto-merge leaves the pull request open for a person, and is said in the output
  if (merge && !group.draft) {
    try {
      await provider.enableAutoMerge(pr);
      more.autoMerge = true;
    } catch (err) {
      more.autoMerge = false;
      log(`auto-merge not turned on for "${group.title}": ${err.message}`);
      await provider.updatePullRequest(pr, { title: group.title, body: pullRequestBody(group, applied, report, notes, changes) });
    }
  }
  return { action, created: !open, title: group.title, more };
}

/**
 * Opens one pull request per group of fixes, or updates the one an earlier run opened.
 * Nothing is stored between runs: the branch of a group never changes, and the pull
 * requests on those branches are the memory. Returns what happened to each group:
 * [{ group, title, action: 'created' | 'updated' | 'unchanged' | 'closed' | 'skipped', url?, reason? }].
 */
export async function openPullRequests(report, root, {
  provider, fixOn, only, branchPrefix, maxPullRequests, autoMerge = 'off', log = () => {}, runNpm, before, fetchJson, registry,
}) {
  const prefix = relative(repositoryRoot(root), root).split(sep).filter(Boolean).join('/');
  const inRepo = (file) => (prefix ? `${prefix}/${file}` : file);
  const groups = planFixes(report.findings, { fixOn, only });
  const baseBranch = await provider.defaultBranch();
  const existing = await provider.findPullRequests(branchPrefix);
  const results = [];

  // A pull request whose findings are gone is closed, but only when its check ran cleanly:
  // a check that could not run says nothing about whether the finding is still there. One
  // whose kind of fix was turned off is left as it is.
  const failed = new Set(report.findings.filter((f) => f.source === 'check').map((f) => f.check));
  const checksOf = (id) => GROUPS.find((g) => g.id === id)?.checks;
  const ranCleanly = (id) => checksOf(id).every((c) => report.checks.run.includes(c) && !failed.has(c));
  for (const pr of existing.filter((p) => p.state === 'open')) {
    const id = pr.branch.slice(branchPrefix.length);
    if (groups.some((g) => g.id === id) || (only && !only.includes(id)) || !checksOf(id) || !ranCleanly(id)) continue;
    await provider.closePullRequest(pr, STALE);
    results.push({ group: id, title: pr.title, action: 'closed', url: pr.url });
  }

  let openCount = existing.filter((p) => p.state === 'open' && !results.some((r) => r.url === p.url)).length;
  for (const group of groups) {
    const branch = `${branchPrefix}${group.id}`;
    const prs = existing.filter((p) => p.branch === branch);
    const open = prs.find((p) => p.state === 'open');
    const result = (action, more) => results.push({ group: group.id, title: group.title, action, ...(open ? { url: open.url } : {}), ...more });
    if (!open && prs.some((p) => p.state === 'closed' && readMarker(p.body) === group.signature)) {
      result('skipped', { reason: 'a pull request for these versions was closed without merging' });
      continue;
    }
    if (!open && openCount >= maxPullRequests) {
      result('skipped', { reason: `${openCount} stack-sentinel pull requests are already open (fix.maxPullRequests)` });
      continue;
    }
    // one group that fails does not stop the others; the run still ends as a tool failure
    try {
      const done = await writeGroup(group, { provider, branch, baseBranch, open, inRepo, report, log, autoMerge, runNpm, before, fetchJson, registry });
      if (done.created) openCount++;
      result(done.action, { title: done.title ?? group.title, ...done.more });
    } catch (err) {
      result('failed', { reason: err.message });
    }
  }
  return results;
}
