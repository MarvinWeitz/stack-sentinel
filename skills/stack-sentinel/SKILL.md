---
name: stack-sentinel
description: Sets up and configures stack-sentinel, which scans SAP UI5, CAP, Node.js and Cloud Foundry projects for out-of-support versions and vulnerable or wrongly licensed npm packages, reports to Microsoft Teams or a JSON endpoint, and can open fix pull requests. Use when the user wants to monitor a project's stack, add the weekly stack-sentinel pipeline on GitHub Actions or Azure DevOps, turn on fix pull requests, the dashboard, a heartbeat or a shared config, ignore a finding, or find out why a stack-sentinel run sent nothing, failed or opened no pull request.
license: Apache-2.0
---

# stack-sentinel

stack-sentinel scans a project folder, compares UI5, Node.js, Cloud Foundry and CAP versions with
the vendors' support data, checks `package-lock.json` for known vulnerabilities and license
policy, and posts the findings to a webhook. It is meant to run weekly in the project's pipeline,
so projects nobody touches are still watched. Your job is to get it running there with as little
for the user to click as possible, and to make the steps only they can do short and exact.

Run it as `npx --yes @cbs-consulting/stack-sentinel@latest <path> [options]` (Node.js 22 or newer;
write `@latest` out, or npx may reuse an old copy). Exit codes: `0` ok, `1` a finding reached
`failOn`, `2` the tool or its configuration failed. The full documentation is at
https://github.com/cbs-consulting/stack-sentinel#readme; read the section you need there instead
of guessing a setting.

## Where settings live

Every setting has a config key, an environment variable `SENTINEL_<KEY>` and sometimes a flag.
Precedence: flag, environment variable, `sentinel.config.json` in the scanned folder, shared
config, default. `--show-config` prints every setting, its value and where it came from.

- **Secrets** (`SENTINEL_WEBHOOK_URL`, `SENTINEL_HEARTBEAT_URL`, `SENTINEL_FIX_TOKEN`) go only into
  the platform's secret store. The tool ignores them in config files, and they must never be
  committed, printed or written into chat.
- **Pipeline settings** go into the platform's variables (GitHub: repository or organization
  variables; Azure DevOps: pipeline variables). The pipeline examples pass every `SENTINEL_...`
  variable to the tool, so the pipeline file is never edited.
- **Project facts** that belong to the code (`project`, `scan.exclude`, file patterns, `ignore`
  rules, `skipChecks`) go into `sentinel.config.json`, so they are reviewed with the code.

## Set it up

1. **Look first.** Find the platform from the remote URL and existing CI files
   (`.github/workflows/`, `azure-pipelines.yml`). Check whether `.github/workflows/stack-sentinel.yml`,
   a pipeline running `stack-sentinel`, or `sentinel.config.json` already exists; if so, change
   that instead of adding a second one.
2. **Ask only what you cannot see.** Unless the user already said:
   - Where should reports go: a Teams channel (`format` `teams`, the default; the user creates a
     Teams workflow "Post to a channel when a webhook request is received" and keeps its URL) or
     a JSON endpoint (`format` `json`)?
   - Should it open fix pull requests (`fix.mode` `pr`)? Should it keep a dashboard issue or work
     item (`dashboard.enabled`)? Is there a heartbeat service or a shared config for this customer?
   Default to reports only. Don't turn on fix pull requests, auto-merge or the dashboard unasked.
3. **Run it locally once** on the folder to scan:
   `npx --yes @cbs-consulting/stack-sentinel@latest . --fail-on never`. Read the findings with the
   user. If a folder that is not part of the app is scanned (vendored code, generated files, test
   fixtures), add it to `scan.exclude` in `sentinel.config.json`; that list replaces the default,
   so keep the defaults in it. If the project has another root, the pipeline gets the variable
   `SENTINEL_PATH`.
4. **Add the pipeline file unchanged.** Copy the current example from the repository, not from
   memory:
   - GitHub: https://raw.githubusercontent.com/cbs-consulting/stack-sentinel/main/examples/github-actions.yml
     to `.github/workflows/stack-sentinel.yml`.
   - Azure DevOps: https://raw.githubusercontent.com/cbs-consulting/stack-sentinel/main/examples/azure-pipelines.yml
     to a new pipeline file, for example `.azure-pipelines/stack-sentinel.yml`, then the user
     creates a pipeline from it (Pipelines, New pipeline, Existing Azure Pipelines YAML file).
   Commit it with `sentinel.config.json` if you made one.
