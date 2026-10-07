#!/usr/bin/env node
/**
 * tools/divisions-probe.mjs — the recorded-division mode, end to end.
 *
 *     node tools/divisions-probe.mjs
 *
 * WHAT IT PROVES, and each check names what it would FAIL on:
 *
 *  1. THE EDITION EXTRACTS. Taylor's 1816 *Theology of Plato* — the edition whose
 *     division numerals the scan destroyed, so that no opener regex can read one —
 *     is extracted from the stored transcription with `opener: "recorded"` and its
 *     divisions taken from `data/editions/<slug>/divisions.json`. FAILS IF the
 *     model is missing, stale, or does not open exactly 1…N in document order.
 *
 *  2. THE DIVISIONS ARE THE STRUCTURE. 223 chapters in 7 books; every section
 *     carries its book and chapter and label; every anchor `s1`…`s223` exists
 *     once; the books' chapter counts are the print's own, and the witness's
 *     agreement is recorded per book. FAILS IF a division lost its book, if an
 *     anchor repeats, or if a book's count silently stops matching the witness.
 *
 *  3. THE READER RENDERS THEM. The served shell is booted in a DOM (happy-dom)
 *     with the extracted document, exactly as the app smoke boots a served
 *     edition, and the contents list it builds must carry one entry per division
 *     with the anchors the document serves. FAILS IF the app does not boot on
 *     this document, or renders a division the document does not anchor.
 *
 *  4. THE PUBLISHED EDITIONS DO NOT MOVE. The two editions that ARE published are
 *     extracted and served by the same code; their `/t` and `/plain` are compared
 *     byte for byte against the hashes MEASURED BEFORE the recorded-division mode
 *     landed (the values below, taken from the last build of the previous unit).
 *     FAILS IF the new mode reached into a served edition.
 *
 *  5. THE SCAN FURNITURE IS OUT OF THE READING VIEW. The Theology's page
 *     furniture — the Google watermark and the line under it, the volume's own
 *     running heads ('ON THE THEOLOGY', 'BOOK n.', 'OF PLATO.') — is recomputed
 *     here from the stored edition (a second statement of the classifier, not a
 *     copy of it) and must be suppressed in the document: absent from the
 *     reading view but the seven book-opening display headings (the book's own
 *     text, spared by the carve-out), kept in the transcription, absent from
 *     /plain, and the pinned anchors must still match. FAILS IF the classifier
 *     stops firing, eats a line of the book's own text, or moves an anchor.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extract,
  readEdition,
  readMeta,
  serialiseDoc,
  plainText,
  sha256,
  editionRecord,
  counts,
  anchorLists,
  anchorHash,
  ANCHOR_DIR,
} from './extract.mjs';
import { TEXTS } from './shelf.mjs';
import { rawBlocks } from './reader.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'site', 'dist');
const SLUG = 'proclus-theology-of-plato-taylor-1816';
/* THE COUNT IS THE MODEL'S OWN, not the witness's contents lists' 223. MEASURED:
 * the print's OWN numbering slips — its Book III runs `CHAPTER III.` then
 * `CHAPTER IX.` with no heading between (verified on the leaf images: pages 166
 * and 168 carry none, and page 167's content, which the second transcription
 * carries in full, carries none either), and its vol. I ends at Book V ch. XXXIX.
 * So the body's chapters are 215 and the witness's contents lists (which number
 * Book III 1…28) over-count. The probe expects what the scans support. */
const EXPECTED = { divisions: 215, books: 7 };

/* The published editions' served files, hashed BEFORE this unit's change (the
 * build of 2026-10-05 that the previous unit left green). They are the control:
 * the recorded-division mode is switched on per edition, and a served edition
 * must be untouched by it. */
const BASELINE = {
  'porphyry-on-the-cave-of-the-nymphs-taylor-1917/t': '95eb5de94c76ee5441781a8b81528b2b5665173e3f7d4164b4ace37fcfc01311',
  'porphyry-on-the-cave-of-the-nymphs-taylor-1917/plain': '640157a8295ab9febb0c5a2b2353b761d1e50aef7646777ffb861736f2671af3',
  'proclus-elements-of-theology-taylor-1816/t': 'd4405672021f86d8926565c865c77f81d1a5d21db528d0aaac5cb9ea8e14002a',
  'proclus-elements-of-theology-taylor-1816/plain': 'b19df5120b30477bd0bcf9488697267dcf938af93accc720ab59032863d37e13',
};

