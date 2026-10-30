import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DAY, fmt, loadFeed } from '../feed.js';

const VERSION_RE = /^(\d+)\.(\d+)(?:\.(\d+))?/;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- feed handling ----------

/** "Q3/2027" (anywhere in the string) -> Date of the last day of that quarter (UTC). */
export function parseQuarter(text) {
  const m = /Q([1-4])\/(\d{4})/i.exec(text ?? '');
  if (!m) return null;
  return new Date(Date.UTC(Number(m[2]), Number(m[1]) * 3, 0, 23, 59, 59));
}

/** Feed status text has inconsistent casing ("Out of maintenance" / "Out of Maintenance"). */
export function normaliseStatus(text) {
  const s = (text ?? '').trim().toLowerCase();
  if (s === 'maintenance') return 'maintenance';
  if (s === 'out of maintenance') return 'out-of-maintenance';
  if (s === 'skipped') return 'skipped';
  return 'unknown';
}

export function parseVersion(text) {
  const m = VERSION_RE.exec(String(text ?? '').trim().replace(/^[\^~>=v\s]+/, ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] === undefined ? null : Number(m[3]) };
}

/** Turns the raw feed into lookup maps. */
export function indexFeed(feed) {
  const minors = new Map();
  let fallback = null;
  for (const v of feed.versions ?? []) {
    const entry = {
      label: v.version,
      status: normaliseStatus(v.support),
      lts: v.lts === true,
      eom: parseQuarter(v.eom),
      eomm: parseQuarter(v.eomm),
      eomText: v.eom || '',
      eocp: parseQuarter(v.eocp),
    };
    if (v.version === '*') fallback = entry;
    else minors.set(v.version.replace(/\.\*$/, ''), entry);
  }
  const patches = new Map();
  const latestPatch = new Map();
  for (const p of feed.patches ?? []) {
    const pv = parseVersion(p.version);
    if (!pv || pv.patch === null || /-/.test(p.version)) continue; // skip "-legacy-free" style variants
    patches.set(p.version, {
      eocp: parseQuarter(p.extended_eocp) ?? parseQuarter(p.eocp),
      removed: p.removed === true,
    });
    const key = `${pv.major}.${pv.minor}`;
    if (!p.removed && (latestPatch.get(key) ?? -1) < pv.patch) latestPatch.set(key, pv.patch);
  }
  return { minors, patches, latestPatch, fallback };
}

// ---------- evaluation ----------


/**
 * The feed carries two end-of-maintenance dates per version: "eomm" is the one SAP shows on
 * the version overview page for SAP BTP, "eom" is a second, often later one.
 */
function endOfMaintenance(minor, maintenanceDate) {
  const dates = [minor.eom, minor.eomm].filter(Boolean);
  if (maintenanceDate === 'earliest') return dates.length ? new Date(Math.min(...dates)) : null;
  return minor[maintenanceDate] ?? minor.eom ?? minor.eomm ?? null;
}

/**
 * The version to move to: the long-term maintenance version whose maintenance runs longest
 * (the newer one on a tie). Returns null when the feed lists none that is still maintained.
 */
export function recommend(index, { now, maintenanceDate }) {
  let best = null;
  for (const [key, minor] of index.minors) {
    if (!minor.lts || minor.status !== 'maintenance') continue;
    const end = endOfMaintenance(minor, maintenanceDate);
    if (!end || end <= now) continue;
    const v = parseVersion(key);
    const better = !best || end > best.end || (end.getTime() === best.end.getTime() && (v.major > best.major || (v.major === best.major && v.minor > best.minor)));
    if (better) best = { key, end, major: v.major, minor: v.minor };
  }
  if (!best) return null;
  return { ...best, text: `UI5 ${best.key} is in long-term maintenance until ${fmt(best.end)}` };
}

/**
 * Evaluates one detected version against the feed.
 * usage.kind: 'framework' | 'preview' | 'bootstrap' | 'workzone' | 'minUI5Version' | 'deployed'
 */
