#!/usr/bin/env node
/**
 * tools/greek-runs.mjs — restore the GREEK this print's scan read as Latin
 * lookalikes, off the PAGE IMAGES, and emit findings the merge can fold in.
 *
 * WHY THIS EXISTS. The 1816 Proclus prints Greek inside Taylor's brackets and in
 * his textual notes (the lemmas: "For τῆς ἁπλότητος I read τὴν ἁπλότητα"). The
 * scan read that Greek as LATIN LOOKALIKES — `xou`, `yag`, `iregi` for καὶ, γὰρ,
 * περὶ, `ofcov` for οἷον — so the served reading view shows a Latin word where the
 * print has a Greek one, and the design's serif stack has nothing Greek to draw.
 *
 * THE FINDER IS tools/vocab.mjs, not this tool. It reports every token the
 * dictionary, the parallel and the shelf's Greek forms do not know (`unknown`),
 * and every short run carrying a Greek-adjacent mark the Latin tokeniser cannot
 * see through (`greeklike`: `y«g` is `y`+`g` with the `«` between, so no token
 * ever contains the run). This tool takes those tokens, asks WHICH runs are Greek
 * rather than English garble or the print's Latin, and then reads the page.
 *
 * WHAT IT READS, AND THE ACCEPTANCE POLICY. The page image is the only honest
 * source: the transcription and the second transcription are OCR passes over the
 * same print and carry the same flattening. But MEASURED, this model's reading of
 * the print's Greek is not stable, and HOW THE QUESTION IS PUT decides whether it
 * reads the page at all or supplies a word that fits the sense. Both settings were
 * measured before this tool was pointed at the work:
 *
 *   - with a prompt that offered `""` for "not on this page" (the wording
 *     tools/vision-unsure.mjs uses for English), one faint footnote lemma (`isiov`,
 *     source line 6418) came back as ἰδίων, ἴσον, εἰσὶν, ἰδίον, ἐστι over eight
 *     draws — five different words, none of them read off the page;
 *   - with the prompt below — every line IS on this page, read the letters, write
 *     `?` for a word you cannot see, never substitute a word that fits the sense —
 *     the same leaf's other line came back IDENTICAL in all three draws ("For ἀεὶ
 *     ἐνεργείᾳ, read, ὡς ἐν ἐνεργείᾳ"), and the lemma came back ζωήν twice of
 *     three.
 *
 * So the tool puts the question that way, and then applies the only test the
 * instrument supports: the leaf is drawn SAMPLES times OF EACH CONFIGURED MODEL and
 * a line is accepted only where two or more draws AGREE character for character —
 * the standard the rest of the pipeline applies to two independent witnesses (two
 * instruments did not both invent the same characters). Two MODELS are configured
 * by default (see MODELS below), because MEASURED on this print the VL models are
 * complementary: each reads Greek the other misreads, and neither is reliable
 * alone. Where the draws disagree the run stays OPEN with the disagreement as its
 * reason, and no Greek is invented. A reading also has to be GREEK: a draw that
 * comes back Latin or English is not this tool's finding.
 *
 * OUTPUT. `tools/edits/<slug>.greek.json`, proposals in the Elements of Theology
 * form: `{find, replace, class, note, decided_by, witness, evidence, line, leaf}`
 * — `find` always the transcription's OWN characters (so the merge's guard holds
 * it), `replace` the page's. The notes name the leaf and its printed page, and the
 * `evidence` entry is the scan of the leaf this edition HOLDS, so the rule's
 * citation resolves on the site.
 *
 *   node tools/greek-runs.mjs <slug> [--vocab FILE] [--xml-dir DIR] [--out FILE]
 *        [--lines FILE] [--samples N] [--concurrency N] [--limit N] [--report]
 *
 * NOT in the build's module graph: it reads the archive item's `_djvu.xml`
 * (megabytes, not in the repo) and calls the vision model by hand, like
 * `tools/vision-unsure.mjs` and `tools/divisions.mjs`.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, readEdition, tidyPunctuation, sha256 } from './extract.mjs';
import { TEXTS } from './shelf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* THE ENDPOINT, and the models. The library's standing order points its LLM work
 * at the DeepSeek proxy on 10.0.0.1:8321; THIS pass reads a page image, and the
 * page-image instruments are the DeepInfra VL models on 10.0.0.1:8322 — the
 * DeepSeek vision model returns EMPTY on many of these leaves (its reasoning
 * burns the output budget), which is what hobbled the first Greek pass.
 *
 * MORE THAN ONE MODEL, AND WHY. MEASURED on this print: the VL models are
 * COMPLEMENTARY rather than one being better. On a leaf whose Greek is known from
 * another edition's independently verified page, google/gemma-3-27b-it read the
 * key word `οὐκ` right, WITH its breathing, where Qwen/Qwen3-VL-235B-A22B-Instruct
 * read it as `ὅτι`; on other leaves the order reverses. One model's reading is
 * therefore not evidence on its own, and MODELS takes a comma-separated list: every
 * (leaf, lines) job is drawn once per model per sample, and the consensus below
 * counts draws from ANY of them, so a reading has to be produced twice over by
 * instruments that did not both invent it. LIBRARY_GREEK_MODELS is the list;
 * LIBRARY_GREEK_MODEL remains the single-model form. */
const ENDPOINT = process.env.LIBRARY_GREEK_URL || 'http://10.0.0.1:8322/v1/chat/completions';
const MODELS = (process.env.LIBRARY_GREEK_MODELS || process.env.LIBRARY_GREEK_MODEL || 'Qwen/Qwen3-VL-235B-A22B-Instruct')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const REQUEST_TIMEOUT_MS = 300_000;
/* MEASURED (tools/vision-unsure.mjs): this model's reasoning runs away
 * nondeterministically and an answer that hits the cap comes back EMPTY. */
const MAX_TOKENS = 32000;
/* A leaf's questioned lines go in one call; past ~a dozen the answer (and its
 * reasoning) is long enough that the cap bites. */
const CHUNK = 8;
/* THE PROMPT IS PART OF THE READING. MEASURED (see the docblock): the same leaf
 * drawn under a different wording of the question produced different Greek, so a
 * cached draw is only usable under the prompt that made it. The id below is
 * carried in every cache key; change the prompt, change the id, and the draws are
 * re-asked rather than mixed. */
const PROMPT_ID = 'greek-letters-v1';

