#!/usr/bin/env node
/**
 * tools/divisions.mjs — recover an edition's BOOK/CHAPTER structure from its
 * PAGE IMAGES and its witness, and write it as the data the extraction opens its
 * sections on.
 *
 *     node tools/divisions.mjs <slug> [--xml-dir DIR] [--witness FILE] [--report]
 *
 * WHY THIS EXISTS. Taylor's 1816 *Theology of Plato* divides into SEVEN BOOKS of
 * roman-numbered CHAPTERS, and the chapter numbers RESTART at I in every book.
 * The scan destroyed the numerals: the running heads read `CHAP. au.`,
 * `CHAP REX`; the chapter headings `CHAPTER VE`, `CHAPTER Piglets`; the book
 * heads `BOOK oe`, `BOOK 1h`, `BOOK actrees`. A fuzzy match of those against a
 * numeral pattern is how an earlier attempt attributed a chapter to the WRONG
 * BOOK — and a wrong book is a wrong text, served silently. So the numbers are
 * not read from the transcription at all. They are read off the SCANS by the
 * vision model (`tools/vision-heads.mjs`), and the transcription is asked only
 * WHERE each one stands — a question it can answer, because the page text IS
 * there even where the numerals are not.
 *
 * WHAT IT DOES, in order:
 *
 *   1. LEAF TABLE. For every stored leaf, the archive item's own `_djvu.xml`
 *      gives the leaf's lines. The leaf's first text line is FINGERPRINTED — a
 *      run of its tokens — against the edition's line stream, and the run must
 *      occur exactly ONCE in the whole transcription. That is the alignment: the
 *      leaf's position in `source.txt`, measured, not inferred from order or from
 *      a page number (this edition's folios are as damaged as its heads). A leaf
 *      whose text cannot be placed is reported UNPLACED and its divisions fall
 *      back to the neighbouring leaves; nothing is guessed.
 *
 *   2. THE READING, by leaf. Each leaf's vision reading (`heads.json`) is parsed:
 *      the running head gives the BOOK (`ON THE THEOLOGY. BOOK VI.`) on the verso
 *      and the CHAPTER (`CHAP. VII. OF PLATO.`) on the recto, and a chapter
 *      heading in the body (`CHAPTER VII.`) gives the chapter directly and marks
 *      the page the chapter OPENS on.
 *
 *   3. THE STRUCTURE, reconciled. The chapter numbers must run I…N with none
 *      missing, restart at I in every book, and the book number must not go
 *      backwards. Readings that violate that are REPORTED, never fitted.
 *
 *   4. THE WITNESS, as a cross-check. The same edition was transcribed a second
 *      time; its contents lists give the chapters each book has, which is
 *      independent of every leaf and is exactly what a mis-read book number would
 *      contradict. Agreement is recorded per book; DISAGREEMENT IS FLAGGED.
 *
 *   5. THE ANCHOR. A division stands where its chapter's first words stand: the
 *      opening prose line of the chapter's first page is fingerprinted into the
 *      transcription and the line it lands on IS the division's line. Where that
 *      cannot be measured, the division opens at the first placed line of the
 *      chapter's first page and says so (`how: "leaf-top"`) with a lower
 *      confidence.
 *
 * OUTPUT: `data/editions/<slug>/divisions.json`, and a report on stdout. The file
 * carries, for every division, the transcription line, the book, the chapter, the
 * label, the anchor, the confidence and the VERBATIM evidence (the leaf, the head
 * and the heading the vision model returned for it).
 *
 * NOT in the build's module graph: it reads the item's `_djvu.xml` (megabytes,
 * not in the repo) and is run by hand, like `tools/derive.mjs` and
 * `tools/migrate-readings.mjs`. The BUILD reads only what this tool leaves behind.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { collapseLine } from './reader.mjs';
import { LIBRARY_DIR, editionRecord, versionOf, sha256 } from './extract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- the arguments ---------- */

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith('--'));
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
if (!slug) {
  console.error('usage: node tools/divisions.mjs <slug> [--xml-dir DIR] [--witness FILE] [--report]');
  process.exit(2);
}
const EDITION = join(LIBRARY_DIR, slug);
const headsPath = join(EDITION, 'heads.json');
if (!existsSync(headsPath)) {
  throw new Error(`library: ${slug}: no vision readings at ${headsPath} — run tools/vision-heads.mjs ${slug} first`);
}
const heads = JSON.parse(readFileSync(headsPath, 'utf8'));
const scan = existsSync(join(EDITION, 'scan.json')) ? JSON.parse(readFileSync(join(EDITION, 'scan.json'), 'utf8')) : null;
/** The item's MEASURED leaf->printed-page offset, where scan.json records one
 * (`archive n = printed page + offset`). Vol. I has one and it is verified at both
 * ends of the work, so a division's printed page is arithmetically its leaf minus
 * the offset — a better witness than the model's digit reading, which misreads a
 * folio now and then (MEASURED: v1-n100's folio "27" read as "97"). */
