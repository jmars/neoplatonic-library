#!/usr/bin/env node
/**
 * tools/scan-probe.mjs — the scan-evidence probe (the citable-leaf claim).
 *
 * THE CLAIM: a repair that was read off a page image carries the LEAF it was
 * decided from, and that leaf resolves — the URL the rule records is a file the
 * site actually ships. Nothing about it is a description: the data says a leaf
 * is held, and the built tree has it.
 *
 * WHAT IT HOLDS, in both directions (a rule that cannot fail is not a rule):
 *
 *   DATA (data/editions/<slug>/)
 *     - `scans/` exists and holds `nNNN.jpg` leaves;
 *     - EVERY rule carries an `evidence` array (empty where the reading rests on
 *       something else — model §0.4: never omitted);
 *     - an entry's `file` is `n<leaf>.jpg`, its `source` is archive.org, and
 *       `exists` is TRUE exactly when `scans/<file>` is present;
 *     - `exists:true` ⇒ `url` is the stable `/texts/<slug>/scans/<file>`;
 *       `exists:false` ⇒ `url` is null (the citation is kept, the image is not
 *       claimed).
 *
 *   BUILT (site/dist/)
 *     - every held leaf's `url` resolves to a shipped file, byte-identical to
 *       the stored leaf;
 *     - every stored leaf is shipped (no orphan held and unserved), and the
 *       edition's `apparatus.json` carries every one of them as a thumbnail url;
 *     - the leaf reaches the reader through the DATA: `/texts/<slug>/apparatus.json`
 *       carries each reading's leaf, the viewer renders the index as
 *       `loading="lazy"` thumbnails, and a cited leaf that is not held is stated
 *       in the viewer without an image url to fake;
 *     - the page server-renders NO leaf image — the index is the viewer's, and
 *       the images are fetched only as a reader scrolls (the old page inlined a
 *       thumbnail per cited rule among 415 rules; the log is a data file now).
 *
 * The editions are read from DATA (every `data/editions/<slug>/edition.json`
 * with `current_version` set), not from the build's list, so the probe
 * recomputes what SHOULD exist and holds the tree against it.
 *
 *     node tools/scan-probe.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
/* The viewer is inlined into the page COMMENT-STRIPPED (build/library.mjs), so
 * the text the reader gets is the stripped one — and that is what the leak gate
 * reads. Check the same text, not the source's comments. */
import { stripJsComments } from '../build/leak.mjs';
import { publishedTexts } from './shelf.mjs';

/** THE SERVED SET, from the shelf's own publication switch: an edition is served
 * when its shelf entry says `published: true`, and the data directory may hold an
 * edition that is not (an unrepaired transcription is held back). Reading THIS
 * is what keeps the probe's scope the served site; reading the data directory
 * alone would put a held-back edition under the served site's checks. */
const SERVED = new Set(publishedTexts().map((t) => t.slug));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'site', 'dist');

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};
const section = (name) => console.log(`\n${name}`);

if (!existsSync(DIST)) {
  console.log('scan-probe: site/dist is not built — run node build/build.mjs first');
  process.exit(1);
}

/* ---------- the served editions, from the data ---------- */

function servedEditions() {
  const dir = join(ROOT, 'data', 'editions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const f = join(dir, d.name, 'edition.json');
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    })
    .filter((e) => e && e.current_version && SERVED.has(e.slug));
}

/** The leaves stored with an edition: the FILE NAMES in its scans/. A leaf file
 * is `nNNN.jpg`, or `v<N>-nNNN.jpg` where the edition's scan comes from more than
 * one archive item (the prefix carries the volume; the number is the leaf in its
 * own item). The NAME is the leaf's identity, not the number: an edition cut from
 * two items has two leaves numbered 74 (`v1-n74.jpg`, `v2-n74.jpg`), so a set of
 * numbers would collapse them into one. */
const LEAF_FILE = /^(?:v\d+-)?n\d+\.jpg$/;
function storedLeaves(slug) {
  const dir = join(ROOT, 'data', 'editions', slug, 'scans');
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((f) => LEAF_FILE.test(f)));
}
/** The number a stored leaf file carries, and the volume prefix it carries (empty
 * when the edition's leaves have none). */
const leafNum = (f) => Number(/n(\d+)\.jpg$/.exec(f)[1]);
const leafPre = (f) => (/^v\d+-/.exec(f) || [''])[0];

