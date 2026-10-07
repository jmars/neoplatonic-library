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
 *  5. THE SCAN FURNITURE IS OUT OF THE READING VIEW. The Theology's whole
 *     furniture class — the Google watermark and the line under it, the
 *     chapter running heads ('CHAP. n.', 'CHAPTER n.'), the Introduction's
 *     and the contents pages' running heads, the printer's signatures and
 *     'VOL.' feet, and the head halves ('ON THE THEOLOGY', 'BOOK n.',
 *     'OF PLATO.') — is recomputed here from the stored edition (a second
 *     statement of the classifier and of its carve-out, not a copy) and must
 *     be suppressed in the document: absent from the reading view but the
 *     book's own text the carve-out spares (the contents entries, the
 *     chapter and book display headings, the title pages' volume
 *     statements, the contents display heading, and the four lines a repair
 *     rule is defined over), kept in the transcription, absent from /plain,
 *     and the pinned anchors must still match. FAILS IF the classifier
 *     stops firing, the carve-out stops sparing, a line of the book's own
 *     text is eaten, or an anchor moves.
 *
 *  6. THE DIVISION MODEL IS VERSION-AWARE. The edition is multi-version and the
 *     model is versioned with it: every version holds its OWN divisions.json
 *     (the build REFUSES the state where one does not — a pinned page must
 *     never silently inherit the edition-level file after it has moved on),
 *     each version's document is built from ITS file, and the two models
 *     frozen at the same state are byte-identical to each other. FAILS IF a
 *     version is missing its model, the extractor serves another file than the
 *     version's own, or the frozen copies diverge.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extract,
  checkEdits,
  tidyPunctuation,
  repairsPath,
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
  divisionsPath,
  versionDivisionsPath,
} from './extract.mjs';
import { TEXTS } from './shelf.mjs';
import { rawBlocks, joinLines, isFurnitureJunk } from './reader.mjs';

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
/* THE SERVED ANCHOR IS THE MODEL'S, NOT THE ORDINAL. The id a citation names
 * is the division\u2019s own recorded `anchor`; the ordinal is only the walk\u2019s
 * position (extractor: `secN = div.n`). So each served id is checked against
 * the RECORDED name \u2014 checking it against `s${n}` would only restate the
 * coupling an inserted division has to break \u2014 and the model may not claim
 * one name twice. */
const servedModel = JSON.parse(readFileSync(divisionsPath(SLUG, editionRecord(SLUG).current_version), 'utf8'));
check(
  new Set(servedModel.divisions.map((d) => d.anchor)).size === servedModel.divisions.length,
  `the ${servedModel.divisions.length} recorded anchors are unique`,
);
check(
  secs.every((b, i) => b.id === servedModel.divisions[i].anchor),
  'every served section id IS its division\u2019s recorded anchor (not its ordinal)',
);

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
/* The shapes and the carve-out below are a SECOND statement of the
 * `theology-1816` classifier in tools/extract.mjs — recomputed here from the
 * stored edition, not read off the extractor, so a classifier that stopped
 * firing, or a carve-out that stopped sparing, would fail these checks. The
 * counts are MEASURED over every line of the stored transcription. */
const spelling = (a, b, k) => {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > k) return Infinity;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
};
const nearK = (a, word, k = 1) => a === word || spelling(a, word, k) <= k;
const lettersOf = (t) => t.replace(/[^A-Za-z]/g, '').toLowerCase();
const numeralToken = (t) => {
  const a = lettersOf(t);
  if (a === '') return false;
  const rom = (a.match(/[ivxlcdm]/g) || []).length;
  return rom === a.length || (a.length >= 3 && rom * 2 >= a.length) || /^\d+$/.test(a);
};
const BOOK_HEAD_LINE = /^book(?![A-Za-z])[^A-Za-z\s]{0,2}(\s*\S{1,4})?(\s\S{1,2})?[^A-Za-z0-9\s]{0,2}$/i;
const CHAPTER_ONE_LINE = /^chapter\s+[il1][.,;:]?$/i;
/* the Google watermark and the line under it (MEASURED: 947) */
const isWatermark = (line) => {
  const t = line.trim();
  if (/^\s*[a-z]?\s*digitiz/i.test(t)) return true;
  if (/^\/?\s*(?:google|gc>9gle)\b/i.test(t)) return true;
  if (t.length === 0 || t.length > 32) return false;
  const toks = t.split(/\s+/).filter((x) => x !== '');
  const isStampWord = (w) => nearK(w, 'digitized', 2) || nearK(w, 'google', 2);
  if (toks.some((x) => isStampWord(lettersOf(x)))) return true;
  return toks.length >= 2 && isStampWord(lettersOf(toks[0]) + lettersOf(toks[1]));
};
/* a CHAPTER line: the running head 'CHAP. n.', the display heading and the
 * contents entry 'CHAPTER n.', and the whole recto head glued on one line
 * (MEASURED: 794) */