let fails = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) fails++;
};
const section = (t) => console.log(`\n${t}`);
const sha = (s) => createHash('sha256').update(s).digest('hex');

/* ---------- the happy-dom loader (the app smoke's own candidates) ---------- */

const HAPPY = process.env.HAPPY_DOM || null;
function happyDom() {
  const candidates = [
    HAPPY,
    join(ROOT, 'node_modules', 'happy-dom'),
    join(ROOT, '..', 'fixpoint-linux', 'fixpointlinux.org', 'node_modules', 'happy-dom'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return require(c).Window;
  throw new Error(`happy-dom not found (looked in ${candidates.join(', ')}; set HAPPY_DOM=...)`);
}
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);

/* ---------- 1. the edition extracts ---------- */

section(`1. ${SLUG} extracts with its recorded divisions`);
const t = TEXTS.find((x) => x.slug === SLUG);
if (!t) {
  console.error('the edition has no shelf entry');
  process.exit(1);
}
const src = readEdition(SLUG);
const doc = extract(src, { entry: t, sha256: sha256(src), version: editionRecord(SLUG).current_version });
const c = counts(doc);
check(c.sections === EXPECTED.divisions, `the document has ${c.sections} division(s) (expected ${EXPECTED.divisions})`);
check(!!doc.divisions && doc.divisions.count === EXPECTED.divisions, `the document states the model it was built from (${doc.divisions && doc.divisions.count})`);
check(!!doc.divisions && doc.divisions.books.length === EXPECTED.books, `and names ${doc.divisions && doc.divisions.books.length} book(s)`);
check(
  !!doc.divisions && doc.divisions.source && doc.divisions.source.sha256 === sha256(src),
  'and the bytes of the transcription it was recovered against',
);

/* ---------- 2. the divisions are the structure ---------- */

section('2. every division carries its book, chapter, label and anchor');
const secs = doc.blocks.filter((b) => b.t === 'sec');
check(secs.length === EXPECTED.divisions, `${secs.length} section block(s) in the document`);
check(
  secs.every((b, i) => b.n === i + 1 && b.id === `s${i + 1}`),
  'the sections run 1…N in document order, each with its own anchor',
);
check(new Set(secs.map((b) => b.id)).size === secs.length, 'no anchor is claimed twice');
check(
  secs.every((b) => Number.isInteger(b.book) && Number.isInteger(b.chapter) && typeof b.label === 'string' && b.label.length),
  'every section carries its book, its chapter and a human label',
);
const withBook = doc.toc.filter((x) => x.book != null && x.chapter != null);
check(withBook.length === EXPECTED.divisions, `${withBook.length} contents entr(y/ies) carry the structure`);
const perBook = doc.divisions.books.map((b) => ({ n: b.n, chapters: b.chapters, w: b.witness, a: b.agreement }));
check(
  perBook.every((b) => b.a === 'agree' || b.a === 'FLAGGED'),
  `every book records its agreement with the witness rather than assuming it ` +
    `(${perBook.map((b) => `${b.n}:${b.chapters}/${b.w}${b.a === 'agree' ? '' : '*'}`).join(' ')})`,
);
const flagged = perBook.filter((b) => b.a !== 'agree');
check(
  flagged.length === 0 || doc.divisions && flagged.every((b) => b.chapters <= b.w),
  `a FLAGGED book never claims more chapters than the witness names (${flagged.map((b) => b.n).join(', ') || 'none flagged'})`,
);
const chapters = doc.toc.filter((x) => x.book != null).map((x) => `${x.book}.${x.chapter}`);
check(new Set(chapters).size === chapters.length, 'no (book, chapter) pair is claimed twice');

/* ---------- 3. the reader renders them ---------- */

section('3. the reader renders the divisions of the extracted document');
const Window = happyDom();
const SHELL = join(DIST, 'texts', 'proclus-elements-of-theology-taylor-1816', 'index.html');
if (!existsSync(SHELL)) {
  console.error(`  the site is not built (${SHELL} is missing) — node build/build.mjs`);
  process.exit(1);
}
/* The shell is a served edition's, with its reader flags pointed at THIS edition:
 * the app boots on the real bundle and renders the real document, which is what
 * "the reader renders its divisions" means. Only the flags differ. */
let shell = readFileSync(SHELL, 'utf8');
const flagsRe = /(<script type="application\/json" id="reader-flags">)(.*?)(<\/script>)/s;
const fm = flagsRe.exec(shell);
check(!!fm, 'the served shell carries its reader flags');
const flags = JSON.parse(fm[2]);
flags.slug = SLUG;
flags.url = '/texts/' + SLUG + '/t';
flags.base = '/texts/' + SLUG + '/';
shell = shell.replace(flagsRe, `$1${JSON.stringify(flags)}$3`);
const headInner = shell.slice(shell.indexOf('<head>') + 6, shell.indexOf('</head>'));
const bodyInner = shell.slice(shell.indexOf('<body>') + 6, shell.lastIndexOf('</body>'));
const docText = serialiseDoc(doc);

/** Boot the page the way a browser does: parse it, run its scripts in order. */
async function boot(docJson) {
  const w = new Window({ url: `http://localhost/texts/${SLUG}/` });
  const names = [
    'window', 'document', 'navigator', 'location', 'history', 'customElements', 'performance',
    'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage',
    'getComputedStyle', 'matchMedia', 'IntersectionObserver', 'HTMLElement', 'HTMLDivElement',
    'HTMLSpanElement', 'HTMLAnchorElement', 'HTMLButtonElement', 'HTMLInputElement',
    'HTMLParagraphElement', 'Element', 'Node', 'Document', 'DocumentFragment', 'Text', 'Comment',
    'NodeList', 'HTMLCollection', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'UIEvent',
    'EventTarget', 'MutationObserver',
  ];
  const bound = new Set(['requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia']);
  for (const name of names) {
    const value = w[name];
    if (value === undefined) continue;
    Object.defineProperty(globalThis, name, {
      value: bound.has(name) && typeof value === 'function' ? value.bind(w) : value,
      configurable: true,
      writable: true,
    });
  }
  globalThis.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve(docJson) });
  globalThis.setTimeout = w.setTimeout.bind(w);
  globalThis.clearTimeout = w.clearTimeout.bind(w);
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.document.head.innerHTML = headInner;
  w.document.body.innerHTML = bodyInner;
  const scripts = [...w.document.querySelectorAll('script')].filter((s) => {
    const ty = s.getAttribute('type');
    return !ty || /javascript|module/i.test(ty);
  });
  try {
    delete globalThis.Elm;
  } catch {
    globalThis.Elm = undefined;
  }
  for (const s of scripts) (0, eval)(s.textContent);
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 12));
  return w;
}