const offsetOf = new Map();
for (const it of (scan && scan.items) || []) if (Number.isFinite(it.archiveOffset)) offsetOf.set(it.prefix || '', it.archiveOffset);
const xmlDir = opt('xml-dir', process.env.LIBRARY_DIVISIONS_XML || '');
const witnessFile = opt('witness', '');
const version = versionOf(slug);
const source = readFileSync(join(EDITION, 'versions', version, 'source.txt'), 'utf8');
const metaJson = JSON.parse(readFileSync(join(EDITION, 'versions', version, 'meta.json'), 'utf8'));

/* ---------- the transcription's two line streams ----------
 *
 * `raw` is the file's own lines, 1-based — the coordinate a division's `line` is
 * reported in, because it is the one a person can check by opening source.txt.
 * `flat` is the same lines with the blank ones dropped and the rest collapsed,
 * which is the stream the extractor opens sections in. A division carries BOTH:
 * the `flat` index is what the extraction matches, and it is derived from `raw`
 * here and re-derived by the extractor from the same file. */

const rawText = source.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
const rawLines = rawText.split('\n');
const flat = [];
const flatOfRaw = new Array(rawLines.length).fill(-1);
const rawOfFlat = []; // the 1-based line of the file each flat line came from
for (let i = 0; i < rawLines.length; i++) {
  const c = collapseLine(rawLines[i]);
  if (c !== '') {
    flatOfRaw[i] = flat.length;
    rawOfFlat.push(i + 1);
    flat.push(c);
  }
}
const tokens = [];
const tokenLine = []; // flat index of each token
{
  const re = /[^\s]+/g;
  flat.forEach((l, fi) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(l)) !== null) {
      tokens.push(m[0]);
      tokenLine.push(fi);
    }
  });
}
const tokenIndex = new Map();
tokens.forEach((w, i) => {
  if (!tokenIndex.has(w)) tokenIndex.set(w, []);
  tokenIndex.get(w).push(i);
});

/* ---------- the item's djvu.xml ---------- */

/** The xml's own line for a stored leaf's text: the words of a line joined with
 * one space and collapsed, exactly as `derive.mjs` reads it. */
const XML_ENTITIES = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
  ['&amp;', '&'],
];
const xmlText = (s) => XML_ENTITIES.reduce((t, [from, to]) => t.split(from).join(to), s);

function parseDjvu(xml) {
  const objects = [...xml.matchAll(/<OBJECT\b[\s\S]*?<\/OBJECT>/g)].map((m) => m[0]);
  return objects.map((raw) => {
    const map = /usemap="[^"]*?(\d{4})\.djvu"/.exec(raw);
    const lines = [];
    for (const lm of raw.matchAll(/<LINE>([\s\S]*?)<\/LINE>/g)) {
      const ws = [...lm[1].matchAll(/<WORD\s+coords="([^"]+)"(?:\s+x-confidence="(\d+)")?\s*>([\s\S]*?)<\/WORD>/g)].map((m) =>
        xmlText(m[3]),
      );
      if (!ws.length) continue;
      lines.push({ text: ws.join(' ').replace(/\s+/g, ' ').trim() });
    }
    return { leaf: map ? Number(map[1]) : null, lines };
  });
}

/** Find the xml file for an item: `<dir>/<archive_id>_djvu.xml`, or a file whose
 * name carries the volume prefix, or any `_djvu.xml` when the dir holds one. */
function xmlFor(item, prefix) {
  if (!xmlDir || !existsSync(xmlDir)) return null;
  const names = readdirSync(xmlDir).filter((n) => n.endsWith('_djvu.xml') || n.endsWith('.xml'));
  const byItem = names.find((n) => item && n.includes(item));
  const byPrefix = names.find((n) => new RegExp(`(^|[^a-z])${prefix}([^a-z]|$)`).test(n));
  if (byItem) return join(xmlDir, byItem);
  if (byPrefix) return join(xmlDir, byPrefix);
  if (names.length === 1) return join(xmlDir, names[0]);
  return null;
}

