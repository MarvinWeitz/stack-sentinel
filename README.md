<div align="center">

<img src=".github/assets/logo.svg" alt="" width="120" />

# stack-sentinel

**Know when a project's stack goes out of support, before it breaks.**

[![npm](https://img.shields.io/npm/v/@cbs-consulting/stack-sentinel?logo=npm)](https://www.npmjs.com/package/@cbs-consulting/stack-sentinel)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-none-0F4C5C)](package.json)

</div>

---

stack-sentinel scans a project for outdated or unsupported versions of UI5,
Node.js, Cloud Foundry runtimes and CAP, checks its npm packages for known
vulnerabilities, and reports the findings to Microsoft Teams or any JSON
endpoint. It is built to run on a schedule, so projects with no new commits
are still monitored, and nobody has to remember to look.

No dependencies; needs Node.js 22 or newer.

## 🚀 Quick start

```sh
npx @cbs-consulting/stack-sentinel@latest <path-to-project>

# notify a Teams channel when there is at least a warning
SENTINEL_WEBHOOK_URL=https://... npx @cbs-consulting/stack-sentinel@latest . --project "Customer A / Orders app"

# send the raw JSON report to a customer-owned endpoint instead
npx @cbs-consulting/stack-sentinel@latest . --webhook https://customer.example/hooks/sentinel --format json
```

To use it often, install it once with `npm install -g @cbs-consulting/stack-sentinel`
and run `stack-sentinel` instead.

Run `stack-sentinel --help` for the flags and see [Settings](#settings) for
everything that can be changed. Exit code is `1` when a finding
reaches `--fail-on` (default `error`), `2` when the tool itself fails.

To run it every week in a project's pipeline, copy one of the
[examples](#scheduling) and set the webhook address as a secret. Nothing in
the file has to be edited.

<a id="checks"></a>

## 🔍 Checks

| Check | What it reports | Compared against |
| --- | --- | --- |
| [`ui5-version`](docs/CHECKS.md#ui5-version) | UI5 versions out of maintenance, not long-term maintenance, or removed from the CDN | SAP's UI5 version overview |
| [`node-version`](docs/CHECKS.md#node-version) | Node.js versions past or near end of life | Node.js release schedule |
| [`cf-node-version`](docs/CHECKS.md#cf-node-version) | Node.js apps on Cloud Foundry asking for a version the buildpack no longer ships | Cloud Foundry Node.js buildpack |
| [`cap-version`](docs/CHECKS.md#cap-version) | CAP packages on a major version SAP no longer supports | npm registry |
| [`npm-audit`](docs/CHECKS.md#npm-audit) | Installed npm packages with known vulnerabilities | npm audit service |

Every finding has a severity (`error`, `warn`, `info` or `ok`), and those that
call for a change say what to change, for example "Set framework.version to
1.148.12". [docs/CHECKS.md](docs/CHECKS.md) describes where each check looks
and when it reports what.

By default every check runs; `stack-sentinel --list-checks` prints their ids.
Use the `checks` setting to run only some, or `skipChecks` to leave some out
(see [Settings](#settings) for the flag, environment variable and config key).
An unknown id, or a selection that leaves nothing to run, stops the run with
exit code `2`. The report lists the checks that ran and the ones skipped.

<a id="settings"></a>

## ⚙️ Settings

Nothing about the scanned project's layout or the network is fixed: every
value below has a default and can be overridden. Precedence, highest first:

1. command-line flag
2. environment variable
3. config file: `sentinel.config.json` in the scanned project, or the file
   named by `--config` / `SENTINEL_CONFIG`
4. shared config, if one is set (see [Shared config](#shared-config))
5. default

An empty environment variable counts as not set, and so does an unexpanded
Azure DevOps variable such as `$(NAME)`. An invalid value stops the
run with exit code `2`. `stack-sentinel --show-config` prints every setting,
its value and where it came from.

| Config key | Flag | Environment variable | Default | Meaning |
| --- | --- | --- | --- | --- |
| `project` | `--project` | `SENTINEL_PROJECT` |  | Name shown in reports (default: name of the scanned folder) |
| `checks` | `--checks` | `SENTINEL_CHECKS` |  | Run only these checks |
| `skipChecks` | `--skip-checks` | `SENTINEL_SKIP_CHECKS` | `(none)` | Run all checks except these |
| `output` | `--output` | `SENTINEL_OUTPUT` |  | Write the JSON report to this file |
| `webhook` | `--webhook` | `SENTINEL_WEBHOOK_URL` |  | URL the report is posted to (not read from the config file, because it is a credential) |
| `heartbeat` | `--heartbeat` | `SENTINEL_HEARTBEAT_URL` |  | URL that gets a short status message after every completed run (not read from the config file) |
| `heartbeatMethod` |  | `SENTINEL_HEARTBEAT_METHOD` | `POST` | How the heartbeat is sent; GET carries no status message, for services that only accept GET: `POST`, `GET` |
| `runUrl` | `--run-url` | `SENTINEL_RUN_URL` |  | Link to this pipeline run, shown on the card (default: detected on GitHub Actions and Azure DevOps) |
| `repositoryUrl` | `--repository-url` | `SENTINEL_REPOSITORY_URL` |  | Link to the scanned repository, shown on the card (default: detected on GitHub Actions and Azure DevOps) |
| `format` | `--format` | `SENTINEL_FORMAT` | `teams` | Webhook payload: `teams`, `json` |
| `notifyOn` | `--notify-on` | `SENTINEL_NOTIFY_ON` | `warn` | Notify at or above this severity: `ok`, `info`, `warn`, `error` |
| `failOn` | `--fail-on` | `SENTINEL_FAIL_ON` | `error` | Exit 1 at or above this severity: `ok`, `info`, `warn`, `error`, `never` |
| `timeoutSeconds` | `--timeout` | `SENTINEL_TIMEOUT_SECONDS` | `30` | Timeout for each HTTP request |
| `scan.exclude` | `--exclude` | `SENTINEL_SCAN_EXCLUDE` | `node_modules,.git,dist,build,gen,coverage,.cache` | Folder names that are not scanned (replaces the default list) |
| `scan.maxDepth` | `--max-depth` | `SENTINEL_SCAN_MAX_DEPTH` | `8` | How many folder levels deep to scan |
| `notify.maxFindings` |  | `SENTINEL_NOTIFY_MAX_FINDINGS` | `25` | Most findings listed in one Teams card |
| `fix.mode` | `--fix` | `SENTINEL_FIX_MODE` | `off` | Fix what can be fixed safely: apply changes the scanned files, pr opens a pull request per kind of fix (see [Fix pull requests](#fix-pull-requests)): `off`, `apply`, `pr` |
| `fix.groups` | `--fix-groups` | `SENTINEL_FIX_GROUPS` | `ui5,node,npm-overrides` | Kinds of fix to make, one pull request each: ui5 (UI5 versions), node (Node.js versions), npm-overrides (npm overrides no longer needed) |
| `fix.on` | `--fix-on` | `SENTINEL_FIX_ON` | `info` | Fix findings at or above this severity: `ok`, `info`, `warn`, `error` |
| `fix.token` |  | `SENTINEL_FIX_TOKEN` |  | Token that opens the pull requests (default: `GITHUB_TOKEN` or `SYSTEM_ACCESSTOKEN`; not read from the config file) |
| `fix.autoMerge` |  | `SENTINEL_FIX_AUTO_MERGE` | `off` | Let fix pull requests merge by themselves once their checks pass: patch for those that only move to a newer patch of the same version, all for every one: `off`, `patch`, `all` |
| `fix.branchPrefix` |  | `SENTINEL_FIX_BRANCH_PREFIX` | `stack-sentinel/` | Start of the branch names of fix pull requests |
| `fix.maxPullRequests` |  | `SENTINEL_FIX_MAX_PULL_REQUESTS` | `5` | Most fix pull requests open at the same time |
| `ui5.feed` |  | `SENTINEL_UI5_FEED` | `https://ui5.sap.com/versionoverview.json` | Version overview feed: a URL, or a path to a downloaded copy |
| `ui5.requireLts` |  | `SENTINEL_UI5_REQUIRE_LTS` | `true` | Warn about versions that are not long-term maintenance |
| `ui5.warnDays` |  | `SENTINEL_UI5_WARN_DAYS` | `180` | Warn this many days before an end date |
| `ui5.maintenanceDate` |  | `SENTINEL_UI5_MAINTENANCE_DATE` | `eomm` | End-of-maintenance date to use: eomm is the SAP BTP date shown on the version overview page, eom the feed's second date: `eomm`, `eom`, `earliest` |
| `ui5.cdnHosts` |  | `SENTINEL_UI5_CDN_HOSTS` | `ui5.sap.com,sapui5.hana.ondemand.com,openui5.hana.ondemand.com,sdk.openui5.org` | Hosts recognised in bootstrap URLs (replaces the default list) |
| `ui5.yamlPattern` |  | `SENTINEL_UI5_YAML_PATTERN` | `(^\|/)ui5([-.][\w.-]+)?\.ya?ml$` | Files read as UI5 tooling config (regex on the relative path) |
| `ui5.htmlPattern` |  | `SENTINEL_UI5_HTML_PATTERN` | `\.html?$` | Files searched for a bootstrap URL (regex on the relative path) |
| `ui5.testPagePattern` |  | `SENTINEL_UI5_TEST_PAGE_PATTERN` | `\.qunit\.html?$` | HTML files treated as local test pages, reported as info at most (regex on the relative path) |
| `ui5.testPageContent` |  | `SENTINEL_UI5_TEST_PAGE_CONTENT` | `sap/ushell/bootstrap/sandbox\d*\.js` | HTML files containing this are treated as local test pages, e.g. a launchpad sandbox (regex on the file content) |
| `ui5.manifestPattern` |  | `SENTINEL_UI5_MANIFEST_PATTERN` | `(^\|/)manifest\.json$` | Files read as app manifests (regex on the relative path) |
| `node.feed` |  | `SENTINEL_NODE_FEED` | `https://raw.githubusercontent.com/nodejs/Release/main/schedule.json` | Node.js release schedule: a URL, or a path to a downloaded copy |
| `node.requireLts` |  | `SENTINEL_NODE_REQUIRE_LTS` | `true` | Warn when only non-LTS Node.js releases are allowed |
| `node.warnDays` |  | `SENTINEL_NODE_WARN_DAYS` | `180` | Warn this many days before end of life |
| `node.packagePattern` |  | `SENTINEL_NODE_PACKAGE_PATTERN` | `(^\|/)package\.json$` | Files read for "engines.node" (regex on the relative path) |
| `node.ciPattern` |  | `SENTINEL_NODE_CI_PATTERN` | `(^\|/)(\.github/workflows/[^/]+\|azure-pipelines[^/]*\|\.azure-pipelines/[^/]+)\.ya?ml$` | CI pipeline files read for the Node.js version they set up (regex on the relative path) |
| `node.containerPattern` |  | `SENTINEL_NODE_CONTAINER_PATTERN` | `(^\|/)(Dockerfile\|Containerfile)([.-][\w.-]+)?$` | Dockerfiles read for the node image they build on (regex on the relative path) |
| `node.versionFilePattern` |  | `SENTINEL_NODE_VERSION_FILE_PATTERN` | `(^\|/)\.(nvmrc\|node-version)$` | Files read as Node.js version files (regex on the relative path) |
| `cf.feed` |  | `SENTINEL_CF_FEED` | `https://raw.githubusercontent.com/cloudfoundry/nodejs-buildpack/master/manifest.yml` | Manifest of the Cloud Foundry Node.js buildpack: a URL, or a path to a downloaded copy |
| `cf.warnDays` |  | `SENTINEL_CF_WARN_DAYS` | `180` | Warn this many days before a Node.js line leaves the buildpack |
| `cf.descriptorPattern` |  | `SENTINEL_CF_DESCRIPTOR_PATTERN` | `(^\|/)(mta\.yaml\|manifest\.ya?ml)$` | Files read as Cloud Foundry deployment descriptors (regex on the relative path) |
| `cf.nodeModuleTypes` |  | `SENTINEL_CF_NODE_MODULE_TYPES` | `nodejs,approuter.nodejs,javascript.nodejs,hdb` | MTA module types that run on the Node.js buildpack (replaces the default list) |
| `cap.registry` |  | `SENTINEL_CAP_REGISTRY` | `https://registry.npmjs.org` | npm registry to ask about CAP packages: a URL, or a folder with downloaded copies |
| `cap.packages` |  | `SENTINEL_CAP_PACKAGES` | `@sap/cds,@sap/cds-dk,@sap/cds-mtxs` | Packages whose major version is checked (replaces the default list) |
| `cap.warnDays` |  | `SENTINEL_CAP_WARN_DAYS` | `180` | Warn this many days before the estimated end of life of the previous major |
| `cap.maintenanceMonths` |  | `SENTINEL_CAP_MAINTENANCE_MONTHS` | `12` | How long the previous major is maintained after a new one is released |
| `cap.packagePattern` |  | `SENTINEL_CAP_PACKAGE_PATTERN` | `(^\|/)package\.json$` | Files read for CAP dependencies (regex on the relative path) |
| `audit.registry` |  | `SENTINEL_AUDIT_REGISTRY` | `https://registry.npmjs.org` | npm registry to ask about known vulnerabilities |
| `audit.lockfilePattern` |  | `SENTINEL_AUDIT_LOCKFILE_PATTERN` | `(^\|/)(package-lock\|npm-shrinkwrap)\.json$` | Lockfiles whose installed packages are checked (regex on the relative path) |
| `audit.reportFrom` |  | `SENTINEL_AUDIT_REPORT_FROM` | `moderate` | Vulnerabilities below this advisory severity are not reported: `info`, `low`, `moderate`, `high`, `critical` |
| `audit.warnAt` |  | `SENTINEL_AUDIT_WARN_AT` | `high` | Advisory severity from which a vulnerability is a warning (below: info): `info`, `low`, `moderate`, `high`, `critical` |
| `audit.errorAt` |  | `SENTINEL_AUDIT_ERROR_AT` | `critical` | Advisory severity from which a vulnerability is an error: `info`, `low`, `moderate`, `high`, `critical` |

List values are comma-separated in flags and environment variables, and JSON
arrays in the config file. Example config:

```json
{
  "project": "Customer A / Orders app",
  "skipChecks": [],
  "scan": { "exclude": ["node_modules", ".git", "dist", "vendor"] },
  "ui5": {
    "requireLts": true,
    "warnDays": 90,
    "cdnHosts": ["ui5.sap.com", "cdn.customer.example"],
    "manifestPattern": "^app/[^/]+/webapp/manifest\\.json$"
  }
}
```

Notes on the UI5 settings:

- `ui5.feed` can point to a downloaded copy of the feed, for runners that
  cannot reach `ui5.sap.com`.
- `ui5.maintenanceDate`: the feed carries two end-of-maintenance dates per
  version. `eomm` (the default) is the "End of Maintenance" SAP shows on the
  version overview page for SAP BTP. `eom` is a second, often much later date
  that appears to apply to on-premise installations. `earliest` uses whichever
  comes first. The feed's status text decides whether a version is reported
  as out of maintenance (an error); the date drives the advance warning, and
  a date that has passed while the status still says "Maintenance" is a
  warning.
- `ui5.probes` (config file only) is a list of `{ "name", "url" }` for systems
  that host their own UI5 library. Each URL must return JSON with a top-level
  `version` field. Apps on SAP BTP do not need one.

<a id="shared-config"></a>

## 🌐 Shared config

A shared config holds settings for many projects in one place. Change it
there, and every project that points at it follows on its next run, without
anyone editing those projects.

It is an ordinary config file (see
[`examples/shared-config.json`](examples/shared-config.json)), hosted where
the pipelines can read it. Tell a project where it is in one of three ways:

| Where | How |
| --- | --- |
| Command line | `--shared-config <url or file>` |
| Environment variable | `SENTINEL_SHARED_CONFIG=<url or file>` |
| The project's config file | `"sharedConfig": "<url or file>"` (a file path is relative to that config file) |

Its values rank below the project's own settings and above the defaults, so
a project can still override whatever it needs to. `--show-config` names the
shared config in use and marks each value that came from it as `[shared]`.

- **If it cannot be read, the run stops** with exit code `2`. Scanning with a
  different policy than intended would be worse than a visible failure.
- **The webhook and heartbeat addresses are never read from it**, as with the
  project's config file.
- **Lists replace, they do not combine.** A project that sets
  `scan.exclude` gets its own list, not the shared one plus its own.
- **A shared config cannot point at another one.**
- Use different files for different groups of projects by pointing them at
  different addresses.

Whoever can change the shared file changes how every project that uses it is
scanned, including where the checks get their data from. Host it somewhere
with the same care as the tool itself.

<a id="scheduling"></a>

## ⏰ Running on a schedule

[`examples/`](examples/) has a GitHub Actions workflow and an Azure DevOps
pipeline. Both run weekly without needing new commits, and both are set up so
that nothing in the file has to be edited: everything is configured where the
platform keeps its variables.

| | GitHub | Azure DevOps |
| --- | --- | --- |
| Where | Settings → Secrets and variables → Actions | Pipelines → the pipeline → Edit → Variables |
| Webhook and heartbeat addresses | Secrets `SENTINEL_WEBHOOK_URL`, `SENTINEL_HEARTBEAT_URL` | Secret variables with the same names |
| Any other setting | A variable named like its environment variable, e.g. `SENTINEL_NOTIFY_ON` | The same |

On GitHub, variables defined for a whole organization work too, which sets a
value for all of a customer's repositories at once. The GitHub workflow picks
up every variable whose name starts with `SENTINEL_`, so settings added to
the tool later need no change to the workflow file either.

This repository runs the GitHub example on itself, unchanged
(`.github/workflows/stack-sentinel.yml`), and a test keeps the two files
identical.

GitHub disables scheduled workflows in public repositories after 60 days
without repository activity. That rule applies to public repositories only,
so customer repositories, which are normally private, keep their schedule.

### What the card links to

On GitHub Actions and Azure DevOps the tool detects the pipeline run and the
repository it scanned, and the Teams card gets "Open pipeline run" and "Open
repository" buttons. The JSON report carries them as `links`. On other CI
systems, set `SENTINEL_RUN_URL` and `SENTINEL_REPOSITORY_URL`.

When a shared config is used, its address is printed in the output, shown at
the bottom of the card, and included in the report as `sharedConfig`.

### Testing a new pipeline

By default a card is only sent when there is at least a warning, so a healthy
project sends nothing. To see a card from a first run, add the variable
`SENTINEL_NOTIFY_ON` with the value `ok`, start the pipeline by hand, and
remove the variable afterwards. The last lines of the tool's output say
whether a notification was sent, and if not, why: no webhook address reached
the tool (usually a missing or misnamed secret), or the status was below the
threshold.

<a id="fix-pull-requests"></a>

## 🔧 Fix pull requests

With `SENTINEL_FIX_MODE=pr` the scheduled run also opens pull requests that
fix what can be fixed safely, much like Dependabot. Only edits that change one
version in one file are made:

| Check | What is changed |
| --- | --- |
| `ui5-version` | `framework.version` and the fiori-tools-proxy `ui5.version` in `ui5.yaml`, the version in CDN bootstrap URLs (a version is added where none is set), and `"sap.platform.cf".ui5VersionNumber` in `manifest.json` (added where it is missing). A fiori-tools-proxy without a version gets the one the app builds with (`framework.version` in a `ui5*.yaml` of the same folder), or else the recommended one |
| `node-version`, `cf-node-version` | The Node.js version in CI pipelines (`setup-node`, `NodeTool`, `UseNode`) and in `FROM node:<tag>` is moved to the recommended major. `.nvmrc` and `.node-version` are set to the recommended Node.js major, `"engines.node"` to `^<major>`, a plain lower bound such as `>=18` is raised, an exact version on Cloud Foundry (`22.11.0`) becomes a range the buildpack can stage (`22.x`), and a Cloud Foundry app that declares none gets `"engines.node"` for the line the buildpack keeps longest. Where the two checks disagree, the version the Cloud Foundry buildpack ships wins |
| `npm-audit` | Overrides in `package.json` that are unused or no longer needed are removed |

Nothing else is changed automatically: not `minUI5Version`, which states
which versions an app supports, not CAP major versions, which need a
migration, not a missing `"engines.node"` outside Cloud Foundry, which would be a guess, and not
vulnerable packages, which need a lockfile update.

- **One pull request per kind of fix**, on a branch whose name never changes
  (`stack-sentinel/ui5`, `stack-sentinel/node`, `stack-sentinel/npm-overrides`). Each run updates it
  while the findings remain, for example to a newer patch, and closes it when
  they are gone.
- **Closing a pull request without merging** skips those versions: the next
  run opens a new one only when there is a newer version to move to.
- **The edits are made to the default branch** as it is at the time of the
  run. A change whose file no longer holds the version the scan saw is left
  out.
- **Choose what is fixed** with `fix.groups`: `SENTINEL_FIX_GROUPS=ui5`
  fixes UI5 versions only, and leaves npm overrides to be reported. A pull
  request of a kind that is turned off is left open as it is.
- **Workflow files on GitHub** (`.github/workflows/*.yml`) can only be
  changed by a token with the "Workflows" permission, which `GITHUB_TOKEN`
  cannot have. Without one, they are left out of the pull request, which
  says so, and the rest goes through.
- **Auto-merge** is off by default. `SENTINEL_FIX_AUTO_MERGE=patch` turns it
  on for pull requests that only move to newer patches (UI5 1.148.12 to
  1.148.13), `all` for every one. The pull request is then merged once its
  required checks pass, never before: on GitHub this needs "Allow
  auto-merge" and a branch protection rule with required checks, and since
  checks do not start for pull requests opened with `GITHUB_TOKEN`, a
  `SENTINEL_FIX_TOKEN`. On Azure DevOps it sets the pull request to complete
  by itself once its branch policies pass. If it cannot be turned on, the
  pull request stays open and the output says why.
- **At most `fix.maxPullRequests`** (default 5) are open at a time.
- **Moving to a new release line** (UI5 1.120 to 1.148, Node.js 20 to 24) is a normal pull
  request too. The project's own checks on the pull request are what show
  whether the app still works.
- The links to the pull requests are on the Teams card and in the JSON report
  (`pullRequests`).
- `SENTINEL_FIX_MODE=apply` (or `--fix apply`) only changes the files in the
  scanned folder, for a local run or a pipeline of your own.

| | GitHub Actions | Azure DevOps (Azure Repos) |
| --- | --- | --- |
| Turn it on | Variable `SENTINEL_FIX_MODE` = `pr` | Pipeline variable `SENTINEL_FIX_MODE` = `pr` |
| Allow it once | Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" | Project settings → Repositories → the repository → Security → the project's build service: "Contribute" and "Contribute to pull requests" |
| Token | The workflow's own `GITHUB_TOKEN`; nothing to set | `$(System.AccessToken)`, mapped in the example |
| The pull request's checks | GitHub starts no workflows for pull requests opened with `GITHUB_TOKEN`. To have them run, set the secret `SENTINEL_FIX_TOKEN` to a GitHub App token or a fine-grained personal access token with "Contents" and "Pull requests" write access | Run as usual |
| An open pull request after the default branch moved | Rebuilt on top of the default branch | Gets a commit on top, because pipelines may not force-push |

The examples already carry the permissions and the token mapping, so turning
it on needs no change to the pipeline file.

<a id="heartbeat"></a>

## 💓 Heartbeat

A project that reports nothing looks the same as a project whose pipeline has
stopped running. To tell them apart, set `SENTINEL_HEARTBEAT_URL`. After
every completed run the tool posts a short status message there:

```json
{
  "tool": "stack-sentinel",
  "toolVersion": "0.3.0",
  "project": "Customer A / Orders app",
  "generatedAt": "2026-10-12T06:17:03.000Z",
  "status": "warn",
  "summary": { "error": 0, "warn": 2, "info": 1, "ok": 4 },
  "checks": { "run": ["ui5-version", "node-version"], "skipped": [] }
}
```

Point it at a service that expects a regular ping and alerts when one is
missing (a "dead man's switch"); give each project its own address there.
The tool itself stays stateless: it only sends the ping, the service notices
the gap.

- The heartbeat is sent whatever the findings are. It means "this project was
  scanned", not "this project is fine".
- It is sent last, and only if the report was delivered. If the webhook
  rejects the report, no heartbeat goes out, so the gap shows up.
- It contains no findings, only counts.
- If the heartbeat cannot be delivered, the run exits with code `2`.
- It is sent as a POST with the message above. Some services only accept
  GET, among them Uptime Kuma 1.x; for those set `SENTINEL_HEARTBEAT_METHOD`
  to `GET` (no message is sent then, only the ping). Uptime Kuma 2.x accepts
  POST.

<a id="releases"></a>

## 📌 Releases

stack-sentinel is published to npm as
[`@cbs-consulting/stack-sentinel`](https://www.npmjs.com/package/@cbs-consulting/stack-sentinel).
What follows the package name chooses the release:

| Install | What you get | Use it for |
| --- | --- | --- |
| `@cbs-consulting/stack-sentinel@latest` | The latest release; changes when a new one is published | Most projects, and any project nobody will maintain: the tool stays current without anyone editing the pipeline |
| `@cbs-consulting/stack-sentinel@0.3.0` | Exactly that release, until someone changes the version | Projects where every change to the pipeline must be deliberate |

Write `@latest` out with `npx`. Without it, `npx` can keep using a copy it
downloaded earlier, which matters on build agents that are not wiped
between runs.

Releases are made by the "Release" workflow in the Actions tab, which

1. runs the tests and the live feed tests on the commit to release,
2. requires a higher version in `package.json` than the latest one on npm,
3. stages it on npm, with a provenance statement that ties the package to
   this repository and commit, and
4. publishes that commit as the GitHub release `v<version>`, with the
   version's entry in [`CHANGELOG.md`](CHANGELOG.md) as the release notes.

Every change goes into the "Unreleased" section of `CHANGELOG.md` in its
pull request. The "Changelog entry" check fails on pull requests that do not
change `CHANGELOG.md`; give those that change nothing a user notices (chores,
CI, typos) the label "no changelog". To prepare a release, raise the version in `package.json` and
rename "Unreleased" to `<version> - <date>`. The tests fail while the version
in `package.json` has no entry, so neither the pull request nor the release
can go through without one.

A staged version is not installable yet. It goes live, and becomes
`@latest`, when a maintainer approves it with two-factor authentication: on
npmjs.com under the package's staged versions, or with
`npm stage approve <stage-id>`. Every release that reaches customer
pipelines has therefore been looked at by a person.

The workflow has a "dry run" option that does steps 1 and 2 and changes
nothing.

`stack-sentinel --version` prints the running version. Every report and
heartbeat carries it as `toolVersion`, and the Teams card shows it, so you can
see which release each project is on.

<a id="contributing"></a>

## 🛠️ Contributing

There is nothing to install: clone the repo and run `npm test` with Node.js 22
or newer. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to propose a change,
and [SECURITY.md](SECURITY.md) how to report a vulnerability privately.

### Adding a check

Add a module in `src/checks/` exporting `{ id, run(ctx) }` that returns
findings, and register it in `src/checks/index.js`. A finding is
`{ check, severity, source, file?, version?, message, details? }` with
severity `ok`, `info`, `warn` or `error`. Describe it in
[docs/CHECKS.md](docs/CHECKS.md) and add it to the table under
[Checks](#checks).

### Testing

```sh
npm test            # unit and end-to-end tests, no outside network needed
npm run test:live   # checks SAP's real feed still has the format the tool expects
```

- **Unit tests** (`test/ui5.test.js`, `test/node.test.js`,
  `test/cf-node.test.js`, `test/cap.test.js`, `test/npm-audit.test.js`,
  `test/pipeline.test.js`, `test/settings.test.js`) cover the version rules and the settings, against
  trimmed copies of the feeds in `test/fixtures/`.
- **End-to-end tests** (`test/cli.test.js`) run the real command against a
  local server that plays SAP's feed and the webhook receiver, and check the
  output, the exit code and what was posted.
- **Live feed test** (`live/feed.live.js`) downloads the real feeds (SAP's UI5
  version overview, the Node.js release schedule, the Cloud Foundry buildpack
  manifest, the npm registry and its vulnerability service) and fails if a field,
  status text or date format is no longer what the tool understands.

GitHub Actions runs `npm test` on every push and pull request, on Node.js 22,
24 and 26, and the live feed test every Monday and on demand.

A git hook can run the tests locally before each push as well. Enable it once
per clone:

```sh
npm run hooks
```

To try a notification by hand, point `--webhook` at a Teams workflow URL, or
at a request inspector to see the payload:

```sh
stack-sentinel test/fixtures/app --webhook https://<your-endpoint>
```

### Decisions

[`docs/DECISIONS.md`](docs/DECISIONS.md) records why the tool works the way it
does, what was deliberately left out, and what is still unverified.

## 📄 License

Copyright © 2026 cbs Corporate Business Solutions Unternehmensberatung GmbH.
Licensed under the [Apache License 2.0](LICENSE).

<sub>SAP, SAP BTP, SAPUI5 and SAP Fiori are trademarks of SAP SE. Node.js is a trademark of the OpenJS Foundation. This project is not affiliated with or endorsed by SAP or the OpenJS Foundation.</sub>
