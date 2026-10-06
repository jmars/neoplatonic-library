#!/usr/bin/env node
/**
 * tools/divisions-reanchor.mjs — move a RECORDED division model onto a
 * transcription it was not derived against, keeping the structure.
 *
 *     node tools/divisions-reanchor.mjs <slug> --xml-dir DIR [--dry-run]
 *
 * WHY THIS EXISTS, and why it is not `tools/divisions.mjs`.
 *
 * `divisions.mjs` RECOVERS the structure: it reads the book and chapter numerals
 * off the page images with the vision model (because the scan destroyed the
 * numerals in THIS edition's old transcription — `CHAP. au.`, `CHAPTER VE`),
 * then locates each chapter's opening line in the transcription. That is the
 * right tool when the structure is unknown.
 *
 * When the STRUCTURE IS ALREADY RECORDED and the TRANSCRIPTION IS REPLACED — a
 * re-source onto another copy of the same print — the structure does not need
 * recovering: the print's books and chapters, and the printed page each one
 * opens on, are properties of the PRINT, and the recorded model already holds
 * them, read off the scans and cross-checked against a witness. What the
 * re-source moves is every LINE POSITION. Re-running the vision pass to read the
 * same numerals a second time would spend 700-odd image readings to learn
 * nothing, and would risk re-attributing a chapter to the wrong book — the exact
 * failure `divisions.mjs` exists to prevent.
 *
 * So this tool re-anchors: for every recorded division it keeps `n`, `book`,
 * `chapter`, `label`, `anchor`, `page` and the recorded evidence, and re-derives
 * the three coordinates that move with the text —
 *
 *   `line`  the 1-based line of the new source.txt the division opens on,
 *           FINGERPRINTED from the new copy's OWN text layer (the item's
 *           `_djvu.xml`, the same leaf lines `divisions.mjs` uses): the chapter's
 *           first prose line on the printed page the division is recorded on,
 *           matched as a token run that occurs exactly ONCE in the whole
 *           transcription;
 *   `text`  `collapseLine` of that line — the extractor REQUIRES it to be the
 *           line's own text, and fails the build when a recorded model no longer
 *           matches the line it names;
 *   `flat`  its index in the collapsed (blank-dropped) line stream.
 *
 * `leaf` moves with the copy too: the printed page a division opens on is stored
 * by the new scan under the new copy's own leaf number (`page + archiveOffset`,
 * from the edition's own scan.json, per volume). `evidence` keeps the recorded
 * vision reading (head, heading, raw) VERBATIM — it is a reading of the PRINTED
 * PAGE, and the same page is now stored under another leaf name, which is what
 * `evidence.leaf` becomes — and the model's `notes` say so.
 *
 * WHAT IT REFUSES TO DO: invent a structure (it never changes book/chapter/label),
 * guess a position (a run that does not occur exactly once places nothing), or
 * write a model it could not re-anchor (every unmoved division is reported, and
 * the tool exits non-zero if any division is left without a position).
 *
 * NOT in the build's module graph: it reads the item's `_djvu.xml` (15 MB, not in
 * the repo) and is run by hand, like `tools/divisions.mjs` itself.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { collapseLine } from './reader.mjs';
import { LIBRARY_DIR, versionOf, readEdition } from './extract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith('--'));
const dryRun = argv.includes('--dry-run');
const xmlDir = argv.includes('--xml-dir') ? argv[argv.indexOf('--xml-dir') + 1] : process.env.LIBRARY_DIVISIONS_XML || '';
if (!slug) {
  console.error('usage: node tools/divisions-reanchor.mjs <slug> --xml-dir DIR [--dry-run]');
  process.exit(2);
}
const EDITION = join(LIBRARY_DIR, slug);
const scan = JSON.parse(readFileSync(join(EDITION, 'scan.json'), 'utf8'));
const model = JSON.parse(readFileSync(join(EDITION, 'divisions.json'), 'utf8'));
const version = versionOf(slug);
const source = readEdition(slug, version);
const sha = createHash('sha256').update(source).digest('hex');

/* ---------- the volume a division belongs to, and its offset ----------
 * A division's own `leaf` names the volume it stands in (`v1-…` / `v2-…`); the
 * printed page it is recorded on comes from the model. The new leaf number is the
 * printed page plus THAT volume's measured offset — the same arithmetic the
 * edition's scan.json states and verifies at both ends. */
