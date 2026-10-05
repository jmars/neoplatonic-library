#!/usr/bin/env node
/**
 * tools/migrate-readings.mjs — seeds `edition.readings[]` (extraction plan §2.4).
 *
 *   node tools/migrate-readings.mjs --from /home/jaye/enlighten [--write]
 *
 * THE ONE MIGRATION SCRIPT THAT READS THE BLOG'S POSTS. It is not part of the
 * build (build/build.mjs never imports it): the blog is a READ-ONLY source that
 * is consulted once, here, and the readings it derives are frozen into
 * `data/editions/<slug>/edition.json`. The build afterwards renders the frozen
 * list as links out to the blog (model §6) and never computes it.
 *
 * WHAT IS DERIVED (the blog's own citation derivation, re-implemented):
 *
 *   A reading is a blog post whose subject is a library text. A text names the
 *   catalogue works it IS — the shelf entry's `cat` field — and a post reads the
 *   text when the post's FOOTNOTE DEFINITIONS match one of those works' match
 *   rules in tools/catalogue.json (`citations()` in the blog's tools/build.mjs,
 *   re-derived here so it can be re-run when the blog publishes new readings);
 *   PLUS any post whose markdown links `/library/<slug>/`, which is a direct
 *   statement about the edition that needs no catalogue entry.
 *
 * MEASURED, 2026-10-04 (the plan's own measurement, reproduced):
 *   proclus-elements-of-theology-taylor-1816  <- proclus-elements-of-theology,
 *                                                proclus-theology-of-plato
 *   porphyry-on-the-cave-of-the-nymphs-taylor-1917 <- porphyry-cave-of-the-nymphs
 * The porphyry edition carries `cat: []` (the Cave has no catalogue entry), so
 * its one reading comes from the `/library/` link alone. The result is written
 * SORTED (by slug), the order the plan records; the blog's own page renders them
 * in post-index order, which is the same set in a different order.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'data', 'editions');

const argv = process.argv.slice(2);
const fromFlag = argv.indexOf('--from');
const BLOG = fromFlag >= 0 ? argv[fromFlag + 1] : '/home/jaye/enlighten';
const WRITE = argv.includes('--write');

if (!existsSync(join(BLOG, 'posts.json')) || !existsSync(join(BLOG, 'tools', 'catalogue.json'))) {
  throw new Error(`not a blog checkout (no posts.json / tools/catalogue.json): ${BLOG}`);
}

const manifest = JSON.parse(readFileSync(join(BLOG, 'posts.json'), 'utf8'));
const catalogue = JSON.parse(readFileSync(join(BLOG, 'tools', 'catalogue.json'), 'utf8'));
const works = catalogue.sources;
const posts = manifest.posts.filter((p) => p.published);

/** The blog's footnote-definition reader (tools/build.mjs `footnoteDefs`),
 * re-implemented verbatim: a definition is a run of lines opened by
 * `[^label]:` and continued until a blank line. */
function footnoteDefs(src) {
  const out = [];
  let cur = null;
  for (const line of src.split('\n')) {
    const m = /^[ \t]*\[\^[^\]]+\]:/.exec(line);
    if (m) {
      if (cur !== null) out.push(cur);
      cur = line.slice(m[0].length);
      continue;
    }
    if (cur === null) continue;
    if (!line.trim()) {
      out.push(cur);
      cur = null;
      continue;
    }
    cur += ' ' + line.trim();
  }
  if (cur !== null) out.push(cur);
  return out.map((d) => d.replace(/\s+/g, ' ').trim());
}

const srcOf = new Map();
for (const p of posts) {
  const file = join(BLOG, 'content', p.file);
  srcOf.set(p.slug, existsSync(file) ? readFileSync(file, 'utf8') : '');
}

/* which posts cite each catalogue work — the exact `citations()` derivation */
const matchers = works.map((w) => {
  try {
    return new RegExp(w.match, 'i');
  } catch {
    return null;
  }
});
const citing = works.map(() => []);
for (const p of posts) {
  const defs = footnoteDefs(srcOf.get(p.slug) || '');
  for (let k = 0; k < works.length; k++) {
    const re = matchers[k];
    if (!re) continue;
    for (const d of defs) {
      if (re.test(d)) {
        citing[k].push(p.slug);
        break;
      }
    }
  }
}
const at = new Map(works.map((w, k) => [w.id, k]));

const byEdition = new Map();
for (const p of posts) {
  const linked = (srcOf.get(p.slug) || '').match(/\/library\/([a-z0-9-]+)\//g) || [];
  for (const l of linked) {
    const slug = l.slice('/library/'.length, -1);
    if (!byEdition.has(slug)) byEdition.set(slug, new Set());
    byEdition.get(slug).add(p.slug);
  }
}

let changed = 0;
for (const dir of readdirSafe(LIB)) {
  const file = join(LIB, dir, 'edition.json');
  if (!existsSync(file)) continue;
  const e = JSON.parse(readFileSync(file, 'utf8'));
  const seen = new Set();
  for (const id of e.cat || []) {
    const k = at.get(id);
    if (k == null) continue;
    for (const s of citing[k]) seen.add(s);
  }
  for (const s of byEdition.get(e.slug) || []) seen.add(s);
  const readings = [...seen].sort();
  const now = JSON.stringify(e.readings || []);
  const want = JSON.stringify(readings);
  console.log(`${e.slug}: readings = [${readings.join(', ')}]${now === want ? '' : '  (CHANGED)'}`);
  if (now !== want) {
    changed++;
    if (WRITE) {
      e.readings = readings;
      writeFileSync(file, `${JSON.stringify(e, null, 2)}\n`);
    }
  }
}
console.log(
  changed === 0
    ? 'migrate-readings: every edition.json already matches the blog derivation'
    : `migrate-readings: ${changed} edition(s) differ${WRITE ? ' (written)' : ' — re-run with --write to seed'}`,
);

function readdirSafe(d) {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
