import { capCheck } from './cap.js';
import { cfNodeCheck } from './cf-node.js';
import { licenseCheck } from './license.js';
import { nodeCheck } from './node.js';
import { npmAuditCheck } from './npm-audit.js';
import { ui5Check } from './ui5.js';

/**
 * Registry of checks. Each check is { id, description, run(ctx) -> Promise<Finding[]> }.
 * ctx: { root, files, config, now, fetchJson, fetchText, postJson }
 * Finding: { check, severity, source, file?, version?, message, details? }
 */
export const checks = [ui5Check, nodeCheck, cfNodeCheck, capCheck, npmAuditCheck, licenseCheck];

/**
 * Decides which checks run from the resolved settings (`checks` = run only these,
 * `skipChecks` = run all except these). Default: every check runs.
 * Unknown ids throw, so a typo cannot silently switch monitoring off.
 */
export function selectChecks({ checks: only, skipChecks: skip = [] } = {}, all = checks) {
  if (only && only.length === 0) only = undefined;
  const known = new Set(all.map((c) => c.id));
  const unknown = [...(only ?? []), ...skip].filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error(`Unknown check(s): ${[...new Set(unknown)].join(', ')}. Available: ${[...known].join(', ')}`);
  }
  const selected = all.filter((c) => (!only || only.includes(c.id)) && !skip.includes(c.id));
  if (selected.length === 0) throw new Error('The check selection leaves nothing to run.');
  return { selected, skipped: all.filter((c) => !selected.includes(c)).map((c) => c.id) };
}
