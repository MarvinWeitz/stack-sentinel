/**
 * Pull requests on GitHub, through the REST API alone: commits are made with the Git data
 * API, so no git client and no checkout of the branch is needed.
 * https://docs.github.com/en/rest/git
 */
export function githubProvider({ apiUrl = 'https://api.github.com', repository, token, timeoutSeconds = 30, fetchImpl = fetch }) {
  const [owner, repo] = repository.split('/');
  const base = `${apiUrl.replace(/\/+$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
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
      throw new Error(`GitHub answered ${method} ${path} with HTTP ${res.status}${detail ? `: ${detail}` : ''}.${hint}`);
    }
    return res.status === 204 ? null : res.json();
  }

  const headOf = async (branch) => (await call('GET', `/git/ref/heads/${refPath(branch)}`, undefined, { allow404: true }))?.object.sha ?? null;
  const state = (pr) => (pr.state === 'open' ? 'open' : pr.merged_at ? 'merged' : 'closed');

  return {
    platform: 'github',

    async defaultBranch() {
      return (await call('GET', '')).default_branch;
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
        .map((pr) => ({ id: pr.number, branch: pr.head.ref, state: state(pr), title: pr.title, body: pr.body ?? '', url: pr.html_url }));
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

    async createPullRequest({ branch, baseBranch, title, body }) {
      const pr = await call('POST', '/pulls', { title, body, head: branch, base: baseBranch });
      return { id: pr.number, url: pr.html_url };
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
