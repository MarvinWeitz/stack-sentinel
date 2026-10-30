import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checks, selectChecks } from './checks/index.js';
import { listFiles } from './files.js';
import { applyFixes, detectProvider, openPullRequests } from './fix/index.js';
import { notify, sendHeartbeat } from './notifiers/webhook.js';
import { detectPipeline } from './pipeline.js';
import { describeFiles, groupFindings, recommendations } from './report.js';
import { SETTINGS, describeSettings, envName, isSet, resolveSettings } from './settings.js';
import { atLeast, rank, worst } from './severity.js';

const DEFAULT_CONFIG_FILE = 'sentinel.config.json';
export const VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

const flagHelp = SETTINGS.filter((d) => d.flag)
  .map((d) => `  --${`${d.flag} <${d.type === 'enum' ? d.values.join('|') : d.type}>`.padEnd(34)} ${d.desc}${d.default !== undefined ? ` (default: ${[].concat(d.default).join(',') || 'none'})` : ''}`)
  .join('\n');

const HELP = `stack-sentinel [path] [options]

Scans a project for outdated or unsupported stack versions.

Options:
  --config <file>                      Config file (env: SENTINEL_CONFIG; default: <path>/${DEFAULT_CONFIG_FILE} if present)
  --shared-config <url|file>           Settings shared by many projects (env: SENTINEL_SHARED_CONFIG)
${flagHelp}
  --json                               Print the JSON report instead of text
  --list-checks                        List the available checks and exit
  --show-config                        Print every setting, its value and where it came from, and exit
  -v, --version                        Print the version and exit
  -h, --help                           Show this help

Every setting can also be set by environment variable or config file, including
ones without a flag. Run --show-config to see them all.
`;

function makeFetch(timeoutSeconds, accept, read) {
  return async (url) => {
    const res = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(timeoutSeconds * 1000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return read(res);
  };
}
export const makeFetchJson = (timeoutSeconds) => makeFetch(timeoutSeconds, 'application/json', (res) => res.json());
export const makeFetchText = (timeoutSeconds) => makeFetch(timeoutSeconds, 'text/plain, */*', (res) => res.text());
export const makePostJson = (timeoutSeconds) => async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
};