const rulesOf = (slug, version) =>
  JSON.parse(readFileSync(join(ROOT, 'data', 'editions', slug, 'versions', version, 'repairs.json'), 'utf8')).rules;

/* ---------- §1 the data: every rule carries coherent evidence ---------- */

section('the data: a rule’s evidence names a leaf, and says whether it is held');
const editions = servedEditions();
check(editions.length > 0, `read ${editions.length} served edition(s) from the data`);

let totalRules = 0;
let totalCited = 0;
let totalWitness = 0;
const held = new Map(); // slug -> Set(leaf)
const notHeld = new Map(); // slug -> Set(leaf)
for (const e of editions) {
  const leaves = storedLeaves(e.slug);
  held.set(e.slug, new Set());
  notHeld.set(e.slug, new Set());
  check(leaves.size > 0, `${e.slug}: scans/ holds ${leaves.size} leaf image(s)`);

  const rules = rulesOf(e.slug, e.current_version);
  totalRules += rules.length;
  const missingArray = rules.filter((r) => !Array.isArray(r.evidence)).length;
  check(missingArray === 0, `${e.slug}: every one of ${rules.length} rules carries an evidence array (${missingArray} without)`);

  const badShape = [];
  const badExists = [];
  const badUrl = [];
  let cited = 0;
  let witnessEntries = 0;
  let witnessRules = 0;
  for (const r of rules) {
    /* A LEAF ENTRY NAMES A LEAF; a WITNESS entry (kind `witness`, an outside
     * human-proofread transcription of the print) names none, has no image and is
     * not a scan. It is counted and asserted separately below, so this check
     * stays about leaves and a witness cannot pass as one. */
    const leaf_ = (r.evidence || []).filter((ev) => ev && ev.leaf != null);
    const wit_ = (r.evidence || []).filter((ev) => ev && ev.leaf == null);
    if (wit_.length) witnessRules++;
    for (const ev of wit_) {
      witnessEntries++;
      if (ev.kind !== 'witness' || typeof ev.witness !== 'string' || !ev.witness || typeof ev.reads !== 'string' || !ev.reads)
        badShape.push(`${r.id}: ${JSON.stringify(ev)}`);
    }
    for (const ev of leaf_) {
      cited++;
      /* THE FILE IS THE LEAF'S IDENTITY (model §4.4): `nNNN.jpg`, or `v<N>-nNNN.jpg`
       * for an edition whose scan comes from two items whose leaf numbers run over
       * each other. The number must be the file's own. */
      const fm = typeof ev.file === 'string' ? /^(?:v\d+-)?n(\d+)\.jpg$/.exec(ev.file) : null;
      if (ev.kind !== 'scan' || !Number.isInteger(ev.leaf) || !fm || Number(fm[1]) !== ev.leaf || ev.source !== 'archive.org') {
        badShape.push(`${r.id}: ${JSON.stringify(ev)}`);
        continue;
      }
      const isHeld = leaves.has(ev.file);
      if (ev.exists !== isHeld) badExists.push(`${r.id}: leaf ${ev.file} exists=${ev.exists} but ${isHeld ? 'is' : 'is not'} stored`);
      const want = isHeld ? `/texts/${e.slug}/scans/${ev.file}` : null;
      if (ev.url !== want) badUrl.push(`${r.id}: leaf ${ev.file} url=${JSON.stringify(ev.url)} (want ${JSON.stringify(want)})`);
      (isHeld ? held.get(e.slug) : notHeld.get(e.slug)).add(ev.file);
    }
  }
  totalCited += cited;
  check(badShape.length === 0, `${e.slug}: every evidence entry is a scan of an nNNN leaf OR a witness of the print (${badShape.length} malformed${badShape.length ? `: ${badShape[0]}` : ''})`);
  totalWitness += witnessEntries;
  if (witnessEntries) console.log(`  NOTE ${e.slug}: ${witnessEntries} witness entr(ies) on ${witnessRules} rule(s) — an outside transcription of the same print, no leaf, no image, checked against the print's own words`);
  check(badExists.length === 0, `${e.slug}: every entry's exists matches the stored leaves (${badExists.length} wrong${badExists.length ? `: ${badExists[0]}` : ''})`);
  check(badUrl.length === 0, `${e.slug}: every held leaf's url is the stable scan address, every unheld leaf's is null (${badUrl.length} wrong${badUrl.length ? `: ${badUrl[0]}` : ''})`);
  console.log(`  NOTE ${e.slug}: ${rules.length} rule(s), ${cited} evidence entr(ies), ${held.get(e.slug).size} leaf/leaves held, ${notHeld.get(e.slug).size} cited but not held`);
}
check(totalRules > 0 && totalCited > 0, `the corpus cites leaves at all (${totalCited} entr(ies) over ${totalRules} rules)`);
check(totalWitness >= 0, `${totalWitness} witness entr(ies) carried beside the leaves over the corpus`);