export function evaluate(usage, index, { now, requireLts, warnDays, maintenanceDate }) {
  const base = { check: 'ui5-version', source: usage.kind, file: usage.file, version: usage.version };
  const v = parseVersion(usage.version);
  if (!v) {
    return [{ ...base, severity: 'warn', message: `Could not parse UI5 version "${usage.version}".` }];
  }
  const key = `${v.major}.${v.minor}`;
  const minor = index.minors.get(key);
  const isFloor = usage.kind === 'minUI5Version';
  // minUI5Version is only a lower bound and says nothing about the version the app runs on,
  // and a local test page is never deployed: both are reported, but as info at most.
  const quiet = isFloor || usage.testPage;
  const cap = (sev) => (quiet && (sev === 'error' || sev === 'warn') ? 'info' : sev);
  // say where the version came from when that changes how much it matters
  const label = (message) => (isFloor ? message.replace(/^UI5 /, 'minUI5Version ') : usage.testPage ? `Local test page: ${message}` : message);
  const findings = [];
  const add = (severity, message, details) => findings.push({ ...base, severity: cap(severity), message: label(message), ...(details && Object.keys(details).length ? { details } : {}) });

  const end = minor ? endOfMaintenance(minor, maintenanceDate) : null;
  // Findings about the release line itself carry what to move to, when there is something newer.
  const rec = recommend(index, { now, maintenanceDate });
  const useRec = rec && (rec.minor > v.minor || rec.major > v.major);
  const recDetails = useRec ? { recommended: rec.key } : {};

  if (!minor) {
    add('error', `UI5 ${key} is not listed in the version overview; treat it as out of maintenance.`, recDetails);
    if (useRec) {
      findings[0].recommendation = rec.text;
      act(findings[0], usage.kind, rec.key, index.latestPatch.get(rec.key), usage.host);
    }
    return findings;
  }

  if (minor.status === 'out-of-maintenance') {
    // Only quote the date when it agrees with the status; the feed can list a later date.
    add('error', `UI5 ${key} is out of maintenance${end && end < now ? ` (ended ${fmt(end)})` : ''}.`, recDetails);
  } else if (minor.status === 'skipped') {
    add('error', `UI5 ${key} was never released (${minor.eomText || 'skipped'}).`, recDetails);
  } else if (minor.status === 'unknown') {
    add('warn', `UI5 ${key} has an unrecognised support status in the feed.`);
  } else {
    if (requireLts && !minor.lts) {
      add('warn', `UI5 ${key} is in maintenance but is not a long-term maintenance version.`);
    }
    if (end) {
      const days = Math.ceil((end - now) / DAY);
      // The feed's status decides what is an error; a passed date it has not caught up with is a warning.
      if (days < 0) add('warn', `UI5 ${key} passed its end of maintenance date (${fmt(end)}), although SAP's feed still lists it as in maintenance.`, recDetails);
      else if (days <= warnDays) add('warn', `UI5 ${key} reaches end of maintenance on ${fmt(end)} (${days} days).`, { daysLeft: days, ...recDetails });
    }
  }

  // Patch-level facts only matter where an exact patch is loaded from the CDN or installed.
  if (v.patch !== null && !isFloor) {
    const full = `${key}.${v.patch}`;
    const patch = index.patches.get(full);
    const onCdn = usage.kind === 'bootstrap' || usage.kind === 'workzone';
    if (patch?.removed) {
      add(onCdn ? 'error' : 'warn', `UI5 ${full} has been removed from the SAP CDN.`);
    } else if (patch?.eocp && onCdn) {
      const days = Math.ceil((patch.eocp - now) / DAY);
      if (days < 0) add('error', `UI5 ${full} is past its end of cloud provisioning (${fmt(patch.eocp)}) and may be removed from the CDN.`);
      else if (days <= warnDays) add('warn', `UI5 ${full} will be removed from the CDN after ${fmt(patch.eocp)} (${days} days).`, { daysLeft: days });
    }
    const latest = index.latestPatch.get(key);
    const newerPatch = minor.status === 'maintenance' && latest !== undefined && latest > v.patch;
    if (newerPatch) {
      add('info', `Newer patch available: ${key}.${latest} (using ${full}).`, { latest: `${key}.${latest}` });
    }
    // A patch problem on a line that is still maintained is fixed by its newest patch.
    for (const f of findings) {
      if (newerPatch && !f.details?.recommended && f.message.includes(full)) act(f, usage.kind, key, latest, usage.host);
    }
  }

  for (const f of findings) {
    if (f.details?.recommended) {
      f.recommendation = rec.text;
      act(f, usage.kind, rec.key, index.latestPatch.get(rec.key), usage.host);
    } else if (!f.action && useRec && /removed from the SAP CDN|cloud provisioning/.test(f.message)) {
      // the patch is gone and the whole line should be left: move to the recommended line
      f.recommendation = rec.text;
      act(f, usage.kind, rec.key, index.latestPatch.get(rec.key), usage.host);
    }
  }

  if (findings.length === 0) {
    add('ok', `UI5 ${usage.version} is a supported${minor.lts ? ' long-term maintenance' : ''} version.`);
  }
  return findings;
}