const offsetOf = new Map();
const leavesOf = new Map();
for (const it of scan.items || []) {
  const p = it.prefix || '';
  if (Number.isFinite(it.archiveOffset)) offsetOf.set(p, it.archiveOffset);
  if (Array.isArray(it.leaves)) leavesOf.set(p, it.leaves);
}
if (offsetOf.size === 0) throw new Error(`divisions-reanchor: ${slug}'s scan.json names no volume offset`);

/* ---------- the transcription's two line streams (as the extractor counts) ---------- */
const raw = source.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
const flat = [];
const rawOfFlat = [];
for (let i = 0; i < raw.length; i++) {
  const c = collapseLine(raw[i]);
  if (c === '') continue;
  rawOfFlat.push(i + 1);
  flat.push(c);
}
const tokens = [];
const tokenLine = [];
for (let fi = 0; fi < flat.length; fi++) {
  for (const m of flat[fi].matchAll(/[^\s]+/g)) {
    tokens.push(m[0]);
    tokenLine.push(fi);
  }
}
const tokenIndex = new Map();
tokens.forEach((w, i) => {
  if (!tokenIndex.has(w)) tokenIndex.set(w, []);
  tokenIndex.get(w).push(i);
});

/** The item's own leaf lines, from `_djvu.xml`, keyed by leaf number — the same
 * parse `divisions.mjs` does, so the two tools read a leaf identically. */
const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function parseDjvu(xml) {
  return [...xml.matchAll(/<OBJECT\b[\s\S]*?<\/OBJECT>/g)].map((m) => {
    const raw1 = m[0];
    const map = /usemap="[^"]*?(\d{4})\.djvu"/.exec(raw1);
    const lines = [];
    for (const lm of raw1.matchAll(/<LINE>([\s\S]*?)<\/LINE>/g)) {
      const ws = [...lm[1].matchAll(/<WORD\s+coords="([^"]+)"(?:\s+x-confidence="(\d+)")?\s*>([\s\S]*?)<\/WORD>/g)].map((w) => xmlText(w[3]));
      if (!ws.length) continue;
      lines.push(ws.join(' ').replace(/\s+/g, ' ').trim());
    }
    return { leaf: map ? Number(map[1]) : null, lines };
  });
}
const itemXml = new Map(); // archive_id -> leaves
for (const it of scan.items || []) {
  const id = it.archive_id || it.item;
  if (itemXml.has(id)) continue;
  /* THE ITEM ID IS NOT IN THE DERIVATIVE'S NAME. An archive item's `_djvu.xml`
   * carries the name of the FILE that was uploaded, not the item's identifier
   * (MEASURED: item `thomastaylor` serves `elementsoftheology_proclus_djvu.xml`),
   * so the item is identified by the sha256 the edition's own scan.json records
   * for its whole `_djvu.txt` — the text beside the xml is that file, and a match
   * is proof the two are the same upload — with a name match and a lone-xml
   * fallback for an item whose text is not in the directory. */
  const names = existsSync(xmlDir) ? readdirSync(xmlDir).filter((n) => n.endsWith('_djvu.xml')) : [];
  const shaOf = (f) => createHash('sha256').update(readFileSync(join(xmlDir, f))).digest('hex');
  let name = null;
  if (it.whole_sha256) {
    const txt = existsSync(xmlDir) ? readdirSync(xmlDir).find((n) => n.endsWith('_djvu.txt') && shaOf(n) === it.whole_sha256) : null;
    if (txt) name = names.find((n) => n === txt.replace(/_djvu\.txt$/, '_djvu.xml')) || null;
  }
  if (!name) name = names.find((n) => n.includes(id)) || (names.length === 1 ? names[0] : null);
  if (!name) throw new Error(`divisions-reanchor: no _djvu.xml for item ${id} in ${xmlDir || '(no --xml-dir)'} (found: ${names.join(', ') || 'none'})`);
  if (it.whole_sha256 && !existsSync(join(xmlDir, name.replace(/_djvu\.xml$/, '_djvu.txt')))) {
    throw new Error(`divisions-reanchor: ${name} has no _djvu.txt beside it to check against the item's recorded sha256`);
  }
  itemXml.set(id, new Map(parseDjvu(readFileSync(join(xmlDir, name), 'utf8')).map((o) => [o.leaf, o.lines])));
}
const leafLines = (prefix, n) => {
  for (const it of scan.items || []) {
    if ((it.prefix || '') !== prefix) continue;
    return itemXml.get(it.archive_id || it.item)?.get(n) || null;
  }
  return null;
};