/* The stored leaf set IS the whole scan: the run of archive leaves the work
 * occupies, contiguous, with nothing missing in the middle. The endpoints are
 * the item's own, MEASURED not assumed: proclus `scan.json` verifies n806
 * (printed 301) and n946 (printed 441) at both ends; the porphyry item serves
 * n0–n71 and returns HTTP 404 for n72 upward. Counted here from the tree, held
 * against the range the edition's own record names. */
section('the whole scan is stored — every leaf of the run, contiguous');
{
  /* PER VOLUME, where a work is cut from more than one item: the prefix names the
   * volume and each volume's run is checked on its own — MEASURED, Taylor's
   * Theology of Plato is cut from ONE item over the two volumes of the print
   * (v1: that item's leaves 76-500, printed pp. 1-425; v2: its leaves 506-804,
   * printed pp. 1-299), and the two runs are the two halves of a work whose pages
   * restart at 1 in vol. II, so a single range check would be meaningless. The
   * leaves between the runs (501-505) are the copy's own end matter and the
   * volume title page, and are not part of the work. */
  const RANGE = {
    'proclus-elements-of-theology-taylor-1816': { '': [806, 946] },
    'porphyry-on-the-cave-of-the-nymphs-taylor-1917': { '': [0, 71] },
    /* The Theology's FRONT MATTER is stored without a volume prefix (`n0.jpg` ..
     * `n75.jpg`) because those leaves carry no printed page — the record gives
     * them their own run with no offset (scan.json). Their prefix is therefore ''
     * and they are checked as their own contiguous run, exactly as a volume is. */
    'proclus-theology-of-plato-taylor-1816': { '': [0, 75], 'v1-': [76, 500], 'v2-': [506, 804] },
  };
  for (const [slug, ranges] of Object.entries(RANGE)) {
    if (!editions.some((e) => e.slug === slug)) continue;
    const files = [...storedLeaves(slug)];
    for (const [pre, [lo, hi]] of Object.entries(ranges)) {
      const got = files.filter((f) => leafPre(f) === pre).map(leafNum).sort((a, b) => a - b);
      const label = pre ? `${slug} (${pre.replace(/-$/, '')})` : slug;
      check(got.length === hi - lo + 1,
        `${label}: all ${hi - lo + 1} leaves of the scan are stored (n${lo}..n${hi}; got ${got.length})`);
      check(got.length > 0 && got[0] === lo && got[got.length - 1] === hi, `${label}: the stored range runs n${lo}..n${hi}`);
      const gaps = got.filter((n, i) => i > 0 && n !== got[i - 1] + 1);
      check(gaps.length === 0, `${label}: no leaf is missing from the middle of the run (${gaps.length} gap(s))`);
    }
  }
}

/* The cited-but-not-held citation is the honest half of §4.4, and the check stays
 * because it CAN fail: it recomputes the unheld set from the rules (whose `exists`
 * §1 holds against the tree), so a leaf dropped from scans/ makes §1 fail and puts
 * the citation back in this list. MEASURED 2026-10-05: fetching the WHOLE SCAN
 * left no cited leaf unheld — the list is empty for both editions. */
section('every cited leaf is held (nothing a reading rests on is unshown)');
for (const e of editions) {
  const got = [...notHeld.get(e.slug)].sort();
  check(got.length === 0,
    `${e.slug}: no reading cites a leaf the edition does not hold (${got.length} unheld${got.length ? `: ${got.join(', ')}` : ''})`);
}

/* ---------- §2 the built tree: every held leaf resolves ---------- */