const GREEK = /[\u0370-\u03ff\u1f00-\u1fff]/;
const MARK = /[«»^\\~\/>£*_|#]/;
/* THE ENGLISH WORDLIST, the same one tools/vocab.mjs and tools/greek.mjs use, from
 * the same machine cache. The English-preservation test below needs to know
 * whether a token IS an English word, and the instrument's own `unknown` set
 * cannot answer it: `unknown` is built over the READING VIEW and already excludes
 * every token the parallel carries, so a lookalike fragment that also occurs in
 * the parallel (`rri`, `rag`, `xat`) is absent from it and would be read as
 * English to be preserved — MEASURED, that rejected four correctly-read Greek
 * quotations (lines 32928, 32930, 33032, 38771). A wordlist asks the question
 * directly. WITH NO LIST the test falls back to the instrument's sets, and says so
 * in the artifact, because a silent degradation here would quietly move the line
 * the pass accepts. */
const CACHE = join(process.env.XDG_CACHE_HOME || join(process.env.HOME || '', '.cache'), 'neoplatonic-library');
const WORDS = (() => {
  const f = join(CACHE, 'words.txt');
  if (!existsSync(f)) return null;
  return new Set(readFileSync(f, 'utf8').split(/\s+/).filter(Boolean));
})();
const isEnglishWord = (w) => (WORDS ? WORDS.has(w) : (!unknown.has(w) && !greeklike.has(w)));

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--vocab', '--xml-dir', '--out', '--samples', '--concurrency', '--limit', '--lines', '--list']);
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
  console.error('usage: node tools/greek-runs.mjs <slug> [--vocab FILE] [--xml-dir DIR] [--out FILE] [--lines FILE] [--samples N] [--concurrency N] [--limit N] [--report]');
  process.exit(2);
}
const entry = TEXTS.find((t) => t.slug === slug);
if (!entry) throw new Error(`greek-runs: no such text on the shelf: ${slug}`);
const editDir = join(ROOT, 'tools', 'edits');
const vocabFile = opt('vocab', join(editDir, `${slug}.vocab.json`));
const xmlDir = opt('xml-dir', '');
const outFile = opt('out', join(editDir, `${slug}.greek.json`));
const samples = num('samples', 3);
const concurrency = num('concurrency', 6);
const limit = num('limit', Infinity);
const reportOnly = argv.includes('--report');
/* THE TARGETED RE-RUN. A pass that only re-reads SOME runs — the ones a pass left
 * open, say — names them in a file (a JSON array of source line numbers, or an
 * object with a `lines` array) and only those runs are placed and read. Everything
 * else the tool does is unchanged, so the selection is data, not a second tool. */
const linesFile = opt('lines', '');
const LINES_ONLY = (() => {
  if (!linesFile) return null;
  const j = JSON.parse(readFileSync(linesFile, 'utf8'));
  const arr = Array.isArray(j) ? j : j.lines || [];
  return new Set(arr.map(Number));
})();