const isChapHead = (line) => {
  const t = line.trim();
  if (t.length === 0 || t.length > 28) return false;
  const toks = t.split(/\s+/).filter((x) => x !== '');
  if (toks.length < 2) return false;
  const isChapWord = (w) =>
    w.length >= 3 && w.length <= 7 && (nearK(w, 'chap') || nearK(w, 'chapter') || /ap$/.test(w));
  let idx = 1;
  if (!isChapWord(lettersOf(toks[0]))) {
    if (toks.length >= 2 && lettersOf(toks[0]).length <= 2 && isChapWord(lettersOf(toks[0]) + lettersOf(toks[1]))) {
      idx = 2;
    } else {
      return false;
    }
  }
  if (idx >= toks.length) return false;
  const num = toks[idx].replace(/[^A-Za-z0-9]/g, '');
  if (num.length < 1 || num.length > 7) return false;
  if (!(/[A-Z]/.test(toks[idx]) || num.length <= 3 || numeralToken(num))) return false;
  for (let k = idx + 1; k < toks.length; k++) {
    if (/^[a-z]{4,}/.test(toks[k]) && !numeralToken(toks[k])) return false;
  }
  return true;
};
/* the Introduction's and the contents pages' running head (MEASURED: 67) */
const isIntroContents = (line) => {
  const t = line.trim();
  if (t.length === 0 || t.length > 20) return false;
  const toks = t.split(/\s+/).filter((x) => x !== '');
  const isWord = (w) => nearK(w, 'introduction', 2) || nearK(w, 'contents', 2);
  if (isWord(lettersOf(t))) return true;
  if (toks.length >= 2) {
    const ab = lettersOf(toks[0]) + lettersOf(toks[1]);
    if (isWord(ab) && toks.slice(2).every((x) => x.length <= 4)) return true;
  }
  const strip = toks.slice();
  while (strip.length && strip[0].length <= 5 && (numeralToken(strip[0]) || /^[^A-Za-z]/.test(strip[0]))) strip.shift();
  while (strip.length && strip[strip.length - 1].length <= 5 && (numeralToken(strip[strip.length - 1]) || /^[^A-Za-z]/.test(strip[strip.length - 1])))
    strip.pop();
  return strip.length > 0 && isWord(lettersOf(strip.join(' ')));
};
/* the running foot's bare 'Proc.' and the printer's signatures (MEASURED: 93) */
const isProcFoot = (line) => {
  const t = line.trim();
  if (t.length > 22) return false;
  const toks = t.split(/\s+/).filter((x) => x !== '');
  if (toks.length === 0) return false;
  if (!nearK(lettersOf(toks[0]), 'proc')) return false;
  if (toks.length === 1) {
    const w = lettersOf(t);
    return w === 'proc' || (w.length === 5 && w.includes('proc'));
  }
  let k = 1;
  while (k < toks.length && toks[k].length <= 2 && !/[A-Za-z]{2}/.test(toks[k])) k++;
  if (k >= toks.length) return true;
  if (!nearK(lettersOf(toks[k]), 'vol', 2) || lettersOf(toks[k]).length > 4) return false;
  k++;
  /* the numeral's period split off onto a token of its own ('Proc. Vol . I. k') */
  while (k < toks.length && toks[k].replace(/[^A-Za-z0-9]/g, '') === '') k++;
  if (k >= toks.length) return true;
  const volnum = toks[k].replace(/[^A-Za-z0-9]/g, '');
  if (volnum.length > 2 || !/^[ivxlcdmj123]+$/i.test(volnum)) return false;
  k++;
  const rest = toks.slice(k);
  if (rest.length === 0) return true;
  return rest.length <= 3 && rest.every((x) => x.replace(/[^A-Za-z0-9]/g, '').length <= 2);
};
/* the running foot's volume half 'VOL. I.' / 'VOL. II.' (MEASURED: 16) */
const isVolFoot = (line) => {
  const t = line.trim();
  if (t.length > 10) return false;
  const toks = t.split(/\s+/).filter((x) => x !== '');
  if (toks.length === 1) {
    const whole = lettersOf(t);
    return nearK(whole.slice(0, 3), 'vol') && /^[ivxlcdmj123]+$/i.test(whole.slice(3));
  }
  if (toks.length < 2 || toks.length > 3) return false;
  if (!nearK(lettersOf(toks[0]), 'vol') || lettersOf(toks[0]).length > 4) return false;
  const volnum = toks[1].replace(/[^A-Za-z0-9]/g, '');
  if (volnum.length > 2 || !/^[ivxlcdmj123]+$/i.test(volnum)) return false;
  if (toks.length === 3 && toks[2].replace(/[^A-Za-z0-9]/g, '').length > 2) return false;
  return true;
};
/* the verso head 'ON THE THEOLOGY' (MEASURED: 357) */
const isVersoHead = (line) => {
  const toks = line.trim().split(/\s+/).filter((t) => t !== '');
  if (toks.length < 2 || toks.length > 6) return false;
  if (!toks.some((t) => nearK(lettersOf(t), 'theology', 2))) return false;
  let headWords = 0;
  for (const t of toks) {
    if (['on', 'the', 'theology'].some((w) => nearK(lettersOf(t), w, 2))) {
      headWords++;
      continue;
    }
    if (nearK(lettersOf(t), 'book')) continue;
    const a = t.replace(/[^A-Za-z0-9]/g, '');
    if (a !== '' && a.length <= 4 && numeralToken(a)) continue;
    if (a === '') continue;
    return false;
  }
  return headWords >= 2;
};
/* the recto head's right half 'OF PLATO.' (MEASURED: 344) */
const isRectoHead = (line) => {
  const t = line.trim();
  const toks = t.split(/\s+/).filter((x) => x !== '');
  if (toks.length < 1 || toks.length > 4) return false;
  if (nearK(lettersOf(t), 'ofplato', 2) && (t.match(/[A-Z]/g) || []).length >= 3) return true;
  if (toks.length >= 2) {
    const a = lettersOf(toks[0].replace(/^[^A-Za-z]+/, ''));
    const b = lettersOf(toks[1]);
    if (
      nearK(a, 'of') &&
      nearK(b, 'plato', 2) &&
      (toks[1].match(/[A-Z]/g) || []).length >= 3 &&
      toks.slice(2).every((x) => /^[^A-Za-z\s]{1,5}$/.test(x))
    ) {
      return true;
    }
  }
  return false;
};
/* the recto head's right half as a line of its own — the narrower shape the
 * carve-out reads a page's head with (a page that carries no such line has no
 * 'CHAP. n.' running head either) */