const words = (t) => t.replace(/\s+/g, ' ').trim().split(' ').filter((w) => /[A-Za-z0-9]/.test(w));
const capWords = (t) => t.filter((w) => /[A-Za-z]{3}/.test(w)).length;
/** Page furniture, not prose: the line a division must not open on. */
const furnished = (t) =>
  /^(?:CHAP|CHAPTER|BOOK|VOL|PROP)\b/i.test(t) ||
  (/\b(?:PLATO|THEOLOGY)\b/i.test(t) && words(t).length <= 6) ||
  /^[^A-Za-z0-9]*\d{1,4}[^A-Za-z0-9]*$/.test(t) ||
  !/[A-Za-z]{3}/.test(t);

/** Find a run of this line's tokens that occurs EXACTLY ONCE in the whole
 * transcription. Returns the raw line (1-based) it starts on, or null.
 *
 * THE RUN IS SLID AND GROWN, not fixed at the line's first five tokens. The
 * item's `_djvu.xml` and the `_djvu.txt` derived from it do not tokenise
 * identically — the xml drops a marker the text keeps (MEASURED: leaf 400's
 * 'For he * in the intellectual', which the text carries with the asterisk and
 * the xml without) — so a run anchored to the line's first token can fail on a
 * line that is plainly there. Every start offset and every length is tried, and a
 * run is accepted only when it occurs ONCE in the whole transcription: a run that
 * occurs twice places nothing, which is what keeps the slide from matching a
 * common phrase somewhere else in the book. */
function placeLine(text) {
  const toks = words(text);
  if (capWords(toks) < 2 || toks.length < 4) return null;
  const maxStart = Math.min(8, toks.length - 4);
  for (let start = 0; start <= maxStart; start += 1) {
    const key0 = toks[start];
    const hits = tokenIndex.get(key0);
    if (!hits) continue;
    for (let n = 5; n <= Math.min(18, toks.length - start); n += 1) {
      if (capWords(toks.slice(start, start + n)) < 2) break;
      const key = toks.slice(start, start + n);
      const found = [];
      for (const p of hits) {
        let ok = true;
        for (let k = 1; k < key.length; k += 1) if (tokens[p + k] !== key[k]) { ok = false; break; }
        if (ok) { found.push(p); if (found.length > 1) break; }
      }
      if (found.length === 0) break; // a longer run cannot occur either
      if (found.length === 1) {
        const fi = tokenLine[found[0]];
        return { line: rawOfFlat[fi], flat: fi, key: key.length };
      }
    }
  }
  return null;
}

const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
const ROMAN_FIX = { i: 'I', l: 'I', '1': 'I', v: 'V', u: 'V', y: 'V', x: 'X' };
function roman(tok) {
  if (!tok) return null;
  let t = String(tok).replace(/[^IVXLCDMivxlcdm1luyY]/g, '');
  if (t === '') return null;
  t = t.split('').map((c) => ROMAN_FIX[c] || c.toUpperCase()).join('');
  if (!/^[IVXLCDM]+$/.test(t) || t.length > 8) return null;
  let n = 0;
  let prev = 0;
  for (let i = t.length - 1; i >= 0; i -= 1) {
    const v = ROMAN[t[i]];
    if (!v) return null;
    n += v < prev ? -v : v;
    prev = Math.max(prev, v);
  }
  return n > 0 && n <= 99 ? n : null;
}

/** The chapter's own opening prose line on a leaf: after the line that carries
 * the chapter heading this division is recorded for, else after the book head,
 * else the leaf's first prose line. `null` when the leaf carries no prose. */