const EDITION = join(ROOT, 'data', 'editions', slug);
const version = readdirSync(join(EDITION, 'versions'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().pop();
const versionDir = join(EDITION, 'versions', version);
const source = readFileSync(join(versionDir, 'source.txt'), 'utf8').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
const scansDir = join(EDITION, 'scans');
const cachePath = join(EDITION, 'greek-vision.json');

/* ---------- the transcription's lines, and the served domain ---------- */

const rawLines = source.split('\n');
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/** The line as the EXTRACTOR SERVES it: the same per-line `tidyPunctuation` the
 * extractor applies when it opens a block (MEASURED: 8,577 of 42,410 non-blank
 * lines are changed by it, and a `find` taken before it is dropped by the merge
 * as "not in the served transcription"). */
const servedLine = (l) => tidyPunctuation(collapse(rawLines[l - 1]));

/* ---------- 1. THE GREEK RUNS (from the vocab instrument's own tokens) ---------- */

const vocab = JSON.parse(readFileSync(vocabFile, 'utf8'));
const unknown = new Set((vocab.unknown || []).map((r) => r.token.toLowerCase()));
const greeklike = new Set((vocab.greeklike || []).map((r) => r.token.toLowerCase()));
const lettersOf = (s) => s.replace(/[^A-Za-zÀ-ÿ]/g, '');

/** Every maximal run of ADJACENT tokens that the instrument does not know or that
 * carries a Greek-adjacent mark. Adjacency is a single space on the served line,
 * so a run never crosses a line end (a run that did would be two runs). */
function runsOnLine(line) {
  const toks = [...servedLine(line).matchAll(/\S+/g)].map((m) => ({ raw: m[0], i: m.index }));
  const out = [];
  let cur = null;
  for (const t of toks) {
    const low = t.raw.toLowerCase();
    const letters = lettersOf(t.raw).length;
    const marked = MARK.test(t.raw) && letters >= 2;
    const isRun = unknown.has(low) || greeklike.has(low) || (marked && !/^[A-Z]/.test(t.raw));
    if (!isRun) { cur = null; continue; }
    const gap = cur ? servedLine(line).slice(cur.last.i + cur.last.raw.length, t.i) : '';
    if (cur && gap === ' ') { cur.toks.push(t); cur.last = t; }
    else { cur = { line, toks: [t], last: t }; out.push(cur); }
  }
  return out.map((r) => {
    const text = r.toks.map((t) => t.raw).join(' ');
    const letters = lettersOf(text).length;
    const known = r.toks.filter((t) => unknown.has(t.raw.toLowerCase()) || greeklike.has(t.raw.toLowerCase())).reduce((a, t) => a + lettersOf(t.raw).length, 0);
    /* THE RUN'S OWN SPAN on the line: the English-preservation test below needs to
     * know which words stand INSIDE a Greek run (a lookalike fragment can BE an
     * English word — `purr**` at line 32930, `the` inside a garble — and counting
     * those as English to be preserved rejected three correctly-read Greek
     * quotations). */
    return { line, text, from: r.toks[0].i, to: r.toks[r.toks.length - 1].i + r.toks[r.toks.length - 1].raw.length, n: r.toks.length, letters, frac: letters ? known / letters : 0, marked: r.toks.some((t) => MARK.test(t.raw)) };
  });
}

/* LATIN, NOT GREEK. Taylor's Introduction quotes a long Latin passage (and the
 * notes quote Latin writers); its words are out of vocabulary exactly as the
 * Greek's are, so the instrument cannot tell them apart token by token. The
 * context can: a Latin run stands among Latin function words. The window is the
 * run's own line and the line either side. REPORTED, never emitted — repairing
 * the print's Latin is not this pass's job. */
const LATIN = /\b(et|ut|enim|est|non|quae|qui|quod|quum|cum|ad|ex|per|sed|sunt|esse|unde|nam|hoc|hac|hic|autem|atque|quidem|vero|igitur|rerum|natura|anima|corpus|deus|deorum|dicitur|possunt|omnibus|omnium|ipsa|ipse|suo|suis|ejus)\b/gi;
const ENGLISH = /\b(the|of|and|to|is|that|which|in|it|for|as|by|with|are|be|this|from|his|not|but|they|their|or|an|have|has|was|were|so|if|when|all)\b/gi;
/* THE SCAN'S OWN FOOTER, which is not a reading at all: `Digitized by v^ooQle`
 * (and its siblings `D itized by L.jOOQle`, `Digitized t`) stands on nearly every
 * leaf of this copy — 279 of the served tokens are this one string. It is
 * `greeklike` only for the `^`, and the 517 open questions carry it as its own
 * class; turning it into "Google" is not Greek and not this pass's finding. */
const WATERMARK = /oog|ooq|oQle|itized/i;
function latinish(line) {
  const win = [line - 1, line, line + 1].filter((l) => l >= 1 && l <= rawLines.length).map((l) => rawLines[l - 1]).join(' ');
  const la = (win.match(LATIN) || []).length;
  const en = (win.match(ENGLISH) || []).length;
  return la >= 4 && la > en * 1.5;
}

const runs = [];
const latin = [];
const watermark = [];
for (let l = 1; l <= rawLines.length; l++) {
  if (collapse(rawLines[l - 1]) === '') continue;
  for (const r of runsOnLine(l)) {
    if (r.letters < 4) continue;
    if (!(r.frac >= 0.6 || (r.marked && r.frac >= 0.45))) continue;
    if (WATERMARK.test(r.text)) { watermark.push(r); continue; }
    if (latinish(l)) latin.push(r);
    else runs.push(r);
  }
}

/* ---------- 2. THE LEAF TABLE (line -> leaf, the item's own text layer) ---------- */

const XML_ENTITIES = [['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&apos;', "'"], ['&amp;', '&']];
const xmlText = (s) => XML_ENTITIES.reduce((t, [from, to]) => t.split(from).join(to), s);
const wordsOf = (t) => t.replace(/\s+/g, ' ').trim().split(' ').filter((w) => /[A-Za-z0-9]/.test(w));

/** The item's own `_djvu.xml`: every leaf's lines. Leaf `n` is the object whose
 * usemap names page `nNNN` — MEASURED on this item against scan.json's verified
 * ends (n76 is printed page 1, n500 is printed page 425). */
function parseDjvu(xml) {
  return [...xml.matchAll(/<OBJECT\b[\s\S]*?<\/OBJECT>/g)].map((m) => {
    const raw = m[0];
    const map = /usemap="[^"]*?(\d{4,5})\.djvu"/.exec(raw);
    const lines = [];
    for (const lm of raw.matchAll(/<LINE>([\s\S]*?)<\/LINE>/g)) {
      const ws = [...lm[1].matchAll(/<WORD\s+coords="([^"]+)"(?:\s+x-confidence="(\d+)")?\s*>([\s\S]*?)<\/WORD>/g)].map((w) => xmlText(w[3]));
      if (ws.length) lines.push(ws.join(' ').replace(/\s+/g, ' ').trim());
    }
    return { leaf: map ? Number(map[1]) : null, lines };
  });
}

/** A LINE -> LEAF mapper, built by fingerprinting each leaf's own text into the
 * transcription — the same measurement `tools/divisions.mjs` step 1 and
 * `tools/vision-unsure.mjs` make, re-made here so this tool stands on the item's
 * own text layer rather than on an interpolated anchor. Leaves are kept in their
 * archive order and must place MONOTONICALLY: a fingerprint landing behind the
 * run so far is a coincidental token match, not the leaf. */
function leafTable() {
  if (!xmlDir || !existsSync(xmlDir)) return null;
  const names = readdirSync(xmlDir).filter((n) => n.endsWith('_djvu.xml'));
  const scan = existsSync(join(EDITION, 'scan.json')) ? JSON.parse(readFileSync(join(EDITION, 'scan.json'), 'utf8')) : { items: [] };
  const items = scan.items || [];
  const files = [];
  for (const it of items) {
    let name = names.find((n) => n.includes(it.archive_id));
    if (!name && it.whole_sha256) {
      const txt = readdirSync(xmlDir).find((n) => n.endsWith('_djvu.txt') && sha256(readFileSync(join(xmlDir, n))) === it.whole_sha256);
      if (txt) name = names.find((n) => n === txt.replace(/_djvu\.txt$/, '_djvu.xml'));
    }
    if (!name && items.length === names.length) name = names[items.indexOf(it)];
    if (name && !files.includes(name)) files.push(name);
  }
  /* ONLY THE EDITION'S OWN ITEM: the directory beside it holds the OTHER copies'
   * `_djvu.xml` too (they are witnesses), and their leaves are numbered in their
   * own runs — folding them in would place a line from this transcription on to a
   * leaf of a different scan. A name that matches nothing is reported, not
   * substituted. */
  if (!files.length) return null;

  /* The transcription's tokens with their line, for the fingerprint search. */
  const tokens = [];
  const tokenLine = [];
  for (let i = 0; i < rawLines.length; i++) {
    const c = collapse(rawLines[i]);
    if (c === '') continue;
    for (const m of c.matchAll(/\S+/g)) { tokens.push(m[0]); tokenLine.push(i + 1); }
  }
  const index = new Map();
  tokens.forEach((w, i) => { if (!index.has(w)) index.set(w, []); index.get(w).push(i); });
  const place = (text) => {
    const toks = wordsOf(text);
    if (toks.length < 4) return null;
    /* GROW THE KEY UNTIL IT NAMES ONE PLACE. A short key whose first word is
     * common matches many times; the same key one word longer usually does not —
     * MEASURED, stopping at the first key that is not unique (rather than growing
     * it) left the whole front matter unplaced, because "the" opens most lines on
     * the page. `findKey` returns at most two hits, so a key that matches twice is
     * "not unique" and one word longer is tried; a key that matches NOWHERE ends
     * the search (a longer key can only match fewer places). */
    const findKey = (key) => {
      const c = index.get(key[0]);
      if (!c) return [];
      const out = [];
      for (const p of c) {
        let ok = true;
        for (let k = 1; k < key.length; k++) if (tokens[p + k] !== key[k]) { ok = false; break; }
        if (ok) {
          out.push(p);
          if (out.length > 1) return out;
        }
      }
      return out;
    };
    for (let n = 5; n <= Math.min(18, toks.length); n++) {
      const h = findKey(toks.slice(0, n));
      if (h.length === 1) return tokenLine[h[0]];
      if (h.length === 0) break;
    }
    return null;
  };

  const pairs = [];
  const placed = [];
  let dropped = 0;
  for (const name of files) {
    const objs = parseDjvu(readFileSync(join(xmlDir, name), 'utf8'));
    let last = -1;
    for (const o of objs) {
      if (o.leaf == null) continue;
      /* A LEAF'S OPENING LINE, chosen against the run so far. The naive rule —
       * walk every line of every leaf and keep the ones that stand forward — was
       * MEASURED unusable here: the title page's lines ("ON THE THEOLOGY OF
       * PLATO,") are verbatim the body's RUNNING HEADS, so one of them fingerprints
       * 4,000 lines into the work, everything after it reads as backward, and
       * 1,817 of the first 1,869 placements were dropped. Taking, per leaf, the
       * SMALLEST placement that stands after the previous leaf's keeps a spurious
       * far-forward match out of the run: the leaf's own opening line is placed
       * near the leaf's own place, and the coincidental one is discarded. */
      const cand = [];
      for (const l of o.lines) {
        const line = place(l);
        if (line != null) cand.push(line);
      }
      cand.sort((a, b) => a - b);
      const pick = cand.find((x) => x > last);
      if (pick === undefined) { dropped++; continue; }
      last = pick;
      pairs.push({ leaf: o.leaf, line: pick });
    }
    placed.push(`${name}: leaves ${objs[0].leaf}..${objs[objs.length - 1].leaf}`);
  }
  if (!pairs.length) return null;
  const arr = pairs.slice().sort((a, b) => a.line - b.line);
  const at = (line) => {
    if (line <= arr[0].line) return { num: arr[0].leaf, conf: 'before-first' };
    const last = arr[arr.length - 1];
    if (line >= last.line) return { num: last.leaf, conf: 'after-last' };
    let lo = 0;
    let hi = arr.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (arr[m].line <= line) lo = m;
      else hi = m;
    }
    const a = arr[lo];
    const b = arr[hi];
    const t = (line - a.line) / (b.line - a.line);
    return { num: t < 0.5 ? a.leaf : b.leaf, conf: t < 0.5 ? 'near-left' : 'near-right' };
  };
  return { at, leaves: arr.length, dropped, placed };
}

