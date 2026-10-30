import { LEVELS } from './severity.js';

/**
 * Every tunable value lives in this table, so nothing else in the code base hardcodes a
 * default. Each setting can be set, in order of precedence, by:
 *   1. a command-line flag (where `flag` is given)
 *   2. an environment variable (SENTINEL_ + the key in upper snake case, unless `env` is given)
 *   3. the config file, at the dotted `key` (unless `noConfig`)
 *   4. the default below
 */
export const SETTINGS = [
  { key: 'project', type: 'string', flag: 'project', desc: 'Name shown in reports (default: name of the scanned folder)' },
  { key: 'checks', type: 'list', flag: 'checks', desc: 'Run only these checks' },
  { key: 'skipChecks', type: 'list', flag: 'skip-checks', default: [], desc: 'Run all checks except these' },
  { key: 'output', type: 'string', flag: 'output', desc: 'Write the JSON report to this file' },
  { key: 'webhook', type: 'string', flag: 'webhook', env: 'SENTINEL_WEBHOOK_URL', noConfig: true, secret: true,
    desc: 'URL the report is posted to (not read from the config file, because it is a credential)' },
  { key: 'heartbeat', type: 'string', flag: 'heartbeat', env: 'SENTINEL_HEARTBEAT_URL', noConfig: true, secret: true,
    desc: 'URL that gets a short status message after every completed run (not read from the config file)' },
  { key: 'heartbeatMethod', type: 'enum', values: ['POST', 'GET'], default: 'POST',
    desc: 'How the heartbeat is sent; GET carries no status message, for services that only accept GET' },
  { key: 'runUrl', type: 'string', flag: 'run-url',
    desc: 'Link to this pipeline run, shown on the card (default: detected on GitHub Actions and Azure DevOps)' },
  { key: 'repositoryUrl', type: 'string', flag: 'repository-url',
    desc: 'Link to the scanned repository, shown on the card (default: detected on GitHub Actions and Azure DevOps)' },
  { key: 'format', type: 'enum', values: ['teams', 'json'], flag: 'format', default: 'teams', desc: 'Webhook payload' },
  { key: 'notifyOn', type: 'enum', values: LEVELS, flag: 'notify-on', default: 'warn', desc: 'Notify at or above this severity' },
  { key: 'failOn', type: 'enum', values: [...LEVELS, 'never'], flag: 'fail-on', default: 'error', desc: 'Exit 1 at or above this severity' },
  { key: 'timeoutSeconds', type: 'int', flag: 'timeout', default: 30, desc: 'Timeout for each HTTP request' },
  { key: 'scan.exclude', type: 'list', flag: 'exclude', default: ['node_modules', '.git', 'dist', 'build', 'gen', 'coverage', '.cache'],
    desc: 'Folder names that are not scanned (replaces the default list)' },
  { key: 'scan.maxDepth', type: 'int', flag: 'max-depth', default: 8, desc: 'How many folder levels deep to scan' },
  { key: 'notify.maxFindings', type: 'int', default: 25, desc: 'Most findings listed in one Teams card' },
  { key: 'minReleaseAgeDays', type: 'int', default: 0,
    desc: 'Recommend and move to UI5 patches and npm packages only once they were published this many days ago; 0 turns it off' },
  { key: 'fix.mode', type: 'enum', values: ['off', 'apply', 'pr'], flag: 'fix', default: 'off',
    desc: 'Fix what can be fixed safely: apply changes the scanned files, pr opens a pull request per kind of fix (GitHub Actions and Azure DevOps)' },
  { key: 'fix.groups', type: 'list', values: ['ui5', 'node', 'npm-overrides', 'cap', 'npm-audit'], flag: 'fix-groups', default: ['ui5', 'node', 'npm-overrides'],
    desc: 'Kinds of fix to make, one pull request each: ui5 (UI5 versions), node (Node.js versions), npm-overrides (npm overrides no longer needed); and, off by default, cap (CAP major upgrades, as draft pull requests) and npm-audit (vulnerable npm packages; runs npm)' },
  { key: 'fix.on', type: 'enum', values: LEVELS, flag: 'fix-on', default: 'info', desc: 'Fix findings at or above this severity' },
  { key: 'fix.token', type: 'string', env: 'SENTINEL_FIX_TOKEN', noConfig: true, secret: true,
    desc: 'Token that opens the pull requests (default: GITHUB_TOKEN or SYSTEM_ACCESSTOKEN; not read from the config file)' },
  { key: 'fix.autoMerge', type: 'enum', values: ['off', 'patch', 'all'], default: 'off',
    desc: 'Let fix pull requests merge by themselves once their checks pass: patch for those that only move to a newer patch of the same version, all for every one' },
  { key: 'fix.branchPrefix', type: 'string', default: 'stack-sentinel/', desc: 'Start of the branch names of fix pull requests' },
  { key: 'fix.maxPullRequests', type: 'int', default: 5, desc: 'Most fix pull requests open at the same time' },

  { key: 'ui5.feed', type: 'string', default: 'https://ui5.sap.com/versionoverview.json',
    desc: 'Version overview feed: a URL, or a path to a downloaded copy' },
  { key: 'ui5.requireLts', type: 'bool', default: true, desc: 'Warn about versions that are not long-term maintenance' },
  { key: 'ui5.warnDays', type: 'int', default: 180, desc: 'Warn this many days before an end date' },
  { key: 'ui5.maintenanceDate', type: 'enum', values: ['eomm', 'eom', 'earliest'], default: 'eomm',
    desc: 'End-of-maintenance date to use: eomm is the SAP BTP date shown on the version overview page, eom the feed\'s second date' },
  { key: 'ui5.versionInfoUrl', type: 'string', default: 'https://ui5.sap.com/{version}/resources/sap-ui-version.json',
    desc: 'Where the build date of a UI5 patch is read, for minReleaseAgeDays ({version} is replaced)' },
  { key: 'ui5.cdnHosts', type: 'list', default: ['ui5.sap.com', 'sapui5.hana.ondemand.com', 'openui5.hana.ondemand.com', 'sdk.openui5.org'],
    desc: 'Hosts recognised in bootstrap URLs (replaces the default list)' },
  { key: 'ui5.yamlPattern', type: 'regex', default: '(^|/)ui5([-.][\\w.-]+)?\\.ya?ml$', desc: 'Files read as UI5 tooling config (regex on the relative path)' },
  { key: 'ui5.htmlPattern', type: 'regex', default: '\\.html?$', desc: 'Files searched for a bootstrap URL (regex on the relative path)' },
  { key: 'ui5.testPagePattern', type: 'regex', default: '\\.qunit\\.html?$',
    desc: 'HTML files treated as local test pages, reported as info at most (regex on the relative path)' },
  { key: 'ui5.testPageContent', type: 'regex', default: 'sap/ushell/bootstrap/sandbox\\d*\\.js',
    desc: 'HTML files containing this are treated as local test pages, e.g. a launchpad sandbox (regex on the file content)' },
  { key: 'ui5.manifestPattern', type: 'regex', default: '(^|/)manifest\\.json$', desc: 'Files read as app manifests (regex on the relative path)' },

  { key: 'node.feed', type: 'string', default: 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json',
    desc: 'Node.js release schedule: a URL, or a path to a downloaded copy' },
  { key: 'node.requireLts', type: 'bool', default: true, desc: 'Warn when only non-LTS Node.js releases are allowed' },
  { key: 'node.warnDays', type: 'int', default: 180, desc: 'Warn this many days before end of life' },
  { key: 'node.packagePattern', type: 'regex', default: '(^|/)package\\.json$', desc: 'Files read for "engines.node" (regex on the relative path)' },
  { key: 'node.ciPattern', type: 'regex', default: '(^|/)(\\.github/workflows/[^/]+|azure-pipelines[^/]*|\\.azure-pipelines/[^/]+)\\.ya?ml$',
    desc: 'CI pipeline files read for the Node.js version they set up (regex on the relative path)' },
  { key: 'node.containerPattern', type: 'regex', default: '(^|/)(Dockerfile|Containerfile)([.-][\\w.-]+)?$',
    desc: 'Dockerfiles read for the node image they build on (regex on the relative path)' },
  { key: 'node.versionFilePattern', type: 'regex', default: '(^|/)\\.(nvmrc|node-version)$', desc: 'Files read as Node.js version files (regex on the relative path)' },

  { key: 'cf.feed', type: 'string', default: 'https://raw.githubusercontent.com/cloudfoundry/nodejs-buildpack/master/manifest.yml',
    desc: 'Manifest of the Cloud Foundry Node.js buildpack: a URL, or a path to a downloaded copy' },
  { key: 'cf.warnDays', type: 'int', default: 180, desc: 'Warn this many days before a Node.js line leaves the buildpack' },
  { key: 'cf.descriptorPattern', type: 'regex', default: '(^|/)(mta\\.yaml|manifest\\.ya?ml)$',
    desc: 'Files read as Cloud Foundry deployment descriptors (regex on the relative path)' },
  { key: 'cf.nodeModuleTypes', type: 'list', default: ['nodejs', 'approuter.nodejs', 'javascript.nodejs', 'hdb'],
    desc: 'MTA module types that run on the Node.js buildpack (replaces the default list)' },

  { key: 'cap.registry', type: 'string', default: 'https://registry.npmjs.org',
    desc: 'npm registry to ask about CAP packages: a URL, or a folder with downloaded copies' },
  { key: 'cap.packages', type: 'list', default: ['@sap/cds', '@sap/cds-dk', '@sap/cds-mtxs'],
    desc: 'Packages whose major version is checked (replaces the default list)' },
  { key: 'cap.warnDays', type: 'int', default: 180, desc: 'Warn this many days before the estimated end of life of the previous major' },
  { key: 'cap.maintenanceMonths', type: 'int', default: 12, desc: 'How long the previous major is maintained after a new one is released' },
  { key: 'cap.packagePattern', type: 'regex', default: '(^|/)package\\.json$', desc: 'Files read for CAP dependencies (regex on the relative path)' },

  { key: 'audit.registry', type: 'string', default: 'https://registry.npmjs.org',
    desc: 'npm registry to ask about known vulnerabilities' },
  { key: 'audit.lockfilePattern', type: 'regex', default: '(^|/)(package-lock|npm-shrinkwrap)\\.json$',
    desc: 'Lockfiles whose installed packages are checked (regex on the relative path)' },
  { key: 'audit.reportFrom', type: 'enum', values: ['info', 'low', 'moderate', 'high', 'critical'], default: 'moderate',
    desc: 'Vulnerabilities below this advisory severity are not reported' },
  { key: 'audit.warnAt', type: 'enum', values: ['info', 'low', 'moderate', 'high', 'critical'], default: 'high',
    desc: 'Advisory severity from which a vulnerability is a warning (below: info)' },
  { key: 'audit.errorAt', type: 'enum', values: ['info', 'low', 'moderate', 'high', 'critical'], default: 'critical',
    desc: 'Advisory severity from which a vulnerability is an error' },
];

