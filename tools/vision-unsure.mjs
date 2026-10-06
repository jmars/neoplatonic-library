#!/usr/bin/env node
/**
 * tools/vision-unsure.mjs — settle the full read's UNSURE questions off the PAGE
 * IMAGES, and emit findings the merge can fold in.
 *
 * WHY THIS EXISTS. `tools/fullread.mjs` decided every reading it could from the
 * transcription and from the parallel witness, and left the rest as `unsure[]`:
 * questions the TEXT cannot settle, because both the transcription and the
 * witness are OCR passes over the same print. A page image is not a transcription
 * of the print — it IS the print — so where a question is "what is actually
 * printed here?", the leaf is the only honest source. This tool reads it.
 *
 * WHAT IT DOES, in order:
 *
 *   1. LOCATE. Each unsure entry's `passage` is the transcription's own
 *      characters, so it is found in `versions/<semver>/source.txt` by an
 *      exact search (whitespace removed from both sides, because the read's
 *      passages have had their spacing normalised). The search is confined to
 *      the entry's own region — `section N` is division N — so a short fragment
 *      cannot match a coincidental run elsewhere in the book. A passage that
 *      cannot be located is REPORTED, never guessed at.
 *
 *   2. MAP line -> leaf. Two instruments, and both are reported:
 *      (a) THE ANCHORS `divisions.json` already carries: one `line`, `page` and
 *          `leaf` per division (215 of them). Between two consecutive anchors
 *          the leaf ordinal is interpolated linearly on the line number, within
 *          each volume separately (the work is cut from two items and their leaf
 *          numbers run over each other).
 *      (b) THE ITEM'S OWN LEAF LINES, where `--xml-dir` holds the archive items'
 *          `_djvu.xml`: every leaf's own text is fingerprinted into the
 *          transcription, which places each leaf at a line, exactly.
 *      (b) is what the ANCHORS were built from (divisions.mjs step 1), so it is
 *      used as the mapping when it is available and (a) is the cross-check: the
 *      measured disagreement between the two is the error bound reported below.
 *
 *   3. GROUP BY LEAF, and READ. One vision call per leaf PER CONFIGURED MODEL
 *      covers every question on it: the model is given the leaf's image and the
 *      transcription's own lines for the questioned passages, and is asked to
 *      transcribe what the page prints on those lines, verbatim. Readings are
 *      cached as DATA in `data/editions/<slug>/unsure-vision.json`, keyed by model
 *      and written after every leaf, so a re-run costs nothing and a parser bug can
 *      be re-run without another pass.
 *
 *   4. EMIT FINDINGS `{region, find, replace, class, note, witness, evidence}`
 *      for what the page DECIDES, and keep the question OPEN where it does not:
 *      the leaf does not carry the line, the print is illegible, the model's
 *      reading differs from the transcription past the damaged span (over-reach),
 *      or the reading agrees with the transcription (nothing to repair). The
 *      `find` is always the transcription's own characters, so the merge's guard
 *      holds it.
 *
 * USAGE
 *   node tools/vision-unsure.mjs <slug> [--xml-dir DIR] [--from FILE] [--out FILE]
 *        [--limit N] [--concurrency N] [--report]
 *
 * NOT in the build's module graph: it reads the archive items' `_djvu.xml`
 * (megabytes, not in the repo) and calls the vision model by hand, like
 * `tools/vision-heads.mjs` and `tools/divisions.mjs`.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
/* The build's own punctuation tidy, imported rather than copied: a rule's `find`
 * must live in the text the extractor SERVES, and that text has had this applied
 * (MEASURED: 8,577 of 42,410 non-blank transcription lines are changed by it, and
 * a `find` taken before it is dropped by the merge as "not in the served
 * transcription"). One definition, so the two cannot drift. */
import { tidyPunctuation, sha256 } from './extract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* THE ENDPOINT, and the models — the same knobs tools/greek-runs.mjs carries.
 * The library's standing order points its LLM work at the DeepSeek proxy on
 * 10.0.0.1:8321, but THIS route reads a page image, and the page-image instruments
 * are the DeepInfra VL models on 10.0.0.1:8322 (the DeepSeek vision model returns
 * EMPTY on many of these leaves — its reasoning burns the output budget).
 *
 * MORE THAN ONE MODEL, AND WHY. MEASURED on this print, the VL models are
 * complementary: each reads Greek the other misreads (google/gemma-3-27b-it got a
 * lemma's `οὐκ` right where Qwen/Qwen3-VL-235B-A22B-Instruct read it as `ὅτι`, and
 * the order reverses elsewhere), so ONE model's reading is not evidence on its
 * own. LIBRARY_UNSURE_MODELS is a comma-separated list; with two or more, a line is
 * a reading only where two of them put the same characters there (see collect()),
 * and a question that is not so agreed stays OPEN with its reason. With a single
 * model the tool falls back to the page's own authority plus its guards, as before,
 * and says so in the artifact. */
const ENDPOINT = process.env.LIBRARY_UNSURE_URL || 'http://10.0.0.1:8322/v1/chat/completions';
const MODELS = (process.env.LIBRARY_UNSURE_MODELS || process.env.LIBRARY_UNSURE_MODEL || 'Qwen/Qwen3-VL-235B-A22B-Instruct')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const REQUEST_TIMEOUT_MS = 300_000;

/** The leaf's own key in the record: `v1-n76` where the edition's leaves carry a
 * volume prefix, `n76` where they do not. MEASURED: the Theology of Plato records
 * its FRONT MATTER under the EMPTY prefix (those leaves have no volume of their
 * own), so a key built as `${vol}-n${num}` would read `-n0` and name nothing. */
const leafKeyOf = (vol, num) => `${vol ? `${vol}-` : ''}n${num}`;

/* MEASURED CAP. This model's reasoning RUNS AWAY nondeterministically and the
 * answer is EMPTY when the reasoning hits the cap. tools/vision-heads.mjs (three
 * short fields) answers at 8000; THIS task (transcribe several printed lines
 * verbatim) MEASURED 22,577 reasoning tokens on one leaf — 8000 returned empty
 * content on 6 attempts running, and the same leaf answered at 32000. The cap is
 * a truncation bound, not a budget: an answer that stops early costs what it
 * costs. */
const MAX_TOKENS = 32000;

/* HOW MANY QUESTIONED LINES GO IN ONE CALL. A leaf's whole page is ~35 printed
 * lines; asking for more than a dozen at once makes the answer long enough that
 * the reasoning cap bites. A leaf with more lines than this is asked in chunks
 * (each chunk cached separately under the same leaf). */
const CHUNK = 8;

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--xml-dir', '--from', '--out', '--limit', '--concurrency']);
const slug = argv.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const num = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
if (!slug) {
  console.error('usage: node tools/vision-unsure.mjs <slug> [--xml-dir DIR] [--from FILE] [--out FILE] [--limit N] [--concurrency N] [--report]');
  process.exit(2);
}
const xmlDir = opt('xml-dir', '');
const fromFile = opt('from', join(ROOT, 'tools', 'edits', `${slug}.fullread.json`));
const outFile = opt('out', join(ROOT, 'tools', 'edits', `${slug}.unsure-findings.json`));
const limit = num('limit', Infinity);
const concurrency = num('concurrency', 6);
const reportOnly = argv.includes('--report');

const EDITION = join(ROOT, 'data', 'editions', slug);
const versionsDir = join(EDITION, 'versions');
const version = readdirSync(versionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().pop();
const versionDir = join(versionsDir, version);
const source = readFileSync(join(versionDir, 'source.txt'), 'utf8').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
const scanDir = join(EDITION, 'scans');
const cachePath = join(EDITION, 'unsure-vision.json');

/** The transcription's own lines, and its DERIVED forms.
 *
 * `raw` is the file's lines, 1-based — the coordinate a division, a locate and
 * this tool's reports all use, because it is the one a person can check by
 * opening source.txt. `flat` is the same lines with the blanks dropped and the
 * rest collapsed, which is the stream the extraction opens sections in.
 *
 * `hay` is every non-blank line with WHITESPACE REMOVED, concatenated, with a
 * character-index -> raw-line map beside it: the unsure passages have had their
 * spacing normalised, so the whitespace-free form is the one that can be
 * searched, and the map is what turns a character position back into a line. */
const rawLines = source.split('\n');
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const flatOfRaw = new Array(rawLines.length).fill(-1);
const flat = [];
const rawOfFlat = [];
for (let i = 0; i < rawLines.length; i++) {
  const c = collapse(rawLines[i]);
  if (c !== '') {
    flatOfRaw[i] = flat.length;
    rawOfFlat.push(i + 1);
    flat.push(c);
  }
}
const lineStart = new Int32Array(rawLines.length + 2); // raw line -> char offset in hay
let hay = '';
{
  let h = 0;
  for (let i = 0; i < rawLines.length; i++) {
    lineStart[i + 1] = h;
    const s = rawLines[i].replace(/\s+/g, '');
    hay += s;
    h += s.length;
  }
  lineStart[rawLines.length + 1] = h;
}
const lineOfChar = new Int32Array(hay.length + 1);
{
  let h = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const n = rawLines[i].replace(/\s+/g, '').length;
    for (let c = 0; c < n; c++) lineOfChar[h++] = i + 1;
  }
}