/* ---------- 3. LOCATE each run's leaf, and group by leaf ---------- */

const table = leafTable();
if (!table) throw new Error('greek-runs: no --xml-dir with the item\'s _djvu.xml — a run cannot be placed on a leaf without the item\'s own text layer');

const scan = existsSync(join(EDITION, 'scan.json')) ? JSON.parse(readFileSync(join(EDITION, 'scan.json'), 'utf8')) : { items: [] };
const offsetOf = new Map();
for (const it of scan.items || []) if (Number.isFinite(it.archiveOffset)) offsetOf.set(it.prefix || '', it.archiveOffset);
const heldFiles = new Set(readdirSync(scansDir).filter((f) => /^(?:v\d+-)?n\d+\.jpg$/.test(f)));
/** The held leaf for an archive leaf number, whichever volume's run it falls in. */
function heldLeaf(num) {
  if (heldFiles.has(`n${num}.jpg`)) return { file: `n${num}.jpg`, leaf: num, vol: '', page: null };
  for (const [prefix, off] of offsetOf) {
    const f = `${prefix}-n${num}.jpg`;
    if (heldFiles.has(f)) return { file: f, leaf: num, vol: prefix, page: num - off };
  }
  return null;
}

const placed = [];
const unplaced = [];
for (const r of runs) {
  const at = table.at(r.line);
  const held = at ? heldLeaf(at.num) : null;
  if (!held) { unplaced.push({ ...r, leaf: at ? at.num : null }); continue; }
  placed.push({ ...r, leafNum: at.num, leaf: held, conf: at.conf });
}

console.log(`${slug}: the Greek runs of the served transcription`);
console.log(`  the instrument's tokens: ${unknown.size} unknown + ${greeklike.size} greek-marked; runs found ${runs.length} (${latin.length} look Latin and are reported, not read)`);
console.log(`  the English wordlist: ${WORDS ? `${WORDS.size} word(s) from ${join(CACHE, 'words.txt')}` : 'NOT BUILT — the English-preservation test falls back to the instrument\'s own sets (run tools/vocab.mjs once to build it)'}`);
console.log(`  leaf map: ${table.leaves} leaf/leaves placed from ${table.placed.join('; ')} (${table.dropped} fingerprint(s) dropped as non-monotone)`);
console.log(`  placed on a HELD leaf: ${placed.length}; NOT held by the edition: ${unplaced.length}${unplaced.length ? ` (leaves ${[...new Set(unplaced.map((u) => u.leaf))].sort((a, b) => a - b).join(', ')})` : ''}`);
const byLeaf = new Map();
const selected = LINES_ONLY ? placed.filter((r) => LINES_ONLY.has(r.line)) : placed;
if (LINES_ONLY) console.log(`  --lines ${linesFile}: ${selected.length} of ${placed.length} placed run(s) are in the target set`);
for (const r of selected.slice(0, limit === Infinity ? selected.length : limit)) {
  if (!byLeaf.has(r.leaf.file)) byLeaf.set(r.leaf.file, { leaf: r.leaf, lines: new Set(), runs: [] });
  byLeaf.get(r.leaf.file).lines.add(r.line);
  byLeaf.get(r.leaf.file).runs.push(r);
}
console.log(`  leaves to read: ${byLeaf.size}; runs on them: ${[...byLeaf.values()].reduce((a, g) => a + g.runs.length, 0)}`);
/* `--list FILE` writes the finder's own census — every run, where it was placed,
 * and the ones the edition does not hold — as DATA, so the selection rule can be
 * re-run against it without re-finding anything. */
{
  const li = argv.indexOf('--list');
  if (li >= 0 && argv[li + 1]) {
    writeFileSync(argv[li + 1], `${JSON.stringify({
      runs,
      latin,
      placed: placed.map((r) => ({ line: r.line, text: r.text, frac: r.frac, n: r.n, letters: r.letters, marked: r.marked, leaf: r.leaf.file, leafNum: r.leaf.leaf, page: r.leaf.page, conf: r.conf })),
      unplaced: unplaced.map((r) => ({ line: r.line, text: r.text, n: r.n, letters: r.letters, frac: r.frac, marked: r.marked, leaf: r.leaf })),
    }, null, 1)}\n`);
    console.log(`  census written to ${argv[li + 1]}`);
  }
}
if (reportOnly) process.exit(0);

/* ---------- 4. READ: SAMPLES draws of each leaf, cached after every call ---------- */

const PROMPT_HEAD =
  'Answer immediately with the JSON object only. Do not deliberate.\n' +
  'This is one scanned page of an 1816 book (Proclus, The Theology of Plato, translated by Thomas Taylor).\n' +
  'EVERY line below IS printed on THIS page; the OCR that read it off the page is damaged, and where the\n' +
  'print sets GREEK the OCR flattened it into Latin lookalikes. The numbers are only LABELS for the lines\n' +
  'they stand beside; they are not page or line numbers of anything.\n' +
  'For each labelled line, transcribe what the page ACTUALLY PRINTS on that line, character for character.\n' +
  'FOR THE GREEK, WHICH IS THE WHOLE POINT: find the printed Greek and read its LETTERS OFF THE PAGE.\n' +
  '  - never substitute a word that fits the sense of the sentence: if the letters cannot be seen, write "?" for THAT WORD and transcribe the rest of the line;\n' +
  '  - return GREEK as GREEK UNICODE, with the breathings and accents the print carries; NEVER transliterate it into Latin letters and never re-spell it as the OCR\'s Latin lookalike;\n' +
  '  - follow the printed word order, and keep the print\'s own spelling, capitalisation and punctuation;\n' +
  '  - do NOT modernise, do NOT paraphrase, do NOT add or remove words of your own, and do NOT rewrite a line that already reads as the page prints it;\n' +
  '  - if a labelled line is printed but the whole of it is too faint to read, its value is "?" — never a guess.\n' +
  'Return a JSON object with one key per label, exactly as labelled.\nLINES:\n';