// ---------- detection ----------

/** Finds `framework: { version }` in a ui5.yaml without a YAML dependency. */
export function versionFromUi5Yaml(text) {
  return frameworkVersionLine(text.split(/\r?\n/))?.version ?? null;
}

/** The line of a ui5.yaml that holds framework.version: { index, version }, or null. */
export function frameworkVersionLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!/^framework:\s*(#.*)?$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\S/.test(lines[j])) break; // left the framework block
      const m = /^\s+version:\s*["']?([^"'\s#]+)/.exec(lines[j]);
      if (m) return { index: j, version: m[1] };
    }
  }
  return null;
}

/**
 * Finds the UI5 source of the SAP Fiori tools preview proxy in a ui5.yaml:
 *   - name: fiori-tools-proxy
 *     configuration:
 *       ui5: { path: [...], url: https://ui5.sap.com, version: 1.120.0 }
 * Returns { version } (null when none is set, which means "latest"), or null when the
 * file has no such block.
 */
export function previewFromUi5Yaml(text) {
  const found = previewVersionLine(text.split(/\r?\n/));
  return found && { version: found.version };
}

/**
 * Where previewFromUi5Yaml finds its answer: { index, version, block }, where index is the line
 * of the version (null when there is none; version is null when it is not a version too) and
 * block the line of "ui5:", or null when there is no fiori-tools-proxy ui5 block.
 */