function openingLine(lines, chapter) {
  if (!lines) return null;
  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /\b(?:CHAPS?|CHAPTERS?)\b[.,:]?\s*([IVXLCDMivxlcdm1luy0-9]+)/i.exec(lines[i]);
    if (m && roman(m[1]) === chapter) { start = i + 1; break; }
    const b = /\bBOOK\b[.,:]?\s*([IVXLCDMivxlcdm1luy]+)/i.exec(lines[i]);
    if (b && /CHAPTER/i.test(lines[i])) start = i + 1;
  }
  for (let i = start; i < lines.length; i += 1) {
    if (furnished(lines[i])) continue;
    if (words(lines[i]).length >= 4) return lines[i];
  }
  // the heading was on this page but its prose begins on the next: take the
  // leaf's own last-prose fallback (never a furniture line)
  for (let i = 0; i < lines.length; i += 1) {
    if (!furnished(lines[i]) && words(lines[i]).length >= 4) return lines[i];
  }
  return null;
}

/* ---------- the re-anchor ---------- */
/** The leaf a chapter opens on, found in the NEW copy's own text layer — the
 * fallback for a division whose recorded `page` is empty (the vision pass read
 * the heading and no folio). It is a lookup of the chapter's own heading, bounded
 * to the volume the division stands in, and it is reported like any other
 * re-anchor: a chapter whose heading cannot be found gets no position and stops
 * the write. */
function leafForChapter(prefix, chapter) {
  const range = leavesOf.get(prefix);
  if (!range) return null;
  for (let n = range[0]; n <= range[1]; n += 1) {
    const lines = leafLines(prefix, n);
    if (!lines) continue;
    /* THE WINDOW MUST COVER A TITLE PAGE'S OWN HEAD LINES. The xml's lines are
     * word-groups, not print lines: a division's first leaf carries the work's
     * title split over four or five of them ('PROCLUS,' / 'THE PLATONIC
     * SUCCESSOR,' / 'ON' / 'The Theology of Plato.') before its 'BOOK … CHAPTER …'
     * head, so a five-line window misses the heading exactly on the pages that
     * open a book (MEASURED: leaf 506, Book VI ch. I). Twelve lines carry it. */
    const head = lines.slice(0, 12).join(' ');
    const m = /\b(?:CHAPS?|CHAPTERS?)\b[.,:]?\s*([IVXLCDMivxlcdm1luy0-9]+)/i.exec(head);
    if (m && roman(m[1]) === chapter) return n;
  }
  return null;
}

/* ---------- the printed page a division opens on ----------
 *
 * The page is the coordinate BOTH the new leaf and the section's served page come
 * from, and the recorded model carries two readings of it: `page` (the page the
 * division opens on) and `pageRead` (what the vision model read off the leaf). A
 * folio the vision pass misread is a WRONG PAGE, and it propagates: the new leaf
 * would be another copy's page for it, and the division would open somewhere else
 * in the book.
 *
 * SO THE PAGE IS CHECKED AGAINST THE MODEL'S OWN ORDER before it is used. The 215
 * divisions run in print order, so the pages must not go backwards; a recorded
 * page that breaks that order (or that is empty) is not used, and the division's
 * page is taken instead from its OWN RECORDED LEAF through the OLD copy's own
 * leaf→page offset — measured from the neighbouring divisions, whose leaf and page
 * are both recorded, so it is a measurement of that copy rather than a fit to a
 * sequence. MEASURED on this model: vol. I's offset is a constant 73 across all
 * 141 of its divisions, and vol. II's shifts by one or two as the copy's leaves
 * carry two printed pages, so the offset is taken LOCALLY (the modal value among
 * the nearest divisions) and never globally.
 */
const oldLeafNum = (d) => {
  const m = /^(v\d+)-n(\d+)\.jpg$/.exec(d.leaf || '');
  return m ? { prefix: m[1], leaf: Number(m[2]) } : null;
};
const pairs = model.divisions.map((d, i) => {
  const ol = oldLeafNum(d);
  return { i, prefix: ol ? ol.prefix : null, leaf: ol ? ol.leaf : null, page: d.page };
});
/** The old copy's leaf→page offset near division i: the modal (leaf − page) among
 * the nearest divisions that recorded both, the nearest occurrence breaking a
 * tie. */
function localOffset(i, prefix) {
  const near = pairs
    .filter((p) => p.i !== i && p.prefix === prefix && p.leaf != null && p.page != null)
    .sort((a, b) => Math.abs(a.i - i) - Math.abs(b.i - i))
    .slice(0, 8);
  const count = new Map();
  for (const p of near) count.set(p.leaf - p.page, (count.get(p.leaf - p.page) || 0) + 1);
  let best = null;
  let bestN = 0;
  for (const p of near) {
    const o = p.leaf - p.page;
    const n = count.get(o);
    if (n > bestN) { best = o; bestN = n; }
  }
  return best;
}

