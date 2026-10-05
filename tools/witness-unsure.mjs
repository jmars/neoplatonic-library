#!/usr/bin/env node
/**
 * tools/witness-unsure.mjs — settle the full read's remaining OPEN questions
 * against the OTHER SCANS of the same 1816 print, and emit findings the merge
 * can fold in.
 *
 * WHY THIS EXISTS. `tools/fullread.mjs` read the text against the transcription
 * and the second transcription (both OCR passes over this print) and left
 * `unsure[]`; `tools/vision-unsure.mjs` then read THIS EDITION'S OWN stored
 * leaves with the vision model, settled 400 of them, and left the rest open for
 * reasons it named (a reading nothing places on the line it was asked about, a
 * page line two answers came back for, a word the page itself will not read).
 * Those are questions about WHAT THE PRINT SAYS, and another COPY of the print —
 * a different scan, with its own OCR and its own page model — is an independent
 * reading of the same page. This tool reads the open questions against those
 * copies.
 *
 * TWO LEVERS, in this order, and the first that answers is taken:
 *
 *   1. THE OTHER COPY'S OWN TEXT. The item's `_djvu.xml` gives the printed page
 *      as that scan read it, line by line. The transcription's window of lines is
 *      aligned against that page word by word; the alignment says which printed
 *      line each of the transcription's lines corresponds to, and the pair is
 *      then diffed on its own. Where the transcription is damaged and the copy
 *      reads words, the reading is the copy's. Where the page stands in TWO other
 *      copies, only a reading they AGREE on is taken — two independent OCR passes
 *      did not both invent the same words.
 *   2. THE OTHER COPY'S PAGE IMAGE, where its TEXT is also garbled AND our own
 *      leaf was illegible (`--images`). The image is fetched from the item and
 *      read with the vision model; every reading is cached as data.
 *
 * WHAT IT DOES NOT DO. A reading no copy carries stays OPEN with its reason, and
 * a question no instrument can place is reported UNLOCATABLE. Nothing is
 * invented; merge.mjs folds the findings in under the build's own fire contract.
 *
 * USAGE
 *   node tools/witness-unsure.mjs <slug> [--xml-dir DIR] [--from FILE] [--out FILE]
 *        [--limit N] [--samples N] [--report] [--images] [--trace TEXT]
 *
 * NOT in the build's module graph: it reads the archive items' `_djvu.xml`
 * (megabytes, not in the repo) and, with `--images`, calls the vision model by
 * hand, like `tools/vision-unsure.mjs`.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { extract, readEdition, sha256, tidyPunctuation } from './extract.mjs';
import { TEXTS } from './shelf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = process.env.LIBRARY_WITNESS_URL || 'http://10.0.0.1:8321/v1/chat/completions';
const MODEL = process.env.LIBRARY_WITNESS_MODEL || 'deepseek-v4-flash-vision-exp';
const REQUEST_TIMEOUT_MS = 300_000;
/* MEASURED CAP, carried over from tools/vision-unsure.mjs: this model's reasoning
 * runs away nondeterministically and an answer that hits the cap comes back
 * EMPTY (the task there measured 22,577 reasoning tokens on one leaf). */
const MAX_TOKENS = 32000;

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--xml-dir', '--from', '--out', '--limit', '--samples', '--trace', '--concurrency']);
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
  console.error('usage: node tools/witness-unsure.mjs <slug> [--xml-dir DIR] [--from FILE] [--out FILE] [--limit N] [--samples N] [--report] [--images] [--trace TEXT]');
  process.exit(2);
}
const xmlDir = opt('xml-dir', '');
const fromFile = opt('from', join(ROOT, 'tools', 'edits', `${slug}.unsure-findings.json`));
const outFile = opt('out', join(ROOT, 'tools', 'edits', `${slug}.witness-findings.json`));
const questionLimit = num('limit', Infinity);
const samples = num('samples', 0);
const reportOnly = argv.includes('--report');
const withImages = argv.includes('--images');
const trace = argv.includes('--trace') ? opt('trace', '') : null;
/* How many pages of the copies are read at once. The reads are cached, so this is
 * a wall-clock knob only; 4 kept the proxy comfortable in this pass. */
const CONCURRENCY = num('concurrency', 4);
let TRACE = false;

const entry = TEXTS.find((t) => t.slug === slug);
if (!entry) throw new Error(`witness-unsure: no such text on the shelf: ${slug}`);
const EDITION = join(ROOT, 'data', 'editions', slug);
const edition = JSON.parse(readFileSync(join(EDITION, 'edition.json'), 'utf8'));
const curVersion = edition.current_version;
const source = readFileSync(join(EDITION, 'versions', curVersion, 'source.txt'), 'utf8').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');

/* ---------- the transcription's own coordinates ---------- */
/* `raw` is the file's lines, 1-based — the coordinate a division, a locate and
 * every report here uses. `tidy` is the same line after the extractor's own
 * punctuation tidy, which is the text the reader SERVES: a rule's `find` must
 * live there, so every span is taken in `tidy` coordinates. */
const raw = source.split('\n');
const tidy = raw.map((l) => tidyPunctuation(l));
const tokensOf = (s) => {
  const out = [];
  const re = /[^\s]+/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push({ t: m[0], s: m.index, e: m.index + m[0].length, u: m[0].toLowerCase() });
  return out;
};
const lineToks = tidy.map(tokensOf);

let hay = '';
const lineStart = new Int32Array(raw.length + 2);
for (let i = 0; i < raw.length; i++) {
  lineStart[i + 1] = hay.length;
  hay += raw[i].replace(/\s+/g, '');
}
lineStart[raw.length + 1] = hay.length;
const lineOfChar = new Int32Array(hay.length + 1);
{
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    const n = raw[i].replace(/\s+/g, '').length;
    for (let c = 0; c < n; c++) lineOfChar[h++] = i + 1;
  }
}

const divisions = JSON.parse(readFileSync(join(EDITION, 'divisions.json'), 'utf8')).divisions;
const divByN = new Map(divisions.map((d) => [d.n, d]));
const regionN = (r) => {
  const m = /section\s+(\d+)/.exec(r || '');
  return m ? Number(m[1]) : null;
};

/** The line span a located passage covers — the same locator `tools/vision-unsure.mjs`
 * used, and the reason many of these questions are open: the passage is the
 * transcription's OWN characters, so it is found by an exact search over the
 * whitespace-free text, confined to the question's own region (so a short
 * fragment cannot match a coincidental run elsewhere in the book). */