export function previewVersionLine(lines) {
  const indent = (line) => line.length - line.trimStart().length;
  const start = lines.findIndex((l) => /^\s*-?\s*name:\s*["']?fiori-tools-proxy["']?\s*$/.test(l));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s*name:/.test(lines[i])) break; // next middleware
    if (!/^\s+ui5:\s*(#.*)?$/.test(lines[i])) continue;
    const depth = indent(lines[i]);
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '' || lines[j].trim().startsWith('#')) continue;
      if (indent(lines[j]) <= depth) break;
      const m = /^\s+version:\s*["']?([^"'\s#]*)/.exec(lines[j]);
      if (m) return { index: j, version: VERSION_RE.test(m[1]) ? m[1] : null, block: i };
    }
    return { index: null, version: null, block: i };
  }
  return null;
}

/** Versions in bootstrap URLs on the given CDN hosts; null stands for an unversioned URL. */
export function versionsFromHtml(text, cdnHosts) {
  return bootstrapsFromHtml(text, cdnHosts).map((b) => b.version);
}

/** Like versionsFromHtml, with the host each bootstrap URL loads from. */
export function bootstrapsFromHtml(text, cdnHosts) {
  if (cdnHosts.length === 0) return [];
  const re = new RegExp(`https?://(${cdnHosts.map(escapeRe).join('|')})/(?:(\\d+\\.\\d+(?:\\.\\d+)?)/)?resources/sap-ui-core\\.js`, 'g');
  return [...text.matchAll(re)].map((m) => ({ host: m[1], version: m[2] ?? null }));
}

/**
 * What to change, in the file where the version was found, to use UI5 `line` (e.g. "1.148").
 * `patch` is the newest patch of that line, for places that need an exact version.
 */
export function ui5Action(kind, line, patch, host = 'ui5.sap.com') {
  const exact = `${line}.${patch ?? 0}`;
  switch (kind) {
    case 'framework': return `Set framework.version to ${exact}`;
    case 'preview': return `Set the version in the fiori-tools-proxy ui5 block to ${exact}`;
    case 'bootstrap': return `Load a fixed version: https://${host}/${exact}/resources/sap-ui-core.js`;
    case 'workzone': return `Set "sap.platform.cf".ui5VersionNumber to ${line}.x`;
    case 'workzone-missing': return `Add "sap.platform.cf": { "ui5VersionNumber": "${line}.x" } to the manifest`;
    case 'minUI5Version': return `Raise minUI5Version to ${line}.0`;
    case 'deployed': return `Upgrade the system to UI5 ${line}`;
    default: return undefined;
  }
}

/**
 * The same change as ui5Action, as data that src/fix can apply to the file: { kind, to, host? }.
 * Only places that are a version in a file the project owns; minUI5Version is a statement
 * of support, not a version to move, so it is never changed automatically.
 */
export function ui5Fix(kind, line, patch, host) {
  switch (kind) {
    case 'framework':
    case 'preview':
      return patch === undefined ? undefined : { kind: `ui5-${kind}`, to: `${line}.${patch}` };
    case 'bootstrap':
      return patch === undefined ? undefined : { kind: 'ui5-bootstrap', to: `${line}.${patch}`, host };
    case 'workzone':
    case 'workzone-missing':
      return { kind: `ui5-${kind}`, to: `${line}.x` };
    default:
      return undefined;
  }
}

/** Sets a finding's action and the fix that carries it out. */
function act(finding, kind, line, patch, host) {
  finding.action = ui5Action(kind, line, patch, host);
  const fix = ui5Fix(kind, line, patch, host);
  if (fix) finding.fix = fix;
  else delete finding.fix;
}

/**
 * Reads the UI5-relevant parts of a manifest.json.
 * - minUI5Version: lower bound the app declares
 * - pinned: "sap.platform.cf".ui5VersionNumber, the version SAP Build Work Zone loads for
 *   this app ("1.136.5", or "1.136.x" for the latest patch)
 * - btp: the app is deployed to the BTP HTML5 repository ("sap.cloud" is present)
 */
export function readManifest(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const str = (v) => (typeof v === 'string' && VERSION_RE.test(v) ? v : null);
  const min = json?.['sap.ui5']?.dependencies?.minUI5Version;
  return {
    minUI5Version: str(Array.isArray(min) ? min[0] : min),
    pinned: str(json?.['sap.platform.cf']?.ui5VersionNumber),
    btp: json?.['sap.cloud'] !== undefined || json?.['sap.platform.cf'] !== undefined,
  };
}

export async function detect(root, files, cfg) {
  // "Always latest" is fine in general, but breaks a long-term-maintenance-only policy.
  const latestSeverity = cfg.requireLts ? 'warn' : 'info';
  const yamlRe = new RegExp(cfg.yamlPattern);
  const htmlRe = new RegExp(cfg.htmlPattern);
  const testPathRe = new RegExp(cfg.testPagePattern);
  const testContentRe = new RegExp(cfg.testPageContent);
  const manifestRe = new RegExp(cfg.manifestPattern);
  const usages = [];
  const notes = [];
  for (const file of files) {
    const read = () => readFile(join(root, file), 'utf8');
    if (yamlRe.test(file)) {
      const text = await read();
      const version = versionFromUi5Yaml(text);
      if (version) usages.push({ kind: 'framework', file, version });
      const preview = previewFromUi5Yaml(text);
      if (preview?.version) usages.push({ kind: 'preview', file, version: preview.version });
      else if (preview) notes.push({
        check: 'ui5-version', severity: 'info', source: 'preview', file, local: true,
        message: 'Local preview (fiori-tools-proxy) loads the latest UI5 release, which can differ from the version the app runs on when deployed.',
      });
    } else if (htmlRe.test(file)) {
      const html = await read();
      // Local test pages (a launchpad sandbox, QUnit pages) are served during development only.
      const testPage = testPathRe.test(file) || testContentRe.test(html);
      for (const { version, host } of bootstrapsFromHtml(html, cfg.cdnHosts)) {
        if (version) usages.push({ kind: 'bootstrap', file, version, host, testPage });
        else notes.push({
          check: 'ui5-version', severity: testPage ? 'info' : latestSeverity, source: 'bootstrap', file, host,
          message: testPage
            ? 'Local test page loads UI5 from the CDN without a version, so it always gets the latest release.'
            : 'Bootstrap loads UI5 from the CDN without a version, so it always gets the latest release, not a long-term maintenance version.',
        });
      }
    } else if (manifestRe.test(file)) {
      const m = readManifest(await read());
      if (!m) continue;
      if (m.minUI5Version) usages.push({ kind: 'minUI5Version', file, version: m.minUI5Version });
      if (m.pinned) usages.push({ kind: 'workzone', file, version: m.pinned });
      else if (m.btp) notes.push({
        check: 'ui5-version', severity: latestSeverity, source: 'workzone', file,
        message: 'No "sap.platform.cf".ui5VersionNumber in the manifest, so SAP Build Work Zone loads the latest SAPUI5 release, not a long-term maintenance version.',
      });
    }
  }
  return { usages, notes };
}

// ---------- check entry point ----------

export const ui5Check = {
  id: 'ui5-version',
  description: 'UI5 versions in use are supported long-term maintenance versions',
  async run(ctx) {
    const cfg = ctx.config.ui5;
    const { usages, notes } = await detect(ctx.root, ctx.files, cfg);
    const findings = [...notes];
    const previews = notes.filter((n) => n.local && n.source === 'preview');

    // Running systems: each probe URL must return JSON with a top-level "version"
    // (the shape of <ui5-root>/resources/sap-ui-version.json).
    for (const probe of cfg.probes ?? []) {
      try {
        const json = await ctx.fetchJson(probe.url);
        if (!json?.version) throw new Error('response has no "version" field');
        usages.push({ kind: 'deployed', file: probe.name ?? probe.url, version: json.version });
      } catch (err) {
        findings.push({
          check: 'ui5-version', severity: 'warn', source: 'deployed', file: probe.name ?? probe.url,
          message: `Could not read the deployed UI5 version: ${err.message}`,
        });
      }
    }

    // The feed is only needed when there is a version to judge or a pin to recommend.
    if (usages.length === 0 && notes.every((n) => n.local)) {
      for (const note of notes) {
        delete note.local;
        delete note.host;
      }
      return findings;
    }
    const index = indexFeed(await loadFeed(cfg.feed, ctx.fetchJson));
    const opts = { now: ctx.now, requireLts: cfg.requireLts, warnDays: cfg.warnDays, maintenanceDate: cfg.maintenanceDate };
    // Notes are about apps that run on "latest" because nothing is pinned: carry what to pin.
    const rec = recommend(index, opts);
    if (rec) {
      for (const note of notes) {
        if (note.local) continue;
        note.recommendation = rec.text;
        note.details = { recommended: rec.key };
        act(note, note.source === 'workzone' ? 'workzone-missing' : note.source, rec.key, index.latestPatch.get(rec.key), note.host);
      }
    }
    for (const note of notes) {
      delete note.local;
      delete note.host;
    }
    for (const usage of usages) findings.push(...evaluate(usage, index, opts));
    const latest = rec && index.latestPatch.has(rec.key) ? `${rec.key}.${index.latestPatch.get(rec.key)}` : null;
    for (const note of previews) pinPreview(note, usages, findings, latest);
    return findings;
  },
};

/**
 * A local preview that loads the latest release is pinned to the version the app builds with:
 * framework.version in a ui5*.yaml of the same folder (SAP Fiori tools keeps it in
 * ui5-local.yaml), after any change the findings make to it, so the two stay alike. Without
 * one it is pinned to `latest`, the newest patch of the recommended version.
 */
function pinPreview(note, usages, findings, latest) {
  const dir = (file) => file.replace(/[^/]*$/, '');
  const later = (a, b) => {
    const [pa, pb] = [parseVersion(a), parseVersion(b)];
    return pa.major - pb.major || pa.minor - pb.minor || (pa.patch ?? 0) - (pb.patch ?? 0);
  };
  const frameworks = usages.filter((u) => u.kind === 'framework' && dir(u.file) === dir(note.file));
  const built = frameworks.map((u) => findings.find((f) => f.file === u.file && f.fix?.kind === 'ui5-framework')?.fix.to ?? u.version);
  const to = built.filter((v) => parseVersion(v)?.patch != null).sort(later).at(-1) ?? latest;
  if (!to) return;
  note.action = `Set the version in the fiori-tools-proxy ui5 block to ${to}${frameworks.length ? ', the version the app builds with' : ''}`;
  note.fix = { kind: 'ui5-preview-missing', to };
}