/* ---------- 1. the leaf table ---------- */

/** A run of a leaf's tokens, searched in the transcription's token stream. Only
 * runs that occur EXACTLY ONCE are used: a run that occurs twice places nothing,
 * and a run that occurs nowhere is a line the two transcriptions do not share. */
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

const words = (text) => text.replace(/\s+/g, ' ').trim().split(' ').filter((w) => /[A-Za-z0-9]/.test(w));
const capWords = (t) => t.filter((w) => /[A-Za-z]{3}/.test(w)).length;

/** Is this xml line page furniture (a running head, a folio, a chapter label)
 * rather than the chapter's own prose? Used only to pick the line a division
 * opens on — never to decide a number. */
const furnished = (t) =>
  /^(?:CHAP|CHAPTER|BOOK|VOL|PROP)\b/i.test(t) ||
  /\b(?:PLATO|THEOLOGY)\b/i.test(t) && words(t).length <= 6 ||
  /^[^A-Za-z0-9]*\d{1,4}[^A-Za-z0-9]*$/.test(t) ||
  !/[A-Za-z]{3}/.test(t);

/** Place one leaf: find a run of its own tokens that occurs once in the whole
 * transcription. The search walks the leaf's lines in order and prefers a LINE
 * that carries prose (a head line is short and its spacing varies between the two
 * OCR passes, so it matches worst exactly where it matters most). Returns
 * `{line, token, how}` — the line the matched run starts on, or null. */
function placeLeaf(lf) {
  const lines = lf.lines.map((l) => ({ text: l.text, toks: words(l.text) }));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < lines.length; i++) {
      const { text, toks } = lines[i];
      if (pass === 0 && furnished(text)) continue; // pass 0: prose lines only
      if (pass === 1 && i > 6) break; // pass 1: the first lines, head and all
      if (capWords(toks) < 2 || toks.length < 4) continue;
      for (let n = 5; n <= Math.min(18, toks.length); n++) {
        const hits = findKey(toks.slice(0, n));
        if (hits.length === 1) return { flat: tokenLine[hits[0]], token: hits[0], how: 'prose' };
        if (hits.length === 0) break;
      }
    }
  }
  return null;
}

const leaves = []; // {leaf, prefix, xml, rec, place}
const unplaced = [];
for (const item of (scan && scan.items) || []) {
  const prefix = item.prefix || '';
  const file = xmlFor(item.archive_id, prefix);
  if (!file) {
    unplaced.push(`${prefix}: NO XML (--xml-dir ${JSON.stringify(xmlDir)})`);
    continue;
  }
  const objects = parseDjvu(readFileSync(file, 'utf8'));
  const [lo, hi] = item.leaves || [0, objects.length - 1];
  for (const lf of objects) {
    if (lf.leaf < lo || lf.leaf > hi) continue;
    const name = `${prefix ? `${prefix}-` : ''}n${lf.leaf}.jpg`;
    const rec = heads.leaves[name] || null;
    const place = lf.lines.length ? placeLeaf(lf) : null;
    if (lf.lines.length && !place) unplaced.push(name);
    leaves.push({ leaf: lf.leaf, name, prefix, lines: lf.lines, rec, place });
  }
}
leaves.sort((a, b) => (a.prefix === b.prefix ? a.leaf - b.leaf : a.prefix < b.prefix ? -1 : 1));
/* A GLOBAL ORDINAL. The two items' leaf numbers RUN OVER EACH OTHER (v1-n74 and
 * v2-n74 are different leaves, and v2-n50 sorts before v1-n100), so every
 * comparison in what follows is on the position in the assembled book — never on
 * the item's own leaf number. */
leaves.forEach((l, i) => {
  l.ord = i;
});

const mapOf = new Map(); // name -> place
for (const l of leaves) mapOf.set(l.name, l.place);
const placed = leaves.filter((l) => l.place).length;
console.log(
  `${slug}: ${leaves.length} leaf/leaves over ${(scan && scan.items ? scan.items.length : 0)} item(s); ` +
    `${placed} PLACED in the transcription, ${leaves.length - placed} unplaced` +
    (unplaced.length ? `\n  unplaced: ${unplaced.slice(0, 20).join(', ')}${unplaced.length > 20 ? ` … (+${unplaced.length - 20})` : ''}` : ''),
);

/* ---------- 2. the reading, by leaf ---------- */

const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
const ROMAN_FIX = { i: 'I', l: 'I', '1': 'I', v: 'V', u: 'V', y: 'V', x: 'X' };
/** Read a token as a roman numeral, through the OCR's own confusions; null when
 * the token is not a numeral at all (the case this whole tool exists for). */