function locate(passage, n) {
  const needle = String(passage || '').replace(/\s+/g, '');
  if (needle.length < 4) return null;
  const lo = Math.max(1, divByN.get(n).line - 60);
  const nextDiv = divByN.get(n + 1);
  const hi = Math.min(raw.length, (nextDiv ? nextDiv.line : raw.length) + 60);
  const a = lineStart[lo];
  const b = lineStart[hi + 1] ?? hay.length;
  const win = hay.slice(a, b);
  let idx = win.indexOf(needle);
  let used = needle.length;
  if (idx < 0) {
    for (let len = Math.min(needle.length - 1, 80); len >= 6; len = Math.floor(len * 0.8)) {
      idx = win.indexOf(needle.slice(0, len));
      if (idx >= 0) {
        used = len;
        break;
      }
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
  if (idx < 0) {
    /* THE LONGEST RUN THE FRAGMENT KEEPS OF ITSELF. A fragment quoted from a
     * damaged passage may be garble at both ends with its middle intact, and the
     * searches above only try prefixes and a 20-character window — MEASURED, three
     * of the questions reported UNLOCATABLE keep a run of 19 to 23 letters and were
     * lost to the slide's step size. A run of twelve letters of a 19th-century
     * sentence is not a coincidence, and it is the run that places the fragment. */
    for (let len = Math.min(needle.length, 40); len >= 12 && idx < 0; len--) {
      for (let st = 0; st + len <= needle.length; st++) {
        const at = win.indexOf(needle.slice(st, st + len));
        if (at >= 0) {
          idx = at;
          used = len;
          break;
        }
      }
    }
  }
  if (idx < 0) return null;
  return { from: lineOfChar[a + idx], to: lineOfChar[a + idx + used - 1] ?? lineOfChar[a + idx] };
}

/* ---------- the served text (what a find must live in) ---------- */
const src = readEdition(slug);
const doc = extract(src, { entry, sha256: sha256(src) });
const served = (doc.blocks || []).filter((b) => typeof b.x === 'string').map((b) => b.x).join('\n');

/** The printed page a LINE stands on, from this edition's own division anchors:
 * the anchors carry a line, a leaf and a printed page each, and between two of
 * them the page moves with the line. Used for the fragments the full read could
 * not anchor to a line at all — a fragment with no leaf has no page either, and
 * without a page there is no page of a copy to read. This is a POSITION, not an
 * identification: the fragment's own characters are what the reading is held to. */
const anchorRows = divisions
  .filter((d) => d.leaf && d.page != null)
  .map((d) => ({ vol: d.leaf.split('-')[0], num: Number(/-n(\d+)/.exec(d.leaf)[1]), line: d.line, page: d.page }))
  .sort((a, b) => a.line - b.line);
function pageOfLine(line) {
  if (!anchorRows.length) return null;
  const vols = [...new Set(anchorRows.map((a) => a.vol))];
  const firstOfLast = anchorRows.filter((a) => a.vol === vols[vols.length - 1])[0].line;
  const vol = line < firstOfLast && vols.length > 1 ? vols[0] : vols[vols.length - 1];
  const arr = anchorRows.filter((a) => a.vol === vol);
  if (!arr.length) return null;
  if (line <= arr[0].line) return { vol, leaf: arr[0].num, page: arr[0].page };
  const last = arr[arr.length - 1];
  if (line >= last.line) return { vol, leaf: last.num, page: last.page };
  for (let i = 1; i < arr.length; i++) {
    if (line <= arr[i].line) {
      const a = arr[i - 1];
      const b = arr[i];
      const t = (line - a.line) / (b.line - a.line);
      return { vol, leaf: Math.round(a.num + t * (b.num - a.num)), page: Math.round(a.page + t * (b.page - a.page)) };
    }
  }
  return null;
}

/* ---------- our own leaf -> printed page ---------- */
const scan = JSON.parse(readFileSync(join(EDITION, 'scan.json'), 'utf8'));
const offsetOf = new Map();
for (const it of scan.items || []) if (Number.isFinite(it.archiveOffset)) offsetOf.set(it.prefix || '', it.archiveOffset);
const divPageOfLeaf = new Map();
for (const d of divisions) if (d.leaf && d.page != null) divPageOfLeaf.set(d.leaf.replace(/\.jpg$/, ''), d.page);
/** The printed page a leaf carries: this edition's own measured offset for the
 * volume, else the page a division anchor carries FOR THAT EXACT LEAF. A leaf
 * with neither gets null rather than a guessed number. */
function pageOfLeaf(leaf) {
  const m = /^(v\d+)-n(\d+)$/.exec(leaf || '');
  if (!m) return null;
  if (offsetOf.has(m[1])) return Number(m[2]) - offsetOf.get(m[1]);
  return divPageOfLeaf.has(leaf) ? divPageOfLeaf.get(leaf) : null;
}

/* ---------- the other copies of the print ---------- */
/* Each copy's own leaf model is MEASURED and recorded in this edition's witness
 * record (`witnesses.json`) beside the sha256 of the text it was imported from:
 * `covers` maps the volume of THIS work it carries to the copy's own offset
 * (archive leaf = printed page + offset) — one offset per volume, because a
 * single item can carry both volumes with a different leaf model for each — and
 * `item` is the archive.org identifier its leaf images come from. A copy whose
 * record carries no model is not guessed at. */
const witRec = JSON.parse(readFileSync(join(EDITION, 'witnesses.json'), 'utf8'));
const copies = (witRec.witnesses || []).filter((w) => w.model);
for (const c of copies) {
  if (!c.model.covers || !Object.values(c.model.covers).every(Number.isFinite)) {
    throw new Error(`witness-unsure: the witness "${c.name}" carries no usable leaf model`);
  }
}

/* ---------- the copies' leaf lines, out of their own _djvu.xml ---------- */
const XML_ENTITIES = [['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&apos;', "'"], ['&amp;', '&']];
const xmlText = (s) => XML_ENTITIES.reduce((t, [from, to]) => t.split(from).join(to), s);
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
function parseDjvu(xml) {
  return [...xml.matchAll(/<OBJECT\b[\s\S]*?<\/OBJECT>/g)].map((m) => {
    const obj = m[0];
    const map = /usemap="[^"]*?(\d{4})\.djvu"/.exec(obj);
    const lines = [];
    for (const lm of obj.matchAll(/<LINE>([\s\S]*?)<\/LINE>/g)) {
      const ws = [...lm[1].matchAll(/<WORD\s+coords="([^"]+)"(?:\s+x-confidence="(\d+)")?\s*>([\s\S]*?)<\/WORD>/g)].map((w) => xmlText(w[3]));
      if (!ws.length) continue;
      lines.push(ws.join(' ').replace(/\s+/g, ' ').trim());
    }
    return { leaf: map ? Number(map[1]) : null, lines };
  });
}
/** copy name -> Map(leaf -> the copy's own printed LINES for that page). The lines
 * are kept, not just the page's text: which printed line a transcription line is,
 * and what that printed line says, is the whole question here. */
function loadLeaves(copy) {
  const p = join(xmlDir, copy.model.xml);
  if (!xmlDir || !existsSync(p)) return null;
  const map = new Map();
  for (const o of parseDjvu(readFileSync(p, 'utf8'))) if (o.leaf != null) map.set(o.leaf, o.lines);
  return map;
}
const leavesOf = new Map();
for (const c of copies) leavesOf.set(c.name, loadLeaves(c));

/** A copy's page: its printed lines, each line's own tokens, and one flat stream
 * whose tokens remember which printed line they came from. */
function pageOf(copy, leaf) {
  const m = leavesOf.get(copy.name);
  if (!m || !m.has(leaf)) return null;
  /* THE DIGITIZER'S OWN LINES ARE NOT THE PRINT. MEASURED: a Google watermark
   * line is a copy's last “line” on many pages, and a junk transcription line
   * aligned against it produced the reading “Digitized by Google”. */
  const texts = m.get(leaf).filter((l) => l.length && !/digitiz|google|v^ooq|^\W*$|https?:/i.test(l));
  if (!texts.length) return null;
  const lines = texts.map(tokensOf);
  const flat = [];
  lines.forEach((tl, wl) => tl.forEach((x) => flat.push({ ...x, wl })));
  return { leaf, texts, lines, flat };
}

/* ---------- the dictionary and the print's own vocabulary ---------- */
/* TWO tests, and they answer different questions. The DICTIONARY (the 370k list
 * `tools/vocab.mjs` fetches) says whether a token is a word at all. The PRINT'S
 * OWN VOCABULARY — every word the copies' own OCR carries, ~5 MB of the same
 * print — is what tells Taylor's archaic spellings, the Latin and the
 * transliterated Greek (all out of vocabulary) from a garble. */
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'neoplatonic-library');
const WORDLIST = join(CACHE, 'words.txt');
const core = (t) =>
  t
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/[’'](s|d|er|t|st|ll|re|ve|m)$/, '')
    .replace(/^[^a-z]+|[^a-z]+$/g, '');
let WORDS = new Set();
try {
  if (existsSync(WORDLIST)) WORDS = new Set(readFileSync(WORDLIST, 'utf8').split(/\s+/).filter(Boolean));
} catch {
  /* an unreadable list is not a reason to fail: the junk test then rests on the
   * print's own vocabulary alone, which is the more conservative signal. */
}
const VOCAB = new Map();
for (const w of witRec.witnesses || []) {
  const p = join(EDITION, 'witnesses', `${w.name}.txt`);
  if (!existsSync(p)) continue;
  for (const t of readFileSync(p, 'utf8').match(/[A-Za-z][A-Za-z'’-]*/g) || []) {
    const c = core(t);
    if (c) VOCAB.set(c, (VOCAB.get(c) || 0) + 1);
  }
}
const inVocab = (t) => {
  const c = core(t);
  return c.length > 1 && (VOCAB.get(c) || 0) >= 2;
};
const isWord = (t) => {
  const c = core(t);
  if (!c) return false;
  if (WORDS.has(c)) return true;
  if (c.length > 3 && WORDS.has(c.replace(/e$/, ''))) return true;
  return false;
};
/** A string NO copy of this print ever produced: 5 MB of this print's own OCR is
 * the widest test there is for "is this a word of the print at all". */
const neverPrinted = (t) => {
  const c = core(t);
  return !c || !VOCAB.has(c);
};
const DAMAGE = new Set('^_~*/£>\\|#™±»«}{&');
const hasDamageChar = (s) => [...s].some((c) => DAMAGE.has(c));
/** A token is DAMAGED when it is no word this print produces: a damage character,
 * a lone non-word character, digits fused into a word, or a string that is in
 * neither the dictionary nor the copies' 5 MB of the same print. */
const isJunk = (t) => {
  const bare = t.replace(/[^A-Za-z0-9]/g, '');
  if (!bare.length) return false;
  if (hasDamageChar(t)) return true;
  if (bare.length === 1 && !/[IaA]/.test(bare)) return true;
  if (/[0-9]/.test(bare) && /[A-Za-z]/.test(bare)) return true;
  return !isWord(t) || neverPrinted(t);
};
/** The other copy reads this span CLEANLY: no damage character, no lone non-word
 * character, and every token a word of the print (dictionary or the copies' own
 * vocabulary). A copy that is itself garbled here corroborates nothing. */
const readsClean = (toks) =>
  toks.length > 0 &&
  toks.every((x) => {
    const bare = x.t.replace(/[^A-Za-z0-9]/g, '');
    if (!bare.length) return true; // punctuation alone
    if (hasDamageChar(x.t)) return false;
    if (bare.length === 1 && !/[IaA]/.test(bare)) return false;
    if (/[0-9]/.test(bare) && /[A-Za-z]/.test(bare)) return false;
    return isWord(x.t) || inVocab(x.t);
  });

/* ---------- the alignment ---------- */
/** The LCS diff of two token streams, as a path of '=' / '-' / '+' steps. The
 * streams are one printed line, or a page, so the quadratic table is cheap; the
 * path is what turns "these words, here" into an exact span. */
function diffPath(a, b) {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i].u === b[j].u ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const path = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i].u === b[j].u) {
      path.push(['=', i, j]);
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) {
      path.push(['+', -1, j]);
      j++;
    } else {
      path.push(['-', i, -1]);
      i++;
    }
  }
  return path;
}

