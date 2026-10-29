# Decisions

Why stack-sentinel works the way it does. Each entry gives the decision, the
reason, and where relevant what would make it worth revisiting. Add to this
file when a decision is made or reversed; do not rewrite history.

Status as of 2026-10-11. Everything here was decided on that day unless noted.

## Contents

- [Purpose and scope](#purpose-and-scope)
- [Architecture](#architecture)
- [Settings](#settings)
- [Output and notifications](#output-and-notifications)
- [Distribution and releases](#distribution-and-releases)
- [Testing and CI](#testing-and-ci)
- [Check: ui5-version](#check-ui5-version)
- [Check: node-version](#check-node-version)
- [Check: cf-node-version](#check-cf-node-version)
- [Check: cap-version](#check-cap-version)
- [Check: npm-audit](#check-npm-audit)
- [Fix pull requests](#fix-pull-requests)
- [Deliberately not built](#deliberately-not-built)
- [Unverified and open](#unverified-and-open)

## Purpose and scope

**A monitoring tool for many projects in many customer environments.** The
starting point was a consultancy that maintains UI5 and CAP projects in
customer-owned repositories (GitHub, Azure DevOps) and needs to hear, at its
own place, when a project's stack falls out of support. That includes
projects nobody pushes to any more.

**Target platform is SAP BTP.** Deployed apps run in SAP Build Work Zone and
on Cloud Foundry. ABAP front-end servers are not a target. The optional
`ui5.probes` setting is the only trace of other setups, and it assumes no
particular path.

**Every project reports from the inside; nothing scans from the outside.**
The assumption is that customers grant no outside read access to their
repositories. Each repository runs its own scheduled pipeline and posts its
report out. A central runner that clones many repositories was considered
and set aside: it needs read access, and with a real mix of git providers,
managing tokens per customer would be a burden of its own. It can be added
later for customers who do grant access. The cost of this model is more
setup per repository, which is accepted.

**The repository is public.** It was private at first. Making it public
(2026-10-11) means customer pipelines can install the tool without an access
token, and CI minutes are free. Nothing customer-specific belongs in it.

**The name is agnostic on purpose.** `stack-sentinel` names no technology, so
checks for other parts of the stack fit without renaming.

## Architecture

**Three parts: scanner, checks, notifier.** Checks produce findings as plain
data; the notifier decides where they go. This is what lets the same scan
report to the consultancy's Teams channel or to a customer's own endpoint
with only a setting changed.

**Checks are a registry.** A check is `{ id, description, run(ctx) }` in
`src/checks/`, listed in `src/checks/index.js`. Adding one touches no other
code.

**Four severities: `ok`, `info`, `warn`, `error`.** `error` means something
is already unsupported or will break; `warn` means it will be, or that a
policy is not met; `info` is worth knowing and needs no action.

**Exit codes separate findings from tool failures.** `0` clean, `1` a finding
reached `failOn`, `2` the tool itself failed (invalid setting, webhook
rejected). A pipeline can tell "your stack has a problem" from "the scanner
is broken".

**A check that cannot run is an error finding, never a green report.** If a
feed is unreachable, the report says so with severity `error`. A monitoring
tool that reports "all fine" because it could not look is worse than none.

**Stateless.** Every run stands alone and nothing is stored between runs.
Reporting only changes since the last run was considered and rejected: it
would need state in every pipeline and make behaviour depend on history.
Repeated identical notifications are accepted. To reduce them, raise
`notifyOn` or run less often.

**Plain JavaScript, no dependencies, no build step.** The tool is installed
straight from GitHub with `npx`, which runs the repository as is. TypeScript
is the team's convention, but it would need a compile step on every install
or a published package. Revisit when publishing to a package registry: the
build step exists then anyway. An in-between option, type annotations in
comments checked in CI, was offered and not taken up yet.

**Small hand-written parsers instead of libraries.** The YAML read here
(`ui5.yaml`, `mta.yaml`, the buildpack manifest) and npm version ranges are
parsed by small purpose-built readers, to keep the zero-dependency property.
They handle the regular shapes these files have, not all of YAML or semver.
Revisit if real projects turn up shapes they misread.

**Feeds are downloaded fresh on every run and never stored.** Publishers
revise dates; the next run picks that up. Each feed location is a setting and
can be a local file, for runners that cannot reach the publisher.

## Settings

**Every tunable value lives in one table, `src/settings.js`.** Nothing else
hardcodes a default. The requirement was that the tool must not depend on a
particular project layout or network setup.

**Precedence: flag, then environment variable, then config file, then
default.** Environment variables suit pipelines, the config file suits
per-project policy kept in the repository, flags suit one-off runs.

**Pipelines are configured through the platform's variables, not by editing
the pipeline file.** The first examples needed a line added to the file for
every setting. The owner expected to set a variable in the repository's
settings instead, which is also the only practical way once many repositories
carry the same file. Azure DevOps passes its variables to the tool by itself.
GitHub does not, so the workflow has a step that passes on every repository
or organization variable whose name starts with `SENTINEL_`; settings added
to the tool later therefore work without touching the file. Secrets are
mapped by name and never taken from variables.

**This repository runs the GitHub example on itself.** The example had never
run anywhere. Running the identical file here, with a test that keeps the two
copies the same, means the file customers copy is one that is known to work.

**A shared config sits between the project's settings and the defaults.**
With every project reporting from the inside, changing a policy for all
customers would otherwise mean editing every repository, including the ones
nobody touches. A project names a shared config by URL or path; its values
apply unless the project sets its own. This overlaps with promoting a
release, which also changes defaults everywhere; the shared config was wanted
anyway (decided by the owner), and it adds two things a release cannot do:
changing policy without a release, and different policy for different groups
of customers.

**A shared config that cannot be read stops the run.** Falling back to the
defaults would scan with a different policy than intended and look normal.
The cost is that an outage of the host stops every project that uses it;
with a heartbeat configured, that shows up as missing pings.

**Secrets are never read from a shared config, and it cannot chain to
another one.** The first for the same reason as the project config file. The
second keeps "where did this value come from" answerable in one step.

**An empty environment variable counts as not set.** CI systems pass unset
variables as empty strings. Azure DevOps passes an undefined variable as its
own unexpanded text, `$(NAME)`, which is treated the same way; otherwise an
optional setting in the pipeline example would break every run where it is
not defined.

**Invalid values and unknown check ids stop the run with exit code 2.** A
typo such as `SENTINEL_CHECKS=ui5` must not silently switch monitoring off.
Selecting no checks at all stops the run for the same reason.

**List settings replace the default list.** Simpler to reason about than
merging; the cost is that overriding the excluded folders means repeating
`node_modules`.

**The webhook URL is not read from the config file.** It is a credential and
the config file is committed.

**Probe URLs are config-file only.** They are a structured list, which
environment variables express badly.

**`--show-config` prints every value and where it came from.** With four
sources per setting, this is how a wrong value gets diagnosed.

## Output and notifications

**The report lists which checks ran and which were skipped.** On the
receiving side "no findings" must be distinguishable from "not checked".

**Text output and the Teams card group identical findings; the JSON report
does not.** A repository with 83 apps produced 248 near-identical lines.
People read one line per problem with the affected files; machines get one
finding per file.

**Teams notifications are Adaptive Cards for "Workflows" webhooks.** The
older connector format is being retired by Microsoft. `--format json` posts
the raw report instead, for customer-owned endpoints.

**Each finding says what to change, where the version was found.** The
recommended version was first appended to every finding's message, which
repeated one long sentence on nearly every line. It was then shown once per
report, which lost the link to the findings it belonged to: the owner found
it out of place, and it could not say what to do, because the fix differs by
place (a bootstrap address, `ui5.yaml`, a manifest pin, `minUI5Version`,
`engines.node`, a CAP dependency). Now each finding carries a short `action`
naming the change and the exact value, shown under its line; the reason for
the target ("UI5 1.148 is in long-term maintenance until 2027-09-30") is
shown once at the end. Findings with the same message but a different action
are shown separately. Recommendations never advise a downgrade.

**A heartbeat makes a dead pipeline visible.** With every project reporting
from the inside, silence is ambiguous: nothing to report, or the pipeline no
longer runs. An optional second address gets a short status message after
every completed run. A service that expects regular pings then alerts on a
missing one, so the tool stays stateless. The heartbeat means "scanned", not
"fine": it is sent whatever the findings are. It is sent last and only after
the report was delivered, so an undelivered report also shows up as a gap. It
carries counts but no findings, because the receiving service may be a third
party. Like the webhook URL, its address is not read from the config file.

**The tool always says whether a notification was sent, and if not, why.**
In the owner's first pipeline test nothing arrived and the output gave no
hint. Two ordinary causes look identical from outside: no webhook address
reached the tool (a missing or misnamed secret arrives as an empty value), or
the project was healthy and below the notification threshold.

**The heartbeat's request method is a setting, and refusals quote the
server.** The first real heartbeat test, against Uptime Kuma, failed with
"HTTP 404" although the address was right: Kuma 1.x only accepts GET on its
push addresses, and the tool sent POST. `heartbeatMethod` can now be `GET`
(the ping then carries no message). Errors from the webhook and the
heartbeat include the start of the server's answer, which in Kuma's case
names the problem ("Cannot POST", or "Monitor not found or not active").
Text settings are also trimmed, because addresses pasted into pipeline
secrets can carry a stray line break.

**The card links back to the run and the repository.** Cards arrive from
many customer organizations; without a link, finding the right pipeline means
searching. GitHub Actions and Azure DevOps both tell a pipeline its own
addresses, so the tool detects them and the card gets buttons; other CI
systems can set them. The heartbeat does not carry them: it goes to a
monitoring service that may be a third party, and the addresses name the
customer's organization and project.

**The shared config in use is named in the output, the report and the
card.** When testing a shared config, a normal run gave no sign that it had
been read; the effect on the card was the only evidence.

**The report carries the tool's version.** With pinned releases, different
customers run different versions; the receiving side needs to see which.

## Distribution and releases

**Pipelines install from a `stable` branch by default; exact release tags
remain available.** First, examples pinned an exact tag (`v0.1.0`), because
installing from `main` would mean every push changes what all customer
pipelines run. But with every project reporting from the inside, a pinned
tag has a cost of its own: in a dormant project nobody will ever edit that
line, so the scanner itself goes stale there. `stable` is a branch the owner
moves when a release has proven itself. Pipelines following it pick up
updates on their next run; a customer who wants deliberate updates names a
tag instead.

**`stable` moves only through the "Promote to stable" workflow.** It runs
the tests and the live feed tests on the candidate, refuses to move `stable`
backwards or sideways, and requires a higher version in `package.json`,
because reports identify the tool by that version. It also publishes the
commit as a release, which replaces creating tags by hand. The workflow is
started by the owner; the assistant session that built the tool is not
permitted to create tags or releases and does not start it.

**State on 2026-10-11:** the owner promoted 0.2.0, so `stable` and the tag
`v0.2.0` carry all four checks, the heartbeat and the shared config. `main`
is at 0.3.0: it adds the message saying why no notification was sent, and
the per-finding actions.

**2026-10-19: Published to npm as `@cbs-consulting/stack-sentinel`; pipelines
install `@latest` by default.** This replaces the `stable` branch and the
`github:` install. An npm package installs faster than a git checkout,
pins with an ordinary version (`@0.3.0`), and carries a provenance statement
that ties it to this repository and commit. The scope matches the company's
other npm packages. `@latest` plays the role `stable` had: it changes only
when a release is published, and only through the "Release" workflow
(formerly "Promote to stable"), which keeps the same checks and now requires
a version higher than the latest one on npm. `@latest` is written out
because `npx` without a version can reuse a copy cached on the build agent.
No pipeline installed from `stable` any more, so the branch and the
workflow steps that moved it were removed. npm accepts the
upload through trusted publishing (OIDC), so no npm token is stored in the
repository. The package ships only `bin/` and `src/`.

**2026-10-19: Releases are staged on npm and approved by a person.** The
workflow runs `npm stage publish`; the version goes live only after a
maintainer approves it with 2FA. Every pipeline follows `@latest`, so a bad
or compromised release would reach all customer projects on their next run;
the approval is the last point where a person can stop it. The trusted
publisher on npm allows staging only, so the workflow cannot make a version
live by itself even if it were misused.

**Minimum Node.js 22.** Node.js 20 reached end of life in April 2026. The
tool's own `node-version` check flagged this repository.

## Testing and CI

**Three layers.** Unit tests on the rules; end-to-end tests that run the real
command against a local server playing the feeds and the webhook receiver;
live tests that download the real feeds and check their format.

**Live tests are not part of `npm test`.** They depend on other parties'
servers, and an outage there must not block work. Their job is to notice a
changed feed format before the scanner reports nonsense.

**Fixtures are trimmed copies of the real feeds.** They keep tests fast and
offline. The dates in them are real, so tests pin "today" to 2026-10-11.

**CI runs on every push again; a pre-push hook is available as well.** For
a few hours on 2026-10-11, CI was limited to pull requests and a weekly run,
because the account had no GitHub Actions minutes left for private
repositories. The repository was then made public, where Actions minutes are
free, and the push trigger was restored. The hook (`npm run hooks`) stays as
a faster local check.

**GitHub disables scheduled workflows after 60 days without activity, in
public repositories only** (confirmed in GitHub's documentation). Customer
repositories are normally private and keep their schedule. This repository
is public, so its own weekly live feed test stops if nothing is pushed for
60 days and has to be re-enabled in the Actions tab.

**Detection was validated on eight public SAP sample repositories.** That
found three gaps, since fixed: the Fiori tools preview version, `ui5.yaml`
variants named with a dot, and flooded output.

## Check: ui5-version

**Source: `https://ui5.sap.com/versionoverview.json`.** It is the data behind
SAP's version overview page, so no HTML scraping is needed.

**The `lts` flag alone is not trusted.** 1.108 is flagged long-term and is
out of maintenance. A version must be both.

**`eomm` is the end-of-maintenance date that counts.** The feed carries two
dates per version. The version overview page is titled for SAP BTP, and its
"End of Maintenance" column matches `eomm` (confirmed against the page).
`eom` is often years later; for 1.120 it is Q4/2030 against Q4/2026. With
`eom`, a BTP project would get no advance warning. `ui5.maintenanceDate`
selects `eomm`, `eom` or `earliest`.

**The feed's status text decides what is an error.** A date that has passed
while the status still says "Maintenance" is a warning. Otherwise the tool
would contradict SAP's own page; on 2026-10-11 this applied to 1.136, 1.142
and 1.145.

**A future date is never quoted as the end date.** This was a bug: 1.108 was
reported as "ended 2030-12-31".

**`minUI5Version` is reported as info at most, and gets no patch checks.**
It was first capped at a warning. Running the tool on a project generated by
SAP's own current tooling (`cds init --add sample`) showed why that was too
loud: SAP's template writes `minUI5Version` 1.136.0, whose BTP maintenance had
just ended, so every new CAP project would carry a warning from its first day.
The value is only the oldest version the app says it supports, not what it
runs on. The finding stays visible, with the action to raise it, but no
longer triggers a card at the default threshold.

**Local test pages are reported as info at most.** The same generated
project loads UI5 without a version in `app/fiori-apps.html`, the launchpad
page `cds watch` serves during development. Pages that load SAP's launchpad
sandbox, and QUnit pages, are recognised as local test pages. Both ways of
recognising them are settings. Messages start with "Local test page:" or
"minUI5Version" so the reader sees why a finding is only info.

**Patch rules follow what the page shows.** A removed patch is an error where
the app loads it from the CDN (bootstrap URL, Work Zone pin) and a warning
elsewhere. The extended provisioning date is used when present: patches with
one are still available past their listed date (confirmed against the page).
Removal happens early in the quarter after the listed one.

**`1.136` and `1.136.x` are judged on the release line only.** They mean "the
newest patch", so there is no patch to check.

**Running on "latest" is a warning under the long-term policy.** An
unversioned CDN bootstrap URL, or a BTP app without a pin, always gets the
newest release, which is never a long-term version. With
`ui5.requireLts: false` these are info.

**On BTP the version comes from the app, not the site.** Work Zone loads the
latest release unless the app's `manifest.json` sets
`"sap.platform.cf".ui5VersionNumber`. No site-level setting was found. A BTP
app is recognised by `sap.cloud` or `sap.platform.cf` in its manifest.

**Recommended target: the long-term version whose maintenance runs longest.**
On 2026-10-11 that is 1.148.

**Fiori tools preview without a version is info, not a warning.** It affects
local preview only.

**Relative bootstrap paths are ignored.** They load UI5 from wherever the app
is served, so the file says nothing about the version.

**Type packages in `package.json` are not read.** They gave too many false
signals about the version in use.

## Check: node-version

**Source: `schedule.json` in the `nodejs/Release` repository.** Maintained by
the Node.js Release working group. It has dates, not a status; the tool
compares them with today.

**A range is judged by the best version it allows.** `>=22` stays fine as
long as some supported release satisfies it. An error means every allowed
version is past end of life.

**A range that still starts at an end-of-life version is a warning.** For
`>=18`, the fix is to raise the minimum. End-of-life odd-numbered releases in
the middle of an open range are ignored: every open range contains some, so
warning about them would be noise.

**"No version declared" is reported for the root `package.json` only.**
Repositories contain many `package.json` files that are not runtimes.

**Recommended target: the newest line that has already entered long-term
support.** Node.js 24 on 2026-10-11, Node.js 26 from 2026-10-28.

**Per major version only.** Patch releases and security fixes belong to a
vulnerability check.

## Check: cf-node-version

**Separate from `node-version`.** Node.js's lifecycle and what Cloud Foundry
offers differ in practice. On 2026-10-11 Node.js 26 is supported by Node.js
and not shipped by the buildpack, and exact versions such as `22.11.0` fail
because the buildpack keeps only the newest patch of each line.

**Source: `manifest.yml` of the `cloudfoundry/nodejs-buildpack` repository.**
SAP documents that BTP uses this community buildpack. The manifest lists the
Node.js versions shipped and a removal date per version line.

**Always compares against the newest buildpack release.** Which release a BTP
region runs is only visible through `cf buildpacks` after a login. Reading it
from a logged-in pipeline was considered and rejected: the tool must behave
the same standalone as in a pipeline, and must not handle deployment
credentials. Accepted cost: a region can lag behind, so a finding can appear
a little before it takes effect there.

**Only deployed Node.js modules are judged.** MTA modules of type `nodejs`,
`approuter.nodejs`, `javascript.nodejs` and `hdb` (the database deployer runs
on Node.js), or with a Node.js buildpack; and applications in a Cloud Foundry
`manifest.yml`. An `html5` module's `package.json` never runs on the
buildpack.

**A module path that is build output falls back to the closest
`package.json` above it.** CAP services deploy from `gen/srv`, which is not
in the repository and is built from the root `package.json`.

**`.nvmrc` is not considered.** Whether the buildpack reads it was not
verified; `engines.node` is documented.

**Stack and pinned-buildpack checks were left out.** Across 13 `mta.yaml` and
3 `manifest.yml` files in the sample repositories, none sets a stack or pins
a buildpack release. Add them if customers turn out to do so.

**Other buildpacks are out of scope.** Java on BTP uses SAP's own buildpack,
which has a different source.

## Check: cap-version

**Source: the npm registry.** CAP has no feed of supported versions, and a
hand-maintained rules file was the expected fallback. It turned out that SAP
marks every CAP version it no longer supports as deprecated on npm ("This
version is no longer supported"). On 2026-10-11 every `@sap/cds` version up
to 8 was flagged and none of 9 or 10. The registry also names the current
major and when it was first released.

**Two majors behind is an error even without a flag.** The flags are not
perfectly consistent: `@sap/cds-mtxs` had one recent unflagged patch in each
of two old majors. CAP's policy is that only the current major and the one
before it are supported, so the check applies that rule as well.

**The previous major's end of life is an estimate.** The registry has no
date for it. CAP's release schedule says the previous major is maintained for
at most twelve months after a new one, so the estimate is the current major's
first release plus twelve months. It is info until 180 days before that date
and a warning from then on (decided by the owner). The message says it is an
estimate and what it is based on. Both numbers are settings.

**The lockfile wins over the range.** `package.json` often says `^9` or
`>=8`; `package-lock.json` says what is installed. Without a lockfile the
newest matching version is judged, because that is what a fresh install gets.
A lockfile further up the folder tree is only trusted when its version fits
the range, since it may belong to a different package.

**Which packages: `@sap/cds`, `@sap/cds-dk`, `@sap/cds-mtxs`.** They are the
ones projects declare directly. `@sap/cds-compiler` comes in through
`@sap/cds`. The list is a setting, and the mechanism works for any package
whose publisher flags unsupported versions.

**References that are not registry versions are skipped.** Git URLs, `file:`
and `workspace:` references have no registry status to judge.

**CAP Java is not covered.** Maven has no equivalent flag, so it would need
the rules file after all. Node.js only for now (decided by the owner).

## Check: npm-audit

**Ask npm's own vulnerability service, without running npm.** The original
idea included vulnerability (CVE) checks. Building a vulnerability database
was never an option; the plan was to reuse an existing scanner. `npm audit`
sends the installed packages from the lockfile to an endpoint on the npm
registry and gets the matching advisories back. The check calls that endpoint
directly: no child process, no dependency on how npm is installed, the same
data as `npm audit`, and testable against a local stand-in.

**One finding per vulnerable package, naming the first fixed version.** The
advisories' own version ranges give the version that leaves all of them
behind. `npm audit` also attributes a dependency's vulnerability to the
package that pulls it in; this check names only the package that is
vulnerable, so its counts can be lower than `npm audit`'s. Checked against
`npm audit` on a project with known-vulnerable packages: the same critical
and high packages.

**Say what brings a package in, and what stands in the way of the fix**
(2026-10-19). Naming only the vulnerable package left findings about packages
nobody declared. The check now builds the dependency graph from the lockfile,
traces each vulnerable package back to the direct dependencies that bring it
in, and compares the fixed version with the ranges along the way: "npm audit
fix" when they allow it, otherwise the `package.json` entry or the direct
dependency to update, or an `overrides` entry. Still one finding per
vulnerable package and lockfile only; grouping findings by direct dependency,
and asking the registry which release of a direct dependency contains the
fix, were left for later.

**Report overrides that no longer do anything** (2026-10-19). Forcing a
version with `overrides` is the fix when a dependency pins a vulnerable
version, but nothing tells you when it can go, and a forgotten override can
later hold a package back. The check reports, as info, overrides whose
package every dependent already allows at the installed version, and
overrides for packages that are not installed. Only the overrides in the
`package.json` next to the lockfile count, as with npm, which ignores them
elsewhere. Overrides that are still needed are not reported, to keep the
noise down.

**Severities: critical is an error, high a warning, moderate info, low not
reported.** All three thresholds are settings. Packages used only for
development are info at most, for the same reason as local test pages: they
are not part of the deployed app.

**Only npm lockfiles.** CAP and UI5 projects use npm. yarn and pnpm lockfiles
have different formats and are not read.

## Fix pull requests

Decided 2026-10-29.

**The tool may change the repository it runs in, but only on request.** Until
now it only read and reported. A Dependabot-like mode was asked for, so that a
finding comes with the change that fixes it. It is off by default
(`fix.mode`): `apply` changes the scanned files, `pr` opens pull requests.

**Only safe text edits.** A fix is made when the finding's action names one
value in one file: UI5 versions in `ui5.yaml`, bootstrap URLs and the Work
Zone pin, Node.js versions in `"engines.node"` and version files, and npm
overrides that no longer do anything. `minUI5Version` is a statement of
support and is never raised. CAP majors need a migration. A missing
`"engines.node"` is only added for Cloud Foundry apps, which run on the
buildpack default anyway; elsewhere the version would be a guess. A
range is only rewritten when it is a plain lower bound (`>=18`). Vulnerable
packages need a lockfile update, which means running npm; the tool starts no
child processes.

**For Node.js, what Cloud Foundry ships wins.** `node-version` recommends the
newest long-term support release, `cf-node-version` the line the buildpack
keeps longest. When both want to change the same `"engines.node"`, the
buildpack's choice is taken, because a version it does not ship fails
staging.

**Fixes are data on the finding.** Each fixable finding carries a `fix`
(`kind`, `to`, ...) beside its `action`, set where the action is, so the edit
is never parsed back out of a sentence. Each edit changes only its value and
first checks that the file still holds what the scan saw. A `package.json`
is only rewritten when it is laid out the way npm writes it.

**Every run reports from the inside, and so does every fix.** The pull
request is opened by the same scheduled pipeline, with the pipeline's own
token, so nobody needs outside access to a repository.

**Still stateless: the pull requests are the memory.** One pull request per
kind of fix, on a branch whose name never changes, so each run finds the one
an earlier run opened and updates it. A hidden line in its description names
the versions it moves to; a pull request closed without merging and naming
the same versions means "not wanted", like Dependabot's ignore. A pull
request whose findings are gone is closed, unless its check did not run
cleanly.

**REST APIs instead of git.** Commits are made through GitHub's Git data API
and Azure Repos' pushes API, with `fetch`. No git client, no credentials on
disk, and the edit is made to the default branch as it is, not to whatever
the pipeline checked out.

**GitHub uses `GITHUB_TOKEN` unless `SENTINEL_FIX_TOKEN` is set.** It needs
no setup beyond one repository setting, which was asked for ("easiest for the
user"). Its cost: GitHub starts no workflows for pull requests it opens, so
their checks do not run until someone pushes or reopens. A GitHub App or
fine-grained token in `SENTINEL_FIX_TOKEN` avoids that.

**Auto-merge is opt-in and waits for checks.** `fix.autoMerge` (`patch` or
`all`) turns on the platform's own auto-merge, which merges once required
checks or branch policies pass. A pull request is never merged directly: a
repository without required checks gets a message, not a merge. `patch`
means every change moves to a newer patch of the same release line; adding
a pin or moving to another line is not a patch.

**Major version moves are normal pull requests.** Moving to a new UI5 release
line is opened like a patch; the project's own checks decide.

## Deliberately not built

| Idea | Why not, or not yet |
| --- | --- |
| Notify only on change | Needs state; rejected (see Architecture) |
| Logging in to Cloud Foundry | Credentials and differing behaviour; rejected |
| CAP Java check | Maven has no support flags; needs a rules file someone maintains |
| One run across many repositories | Needs outside read access, which is not assumed (see Purpose and scope) |
| TypeScript | See Architecture |
| ABAP front-end server support | Not the target platform |

## Unverified and open

- **Fix pull requests were tried on one GitHub test repository only**
  (2026-10-29: opened, and left unchanged on the next run). The Azure DevOps
  calls are tested against recorded shapes only, and it is assumed that the
  build service may delete the branches it created, which is how a branch
  left from a closed pull request starts over.
- **Nobody has seen a real Teams card.** The payload is tested for shape, not
  for how Teams renders it.
- **Not yet run on a customer project or in a customer pipeline.** Detection
  was tested on SAP's public samples only.
- **The Work Zone pin was not seen in a real repository.** None of the
  sample repositories sets `ui5VersionNumber`.
- **What `eom` means is inferred**, most likely the on-premise date.
- **Which version Work Zone falls back to** when an app pins an
  out-of-maintenance version is not known; SAP KBA 3758124 describes it but
  could only be read as a preview.
