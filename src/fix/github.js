/**
 * Pull requests on GitHub, through the REST API alone: commits are made with the Git data
 * API, so no git client and no checkout of the branch is needed.
 * https://docs.github.com/en/rest/git
 */
export function githubProvider({ apiUrl = 'https://api.github.com', repository, token, timeoutSeconds = 30, fetchImpl = fetch }) {
  const [owner, repo] = repository.split('/');
  const api = apiUrl.replace(/\/+$/, '');
  const base = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  // GitHub Enterprise Server serves REST under /api/v3 and GraphQL under /api/graphql
  const graphqlUrl = /\/api\/v3$/.test(api) ? api.replace(/\/v3$/, '/graphql') : `${api}/graphql`;
  const refPath = (branch) => branch.split('/').map(encodeURIComponent).join('/');

  async function call(method, path, body, { allow404 = false } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
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
      const hint = res.status === 403 && method === 'POST' && path === '/pulls'
        ? ' Allow it under Settings -> Actions -> General -> "Allow GitHub Actions to create and approve pull requests", or set SENTINEL_FIX_TOKEN.'
        : res.status === 403 || res.status === 404
          ? ' The token needs "contents: write" and "pull-requests: write" (the permissions block of the workflow).'
          : '';
      throw Object.assign(new Error(`GitHub answered ${method} ${path} with HTTP ${res.status}${detail ? `: ${detail}` : ''}.${hint}`), { status: res.status });
    }
    return res.status === 204 ? null : res.json();
  }

  let info;
  const repoInfo = async () => (info ??= await call('GET', ''));
  const headOf = async (branch) => (await call('GET', `/git/ref/heads/${refPath(branch)}`, undefined, { allow404: true }))?.object.sha ?? null;
  const state = (pr) => (pr.state === 'open' ? 'open' : pr.merged_at ? 'merged' : 'closed');

  return {
    platform: 'github',

    async defaultBranch() {
      return (await repoInfo()).default_branch;
    },

    async readFile(branch, path) {
      const file = await call('GET', `/contents/${refPath(path)}?ref=${encodeURIComponent(branch)}`, undefined, { allow404: true });
      if (!file || Array.isArray(file) || file.type !== 'file') return null;
      return Buffer.from(file.content, 'base64').toString('utf8');
    },

    /** Pull requests, open and closed, whose branch starts with `prefix`. */
    async findPullRequests(prefix) {
      const prs = await call('GET', '/pulls?state=all&sort=updated&direction=desc&per_page=100');
      return prs
        .filter((pr) => pr.head?.ref?.startsWith(prefix) && pr.head.repo?.full_name === `${owner}/${repo}`)
        .map((pr) => ({ id: pr.number, nodeId: pr.node_id, branch: pr.head.ref, state: state(pr), title: pr.title, body: pr.body ?? '', url: pr.html_url }));
    },

    /**
     * Makes `branch` one commit on top of `baseBranch` with `files` changed, replacing what it
     * held before. Returns 'created', 'updated', or 'unchanged' when it already held exactly that.
     */
    async writeBranch(branch, baseBranch, files, message) {
      const baseSha = await headOf(baseBranch);
      const baseCommit = await call('GET', `/git/commits/${baseSha}`);
      const tree = await call('POST', '/git/trees', {
        base_tree: baseCommit.tree.sha,
        tree: [...files].map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
      });
      const current = await headOf(branch);
      if (current) {
        const commit = await call('GET', `/git/commits/${current}`);
        if (commit.tree.sha === tree.sha) return 'unchanged';
      }
      const commit = await call('POST', '/git/commits', { message, tree: tree.sha, parents: [baseSha] });
      if (current) await call('PATCH', `/git/refs/heads/${refPath(branch)}`, { sha: commit.sha, force: true });
      else await call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
      return current ? 'updated' : 'created';
    },

    async createPullRequest({ branch, baseBranch, title, body, draft = false }) {
      const pr = await call('POST', '/pulls', { title, body, head: branch, base: baseBranch, draft });
      return { id: pr.number, nodeId: pr.node_id, url: pr.html_url };
    },

    /**
     * Turns on auto-merge, so GitHub merges the pull request once its required checks pass.
     * It never merges right away: a branch without required checks gets an error instead.
     */
    async enableAutoMerge(pr) {
      const settings = await repoInfo();
      if (settings.allow_auto_merge === false) throw new Error('auto-merge is turned off for the repository (Settings -> General -> "Allow auto-merge")');
      const method = settings.allow_squash_merge !== false ? 'SQUASH' : settings.allow_merge_commit !== false ? 'MERGE' : 'REBASE';
      const res = await fetchImpl(graphqlUrl, {
        method: 'POST',
        headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId } }',
          variables: { id: pr.nodeId, method },
        }),
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
      const json = await res.json().catch(() => ({}));
      const error = json.errors?.[0]?.message ?? (res.ok ? null : `HTTP ${res.status}`);
      if (!error || /already/i.test(error)) return;
      throw new Error(/clean status|protected branch/i.test(error)
        ? `${error}: auto-merge needs a branch protection rule with required checks on the default branch`
        : error);
    },

    async updatePullRequest(pr, { title, body }) {
      await call('PATCH', `/pulls/${pr.id}`, { title, body });
    },

    async closePullRequest(pr, comment) {
      await call('POST', `/issues/${pr.id}/comments`, { body: comment });
      await call('PATCH', `/pulls/${pr.id}`, { state: 'closed' });
      await call('DELETE', `/git/refs/heads/${refPath(pr.branch)}`, undefined, { allow404: true });
    },
  };
}