/** The window of OUR lines a question is read against, each token carrying the
 * line it stands on so the alignment can be read as a line-to-line map. */
function ourWindow(from, to) {
  const out = [];
  for (let l = Math.max(1, from); l <= Math.min(raw.length, to); l++) {
    for (const x of lineToks[l - 1]) out.push({ ...x, line: l });
  }
  return out;
}

/** THE LINE MAP: which printed line of the copy each of our lines corresponds to,
 * read off the EQUAL steps of the window alignment. Those steps are in order, so
 * the map is monotone by construction: an OCR line of the copy can only be the
 * same printed line as an OCR line of ours. */
function lineMap(winToks, pc) {
  const votes = new Map();
  for (const [tag, ai, bi] of diffPath(winToks, pc.flat)) {
    if (tag !== '=') continue;
    const l = winToks[ai].line;
    const w = pc.flat[bi].wl;
    if (!votes.has(l)) votes.set(l, new Map());
    const m = votes.get(l);
    m.set(w, (m.get(w) || 0) + 1);
  }
  const out = new Map();
  for (const [l, m] of votes) {
    let best = null;
    for (const [w, n] of m) if (!best || n > best[1]) best = [w, n];
    out.set(l, best[0]);
  }
  return out;
}

/** The non-equal runs of a pair's diff, each widened by ONE equal token on each
 * side where there is one: a run that only inserts (the copy prints a word ours
 * dropped) or only deletes (ours carries junk the copy does not) has no span of
 * its own, and the neighbouring printed words are what make it writable. */
function runsOf(aToks, bToks) {
  const path = diffPath(aToks, bToks);
  const out = [];
  let k = 0;
  while (k < path.length) {
    if (path[k][0] === '=') {
      k++;
      continue;
    }
    const runStart = k;
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    while (k < path.length && path[k][0] !== '=') {
      const [, ai, bi] = path[k];
      if (ai >= 0) {
        a0 = Math.min(a0, ai);
        a1 = Math.max(a1, ai + 1);
      }
      if (bi >= 0) {
        b0 = Math.min(b0, bi);
        b1 = Math.max(b1, bi + 1);
      }
      k++;
    }
    const prev = runStart > 0 && path[runStart - 1][0] === '=' ? path[runStart - 1] : null;
    const next = k < path.length && path[k][0] === '=' ? path[k] : null;
    if (prev) {
      a0 = Math.min(a0, prev[1]);
      b0 = Math.min(b0, prev[2]);
    }
    if (next) {
      a1 = Math.max(a1, next[1] + 1);
      b1 = Math.max(b1, next[2] + 1);
    }
    if (!Number.isFinite(a0) || !Number.isFinite(b0)) continue;
    if (a1 - a0 < 1 || b1 - b0 < 1) continue;
    out.push({ a: aToks.slice(a0, a1), b: bToks.slice(b0, b1), a0, a1, b0, b1 });
  }
  return out;
}