const pages = new Array(model.divisions.length).fill(null);
const pageNotes = [];
for (let i = 0; i < model.divisions.length; i += 1) {
  const d = model.divisions[i];
  const ol = oldLeafNum(d);
  const off = ol ? localOffset(i, ol.prefix) : null;
  const implied = ol && off != null ? ol.leaf - off : null;
  /* THE TEST IS AGAINST THE DIVISION'S OWN LEAF, not against its neighbours'
   * pages: a folio misread FORWARD (191 for 101) leaves a sequence that is still
   * non-decreasing, so an order check alone cannot see it. The recorded leaf and
   * the recorded page are two readings of the same leaf, and a disagreement of
   * more than the copy's own two-page-leaf slack (one or two leaves) means one of
   * them is not a reading of this page. */
  let page = d.page;
  if (implied != null && (page == null || Math.abs(page - implied) > 2)) {
    pageNotes.push({
      n: d.n,
      label: d.label,
      recorded: d.page,
      used: implied,
      why: `its own recorded leaf ${d.leaf} minus that copy's local leaf→page offset ${off}`,
    });
    page = implied;
  } else if (page == null) {
    pageNotes.push({ n: d.n, label: d.label, recorded: null, used: null, why: 'no leaf and no page recorded' });
  }
  pages[i] = page;
}
/* THE ORDER, AS A CHECK AND NOT AS THE METHOD: within a volume the pages must
 * never go backwards (vol. II's pages restart at 1, so a cross-volume comparison
 * is meaningless), and a division that does is reported rather than fitted. */
for (let i = 1; i < pages.length; i += 1) {
  const a = oldLeafNum(model.divisions[i - 1]);
  const b = oldLeafNum(model.divisions[i]);
  if (!a || !b || a.prefix !== b.prefix) continue;
  if (pages[i] != null && pages[i - 1] != null && pages[i] < pages[i - 1]) {
    pageNotes.push({ n: model.divisions[i].n, label: model.divisions[i].label, recorded: pages[i], used: pages[i], why: `the pages go BACKWARDS here (${pages[i - 1]} then ${pages[i]}) — reported, not fitted` });
  }
}

const moved = [];
const report = [];
for (let i = 0; i < model.divisions.length; i += 1) {
  const d = model.divisions[i];
  const page = pages[i];
  const prefix = /^(v\d+)-n\d+\.jpg$/.exec(d.leaf || '')?.[1] || '';
  const off = offsetOf.get(prefix);
  if (!Number.isFinite(off)) {
    moved.push({ n: d.n, why: `the model records no ${prefix || 'volume'} offset for its leaf` });
    continue;
  }
  let leaf = page == null ? leafForChapter(prefix, d.chapter) : page + off;
  const found = page == null ? 'chapter-head' : d.page == null || d.page !== page ? 'own-leaf' : 'page';
  if (leaf == null) {
    moved.push({ n: d.n, why: `no page recorded and no leaf carries its chapter ${d.chapter} in ${prefix}` });
    continue;
  }
  const lines = leafLines(prefix, leaf);
  const opening = openingLine(lines, d.chapter);
  const placed = opening ? placeLine(opening) : null;
  if (!placed) {
    moved.push({ n: d.n, why: `leaf ${prefix}-n${leaf} (printed page ${leaf - off}${found === 'page' ? '' : `, ${found}`}): ${lines ? 'its opening line could not be fingerprinted into the transcription' : 'the item serves no such leaf'}` });
    continue;
  }
  const newLeaf = `${prefix}-n${leaf}.jpg`;
  report.push({
    n: d.n,
    label: d.label,
    line: placed.line,
    flat: placed.flat,
    text: flat[placed.flat],
    page: leaf - off,
    leaf: newLeaf,
    how: d.how,
    wasLine: d.line,
    wasLeaf: d.leaf,
    wasPage: d.page,
    found,
  });
}
console.log(`${slug}: ${model.divisions.length} recorded division(s); ${report.length} re-anchored, ${moved.length} NOT`);
if (moved.length) for (const m of moved.slice(0, 40)) console.log(`  NOT division ${m.n}: ${m.why}`);
if (moved.length > 40) console.log(`  … (+${moved.length - 40})`);
for (const p of pageNotes) {
  console.log(`  page corrected: division ${p.n} (${p.label}) recorded printed page ${p.recorded == null ? '(none)' : p.recorded} — used ${p.used}: ${p.why}`);
}