5. **Hand over the settings** as one short list with exact names, values and where to click
   (see "What only the user can do"). With the GitHub CLI signed in and the user's agreement, you
   may set variables yourself with `gh variable set NAME --body VALUE`. For secrets, let the user
   run `gh secret set SENTINEL_WEBHOOK_URL`, which asks for the value, so it never passes
   through you.
6. **Test once.** Ask the user to add the variable `SENTINEL_NOTIFY_ON` = `ok` (otherwise a
   healthy project sends no card), then start the run: GitHub Actions, stack-sentinel, Run
   workflow (or `gh workflow run stack-sentinel.yml`); Azure DevOps, Run pipeline. Read the last
   lines of the log with the user: they say whether a notification was sent and, if not, why.
   Afterwards remove `SENTINEL_NOTIFY_ON` again.

## What only the user can do

| Setting | GitHub | Azure DevOps |
| --- | --- | --- |
| Webhook secret | Settings, Secrets and variables, Actions, Secrets: `SENTINEL_WEBHOOK_URL` | Pipeline, Edit, Variables: `SENTINEL_WEBHOOK_URL`, "Keep this value secret" |
| Other settings | Same page, Variables tab: `SENTINEL_<KEY>`; organization variables apply to all repositories | Same Variables dialog |
| Fix pull requests | Variable `SENTINEL_FIX_MODE` = `pr`, and Settings, Actions, General, Workflow permissions: "Allow GitHub Actions to create and approve pull requests" | Variable `SENTINEL_FIX_MODE` = `pr`, and Project settings, Repositories, the repository, Security, the project's build service: "Contribute" and "Contribute to pull requests" |
| Checks on fix pull requests | Secret `SENTINEL_FIX_TOKEN`: a fine-grained token for this repository with Contents and Pull requests read and write (add Workflows to let it update workflow files) | Nothing to do |
| Dashboard | Variable `SENTINEL_DASHBOARD_ENABLED` = `true` (the example already has `issues: write`) | Same variable, and the build service needs "Edit work items in this node" on the area path |
| Heartbeat | Secret `SENTINEL_HEARTBEAT_URL`, one address per project at a service that alerts on a missing ping | Secret variable with the same name |

The pipeline examples run Mondays 06:17 UTC; nothing else needs scheduling.

## When something goes wrong

| Symptom | Cause and fix |
| --- | --- |
| Run succeeded, no card | The status was below `notifyOn` (default `warn`), or no webhook reached the tool: the secret is missing or misnamed. The log's last lines say which. |
| Exit code `2` | A setting is invalid, the shared config could not be read, or the webhook, heartbeat or dashboard could not be written. The message names it. Run `--show-config` locally to see the values. |
| Exit code `1` fails the pipeline | A finding reached `failOn` (default `error`). Fix the finding or ignore it with a reason. Set `SENTINEL_FAIL_ON` = `never` only if the user wants the run to stay green. |
| No fix pull request | `SENTINEL_FIX_MODE` is not `pr`, the "create pull requests" permission is off, `fix.maxPullRequests` is reached, or a closed pull request already skipped that version. |
| Fix pull request has no checks | It was opened with `GITHUB_TOKEN`; set `SENTINEL_FIX_TOKEN`. |
| Workflow files left out of a fix | Changing `.github/workflows/` needs a token with the Workflows permission. |
| Schedule stopped on GitHub | GitHub disables schedules in public repositories after 60 days without activity. Re-enable it in the Actions tab. |
| An unknown check id | `stack-sentinel --list-checks` prints the valid ids. |

## Ignoring a finding

When the user decides to live with a finding, add a rule under `"ignore"` in
`sentinel.config.json`, as narrow as possible and always with `until` and `reason`:

```json
{ "ignore": [{ "advisory": "GHSA-29mw-wpgm-hmr9", "until": "2027-01-31", "reason": "Only used by a build script" }] }
```

A rule matches by `check`, `file` (regex), `package`, `version`, `advisory` or `message` (regex),
and needs at least one besides `check`. To stop a whole check, use `skipChecks`.

## Rules for agents

- Never write a webhook, heartbeat address or token into a file, a commit, a log or the chat.
- Don't edit the pipeline example to change a setting; use a variable. Keep `@latest` unless the
  user wants to pin a release with `SENTINEL_SOURCE`.
- Don't ignore findings, raise `failOn`, skip checks or turn on auto-merge to make a run pass,
  unless the user decides so. Ignore rules always get a reason and an end date.
- Don't merge fix pull requests yourself. The project's own checks on them show whether the app
  still works.
- Settings in the platform belong to the user. Tell them what to set; change them yourself only
  when they ask and you have a signed-in CLI for it.