function roman(tok) {
  if (!tok) return null;
  let t = tok.replace(/[^IVXLCDMivxlcdm1luyY]/g, '');
  if (t === '') return null;
  t = t
    .split('')
    .map((c) => ROMAN_FIX[c] || c.toUpperCase())
    .join('');
  // the longest numeral this work uses is XXXVIII (7 characters); a bound of 5
  // silently dropped XXVIII, XXXIII, XXXVII and XXXVIII, which is exactly the
  // set of chapters the report then called MISSING (MEASURED)
  if (!/^[IVXLCDM]+$/.test(t) || t.length > 8) return null;
  let n = 0;
  let prev = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    const v = ROMAN[t[i]];
    if (!v) return null;
    n += v < prev ? -v : v;
    prev = Math.max(prev, v);
  }
  return n > 0 && n <= 99 ? n : null;
}

/** A book number as the witness writes it. The witness's contents headers OCR
 * `VI` as `VL` (MEASURED: "CONTENTS OF THE CHAPTERS OF BOOK VL"), and the roman
 * reader takes VL for 45 — so a value outside the seven books is re-read with
 * `L` as `I`, which is the confusion the scan actually makes, and only there. */
function romanBook(tok) {
  const v = roman(tok);
  if (v != null && v >= 1 && v <= 7) return v;
  const alt = roman(String(tok).replace(/L/g, 'I'));
  return alt != null && alt >= 1 && alt <= 7 ? alt : null;
}

const CHAP_HEAD = /\bCHAPS?\b[.,:]?\s*([^\s]+)/i;
const BOOK_HEAD = /\bBOOK\b[.,:]?\s*([^\s]+)/i;
const CHAPTER_HEAD = /\bCHAPTER\b[.,:]?\s*([^\s]+)/i;

const readings = leaves.map((l) => {
  const head = (l.rec && l.rec.head) || '';
  const heading = (l.rec && l.rec.heading) || '';
  const cb = BOOK_HEAD.exec(head);
  const cc = CHAP_HEAD.exec(head);
  const ch = CHAPTER_HEAD.exec(heading) || CHAPTER_HEAD.exec(head);
  return {
    leaf: l.leaf,
    ord: l.ord,
    name: l.name,
    prefix: l.prefix,
    place: l.place,
    head,
    heading,
    page: l.rec ? l.rec.page || null : null,
    bookTok: cb ? cb[1] : null,
    book: cb ? roman(cb[1]) : null,
    headTok: cc ? cc[1] : null,
    headChapter: cc ? roman(cc[1]) : null,
    labelTok: ch ? ch[1] : null,
    labelChapter: ch ? roman(ch[1]) : null,
    headingPresent: !!CHAPTER_HEAD.exec(heading),
    raw: l.rec ? l.rec.raw || '' : '',
  };
});

/* ---------- 3. the structure, reconciled ---------- */

/* THE BOOKS, from the print's own book headings first. The work prints `BOOK II.`
 * as a heading in the body whenever a book opens (the vision model returns it in
 * `heading`), and the running heads then carry `ON THE THEOLOGY. BOOK n.` for the
 * rest of that book. The heading is the exact page; the running heads are the
 * corroboration, and they are what is used where a heading was not read. A book
 * whose readings overlap another's range is REPORTED — a head read as the wrong
 * book must not be allowed to move every division after it. */