const isPlatoHead = (line) => {
  const t = line.trim();
  if (t.length > 12) return false;
  if (nearK(lettersOf(t), 'ofplato', 2) && (t.match(/[A-Z]/g) || []).length >= 3) return true;
  return t
    .split(/\s+/)
    .filter((x) => x !== '')
    .some((tok) => (tok.match(/[A-Z]/g) || []).length >= 3 && nearK(lettersOf(tok), 'plato', 2));
};
/* a line of prose, as the carve-out reads it */
const isProse = (line) => {
  const t = line.trim();
  return t.length > 55 || (/[a-z]{3,}/.test(t) && /\s/.test(t) && t.length > 25);
};
/* The furniture class of a line, in the classifier's own order. */
const furnitureClass = (line) => {
  if (isWatermark(line)) return 'watermark';
  if (isChapHead(line)) return 'chap';
  if (isIntroContents(line)) return 'intro';
  if (isProcFoot(line)) return 'proc';
  if (isVolFoot(line)) return 'vol';
  if (isVersoHead(line)) return 'versoHead';
  if (isRectoHead(line)) return 'rectoHead';
  if (line.length <= 12 && BOOK_HEAD_LINE.test(line)) return 'book';
  return null;
};
/* The stored transcription's own lines, in reading order, with the recorded
 * divisions' positions and the block each line stands in, so the carve-out
 * can be recomputed here. */
