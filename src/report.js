import { rank } from './severity.js';

/**
 * Merges findings that say the same thing about different files, so a repository with
 * many apps produces one line per problem instead of one per file. Order: worst first.
 */
export function groupFindings(findings) {
  const groups = new Map();
  for (const f of findings) {
    // the same problem found in different kinds of places can need different fixes
    const key = `${f.severity}\u0000${f.message}\u0000${f.action ?? ''}`;
    if (!groups.has(key)) groups.set(key, { severity: f.severity, message: f.message, action: f.action, files: [] });
    if (f.file && !groups.get(key).files.includes(f.file)) groups.get(key).files.push(f.file);
  }
  return [...groups.values()].sort((a, b) => rank(b.severity) - rank(a.severity));
}

/** "a.html" / "3 files: a, b, c" / "12 files: a, b, c and 9 more". */
export function describeFiles(files, maxNames = 3) {
  if (files.length === 0) return '';
  if (files.length === 1) return files[0];
  const names = files.slice(0, maxNames).join(', ');
  const rest = files.length - maxNames;
  return `${files.length} files: ${names}${rest > 0 ? ` and ${rest} more` : ''}`;
}

/** The distinct recommendations carried by a set of findings, in order of first appearance. */
export function recommendations(findings) {
  return [...new Set(findings.map((f) => f.recommendation).filter(Boolean))];
}