const notes = [];
const bookHeadingAt = new Map(); // book -> {leaf, r}
const bookHeadRange = new Map(); // book -> {lo, hi, reads}
for (const r of readings) {
  const mh = BOOK_HEAD.exec(r.heading);
  const vh = mh ? roman(mh[1]) : null;
  if (vh != null) {
    const prev = bookHeadingAt.get(vh);
    if (!prev || r.ord < prev.ord) bookHeadingAt.set(vh, { ord: r.ord, leaf: r.leaf, r });
  }
  const mc = BOOK_HEAD.exec(r.head);
  const vc = mc ? roman(mc[1]) : null;
  if (vc != null) {
    const g = bookHeadRange.get(vc) || { lo: Infinity, hi: -Infinity, reads: [] };
    g.lo = Math.min(g.lo, r.ord);
    g.hi = Math.max(g.hi, r.ord);
    g.reads.push(r);
    bookHeadRange.set(vc, g);
  }
}
if (!bookHeadingAt.size && !bookHeadRange.size) {
  throw new Error(`${slug}: no reading carries a book number — there is no structure to recover`);
}
const bookNums = [...new Set([...bookHeadingAt.keys(), ...bookHeadRange.keys()])].sort((a, b) => a - b);
const bookLo = new Map();
for (const b of bookNums) {
  const h = bookHeadingAt.get(b);
  const g = bookHeadRange.get(b);
  // the heading is the page the book opens on; the head range's first leaf is the
  // first page whose head carries the new number, which is never EARLIER
  const lo = h ? h.ord : g.lo;
  bookLo.set(b, lo);
  if (h && g && g.lo < h.leaf) {
    notes.push(
      `book ${b}: a running head reads BOOK ${b} on leaf ${g.lo}, before the book's own heading at leaf ${h.leaf} ` +
        `(${JSON.stringify(h.r.heading)}) — the head is a mis-read or the heading is late; the heading stands.`,
    );
  }
}
// the ranges must not interleave: book n's leaves come before book n+1's
const ordered = [...bookLo.keys()].sort((a, b) => bookLo.get(a) - bookLo.get(b));
{
  const bad = ordered.find((b, i) => b !== i + 1);
  if (bad != null) {
    const absent = ordered.map((_, i) => i + 1).filter((b) => !bookHeadingAt.has(b));
    notes.push(
      `the books are not read 1…K in order: the reading gives ${ordered.join(', ')} — a book number is spurious, or ` +
        `an earlier one was never read.` + (absent.length ? ` No heading was read for book ${absent.join(', ')}.` : ''),
    );
  }
}
const spans = ordered.map((b) => ({ book: b, lo: bookLo.get(b), hi: Infinity }));

/* THE RESET IS THE BOUNDARY. A book's chapter numbering RESTARTS at I, and the
 * first page of the new book's chapter I carries the head `CHAP. I.` whether or
 * not the page also carries `ON THE THEOLOGY. BOOK n.` — MEASURED on Book V,
 * whose chapter I is on leaf 384 and whose first `BOOK V` head is on leaf 385.
 * So a span is widened backwards to the first leaf at or before its start that
 * the readings give chapter I, and the widening is REPORTED: a book boundary
 * taken from a chapter reset is one page of inference, and it is listed. */
for (let i = 1; i < spans.length; i++) {
  const lo = spans[i].lo;
  const cand = readings.filter(
    (r) => r.ord < lo && r.ord >= spans[i - 1].lo && r.ord >= lo - 3 && (r.headChapter === 1 || r.labelChapter === 1),
  );
  if (!cand.length) continue;
  const first = cand.reduce((a, b) => (a.ord < b.ord ? a : b));
  spans[i].lo = first.ord;
  notes.push(
    `book ${spans[i].book}: the span opens at leaf ordinal ${first.ord} (${first.name}) rather than ${lo}, because that ` +
      `leaf is the first the readings give CHAPTER I of book ${spans[i].book} — the book's own head appears a page later ` +
      `(${JSON.stringify(first.head)}); the reset is the boundary`,
  );
}

/* THE SPANS TILE, and the tiling is computed AFTER the widening above — a span
 * widened backwards would otherwise still be overlapped by its predecessor's
 * `hi`, and the earlier book would win every leaf at the seam (MEASURED: leaf
 * v1-n384, Book V's chapter I, was claimed by Book IV and its chapter never
 * opened). */
for (let i = 0; i < spans.length; i++) spans[i].hi = i + 1 < spans.length ? spans[i + 1].lo - 1 : Infinity;

/** Which book a leaf belongs to: the span its ORDINAL stands in. */
function bookOf(ord) {
  for (const s of spans) if (ord >= s.lo && ord <= s.hi) return s.book;
  return ord < spans[0].lo ? spans[0].book : spans[spans.length - 1].book;
}

/* THE CHAPTERS, within one book at a time. The print's invariant is the one the
 * reconciliation holds: the chapters run 1…N with none missing and none repeated,
 * and the book's own contents list says what N is. A reading that cannot be
 * reconciled with it is REPORTED with its leaf and its verbatim head — never
 * fitted, because fitting is what a wrong book is made of. */