/* ---------- the third instrument: THIS EDITION'S OWN LEAF, already read ---------- */
/* `tools/vision-unsure.mjs` read every leaf it was asked about with the vision
 * model and cached the readings verbatim. REUSED, never re-asked (the brief's own
 * rule): where its reading of the line is ANCHORED to the transcription's line —
 * it shares a run of six letters with it — it is a reading of THIS line, of the
 * PRINT ITSELF, and a copy whose OCR disagrees with it is contradicted by the page
 * rather than merely uncertain. Two anchored readings that disagree leave the
 * question open: nothing in this tree decides between them. */
const pastReadings = new Map();
{
  const p = join(EDITION, 'unsure-vision.json');
  if (existsSync(p)) {
    try {
      for (const rec of Object.values(JSON.parse(readFileSync(p, 'utf8')).leaves || {})) {
        for (const [k, v] of Object.entries(rec.reading || {})) {
          const l = Number(k);
          const cur = pastReadings.get(l);
          if (cur === undefined || (cur === '' && v !== '')) pastReadings.set(l, v);
        }
      }
    } catch {
      /* an unreadable cache is not a reason to fail: it is one instrument less */
    }
  }
}
/** The longest run of letters two readings share — the anchor test, and the
 * "does the page carry this reading" test, in one measure. */
function longestRun(a, b) {
  for (let len = Math.min(a.length, b.length); len > 0; len--) {
    for (let i = 0; i + len <= a.length; i++) if (b.includes(a.slice(i, i + len))) return len;
  }
  return 0;
}
/** Does this edition's own earlier leaf read CARRY the copy's reading? The page's
 * reading counts as evidence about this line only where it is anchored to the
 * transcription's line (it shares a run of six letters with it) — otherwise the
 * model answered about another printed line. */
function pageCarries(line, find, replace) {
  const vis = pastReadings.get(line);
  if (!vis) return null;
  const A = bare(vis);
  if (longestRun(A, bare(find)) < 6) return null;
  return longestRun(bare(replace), A) >= Math.min(bare(replace).length, 12);
}

const WHY = {};
const note = (k) => {
  WHY[k] = (WHY[k] || 0) + 1;
};