async function loadConfig(root, explicit) {
  const file = explicit ? resolve(explicit) : join(root, DEFAULT_CONFIG_FILE);
  try {
    return { file, config: JSON.parse(await readFile(file, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT' && !explicit) return { file: null, config: {} };
    throw new Error(`Cannot read config ${file}: ${err.message}`);
  }
}

/**
 * Loads the shared config: settings kept in one place for many projects. `location` is a
 * URL or a file path (relative to `baseDir`). A shared config that cannot be read stops
 * the run, because quietly scanning with a different policy would be worse.
 */
async function loadSharedConfig(location, baseDir, timeoutSeconds) {
  let shared;
  try {
    shared = /^https?:\/\//i.test(location)
      ? await makeFetchJson(timeoutSeconds)(location)
      : JSON.parse(await readFile(resolve(baseDir, location), 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read the shared config ${location}: ${err.message}`);
  }
  if (!shared || typeof shared !== 'object' || Array.isArray(shared)) {
    throw new Error(`The shared config ${location} is not a JSON object.`);
  }
  return shared;
}

/**
 * Runs the selected checks. `settings` is the `values` object from resolveSettings();
 * when omitted it is resolved from `config` alone.
 */
export async function scan({ root, config = {}, settings = resolveSettings({ config }).values, now = new Date(), fetchJsonImpl, fetchTextImpl, postJsonImpl }) {
  const selection = selectChecks(settings);
  const files = await listFiles(root, settings.scan);
  const ctx = {
    root, files, config: settings, now,
    fetchJson: fetchJsonImpl ?? makeFetchJson(settings.timeoutSeconds),
    fetchText: fetchTextImpl ?? makeFetchText(settings.timeoutSeconds),
    postJson: postJsonImpl ?? makePostJson(settings.timeoutSeconds),
  };
  const findings = [];
  for (const check of selection.selected) {
    try {
      findings.push(...(await check.run(ctx)));
    } catch (err) {
      // A check that cannot run must be visible, never silently "green".
      findings.push({ check: check.id, severity: 'error', source: 'check', message: `Check failed to run: ${err.message}` });
    }
  }
  findings.sort((a, b) => rank(b.severity) - rank(a.severity));
  const summary = { error: 0, warn: 0, info: 0, ok: 0 };
  for (const f of findings) summary[f.severity]++;
  return {
    tool: 'stack-sentinel',
    toolVersion: VERSION,
    project: settings.project ?? basename(root),
    generatedAt: now.toISOString(),
    status: worst(findings.map((f) => f.severity)),
    checks: { run: selection.selected.map((c) => c.id), skipped: selection.skipped },
    summary,
    findings,
  };
}

function printText(report) {
  console.log(`stack-sentinel: ${report.project} — ${report.status.toUpperCase()}`);
  console.log(`  checks run: ${report.checks.run.join(', ')}${report.checks.skipped.length ? ` · skipped: ${report.checks.skipped.join(', ')}` : ''}`);
  if (report.sharedConfig) console.log(`  shared config: ${report.sharedConfig}`);
  if (report.links?.run) console.log(`  run: ${report.links.run}`);
  if (report.findings.length === 0) console.log('  No supported stack files found; nothing was checked.');
  for (const g of groupFindings(report.findings)) {
    console.log(`  [${g.severity.padEnd(5)}] ${g.message}${g.files.length ? `  (${describeFiles(g.files)})` : ''}`);
    if (g.action) console.log(`          → ${g.action}`);
  }
  for (const text of recommendations(report.findings)) console.log(`  ${text}.`);
  for (const f of report.fixes ?? []) {
    console.log(`  fixed: ${f.title}${f.files.length ? ` (${describeFiles(f.files)})` : ' (nothing changed)'}`);
    for (const reason of f.skipped) console.log(`          not changed: ${reason}`);
  }
  for (const pr of report.pullRequests ?? []) {
    const merge = pr.autoMerge === true ? ', auto-merge on' : pr.autoMerge === false ? ', auto-merge could not be turned on' : '';
    console.log(`  pull request ${pr.action}: ${pr.title}${pr.url ? `  ${pr.url}` : ''}${pr.reason ? ` (${pr.reason})` : ''}${merge}`);
  }
}

export async function main(argv, env = process.env) {
  const options = {
    config: { type: 'string' },
    'shared-config': { type: 'string' },
    json: { type: 'boolean', default: false },
    'list-checks': { type: 'boolean', default: false },
    'show-config': { type: 'boolean', default: false },
    version: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  };
  for (const d of SETTINGS) if (d.flag) options[d.flag] = { type: 'string' };
  const { values: cli, positionals } = parseArgs({ args: argv, allowPositionals: true, options });

  if (cli.help) {
    console.log(HELP);
    return 0;
  }
  if (cli.version) {
    console.log(VERSION);
    return 0;
  }
  if (cli['list-checks']) {
    for (const c of checks) console.log(`${c.id.padEnd(16)} ${c.description}`);
    return 0;
  }

  const root = resolve(positionals[0] ?? '.');
  const { file: configFile, config } = await loadConfig(root, cli.config ?? (env.SENTINEL_CONFIG || undefined));

  // Where the shared config is: flag, then environment, then "sharedConfig" in the project's config.
  const fromOutside = [cli['shared-config'], env.SENTINEL_SHARED_CONFIG].find(isSet);
  const sharedLocation = fromOutside ?? (isSet(config.sharedConfig) ? config.sharedConfig : undefined);
  let shared = {};
  if (sharedLocation !== undefined) {
    if (typeof sharedLocation !== 'string') throw new Error('"sharedConfig" must be a URL or a file path.');
    // a path in the project's config file is relative to that file; elsewhere, to the working directory
    const baseDir = fromOutside === undefined && configFile ? dirname(configFile) : process.cwd();
    const { timeoutSeconds } = resolveSettings({ cli, env, config }).values;
    shared = await loadSharedConfig(sharedLocation, baseDir, timeoutSeconds);
  }

  const resolved = resolveSettings({ cli, env, config, shared });
  const settings = resolved.values;

  if (cli['show-config']) {
    console.log(`Shared config: ${sharedLocation ?? '(none)'}`);
    console.log(describeSettings(resolved).join('\n'));
    console.log(`\nEnvironment variables: ${SETTINGS.map(envName).join(', ')}`);
    return 0;
  }

  const report = await scan({ root, settings });
  // Where this report came from: which shared config applied, and links back to the run.
  const pipeline = detectPipeline(env);
  if (sharedLocation !== undefined) report.sharedConfig = sharedLocation;
  const links = { run: settings.runUrl ?? pipeline.runUrl, repository: settings.repositoryUrl ?? pipeline.repositoryUrl };
  if (links.run || links.repository) report.links = Object.fromEntries(Object.entries(links).filter(([, v]) => v));

  // Fixes come before the report goes out, so the card can link the pull requests. A fix
  // that fails is a tool failure, but the report is still delivered first.
  let fixError;
  try {
    if (settings.fix.mode === 'apply') report.fixes = await applyFixes(report, root, { fixOn: settings.fix.on, only: settings.fix.groups });
    if (settings.fix.mode === 'pr') {
      const provider = detectProvider(env, { token: settings.fix.token, timeoutSeconds: settings.timeoutSeconds });
      report.pullRequests = await openPullRequests(report, root, {
        provider, fixOn: settings.fix.on, only: settings.fix.groups, branchPrefix: settings.fix.branchPrefix, maxPullRequests: settings.fix.maxPullRequests,
        autoMerge: settings.fix.autoMerge, log: (line) => console.error(`stack-sentinel: ${line}`),
      });
      const failed = report.pullRequests.filter((pr) => pr.action === 'failed');
      if (failed.length) throw new Error(failed.map((pr) => `${pr.title}: ${pr.reason}`).join(' '));
    }
  } catch (err) {
    fixError = err;
    report.fixError = err.message;
  }

  if (cli.json) console.log(JSON.stringify(report, null, 2));
  else printText(report);
  if (settings.output) await writeFile(settings.output, JSON.stringify(report, null, 2));

  if (settings.webhook && atLeast(report.status, settings.notifyOn)) {
    await notify(report, {
      url: settings.webhook,
      format: settings.format,
      threshold: settings.notifyOn,
      maxFindings: settings.notify.maxFindings,
      timeoutSeconds: settings.timeoutSeconds,
    });
    console.error('stack-sentinel: notification sent.');
  } else if (!settings.webhook) {
    // Say why nothing was sent: an unset or misnamed secret is otherwise invisible.
    console.error('stack-sentinel: no notification sent, because no webhook address is set (SENTINEL_WEBHOOK_URL or --webhook).');
  } else {
    console.error(`stack-sentinel: no notification sent, because the status "${report.status}" is below notify-on "${settings.notifyOn}". Set SENTINEL_NOTIFY_ON=ok (or --notify-on ok) to send one on every run.`);
  }

  // Sent last, and only when everything before it worked: a missing heartbeat then means
  // the run did not happen, did not finish, or could not deliver its report.
  if (settings.heartbeat) {
    await sendHeartbeat(report, { url: settings.heartbeat, method: settings.heartbeatMethod, timeoutSeconds: settings.timeoutSeconds });
    console.error('stack-sentinel: heartbeat sent.');
  }

  if (fixError) throw new Error(`Could not fix the findings: ${fixError.message}`);
  return settings.failOn !== 'never' && atLeast(report.status, settings.failOn) ? 1 : 0;
}