/* ---------- the divisions (the anchors, and the region spans) ---------- */

const divisions = JSON.parse(readFileSync(join(EDITION, 'divisions.json'), 'utf8')).divisions;
const divByN = new Map(divisions.map((d) => [d.n, d]));
const divLineOf = (n) => {
  const d = divByN.get(n);
  return d ? d.line : 1;
};
const regionN = (r) => {
  const m = /section\s+(\d+)/.exec(r || '');
  return m ? Number(m[1]) : null;
};

/* ---------- 1. LOCATE ---------- */

/** The line span a located passage covers: the raw line of its first and last
 * character in the transcription. A passage that spans several lines (the read
 * joins them with '...') comes back as a range, and every line in it is asked
 * about. */
function locate(passage, n) {
  const needle = String(passage || '').replace(/\s+/g, '');
  if (needle.length < 4) return null;
  const lo = Math.max(1, divLineOf(n) - 60);
  const nextDiv = divByN.get(n + 1);
  const hi = Math.min(rawLines.length, (nextDiv ? nextDiv.line : rawLines.length) + 60);
  const a = lineStart[lo];
  const b = lineStart[hi + 1] ?? hay.length;
  const win = hay.slice(a, b);
  let idx = win.indexOf(needle);
  let used = needle.length;
  if (idx < 0) {
    /* A fragment may have been shortened when the read quoted it (a trailing
     * run it could not place). Shrink from the right, then slide a window. */
    for (let len = Math.min(needle.length - 1, 80); len >= 6; len = Math.floor(len * 0.8)) {
      idx = win.indexOf(needle.slice(0, len));
      if (idx >= 0) {
        used = len;
        break;
      }
    }
    if (idx < 0) {
      for (let s = 0; s + 20 <= needle.length; s += 6) {
        idx = win.indexOf(needle.slice(s, s + 20));
        if (idx >= 0) {
          used = 20;
          break;
        }
      }
    }
  }
  if (idx < 0) return null;
  const from = lineOfChar[a + idx];
  const to = lineOfChar[a + idx + used - 1] ?? from;
  return { from, to, how: used === needle.length ? 'passage' : 'partial' };
}

/* ---------- 2. THE LEAF TABLE ---------- */
/* The item's own `_djvu.xml` lines, fingerprinted into the transcription. This is
 * the same measurement divisions.mjs step 1 makes, and what its anchor `leaf`
 * fields were built from; it is re-made here so a LINE (not just a division's
 * opening line) can be placed. */

const XML_ENTITIES = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
  ['&amp;', '&'],
];
const xmlText = (s) => XML_ENTITIES.reduce((t, [from, to]) => t.split(from).join(to), s);
const words = (t) => t.replace(/\s+/g, ' ').trim().split(' ').filter((w) => /[A-Za-z0-9]/.test(w));

function parseDjvu(xml) {
  return [...xml.matchAll(/<OBJECT\b[\s\S]*?<\/OBJECT>/g)].map((m) => {
    const raw = m[0];
    const map = /usemap="[^"]*?(\d{4})\.djvu"/.exec(raw);
    const lines = [];
    for (const lm of raw.matchAll(/<LINE>([\s\S]*?)<\/LINE>/g)) {
      const ws = [...lm[1].matchAll(/<WORD\s+coords="([^"]+)"(?:\s+x-confidence="(\d+)")?\s*>([\s\S]*?)<\/WORD>/g)].map((w) => xmlText(w[3]));
      if (!ws.length) continue;
      lines.push(ws.join(' ').replace(/\s+/g, ' ').trim());
    }
    return { leaf: map ? Number(map[1]) : null, lines };
  });
}