/** Every repair a pair of lines yields, each with the guard that decided it. */
function pairCandidates(ourLine, copyLine, copyText) {
  const out = [];
  const aToks = lineToks[ourLine - 1];
  /* THE ANCHOR: what the two lines SHARE, from the pair's own diff. A pair with no
   * shared token is not an alignment at all — MEASURED: five junk transcription
   * lines of one damaged page all “matched” the copy's chapter heading
   * “CHAPTER XX.”, which shares nothing with any of them. */
  const pPath = diffPath(aToks, copyLine);
  const shared = pPath.filter(([tag]) => tag === '=').map(([, ai]) => aToks[ai].t);
  const sharedLetters = shared.join('').replace(/[^A-Za-z]/g, '').length;
  /* THE STRONGEST ANCHOR the pair has: the longest run of CONSECUTIVE tokens it
   * shares with the printed line. Two words that stand next to each other in both
   * are far harder to match by accident than two words that merely both occur — the
   * weak-anchor failure this measures is a line matched to a printed line about
   * something else because one word in it recurs there. */
  let contiguous = 0;
  {
    let run = 0;
    for (const [tag] of pPath) {
      if (tag === '=') {
        run++;
        if (run > contiguous) contiguous = run;
      } else run = 0;
    }
  }
  /* HOW MUCH ANCHOR A LINE NEEDS DEPENDS ON HOW MUCH OF IT IS JUNK. A line that is
   * mostly garble shares only its few surviving words with the page, and two words
   * that happen to recur map it anywhere on the page — MEASURED: a line whose only
   * real word was “are” was matched against a printed line about something else
   * entirely, and two copies (whose line breaks are alike) both made the same
   * wrong match. So a line that is mostly junk must share at least five letters
   * with the printed line it is matched against. */
  const junkFrac = aToks.length ? aToks.filter((x) => isJunk(x.t)).length / aToks.length : 0;
  if (sharedLetters < (junkFrac >= 0.6 ? 5 : 2)) {
    note(junkFrac >= 0.6 ? 'a mostly-garbled line with too little anchor to the printed line' : 'the two lines share no anchored word');
    return out;
  }
  for (const run of runsOf(aToks, copyLine)) {
    const ours = run.a;
    const wit = run.b;
    if (!ours.length || !wit.length) {
      note('run has one side only');
      continue;
    }
    const find = tidy[ourLine - 1].slice(ours[0].s, ours[ours.length - 1].e);
    const replace = copyText.slice(wit[0].s, wit[wit.length - 1].e).replace(/\s+/g, ' ').trim();
    if (!find || !replace) {
      note('nothing to write');
      continue;
    }
    if (find === replace) {
      note('the copy reads the same words');
      continue;
    }
    if (hasDamageChar(replace)) {
      note('the copy carries a damage character');
      continue;
    }
    if (replace.replace(/[^A-Za-z]/g, '').length < 3) {
      note('the reading writes no printed word back');
      continue;
    }
    const findLetters = find.replace(/[^A-Za-z]/g, '').length;
    if (findLetters < 3) {
      note('the span to replace carries almost no letters');
      continue;
    }
    if (replace.replace(/[^A-Za-z]/g, '').length > findLetters * 3 + 12) {
      note('the reading adds far more words than the span carries');
      continue;
    }
    /* SIZE GUARDS, from two measured failure modes. A reading far LONGER than the
     * span it replaces is the alignment running off into the neighbouring printed
     * lines (MEASURED: an 11-character garble came back as a 160-character
     * sentence); a reading far SHORTER is a truncated answer. Neither is a reading
     * OF THIS SPAN. */
    if (replace.length > find.length * 3 + 24) {
      note('the reading is far longer than the span');
      continue;
    }
    /* HALF, not a third: MEASURED, the boundary let “CHAP. Six SS OF. ‘PLATO.
     * pret: 262 z” be “repaired” into the copy's partial “CHAP. XIX.” — a rule that
     * DELETES the heading's own words. A reading that drops more than half the
     * span's letters is dropping print, not recovering it. */
    if (replace.replace(/[^A-Za-z]/g, '').length * 2 < find.replace(/[^A-Za-z]/g, '').length) {
      note('the reading is far shorter than the span');
      continue;
    }
    if (wit.length > ours.length + 3) {
      note('the copy reads many more words than the span');
      continue;
    }
    /* THE COPY'S OWN CHARACTERS MUST BE PRINT, not the scanner's debris: a token
     * carrying anything but letters, digits and the print's punctuation is the
     * copy's damage, and MEASURED it reaches the reading (a find was “replaced” by
     * the copy's `▼eyed by`). */
    if (wit.some((x) => !/^[A-Za-z0-9'’.,;:!?()—§-]+$/.test(x.t))) {
      note('the copy carries a character the print does not set');
      continue;
    }
    if (!readsClean(wit)) {
      note('the copy is garbled here too');
      continue;
    }
    /* A PRINTED LINE SPLIT ACROSS A LINE BREAK IS NOT A LINE THAT ENDS THERE. The
     * copy's OCR line ends in a hyphen exactly when the print went on; if the span
     * runs to the end of the copy's line and the transcription's does not, the copy
     * simply ran out of line, and writing it in would DELETE the words our line
     * carries past that point — MEASURED: "which ‘possesses the iis eauents" was
     * about to be "repaired" into the copy's truncated "which possesses the-". */
    if (run.b1 >= copyLine.length && /[-\u2010]$/.test(copyLine[copyLine.length - 1].t) && !/[-\u2010]$/.test(find)) {
      note('the copy’s line breaks off in a hyphen where the span does not');
      continue;
    }
    const junk = ours.filter((x) => isJunk(x.t));
    if (!junk.length) {
      note('the transcription is not damaged here');
      continue;
    }
    out.push({
      line: ourLine,
      find,
      replace,
      sharedLetters,
      contiguous,
      junkFrac,
      junk: junk.map((x) => x.t).join(' '),
      ours: ours.map((x) => x.t).join(' '),
      wit: wit.map((x) => x.t).join(' '),
    });
  }
  return out;
}

/** All the repairs a copy yields for one question: the alignment first says which
 * printed line each of our questioned lines is, and each pair is then diffed on
 * its own. A questioned line the alignment did not match at all is tried against
 * the printed lines that stand BETWEEN its matched neighbours — a line the OCR
 * lost entirely is the reason those questions exist, and the neighbours are what
 * bound it. */
function copyCandidates(winToks, pc, loc) {
  const map = lineMap(winToks, pc);
  const out = [];
  const claimed = new Map(); // copy printed line -> the our-line that claimed it
  for (let l = loc.from; l <= loc.to; l++) {
    if (!lineToks[l - 1].length) continue;
    let ws = [];
    if (map.has(l)) ws = [map.get(l)];
    else {
      let before = null;
      for (let p = l - 1; p >= loc.from - 12; p--) if (map.has(p)) { before = map.get(p); break; }
      let after = null;
      for (let q = l + 1; q <= loc.to + 12; q++) if (map.has(q)) { after = map.get(q); break; }
      const lo = before != null ? before + 1 : 0;
      const hi = after != null ? after - 1 : pc.lines.length - 1;
      for (let w = lo; w <= hi; w++) ws.push(w);
      if (ws.length > 3) ws = [];
    }
    for (const w of ws) {
      if (w < 0 || w >= pc.lines.length) continue;
      /* ONE PRINTED LINE IS ONE OF OUR LINES. If two of the questioned lines claim
       * the same printed line the mapping between them is ambiguous, and NOTHING is
       * taken from it — which is what stops a page of junk from all being “read”
       * as the chapter heading it happens to sit beside. */
      if (claimed.has(w) && claimed.get(w) !== l) {
        note('two of the questioned lines claim the same printed line');
        continue;
      }
      claimed.set(w, l);
      for (const c of pairCandidates(l, pc.lines[w], pc.texts[w])) {
        out.push({ ...c, copy: pc.copy, leaf: pc.leaf, wl: w, how: map.has(l) ? 'aligned' : 'between' });
      }
    }
  }
  return out;
}

/* ---------- the questions ---------- */
function classOf(w) {
  if (/shares no run/.test(w || '')) return 'unanchored';
  if (/more than one of this leaf/.test(w || '')) return 'duplicate';
  if (/could not be written as a repair/.test(w || '')) return 'guard';
  if (/uncorroborated/.test(w || '')) return 'uncorrLarge';
  if (/came back as (absent|illegible)/.test(w || '')) return 'illegible';
  return 'other';
}
const read = JSON.parse(readFileSync(fromFile, 'utf8'));
const questions = (read.open || []).map((o) => ({ ...o, _class: classOf(o.why) }));
const unlocatable = [];
const stats0 = { notLocated: 0, placed: 0 };
/* THE FRAGMENTS THE FULL READ COULD NOT PLACE AT ALL. They carry no leaf and no
 * page, so nothing could be read for them. The locator is tried again (it now
 * takes the longest run a fragment keeps of itself, not only its prefix and a
 * 20-character window — MEASURED: three of them keep a run of 19 to 23 letters),
 * and a fragment that lands is given the page its own division anchors put its
 * line on. A fragment that still will not land is reported UNLOCATABLE. */
let placedFragments = 0;
for (const u of read.unlocatable || []) {
  const n = regionN(u.region);
  const loc = n != null && divByN.has(n) ? locate(u.passage, n) : null;
  const at = loc ? pageOfLine(loc.from) : null;
  if (!loc || !at) {
    unlocatable.push(u);
    stats0.notLocated++;
    continue;
  }
  stats0.placed++;
  questions.push({
    ...u,
    leaf: `${at.vol}-n${at.leaf}`,
    page: at.page,
    _class: 'unlocatable',
    _placed: 'by the edition’s own division anchors',
    why: 'the full read could not anchor this fragment to a line of the transcription; this pass placed it by the edition’s own division anchors, from its longest surviving run',
  });
}

const findings = [];
const open = [];
const stats = {
  open: questions.length,
  unlocatable: unlocatable.length,
  located: 0,
  notLocated: 0,
  fragmentsPlaced: 0,
  fragmentsUnlocatable: 0,
  noCopy: 0,
  nothingToRead: 0,
  notInServed: 0,
  disagree: 0,
  agree2: 0,
  single: 0,
  byClass: {},
  imagesAsked: 0,
  imagesAnswered: 0,
  imagesResolved: 0,
  imagesUnread: 0,
  contradicted: 0,
  unanchored: 0,
};
const sampleRows = [];
/** Readings only ONE copy of the print carries: held for the page-image lever. */
const pending = [];
const bare = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

for (const q0 of questions.slice(0, questionLimit === Infinity ? questions.length : questionLimit)) {
  TRACE = !!(trace && String(q0.passage).includes(trace));
  if (TRACE) console.log(`\n--- ${q0.region} ${q0.leaf} p${q0.page} :: ${JSON.stringify(q0.passage)}`);
  const n = regionN(q0.region);
  const loc = n != null && divByN.has(n) ? locate(q0.passage, n) : null;
  const bump = (k) => {
    stats.byClass[q0._class] = stats.byClass[q0._class] || { readings: 0, open: 0 };
    stats.byClass[q0._class][k]++;
  };
  if (!loc) {
    unlocatable.push({ region: q0.region, passage: q0.passage, why: 'the passage could not be located in the transcription' });
    stats.notLocated++;
    continue;
  }
  stats.located++;
  const page = q0.page != null ? q0.page : q0.leaf ? pageOfLeaf(q0.leaf) : null;
  const vol = (q0.leaf || '').split('-')[0] || null;
  const usable = copies.filter((c) => vol && Object.prototype.hasOwnProperty.call(c.model.covers, vol));
  const keepOpen = (why) => {
    open.push({ ...q0, why });
    bump('open');
  };
  if (!usable.length || page == null) {
    stats.noCopy++;
    keepOpen(`${q0.why}; no other copy of this print carries ${vol || 'this volume'}`);
    continue;
  }

  const ctx = 12;
  const winToks = ourWindow(loc.from - ctx, loc.to + ctx);
  const perCopy = [];
  for (const c of usable) {
    const want = page + c.model.covers[vol];
    let leaf = want;
    let pg = pageOf(c, leaf);
    if (!pg) {
      /* a copy's leaf numbering need not run exactly where its recorded offset
       * says: a page the copy does not hold is tried at its neighbours, and the
       * leaf actually read is what the finding records. */
      for (const d of [-1, 1, -2, 2]) {
        pg = pageOf(c, want + d);
        if (pg) {
          leaf = want + d;
          break;
        }
      }
    }
    if (pg) perCopy.push({ copy: c, leaf, ...pg });
  }
  if (!perCopy.length) {
    stats.noCopy++;
    keepOpen(`${q0.why}; the other copies carry no leaf for printed page ${page}`);
    continue;
  }

  const cands = [];
  for (const pc of perCopy) {
    const got = copyCandidates(winToks, pc, loc);
    if (TRACE) for (const g of got) console.log(`    [${g.copy.name} w${g.wl} ${g.how}] ${JSON.stringify(g.find)} -> ${JSON.stringify(g.replace)}`);
    cands.push(...got);
  }
  if (samples && sampleRows.length < samples) {
    for (const c of cands) sampleRows.push({ cls: q0._class, leaf: q0.leaf, page, region: q0.region, item: c.copy.name, find: c.find, replace: c.replace, junk: c.junk, ours: c.ours, wit: c.wit, how: c.how });
    if (!cands.length) sampleRows.push({ cls: q0._class, leaf: q0.leaf, page, region: q0.region, item: '(none)', find: '(no candidate)', replace: '', junk: '', ours: q0.passage, wit: '', how: '' });
  }
  if (!cands.length) {
    stats.nothingToRead++;
    keepOpen(`${q0.why}; the other copies read no word at this line that the transcription lacks`);
    continue;
  }

  /* ONE READING PER LINE AND SPAN: candidates are grouped, and a group is taken
   * only when the copies AGREE on the words (or when a single copy carries the
   * page at all, which is recorded as a single-witness reading). */
  const groups = new Map();
  for (const c of cands) {
    const key = `${c.line}\u0000${c.find}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const [, group] of groups) {
    const first = group[0];
    const agree = group.filter((g) => bare(g.replace) === bare(first.replace));
    const corroborated = agree.length >= 2;
    if (!corroborated && group.length > 1) {
      stats.disagree++;
      keepOpen(`${q0.why}; the other copies read different words at this line, so no reading is taken from them`);
      continue;
    }
    if (!served.includes(first.find)) {
      stats.notInServed++;
      keepOpen(`${q0.why}; the other copy's reading does not stand in the served text where the transcription's characters do`);
      continue;
    }
    if (!corroborated) {
      /* ONE COPY'S OWN OCR IS NOT ENOUGH. MEASURED, from this pass's own single-copy
       * readings: the copy read “the firRt division” where the transcription's own
       * “the firat division” is nearer the print — a second scan's word is another
       * reading, not the truth. So a reading only one copy carries is HELD and put
       * to that copy's own PAGE IMAGE, which is a different instrument on the same
       * page (see lever 2); confirmed there, it is a finding, refused there, it
       * stays open. */
      pending.push({
        q: q0,
        line: first.line,
        how: first.how,
        copy: first.copy,
        leaf: first.leaf,
        find: first.find,
        replace: first.replace,
      });
      continue;
    }
    /* WHAT MAKES A TWO-COPY READING WRITABLE. Two independent OCR passes agreeing
     * is necessary and not sufficient: the reading has to be PLACED on the line it
     * is written against, and a line that is mostly garble shares only a word or
     * two with the page — MEASURED, a line whose only real word was "are" was
     * matched to a printed line about something else, and two copies (whose line
     * breaks are alike) made the same wrong match. So a reading stands when the
     * pair's anchor is STRONG (two consecutive tokens, or eight letters, shared
     * with the printed line) or when THIS EDITION'S OWN LEAF, read earlier and
     * anchored to the same line, carries it too. */
    const carried = pageCarries(first.line, first.find, first.replace);
    const strong = first.contiguous >= 2 || first.sharedLetters >= 8;
    if (carried === false) {
      stats.contradicted++;
      keepOpen(`${q0.why}; the other copies and this edition’s own leaf were both read at this line and do not agree`);
      continue;
    }
    if (carried === null && !strong) {
      stats.unanchored++;
      keepOpen(`${q0.why}; the other copies read this line, but the transcription keeps too little of the printed line for the reading to be placed there`);
      continue;
    }
    findings.push({
      region: q0.region,
      find: first.find,
      replace: first.replace,
      kind: '1',
      class: 'reading',
      sites: 1,
      decided_by: 'witness',
      witness: `two other copies of the same print (${agree.map((g) => g.copy.name).join(', ')}), printed page ${page} — ` + `${agree.map((g) => `${g.copy.model.item || g.copy.name} leaf n${g.leaf}`).join(' and ')}`,
      note:
        `the print reads "${first.replace}" where the transcription has "${first.find}" ` +
        `(two independent copies of the same print read it so, at the same line of the same page). The full read left this open: ${q0.why}`,
      _from: { class: q0._class, leaf: q0.leaf, page, line: first.line, how: first.how, sharedLetters: first.sharedLetters, contiguous: first.contiguous, junkFrac: Number(first.junkFrac.toFixed(2)), copies: agree.map((g) => ({ item: g.copy.name, leaf: g.leaf, replace: g.replace })) },
    });
    stats.agree2++;
    bump('readings');
  }
}

/* ---------- lever 2: the other copy's PAGE IMAGE ---------- */
/* Only where the copy's TEXT is garbled and OUR OWN leaf was illegible: the
 * questions the vision pass left because the page it had was unreadable. The
 * image comes from the copy, is read by the same model that read ours, and every
 * reading is cached as data before anything is decided from it. */
const visionCachePath = join(EDITION, 'witness-vision.json');
const vcache = existsSync(visionCachePath) ? JSON.parse(readFileSync(visionCachePath, 'utf8')) : { slug, model: MODEL, method: 'the other copies’ page images, fetched from the archive item', leaves: {} };
if (!vcache.leaves) vcache.leaves = {};
const writeVCache = () => {
  const tmp = `${visionCachePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(vcache, null, 1));
  renameSync(tmp, visionCachePath);
};
/* MEASURED, from tools/vision-unsure.mjs and kept: the answer must be a JSON
 * object keyed by the labels, the labels are inert, and a run-away reasoning pass
 * returns empty content — which is retried, never cached as a reading. */
const PROMPT_HEAD =
  'Answer immediately with the JSON object only. Do not deliberate.\n' +
  'This is one scanned page of an 1816 book. Below are some of the lines printed on THIS page, as OCR read them off it; the OCR is damaged.\n' +
  'The numbers below are only LABELS for the lines they stand beside. They are not page numbers or line numbers of anything, and mean nothing about the book.\n' +
  'For each labelled line, transcribe what the page ACTUALLY PRINTS on that line, character for character:\n' +
  "  - follow the printed word order, and keep the print's own spelling, capitalisation and punctuation;\n" +
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
const IMG_CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'neoplatonic-library', 'witness-leaves');
async function fetchLeaf(item, leaf) {
  const dir = join(IMG_CACHE, item);
  const p = join(dir, `n${leaf}.jpg`);
  if (existsSync(p)) return readFileSync(p);
  const url = `https://archive.org/download/${item}/page/n${leaf}_w1200.jpg`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      /* the JPEG SOI marker, as tools/fetch-scans.mjs checks it */
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw new Error(`not a JPEG (${buf.length} bytes)`);
      const { mkdirSync } = await import('node:fs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, buf);
      return buf;
    } catch (e) {
      if (attempt === 4) throw new Error(`${item} n${leaf}: ${e && e.message ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return null;
}
async function askImage(buf, labelLines) {
  const asked = labelLines.map((l, i) => `${i + 1}: ${raw[l - 1]}`).join('\n');
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    reasoning_effort: 'low',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${PROMPT_HEAD}${asked}\n` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
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
      const text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
      const parsed = parseAnswer(text);
      if (!parsed) {
        if (attempt < 4) continue;
        return { error: 'no parseable answer over 4 attempts' };
      }
      const out = {};
      for (let i = 0; i < labelLines.length; i++) {
        const v = parsed[String(i + 1)];
        if (typeof v === 'string') out[labelLines[i]] = v;
      }
      if (!Object.keys(out).length) {
        if (attempt < 4) continue;
        return { error: 'the answer carried none of the asked line labels' };
      }
      return { reading: out, raw: text, at: new Date().toISOString(), model: MODEL };
    } catch (e) {
      if (attempt === 4) return { error: String(e && e.message ? e.message : e) };
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    } finally {
      clearTimeout(t);
    }
  }
  return { error: 'no answer' };
}
/* THE EMISSION GUARDS for an image reading, each from a MEASURED defect in the
 * first page-image pass (tools/vision-unsure.mjs): the reading must carry a run
 * of letters; it must not be the illegible marker; and it must share a run of 8
 * characters with the transcription's own line, or it is a reading of ANOTHER
 * printed line and nothing places it here. */
function imageFinding(line, reading, q0, pc, page) {
  const r = collapse(reading);
  if (!r || r === '?') return { why: 'the page image came back illegible for this line' };
  if (hasDamageChar(r)) return { why: 'the reading still carries a damage character' };
  if (r.replace(/[^A-Za-z]/g, '').length < 3) return { why: 'the reading writes no printed word back' };
  const ours = lineToks[line - 1];
  const find = tidy[line - 1].slice(ours[0].s, ours[ours.length - 1].e);
  if (bare(r) === bare(find)) return { why: 'the page image reads the same words the transcription has' };
  let run = 0;
  {
    const a = find.replace(/\s+/g, '');
    const b = r.replace(/\s+/g, '');
    for (let len = Math.min(a.length, b.length); len >= 8; len--) {
      let hit = false;
      for (let i = 0; i + len <= a.length && !hit; i++) if (b.includes(a.slice(i, i + len))) hit = true;
      if (hit) {
        run = len;
        break;
      }
    }
  }
  if (run < 8) return { why: 'the reading shares no run of 8 characters with the transcription’s line, so nothing places it on that line' };
  if (r.length > find.length * 3 + 24) return { why: 'the reading is far longer than the line it replaces' };
  return {
    finding: {
      region: q0.region,
      find,
      replace: r,
      kind: '1',
      class: 'reading',
      sites: 1,
      decided_by: 'witness',
      witness: `the page image of a further copy of the same print (${pc.copy.model.item || pc.copy.name} leaf n${pc.leaf}), printed page ${page}`,
      note: `the print reads "${r}" where the transcription has "${find}" (read off the page image of another copy of the same print, printed page ${page} — this copy’s own text is garbled at that line). The full read left this open: ${q0.why}`,
      _from: { class: q0._class, leaf: q0.leaf, page, line, how: 'image', item: pc.copy.model.item || pc.copy.name, leafOfCopy: pc.leaf },
    },
  };
}

/** A small worker pool. MEASURED: one vision read of one page of these scans took
 * ~45 s, and a page asked for several lines at once took minutes — the proxy
 * serves several such requests at once (tools/vision-unsure.mjs ran six abreast
 * against it), and the readings are cached, so the wall clock is bought back
 * without buying anything less. */
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      await fn(items[k]);
    }
  });
  await Promise.all(workers);
}

