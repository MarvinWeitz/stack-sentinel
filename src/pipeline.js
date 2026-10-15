/**
 * Where a run happens, read from the variables the pipeline platforms set themselves.
 * Returns { platform, runUrl, repositoryUrl }; fields are missing when unknown.
 */
export function detectPipeline(env = {}) {
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY) {
    const repositoryUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`;
    return {
      platform: 'github',
      repositoryUrl,
      ...(env.GITHUB_RUN_ID ? { runUrl: `${repositoryUrl}/actions/runs/${env.GITHUB_RUN_ID}` } : {}),
    };
  }
  if (env.TF_BUILD === 'True' && env.SYSTEM_COLLECTIONURI && env.SYSTEM_TEAMPROJECT) {
    const collection = env.SYSTEM_COLLECTIONURI.replace(/\/*$/, '/');
    const out = { platform: 'azure-devops' };
    if (env.BUILD_BUILDID) out.runUrl = `${collection}${encodeURIComponent(env.SYSTEM_TEAMPROJECT)}/_build/results?buildId=${env.BUILD_BUILDID}`;
    // Azure Repos addresses can carry the organization as a user name ("org@dev.azure.com")
    if (env.BUILD_REPOSITORY_URI) out.repositoryUrl = env.BUILD_REPOSITORY_URI.replace(/^(https?:\/\/)[^@/]+@/, '$1').replace(/\.git$/, '');
    return out;
  }
  return {};
}