const w = await boot(docText);
const app = w.document.getElementById('reader-app');
check(!!app && app.innerHTML.length > 1000, 'the app boots on the extracted document and renders');
const toc = app && app.querySelector('.rd-toc');
check(!!toc, 'the contents list is rendered');
/* The contents list also links the section headings back to the top of the list,
 * so only the DIVISION links are counted: each is `#s<n>`. */
const links = toc ? [...toc.querySelectorAll('a')].filter((a) => /^#s\d+$/.test(a.getAttribute('href') || '')) : [];
check(links.length === EXPECTED.divisions, `one contents entry per division (${links.length})`);
const hrefs = new Set(links.map((a) => (a.getAttribute('href') || '').replace(/^#/, '')));
check(hrefs.size === EXPECTED.divisions, 'every contents entry points at its own anchor');
check(
  secs.every((b) => w.document.getElementById(b.id) != null),
  'every division the document anchors is an element the app rendered (s1…s215 resolve)',
);
check(
  w.document.getElementById('s215') != null && w.document.getElementById('s150') != null,
  'including a division deep in Book VI and the last division of the work',
);

/* ---------- 4. the published editions do not move ---------- */

section('4. the published editions’ served files are byte-identical');
for (const [rel, want] of Object.entries(BASELINE)) {
  const file = join(DIST, 'texts', rel);
  if (!existsSync(file)) {
    check(false, `${rel} exists (build the site first)`);
    continue;
  }
  const got = sha(readFileSync(file));
  check(got === want, `${rel} unchanged (${got.slice(0, 12)}…)`);
}
/* and the two published editions still extract to the same documents they are
 * SERVED as — the file comparison above is of the build's output, this is of the
 * extraction the build runs, so the two cannot agree by both being stale */
for (const slug of ['porphyry-on-the-cave-of-the-nymphs-taylor-1917', 'proclus-elements-of-theology-taylor-1816']) {
  const e = TEXTS.find((x) => x.slug === slug);
  const s = readEdition(slug);
  const d = extract(s, { entry: e, sha256: sha256(s), version: editionRecord(slug).current_version });
  const served = readFileSync(join(DIST, 'texts', slug, 't'), 'utf8');
  const servedPlain = readFileSync(join(DIST, 'texts', slug, 'plain'), 'utf8');
  check(serialiseDoc(d) === served, `${slug}: the extraction still IS the served /t`);
  check(plainText(d, e) === servedPlain, `${slug}: the extraction still IS the served /plain`);
}


/* ---------- 5. the scan furniture is out of the reading view, kept in the
 * transcription, and the anchors did not move ---------- */

section('5. the scan furniture is suppressed in the reading view and kept in the transcription');
/* The shapes below are a SECOND statement of the `theology-1816` classifier in
 * tools/extract.mjs — recomputed here from the stored edition, not read off the
 * extractor, so a classifier that stopped firing would fail these checks. The
 * counts are MEASURED over every line of the stored transcription. */
const near = (a, b) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (edits++) return false;
    if (a.length === b.length) {
      i++;
      j++;
    } else if (a.length < b.length) {
      j++;
    } else {
      i++;
    }
  }
  return true;
};
const BOOK_HEAD_LINE = /^book(?![A-Za-z])[^A-Za-z\s]{0,2}(\s*\S{1,4})?(\s\S{1,2})?[^A-Za-z0-9\s]{0,2}$/i;
const CHAPTER_ONE_LINE = /^chapter\s+[il1][.,;:]?$/i;
/* The furniture class of a line: the Google watermark and the line under it,
 * the verso head's halves ('ON THE THEOLOGY', 'BOOK n.') and the recto head's
 * right half ('OF PLATO.') — `book` for the book running-head line, which the
 * carve-out may spare at a book opening. */
const furnitureClass = (line) => {
  if (/^\s*[a-z]?\s*digitiz/i.test(line)) return 'watermark';
  if (/^\/?\s*(?:google|gc>9gle)\b/i.test(line)) return 'google';
  const toks = line.split(/\s+/).filter((t) => t !== '');
  const word = (t) => t.replace(/[^A-Za-z]/g, '').toLowerCase();
  const isHeadWord = (t) => ['on', 'the', 'theology'].some((w) => near(word(t), w));
  if (toks.length >= 2 && toks.length <= 5 && toks.some((t) => near(word(t), 'theology'))) {
    const rest = toks.filter((t) => !isHeadWord(t));
    const gluedBook =
      rest.length === 0 ||
      (rest.length <= 2 &&
        near(word(rest[0]), 'book') &&
        rest.slice(1).every((t) => {
          const numeral = t.replace(/[^A-Za-z0-9]/g, '');
          return (
            numeral.length >= 1 &&
            numeral.length <= 4 &&
            (numeral.match(/[ivxlcdm0-9]/gi) || []).length * 2 >= numeral.length
          );
        }));
    if (gluedBook && toks.length - rest.length >= 2) return 'versoHead';
  }
  if (toks.length >= 2 && toks.length <= 4) {
    const [a, b] = toks.map(word);
    if (
      near(a, 'of') &&
      near(b, 'plato') &&
      (toks[1].match(/[A-Z]/g) || []).length >= 3 &&
      toks.slice(2).every((t) => /^[^A-Za-z\s]{1,5}$/.test(t))
    ) {
      return 'rectoHead';
    }
  }
  if (line.length <= 12 && BOOK_HEAD_LINE.test(line)) return 'book';
  return null;
};
/* The stored transcription's own lines, in reading order, with the recorded
 * divisions' positions, so the carve-out can be recomputed here. */
const divisions = JSON.parse(readFileSync(join(ROOT, 'data', 'editions', SLUG, 'divisions.json'), 'utf8'));
const flatLines = rawBlocks(src).flat();
const flatOfRaw = [];
{
  const raw = src.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
  let f = 0;
  for (let i = 0; i < raw.length; i++) flatOfRaw[i] = raw[i].trim() !== '' ? f++ : -1;
}
const divAt = new Map();
for (const d of divisions.divisions) divAt.set(flatOfRaw[d.line - 1], d);
const divFlat = [...divAt.keys()].sort((a, b) => a - b);
/* The book-opening display headings the carve-out spares: the BOOK line
 * standing immediately above the `CHAPTER I.` line that belongs to a
 * chapter-1 division (MEASURED: seven, one per book — the volume prints each
 * book's opening page with the display headings `BOOK n.` / `CHAPTER I.`
 * above the chapter's first line, and the verso running head
 * `ON THE THEOLOGY BOOK n.` on the same page). */
const spared = [];
for (const at of divFlat) {
  const div = divAt.get(at);
  if (div.chapter !== 1) continue;
  let heading = -1;
  for (let k = at - 1; k >= Math.max(0, at - 40); k--) {
    if (CHAPTER_ONE_LINE.test(flatLines[k])) {
      heading = k;
      break;
    }
  }
  if (heading < 0) continue;
  for (let k = heading - 1; k >= Math.max(0, heading - 4); k--) {
    if (flatLines[k].length <= 12 && BOOK_HEAD_LINE.test(flatLines[k])) {
      spared.push(k);
      break;
    }
  }
}
const sparedSet = new Set(spared);
const FURNITURE = { watermark: 792, google: 143, versoHead: 340, rectoHead: 337, book: 342 };
const sourceClass = {};
flatLines.forEach((line, i) => {
  const cls = furnitureClass(line);
  if (!cls) return;
  sourceClass[cls] = (sourceClass[cls] || 0) + 1;
  if (cls === 'book' && sparedSet.has(i)) (sourceClass.bookSpared = (sourceClass.bookSpared || 0) + 1);
});
for (const [cls, want] of Object.entries(FURNITURE)) {
  check(
    sourceClass[cls] === want,
    `the stored transcription carries ${want} ${cls} line(s) (found ${sourceClass[cls] || 0})`,
  );
}
check(
  (sourceClass.bookSpared || 0) === 7,
  `the carve-out spares exactly 7 book-opening display headings (found ${sourceClass.bookSpared || 0})`,
);
/* The reading view: no furniture class survives as text but the display
 * headings — the seven `BOOK n.` lines are the book's own headings, and every
 * other furniture line is suppressed. */
const docClass = { p: {}, rh: {} };
for (const b of doc.blocks) {
  if (typeof b.x !== 'string') continue;
  const cls = furnitureClass(b.x.trim());
  if (!cls) continue;
  const tally = b.t === 'rh' ? docClass.rh : docClass.p;
  tally[cls] = (tally[cls] || 0) + 1;
}
const pFurniture = Object.values(docClass.p).reduce((a, b) => a + b, 0);
check(
  pFurniture === 7 && (docClass.p.book || 0) === 7,
  `the reading view carries no furniture but the 7 display headings (found ${pFurniture}: ${JSON.stringify(docClass.p)})`,
);
const rhFurniture = Object.values(docClass.rh).reduce((a, b) => a + b, 0);
check(
  rhFurniture === 792 + 143 + 340 + 337 + 335,
  `the transcription keeps all 1,947 furniture lines as suppressed blocks (found ${rhFurniture}: ${JSON.stringify(docClass.rh)})`,
);
/* The served files: the built /t is this extraction, so the checks above are
 * checks of what is served; and /plain — which skips the suppressed blocks,
 * exactly as the Elements' does — carries none of the watermark or head
 * classes at all. */
{
  const servedT = readFileSync(join(DIST, 'texts', SLUG, 't'), 'utf8');
  check(serialiseDoc(doc) === servedT, 'the served /t IS this extraction (the reading-view checks apply to it)');
  const servedPlain = readFileSync(join(DIST, 'texts', SLUG, 'plain'), 'utf8');
  const plainFurniture = servedPlain
    .split('\n')
    .filter((l) => ['watermark', 'google', 'versoHead', 'rectoHead'].includes(furnitureClass(l.trim())));
  check(
    plainFurniture.length === 0,
    `/plain carries no watermark or head line (the suppressed blocks are skipped there; found ${plainFurniture.length})`,
  );
}
/* The anchors did not move: the pinned manifest is this document's anchor list. */
{
  const lists = anchorLists(doc);
  const hash = anchorHash(lists);
  const pinned = JSON.parse(readFileSync(join(ANCHOR_DIR, `${SLUG}.json`), 'utf8'));
  check(
    pinned.hash === hash && JSON.stringify(pinned.sections) === JSON.stringify(lists.sections),
    `the pinned anchor manifest still matches (${lists.sections.length} sections, ${lists.pages.length} pages, hash ${hash.slice(0, 12)}…)`,
  );
}

console.log(`\n${fails === 0 ? 'DIVISIONS PROBE PASSED' : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