const starts = new Map(); // `${book}:${chapter}` -> {leaf, how, from}
const headsOf = new Map(); // `${book}:${chapter}` -> first leaf whose head reads it
let chapter = 0;
let curBook = null;
for (const r of readings) {
  const b = bookOf(r.ord);
  if (b !== curBook) {
    curBook = b;
    chapter = 0;
  }
  if (r.headChapter != null) {
    const key = `${b}:${r.headChapter}`;
    const prev = headsOf.get(key);
    if (prev == null || r.ord < prev.ord) headsOf.set(key, r);
    if (r.headChapter > chapter) {
      if (r.headChapter === chapter + 1) {
        chapter = r.headChapter;
        if (!starts.has(key)) starts.set(key, { ord: r.ord, leaf: r.leaf, how: 'head', from: r });
      } else {
        notes.push(
          `leaf ${r.name}: the running head reads CHAP. ${r.headTok} (${r.headChapter}) where chapter ` +
            `${chapter + 1} is due in Book ${b} — ${r.headChapter - chapter - 1} chapter(s) would be missing; the ` +
            `readings between them are reported, not filled in. head ${JSON.stringify(r.head)}`,
        );
      }
    } else if (r.headChapter < chapter) {
      /* A BACKWARD HEAD READING. A head read as an EARLIER chapter of the SAME
       * book is a mis-read numeral (MEASURED: v1-n106 reads `CHAP. I.` where
       * `CHAP. XI.` is due) and it must not be allowed to move the chapter back;
       * reported with the reading so the two can be told apart by hand. */
      notes.push(
        `leaf ${r.name}: the running head reads CHAP. ${r.headTok} (${r.headChapter}) where chapter ${chapter} is ` +
          `open in Book ${b} — a head that goes backwards within a book is a mis-read numeral; it is NOT used to ` +
          `move the chapter. head ${JSON.stringify(r.head)}`,
      );
    }
  }
  if (r.labelChapter != null) {
    const key = `${b}:${r.labelChapter}`;
    if (r.labelChapter === chapter + 1 || r.labelChapter === chapter) {
      chapter = r.labelChapter;
      const prev = starts.get(key);
      // the heading is PRINTED, so it marks the page the chapter opens on — the
      // strongest placement there is, and it wins over a head-derived one
      if (!prev || prev.how !== 'heading' || r.ord < prev.ord) {
        starts.set(key, { ord: r.ord, leaf: r.leaf, how: 'heading', from: r });
      }
    } else if (r.labelChapter > chapter + 1) {
      notes.push(
        `leaf ${r.name}: the chapter heading reads CHAPTER ${r.labelTok} (${r.labelChapter}) where chapter ` +
          `${chapter + 1} is due in Book ${b}; the chapters between are not read and are NOT filled in.`,
      );
      chapter = r.labelChapter;
      starts.set(key, { ord: r.ord, leaf: r.leaf, how: 'heading', from: r });
    } else if (r.labelChapter < chapter) {
      notes.push(
        `leaf ${r.name}: the chapter heading reads CHAPTER ${r.labelTok} (${r.labelChapter}), behind the open ` +
          `chapter ${chapter} of Book ${b}.`,
      );
    }
  }
}

/* A chapter whose heading was never read but whose running head was opens on the
 * page BEFORE the first page whose head carries it (the head changes on the page
 * after the chapter opens). This is stated as its own `how`, because it is one
 * page of inference and the reader of the model must be able to see it. */
for (const [key, first] of [...headsOf]) {
  if (starts.has(key)) continue;
  starts.set(key, { ord: first.ord - 1, leaf: null, how: 'head-before', from: first });
}

/* ---------- 4. the witness, as a cross-check ---------- */

/** The witness's own contents lists: "THE CHAPTERS OF BOOK I." … "CONTENTS OF THE
 * CHAPTERS OF BOOK VII.", each followed by its chapters. The counts are the
 * independent fact: a mis-read BOOK number contradicts them. */
function witnessContents(file) {
  if (!file || !existsSync(file)) return null;
  const L = readFileSync(file, 'utf8').split('\n');
  const hdr = [];
  L.forEach((l, i) => {
    const m = /^\s*(?:THE CHAPTERS OF BOOK|CONTENTS OF THE CHAPTERS OF BOOK)\s+([IVXLCDMvl.]+)/i.exec(l);
    if (m) hdr.push({ i, raw: m[1], book: romanBook(m[1].replace(/\./g, '')) });
  });
  const books = [];
  for (let k = 0; k < hdr.length; k++) {
    const from = hdr[k].i + 1;
    const to = k + 1 < hdr.length ? hdr[k + 1].i : from + 400;
    let n = 0;
    let seq = [];
    for (let i = from; i < Math.min(to, L.length); i++) {
      const m = /^\s*[^\w]{0,4}CHAPTER\s+([^\s.]+)\.?\s*$/.exec(L[i]);
      if (m) {
        n++;
        seq.push(roman(m[1]));
      }
    }
    books.push({ book: hdr[k].book, raw: hdr[k].raw, chapters: n, nums: seq, line: hdr[k].i + 1 });
  }
  return books;
}
const witness = witnessContents(witnessFile);
const wBook = new Map();
if (witness) for (const b of witness) if (b.book != null) wBook.set(b.book, b);