function parseAnswer(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      const o = JSON.parse(text.slice(start, end + 1));
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch { /* a shorter span */ }
  }
  return null;
}

async function ask(file, lines, model) {
  const src = join(scansDir, file);
  if (!existsSync(src)) return { error: `no held leaf ${file}` };
  const buf = readFileSync(src);
  const mime = extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    /* `low` is the working effort (MEASURED in tools/vision-unsure.mjs); the last
     * attempt drops it so a stubborn page still gets the model's own effort. The
     * DeepInfra VL models do not know this knob, and MEASURED they answer at `low`
     * as well as without it (their answers here are one or two lines), so it is
     * kept only for the DeepSeek endpoint's sake. */
    reasoning_effort: 'low',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${PROMPT_HEAD}${lines.map((l, i) => `${i + 1}: ${rawLines[l - 1]}`).join('\n')}\n` },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
        ],
      },
    ],
  };
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt >= 4) delete body.reasoning_effort;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(`HTTP ${res.status}: ${json.error ? json.error.message : ''}`);
      const text = ((json.choices && json.choices[0]) || {}).message?.content || '';
      const parsed = parseAnswer(text);
      if (!parsed) { if (attempt < 4) continue; return { error: 'no parseable answer over 4 attempts' }; }
      const out = {};
      for (let i = 0; i < lines.length; i++) {
        const v = parsed[String(i + 1)];
        if (typeof v === 'string') out[lines[i]] = v;
      }
      if (!Object.keys(out).length) { if (attempt < 4) continue; return { error: 'the answer carried none of the asked labels' }; }
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

/* THE CACHE CARRIES THE MODEL IN EVERY KEY. A draw is only usable as the MODEL
 * that made it: the whole point of running two of them is that their readings
 * differ, so a key that named only the leaf would let one model's answer be
 * returned for the other's question. Older caches (one model, keys without a
 * model prefix) are MIGRATED here by prefixing each entry's own recorded `model`
 * — the draws keep their provenance and are simply not among the configured
 * models, so the consensus below ignores them. */
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : { slug, method: table.placed.join('; '), samples, leaves: {} };
if (!cache.leaves) cache.leaves = {};
{
  const migrated = {};
  for (const [k, v] of Object.entries(cache.leaves)) {
    migrated[k.includes('#') && k.split('#').length >= 4 ? k : `${(v && v.model) || 'unknown'}#${k}`] = v;
  }
  cache.leaves = migrated;
}
cache.models = MODELS.slice();
cache.method = table.placed.join('; ');
const writeCache = () => {
  const tmp = `${cachePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 1));
  renameSync(tmp, cachePath);
};

/* THE KEY NAMES THE MODEL, THE PROMPT AND THE SAMPLE: a cached draw is only
 * usable under the same model and the same wording of the question (see
 * PROMPT_ID), so a change to either re-asks rather than mixes. */
const jobKey = (j, k) => `${j.model}#${j.leaf.file}#${j.lines[0]}-${j.lines[j.lines.length - 1]}#${PROMPT_ID}#${k}`;
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const jobs = [];
for (const g of byLeaf.values()) {
  const lines = [...g.lines].sort((a, b) => a - b);
  for (const c of chunk(lines, CHUNK)) for (const model of MODELS) for (let k = 1; k <= samples; k++) jobs.push({ leaf: g.leaf, lines: c, model, k });
}
const isDone = (j) => {
  const c = cache.leaves[jobKey(j, j.k)];
  return !!c && (!c.error || c.tries >= 2);
};

async function runJobs(list) {
  const todo = list.filter((j) => !isDone(j));
  if (!todo.length) return { asked: 0, failed: 0 };
  let done = 0;
  let failed = 0;
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const j = todo[next++];
      const rec = await ask(j.leaf.file, j.lines, j.model);
      done++;
      if (rec.error) {
        failed++;
        const prev = cache.leaves[jobKey(j, j.k)] || {};
        cache.leaves[jobKey(j, j.k)] = { leaf: j.leaf.file, lines: j.lines, model: j.model, sample: j.k, error: rec.error, tries: (prev.tries || 0) + 1 };
        console.log(`[${done}/${todo.length}] ${jobKey(j, j.k)} FAILED: ${rec.error}`);
      } else {
        cache.leaves[jobKey(j, j.k)] = { ...rec, leaf: j.leaf.file, lines: j.lines, model: j.model, sample: j.k };
        console.log(`[${done}/${todo.length}] ${jobKey(j, j.k)} ${j.lines.length} line(s) answered`);
      }
      writeCache();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  writeCache();
  return { asked: done, failed };
}

const r = await runJobs(jobs);
console.log(`${slug}: read — ${r.asked} job(s) asked over ${byLeaf.size} leaf/leaves × ${samples} draw(s), ${r.failed} failed`);

/* ---------- ROUND 2: the lines round 1 did not read ----------
 * The leaf a line is placed on is the NEAREST of the item's placed leaf lines, so
 * a line that falls at a leaf's edge can carry its question to the leaf beside it.
 * MEASURED (tools/vision-unsure.mjs, same map): the model answers "" — "not on
 * this page" — for a label it cannot find, so a miss is a placement, not a
 * refusal, and the neighbour is asked before the question is written off. */
const neighbour = (n) => {
  const cands = [n - 1, n + 1].map((x) => heldLeaf(x)).filter(Boolean);
  return cands;
};
{
  const misses = new Map();
  const readLines = new Set();
  for (const rec of Object.values(cache.leaves)) {
    if (!MODELS.includes(rec.model)) continue;
    for (const [line, text] of Object.entries(rec.reading || {})) if (text && text !== '?') readLines.add(Number(line));
  }
  for (const r of selected) {
    if (readLines.has(r.line)) continue;
    for (const nb of neighbour(r.leaf.leaf)) {
      if (!misses.has(nb.file)) misses.set(nb.file, { leaf: nb, lines: new Set() });
      misses.get(nb.file).lines.add(r.line);
    }
  }
  const jobs2 = [];
  for (const g of misses.values()) {
    const lines = [...g.lines].sort((a, b) => a - b);
    for (const c of chunk(lines, 5)) for (const model of MODELS) for (let k = 1; k <= samples; k++) jobs2.push({ leaf: g.leaf, lines: c, model, k });
  }
  const r2 = await runJobs(jobs2);
  console.log(`${slug}: round 2 — ${r2.asked} job(s) asked over ${misses.size} neighbour leaf/leaves, ${r2.failed} failed`);
  for (const [f, g] of misses) if (!byLeaf.has(f)) byLeaf.set(f, { leaf: g.leaf, lines: g.lines, runs: [] });
}

/* ---------- 5. THE READING: what the draws AGREE on ---------- */

/** Every draw's reading of one line, collapsed for comparison, WITH the model
 * that made it. Only the configured models count: the consensus below is over
 * draws a reader can name, and dropping a retired model's draws is the whole
 * meaning of "the old model is dropped for this work" (its readings stay in the
 * cache with their provenance, they are simply not evidence). */
const readingsOf = new Map(); // line -> [{model, sample, text}]
for (const rec of Object.values(cache.leaves)) {
  if (!MODELS.includes(rec.model)) continue;
  for (const [line, text] of Object.entries(rec.reading || {})) {
    const l = Number(line);
    if (!readingsOf.has(l)) readingsOf.set(l, []);
    readingsOf.get(l).push({ model: rec.model, sample: rec.sample, text: collapse(text) });
  }
}
/** THE FOOTNOTE MARKER IS NOT THE READING. Taylor's notes are keyed `1`, `2`,
 * `*`, `†` in the margin, and the transcription carries that key. The model
 * renders the same key four different ways across draws (`1`, `1.`, `¹`, `*`),
 * which was MEASURED to make three draws of one line look like three different
 * readings: line 6362's agreement is on the Greek, and the marker beside it is
 * noise about the page's furniture, not about the print's words. So the DRAW
 * COMPARISON drops a leading marker, and the emission below puts the
 * TRANSCRIPTION's own marker back before the reading is diffed against it. */
const stripMarker = (s) => s.replace(/^\s*(?:[*•†‡§¶%]\s*|\d{1,2}\s*[.)]?\s*|[¹²³⁴⁵⁶⁷⁸⁹⁰]+\s*)/, '').replace(/\s+/g, ' ').trim();
const markerOf = (s) => (/^\s*(?:[*•†‡§¶%]\s*|\d{1,2}\s*[.)]?\s*|[¹²³⁴⁵⁶⁷⁸⁹⁰]+\s*)/.exec(s) || [''])[0];
/** Put the transcription's own marker in front of the page's reading: the marker
 * belongs to the transcription's furniture, and a diff that ran over it would
 * state the page changes `1` into `¹`. */
