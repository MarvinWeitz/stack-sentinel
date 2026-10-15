import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Recursively lists files under root as paths relative to root, always with "/" separators. */
export async function listFiles(root, { exclude, maxDepth }) {
  const skip = new Set(exclude);
  const out = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name) && depth < maxDepth) await walk(full, depth + 1);
      } else if (e.isFile()) {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  }
  await walk(root, 0);
  return out.sort();
}
