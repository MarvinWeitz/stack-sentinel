import { versionsFromCi, versionsFromDockerfile } from '../checks/node.js';
import { frameworkVersionLine, previewVersionLine } from '../checks/ui5.js';

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Applies one finding's fix to the text of its file. Every edit changes only the value it
 * is about and keeps the rest of the file as it is. Returns { text } with the new content,
 * or { skipped } with the reason when the file no longer holds what the finding saw, so a
 * file that changed since the scan is never overwritten.
 */
export function applyFix(text, finding) {
  const { fix, version } = finding;
  switch (fix.kind) {
    case 'ui5-framework': return yamlLine(text, frameworkVersionLine, version, fix.to);
    case 'ui5-preview': return yamlLine(text, previewVersionLine, version, fix.to);
    case 'ui5-bootstrap': return bootstrap(text, fix.host, version, fix.to);
    case 'ui5-workzone': return workzone(text, version, fix.to);
    case 'ui5-workzone-missing': return workzoneMissing(text, fix.to);
    case 'npm-override-remove': return removeOverride(text, fix.path);
    case 'node-engines': return engines(text, version, fix.to);
    case 'node-version-file': return versionFile(text, version, fix.to);
    case 'node-ci': return onLines(text, versionsFromCi(text).find((v) => v.value === version), version, fix.to);
    case 'node-container': return onLines(text, versionsFromDockerfile(text).find((v) => v.value === version && v.suffix === (fix.suffix ?? '')), version, fix.to, /(node:)/);
    default: return { skipped: `unknown fix "${fix.kind}"` };
  }
}

/** Replaces the version on the line `locate` finds, keeping quotes and comments. */
function yamlLine(text, locate, from, to) {
  const lines = text.split('\n');
  const found = locate(lines.map((l) => l.replace(/\r$/, '')));
  if (found?.index == null || found.version !== from) return { skipped: `version ${from} not found` };
  lines[found.index] = lines[found.index].replace(/^(\s+version:\s*["']?)[^"'\s#]+/, `$1${to}`);
  return { text: lines.join('\n') };
}

/** Points bootstrap URLs on `host` at version `to`; `from` null means URLs without a version. */
function bootstrap(text, host, from, to) {
  const re = new RegExp(`(https?://${escapeRe(host)}/)${from ? `${escapeRe(from)}/` : ''}(resources/sap-ui-core\\.js)`, 'g');
  if (!re.test(text)) return { skipped: `no bootstrap URL for ${from ?? 'the latest version'} on ${host}` };
  return { text: text.replace(re, `$1${to}/$2`) };
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function workzone(text, from, to) {
  const re = new RegExp(`("ui5VersionNumber"\\s*:\\s*")${escapeRe(from)}"`, 'g');
  if ((text.match(re) ?? []).length !== 1) return { skipped: `ui5VersionNumber ${from} not found once` };
  const out = text.replace(re, `$1${to}"`);
  return parse(out)?.['sap.platform.cf']?.ui5VersionNumber === to ? { text: out } : { skipped: 'the manifest did not read back as expected' };
}

/** The indent of the first nested line, e.g. "  " or "\t"; two spaces when there is none. */
const indentOf = (text) => /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';

/** Adds "sap.platform.cf": { "ui5VersionNumber": to }, into an existing block or at the end of the manifest. */
function workzoneMissing(text, to) {
  const json = parse(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { skipped: 'the manifest is not a JSON object' };
  if (json['sap.platform.cf']?.ui5VersionNumber !== undefined) return { skipped: 'ui5VersionNumber is already set' };
  const ind = indentOf(text);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  let out;
  if (json['sap.platform.cf'] !== undefined) {
    const block = /("sap\.platform\.cf"\s*:\s*\{)(\s*)(\}?)/.exec(text);
    if (!block || text.split('"sap.platform.cf"').length !== 2) return { skipped: '"sap.platform.cf" not found once' };
    const at = block.index + block[1].length;
    const inner = `${ind}${ind}"ui5VersionNumber": "${to}"`;
    out = block[3]
      ? `${text.slice(0, at)}${nl}${inner}${nl}${ind}${text.slice(at + block[2].length)}` // an empty block
      : `${text.slice(0, at)}${nl}${inner},${text.slice(at)}`;
  } else {
    const end = text.lastIndexOf('}');
    const last = text.slice(0, end).trimEnd();
    const comma = last.endsWith('{') ? '' : ',';
    out = `${last}${comma}${nl}${ind}"sap.platform.cf": {${nl}${ind}${ind}"ui5VersionNumber": "${to}"${nl}${ind}}${nl}${text.slice(end)}`;
  }
  return parse(out)?.['sap.platform.cf']?.ui5VersionNumber === to ? { text: out } : { skipped: 'the manifest did not read back as expected' };
}

/**
 * Removes an entry from "overrides" in a package.json, and the objects that are left empty.
 * The file is written back the way npm writes it, so only a file already in that layout is
 * changed; anything else would rewrite lines that have nothing to do with the override.
 */
function removeOverride(text, path) {
  const json = parse(text);
  const ind = indentOf(text);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const write = (obj) => JSON.stringify(obj, null, ind).replace(/\n/g, nl) + (/\r?\n$/.test(text) ? nl : '');
  if (!json || write(json) !== text) return { skipped: 'package.json is not laid out the way npm writes it' };
  const chain = [json.overrides];
  for (const key of path.slice(0, -1)) chain.push(chain.at(-1)?.[key]);
  const last = path.at(-1);
  if (!chain.at(-1) || typeof chain.at(-1) !== 'object' || !(last in chain.at(-1))) return { skipped: 'the override is not there any more' };
  delete chain.at(-1)[last];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length === 0) delete chain[i - 1][path[i - 1]];
  }
  if (Object.keys(json.overrides).length === 0) delete json.overrides;
  return { text: write(json) };
}

/** Sets "engines.node" in a package.json, where it says `from`. */
function engines(text, from, to) {
  const re = new RegExp(`("engines"\\s*:\\s*\\{[^{}]*?"node"\\s*:\\s*")${escapeRe(from)}(\\s*")`, 'g');
  if ((text.match(re) ?? []).length !== 1) return { skipped: `"engines.node" "${from}" not found once` };
  const out = text.replace(re, `$1${to}$2`);
  return parse(out)?.engines?.node === to ? { text: out } : { skipped: 'package.json did not read back as expected' };
}

/** Changes the version in a .nvmrc or .node-version, keeping comments. */
function versionFile(text, from, to) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.replace(/#.*$/, '').trim() !== '');
  if (i === -1 || lines[i].replace(/#.*$/, '').trim() !== from) return { skipped: `version ${from} not found` };
  lines[i] = lines[i].replace(from, to);
  return { text: lines.join('\n') };
}

/**
 * Replaces `from` with `to` on the lines a reader found it on (`found.lines`), in the value
 * after the key, or after `anchor` (the image name in a FROM line).
 */
function onLines(text, found, from, to, anchor = /(:\s*["']?)/) {
  if (!found) return { skipped: `version ${from} not found` };
  const lines = text.split('\n');
  const re = new RegExp(`${anchor.source}${escapeRe(from)}(?![\\w.])`);
  for (const i of found.lines) lines[i] = lines[i].replace(re, `$1${to}`);
  return { text: lines.join('\n') };
}
