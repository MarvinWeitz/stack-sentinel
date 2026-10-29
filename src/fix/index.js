import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { azureProvider } from './azure.js';
import { githubProvider } from './github.js';
import { GROUPS, applyGroup, planFixes, pullRequestBody, readMarker } from './plan.js';

/** Changes the files in the scanned folder itself. Returns [{ group, files, skipped }]. */
export async function applyFixes(report, root, { fixOn, only }) {
  const results = [];
  for (const group of planFixes(report.findings, { fixOn, only })) {
    const { files, skipped } = await applyGroup(group, (file) => readFile(join(root, file), 'utf8').catch(() => null));
    for (const [file, text] of files) await writeFile(join(root, file), text);
    results.push({ group: group.id, title: group.title, files: [...files.keys()], skipped: skipped.map((s) => `${s.change.file}: ${s.reason}`) });
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
export function detectProvider(env, { token, timeoutSeconds }) {
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY) {
    const auth = token ?? env.GITHUB_TOKEN;
    if (!auth) throw new Error('Opening pull requests needs a token: pass GITHUB_TOKEN (or SENTINEL_FIX_TOKEN) to the step.');
    return githubProvider({ apiUrl: env.GITHUB_API_URL, repository: env.GITHUB_REPOSITORY, token: auth, timeoutSeconds });
  }
  if (env.TF_BUILD === 'True' && env.SYSTEM_COLLECTIONURI) {
    if (env.BUILD_REPOSITORY_PROVIDER && env.BUILD_REPOSITORY_PROVIDER !== 'TfsGit') {
      throw new Error(`Pull requests can be opened in Azure Repos only, not in a ${env.BUILD_REPOSITORY_PROVIDER} repository.`);
    }
    const auth = token ?? env.SYSTEM_ACCESSTOKEN;
    if (!auth) throw new Error('Opening pull requests needs a token: map $(System.AccessToken) to SYSTEM_ACCESSTOKEN in the step\'s env.');
    return azureProvider({
      collectionUri: env.SYSTEM_COLLECTIONURI, project: env.SYSTEM_TEAMPROJECT, repositoryId: env.BUILD_REPOSITORY_ID, token: auth, timeoutSeconds,
    });
  }
  throw new Error('Pull requests can be opened on GitHub Actions and Azure DevOps only. Use --fix apply (SENTINEL_FIX_MODE=apply) to change the files instead.');
}

const STALE = 'stack-sentinel no longer finds anything to change here, so this pull request is closed.';
const WORKFLOWS = 'GitHub lets only a token with the "Workflows" permission change files in .github/workflows, and GITHUB_TOKEN cannot have it. '
  + 'To have them changed too, set SENTINEL_FIX_TOKEN to a token with "Contents", "Pull requests" and "Workflows" write access.';

/** Commits one group's changes to its branch and opens or updates its pull request. */
async function writeGroup(group, { provider, branch, baseBranch, open, inRepo, report, log }) {
  // the edits are made to the default branch as it is now, not to the files the scan saw
  let { files, applied, skipped } = await applyGroup({ ...group, changes: group.changes.map((c) => ({ ...c, file: inRepo(c.file) })) },
    (file) => provider.readFile(baseBranch, file));
  for (const s of skipped) log(`not changed: ${s.change.file}: ${s.reason}`);
  if (files.size === 0) return { action: 'skipped', more: { reason: 'none of the changes apply to the default branch' } };
  let written;
  const notes = [];
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
  const body = pullRequestBody(group, applied, report, notes);
  if (open) {
    if (written !== 'unchanged' || open.title !== group.title || open.body !== body) await provider.updatePullRequest(open, { title: group.title, body });
    return { action: written === 'unchanged' ? 'unchanged' : 'updated' };
  }
  const pr = await provider.createPullRequest({ branch, baseBranch, title: group.title, body, draft: group.draft });
  return { action: 'created', created: true, more: { url: pr.url } };
}

/**
 * Opens one pull request per group of fixes, or updates the one an earlier run opened.
 * Nothing is stored between runs: the branch of a group never changes, and the pull
 * requests on those branches are the memory. Returns what happened to each group:
 * [{ group, title, action: 'created' | 'updated' | 'unchanged' | 'closed' | 'skipped', url?, reason? }].
 */
export async function openPullRequests(report, root, { provider, fixOn, only, branchPrefix, maxPullRequests, log = () => {} }) {
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
      const done = await writeGroup(group, { provider, branch, baseBranch, open, inRepo, report, log });
      if (done.created) openCount++;
      result(done.action, done.more);
    } catch (err) {
      result('failed', { reason: err.message });
    }
  }
  return results;
}