export const envName = (def) =>
  def.env ?? `SENTINEL_${def.key.replace(/\./g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;

const getPath = (obj, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

function setPath(obj, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  let o = obj;
  for (const p of parts) {
    if (!o[p] || typeof o[p] !== 'object' || Array.isArray(o[p])) o[p] = {};
    o = o[p];
  }
  o[last] = value;
}

function coerce(def, raw, where) {
  const fail = (expected) => {
    throw new Error(`Invalid value for ${where}: expected ${expected}, got ${JSON.stringify(raw)}`);
  };
  switch (def.type) {
    case 'string':
      // values pasted into pipeline secrets often carry a stray space or line break
      return typeof raw === 'string' ? raw.trim() : fail('text');
    case 'int': {
      const n = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw).trim()) ? Number(raw) : NaN;
      return Number.isInteger(n) && n >= 0 ? n : fail('a whole number');
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return true;
      if (['false', '0', 'no', 'off'].includes(s)) return false;
      return fail('true or false');
    }
    case 'list': {
      const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : fail('a list');
      const list = items.map((s) => String(s).trim()).filter(Boolean);
      if (def.values && list.some((v) => !def.values.includes(v))) fail(`a list of ${def.values.join(', ')}`);
      return list;
    }
    case 'enum':
      return def.values.includes(raw) ? raw : fail(`one of ${def.values.join(', ')}`);
    case 'regex':
      try {
        new RegExp(raw);
      } catch {
        fail('a valid regular expression');
      }
      return typeof raw === 'string' ? raw : fail('a regular expression');
    default:
      throw new Error(`Unknown setting type ${def.type}`);
  }
}

// An empty string counts as "not set": CI systems pass unset variables that way. Azure
// DevOps passes an undefined variable as its own unexpanded text, "$(NAME)".
export const isSet = (v) => v !== undefined && v !== null && v !== '' && !/^\$\([\w.]+\)$/.test(v);

/** Combines two config objects; `over` wins, objects are merged key by key, lists are replaced. */
function merge(under, over) {
  const out = structuredClone(under);
  for (const [key, value] of Object.entries(over)) {
    const both = value && typeof value === 'object' && !Array.isArray(value)
      && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]);
    out[key] = both ? merge(out[key], value) : structuredClone(value);
  }
  return out;
}

/**
 * Resolves all settings. `shared` is the content of a shared config file, which ranks
 * between the project's own config file and the built-in defaults. Returns
 *   values:  the config content (shared, then the project's on top) with every setting
 *            filled in at its dotted key
 *   sources: key -> 'flag' | 'env' | 'config' | 'shared' | 'default'
 */
export function resolveSettings({ cli = {}, env = {}, config = {}, shared = {} } = {}) {
  const values = merge(shared, config);
  const sources = {};
  for (const def of SETTINGS) {
    const fromConfig = def.noConfig ? undefined : getPath(config, def.key);
    const fromShared = def.noConfig ? undefined : getPath(shared, def.key);
    let value;
    let source;
    if (def.flag && isSet(cli[def.flag])) {
      value = coerce(def, cli[def.flag], `--${def.flag}`);
      source = 'flag';
    } else if (isSet(env[envName(def)])) {
      value = coerce(def, env[envName(def)], envName(def));
      source = 'env';
    } else if (isSet(fromConfig)) {
      value = coerce(def, fromConfig, `"${def.key}" in the config file`);
      source = 'config';
    } else if (isSet(fromShared)) {
      value = coerce(def, fromShared, `"${def.key}" in the shared config`);
      source = 'shared';
    } else {
      value = def.default === undefined ? undefined : structuredClone(def.default);
      source = 'default';
    }
    setPath(values, def.key, value);
    sources[def.key] = source;
  }
  return { values, sources };
}

/** Lines for --show-config. Secrets are masked. */
export function describeSettings({ values, sources }) {
  return SETTINGS.map((def) => {
    const v = getPath(values, def.key);
    const shown = v === undefined ? '(not set)' : def.secret ? '(set, hidden)' : JSON.stringify(v);
    return `${def.key.padEnd(20)} ${shown}  [${sources[def.key]}]`;
  });
}