/** One vision read of one leaf of one copy, cached as data before anything is
 * decided from it — so a guard can be re-tuned without another pass. */
async function readPage(item, leaf, lines) {
  const key = `${item}#n${leaf}#${lines[0]}-${lines[lines.length - 1]}`;
  if (vcache.leaves[key]) return vcache.leaves[key];
  let rec;
  try {
    const buf = await fetchLeaf(item, leaf);
    rec = { item, leaf, lines, ...(await askImage(buf, lines)) };
  } catch (e) {
    rec = { item, leaf, lines, error: String(e && e.message ? e.message : e) };
  }
  vcache.leaves[key] = rec;
  writeVCache();
  return rec;
}

if (withImages) {
  /* ---------- lever 2a: CONFIRM a single copy's reading off that copy's page ---------- */
  /* A reading only one copy's OCR carries is a reading, not yet a finding. The
   * copy's own page image is a second instrument on the same page — a different
   * process reading the same print — so the reading is taken only if the image
   * carries it. MEASURED, on this pass's own singles: the copy that read "the
   * firRt division" over the transcription's "the firat division" is exactly the
   * case this refuses. */
  const byLeaf = new Map();
  for (const p of pending) {
    const k = `${p.copy.model.item}#${p.leaf}`;
    if (!byLeaf.has(k)) byLeaf.set(k, { item: p.copy.model.item, leaf: p.leaf, copy: p.copy, items: [] });
    byLeaf.get(k).items.push(p);
  }
  console.log(`  --images: ${pending.length} reading(s) carried by ONE copy held for that copy's own page image (${byLeaf.size} page(s))`);
  const confirmGroup = async (g) => {
    /* the questioned lines of this page, deduped and ordered */
    const lines = [...new Set(g.items.map((x) => x.line))].sort((a, b) => a - b);
    if (lines.length > 8) {
      for (const p of g.items) {
        open.push({ ...p.q, why: `${p.q.why}; more than eight lines of one page are held for its image in one read` });
        stats.byClass[p.q._class].open++;
      }
      return;
    }
    const rec = await readPage(g.item, g.leaf, lines);
    stats.imagesAsked++;
    if (!rec.reading) {
      stats.imagesUnread++;
      for (const p of g.items) {
        open.push({ ...p.q, why: `${p.q.why}; one copy only reads this line, and that copy's page image could not be read either (${rec.error || 'no reading'})` });
        stats.byClass[p.q._class].open++;
      }
      return;
    }
    stats.imagesAnswered++;
    for (const p of g.items) {
      const r = collapse(rec.reading[p.line] || '');
      const carried = r && r !== '?' ? longestRun(bare(r), bare(p.replace)) : 0;
      if (carried < Math.min(bare(p.replace).length, 12) || bare(p.replace).length < 4) {
        open.push({ ...p.q, why: `${p.q.why}; one copy only reads this line, and that copy's own page image does not carry the reading${r ? '' : ' (the image answered nothing for the line)'}` });
        stats.byClass[p.q._class].open++;
        continue;
      }
      /* ...and the same test as any other reading: this edition's own leaf, where it
       * was read at this line and the reading is anchored to it, must not say
       * something else again. */
      if (pageCarries(p.line, p.find, p.replace) === false) {
        open.push({ ...p.q, why: `${p.q.why}; one copy's text and its page image read this line one way and this edition's own leaf was read another — the readings disagree` });
        stats.byClass[p.q._class].open++;
        stats.contradicted++;
        continue;
      }
      findings.push({
        region: p.q.region,
        find: p.find,
        replace: p.replace,
        kind: '1',
        class: 'reading',
        sites: 1,
        decided_by: 'witness',
        witness:
          `another copy of the same print, its own OCR and its own page image (` +
          `${p.copy.model.item || p.copy.name} leaf n${p.leaf}), printed page ${p.q.page}`,
        note:
          `the print reads "${p.replace}" where the transcription has "${p.find}" (one other copy of the same print ` +
          `reads it so, and that copy's page image carries the same words). The full read left this open: ${p.q.why}`,
        _from: { class: p.q._class, leaf: p.q.leaf, page: p.q.page, line: p.line, how: 'image-confirmed', copies: [{ item: p.copy.name, leaf: p.leaf, replace: p.replace }] },
      });
      stats.single++;
      stats.imagesResolved++;
      stats.byClass[p.q._class].readings++;
    }
  };
  await pool([...byLeaf.values()], CONCURRENCY, confirmGroup);

  /* ---------- lever 2b: READ the copy's page where ours was illegible ---------- */
  const targets = open.filter((o) => classOf(o.why) === 'illegible');
  console.log(`  --images: ${targets.length} question(s) still open whose own leaf was illegible`);
  const readTarget = async (q0) => {
    const n = regionN(q0.region);
    const loc = n != null && divByN.has(n) ? locate(q0.passage, n) : null;
    if (!loc) return;
    const page = q0.page != null ? q0.page : q0.leaf ? pageOfLeaf(q0.leaf) : null;
    const vol = (q0.leaf || '').split('-')[0] || null;
    const usable = copies.filter((c) => vol && Object.prototype.hasOwnProperty.call(c.model.covers, vol));
    if (!usable.length || page == null) return;
    const lines = [];
    for (let l = loc.from; l <= loc.to; l++) if (lineToks[l - 1].length) lines.push(l);
    if (!lines.length || lines.length > 8) return;
    let done = false;
    for (const c of usable) {
      if (done) break;
      const want = page + c.model.covers[vol];
      for (const leaf of [want, want - 1, want + 1]) {
        const rec = await readPage(c.model.item, leaf, lines);
        stats.imagesAsked++;
        if (!rec.reading) continue;
        stats.imagesAnswered++;
        for (const l of lines) {
          const r = rec.reading[l];
          if (typeof r !== 'string') continue;
          const got = imageFinding(l, r, q0, { copy: c, leaf }, page);
          if (!got.finding) continue;
          if (!served.includes(got.finding.find)) continue;
          findings.push(got.finding);
          stats.imagesResolved++;
          stats.byClass[q0._class].readings++;
          done = true;
          break;
        }
      }
    }
    if (!done) {
      const i = open.indexOf(q0);
      if (i >= 0) open[i] = { ...q0, why: `${q0.why}; the page images of the other copies settle no reading here either` };
    }
  };
  await pool(targets, CONCURRENCY, readTarget);
}