const alignMarker = (T, M) => {
  const mt = markerOf(T);
  const mm = markerOf(M);
  return mm === mt ? M : mt + M.slice(mm.length);
};

/** The reading the draws AGREE on: the same characters from more than one draw.
 * MEASURED, the model's reading of this print's small Greek type is not stable,
 * so agreement is the whole test; a line whose draws disagree has no reading. The
 * comparison is on the marker-stripped form; the text returned is one draw's own
 * characters. */
function consensus(line) {
  const list = readingsOf.get(line) || [];
  const counts = new Map();
  for (const r of list) {
    if (!r.text || r.text === '?') continue;
    const key = stripMarker(r.text);
    if (!key) continue;
    const cur = counts.get(key);
    if (cur) { cur.n += 1; cur.models.add(r.model); }
    else counts.set(key, { n: 1, text: r.text, models: new Set([r.model]) });
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  const total = list.filter((r) => r.text && r.text !== '?').length;
  /* TWO DRAWS, AND HALF OF THEM. A line can be asked more than once over (the
   * mapped leaf, then a neighbour), so a bare count of 2 says nothing on its own:
   * MEASURED, 2 of 6 draws agreeing is a line the instrument could not settle,
   * while 2 of 2 is every draw there was. The reading stands when at least two
   * draws agree AND they are at least half of the draws that returned anything.
   * The draws counted here are the CONFIGURED MODELS' draws (readingsOf filtered
   * them), so "two agree" can be one model twice or the two models once each —
   * either way two instruments put the same characters there. */
  if (!best || best.n < 2 || best.n < 0.5 * total) return { text: null, draws: total, distinct: counts.size };
  return { text: best.text, draws: total, agree: best.n, distinct: counts.size, models: [...best.models] };
}

/* ---------- 6. FINDINGS ---------- */

/** The span by which the transcription's served line differs from the page's
 * reading — a prefix/suffix peel then one span for the middle. The two are the
 * same text at the same place, so the span cannot invent characters neither side
 * carries. */
function diffSpan(a, b) {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hi = 0;
  while (hi < a.length - lo && hi < b.length - lo && a[a.length - 1 - hi] === b[b.length - 1 - hi]) hi++;
  const find = a.slice(lo, a.length - hi);
  const replace = b.slice(lo, b.length - hi);
  if (!find && !replace) return [];
  return [{ find, replace }];
}

/** THE LONGEST COMMON RUN of letters and digits between the transcription's line
 * and the page's reading — the anchoring test `tools/vision-unsure.mjs` applies,
 * for the same reason: the model is choosing WHICH printed line each OCR fragment
 * is, and it can choose wrong. A reading of the RIGHT line is the transcription's
 * own words with one place repaired, so the two share a long run somewhere; a
 * reading of a DIFFERENT printed line shares only small words. MEASURED on this
 * pass: `18127`'s line ("It is here necessary to supply xa» rtjy ownav row e?of.")
 * came back as another note on the page entirely ("appears to me that the word
 * προνοια is wanting in the original …"), sharing 5 letters, and `18129`'s as yet
 * another, sharing 2 — both twice over, since two draws made the same mistake. */
function longestCommonRun(a, b) {
  const A = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const B = b.toLowerCase().replace(/[^a-z0-9]/g, '');
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
  return best;
}

/** THE PRINT'S OWN ENGLISH, which a repair may not take away. A line of Taylor's
 * prose or of his notes carries English words BESIDE the Greek; a reading of the
 * RIGHT line keeps them and repairs the Greek among them. A reading of a DIFFERENT
 * printed line throws them away with the Greek — MEASURED on this pass, source line
 * 6416 ("* For caxv evejyeread, ctet oov evegysia.") came back as another note on
 * the page ("Instead of ὁμοίου μὴ κατὰ δύναμιν, it is necessary to read …"), which
 * drops the line's "For"; and line 18127's ("is here necessary to supply …") came
 * back as yet another, which drops "here necessary supply". Both passed a
 * length-only test. The English words are the transcription's tokens the vocab
 * instrument did NOT flag — a lookalike token is not English however Latin it
 * looks. A line with NO English word is a pure Greek quotation and is exempt. */
const runSpans = new Map();
function spansOf(line) {
  if (!runSpans.has(line)) runSpans.set(line, runsOnLine(line).map((r) => [r.from, r.to]));
  return runSpans.get(line);
}
/** THE ENGLISH OUTSIDE THE GREEK RUNS. A token is a printed English word only if
 * it stands OUTSIDE every run the instrument flagged: inside a run it is a
 * lookalike fragment, and the fact that it happens to spell an English word says
 * nothing about the print. */
function englishWords(line) {
  const T = servedLine(line);
  const spans = spansOf(line);
  const inside = (a, b) => spans.some(([f, t]) => a < t && b > f);
  const out = [];
  for (const m of T.matchAll(/[A-Za-z][A-Za-z'\-]*[A-Za-z]|[A-Za-z]{2}/g)) {
    const w = m[0];
    if (w.length < 3) continue;
    if (!/^[A-Za-z][A-Za-z'\-]*$/.test(w)) continue;
    if (inside(m.index, m.index + w.length)) continue;
    const low = w.toLowerCase();
    if (!isEnglishWord(low)) continue;
    out.push(low);
  }
  return out;
}
/** Does the page's reading keep the transcription's English? */
function keepsEnglish(line, T, M) {
  const en = englishWords(line);
  if (!en.length) return { ok: true, en: 0, kept: 0 };
  const low = M.toLowerCase();
  const kept = en.filter((w) => low.includes(w)).length;
  return { ok: kept / en.length >= 0.6, en: en.length, kept };
}

/* THE SERVED TEXT, for the merge's own guard, run here so a `find` that cannot
 * fire is named by this tool rather than dropped downstream. */
const src = readEdition(slug);
const doc = extract(src, { entry, sha256: sha256(src) });
const served = (doc.blocks || []).filter((b) => typeof b.x === 'string').map((b) => b.x).join('\n');

const findings = [];
const open = [];
const agreedNoRule = [];
const stats = { lines: 0, agree: 0, noAgree: 0, noReading: 0, same: 0, notGreek: 0, unanchored: 0, guards: 0, notInServed: 0 };

for (const r of selected) {
  const line = r.line;
  stats.lines++;
  const con = consensus(line);
  if (!con.text) {
    if (readingsOf.has(line) && (readingsOf.get(line) || []).some((x) => x.text && x.text !== '?')) {
      stats.noAgree++;
      open.push({ line, leaf: r.leaf.file, page: r.leaf.page, run: r.text, why: `the ${con.draws} draw(s) of this leaf disagree (${con.distinct} distinct reading(s)) — no two agree, so the page has not been read` });
    } else {
      stats.noReading++;
      open.push({ line, leaf: r.leaf.file, page: r.leaf.page, run: r.text, why: 'no draw returned a reading for this line ("?" or absent), so the print is not read here' });
    }
    continue;
  }
  stats.agree++;
  const T = servedLine(line);
  const M = tidyPunctuation(alignMarker(T, con.text));
  if (M === T || stripMarker(M) === stripMarker(T)) { stats.same++; agreedNoRule.push({ line, leaf: r.leaf.file, run: r.text, why: 'the page reads the line as the transcription has it — nothing to repair' }); continue; }
  if (!GREEK.test(M)) { stats.notGreek++; open.push({ line, leaf: r.leaf.file, page: r.leaf.page, run: r.text, reading: M, why: 'the agreed reading carries no Greek script — the run is English or the print\'s Latin, not this pass\'s finding' }); continue; }
  /* ANCHORING, before anything is stated: the reading must be THIS line with its
   * Greek repaired, not another line of the page. Two tests, because a pure Greek
   * quotation has no English to keep and no character to share with the lookalike
   * the transcription left: the English must survive, and either a long run of the
   * line is shared or the line carries almost no English at all. */
  const shared = longestCommonRun(T, M);
  const eng = keepsEnglish(line, T, M);
  if (!eng.ok || (shared < 8 && eng.en > 3)) {
    stats.unanchored = (stats.unanchored || 0) + 1;
    open.push({
      line, leaf: r.leaf.file, page: r.leaf.page, run: r.text, reading: M,
      why: !eng.ok
        ? `the agreed reading does not keep the transcription's English (${eng.kept} of its ${eng.en} English word(s) survive) — the model read a DIFFERENT printed line, not this one`
        : `the agreed reading shares only ${shared} character(s) with the transcription's line, which carries ${eng.en} English words — the model read a DIFFERENT printed line, not this one`,
    });
    continue;
  }
  const spans = [];
  for (const raw of diffSpan(T, M)) {
    let { find, replace } = raw;
    while (find.length && replace.length && find[0] === replace[0] && find[0] === ' ') { find = find.slice(1); replace = replace.slice(1); }
    while (find.length && replace.length && find[find.length - 1] === replace[replace.length - 1] && find[find.length - 1] === ' ') { find = find.slice(0, -1); replace = replace.slice(0, -1); }
    if (!find || find === replace) continue;
    if (find.replace(/\s+/g, '') === replace.replace(/\s+/g, '')) continue;
    if (!lettersOf(find).length || lettersOf(find).length < 3) continue;
    if (replace.includes('?')) continue;
    if (!GREEK.test(replace)) continue;
    spans.push({ find, replace });
  }
  if (!spans.length) { stats.guards++; open.push({ line, leaf: r.leaf.file, page: r.leaf.page, run: r.text, reading: M, why: 'the agreed reading differs from the transcription, but not as a repair this pass can state (no Greek on the changed span, or the difference is spacing alone)' }); continue; }
  const inServed = spans.filter((s) => served.includes(s.find));
  if (inServed.length !== spans.length) stats.notInServed += spans.length - inServed.length;
  for (const s of inServed) {
    findings.push({
      line,
      leaf: r.leaf.file,
      leafNum: r.leaf.leaf,
      page: r.leaf.page,
      run: r.text,
      find: s.find,
      replace: s.replace,
      class: 'reading',
      decided_by: 'page',
      witness: `page image, ${r.leaf.page != null ? `printed page ${r.leaf.page} = ` : ''}archive ${r.leaf.file.replace(/\.jpg$/, '')}`,
      evidence: [
        {
          kind: 'scan',
          leaf: r.leaf.leaf,
          page: r.leaf.page,
          file: r.leaf.file,
          url: `/texts/${slug}/scans/${r.leaf.file}`,
          exists: true,
          source: 'archive.org',
        },
      ],
      agree: con.agree,
      draws: con.draws,
      agreeModels: con.models,
      note:
        `the print sets GREEK here, which the scan read as a Latin lookalike: it reads ${JSON.stringify(s.replace)} where the transcription has ${JSON.stringify(s.find)}` +
        ` (page image, ${r.leaf.page != null ? `printed page ${r.leaf.page} = ` : ''}archive ${r.leaf.file.replace(/\.jpg$/, '')}). ` +
        `The transcription and the second transcription are both OCR passes over this print and flatten the Greek the same way, so neither can settle it. ` +
        `The leaf was drawn ${con.draws} time(s) over ${MODELS.length} model(s) (${MODELS.join(', ')}); the ${con.agree} draw(s) that read these characters were ${con.models.join(' and ')}` +
        (MODELS.length > 1 && con.models.length === 1 ? ` — ONE instrument repeated, not two, so this reading rests on that model alone.` : '.'),
    });
  }
}

/* ---------- 7. WHAT EACH MODEL ACTUALLY DID (the echo diagnostic) ---------- */

/** A draw that returns the transcriber's own line CHARACTER FOR CHARACTER is not
 * a reading of the page: no instrument that looks at this print reproduces its
 * OCR garble exactly. MEASURED on this item (2026-10-06): google/gemma-3-27b-it
 * returned the line verbatim in 612 of its 700 draws (87.4%) while
 * Qwen/Qwen3-VL-235B-A22B-Instruct did so in 159 of 764 (20.8%) — so gemma was
 * an ECHO here, not a second reader, and EVERY finding of this pass (23 of 23) was
 * read by Qwen ALONE — one instrument repeated, never two. The count is reported per model
 * (and per model in the artifact) because "two models were configured" is NOT
 * the same claim as "two models read it", and the difference is invisible in the
 * findings alone.
 *
 * AND THE TOTAL IS AN UPPER BOUND, because the target set is not all garble: it
 * is every run the vocab instrument does not know, and some of those runs are
 * English or the print's Latin, where returning the transcription verbatim IS the
 * correct reading. MEASURED on this item, the share restricted to the lines where
 * some model read something OTHER than the transcription — the lines where the
 * page demonstrably differs from the OCR, `differing` below — is the honest
 * anti-confound figure, and it is reported beside the total. This is also why a
 * model above the echo line must be dropped from MODELS rather than merely
 * flagged: a verbatim draw agrees with the transcription, so on the tool's own
 * two-draw-agreement rule it VOTES for the transcription and can outvote a
 * reader. MEASURED on the 2-model pass (gemma + Qwen), on 290 of the 292 lines
 * the consensus called "the page reads as the transcription has it", EVERY
 * agreeing draw was one that had returned the transcription verbatim — the echo
 * instrument decided those lines. (The tool's `stats.same` counts RUNS — 453 of
 * them — which are 292 distinct source LINES; the count above is over the lines.) */
const isVerbatim = (l, text) => stripMarker(collapse(text)) === stripMarker(servedLine(l)) || collapse(text) === collapse(rawLines[l - 1]);
const echo = new Map();
for (const model of MODELS) echo.set(model, { draws: 0, verbatim: 0, firsthand: 0, differing: { draws: 0, verbatim: 0 } });
/* THE LINES THE PAGE DEMONSTRABLY DIFFERS ON: some configured model's draw
 * returned a reading that is not the transcription. */
const differing = new Set();
for (const rec of Object.values(cache.leaves)) {
  if (!MODELS.includes(rec.model)) continue;
  for (const [line, text] of Object.entries(rec.reading || {})) {
    const l = Number(line);
    if (!(l >= 1 && l <= rawLines.length)) continue;
    const t = collapse(text);
    if (!t || t === '?') continue;
    if (!isVerbatim(l, t)) differing.add(l);
  }
}
for (const rec of Object.values(cache.leaves)) {
  if (!MODELS.includes(rec.model)) continue;
  for (const [line, text] of Object.entries(rec.reading || {})) {
    const l = Number(line);
    if (!(l >= 1 && l <= rawLines.length)) continue;
    const e = echo.get(rec.model);
    e.draws++;
    if (isVerbatim(l, text)) e.verbatim++;
    else e.firsthand++;
    if (differing.has(l)) { e.differing.draws++; if (isVerbatim(l, text)) e.differing.verbatim++; }
  }
}
const artifact = {
  slug,
  models: MODELS,
  tool: 'tools/greek-runs.mjs — the GREEK the scan read as Latin lookalikes, read off the PAGE images (the leaves this edition holds), samples agreed',
  method: table.placed.join('; '),
  samples,
  targets: LINES_ONLY ? { file: linesFile, count: LINES_ONLY.size, lines: [...LINES_ONLY].sort((a, b) => a - b) } : null,
  vocab: vocabFile,
  runs: runs.length,
  latinReported: latin.map((r) => ({ line: r.line, text: r.text })),
  placed: placed.length,
  unplaced: unplaced.map((r) => ({ line: r.line, text: r.text, leaf: r.leaf })),
  leavesRead: new Set([...byLeaf.keys()].filter((f) => Object.values(cache.leaves).some((c) => c.leaf === f && c.reading))).size,
  findings,
  open,
  agreedNoRule,
  echo: Object.fromEntries(echo),
  stats,
};
writeFileSync(outFile, `${JSON.stringify(artifact, null, 1)}\n`);

console.log('--- findings ---');
console.log(`  runs placed on held leaves: ${placed.length} over ${byLeaf.size} leaf/leaves`);
console.log(`  a reading two draws agree on: ${stats.agree}; and of those, a GREEK rule: ${findings.length}`);
console.log(`  the page reads as the transcription has it: ${stats.same}`);
console.log(`  STILL OPEN: ${open.length} (no two draws agreed: ${stats.noAgree}; nothing returned: ${stats.noReading}; the agreed reading is not Greek: ${stats.notGreek}; the reading is not anchored to this line: ${stats.unanchored}; not stateable as a repair: ${stats.guards})`);
console.log(`  a find that is not in the served transcription: ${stats.notInServed}`);
console.log(`  runs on leaves this edition does NOT hold (reported, not read): ${unplaced.length}`);
console.log('--- what each model actually did ---');
for (const [m, e] of echo) {
  const d = e.differing;
  console.log(`  ${m}: ${e.draws} draw(s), ${e.verbatim} returned the transcription's own line verbatim (${(100 * e.verbatim / Math.max(1, e.draws)).toFixed(1)}%), ${e.firsthand} read something else`);
  console.log(`      on the ${differing.size} line(s) where some model read something OTHER than the transcription: ${d.draws} draw(s), ${d.verbatim} verbatim (${(100 * d.verbatim / Math.max(1, d.draws)).toFixed(1)}%)`);
}
console.log(`  findings read by ONE model twice: ${findings.filter((f) => (f.agreeModels || []).length === 1).length} of ${findings.length}; by two models: ${findings.filter((f) => (f.agreeModels || []).length > 1).length}`);
if (argv.includes('--verbose')) console.log(findings.map((f) => `     ${JSON.stringify(f.find)} -> ${JSON.stringify(f.replace)}`).join('\n'));
console.log(`  artifact: ${outFile}`);
