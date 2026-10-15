import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DAY = 24 * 60 * 60 * 1000;

/** Date as YYYY-MM-DD. */
export const fmt = (d) => d.toISOString().slice(0, 10);

/** Whole days from now until date; negative when the date has passed. */
export const daysUntil = (date, now) => Math.ceil((date - now) / DAY);

/**
 * A feed setting is a URL, or a path to a downloaded copy for networks that block the URL.
 * `fetchImpl` gets the URL; `parse` turns file content into the same shape (default: JSON).
 */
export async function loadFeed(feed, fetchImpl, parse = JSON.parse) {
  if (/^https?:\/\//i.test(feed)) return fetchImpl(feed);
  return parse(await readFile(resolve(feed), 'utf8'));
}