const blocks = rawBlocks(src);
const flatLines = blocks.flat();
const flatStart = [];
const flatBlock = [];
{
  let f = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    flatStart.push(f);
    for (let k = 0; k < blocks[bi].length; k++) flatBlock.push(bi);
    f += blocks[bi].length;
  }
}
const flatOfRaw = [];
{
  const raw = src.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
  let f = 0;
  for (let i = 0; i < raw.length; i++) flatOfRaw[i] = raw[i].trim() !== '' ? f++ : -1;
}
/* The model the SERVED document is built from: resolved version-aware, so the
 * carve-out below is recomputed from the same model the extraction read (the
 * current version's own file, not the edition-level working copy). */
const divisions = JSON.parse(readFileSync(divisionsPath(SLUG, editionRecord(SLUG).current_version), 'utf8'));
const divAt = new Map();
for (const d of divisions.divisions) divAt.set(flatOfRaw[d.line - 1], d);
const divFlat = [...divAt.keys()].sort((a, b) => a - b);
const bodyStart = divFlat[0];
/* the next line past the scan's debris */
const nextText = (i) => {
  for (let k = i + 1; k <= Math.min(flatLines.length - 1, i + 2); k++) {
    if (isFurnitureJunk(flatLines[k])) continue;
    return k;
  }
  return -1;
};
/* a chapter line is a display heading when it opens the chapter's text; the
 * clause that spares it is named, so the decomposition is asserted too */
const displayClause = (i) => {
  const line = flatLines[i];
  if (line.trim().length > 18) return null;
  const nx = nextText(i);
  if (nx < 0 || !isProse(flatLines[nx])) return null;
  let wm = -1;
  for (let k = i; k >= Math.max(0, i - 40); k--) {
    if (isWatermark(flatLines[k])) {
      wm = k;
      break;
    }
  }
  let proseAbove = false;
  let platoAbove = false;
  let chapAbove = 0;
  if (wm >= 0) {
    for (let k = wm + 1; k < i; k++) {
      if (isProse(flatLines[k])) {
        proseAbove = true;
        break;
      }
      if (isPlatoHead(flatLines[k])) platoAbove = true;
      if (isChapHead(flatLines[k])) chapAbove++;
    }
  }
  if (proseAbove) return 'afterProse';
  if (chapAbove > 0) return 'secondChap';
  let distBelow = Infinity;
  let distAbove = -1;
  for (const at of divFlat) {
    if (at > i) {
      distBelow = at - i;
      break;
    }
  }
  for (let k = divFlat.length - 1; k >= 0; k--) {
    if (divFlat[k] <= i) {
      distAbove = i - divFlat[k];
      break;
    }
  }
  if (distBelow <= 2) return 'aboveDiv';
  if (wm >= 0 && !platoAbove) return 'noRectoHead';
  return distAbove <= 25 ? 'nearDivAbove' : null;
};
/* the title pages' volume statements are not at a page foot */
const atPageFoot = (i) => {
  for (let k = i + 1; k <= Math.min(flatLines.length - 1, i + 4); k++) {
    if (isWatermark(flatLines[k])) return true;
  }
  return false;
};
/* the contents section's display heading, split over lines */
const isContentsDisplay = (i) => {
  if (/[^A-Za-z]/.test(flatLines[i].trim())) return false;
  for (let k = i + 1; k <= Math.min(flatLines.length - 1, i + 2); k++) {
    if (/^the chapters of book/i.test(flatLines[k].trim())) return true;
  }
  return false;
};
/* The book-opening display headings the carve-out spares: the BOOK line
 * standing immediately above the `CHAPTER I.` line that belongs to a
 * chapter-1 division (MEASURED: seven, one per book — the volume prints each
 * book's opening page with the display headings `BOOK n.` / `CHAPTER I.`
 * above the chapter's first line, and the verso running head
 * `ON THE THEOLOGY BOOK n.` on the same page). */
const bookSpared = [];
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
      bookSpared.push(k);
      break;
    }
  }
}
const bookSparedSet = new Set(bookSpared);
/* a furniture line a repair rule is defined over: the rule's find is present
 * in the block's served text only with the line kept (a fusion of a
 * printer-broken word with the signature inside the break, or a line served
 * tidied), and in neither the block without the line nor the raw line the
 * transcription serves — so the line is spared and the rule keeps firing */
