export const LEVELS = ['ok', 'info', 'warn', 'error'];

export function rank(severity) {
  const i = LEVELS.indexOf(severity);
  if (i === -1) throw new Error(`Unknown severity "${severity}" (use ${LEVELS.join(', ')})`);
  return i;
}

export function worst(severities) {
  return severities.reduce((a, b) => (rank(b) > rank(a) ? b : a), 'ok');
}

export function atLeast(severity, threshold) {
  return rank(severity) >= rank(threshold);
}
