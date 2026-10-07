#!/usr/bin/env node
/**
 * tools/heads-probe.mjs — the vision-heads cache cannot go stale silently.
 *
 *     node tools/heads-probe.mjs [slug]
 *
 * Checks `data/editions/<slug>/heads.json` (default: the Theology of Plato, the
 * one edition the cache exists for) against the scans on disk:
 *
 *  1. IDENTITY. The file records an `imageSet` digest — sha256 over the scans'
 *     `name:byteSize` lines, sorted, the same identity `tools/vision-heads.mjs`
 *     refuses to mismatch — and it equals the one computed over the scans NOW on
 *     disk. FAILS IF the file records no identity (a pre-guard cache), or records
 *     one that the current scans do not hash to: the edition was re-sourced once
 *     and 423 leaf names collided across the two image sets with every surviving
 *     reading taken from different bytes — a digest mismatch is that defect,
 *     caught before anything reads the file.
 *
 *  2. COVERAGE. The file's leaf set EQUALS the scan set, both directions: no
 *     reading for a leaf that is not on disk (the stale cache carried 299 such
 *     keys), and no scan left unread (377 of 800 went unread in it).
 *     FAILS IF either direction diverges.
 *
 *  3. PROVENANCE. The file names the model that read it (top level and per
 *     record), the prompt id and hash its readings were taken under, and when the
 *     run started and finished; no record is left without `at`/`model`; no
 *     `unread` list lingers (a run that left failures re-runs before this probe
 *     passes). FAILS IF any of that is missing — a reading that cannot say what
 *     read it, when, and against what image set is not evidence.
 *
 * `divisions.mjs` and `vision-unsure.mjs` read this cache; the divisions probe
 * covers the derived model. This probe covers the cache itself.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2] || 'proclus-theology-of-plato-taylor-1816';
const dir = join(ROOT, 'data', 'editions', slug);
const headsPath = join(dir, 'heads.json');
const scanDir = join(dir, 'scans');

let fails = 0;
const fail = (m) => {
  fails++;
  console.error(`FAIL: ${m}`);
};

if (!existsSync(headsPath)) {
  console.error(`FAIL: no heads.json at ${headsPath}`);
  process.exit(1);
}
if (!existsSync(scanDir)) {
  console.error(`FAIL: no scans at ${scanDir}`);
  process.exit(1);
}
const heads = JSON.parse(readFileSync(headsPath, 'utf8'));
const scans = readdirSync(scanDir)
  .filter((f) => /\.(?:jpe?g|png|webp)$/i.test(f))
  .sort();

/* 1. IDENTITY — same recipe as tools/vision-heads.mjs */
const digest =
  'sha256:' +
  createHash('sha256')
    .update(scans.map((f) => `${f}:${statSync(join(scanDir, f)).size}`).join('\n'))
    .digest('hex');
if (!heads.imageSet || !heads.imageSet.digest) {
  fail('heads.json records no imageSet identity — it cannot prove which scans its readings were taken against');
} else if (heads.imageSet.digest !== digest) {
  fail(`imageSet identity mismatch:\n  recorded      : ${heads.imageSet.digest} (${heads.imageSet.leaves} leaves)\n  scans on disk : ${digest} (${scans.length} leaves)`);
} else {
  console.log(`ok: imageSet identity matches the scans on disk (${heads.imageSet.leaves} leaves)`);
}

/* 2. COVERAGE — the leaf set equals the scan set, both directions */
const recorded = new Set(Object.keys(heads.leaves || {}));
const held = new Set(scans);
const ghosts = [...recorded].filter((l) => !held.has(l));
const unreads = [...held].filter((l) => !recorded.has(l));
if (ghosts.length) fail(`${ghosts.length} reading(s) name leaves that are not on disk, e.g. ${ghosts.slice(0, 5).join(', ')}`);
else console.log('ok: no reading names a leaf that is not on disk');
if (unreads.length) fail(`${unreads.length} scan(s) on disk have no reading, e.g. ${unreads.slice(0, 5).join(', ')}`);
else console.log(`ok: every stored scan has a reading (${recorded.size} leaves)`);

/* 3. PROVENANCE */
if (!heads.model) fail('no top-level model');
if (!heads.prompt || !heads.prompt.id || !heads.prompt.sha256) fail('no prompt id/hash recorded — the readings cannot be tied to the prompt that took them');
if (!heads.takenAt) fail('no takenAt');
if (heads.unread && heads.unread.length) fail(`an unread list lingers (${heads.unread.length} leaves) — re-run the failed leaves first`);
else if (heads.model) console.log(`ok: provenance present (model ${heads.model}, prompt ${heads.prompt ? heads.prompt.id : '?'}), no unread list`);
const models = new Map();
for (const [leaf, rec] of Object.entries(heads.leaves || {})) {
  if (!rec.model) fail(`${leaf}: record names no model`);
  if (!rec.at) fail(`${leaf}: record names no time`);
  if (rec.error) fail(`${leaf}: record holds an error, not a reading`);
  models.set(rec.model, (models.get(rec.model) || 0) + 1);
}
if (models.size > 1) console.log(`note: records carry ${models.size} readers: ${[...models].map(([m, n]) => `${m}×${n}`).join(', ')}`);

if (fails) {
  console.error(`heads-probe: ${fails} check(s) FAILED for ${slug}`);
  process.exit(1);
}
console.log(`heads-probe: all checks pass for ${slug}`);