const ruleVersion = editionRecord(SLUG).current_version;
const repairs = JSON.parse(readFileSync(repairsPath(SLUG, ruleVersion), 'utf8'));
const ruleFinds = repairs.rules.map((r) => (r.location && r.location.find) || '').filter((f) => f !== '');
const ruleTargeted = (i) => {
  const bi = flatBlock[i];
  if (bi == null) return false;
  const block = blocks[bi];
  const li = i - flatStart[bi];
  const withLine = tidyPunctuation(joinLines(block));
  const without = tidyPunctuation(joinLines(block.filter((_, k) => k !== li)));
  const raw = flatLines[i];
  return ruleFinds.some((f) => withLine.includes(f) && !without.includes(f) && !raw.includes(f));
};
/* The carve-out, re-stated clause by clause, over every line of the slice. */
const SOURCE = { watermark: 947, chap: 794, intro: 67, proc: 93, vol: 16, versoHead: 357, rectoHead: 344, book: 342 };
const tally = {};
for (const cls of Object.keys(SOURCE)) tally[cls] = { spared: 0, suppressed: 0 };
const clause = {
  front: 0,
  afterProse: 0,
  secondChap: 0,
  aboveDiv: 0,
  noRectoHead: 0,
  nearDivAbove: 0,
  bookDisplay: 0,
  volTitle: 0,
  contentsDisplay: 0,
  ruleTargeted: 0,
};
const sourceClass = {};
for (let i = 0; i < flatLines.length; i++) {
  const cls = furnitureClass(flatLines[i]);
  if (!cls) continue;
  sourceClass[cls] = (sourceClass[cls] || 0) + 1;
  let why = null;
  if (cls === 'chap') {
    if (i < bodyStart) why = 'front';
    else why = displayClause(i);
  } else if (cls === 'book') {
    if (bookSparedSet.has(i)) why = 'bookDisplay';
  } else if (cls === 'vol') {
    if (!atPageFoot(i)) why = 'volTitle';
  } else if (cls === 'intro') {
    if (isContentsDisplay(i)) why = 'contentsDisplay';
  }
  if (!why && ruleTargeted(i)) why = 'ruleTargeted';
  if (why) {
    tally[cls].spared++;
    clause[why]++;
  } else {
    tally[cls].suppressed++;
  }
}
for (const [cls, want] of Object.entries(SOURCE)) {
  check(sourceClass[cls] === want, `the stored transcription carries ${want} ${cls} line(s) (found ${sourceClass[cls] || 0})`);
}
check(
  Object.values(sourceClass).reduce((a, b) => a + b, 0) === 2960,
  `the whole class is 2,960 line(s) (found ${Object.values(sourceClass).reduce((a, b) => a + b, 0)})`,
);
check(clause.front === 225, `the carve-out spares the 225 front-matter contents entries (found ${clause.front})`);
/* MEASURED over the corrected model (version 1.0.2): the spared SET is the
 * same 215 display headings, but one line's clause moved — the CHAPTER I.
 * display heading at flat 13531 now stands immediately above division 103's
 * own line (the division moved from flat 13551 to 13532), so the aboveDiv
 * clause spares it where noRectoHead spared it before. aboveDiv 35 -> 36,
 * noRectoHead 2 -> 1; the other three clauses are unchanged. */
