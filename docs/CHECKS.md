# Checks

What each check looks at and when it reports what. Back to the [README](../README.md).

`stack-sentinel --list-checks` prints the ids. Settings named here (`ui5.warnDays`, …) are listed in the README under [Settings](../README.md#settings).

Some findings can be fixed automatically: they carry a `fix` in the JSON report, and `SENTINEL_FIX_MODE` applies them or opens pull requests for them (README, [Fix pull requests](../README.md#fix-pull-requests)).

## `ui5-version`

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

## `node-version`

Compares the Node.js versions a project allows with the official Node.js
release schedule
(`https://raw.githubusercontent.com/nodejs/Release/main/schedule.json`).

| Where it looks | Meaning |
| --- | --- |
| `package.json` → `engines.node` | The range of Node.js versions the project accepts; on Cloud Foundry the buildpack picks the runtime from it |
| `.nvmrc`, `.node-version` | The version used for local development and CI |
| CI pipelines (`.github/workflows/*.yml`, `azure-pipelines*.yml`) → `actions/setup-node` `node-version`, `NodeTool` `versionSpec`, `UseNode` `version` | The version the pipeline builds and tests with; expressions and build matrices are not read |
| `Dockerfile`, `Containerfile` → `FROM node:<tag>` | The version of the official node image the container is built on |

| Severity | When |
| --- | --- |
| error | Every version the range allows is past end of life |
| warn | The range still starts at a version past end of life (`>=18`); all allowed versions reach end of life within `node.warnDays`; only a non-LTS release is allowed, or the latest release is followed (`node`), unless `node.requireLts` is `false`; the version text cannot be understood |
| info | The newest allowed version is in maintenance and a newer long-term support release exists; the root `package.json` declares no Node.js version |

A range is judged by the best version it allows, so `>=22` stays fine as long
as some supported release satisfies it. This check knows only Node.js's own
dates; which versions Cloud Foundry still offers is covered by
`cf-node-version`.

## `cf-node-version`

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

## `cap-version`

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

## `npm-audit`

Checks the packages installed through `package-lock.json` (or
`npm-shrinkwrap.json`) for known vulnerabilities. It asks the same service
`npm audit` uses, on the npm registry, so its results match `npm audit`. It
reads the lockfile only; nothing is installed. Projects without an npm
lockfile (for example with yarn or pnpm) are not checked.

| Severity | When |
| --- | --- |
| error | A vulnerability with advisory severity `critical` (`audit.errorAt`) |
| warn | Advisory severity `high` (`audit.warnAt`) |
| info | Advisory severity `moderate`, or any severity in a package used only for development; an override in `package.json` that is no longer needed |
| ok | No known vulnerabilities of `moderate` severity or above (`audit.reportFrom`) |

There is one finding per vulnerable package, naming the worst advisory and
the first version that fixes all of them. The advisories, with links, are in
the JSON report under `details.advisories`. `npm audit` attributes a
dependency's vulnerability to the package that pulls it in as well; this
check counts only the package that is actually vulnerable, so its counts can
be lower.

When the vulnerable package is not one of your own dependencies, the finding
says which of them brings it in, with the shortest chain (for example
`It comes in through express 4.17.1 → body-parser 1.19.0.`). Every direct
dependency it comes in through, with its chain, is in the JSON report under
`details.introducedBy`. The check works this out from the lockfile, resolving
each dependency the way Node.js does. For lockfile version 1, which does not
record the project's own dependencies, it reads the `package.json` next to
the lockfile.

The action depends on what the version ranges along the way allow:

| Situation | Action |
| --- | --- |
| Every package that asks for it allows the fixed version | Run `npm audit fix`: the lockfile is only out of date |
| `package.json` pins it below the fix | Raise it in `package.json` |
| A dependency pins it below the fix | Update the direct dependency that brings it in, or force the version with `overrides` in `package.json` |
| It is bundled inside another package | Only a new release of that package fixes it |
| No fixed version is known | Consider replacing it, or the direct dependency that brings it in |

The first two rows carry a `fix`: with `fix.groups` naming `npm-audit`, the
fix pull request raises the range and lets npm move the package (README, [Fix pull requests](../README.md#fix-pull-requests)).

An `overrides` entry in `package.json` forces a version, and stays in force
after the reason for it is gone. The check reads the `overrides` of the
`package.json` next to each lockfile and reports an override as info when it
no longer does anything, with the action to remove it:

- **No longer needed:** every package that asks for the overridden package
  already allows the installed version. The lockfile records the ranges the
  packages declare themselves, before any override, so removing the override
  leaves the same version installed.
- **Unused:** the overridden package is not installed at all (or, for an
  override scoped under a parent, not below that parent).

Plain overrides (`"pkg": "1.2.3"`, also `"pkg@range": …`) and overrides
scoped one level under a parent (`"parent": { "pkg": "1.2.3" }`) are judged;
deeper nesting is ignored. A range the check cannot read, such as a git URL,
counts as still needing the override.

## `license`

Checks the licenses of the packages installed through `package-lock.json`
(or `npm-shrinkwrap.json`) against a license policy. The licenses are the
ones npm recorded in the lockfile from each package's `package.json`, so
nothing is downloaded. Lockfile version 1 records no licenses; it gets one
info finding saying so.

| Severity | When |
| --- | --- |
| error | The license is on the deny list (`license.deny`; by default strong copyleft: AGPL, GPL, SSPL, EUPL and OSL) |
| warn | An allow list is set (`license.allow`) and the license is not on it |
| info | The package declares no SPDX license, for example `"SEE LICENSE IN LICENSE"` (SAP's own packages do this) or nothing at all (`license.unknown`); or any of the above in a package used only for development, which is not shipped |
| ok | Every installed package meets the policy |

- **SPDX expressions are understood.** With `OR` a package may be used under
  the best of its choices (`MIT OR GPL-2.0` is fine), with `AND` it must meet
  all of them (`MIT AND AGPL-3.0` is not). `WITH` exceptions are read as the
  license they modify.
- **Ids match without their variant**: `GPL-3.0` on a list also matches
  `GPL-3.0-only`, `GPL-3.0-or-later` and `GPL-3.0+`. Case does not matter.
- **LGPL and MPL are not denied by default.** They are weak copyleft, which
  most policies allow for libraries used unchanged. Add them to
  `license.deny` if yours does not.
- **A license that was approved for one package** is best recorded as an
  [ignore rule](../README.md#ignore) with the reason, for example
  `{ "check": "license", "package": "gpl-lib", "reason": "approved by legal, 2026-10" }`.
