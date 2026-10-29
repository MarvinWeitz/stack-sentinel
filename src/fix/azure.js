/**
 * Pull requests in Azure Repos, through its REST API alone: commits are made with the pushes
 * API, so no git client is needed. Azure Repos gives a pipeline no force push by default, so
 * a branch with an open pull request gets a new commit on top instead of being rebuilt.
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/
 */
const ZERO = '0'.repeat(40);
const VERSION = 'api-version=7.1';

export function azureProvider({ collectionUri, project, repositoryId, token, timeoutSeconds = 30, fetchImpl = fetch }) {
  const base = `${collectionUri.replace(/\/*$/, '/')}${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}`;
  const heads = (branch) => `refs/heads/${branch}`;

  async function call(method, path, body, { allow404 = false } = {}) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetchImpl(`${base}${path}${sep}${VERSION}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).message ?? '';
      } catch { /* no JSON body */ }
      const hint = res.status === 401 || res.status === 403
        ? ' Pass $(System.AccessToken) as SYSTEM_ACCESSTOKEN, and give the project\'s build service "Contribute" and "Contribute to pull requests" on the repository.'
        : '';
      throw Object.assign(new Error(`Azure DevOps answered ${method} ${path.split('?')[0] || '/'} with HTTP ${res.status}${detail ? `: ${detail}` : ''}.${hint}`), { status: res.status });
    }
    return res.status === 204 ? null : res.json();
  }

  /** The commit a branch points at, or null. The refs filter matches by prefix, so the name is compared in full. */
  async function headOf(branch) {
    const refs = await call('GET', `/refs?filter=${encodeURIComponent(`heads/${branch}`)}`);
    return refs.value.find((r) => r.name === heads(branch))?.objectId ?? null;
  }

  async function readFile(branch, path) {
    const item = await call('GET', `/items?path=${encodeURIComponent(`/${path}`)}&versionDescriptor.version=${encodeURIComponent(branch)}`
      + '&versionDescriptor.versionType=branch&includeContent=true&$format=json', undefined, { allow404: true });
    return item?.content ?? null;
  }

  const state = (pr) => (pr.status === 'active' ? 'open' : pr.status === 'completed' ? 'merged' : 'closed');
  let repository;
  const repo = async () => (repository ??= await call('GET', ''));
  const webUrl = async (id) => `${(await repo()).webUrl}/pullrequest/${id}`;
  // descriptions are limited to 4000 characters; the last line is the marker, which must stay
  const fit = (body) => (body.length <= 4000 ? body : `${body.slice(0, 3990 - body.split('\n').at(-1).length)}…\n${body.split('\n').at(-1)}`);

  return {
    platform: 'azure-devops',

    async defaultBranch() {
      return (await repo()).defaultBranch.replace(/^refs\/heads\//, '');
    },

    readFile,

    async findPullRequests(prefix) {
      const prs = await call('GET', '/pullrequests?searchCriteria.status=all&$top=100');
      return Promise.all(prs.value
        .filter((pr) => pr.sourceRefName.startsWith(heads(prefix)))
        .map(async (pr) => ({
          id: pr.pullRequestId, branch: pr.sourceRefName.replace(/^refs\/heads\//, ''), state: state(pr),
          title: pr.title, body: pr.description ?? '', url: await webUrl(pr.pullRequestId),
        })));
    },

    /**
     * Gives `branch` the files' content. A branch left over from a closed pull request is
     * started again from `baseBranch`; an open one gets a commit on top, unless it already
     * holds exactly that content ('unchanged').
     */
    async writeBranch(branch, baseBranch, files, message, { open = false } = {}) {
      let current = await headOf(branch);
      if (current && open) {
        const same = await Promise.all([...files].map(async ([path, content]) => (await readFile(branch, path)) === content));
        if (same.every(Boolean)) return 'unchanged';
      } else if (current) {
        await call('POST', '/refs', [{ name: heads(branch), oldObjectId: current, newObjectId: ZERO }]);
        current = null;
      }
      const parent = current ?? await headOf(baseBranch);
      await call('POST', '/pushes', {
        refUpdates: [{ name: heads(branch), oldObjectId: current ?? ZERO }],
        commits: [{
          comment: message,
          parents: [parent],
          changes: [...files].map(([path, content]) => ({ changeType: 'edit', item: { path: `/${path}` }, newContent: { content, contentType: 'rawtext' } })),
        }],
      });
      return current ? 'updated' : 'created';
    },

    async createPullRequest({ branch, baseBranch, title, body, draft = false }) {
      const pr = await call('POST', '/pullrequests', { sourceRefName: heads(branch), targetRefName: heads(baseBranch), title, description: fit(body), isDraft: draft });
      return { id: pr.pullRequestId, url: await webUrl(pr.pullRequestId) };
    },

    async updatePullRequest(pr, { title, body }) {
      await call('PATCH', `/pullrequests/${pr.id}`, { title, description: fit(body) });
    },

    async closePullRequest(pr, comment) {
      await call('POST', `/pullrequests/${pr.id}/threads`, { comments: [{ content: comment, commentType: 'text' }], status: 'closed' });
      await call('PATCH', `/pullrequests/${pr.id}`, { status: 'abandoned' });
    },
  };
}