const tokens = [];
const tokenLine = [];
flat.forEach((l, fi) => {
  const re = /[^\s]+/g;
  let m;
  while ((m = re.exec(l)) !== null) {
    tokens.push(m[0]);
    tokenLine.push(fi);
  }
});
const tokenIndex = new Map();
tokens.forEach((w, i) => {
  if (!tokenIndex.has(w)) tokenIndex.set(w, []);
  tokenIndex.get(w).push(i);
});
function findKey(key) {
  const c = tokenIndex.get(key[0]);
  if (!c) return [];
  const out = [];
  for (const p of c) {
    let ok = true;
    for (let k = 1; k < key.length; k++) {
      if (tokens[p + k] !== key[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.push(p);
      if (out.length > 1) return out;
    }
  }
  return out;
}
function placeLine(text) {
  const toks = words(text);
  if (toks.length < 4) return null;
  for (let n = 5; n <= Math.min(18, toks.length); n++) {
    const h = findKey(toks.slice(0, n));
    if (h.length === 1) return tokenLine[h[0]];
    if (h.length === 0) break;
  }
  return null;
}

/** `null` when the item's xml is not on disk; else a line -> {vol,n} mapper. */
function leafTable() {
  if (!xmlDir || !existsSync(xmlDir)) return null;
  /* ONLY A `_djvu.xml` IS AN ITEM'S TEXT LAYER: the same directory holds
   * `_scandata.xml`, which is page geometry and carries no lines. */
  const names = readdirSync(xmlDir).filter((n) => n.endsWith('_djvu.xml'));
  const items = ((JSON.parse(readFileSync(join(EDITION, 'scan.json'), 'utf8')).items) || []);
  const leafCand = [];
  const placed = [];
  for (const it of items) {
    const prefix = it.prefix || '';
    /* THE FILE FOR AN ITEM. Its archive id in the name where the derivative
     * carries one; else the item's own `_djvu.txt` found by the sha256 the
     * edition's scan.json records (the text beside the xml IS that file, so a
     * match proves the two are the same upload); else the volume prefix standing
     * as its own token; else a lone xml for a lone item.
     *
     * MEASURED after the re-source: Taylor's 1816 Theology of Plato is ONE item
     * (`thomastaylor`) entered TWICE, once per printed volume, and that item's
     * derivative is named after the uploaded FILE, not the item
     * (`elementsoftheology_proclus_djvu.xml`) -- so the name match finds nothing
     * and the sha of the sibling text is what identifies it. */
    let name = names.find((n) => n.includes(it.archive_id)) || null;
    if (!name && it.whole_sha256) {
      const txt = readdirSync(xmlDir).find((n) => n.endsWith('_djvu.txt') && sha256(readFileSync(join(xmlDir, n))) === it.whole_sha256);
      if (txt) name = names.find((n) => n === txt.replace(/_djvu\.txt$/, '_djvu.xml')) || null;
    }
    if (!name) name = names.find((n) => new RegExp(`(^|[^a-z0-9])${prefix}([^a-z0-9]|$)`).test(n)) || (items.length === names.length ? names[items.indexOf(it)] : null);
    if (!name) continue;
    /* THE ITEM'S OWN LEAF RUN, where scan.json gives one: two entries can name
     * the SAME item (one scan, two volumes), and without the bound every leaf of
     * that scan would be mapped to BOTH volumes. */
    const lo = Array.isArray(it.leaves) ? it.leaves[0] : -Infinity;
    const hi = Array.isArray(it.leaves) ? it.leaves[1] : Infinity;
    for (const o of parseDjvu(readFileSync(join(xmlDir, name), 'utf8'))) {
      if (o.leaf == null || o.leaf < lo || o.leaf > hi) continue;
      const cand = [];
      for (const l of o.lines) {
        const raw = placeLine(l);
        if (raw == null) continue;
        cand.push(rawOfFlat[raw]);
      }
      leafCand.push({ vol: prefix, num: o.leaf, cand });
    }
    placed.push(`${prefix}: ${name}`);
  }
  if (!leafCand.length) return null;
  /* THE LEAF'S OWN PLACE, chosen AGAINST THE RUN SO FAR — the same rule
   * tools/greek-runs.mjs uses, and MEASURED necessary here. Taking every line of
   * every leaf and keeping the ones that stand forward looked fine while the only
   * runs were the two BODY volumes, and BROKE the moment the front matter was
   * added: the title page and the contents pages carry verbatim the body's own
   * headings, so one of their lines fingerprints thousands of lines into the work,
   * `last` jumps past the whole of vol. I, and 9,174 of 23,370 placements are
   * dropped as non-monotone (MEASURED on this item, this unit). Per leaf, taking
   * the SMALLEST placement that stands after the previous leaf's keeps the
   * coincidental far-forward match out of the run: the leaf's own opening line is
   * placed near the leaf's own place and the other candidate is discarded. */
  const kept = [];
  let last = -1;
  let dropped = 0;
  for (const lc of leafCand) {
    lc.cand.sort((a, b) => a - b);
    const pick = lc.cand.find((x) => x > last);
    if (pick === undefined) { dropped++; continue; }
    last = pick;
    kept.push({ vol: lc.vol, num: lc.num, line: pick });
  }
  const byVol = new Map();
  for (const p of kept) {
    if (!byVol.has(p.vol)) byVol.set(p.vol, []);
    byVol.get(p.vol).push(p);
  }
  for (const arr of byVol.values()) arr.sort((a, b) => a.line - b.line);
  const vols = [...byVol.keys()].sort();
  /* WHICH RUN A LINE BELONGS TO, in general — MEASURED BUG this replaces: the old
   * rule was `line < firstOfLast ? vols[0] : vols[last]`, which assumed exactly TWO
   * items (the two volumes). The Theology now records THREE runs (its front matter
   * under the empty prefix, then vol. I, then vol. II), and under the old rule every
   * line before vol. II's first leaf resolved to the FRONT MATTER's leaves — the
   * whole body would have been read off the wrong pages. A line is now placed in the
   * run whose own line range contains it; a line outside every run goes to the
   * nearest run's end. */
  const ranges = vols.map((v) => {
    const arr = byVol.get(v);
    return { vol: v, lo: arr[0].line, hi: arr[arr.length - 1].line };
  });
  const volAt = (line) => {
    for (const r of ranges) if (line >= r.lo && line <= r.hi) return r.vol;
    let best = ranges[0];
    let bd = Infinity;
    for (const r of ranges) {
      const d = line < r.lo ? r.lo - line : line - r.hi;
      if (d < bd) { bd = d; best = r; }
    }
    return best.vol;
  };
  const at = (line) => {
    const vol = volAt(line);
    const arr = byVol.get(vol) || [];
    if (!arr.length) return null;
    if (line <= arr[0].line) return { vol, num: arr[0].num, conf: 'before-first' };
    if (line >= arr[arr.length - 1].line) return { vol, num: arr[arr.length - 1].num, conf: 'after-last' };
    let lo = 0;
    let hi = arr.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (arr[m].line <= line) lo = m;
      else hi = m;
    }
    const a = arr[lo];
    const b = arr[hi];
    if (a.num === b.num) return { vol, num: a.num, conf: 'exact' };
    const t = (line - a.line) / (b.line - a.line);
    return { vol, num: t < 0.5 ? a.num : b.num, conf: 'boundary' };
  };
  /** The neighbour leaves a line could belong to, nearest first. A 'boundary'
   * placement (the line falls between two of a leaf's placed lines) is a genuine
   * tie: the caller reads the first and falls back to the next. */
  const near = (line) => {
    const one = at(line);
    if (!one) return [];
    const out = [leafKeyOf(one.vol, one.num)];
    if (one.conf === 'boundary') {
      const prev = at(Math.max(1, line - 1));
      if (prev && leafKeyOf(prev.vol, prev.num) !== out[0]) out.push(leafKeyOf(prev.vol, prev.num));
      const next = at(line + 40);
      if (next && !out.includes(leafKeyOf(next.vol, next.num))) out.push(leafKeyOf(next.vol, next.num));
    }
    return out;
  };
  return { at, near, kept: kept.length, dropped, placed, method: 'the item\'s own _djvu.xml leaf lines, fingerprinted into the transcription' };
}

/** The anchor interpolation (divisions.json), the brief's own method and the
 * cross-check on the leaf table. */
function anchorMap() {
  const anchors = divisions
    .map((d) => ({ line: d.line, vol: d.leaf.split('-')[0], num: Number(/-n(\d+)/.exec(d.leaf)[1]) }))
    .sort((a, b) => a.line - b.line);
  const vols = [...new Set(anchors.map((a) => a.vol))];
  const byVol = new Map(vols.map((v) => [v, anchors.filter((a) => a.vol === v)]));
  const firstOfLast = byVol.get(vols[vols.length - 1])[0].line;
  return (line) => {
    const vol = line < firstOfLast && vols.length > 1 ? vols[0] : vols[vols.length - 1];
    const arr = byVol.get(vol);
    if (line <= arr[0].line) return { vol, num: arr[0].num, exact: false };
    if (line >= arr[arr.length - 1].line) return { vol, num: arr[arr.length - 1].num, exact: false };
    for (let i = 1; i < arr.length; i++) {
      if (line <= arr[i].line) {
        const a = arr[i - 1];
        const b = arr[i];
        const p = a.num + ((line - a.line) * (b.num - a.num)) / (b.line - a.line);
        return { vol, num: p, rounded: Math.round(p), exact: false };
      }
    }
    return null;
  };
}

/* ---------- the worklist ---------- */

const read = JSON.parse(readFileSync(fromFile, 'utf8'));
const unsure = read.unsure || [];
const located = [];
const unlocated = [];
const table = leafTable();
const anchor = anchorMap();

for (let i = 0; i < unsure.length; i++) {
  const e = unsure[i];
  const n = regionN(e.region);
  const hit = n != null && divByN.has(n) ? locate(e.passage, n) : null;
  const rec = { i, region: e.region, n, passage: e.passage, question: e.question, note: e.note, evidence: e.evidence };
  if (!hit) {
    unlocated.push(rec);
    continue;
  }
  const near = table ? table.near(hit.from) : null;
  const am = anchor(hit.from);
  located.push({
    ...rec,
    from: hit.from,
    to: hit.to,
    how: hit.how,
    leaf: near ? near[0] : am ? leafKeyOf(am.vol, am.rounded) : null,
    leaves: near,
    anchorLeaf: am ? leafKeyOf(am.vol, am.rounded) : null,
    boundary: table ? table.at(hit.from).conf === 'boundary' : false,
  });
}

/** The leaves to read, and the lines each carries a question about. */
const byLeaf = new Map();
for (const rec of located.slice(0, limit === Infinity ? located.length : limit)) {
  if (!rec.leaf) continue;
  if (!byLeaf.has(rec.leaf)) byLeaf.set(rec.leaf, { leaf: rec.leaf, lines: new Set(), entries: [] });
  const g = byLeaf.get(rec.leaf);
  for (let l = rec.from; l <= rec.to; l++) if (collapse(rawLines[l - 1]) !== '') g.lines.add(l);
  g.entries.push(rec);
}

/* ---------- leaf -> printed page, and the scan evidence ---------- */

const heads = existsSync(join(EDITION, 'heads.json')) ? JSON.parse(readFileSync(join(EDITION, 'heads.json'), 'utf8')).leaves : {};
const scan = existsSync(join(EDITION, 'scan.json')) ? JSON.parse(readFileSync(join(EDITION, 'scan.json'), 'utf8')) : { items: [] };
const offsetOf = new Map();
for (const it of scan.items || []) if (Number.isFinite(it.archiveOffset)) offsetOf.set(it.prefix || '', it.archiveOffset);
const heldFiles = new Set(existsSync(scanDir) ? readdirSync(scanDir).filter((f) => /^(?:v\d+-)?n\d+\.jpg$/.test(f)) : []);
/** The printed page the record stamps for a leaf: the volume's own verified offset
 * (archive n = printed page + offset, confirmed at both ends of the run) where the
 * record states one, else the page a division anchor carries FOR THAT EXACT LEAF. A
 * leaf with neither gets null rather than a guessed number — the apparatus prints
 * "no page recorded". The FRONT MATTER's leaves (stored as `n0`..`n75`, no volume
 * prefix) carry no arabic printed page at all and so always get null. */
function pageOfLeaf(leaf) {
  const m = /^(?:([a-z0-9]+)-)?n(\d+)$/.exec(leaf);
  if (!m) return null;
  const [, vol = '', numS] = m;
  const num = Number(numS);
  if (offsetOf.has(vol)) return num - offsetOf.get(vol);
  const hit = divisions.find((d) => d.leaf === `${leaf}.jpg`);
  return hit && hit.page != null ? hit.page : null;
}
function evidenceEntry(leaf) {
  const m = /^(?:([a-z0-9]+)-)?n(\d+)$/.exec(leaf);
  const num = m ? Number(m[2]) : NaN;
  const file = `${leaf}.jpg`;
  const exists = heldFiles.has(file);
  return { kind: 'scan', leaf: num, page: pageOfLeaf(leaf), file, url: exists ? `/texts/${slug}/scans/${file}` : null, exists, source: 'archive.org' };
}
const fileName = (leaf, heads) => `${leaf}.jpg`;

/* ---------- reporting the map, before any model call ---------- */

const counts = { full: 0, partial: 0 };
for (const r of located) counts[r.how]++;
let disagree = 0;
let margin = [];
for (const r of located) {
  const t = table ? table.at(r.from) : null;
  const a = anchor(r.from);
  if (!t || !a) continue;
  const d = Math.abs(t.num - a.num);
  margin.push(d);
  if (leafKeyOf(t.vol, t.num) !== leafKeyOf(a.vol, a.rounded)) disagree++;
}
margin.sort((x, y) => x - y);
const q = (f) => (margin.length ? margin[Math.min(margin.length - 1, Math.floor(margin.length * f))] : NaN);
console.log(`${slug}: ${unsure.length} unsure question(s) in ${new Set(unsure.map((e) => e.region)).size} region(s)`);
console.log(`  located ${located.length} (${counts.passage || located.filter((r) => r.how === 'passage').length} whole, ${counts.partial} by a leading fragment), not located ${unlocated.length}`);
console.log(`  leaf map: ${table ? table.method : 'divisions.json anchors (no --xml-dir)'}`);
if (table) console.log(`    leaf table: ${table.kept} leaf/leaves placed, ${table.dropped} dropped (no placement left standing after the previous leaf); xml: ${table.placed.join('; ')}`);
if (margin.length) console.log(`    the anchors vs the leaf table, over the ${margin.length} located line(s): median ${q(0.5).toFixed(2)} leaf, p90 ${q(0.9).toFixed(2)}, max ${q(1).toFixed(2)}; they round to DIFFERENT leaves for ${disagree}`);
console.log(`  leaves to read: ${byLeaf.size}; questions on them: ${located.filter((r) => byLeaf.has(r.leaf)).length}`);
const noLeaf = located.filter((r) => !r.leaf);
if (noLeaf.length) console.log(`  located but no leaf: ${noLeaf.length}`);
const boundary = located.filter((r) => r.boundary).length;
console.log(`  placements that are a leaf-boundary tie (a second leaf is tried if the first does not carry the line): ${boundary}`);

if (reportOnly) process.exit(0);

/* ---------- the SECOND TRANSCRIPTION (the witness) ---------- */
/* The witness is the same 1816 print transcribed a second time. It is NOT the
 * decision — the page image is — but two instruments independent of the page's
 * own OCR that agree on a sentence will not both have invented it, so it is the
 * corroboration test for a reading that REPLACES a long damaged span. Where the
 * witness is itself damaged at that place it corroborates nothing, and the
 * reading is judged by its size instead (see `decide`). */

const witnessText = (() => {
  const f = existsSync(join(EDITION, 'witnesses.json'))
    ? JSON.parse(readFileSync(join(EDITION, 'witnesses.json'), 'utf8'))
    : null;
  for (const w of (f && f.witnesses) || []) {
    const p = join(EDITION, 'witnesses', `${w.name}.txt`);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  const dir = join(EDITION, 'witnesses');
  if (existsSync(dir)) {
    const one = readdirSync(dir)[0];
    if (one) return readFileSync(join(dir, one), 'utf8');
  }
  return '';
})();
/** Letters and digits only, lowercased: the OCR passes disagree about spacing,
 * hyphens and the soft-hyphen glyph, and none of that is a disagreement about
 * what the print says. */
const bare = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const witnessWords = witnessText.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
/* The same text as ONE searchable stream. Hoisted: it is 2.4 MB of string work and
 * corroboration is asked for every span. */
const witnessWordStream = witnessWords.join(' ');
/* THE WITNESS IN ITS OWN COORDINATES: its whole text with everything but letters
 * and digits removed (`witnessBare`), and a character -> line map beside it. The
 * two OCR passes disagree about spacing, hyphens and the soft-hyphen glyph, and
 * none of that is a disagreement about the print; dropping it is what lets a
 * reading be LOCATED in the witness ("these words, HERE") rather than merely
 * found in it ("these words, somewhere in 2.4 MB"). */
const witnessLines = witnessText ? witnessText.split(/\r?\n/) : [];
let witnessBare = '';
const witnessLineOfChar = new Int32Array(witnessText.length + 2);
{
  let h = 0;
  for (let i = 0; i < witnessLines.length; i++) {
    const b = bare(witnessLines[i]);
    for (let c = 0; c < b.length; c++) witnessLineOfChar[h++] = i + 1;
    witnessBare += b;
  }
  witnessLineOfChar[witnessText.length + 1] = witnessLines.length;
}
/** EVERY line of the witness that carries this text. ALL of them, not the first:
 * a running head ("CHAP. XIX. OF PLATO. 261") is short and its words recur all
 * through the volume, so the FIRST occurrence is usually the wrong page — MEASURED:
 * taking only the first occurrence is why the correctly-read heads were rejected.
 * The caller decides which occurrence is the right one by where the transcription's
 * own neighbouring line stands.
 *
 * `min` is the shortest run worth locating. A running head is ~17 letters, so a
 * 20-letter floor lost every head; 12 with the place-test below is what a head
 * needs, and the place-test is what keeps a short run from matching by accident. */
function witnessLinesOf(text, min = 12) {
  const b = bare(text);
  if (b.length < min) return [];
  const out = [];
  for (let i = witnessBare.indexOf(b); i >= 0; i = witnessBare.indexOf(b, i + 1)) {
    out.push(witnessLineOfChar[i]);
    if (out.length >= 400) break;
  }
  return out;
}
/** Does the second transcription carry this reading? The whole reading, else the
 * longest run of its words (>= 5 words or 30 characters) — a reading the witness
 * carries in part is still evidence for that part. */
function corroborated(reading) {
  if (!witnessBare) return null;
  const b = bare(reading);
  if (b.length >= 12 && witnessBare.includes(b)) return 'whole';
  const w = reading.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  for (let n = Math.min(w.length, 12); n >= 5; n--) {
    for (let i = 0; i + n <= w.length; i++) {
      const run = w.slice(i, i + n).join(' ');
      if (run.length >= 30 && witnessWordStream.includes(run)) return `${n} words`;
    }
  }
  return null;
}
const witnessLabel = (() => {
  const w = witnessText ? 'second transcription (the witness)' : 'no witness on disk';
  return w;
})();

console.log(`  witness: ${witnessText ? `${witnessText.length} B on disk (${witnessLabel})` : 'NONE on disk — readings judged by size only'}`);

/* ---------- 3. READ ---------- */

/* THE LABELS ARE INERT. MEASURED: asking with the transcription's own line
 * numbers sent the model into a long deliberation about the numbering itself
 * ("might be actual line numbers in the text file where line 1 is first line of
 * book…") that spent the whole cap and returned nothing. The labels below are
 * 1,2,3… and the prompt says outright that they mean nothing; the label -> line
 * mapping is ours, kept out of the model's way. */
const PROMPT_HEAD =
  'Answer immediately with the JSON object only. Do not deliberate.\n' +
  'This is one scanned page of an 1816 book. Below are some of the lines printed on THIS page, as OCR read them off it; the OCR is damaged.\n' +
  'The numbers below are only LABELS for the lines they stand beside. They are not page numbers or line numbers of anything, and mean nothing about the book.\n' +
  'For each labelled line, transcribe what the page ACTUALLY PRINTS on that line, character for character:\n' +
  '  - follow the printed word order, and keep the print\'s own spelling, capitalisation and punctuation;\n' +
  '  - the page is the authority: where the OCR shows a word that is not a word, read the printed word;\n' +
  '  - do NOT modernise, do NOT paraphrase, do NOT add or remove words of your own, and do NOT rewrite a line that already reads as the page prints it;\n' +
  '  - if a line below is not printed on this page at all, its value is "" — never a guess;\n' +
  '  - if the page prints it but it is too faint or damaged to read, its value is "?" — never a guess.\n' +
  'Return a JSON object with one key per label, exactly as labelled, whose value is the printed line.\n' +
  'LINES:\n';

function parseAnswer(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      const o = JSON.parse(text.slice(start, end + 1));
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch {
      /* a shorter span */
    }
  }
  return null;
}

async function ask(leaf, lines, model) {
  const file = `${leaf}.jpg`;
  const src = join(scanDir, file);
  if (!existsSync(src)) return { error: `no stored leaf ${file}` };
  const buf = readFileSync(src);
  const mime = extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  const asked = lines.map((l, i) => `${i + 1}: ${rawLines[l - 1]}`).join('\n');
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    /* EFFORT. MEASURED on one leaf: the model's default effort spent 22,577
     * reasoning tokens and 96 s; `low` spent 12,290 and 56 s for the same answer,
     * so `low` is the working setting. tools/vision-heads.mjs found `low` returns
     * EMPTY answers on some pages, so the LAST attempt drops the setting and
     * gives the leaf the model's own effort — a stubborn page is still read. */
    reasoning_effort: 'low',
    /* NOTE ON EFFORT, from tools/vision-heads.mjs: this model's reasoning RUNS
     * AWAY nondeterministically and returns EMPTY content; `reasoning_effort:
     * "low"` suppresses the runaway but also produces empty answers on real
     * pages, so it is not used. The prompt's "answer immediately" directive bounds
     * the reasoning and an empty answer is RETRIED, not cached as a reading. */
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${PROMPT_HEAD}${asked}\n` },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
        ],
      },
    ],
  };
  for (let attempt = 1; attempt <= 4; attempt++) {
    /* The LAST attempt drops `low`: a page it cannot read at low effort still gets
     * the model's own effort. */
    if (attempt >= 4) delete body.reasoning_effort;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(`HTTP ${res.status}: ${json.error ? json.error.message : ''}`);
      const choice = (json.choices && json.choices[0]) || {};
      const text = (choice.message && choice.message.content) || '';
      const parsed = parseAnswer(text);
      /* AN EMPTY OR UNPARSEABLE ANSWER IS A FAILED READ — not a page that carries
       * nothing. A page that carries none of the lines answers with "" against
       * every key, which is a reading and is kept. */
      if (!parsed) {
        if (attempt < 4) continue;
        return { error: 'no parseable answer over 4 attempts' };
      }
      const out = {};
      for (let i = 0; i < lines.length; i++) {
        const v = parsed[String(i + 1)];
        if (typeof v === 'string') out[lines[i]] = v;
      }
      if (!Object.keys(out).length) {
        if (attempt < 4) continue;
        return { error: 'the answer carried none of the asked line labels' };
      }
      return { reading: out, raw: text, at: new Date().toISOString(), model };
    } catch (e) {
      if (attempt === 4) return { error: String(e && e.message ? e.message : e) };
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    } finally {
      clearTimeout(t);
    }
  }
  return { error: 'no answer' };
}

/* THE CACHE, read once and rewritten (atomically) after every job: a job in here
 * is never asked again. It carries the model's whole answer verbatim (`raw`), so a
 * change to the finding rule can be re-run against the SAME readings without
 * another vision pass. */
/* THE CACHE CARRIES THE MODEL IN EVERY KEY, for the same reason tools/greek-runs.mjs
 * does: the two models' readings of one leaf DIFFER, so a key naming only the leaf
 * would serve one model's answer as the other's. An older cache (one model, keys
 * without a model prefix) is MIGRATED by prefixing each entry's own recorded
 * `model`; those draws keep their provenance and are not among the configured
 * models, so collect() does not count them. */
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : { slug, method: table ? table.method : 'divisions.json anchors', leaves: {} };
if (!cache.leaves) cache.leaves = {};
{
  const migrated = {};
  for (const [k, v] of Object.entries(cache.leaves)) {
    migrated[k.includes('#') && k.split('#').length >= 3 ? k : `${(v && v.model) || 'unknown'}#${k}`] = v;
  }
  cache.leaves = migrated;
}
cache.models = MODELS.slice();
cache.method = table ? table.method : 'divisions.json anchors';
const writeCache = () => {
  const tmp = `${cachePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 1));
  renameSync(tmp, cachePath);
};

/* THE KEY NAMES THE MODEL AND THE LINES it was asked: one draw per (leaf, lines,
 * model). */
const jobKey = (j) => `${j.model}#${j.leaf}#${j.lines[0]}-${j.lines[j.lines.length - 1]}`;
const isDone = (j) => {
  const c = cache.leaves[jobKey(j)];
  return !!c && (!c.error || c.tries >= 2);
};

/** The reading for a source line. A page that does not carry the line answers "",
 * which is a reading too.
 *
 * WITH MORE THAN ONE MODEL THE READING IS WHAT THEY AGREE ON: each configured
 * model's own reading of the line is gathered, and the line is a reading only
 * where at least two models returned the SAME non-blank characters. One model's
 * word is not evidence — MEASURED, the two VL models give different Greek for the
 * same printed word as often as not — so a line only one model read, or two
 * models read differently, is NOT settled here and is recorded in `unsettledLines`
 * with the reason, which keeps the question OPEN downstream.
 *
 * WITH A SINGLE MODEL the old rule stands (a reading from a leaf beats a "not on
 * this page" answer from another), and the artifact says the route ran that way. */
const readLines = new Map();
/** line -> why the models did not settle it (only used with >= 2 models). */
const unsettledLines = new Map();
/** The readings the SAME leaf gave for MORE THAN ONE of its lines. */
const dupLines = new Map();
function collect() {
  readLines.clear();
  unsettledLines.clear();
  const perLine = new Map(); // line -> Map(model -> text)
  for (const rec of Object.values(cache.leaves)) {
    if (!MODELS.includes(rec.model)) continue;
    for (const [line, text] of Object.entries(rec.reading || {})) {
      const l = Number(line);
      if (!perLine.has(l)) perLine.set(l, new Map());
      const m = perLine.get(l);
      const t = collapse(text);
      const cur = m.get(rec.model);
      /* A reading from a leaf beats a "not on this page" answer from the same model. */
      if (cur === undefined || (cur === '' && t !== '')) m.set(rec.model, t);
    }
  }
  for (const [l, m] of perLine) {
    if (MODELS.length < 2) {
      for (const t of m.values()) {
        const cur = readLines.get(l);
        if (cur === undefined || (cur === '' && t !== '')) readLines.set(l, t);
      }
      continue;
    }
    const nonblank = new Map([...m].filter(([, t]) => t && t !== '?'));
    if (!nonblank.size) { readLines.set(l, m.size ? '' : '?'); continue; }
    if (nonblank.size < 2) {
      unsettledLines.set(l, `only ${nonblank.size} of the ${MODELS.length} models returned a reading for this line`);
      continue;
    }
    const texts = [...new Set(nonblank.values())];
    if (texts.length > 1) {
      unsettledLines.set(l, `the ${nonblank.size} models read this line differently (${texts.map((t) => JSON.stringify(t.slice(0, 40))).join(' vs ')})`);
      continue;
    }
    readLines.set(l, texts[0]);
  }
}
function collectDupes() {
  dupLines.clear();
  /* PER LINE, NOT PER JOB. MEASURED BUG: this counted the readings of the cache's
   * JOBS, and a line can be asked in more than one job (the mapped leaf, then the
   * tie neighbour, then a smaller retry chunk) — so a line read twice counted as
   * its own duplicate and 61 questions were rejected, including the one this unit
   * was asked about (`tioned.” a aoe anywhere…` at source line 10323). The count is
   * now over the lines of a leaf, with each line contributing one reading. */
  const lineLeaf = new Map();
  for (const rec of located) {
    if (!rec.leaf) continue;
    for (const l of linesOf(rec)) if (!lineLeaf.has(l)) lineLeaf.set(l, rec.leaf);
  }
  const perLeaf = new Map();
  for (const [l, t] of readLines) {
    const leaf = lineLeaf.get(l);
    if (!leaf) continue;
    const c = collapse(t || '');
    if (!c || c === '?') continue;
    if (!perLeaf.has(leaf)) perLeaf.set(leaf, new Map());
    const m = perLeaf.get(leaf);
    m.set(c, (m.get(c) || 0) + 1);
  }
  for (const [leaf, m] of perLeaf) {
    const dup = new Set([...m].filter(([, n]) => n > 1).map(([t]) => t));
    if (dup.size) dupLines.set(leaf, dup);
  }
}
const lineHasReading = (l) => {
  const v = readLines.get(l);
  return v !== undefined && v !== null && v !== '';
};

/** The raw lines a question asks about (the blank ones carry no text). */
const linesOf = (rec) => {
  const out = [];
  for (let l = rec.from; l <= rec.to; l++) if (collapse(rawLines[l - 1]) !== '') out.push(l);
  return out;
};

/** The leaves a line's question could be on, nearest first: the mapped leaf,
 * then the other side of a leaf-boundary tie. */
function candidateLeaves(rec) {
  const out = rec.leaves ? rec.leaves.slice() : [];
  if (rec.leaf && !out.includes(rec.leaf)) out.unshift(rec.leaf);
  return out;
}

async function runJobs(jobs, concurrency) {
  const todo = jobs.filter((j) => !isDone(j));
  if (!todo.length) return { asked: 0, failed: 0 };
  let done = 0;
  let failed = 0;
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const j = todo[next++];
      const rec = await ask(j.leaf, j.lines, j.model);
      done++;
      if (rec.error) {
        failed++;
        const prev = cache.leaves[jobKey(j)] || {};
        cache.leaves[jobKey(j)] = { leaf: j.leaf, lines: j.lines, model: j.model, error: rec.error, tries: (prev.tries || 0) + 1 };
        console.log(`[${done}/${todo.length}] ${jobKey(j)} FAILED: ${rec.error}`);
      } else {
        /* THE ASKED LINES AND THE ANSWER ARE DIFFERENT FIELDS. MEASURED: the answer
         * was stored under `lines` and overwrote the asked-line array — the cache kept
         * the reading but lost what had been asked. */
        cache.leaves[jobKey(j)] = { ...rec, leaf: j.leaf, lines: j.lines, model: j.model };
        console.log(`[${done}/${todo.length}] ${jobKey(j)} ${j.lines.length} line(s) answered`);
      }
      writeCache();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  writeCache();
  return { asked: done, failed };
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const withLimit = located.slice(0, limit === Infinity ? located.length : limit);
const inScope = (rec) => withLimit.includes(rec);

/* ONE CALL PER LEAF, NOT ONE PER QUESTION: every question on a leaf is answered
 * by the same reading of that leaf, so the lines are gathered ACROSS the leaf's
 * questions and asked together. Asking per question would read the same page once
 * per uncertain fragment on it. */
const linesByLeaf = new Map();
for (const rec of withLimit) {
  if (!rec.leaf) continue;
  if (!linesByLeaf.has(rec.leaf)) linesByLeaf.set(rec.leaf, new Set());
  const set = linesByLeaf.get(rec.leaf);
  for (const l of linesOf(rec)) set.add(l);
}
const leafJobs = (map, size) => {
  const jobs = [];
  for (const [leaf, set] of map) {
    const lines = [...set].sort((a, b) => a - b);
    for (const c of chunk(lines, size)) for (const model of MODELS) jobs.push({ leaf, lines: c, model });
  }
  return jobs;
};

/* ---------- ROUND 1: the mapped leaf, every line of every question on it ---------- */
{
  const jobs = leafJobs(linesByLeaf, CHUNK);
  const uniq = new Map(jobs.map((j) => [jobKey(j), j]));
  const r = await runJobs([...uniq.values()], concurrency);
  console.log(`${slug}: round 1 — ${r.asked} job(s) asked over ${linesByLeaf.size} leaf/leaves, ${r.failed} failed`);
  collect();
}

/* ---------- ROUND 2: the lines round 1 could not read ----------
 * Two fallbacks, both honest and both bounded: the OTHER leaf of a boundary tie
 * (the line fell between two leaves' placed lines, so the mapping itself is a
 * tie), and a second ask of the SAME leaf with fewer lines at once (a chunk the
 * model answered with nothing may answer when it is smaller). */
for (let round = 2; round <= 3; round++) {
  collect();
  collectDupes();
  /* The other side of a boundary tie first — the line fell between two leaves'
   * placed lines, so the mapping itself is a tie — then a second ask of the same
   * leaf in smaller chunks. Both are gathered PER LEAF, as round 1 is. */
  const targets = new Map();
  for (const rec of withLimit) {
    const missing = linesOf(rec).filter((l) => !lineHasReading(l));
    if (!missing.length) continue;
    const leaves = candidateLeaves(rec);
    const leaf = round === 2 && leaves.length > 1 ? leaves[1] : rec.leaf;
    if (!leaf) continue;
    if (!targets.has(leaf)) targets.set(leaf, new Set());
    for (const l of missing) targets.get(leaf).add(l);
  }
  const jobs = leafJobs(targets, round === 2 ? 5 : 5);
  const uniq = new Map(jobs.filter((j) => !isDone(j)).map((j) => [jobKey(j), j]));
  if (!uniq.size) break;
  const r = await runJobs([...uniq.values()], concurrency);
  console.log(`${slug}: round ${round} — ${r.asked} job(s) asked over ${targets.size} leaf/leaves, ${r.failed} failed`);
}
collect();
collectDupes();
const readLeaves = new Set(Object.values(cache.leaves).filter((r) => !r.error).map((r) => r.leaf));
{
  const want = new Set(withLimit.flatMap(linesOf));
  const got = [...want].filter((l) => lineHasReading(l)).length;
  console.log(`${slug}: leaves read ${readLeaves.size}; ${got} of the ${want.size} questioned line(s) carry a printed reading`);
}

/* ---------- 4. FINDINGS ---------- */

/** The change needed to turn the transcription's line into the page's reading:
 * the differing span (transcription, print). A prefix/suffix peel then one span
 * for the middle, which is enough for OCR damage (the two strings are the same
 * text at the same place) and cannot invent a span neither side carries. */
function diffSpan(a, b) {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hi = 0;
  while (hi < a.length - lo && hi < b.length - lo && a[a.length - 1 - hi] === b[b.length - 1 - hi]) hi++;
  const find = a.slice(lo, a.length - hi);
  const replace = b.slice(lo, b.length - hi);
  if (!find && !replace) return [];
  return [{ find, replace, common: lo + hi }];
}

/* Is a reading a SMALL repair — one the model cannot have invented a sentence
 * for? Measured on the changed span, not on the line: a damaged line is often
 * much shorter than the printed line it stands for, so the span is the only
 * scale that means anything. */
const smallRepair = (find, replace) => {
  const fw = find.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
  const rw = replace.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
  return Math.max(fw, rw) <= 3 && Math.max(find.length, replace.length) <= 24;
};

/** The first line AFTER a question that the transcription carries cleanly, with
 * enough letters to be searched for (>= 25). It is the witness's own landmark for
 * "this place in the print": a reading the witness carries must sit just BEFORE
 * it.
 *
 * THE LANDMARK IS TAKEN AFTER THE PASSAGE, never before: the lines before it are
 * often the passage's own continuation in the same damaged run.
 */
function nextCleanLine(rec) {
  for (let l = rec.to + 1; l <= Math.min(rawLines.length, rec.to + 8); l++) {
    const t = tidyPunctuation(collapse(rawLines[l - 1]));
    if (bare(t).length >= 25) return t;
  }
  return null;
}

const findings = [];
const open = [];
const confirmed = [];
const stats = { stamped: 0, duplicate: 0, guardDropped: 0, corroborated: 0, placed: 0, small: 0, uncorroboratedLarge: 0, noReading: 0, illegible: 0, unanchored: 0, same: 0, unsettled: 0 };

for (const rec of located) {
  if (!inScope(rec)) continue;
  const ev = rec.leaf ? evidenceEntry(rec.leaf) : null;
  const lines = linesOf(rec);
  /* WITH TWO MODELS, AGREEMENT IS THE FIRST TEST. A passage whose line(s) the two
   * models did not settle — one model only, or two different readings — is OPEN
   * with that as its reason; nothing is emitted from a reading a single instrument
   * supplied, which is exactly how the model invents a word that fits the sense. */
  const unsettled = lines.filter((l) => unsettledLines.has(l));
  if (unsettled.length) {
    stats.unsettled++;
    open.push({ region: rec.region, passage: rec.passage, leaf: rec.leaf, leaves: rec.leaves, page: ev && ev.page, why: `the configured models did not settle this passage: ${[...new Set(unsettled.map((l) => unsettledLines.get(l)))].join('; ')}` });
    continue;
  }
  const pageLeaf = lines.map((l) => readLines.get(l));
  const answered = lines.filter((l) => lineHasReading(l) || readLines.get(l) === '');
  if (!answered.length) {
    stats.noReading++;
    open.push({ region: rec.region, passage: rec.passage, leaf: rec.leaf, leaves: rec.leaves, page: ev && ev.page, why: `no reading came back for this passage's line(s) from leaf ${rec.leaf || '?'} (and its tie neighbours) — the leaf was read and did not carry the line, or the answer was empty` });
    continue;
  }
  if (pageLeaf.every((v) => v === '' || v === '?')) {
    stats.illegible++;
    open.push({ region: rec.region, passage: rec.passage, leaf: rec.leaf, page: ev && ev.page, why: `the reading came back as ${pageLeaf.includes('?') ? 'illegible ("?")' : 'absent ("")'} for every line of this passage on leaf ${rec.leaf}` });
    continue;
  }

  const spans = [];
  let changedChars = 0;
  let lineChars = 0;
  let differs = false;
  const guardDrop = [];
  for (const l of lines) {
    /* THE SERVED DOMAIN, not the raw line: the extractor joins a block's lines
     * into one paragraph and tidies its punctuation, so the text a `find` must
     * live in is that paragraph's. Same words, same place — only the spacing
     * rules differ. */
    const T = tidyPunctuation(collapse(rawLines[l - 1]));
    const v = readLines.get(l);
    if (v === undefined || v === null || v === '' || v === '?') continue;
    const M = tidyPunctuation(collapse(v));
    lineChars += Math.max(T.length, M.length);
    if (M === T) continue;
    differs = true;
    /* A TRUNCATED READING. MEASURED: the model answered one long line with "The o"
     * — it stopped early, and the rule would have replaced "| The unly-begotten,
     * therefore, the eternal," with that fragment. A reading far shorter than the
     * transcription's own line is not a reading of it. */
    if (bare(M).length + 10 < 0.5 * bare(T).length) {
      guardDrop.push('the page\'s reading is far shorter than the transcription line (a truncated answer)');
      continue;
    }
    for (const raw of diffSpan(T, M)) {
      /* A span must not begin or end on a space: the same words with different
       * spacing are not a reading, and the merge would drop it. Peel the shared
       * spaces off both sides, keeping them in the surrounding text. */
      let { find, replace } = raw;
      while (find.length && replace.length && find[0] === replace[0] && find[0] === ' ') {
        find = find.slice(1);
        replace = replace.slice(1);
      }
      while (find.length && replace.length && find[find.length - 1] === replace[replace.length - 1] && find[find.length - 1] === ' ') {
        find = find.slice(0, -1);
        replace = replace.slice(0, -1);
      }
      const s = { line: l, print: M, find, replace, common: raw.common };
      if (!s.find || s.find === s.replace) continue;
      /* A difference ONLY of spacing is not a reading: the print's words are the
       * same. (MEASURED: the model answers a running head with its own run of
       * spaces, which would otherwise become a rule "repairing" white space.) */
      if (find.replace(/\s+/g, '') === replace.replace(/\s+/g, '')) continue;
      /* WHAT A READING MUST BE. MEASURED over the first emission of these findings:
       * a handful of spans were not readings at all — a lone `1` replaced by a
       * whole sentence, a `.` replaced by `-`, a `?` (the ILLEGIBLE marker, not the
       * print) written into the text, and words deleted outright. Each is an
       * assertion the page cannot support, so each is refused HERE rather than
       * merged and noticed later:
       *   - the find must carry a run of three LETTERS: a rule whose find is
       *     punctuation or a lone digit is not repairing a printed word;
       *   - the replace must not carry the illegible marker the model was told to
       *     answer with ("?" means "cannot read"), unless the find carries one too;
       *   - a replace that is empty while the find carries two or more letters is a
       *     DELETION, and a diff cannot tell a deletion from a misassigned line. */
      if (!/[A-Za-z]{3}/.test(find)) {
        guardDrop.push('the difference is not in a printed word (the transcription has only punctuation or single characters there)');
        continue;
      }
      if (replace.includes('?') && !find.includes('?')) {
        guardDrop.push('the reading came back with the illegible marker');
        continue;
      }
      /* A repair WRITES A PRINTED WORD BACK. MEASURED: one accepted span deleted a
       * stray " SEN" and wrote nothing, another wrote a bare "." — neither is a
       * reading a page can establish, so a replace with fewer than three letters is
       * refused however long the find. */
      if (bare(replace).length < 3) {
        guardDrop.push('the reading writes no printed word back (fewer than three letters)');
        continue;
      }

      if (!s.find.replace(/\s/g, '').length && !s.replace.replace(/\s/g, '').length) continue;
      spans.push(s);
      changedChars += Math.max(s.find.length, s.replace.length);
    }
  }

  if (!spans.length) {
    if (!differs) {
      stats.same++;
      confirmed.push({ region: rec.region, passage: rec.passage, leaf: rec.leaf, page: ev && ev.page, why: 'the reading returned the line as the transcription has it (the page was read; no rule is needed and this is NOT counted as a page-decided reading)' });
    } else {
      stats.guardDropped++;
      open.push({ region: rec.region, passage: rec.passage, leaf: rec.leaf, page: ev && ev.page, why: `the page's reading could not be written as a repair of the transcription: ${[...new Set(guardDrop)].join('; ') || 'the difference was not in a printed word'}` });
    }
    continue;
  }

  /* ANCHORING. The model is choosing WHICH printed line each OCR fragment is, and
   * it can choose wrong (MEASURED: one leaf answered a label with the page's body
   * line on one run and the page's footnote on the next). The reading for the
   * RIGHT line is the SAME WORDS as the transcription's line with the damage
   * repaired, so the two share a long run of text somewhere in the middle; a
   * reading of a DIFFERENT printed line shares only small words ("the", "of").
   *
   * MEASURED WHY THIS IS NOT A PREFIX/SUFFIX TEST: the damage sits in the MIDDLE
   * of these lines, so the first version of this test — comparing only the common
   * head and tail — rejected 584 of the readings as "a different printed line",
   * including the leaf v1-n95 line the witness confirms verbatim ("| vol he olde
   * of felony…" -> "unfold the multitude of beings, and the orders of divine
   * natures, are in-", which shares 0 characters at either end and 24 in the
   * middle). The test is a longest-common-run over letters and digits only, where
   * the print's own spacing is noise. */
  const bareOf = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const commonRun = (a, b) => {
    const A = bareOf(a);
    const B = bareOf(b);
    let best = 0;
    let prev = new Int32Array(B.length + 1);
    for (let i = 1; i <= A.length; i++) {
      const cur = new Int32Array(B.length + 1);
      for (let j = 1; j <= B.length; j++) {
        if (A[i - 1] === B[j - 1]) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        }
      }
      prev = cur;
    }
    return { best, short: Math.min(A.length, B.length) };
  };
  /* THE ANCHOR, in two strengths. A run of 8 letters between the reading and the
   * transcription's line is evidence on its own. A shorter run (6-7) is evidence
   * only if the second transcription carries the reading as well — TWO independent
   * agreements, which is the same standard the long-rewrite gate below applies.
   * MEASURED over the readings this tool has already taken: of the lines a run of
   * 6-7 was rejected for, 47 of 68 are carried by the witness verbatim, and the run
   * histogram is bimodal (a mass at 0-3 letters — lines the model plainly read
   * somewhere else — and a tail from 5 up), so 6 with corroboration sits in the
   * valley between "the same words with the damage repaired" and "another line". */
  const unanchored = (s) => {
    const T = tidyPunctuation(collapse(rawLines[s.line - 1]));
    const { best, short } = commonRun(T, s.print);
    s.run = best;
    s.corrob = corroborated(s.replace);
    return best < 8 && !(best >= 6 && best >= 0.6 * short && s.corrob);
  };
  const loose = spans.filter(unanchored);

  /* A RUNNING HEAD STAMPS ITS OWN PAGE. Some of these lines are the page's running
   * head ("CHAP. XIX. OF PLATO. 261") and the transcription has destroyed it
   * ("CHAP. Six SS OF. 'PLATO. pret: 262 z"); such a reading shares almost nothing
   * with the transcription, so no text comparison can anchor it — but it carries a
   * PAGE NUMBER, and the record gives this leaf's own printed page. A head reading
   * whose number IS this leaf's page has located ITSELF: it is this page's head, and
   * nothing else on this page would print that number. (MEASURED over the readings
   * taken: 28 of the 54 head-like rejected readings stamp the leaf's own page.) */
  /* A PAGE LINE IS READ ONCE. MEASURED: on a page whose questioned lines were
   * mostly noise the model returned the SAME sentence for two different labels
   * ("conception of this monad." for two lines). One of those two lines is not that
   * sentence, and nothing in the pair says which — so both are kept OPEN, unless the
   * reading stamps the leaf's own page and has located itself. */
  const dupReading = lines.some((l) => {
    const t = readLines.get(l);
    return t && (dupLines.get(rec.leaf) || new Set()).has(collapse(t));
  });
  const HEADY = /^(?:CHAP|CHAPTER|BOOK|ON THE THEOLOGY)\b|\bOF PLATO\b/i;
  const tailsNumber = (t) => {
    const m = /(?:^|\s)(\d{1,4})\s*$/.exec(t.trim());
    return m ? Number(m[1]) : null;
  };
  const leafPage = rec.leaf ? pageOfLeaf(rec.leaf) : null;
  const pageStamped = leafPage != null && spans.some((s) => HEADY.test(s.print.trim()) && tailsNumber(s.print) === leafPage);

  /* THE WITNESS'S OWN PLACE, as a second instrument for a reading the
   * transcription's own damaged line cannot vouch for. A reading is PLACED when
   * the witness carries it AND carries the transcription's next clean line just
   * AFTER it (within 12 of the witness's lines): that is the reading standing
   * where the print has it, not merely somewhere in 2.4 MB. It is what recovers
   * the badly-damaged lines — MEASURED: the first version of the anchoring test
   * rejected 584 readings, among them "| vol he olde of felony…" ->
   * "unfold the multitude of beings, and the orders of divine natures, are in-",
   * which shares nothing at either end of the line and which the witness carries
   * verbatim. */
  const landmark = spans.length ? nextCleanLine(rec) : null;
  const landmarks = landmark ? witnessLinesOf(landmark, 25) : [];
  const placed = spans.some((s) => {
    const here = witnessLinesOf(s.print);
    return here.some((p) => landmarks.some((q) => q >= p && q - p <= 12));
  });
  if (dupReading && !pageStamped && !placed) {
    stats.duplicate++;
    open.push({ region: rec.region, passage: rec.passage, leaf: rec.leaf, page: ev && ev.page, why: 'the same printed line was returned for more than one of this leaf\'s lines — which of them it belongs to cannot be told, not accepted' });
    continue;
  }
  if (loose.length && !placed && !pageStamped) {
    stats.unanchored++;
    open.push({ region: rec.region, passage: rec.passage, leaf: rec.leaf, page: ev && ev.page, why: `the reading shares no run of 8 characters with the transcription's line (the longest common run is ${loose[0].run}) and the second transcription does not place it at this line — the model read a different printed line, not accepted` });
    continue;
  }
  const whole = spans.map((s) => `${s.find} -> ${s.replace}`).join('; ');
  const corrob = spans.filter((s) => s.corrob).length;
  const allSmall = spans.every((s) => smallRepair(s.find, s.replace));

  /* THE DECISION. A long replacement is accepted only where the second
   * transcription carries the reading too — two instruments agreeing on a
   * sentence will not both have invented it. A short repair (<= 3 words) is
   * accepted on the page's own authority: that is the size of an ordinary OCR
   * misread, and it is the case a witness that is damaged in the same place
   * cannot corroborate. Anything else — a long run the witness does not carry —
   * is kept OPEN: this is exactly where a model would invent. */
  if (!allSmall && !corrob && !placed) {
    stats.uncorroboratedLarge++;
    open.push({ region: rec.region, passage: rec.passage, leaf: rec.leaf, page: ev && ev.page, why: `the page's reading rewrites ${changedChars} of ${lineChars} print characters (${whole.slice(0, 120)}) and the second transcription neither carries it nor places it at this line — past the damaged span and uncorroborated, not accepted` });
    continue;
  }
  if (pageStamped) stats.stamped++;
  else if (corrob) stats.corroborated++;
  else if (placed) stats.placed++;
  else stats.small++;

  const page = ev ? ev.page : null;
  for (const s of spans) {
    findings.push({
      region: rec.region,
      find: s.find,
      replace: s.replace,
      kind: '1',
      class: 'reading',
      note:
        `the print reads ${JSON.stringify(s.replace)} where the transcription has ${JSON.stringify(s.find)}` +
        ` (page image, ${page != null ? `printed page ${page} = ` : ''}archive ${rec.leaf}). ` +
        `The transcription and the ${witnessLabel} are both OCR passes over this print, and the full read` +
        ` could not settle the question.` +
        (pageStamped
          ? ` The reading stamps printed page ${leafPage}, which is THIS leaf's own recorded page (the page model's measured offset), so the reading has located itself.`
          : corrob
          ? ' The second transcription carries the reading at this place.'
          : placed
            ? ' The second transcription places the reading at this place — it carries the words, with the transcription\'s own next clean line just after them.'
            : ' The second transcription is damaged at this place and carries no reading to corroborate it.'),
      witness: `page image, ${page != null ? `printed page ${page} = ` : ''}archive ${rec.leaf}`,
      decided_by: 'page',
      evidence: [ev],
      line: s.line,
      leaf: rec.leaf,
      corroborated: !!s.corrob,
    });
  }
}

const artifact = {
  slug,
  models: MODELS,
  agreesAcrossModels: MODELS.length > 1,
  from: fromFile,
  method: table ? table.method : 'divisions.json anchors',
  unsure: unsure.length,
  located: located.length,
  unlocated: unlocated.length,
  leavesRead: readLeaves.size,
  findings,
  open,
  confirmed,
  unlocatable: unlocated.map((r) => ({ region: r.region, passage: r.passage })),
  stats,
};
writeFileSync(outFile, `${JSON.stringify(artifact, null, 1)}\n`);

console.log('--- findings ---');
console.log(`  RESOLVED with a rule: ${findings.length} finding(s) over ${new Set(findings.map((f) => f.leaf)).size} leaf/leaves (${stats.corroborated} carried by the second transcription, ${stats.placed} placed in it at this line, ${stats.stamped} a running head stamping this leaf's own page, ${stats.small} a small repair)`);
console.log(`  RESOLVED with no rule needed (the page reads as the transcription prints it): ${confirmed.length}`);
console.log(`  STILL OPEN: ${open.length}`);
console.log(`     the models did not agree: ${stats.unsettled}; no reading came back: ${stats.noReading}; illegible on the page: ${stats.illegible}; one reading returned for more than one line: ${stats.duplicate}; the reading could not be written as a repair: ${stats.guardDropped}; uncorroborated long rewrite: ${stats.uncorroboratedLarge}; reading not anchored to the transcription's line: ${stats.unanchored}`);
console.log(`  not located in the transcription at all: ${unlocated.length}`);
console.log(`  artifact: ${outFile}`);
