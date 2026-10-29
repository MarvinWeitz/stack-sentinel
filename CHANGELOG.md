# Changelog

What changed in each release of `@cbs-consulting/stack-sentinel`, newest
first. Add your change under "Unreleased" in the same pull request; a check
fails otherwise, unless the pull request has the label "no changelog". To
release, raise the version in `package.json` and rename "Unreleased" to that
version and the date. The tests fail while the version in `package.json` has
no entry here, and the Release workflow publishes the entry as the GitHub
release notes.

## Unreleased

- `node-version` also reads the Node.js version that CI pipelines set up
  (GitHub's `actions/setup-node`, Azure Pipelines' `NodeTool` and `UseNode`)
  and the `node` image Dockerfiles build on, and fix pull requests move them.
- Fix pull requests, much like Dependabot: with `SENTINEL_FIX_MODE=pr` the
  scheduled run on GitHub Actions or Azure DevOps opens one pull request per
  kind of fix, and keeps it up to date. It changes UI5 versions in
  `ui5.yaml`, bootstrap URLs and `manifest.json`, Node.js versions in
  `"engines.node"`, `.nvmrc` and `.node-version`, and removes npm overrides
  that are no longer needed. `SENTINEL_FIX_MODE=apply` changes the scanned
  files instead, and `SENTINEL_FIX_GROUPS` chooses which kinds of fix are
  made. Findings that can be fixed carry a `fix` in the JSON report.
- Add contributing guide, code of conduct, security policy, issue and pull
  request templates, and Dependabot updates for GitHub Actions and the dev
  container.
- Releases have a changelog. `CHANGELOG.md` ships in the npm package, and
  each version's entry is its GitHub release notes.

## 0.3.3 - 2026-10-19

- The npm-audit check reports overrides in `package.json` that are no longer
  needed, as info: overrides whose package every dependent already allows at
  the installed version, and overrides for packages that are not installed.
- When only the lockfile stands between a vulnerable package and its fix, the
  action says so: `npm audit fix` is enough and no override is needed.

## 0.3.2 - 2026-10-19

- The npm-audit check names the direct dependency each vulnerable package
  comes in through (`details.introducedBy` in the JSON report). Its action
  depends on the version ranges along the way: `npm audit fix`, raising the
  version in `package.json`, updating the direct dependency, adding an
  override, or waiting for a release of the package that bundles it.

## 0.3.1 - 2026-10-19

- Published to npm as `@cbs-consulting/stack-sentinel`. Pipelines install
  `@cbs-consulting/stack-sentinel@latest` instead of
  `github:cbs-consulting/stack-sentinel#stable`.
- Releases are staged on npm and go live only when a maintainer approves them.
- The license is Apache-2.0.
- No changes to the checks.

## 0.3.0 - 2026-10-19

- First release.