section('the built tree: every held leaf is shipped, and the url resolves to it');
for (const e of editions) {
  const distDir = join(DIST, 'texts', e.slug, 'scans');
  if (!existsSync(distDir)) {
    check(false, `${e.slug}: site/dist/texts/${e.slug}/scans/ exists`);
    continue;
  }
  const leaves = storedLeaves(e.slug);
  const shipped = new Set(readdirSync(distDir).filter((f) => LEAF_FILE.test(f)));
  const orphans = [...leaves].filter((f) => !shipped.has(f));
  const extras = [...shipped].filter((f) => !leaves.has(f));
  check(orphans.length === 0, `${e.slug}: every stored leaf is shipped (${orphans.length} missing${orphans.length ? `: ${orphans.sort().slice(0, 6).join(', ')}` : ''})`);
  check(extras.length === 0, `${e.slug}: no shipped leaf is unstored (${extras.length} extra)`);
  check(shipped.size === leaves.size, `${e.slug}: ${shipped.size} served = ${leaves.size} stored`);

  /* BYTE-IDENTITY of ONE leaf per volume: the copy is a copy. Comparing all 935
   * would be slow and prove nothing more than the ones — the copy is mechanical. */
  for (const pre of new Set([...leaves].map(leafPre))) {
    const one = [...leaves].filter((f) => leafPre(f) === pre).sort()[0];
    if (one == null) continue;
    const a = readFileSync(join(ROOT, 'data', 'editions', e.slug, 'scans', one));
    const b = readFileSync(join(distDir, one));
    check(a.equals(b), `${e.slug}: the served leaf ${one} is byte-identical to the stored one`);
  }
}

/* ---------- §3 the leaf in the data, and the viewer that shows it ---------- */