check(
  clause.afterProse === 155 &&
    clause.secondChap === 22 &&
    clause.aboveDiv === 36 &&
    clause.noRectoHead === 1 &&
    clause.nearDivAbove === 1,
  `the 215 display headings are spared by the measured clauses — afterProse ${clause.afterProse}, secondChap ${clause.secondChap}, aboveDiv ${clause.aboveDiv}, noRectoHead ${clause.noRectoHead}, nearDivAbove ${clause.nearDivAbove}`,
);
check(clause.bookDisplay === 7, `the carve-out spares the 7 book-opening display headings (found ${clause.bookDisplay})`);
check(clause.volTitle === 2, `the carve-out spares the 2 title-page volume statements (found ${clause.volTitle})`);
check(clause.contentsDisplay === 1, `the carve-out spares the contents display heading (found ${clause.contentsDisplay})`);
check(clause.ruleTargeted === 4, `the carve-out spares the 4 lines a repair rule is defined over (found ${clause.ruleTargeted})`);
const SPARED = { watermark: 0, chap: 441, intro: 1, proc: 3, vol: 2, versoHead: 0, rectoHead: 0, book: 7 };
for (const [cls, want] of Object.entries(SPARED)) {
  check(
    tally[cls].spared === want && tally[cls].suppressed === SOURCE[cls] - want,
    `${cls}: ${want} spared, ${SOURCE[cls] - want} suppressed (found ${tally[cls].spared}/${tally[cls].suppressed})`,
  );
}
check(
  Object.values(tally).reduce((a, t) => a + t.spared, 0) === 454 &&
    Object.values(tally).reduce((a, t) => a + t.suppressed, 0) === 2506,
  `the carve-out spares 454 and suppresses 2,506 (found ${Object.values(tally).reduce((a, t) => a + t.spared, 0)}/${Object.values(tally).reduce((a, t) => a + t.suppressed, 0)})`,
);
/* The reading view: every suppressed line is out of it, served `rh` in the
 * transcription; every spared line is in it — and the four lines a repair
 * rule is defined over are in it too, fused where the printer broke a word
 * across the page, so the rule keeps firing. */
const docClass = { p: {}, rh: {} };
for (const b of doc.blocks) {
  if (typeof b.x !== 'string') continue;
  const cls = furnitureClass(b.x.trim());
  if (!cls) continue;
  const t2 = b.t === 'rh' ? docClass.rh : docClass.p;
  t2[cls] = (t2[cls] || 0) + 1;
}
/* The spared lines as the reading view serves them: the three spared
 * signatures are fused into prose blocks (asserted by their strings just
 * below), and the whole-head line a repair rule is defined over is served
 * tidied — 'CHAP, xyi.:OF.PM,TO. 137', where the tidying glues the numeral
 * token, so its served form is no longer chap-shaped (asserted by its exact
 * string just below too). */
const P_SERVED = { watermark: 0, chap: 440, intro: 1, proc: 0, vol: 2, versoHead: 0, rectoHead: 0, book: 7 };
for (const cls of Object.keys(SOURCE)) {
  const pWant = P_SERVED[cls];
  check(
    (docClass.rh[cls] || 0) === SOURCE[cls] - SPARED[cls],
    `${cls}: all ${SOURCE[cls] - SPARED[cls]} suppressed line(s) are kept in the transcription as rh (found ${docClass.rh[cls] || 0})`,
  );
  check((docClass.p[cls] || 0) === pWant, `${cls}: the reading view carries ${pWant} (found ${docClass.p[cls] || 0})`);
}
const shapeTally = {};
for (const b of doc.blocks) shapeTally[b.t] = (shapeTally[b.t] || 0) + 1;
check(
  shapeTally.p === 3193 && shapeTally.rh === 2695 && shapeTally.sec === 215 && shapeTally.verse === 9,
  `the document's shape: 3,193 p, 2,695 rh, 215 sections, 9 verse (found ${shapeTally.p}/${shapeTally.rh}/${shapeTally.sec}/${shapeTally.verse})`,
);
const readingText = doc.blocks
  .filter((b) => b.t !== 'rh' && typeof b.x === 'string')
  .map((b) => b.x)
  .join('\n');
for (const needle of ['sub-Proc. Vol. I. S', 'attri-Proc. Vol. I, 2 E', 'Proc, Vol. JI. Z']) {
  check(readingText.includes(needle), `the reading view keeps the fused signature '${needle}' so its repair rule fires`);
}
check(
  doc.blocks.some((b) => b.t !== 'rh' && b.x === 'CHAP, xyi.:OF.PM,TO. 137'),
  'the reading view keeps the whole-head line a repair rule is defined over, served tidied',
);
{
  let err = null;
  try {
    checkEdits(doc);
  } catch (e) {
    err = e;
  }
  check(!err, `every repair rule fires in the served text${err ? ` — ${String(err.message).split('\n')[0]}` : ''}`);
}
/* The negative controls: lines the shapes must never take — the book's own
 * text that looks like furniture. Each must still be in the reading view. */
