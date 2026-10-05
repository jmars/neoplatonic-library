#!/usr/bin/env node
/**
 * tools/fetch-scans.mjs — fetch the WHOLE scan of an edition into
 * `data/editions/<slug>/scans/nNNNN.jpg`.
 *
 * WHY THE WHOLE SCAN. The page images are part of the citable record: they are
 * committed, served beside the text at `/texts/<slug>/scans/nNNNN.jpg`, and the
 * apparatus viewer reads every stored leaf. The blog's own tools/library/scan.mjs
 * fetched ONE leaf at a time, at the address
 *
 *     https://archive.org/download/<item>/page/n<N>_w1200.jpg
 *
 * and that is the address used here, unchanged (a stored leaf is ~250 KB). This
 * tool exists so the whole scan can be fetched again from the item, leaf for
 * leaf, without the calling session having to name the range: the range comes
 * from the edition's own record.
 *
 *     node tools/fetch-scans.mjs                 # every served edition
 *     node tools/fetch-scans.mjs <slug> [...]    # named editions
 *
 * WHICH LEAVES, and where the range comes from (never typed into this file):
 *   - `scan.json` (the item has no derivable leaf model): it names the item, the
 *     MEASURED offset (archive n = printed page + offset) and the printed range
 *     the work occupies, so n runs `firstPage + offset .. lastPage + offset`;
 *   - `derivs.json` (the leaf model): it names the item; the item's OWN
 *     imagecount (archive.org `/metadata/<item>`) gives the scan's n as
 *     `0 .. imagecount - 1`, and a leaf the item does not serve is REPORTED as
 *     not existing — never invented, never silently dropped.
 *
 * A leaf already on disk is NOT re-fetched. Every fetched leaf is checked for
 * the JPEG SOI marker (FF D8 FF) before it is kept. Each request is retried.
 *
 *     node tools/fetch-scans.mjs --list        # report the stored leaves only
 *
 * NOT in the build's module graph: it is a data-fetching tool, run by hand, like
 * tools/migrate-readings.mjs.
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDITIONS = join(ROOT, 'data', 'editions');
const ATTEMPTS = 4;
const POOL = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The edition's item, and the archive leaf range its record implies.
 *
 * ONE ITEM OR SEVERAL. `scan.json` may name ONE item with a measured offset
 * (archive n = printed page + offset), or SEVERAL, one per volume of a printed
 * edition: Taylor's 1816 Theology of Plato comes from two items, and the two
 * items' leaf numbers run over each other, so each range carries a PREFIX and a
 * stored leaf is `<prefix>-n<N>.jpg` (`v1-n74.jpg`). A range given in LEAVES
 * (`leaves: [from, to]`) is used as it stands — that is the honest form where
 * the item supplies no page-number model and no single offset holds (the
 * measurement is in the edition's scan.json). */
async function rangesOf(slug) {
  const scanF = join(EDITIONS, slug, 'scan.json');
  if (existsSync(scanF)) {
    const s = JSON.parse(readFileSync(scanF, 'utf8'));
    if (Array.isArray(s.items) && s.items.length) {
      return s.items.map((it) => ({
        item: it.archive_id || it.item,
        prefix: it.prefix || '',
        from: it.leaves ? it.leaves[0] : it.firstPage + it.archiveOffset,
        to: it.leaves ? it.leaves[1] : it.lastPage + it.archiveOffset,
        why: it.leaves
          ? `scan.json: the leaves this volume's part of the work occupies (${it.archive_id || it.item})`
          : `scan.json: printed pages ${it.firstPage}–${it.lastPage} + offset ${it.archiveOffset}`,
      }));
    }
    return [{
      item: s.item,
      prefix: '',
      from: s.firstPage + s.archiveOffset,
      to: s.lastPage + s.archiveOffset,
      why: `scan.json: printed pages ${s.firstPage}–${s.lastPage} + offset ${s.archiveOffset}`,
    }];
  }
  const derivsF = join(EDITIONS, slug, 'derivs.json');
  if (existsSync(derivsF)) {
    const d = JSON.parse(readFileSync(derivsF, 'utf8'));
    const res = await fetch(`https://archive.org/metadata/${d.item}`);
    if (!res.ok) throw new Error(`fetch-scans: metadata for ${d.item} -> HTTP ${res.status}`);
    const meta = await res.json();
    const count = Number(meta && meta.metadata && meta.metadata.imagecount);
    if (!Number.isFinite(count) || count <= 0) {
      throw new Error(`fetch-scans: ${d.item} metadata carries no imagecount`);
    }
    return [{ item: d.item, prefix: '', from: 0, to: count - 1, why: `derivs.json + item imagecount ${count}` }];
  }
  throw new Error(`fetch-scans: ${slug} has neither scan.json nor derivs.json — no item to fetch from`);
}

const scansDir = (slug) => join(EDITIONS, slug, 'scans');
/** The stored leaf's own file name — `<prefix>-n<N>.jpg`, or `n<N>.jpg` for a
 * single-item edition. The prefix is part of the NAME on disk and in every URL
 * that cites the leaf; the leaf number stays the number in its own item. */