/* ---------- report ---------- */
if (samples) {
  for (const r of sampleRows) {
    console.log(`\n[${r.cls}] ${r.leaf} p${r.page} ${r.region}  ${r.item} (${r.how})`);
    console.log(`   ours: ${JSON.stringify(r.ours)}`);
    console.log(`   find: ${JSON.stringify(r.find)}  [junk: ${r.junk}]`);
    console.log(`   copy: ${JSON.stringify(r.wit)}`);
    console.log(`   repl: ${JSON.stringify(r.replace)}`);
  }
  process.exit(0);
}

const textFindings = findings.filter((f) => f._from.how !== 'image').length;
stats.fragmentsPlaced = stats0.placed;
stats.fragmentsUnlocatable = stats0.notLocated;
console.log(`${slug}: ${questions.length - stats0.placed} open question(s), ${(read.unlocatable || []).length} unlocatable fragment(s)`);
console.log(`  fragments: ${stats0.placed} placed by the division anchors, ${stats0.notLocated} left unlocatable`);
console.log(`  copies: ${copies.map((c) => `${c.name} [${Object.entries(c.model.covers).map(([v, o]) => `${v}=page+${o}`).join(' ')}]`).join('; ') || 'NONE with a model'}${xmlDir ? '' : ' (no --xml-dir: the copies own text is unavailable)'}`);
console.log(`  located ${stats.located}, not located ${stats.notLocated}`);
console.log(`  readings ${findings.length} (from the copies' text ${textFindings}, from their page images ${stats.imagesResolved}): agreed by two copies ${stats.agree2}, single copy ${stats.single}`);
console.log(`  still open ${open.length} (no copy for the volume ${stats.noCopy}, the copies read nothing this line lacks ${stats.nothingToRead}, copies disagree ${stats.disagree}, not in the served text ${stats.notInServed}, too little of the printed line kept ${stats.unanchored}, the copies and this edition’s own leaf disagree ${stats.contradicted})`);
console.log(`  held for the copies’ own page images: ${pending.length} reading(s) carried by one copy only`);
console.log(`  by class: ${JSON.stringify(stats.byClass)}`);
if (withImages) console.log(`  page images: asked ${stats.imagesAsked}, answered ${stats.imagesAnswered}, resolved ${stats.imagesResolved}, unreadable ${stats.imagesUnread}`);
if (stats.contradicted) console.log(`  readings held back by an anchored disagreement with this edition's own earlier leaf read: ${stats.contradicted}`);
if (Object.keys(WHY).length) console.log(`  spans the guards refused: ${JSON.stringify(WHY)}`);

if (reportOnly) process.exit(0);
writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      slug,
      method: "the other copies of the same print — their own _djvu.xml printed lines, line-mapped and word-aligned against the transcription's served lines; where a copy's text is garbled and this edition's own leaf was illegible, the copy's page image read with the vision model",
      model: MODEL,
      from: fromFile,
      stats,
      findings,
      open,
      unlocatable,
    },
    null,
    2,
  )}\n`,
);
console.log(`  findings -> ${outFile}`);