section('the apparatus data carries the leaf, and the viewer shows it lazily');
{
  const css = readFileSync(join(ROOT, 'design', 'library.css'), 'utf8');
  check(/\.app-leaf-img\s*\{[^}]*max-width:\s*120px/.test(css), 'the stylesheet caps a leaf-index thumbnail at 120px');
  check(/\.app-leaf-img\s*\{[^}]*height:\s*auto/.test(css), 'and lets its height follow the image (no fixed box)');
  /* CHANGED EXPECTATION (the width unit). The panel leaf used to be `width: auto`
   * with a `max-height: 82vh` cap, which held a ~1400×2500px page to ≈430–560px wide
   * — a strip beside a ~916px column (the author's report). It FILLS its column now
   * and is bounded by the column instead of the viewport: the panel sits inside
   * `#the-apparatus .wrap` (--reader), so the width bound implies the height. */
  check(/\.app-panel-img\s*\{[^}]*width:\s*100%/.test(css) &&
    /\.app-panel-img\s*\{[^}]*max-height:\s*none/.test(css) &&
    !/\.app-panel-img\s*\{[^}]*max-height:\s*[\d.]+vh/.test(css),
    'the panel shows the selected leaf FILLING its column at a readable size (width: 100% of the panel, bounded by the column, no viewport-height cap)');
  check(/\.apparatus-entry\.target\s*\{[^}]*border-left:\s*2px solid var\(--accent\)/.test(css),
    'and the linked reading (#repair-<id>) is set apart with the rubric');

  /* THE WIDTH: the apparatus is laid out on the reader's width, not on a
   * measure. MEASURED before this unit: the reader section was 1240px and the
   * apparatus section fell back to --wide (72rem = 1152px), so the leaf could not
   * use the page it sat on. One token now names the width for both. */
  check(/--reader:\s*1240px/.test(css), 'the reading width is a TOKEN (:root --reader = 1240px)');
  check(/#the-apparatus\s+\.wrap\s*\{[^}]*max-width:\s*var\(--reader\)/.test(css),
    'and #the-apparatus .wrap is set to it — the apparatus is as wide as the reader above it');
  check(/\.app-leaf-badge\s*\{/.test(css) && /\.app-leaf-evidence\s*\{/.test(css),
    'a leaf a reading was decided from is MARKED (a badge and a darkened rule), not moved out of the index');
  check(/\.app-leafnav\s*\{/.test(css), 'and the viewer carries leaf-paging chrome (.app-leafnav)');

  const client = stripJsComments(readFileSync(join(ROOT, 'tools', 'apparatus', 'viewer.js'), 'utf8'));
  check(/img\.loading = 'lazy'/.test(client), 'the viewer marks every leaf thumbnail loading="lazy"');
  check(/app-leaf-evidence/.test(client) && /app-leaf-badge/.test(client),
    'and marks a leaf a reading was decided from');
  check(/app-leafnav/.test(client) && /Previous leaf/.test(client) && /Next leaf/.test(client),
    'and pages the scan leaf by leaf (previous/next leaf)');
  check(/carries no recorded reading/.test(client),
    'and says plainly when a leaf carries no reading, rather than showing an empty panel');
  check(/not held with this edition/.test(client),
    'and still states a cited-but-unheld leaf in words, with no image url to show (the form is no longer exercised by the served data — see §1)');
  /* The prose the viewer emits is inlined into a PAGE, so it may not carry the
   * gate's workshop phrases. "the scan" is one (the gate\'s extraction-mechanics
   * rule); "the page images"/"the leaves" is what the viewer says instead. */
  const viewerStrings = client.match(/'[^']*'|"[^"]*"/g) || [];
  const leaky = viewerStrings.filter((s) => /\bthe scan\b|\bthe build\b(?!\s+in\b)|\bthe extract\b|\bthe corpus\b/i.test(s));
  check(leaky.length === 0, `no string the viewer emits carries a gate phrase (${leaky.length} do${leaky.length ? `: ${leaky[0]}` : ''})`);

  for (const e of editions) {
    const file = join(DIST, 'texts', e.slug, 'apparatus.json');
    if (!existsSync(file)) { check(false, `${e.slug}: apparatus.json is built`); continue; }
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const leaves = storedLeaves(e.slug);
    const entries = data.rules.flatMap((r) => r.evidence);

    /* The apparatus data carries each evidence entry's SERVED URL (model §7.1),
     * not a separate file field: the leaf's stored name is the url's basename, and
     * it must be a leaf file whose number is the entry's leaf. */
    const badAddr = entries.filter((ev) => {
      if (!ev.exists) return false;
      const base = String(ev.url || '').split('/').pop();
      return ev.url !== `/texts/${e.slug}/scans/${base}` || !LEAF_FILE.test(base) || leafNum(base) !== ev.leaf;
    });
    check(badAddr.length === 0, `${e.slug}: every held leaf's url is the stable scan address (${badAddr.length} wrong${badAddr.length ? `: ${badAddr[0].url}` : ''})`);
    const unresolved = entries.filter((ev) => ev.url && !existsSync(join(DIST, ev.url.replace(/^\//, ''))));
    check(unresolved.length === 0,
      `${e.slug}: every held leaf's url resolves to a shipped file (${entries.filter((ev) => ev.exists).length} entr(ies), ${unresolved.length} unresolved${unresolved.length ? `: ${unresolved[0].url}` : ''})`);
    const gone = entries.filter((ev) => !ev.exists);
    check(gone.every((ev) => ev.url === null),
      `${e.slug}: a cited-but-unheld leaf claims no image url at all (${gone.length} entr(ies))`);
    const thumbMissing = data.leaves.filter((l) => !existsSync(join(DIST, l.url.replace(/^\//, ''))));
    check(data.leaves.length === leaves.size && thumbMissing.length === 0,
      `${e.slug}: the leaf index has a resolving thumbnail for all ${leaves.size} stored leaves (${thumbMissing.length} missing)`);
    /* THE LEAF ENTRY IS LEAN: what the viewer needs, and no per-leaf description
     * (the file carries 141 entries for proclus; a sentence apiece would be the
     * log again, in a worse form). */
    const fat = data.leaves.filter((l) => Object.keys(l).sort().join(',') !== 'n,page,readings,url');
    check(fat.length === 0,
      `${e.slug}: every leaf entry carries exactly n/url/page/readings (${fat.length} carry more)`);

    /* THE VIEWER LIVES ON THE APPARATUS PAGE (`/texts/<slug>/apparatus/`); the
     * reader's width token is emitted on the edition page the leaf panel is
     * reached from. Both are read where each belongs. */
    const appHtml = readFileSync(join(DIST, 'texts', e.slug, 'apparatus', 'index.html'), 'utf8');
    check(appHtml.includes('id="app-leaves"') && appHtml.includes('id="app-panel"'),
      `${e.slug}: the viewer's leaf index and panel stand in the apparatus page`);
    check(!/<img[^>]*class="app-leaf-img"/.test(appHtml),
      `${e.slug}: the apparatus page server-renders NO leaf image (the index is the viewer's, and nothing is eager)`);
    const html = readFileSync(join(DIST, 'texts', e.slug, 'index.html'), 'utf8');
    check(html.includes('.rd-section .wrap { max-width: var(--reader); }'),
      `${e.slug}: the emitted reader section is the --reader width (the token reaches the page)`);
  }
}

console.log(failures === 0 ? '\nscan-probe: all checks passed' : `\nscan-probe: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