/* ---------- 5. the divisions ---------- */

/** The line a division opens on: the chapter's own opening prose, found by
 * fingerprinting the first prose line of the chapter's first page. Falls back to
 * the placed line of that page (its top), and says which it was. */
function openingLine(start, after = -1) {
  const at = start.ord != null ? start.ord : leaves.findIndex((l) => l.leaf === start.leaf && (!start.from || l.prefix === start.from.prefix));
  if (at < 0) return null;
  // the leaf the chapter opens on, and — when the placement came from a running
  // head on the NEXT page — that one too, so the opening line is not missed
  for (const cand of [leaves[at], leaves[at + 1]]) {
    if (!cand) continue;
    for (const line of cand.lines) {
      const t = line.text;
      if (furnished(t)) continue;
      const toks = words(t);
      if (capWords(toks) < 2 || toks.length < 4) continue;
      for (let n = 5; n <= Math.min(18, toks.length); n++) {
        const hits = findKey(toks.slice(0, n));
        if (hits.length === 1) {
          const fi = tokenLine[hits[0]];
          // TWO CHAPTERS CAN OPEN ON ONE PAGE (MEASURED): a division must stand
          // AFTER the one before it, so a line already claimed is not this
          // division's opening and the search goes on to the next prose line.
          if (fi <= after) break;
          return { flat: fi, how: cand === leaves[at] ? 'opening' : 'opening-next-page', leaf: cand.name };
        }
        if (hits.length === 0) break;
      }
    }
  }
  const p = leaves[at].place;
  if (p && p.flat > after) return { flat: p.flat, how: 'leaf-top', leaf: leaves[at].name };
  // the page could not be placed: take the next placed leaf's line and say so
  for (let k = at + 1; k < leaves.length; k++) {
    if (leaves[k].place) return { flat: leaves[k].place.flat, how: 'next-placed-leaf', leaf: leaves[k].name };
  }
  return null;
}

const booksOut = [];
const divisions = [];
let n = 0;
const byBook = new Map();
for (const [key, start] of [...starts].sort((a, b) => a[1].ord - b[1].ord)) {
  const [b, c] = key.split(':').map(Number);
  byBook.set(b, (byBook.get(b) || 0) + 1);
}
for (const b of [...byBook.keys()].sort((x, y) => x - y)) {
  const w = wBook.get(b);
  const measured = byBook.get(b);
  booksOut.push({
    n: b,
    label: `Book ${romanWord(b)}`,
    chapters: measured,
    ...(w && w.chapters !== measured
      ? { witness: w.chapters, witnessAgreement: 'FLAGGED', witnessNote: `the witness's contents list has ${w.chapters} chapter(s) (line ${w.line})` }
      : w
        ? { witness: w.chapters, witnessAgreement: 'agree' }
        : { witness: null, witnessAgreement: 'no-witness-list' }),
  });
}

let lastFlat = -1;
for (const [key, start] of [...starts].sort((a, b) => a[1].ord - b[1].ord)) {
  const [b, c] = key.split(':').map(Number);
  const op = openingLine(start, lastFlat);
  if (op) lastFlat = op.flat;
  n++;
  const first = start.from;
  /* THE PRINTED PAGE. Where the item records a measured leaf->page offset, the
   * page is the leaf the division opens on minus that offset; otherwise it is the
   * number the model read off the page itself. The model's reading is KEPT either
   * way, so a disagreement is visible in the file rather than merged away. */
  const leafName = op ? op.leaf : first ? first.name : null;
  const leafNum = leafName ? Number(/n(\d+)\.jpg$/.exec(leafName)?.[1]) : null;
  const prefix = leafName ? (/^v\d+-/.exec(leafName) || [''])[0].replace(/-$/, '') : '';
  const hasOffset = offsetOf.has(prefix) && Number.isFinite(leafNum);
  const page = hasOffset ? leafNum - offsetOf.get(prefix) : first && first.page ? Number(first.page) : null;
  const pageRead = first && first.page ? Number(first.page) : null;
  if (hasOffset && pageRead != null && pageRead !== page) {
    notes.push(
      `division ${n + 1} (Book ${b} ch ${c}): the model read the printed page as ${pageRead} on ${leafName}, ` +
        `where the item's measured offset (leaf ${leafNum} - ${offsetOf.get(prefix)}) gives ${page} — the offset ` +
        `stands, the reading is recorded.`,
    );
  }
  divisions.push({
    n,
    book: b,
    chapter: c,
    label: `Book ${romanWord(b)}, Chapter ${romanWord(c)}`,
    anchor: `s${n}`,
    line: op ? rawOfFlat[op.flat] : null,
    flat: op ? op.flat : null,
    text: op ? flat[op.flat] : null,
    page,
    pageRead,
    leaf: leafName,
    how: op ? op.how : 'unplaced',
    confidence: op ? (op.how === 'opening' && start.how === 'heading' ? 'high' : 'medium') : 'none',
    evidence: {
      leaf: first ? first.name : null,
      head: first ? first.head : '',
      heading: first ? first.heading : '',
      raw: first ? first.raw : '',
    },
  });
}