const leafFile = (prefix, n) => `${prefix ? `${prefix}-` : ''}n${n}.jpg`;
const leafPath = (slug, prefix, n) => join(scansDir(slug), leafFile(prefix, n));
const isJpeg = (buf) => buf.length > 1000 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
const url = (item, n) => `https://archive.org/download/${item}/page/n${n}_w1200.jpg`;

/** One leaf, retried. Distinguishes "the item does not serve this leaf" (404,
 * returned as `missing`) from "the request failed" (thrown). */
async function fetchLeaf(item, n) {
  const u = url(item, n);
  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(u);
      if (res.status === 404) {
        await res.arrayBuffer().catch(() => {});
        return { n, missing: true };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!isJpeg(buf)) throw new Error(`not a JPEG (${buf.length} bytes)`);
      return { n, buf };
    } catch (err) {
      last = err;
      if (attempt < ATTEMPTS) await sleep(800 * attempt);
    }
  }
  return { n, error: last && last.message ? last.message : String(last) };
}

async function run(slug, range) {
  const { item, prefix, from, to, why } = range;
  const dir = scansDir(slug);
  const wanted = [];
  let stored = 0;
  let bad = 0;
  for (let n = from; n <= to; n += 1) {
    const p = leafPath(slug, prefix, n);
    if (existsSync(p)) {
      const buf = readFileSync(p);
      if (isJpeg(buf)) {
        stored += 1;
        continue;
      }
      bad += 1;
    }
    wanted.push(n);
  }
  console.log(
    `\n${slug}\n  item ${item}${prefix ? ` (leaves ${prefix}-n<N>.jpg)` : ''} — ${why}\n  ` +
      `leaves n${from}..n${to} (${to - from + 1}) — ` +
      `${stored} already stored${bad ? `, ${bad} stored file(s) invalid` : ''}, ${wanted.length} to fetch`,
  );

  const missing = [];
  const failed = [];
  let fetched = 0;
  let bytes = 0;
  let i = 0;
  const worker = async () => {
    for (;;) {
      const k = i;
      i += 1;
      if (k >= wanted.length) return;
      const n = wanted[k];
      const r = await fetchLeaf(item, n);
      if (r.missing) {
        missing.push(n);
        console.log(`  ${leafFile(prefix, n)}: not served by the item (HTTP 404)`);
      } else if (r.error) {
        failed.push({ n, error: r.error });
        console.log(`  ${leafFile(prefix, n)}: FAILED — ${r.error}`);
      } else {
        writeFileSync(leafPath(slug, prefix, n), r.buf);
        fetched += 1;
        bytes += r.buf.length;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, Math.max(1, wanted.length)) }, worker));

  const total = readdirSync(dir).filter((f) => /^(?:v\d+-)?n\d+\.jpg$/.test(f)).length;
  const size = readdirSync(dir)
    .filter((f) => /^(?:v\d+-)?n\d+\.jpg$/.test(f))
    .reduce((a, f) => a + statSync(join(dir, f)).size, 0);
  console.log(
    `  fetched ${fetched} (${(bytes / 1e6).toFixed(1)} MB), skipped ${stored} stored, ` +
      `${missing.length} not served, ${failed.length} failed`,
  );
  /* The DIRECTORY total, not this range's: an edition fetched from several items
   * (several ranges) has one scans/ directory, and its size is stated once, by
   * the caller, after the last range. */
  return { slug, item, fetched, bytes, stored, missing, failed, total, size };
}

const argv = process.argv.slice(2);
const list = argv.includes('--list');
const names = argv.filter((a) => !a.startsWith('--'));
const all = readdirSync(EDITIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(EDITIONS, d.name, 'edition.json')))
  .map((d) => d.name);
const slugs = names.length ? names : all;
const bad = slugs.filter((s) => !all.includes(s));
if (bad.length) throw new Error(`fetch-scans: no such edition: ${bad.join(', ')}`);

if (list) {
  for (const slug of slugs) {
    const dir = scansDir(slug);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^(?:v\d+-)?n\d+\.jpg$/.test(f)) : [];
    const size = files.reduce((a, f) => a + statSync(join(dir, f)).size, 0);
    console.log(`${slug}: ${files.length} leaf image(s), ${(size / 1e6).toFixed(1)} MB`);
  }
  process.exit(0);
}

let totalLeaves = 0;
let totalBytes = 0;
let failures = 0;
for (const slug of slugs) {
  let last = null;
  for (const range of await rangesOf(slug)) {
    last = await run(slug, range);
    failures += last.failed.length;
  }
  if (last) {
    console.log(`  ${slug}: ${last.total} leaf image(s) on disk, ${(last.size / 1e6).toFixed(1)} MB`);
    totalLeaves += last.total;
    totalBytes += last.size;
  }
}
console.log(`\nTOTAL: ${totalLeaves} leaf image(s), ${(totalBytes / 1e6).toFixed(1)} MB, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