/* EVERY division moves or the model is not written: a partially re-anchored
 * model is a model whose remaining positions are another transcription's. */
if (moved.length) {
  console.error(`divisions-reanchor: refusing to write a model with ${moved.length} division(s) left unmoved`);
  process.exit(1);
}
const dupes = new Set();
for (const r of report) {
  if (dupes.has(r.line)) {
    const other = report.find((x) => x !== r && x.line === r.line);
    console.error(
      `divisions-reanchor: two divisions re-anchor on the same line (${r.line}): ${other.label} (was ${other.wasLeaf} line ${other.wasLine}) and ` +
        `${r.label} (was ${r.wasLeaf} line ${r.wasLine})\n  the line: ${JSON.stringify(r.text)}`,
    );
    process.exit(1);
  }
  dupes.add(r.line);
}
if (report.length !== model.divisions.length) {
  console.error('divisions-reanchor: the re-anchored set is not the whole model');
  process.exit(1);
}

report.sort((a, b) => a.n - b.n);
for (let i = 1; i < report.length; i += 1) {
  if (report[i].line <= report[i - 1].line) {
    console.error(`divisions-reanchor: division ${report[i].n} does not open after division ${report[i - 1].n} (${report[i].line} <= ${report[i - 1].line})`);
    process.exit(1);
  }
}

const byN = new Map(report.map((r) => [r.n, r]));
const out = JSON.parse(JSON.stringify(model));
for (const d of out.divisions) {
  const r = byN.get(d.n);
  d.line = r.line;
  d.flat = r.flat;
  d.text = r.text;
  d.leaf = r.leaf;
  d.page = r.page;
  if (d.evidence && typeof d.evidence === 'object') {
    d.evidence = { ...d.evidence, leaf: r.leaf, read_from: d.evidence.leaf };
  }
}
out.source = {
  ...(out.source || {}),
  version,
  sha256: sha,
  lines: raw.length,
  linesWithText: flat.length,
  meta: sha,
};
out.witness = out.witness || {};
out.notes = [
  ...(out.notes || []),
  `RE-ANCHORED 2026-10-05 onto the transcription the edition now serves (sha256 ${sha.slice(0, 12)}…, ${raw.length} lines): the book and chapter numerals, the labels and the printed page each division opens on are the recorded ones, read off the scans and cross-checked against the witness; only the line positions were re-derived, by fingerprinting the chapter's own opening line from the NEW copy's text layer (the item's _djvu.xml leaf lines) into the new transcript, each run required to occur exactly once. Leaf names move to the new copy's own numbering (printed page + that volume's measured offset, from the edition's scan.json): vol. I n76-n500, vol. II n506-n804. Each division's evidence keeps the vision reading (head, heading, raw) recorded for that printed page and names the leaf the reading was taken FROM under 'read_from' (the superseded copy's leaf of the SAME printed page, whose images are no longer stored); 'leaf' is the stored page image a reader can check it on.`,
  ...(pageNotes.length
    ? [`PAGE CORRECTIONS (${pageNotes.length}): the recorded printed page was not used where it contradicted the division's own recorded leaf by more than that copy's two-page-leaf slack — ` +
      pageNotes.map((p) => `division ${p.n} (${p.label}): recorded ${p.recorded == null ? 'none' : p.recorded}, used ${p.used == null ? 'none' : p.used} — ${p.why}`).join('; ') +
      `. Each division keeps the misread folio in 'pageRead': the model now records what was read and what the division's own leaf makes the page, separately.`]
    : []),
];
out.vision = {
  ...(out.vision || {}),
  leaves: [...(scan.items || [])].reduce((a, it) => a + (it.leaves ? it.leaves[1] - it.leaves[0] + 1 : 0), 0),
  readings: out.vision?.readings ?? null,
  placed: report.length,
};

if (dryRun) {
  console.log('divisions-reanchor: --dry-run, nothing written');
  process.exit(0);
}
writeFileSync(join(EDITION, 'divisions.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`divisions-reanchor: wrote ${join('data', 'editions', slug, 'divisions.json')} (${report.length} division(s), source sha256 ${sha.slice(0, 12)}…)`);