/* ---------- the report ---------- */

const conf = {};
for (const d of divisions) conf[d.confidence] = (conf[d.confidence] || 0) + 1;
const how = {};
for (const d of divisions) how[d.how] = (how[d.how] || 0) + 1;
console.log(`\nbooks (${booksOut.length}) — measured against the witness where it has a list:`);
for (const b of booksOut) {
  console.log(
    `  ${b.label}: ${b.chapters} chapter(s)` +
      (b.witnessAgreement === 'agree' ? ` — witness agrees (${b.witness})` : b.witnessAgreement === 'FLAGGED' ? ` — FLAGGED: ${b.witnessNote}` : ' — no witness list'),
  );
}
console.log(`\ndivisions: ${divisions.length}  confidence ${JSON.stringify(conf)}  placement ${JSON.stringify(how)}`);
const missing = [];
for (let b = 1; b <= (booksOut.length ? Math.max(...booksOut.map((x) => x.n)) : 0); b++) {
  const w = wBook.get(b);
  const want = w ? w.chapters : booksOut.find((x) => x.n === b).chapters;
  const got = divisions.filter((d) => d.book === b).map((d) => d.chapter);
  for (let c = 1; c <= want; c++) if (!got.includes(c)) missing.push(`Book ${b} ch ${c}`);
}
if (missing.length) console.log(`MISSING from the model: ${missing.join(', ')}`);
if (notes.length) {
  console.log(`\nreadings that could not be reconciled (${notes.length}):`);
  for (const m of notes) console.log(`  ${m}`);
}

/* ---------- the artifact ---------- */

const out = {
  slug,
  // THE METHOD IS SERVED. This string travels into the edition's document
  // (`divisions.readFrom`, tools/extract.mjs) and is therefore written for a
  // READER: it names no internal file and no tool. It said `tools/vision-heads.mjs`
  // and `source.txt`/`_djvu.xml`, which the leak gate caught the first time this
  // edition was published (an internal path in a served document).
  method:
    'the chapter and book numerals are read off the PAGE IMAGES themselves, one reading per leaf (its running ' +
    'head, its chapter heading, its printed page) — the transcription destroyed them (`CHAP. au.`, ' +
    '`CHAPTER VE`, `BOOK actrees`) and fitting one from the sequence is how a division is attributed to the wrong ' +
    'book. Each division is then placed in the transcription by matching the opening words of its first page ' +
    'against the text layer the scan itself carries, and a run that does not occur EXACTLY ONCE places nothing. ' +
    'A second transcription of the same print was read against the model as a witness, book by book.',
  source: {
    version,
    sha256: sha256(source),
    lines: rawLines.length,
    linesWithText: flat.length,
    meta: metaJson.source_sha256 || null,
  },
  vision: { model: heads.model, leaves: Object.keys(heads.leaves).length, readings: readings.length, placed },
  witness: witness
    ? { file: witnessFile, lists: witness.map((b) => ({ book: b.book, raw: b.raw, chapters: b.chapters, line: b.line })) }
    : { file: null },
  books: booksOut,
  divisions,
  notes,
};
mkdirSync(dirname(join(EDITION, 'divisions.json')), { recursive: true });
writeFileSync(join(EDITION, 'divisions.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`\nwrote ${join(EDITION, 'divisions.json')} (${divisions.length} division(s))`);

function romanWord(x) {
  if (!Number.isInteger(x) || x <= 0) return String(x);
  const T = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let n = x;
  for (const [v, s] of T) while (n >= v) { out += s; n -= v; }
  return out;
}
