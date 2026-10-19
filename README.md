# stack-sentinel

Scans a project for outdated or unsupported stack versions and reports the
findings to a webhook (Microsoft Teams or any JSON endpoint). It is built to
run on a schedule, so projects with no new commits are still monitored.

No dependencies; needs Node.js 22 or newer.

## Usage

```sh
npx github:cbs-consulting/stack-sentinel#stable <path-to-project>

# notify a Teams channel when there is at least a warning
SENTINEL_WEBHOOK_URL=https://... npx github:cbs-consulting/stack-sentinel#stable . --project "Customer A / Orders app"

# send the raw JSON report to a customer-owned endpoint instead
npx github:cbs-consulting/stack-sentinel#stable . --webhook https://customer.example/hooks/sentinel --format json
```

Run `stack-sentinel --help` for the flags and see [Settings](#settings) for
everything that can be changed. Exit code is `1` when a finding
reaches `--fail-on` (default `error`), `2` when the tool itself fails.

## Choosing which checks run

By default every check runs; `stack-sentinel --list-checks` prints their ids.
Use the `checks` setting to run only some, or `skipChecks` to leave some out
(see [Settings](#settings) for the flag, environment variable and config key).

An unknown id, or a selection that leaves nothing to run, stops the run with
exit code `2`. The report lists the checks that ran and the ones skipped.

## Checks

### `ui5-version`

Compares the UI5 versions a project uses with SAP's version overview feed
(`https://ui5.sap.com/versionoverview.json`).

| Where it looks | Meaning |
| --- | --- |
| `ui5.yaml` → `framework.version` | Version used for local development and builds |
| `ui5.yaml` → `fiori-tools-proxy` → `ui5.version` | Version the SAP Fiori tools preview loads; without one it loads the latest release (reported as info) |
| `*.html` → CDN bootstrap URL | Version loaded at runtime from the SAP CDN |
| `manifest.json` → `"sap.platform.cf".ui5VersionNumber` | Version SAP Build Work Zone loads for the app on SAP BTP (`1.136.5`, or `1.136.x` for the latest patch) |
| `manifest.json` → `minUI5Version` | Lower bound only, so never worse than info |
| `ui5.probes` in the config | Version reported by a running system |

| Severity | When |
| --- | --- |
| error | Out of maintenance, never released, unknown, or (CDN) patch removed / past end of cloud provisioning |
| warn | In maintenance but not a long-term maintenance version; end of maintenance or CDN removal within `ui5.warnDays`; no version pinned, so the latest release is loaded (info when `ui5.requireLts` is `false`) |
| info | A newer patch exists |

The feed's `lts` flag alone is not trusted: a version must also be in
maintenance.

Two kinds of findings are reported as info at most, because they do not
describe what a deployed app runs on: `minUI5Version`, which is only the
oldest version an app says it supports, and local test pages. A page counts
as a local test page when its path matches `ui5.testPagePattern` (QUnit pages
by default) or its content matches `ui5.testPageContent` (by default, pages
that load SAP's launchpad sandbox, such as CAP's `app/fiori-apps.html` and the
`flpSandbox.html` that SAP Fiori tools generate).

The text output and the Teams card show one line per problem with the files it
affects; the JSON report keeps one finding per file.

Each finding that calls for a change says what to change, in the place the
version was found: for example "Set framework.version to 1.148.12" for
`ui5.yaml`, or "Raise minUI5Version to 1.148.0" for a manifest. The target
is the long-term maintenance version whose maintenance runs longest, never a
downgrade; why that version is named once at the end of the report. In the
JSON report each such finding carries `action`, `recommendation` and, with
the bare version, `details.recommended`.

On SAP BTP, an app without `ui5VersionNumber` runs on the latest SAPUI5
release. A BTP app is recognised by `sap.cloud` or `sap.platform.cf` in its
manifest.

### `node-version`

Compares the Node.js versions a project allows with the official Node.js
release schedule
(`https://raw.githubusercontent.com/nodejs/Release/main/schedule.json`).

| Where it looks | Meaning |
| --- | --- |
| `package.json` → `engines.node` | The range of Node.js versions the project accepts; on Cloud Foundry the buildpack picks the runtime from it |
| `.nvmrc`, `.node-version` | The version used for local development and CI |

| Severity | When |
| --- | --- |
| error | Every version the range allows is past end of life |
| warn | The range still starts at a version past end of life (`>=18`); all allowed versions reach end of life within `node.warnDays`; only a non-LTS release is allowed, or the latest release is followed (`node`), unless `node.requireLts` is `false`; the version text cannot be understood |
| info | The newest allowed version is in maintenance and a newer long-term support release exists; the root `package.json` declares no Node.js version |

A range is judged by the best version it allows, so `>=22` stays fine as long
as some supported release satisfies it. This check knows only Node.js's own
dates; which versions Cloud Foundry still offers is covered by
`cf-node-version`.

### `cf-node-version`

Checks that Node.js apps deployed to Cloud Foundry ask for a version the
Node.js buildpack ships. It reads the buildpack's manifest
(`https://raw.githubusercontent.com/cloudfoundry/nodejs-buildpack/master/manifest.yml`),
which lists the Node.js versions included and the date each version line is
removed. SAP BTP uses this buildpack.

The check applies only to projects with a deployment descriptor:

| Where it looks | Meaning |
| --- | --- |
| `mta.yaml` → modules of type `nodejs`, `approuter.nodejs`, `javascript.nodejs`, `hdb`, or with a Node.js buildpack | The Node.js apps that get deployed |
| `manifest.yml` → `applications` | The same, for projects pushed with `cf push` |
| `engines.node` in each such module's `package.json` | The version Cloud Foundry is asked for |

When a module's path is build output that is not in the repository (CAP's
`gen/srv`), the closest `package.json` above it is used.

| Severity | When |
| --- | --- |
| error | The range matches no version the buildpack ships, so staging fails: a removed line (`^20`), a line not shipped yet (`26`), or an exact version (`22.11.0`; the buildpack keeps only the newest patch of each line) |
| warn | The version the range resolves to leaves the buildpack within `cf.warnDays` |
| info | No version is declared, so the buildpack default applies |

The comparison is always against the newest buildpack release. A platform
region can run a slightly older release, so a finding can appear a little
before it takes effect there.

### `cap-version`

Checks that the CAP packages of a Node.js project are on a major version SAP
still supports. It asks the npm registry (`https://registry.npmjs.org`): SAP
marks every CAP version it no longer supports as deprecated there, and the
registry also gives the current major version and its release date.

| Where it looks | Meaning |
| --- | --- |
| `package.json` → `dependencies` and `devDependencies` | The version range of `@sap/cds`, `@sap/cds-dk` and `@sap/cds-mtxs` (`cap.packages`) |
| `package-lock.json`, in the same folder or above | The exact installed version, which is used instead of the range when present |

Without a lockfile, the newest version matching the range is judged, since
that is what a fresh install would get.

| Severity | When |
| --- | --- |
| error | SAP has marked the version as unsupported on npm; or it is two or more major versions behind the current one |
| warn | It is on the previous major and the estimated end of life is within `cap.warnDays`, or has passed |
| info | It is on the previous major, which gets critical fixes only |

The end of life of the previous major is an estimate: CAP's release policy
maintains it for at most twelve months (`cap.maintenanceMonths`) after a new
major is released, and the registry has no exact date. CAP Java is not
covered.

### `npm-audit`

Checks the packages installed through `package-lock.json` (or
`npm-shrinkwrap.json`) for known vulnerabilities. It asks the same service
`npm audit` uses, on the npm registry, so its results match `npm audit`. It
reads the lockfile only; nothing is installed. Projects without an npm
lockfile (for example with yarn or pnpm) are not checked.

| Severity | When |
| --- | --- |
| error | A vulnerability with advisory severity `critical` (`audit.errorAt`) |
| warn | Advisory severity `high` (`audit.warnAt`) |
| info | Advisory severity `moderate`, or any severity in a package used only for development |
| ok | No known vulnerabilities of `moderate` severity or above (`audit.reportFrom`) |

There is one finding per vulnerable package, naming the worst advisory and
the first version that fixes all of them. The advisories, with links, are in
the JSON report under `details.advisories`. `npm audit` attributes a
dependency's vulnerability to the package that pulls it in as well; this
check names only the package that is actually vulnerable, so its counts can
be lower.

## Settings

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

## Shared config

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

## Scheduling

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

## Heartbeat

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

## Releases

There are two ways to install, chosen by what follows the `#`:

| Install from | What you get | Use it for |
| --- | --- | --- |
| `#stable` | The latest tested release; changes when a new release is promoted | Most projects, and any project nobody will maintain: the tool stays current without anyone editing the pipeline |
| `#v0.2.0` (a release tag) | Exactly that release, until someone changes the tag | Projects where every change to the pipeline must be deliberate |

Without the `#...` part, every run uses the newest code on `main`, tested or
not.

`stable` is a branch that only ever moves forward. It is moved by the
"Promote to stable" workflow in the Actions tab, which

1. runs the tests and the live feed tests on the commit to promote,
2. requires a higher version in `package.json` than `stable` has now,
3. publishes that commit as the release `v<version>`, and
4. moves `stable` to it.

It has a "dry run" option that does steps 1 and 2 and changes nothing.

`stack-sentinel --version` prints the running version. Every report and
heartbeat carries it as `toolVersion`, and the Teams card shows it, so you can
see which release each project is on.

## Testing

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

## Decisions

[`docs/DECISIONS.md`](docs/DECISIONS.md) records why the tool works the way it
does, what was deliberately left out, and what is still unverified.

## Adding a check

Add a module in `src/checks/` exporting `{ id, run(ctx) }` that returns
findings, and register it in `src/checks/index.js`. A finding is
`{ check, severity, source, file?, version?, message, details? }` with
severity `ok`, `info`, `warn` or `error`.