for (const control of [
  'END OF VOL. I.',
  'Horos.',
  'Mid. ^',
  'Heaven. 3',
  'chapter forty is wanting.',
  'cap. 7.',
  'Procl. in Tim. p. 296.',
  'ON THE THEOLOGY OF PLATO.',
  'ON THE THEOLOGY OF PLATO,',
  'of Plato.',
]) {
  check(readingText.includes(control), `the book's own text '${control}' is still in the reading view`);
}
/* The served files: the built /t is this extraction, so the checks above are
 * checks of what is served; and /plain — which skips the suppressed blocks,
 * exactly as the Elements' does — carries none of the suppressed classes,
 * only the spared lines that are the book's own text. */
{
  const servedT = readFileSync(join(DIST, 'texts', SLUG, 't'), 'utf8');
  check(serialiseDoc(doc) === servedT, 'the served /t IS this extraction (the reading-view checks apply to it)');
  const servedPlain = readFileSync(join(DIST, 'texts', SLUG, 'plain'), 'utf8');
  const plainClass = {};
  for (const l of servedPlain.split('\n')) {
    const cls = furnitureClass(l.trim());
    if (cls) plainClass[cls] = (plainClass[cls] || 0) + 1;
  }
  const PLAIN = { watermark: 0, chap: 440, intro: 1, proc: 0, vol: 2, versoHead: 0, rectoHead: 0, book: 7 };
  for (const [cls, want] of Object.entries(PLAIN)) {
    check(
      (plainClass[cls] || 0) === want,
      `/plain carries ${want} ${cls} line(s) — spared text, no suppressed line (found ${plainClass[cls] || 0})`,
    );
  }
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

/* ---------- 6. the division model is version-aware ---------- */

section('6. the division model is version-aware (a pinned version serves its own)');
/* The edition is multi-version and the model is versioned with it: every
 * version holds its OWN divisions.json — the build refuses the state where one
 * does not, because a pinned page inheriting the edition-level file after that
 * file has moved on would serve a structure its DOI does not name — each
 * version's document is built from ITS file, and the two models frozen at the
 * same state are byte-identical to each other. */
const versions = readdirSync(join(ROOT, 'data', 'editions', SLUG, 'versions'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
check(versions.length > 1, `the edition is multi-version (${versions.join(', ')})`);
for (const v of versions) {
  check(existsSync(versionDivisionsPath(SLUG, v)), `v${v} holds its own division model (versions/${v}/divisions.json)`);
}
for (const v of versions) {
  /* a version whose model is missing is already FAILED above; do not crash on
   * it here — the failure list must stay complete */
  if (!existsSync(versionDivisionsPath(SLUG, v))) continue;
  const s = readEdition(SLUG, v);
  const d = extract(s, { entry: t, sha256: sha256(s), version: v });
  const model = JSON.parse(readFileSync(versionDivisionsPath(SLUG, v), 'utf8'));
  const secs = d.blocks.filter((b) => b.t === 'sec');
  check(
    secs.length === model.divisions.length &&
      secs.every((b, i) => b.n === model.divisions[i].n && (b.page ?? null) === (model.divisions[i].page ?? null)),
    `v${v}: the document's ${secs.length} section(s) are built from its own model, pages included`,
  );
  /* the served ids are the model's recorded anchors on EVERY pinned version,
   * and no model claims an anchor twice */
  check(
    new Set(model.divisions.map((d) => d.anchor)).size === model.divisions.length &&
      secs.every((b, i) => b.id === model.divisions[i].anchor),
    `v${v}: every served id is its division\u2019s recorded anchor, and the anchors are unique`,
  );
  const served = readFileSync(join(DIST, 'texts', SLUG, 'v', v, 't'), 'utf8');
  check(serialiseDoc(d) === served, `v${v}: the served /v/${v}/t IS this extraction`);
}
/* the two models frozen at the same state are byte-identical to each other */
{
  const pa = versionDivisionsPath(SLUG, '1.0.0');
  const pb = versionDivisionsPath(SLUG, '1.0.1');
  const same = existsSync(pa) && existsSync(pb) && sha(readFileSync(pa)) === sha(readFileSync(pb));
  check(same, `the models frozen for 1.0.0 and 1.0.1 are byte-identical (${same ? sha(readFileSync(pa)).slice(0, 12) : 'missing'}…)`);
}

console.log(`\n${fails === 0 ? 'DIVISIONS PROBE PASSED' : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
