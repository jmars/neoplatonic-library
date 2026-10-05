/**
 * tools/library-extract-smoke.mjs — the extractor's proof (plan §11 Phase 1).
 *
 * `library-smoke.mjs` proves the built PAGES say something true about the shelf.
 * This proves the DOCUMENT does — and it recomputes everything from the stored
 * edition itself (`content/texts/<slug>/source.txt`), never from the build's
 * own report, because an expectation copied from the thing under test asserts
 * only that the thing is self-consistent.
 *
 * What it asserts, and what would break each:
 *
 *  1. NO TEXT IS LOST, DUPLICATED OR REORDERED. The source blocks are recomputed
 *     here (the same blank-line split the extractor uses, and the same
 *     de-hyphenation the reader uses — the text of the document must be the text
 *     of the page), the library stamp is recomputed as the leading run, and the
 *     document's text stream is compared with them. Fails if a block is dropped,
 *     a run is emitted twice, a run is emitted OUT OF ORDER (this caught the
 *     reference runs being emitted before the paragraph they sit in), or a
 *     character is changed. The comparison is on the character sequence with
 *     whitespace removed, because the reader normalises whitespace by design;
 *     state the convention and check the thing you can check.
 *  2. THE DIVISIONS RUN 1…18, NO GAPS, NO DUPLICATES, DISTINCT TITLES. The
 *     openers are re-derived here by a SECOND implementation of the three opener
 *     repairs, and the sequence is checked independently of the document. Fails
 *     if a section is missed, found twice, or two sections derive one title.
 *  3. EVERY NOTE IS DEFINED AND REFERENCED, AND THE NUMBER-FITTING RULE CAN FAIL.
 *     The definitions and references are recounted here from the source. The
 *     `(n)`→11 resolution is proven by TWO fixtures over the real text: a marker
 *     re-spelled as an unreadable token must still resolve to 11 (the rule fits
 *     the sequence, it does not know that string), and a marker re-spelled as a
 *     WRONG NUMBER must fail the extraction (so the fitting cannot paper over a
 *     real disagreement). Fails if fitting is a special case, or if the sequence
 *     is not actually enforced.
 *  4. THE PAGE SEQUENCE IS MONOTONE, AND ONLY THE RULE REFUSES. Every marker is
 *     recomputed from the running heads and the bare folios, the ±1 stride rule
 *     is re-applied here, and each `pb` in the document must carry a `how` and
 *     agree with the recomputation. Fails if a page goes backwards, if a pb has
 *     no `how`, if a refused marker would have been accepted (or the reverse),
 *     or if the document claims a page the text does not have.
 *  5. NO ANCHOR DRIFT — AND A DELIBERATE MOVE FAILS. The anchor list is
 *     recomputed and hashed against the committed manifest. Then the source is
 *     MUTATED (a head line deleted, a section number changed) and the gate must
 *     fire: `checkAnchors` must refuse the moved anchors, and the extraction must
 *     refuse the broken division sequence. Fails if the manifest has drifted, if
 *     the gate is a no-op, or if it writes over a pinned manifest.
 *  6. THE TWO FILES ARE EMITTED, ARE WHAT THE EXTRACTOR PRODUCES, LEAK NOTHING,
 *     AND FIT THE BUDGET. `/t` and `/plain` are read from dist and compared with
 *     a fresh extraction; an INDEPENDENT leak list (not the build's) is scanned
 *     over both; the sizes are measured against the plan's budget. Fails if a
 *     file is missing, stale, carries an internal path or a size claim, has no
 *     extension-cheating name problem, or grows past the cap. Skipped, loudly,
 *     when the tree has not been built yet.
 *  6b. THE RULES FILE IS THE DOCUMENT'S RULES, AND EVERY ONE OF THEM FIRES
 *     (phase 3, plan §7). The rules file is read here, its order and its classes
 *     are checked against the pipeline's own order, and every rule's hit count is
 *     RECOMPUTED over the document's own text fields — never read off the
 *     document. Then: the document's own `hits` must equal the recomputation; a
 *     rule ADDED to a copy and matching nothing must make `checkEdits` fail and be
 *     named; a rule whose find stands in the front-matter region must make the
 *     extraction fail (so the title page the reading cites as evidence cannot be
 *     quietly repaired); and the rules that fire more than once must be the ones
 *     the document names.
 *  6c. THE SECTION TITLES ARE THE READING'S OWN WORDS (phase 3, plan §11). Each
 *     title is recomputed here — from the section's opening words, with the file's
 *     rules applied — and must equal the document's. The raw title (no rule
 *     applied) must equal the document's `raw`. The titles the transcription
 *     damaged past repair must be exactly the ones whose damaged words no reading
 *     rule touches, must be marked rather than invented, and a section whose
 *     damage a reading rule READS (§11's opener) must come out readable and
 *     unmarked. Fails if a title is derived from the raw words, if a still-damaged
 *     title ships unmarked, or if a readable one is marked damaged.
 *  6d. THE DAMAGE THE READING VIEW STILL SHOWS IS COUNTED IN TWO CLASSES AND
 *     ACCOUNTED FOR IN FULL (fix 2 and fix 3 of the standalone-marker brief). Both
 *     counts are recomputed here from the served document — the damaged WORDS no
 *     rule resolved, and the STANDALONE MARKERS (letterless tokens carrying a
 *     damage character) standing between words — over the text the reading view
 *     actually renders (`p`, `verse` and `notedef`; the running heads are
 *     suppressed and the page markers are chrome). Fails if the two classes
 *     overlap or are merged, if a marker is counted among the words, if either
 *     count disagrees with the document's, or if any damage character in the
 *     reading view stands in a token belonging to NEITHER class. That last clause
 *     is the one that would have caught the gap the author found: MEASURED, the
 *     document reported 2 damaged words while the reading view showed 33 damage
 *     characters, because the other 31 stood alone between words.
 *  7. THE EDITION IN THE REPO IS THE SHELF FILE, AND A CHANGED SHELF FILE CANNOT
 *     OVERWRITE IT. The stored edition's sha256 is compared with the shelf's when
 *     the shelf is present, and the importer is run against a MODIFIED copy of
 *     the shelf in a temporary shelf directory: it must fail without writing.
 *     Fails if the edition drifted from its recorded provenance, or if the
 *     importer would silently replace a published edition.
 *
 * Run against a built tree:
 *
 *     node build/build.mjs && node tools/library-extract-smoke.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  extract,
  counts,
  checkEdits,
  checkFrontMatter,
  frontMatterText,
  editsPath,
  sectionTitle,
  titleDamage,
  loadEdits,
  loadBasePolicy,
  checkReadingPolicy,
  isPureDeletion,
  EDIT_CLASSES,
  wordDamaged,
  applyEditsCounted,
  damageCensus,
  markerCensus,
  damageCharCount,
  serialiseDoc,
  plainText,
  anchorLists,
  anchorHash,
  checkAnchors,
  anchorPath,
  readEdition,
  repairsPath,
  versionOf,
  editionPath,
  importPath,
  derivsPath,
  hasEdition,
  diffDocs,
  summariseDiff,
  loadDerivs,
  pageSignals,
  sha256,
} from './extract.mjs';
import { agreementRows, derivativeFiles, parseDjvu, readPageNumbers, leafTable, ITEM_FACTS } from './derive.mjs';
import { TEXTS, SHELF } from './shelf.mjs';
import { rawBlocks, joinLines, normaliseNumber, runningHead, bareFolio } from './reader.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The served bytes of an edition at its current version (model §3.1). */
const readExistingEdition = (slug) => {
  if (!hasEdition(slug)) throw new Error(`library-extract-smoke: no stored edition for ${slug}`);
  return readEdition(slug);
};
const DIST = join(ROOT, 'site', 'dist');
const SLUG = 'porphyry-on-the-cave-of-the-nymphs-taylor-1917';
const PROCLUS_SLUG = 'proclus-elements-of-theology-taylor-1816';
const ENTRY = TEXTS.find((t) => t.slug === SLUG);
const strip = (s) => s.replace(/\s+/g, '');
/** The served document's own text at a damaged find: the raw block text that carries it. */
const rawTextAt = (find) => (doc.blocks.find((b) => typeof b.x === 'string' && b.x.includes(find)) || {}).x || '';

let failures = 0;
let skipped = 0;
const check = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};
const skip = (msg) => {
  skipped++;
  console.log(`  SKIP ${msg}`);
};
const section = (name) => console.log(`\n${name}`);

if (!ENTRY) {
  console.error(`library-extract-smoke: no shelf entry '${SLUG}'`);
  process.exit(1);
}

/* The stored edition, and a fresh extraction of it. Everything below is checked
 * against these two, recomputed here. TWO EXTRACTIONS, because phase 4 is a
 * comparison between them: the document as phase 1 read it (from the running heads
 * alone) and the document as phase 4 reads it (every boundary placed on a leaf). */
const src = readExistingEdition(SLUG);
const doc = extract(src, { entry: ENTRY, sha256: sha256(src) });
const txtDoc = extract(src, { entry: ENTRY, sha256: sha256(src), leaf: false });
const recount = counts(doc);

/* The corrections this smoke applies itself — a SECOND statement of the three
 * opener repairs (§1.1 of the plan), so the document's 18 sections are not
 * trusted to the extractor's own rule list. */
const OPENERS = [
  ['I i. What', '1. What'],
  ["'3. After", '3. After'],
  ['n.^Tb,eologists', '11. Theologists'],
];
const fix = (line) => OPENERS.reduce((s, [a, b]) => (s.includes(a) ? s.split(a).join(b) : s), line);

/* ---------- 1. no text lost, duplicated or reordered ---------- */

section('every source block lands exactly once, in order (recomputed)');
{
  const blocks = rawBlocks(src);
  // the library stamp: the leading run of blocks that carry no word of letters
  // and no digits-only text of the book's own — recomputed as the first five
  // short blocks, then asserted to be exactly what the document recorded
  const stampCount = doc.dropped.length;
  check(stampCount > 0, `the library stamp is recorded (${stampCount} block(s)) — and SERVED, as the leading library region`);
  check(
    blocks.slice(0, stampCount).every((ls, i) => ls.join(' ') === doc.dropped[i].x),
    `the dropped blocks are the file's own leading blocks (${doc.dropped.map((d) => d.x).join(' ')})`,
  );
  // THE WHOLE FILE, because nothing is dropped from the transcription any more:
  // the library's stamp is SERVED as the leading `library` region (it used to be
  // dropped), so the document's text is the file's text entire.
  const source = blocks;
  const stream = doc.blocks.map((b) => b.x || '').join(' ');
  check(
    strip(stream) === strip(source.map((ls) => joinLines(ls)).join(' ')),
    `the document's text is the transcription's text, character for character ` +
      `(${strip(stream).length} characters against ${strip(source.map((ls) => joinLines(ls)).join(' ')).length})`,
  );
  let at = 0;
  let outOfPlace = null;
  for (const ls of source) {
    const t = strip(joinLines(ls));
    if (t === '') continue;
    if (strip(stream).slice(at, at + t.length) !== t) {
      outOfPlace = t.slice(0, 60);
      break;
    }
    at += t.length;
  }
  check(outOfPlace === null, `every source block stands at its own position in the document${outOfPlace ? ` (first out of place: ${JSON.stringify(outOfPlace)})` : ''}`);
  check(at === strip(stream).length, `and nothing stands in the document that the transcription does not have (${at} of ${strip(stream).length} characters accounted for)`);
}

/* ---------- 2. the divisions ---------- */

section('the divisions run 1…18, with distinct titles (recomputed)');
{
  const openers = [];
  for (const ls of rawBlocks(src)) {
    for (const line of ls) {
      const m = /^['\u2018]?(\d{1,2})\.\s/.exec(fix(line));
      if (m) openers.push(Number(m[1]));
    }
  }
  // the sequence, independently: each opener must be the next number due
  const sequence = openers.filter((n, i) => n === i + 1);
  check(
    openers.length === 18 && sequence.length === 18,
    `18 section openers were found in the transcription by a second reading of the three repairs ` +
      `(${openers.length} found: ${openers.join(', ')})`,
  );
  const secs = doc.blocks.filter((b) => b.t === 'sec').map((b) => b.n);
  check(
    secs.length === 18 && secs.every((n, i) => n === i + 1),
    `the document's sections are consecutive 1…18 (${secs.join(', ')})`,
  );
  check(doc.toc.length === 18 && doc.toc.every((e, i) => e.n === i + 1), `the contents list carries all 18, in order`);
  const titles = doc.toc.map((e) => e.title);
  check(new Set(titles).size === 18, `the 18 titles are distinct (${new Set(titles).size} distinct)`);
  check(
    doc.toc.every((e) => typeof e.title === 'string' && e.title.length > 0 && e.title.length <= 90),
    `every title is a short piece of the section's own opening words (longest ${Math.max(...titles.map((t) => t.length))} characters)`,
  );
  const body = doc.blocks.findIndex((b) => b.t === 'region' && b.kind === 'body');
  check(body > 0, `the body region opens where the first division opens (block ${body})`);
  const regions = doc.blocks.filter((b) => b.t === 'region').map((b) => b.kind);
  check(
    regions.join(',') === 'library,front,body,notes,colophon,end,library',
    `the volume's regions are in order, each named for what it is — the library's own marks at BOTH ends (${regions.join(', ')})`,
  );
  // the notes division, then the back of the volume in its three parts
  const notesAt = doc.blocks.findIndex((b) => b.t === 'region' && b.kind === 'notes');
  const adsAt = doc.blocks.findIndex((b) => b.t === 'region' && b.kind === 'end');
  check(
    doc.blocks[notesAt + 1] && doc.blocks[notesAt + 1].x === 'Notes',
    `the notes region opens at the print's own Notes division (${JSON.stringify((doc.blocks[notesAt + 1] || {}).x)})`,
  );
  // The boundary is the COLOPHON — the first block after note (25)'s own
  // paragraph — not the plan's `FROM THE GREEK OF PORPHYRY`, which occurs once in
  // the edition and on the title page, which OCRs as "From the Greeh of
  // Porphyry", so the rule never fired. This assertion used to encode the wrong
  // rule; it encodes the corrected one.
  const colophonAt = doc.blocks.findIndex((b) => b.t === 'region' && b.kind === 'colophon');
  check(
    doc.blocks[colophonAt + 1] && /^PRINTED IN GREAT BRITAIN/.test(doc.blocks[colophonAt + 1].x),
    `the printer's colophon opens its OWN region (${JSON.stringify((doc.blocks[colophonAt + 1] || {}).x)})`,
  );
  check(
    doc.blocks[colophonAt + 2] && doc.blocks[colophonAt + 2].t === 'region' && doc.blocks[colophonAt + 2].kind === 'end',
    'and the region after it is the publisher\'s list, not the colophon (the colophon is one block)',
  );
  const libAt = doc.blocks.map((b, i) => (b.t === 'region' && b.kind === 'library' ? i : -1)).filter((i) => i >= 0);
  check(libAt.length === 2, `the library's own marks are their own region at BOTH ends (${libAt.length})`);
  check(
    doc.blocks[libAt[0] + 1] && /^PA$/.test(doc.blocks[libAt[0] + 1].x),
    `the front one is this copy's call number, served not dropped (${JSON.stringify((doc.blocks[libAt[0] + 1] || {}).x)})`,
  );
  check(
    doc.blocks[libAt[1] + 1] && /^PLEASE DO NOT REMOVE/.test(doc.blocks[libAt[1] + 1].x),
    `and the back one is the circulation slip (${JSON.stringify((doc.blocks[libAt[1] + 1] || {}).x)})`,
  );
  const frontAt = doc.blocks.findIndex((b) => b.t === 'region' && b.kind === 'front');
  check(
    frontAt > libAt[0] && doc.blocks[frontAt + 1] && /^ON THE$/.test(doc.blocks[frontAt + 1].x),
    `and the BOOK's front matter opens after the library's stamp (${JSON.stringify((doc.blocks[frontAt + 1] || {}).x)})`,
  );
  check(
    doc.blocks.filter((b) => b.t === 'notedef' && b.n === 25).length === 1,
    'and the note before it did not swallow the colophon',
  );
}

/* ---------- 2b. the canonical rule file, and the acceptance rule (phase 3) ---------- */

/* ADAPTED (extraction plan §6, model §4.3): the blog's version of this section
 * read the pipeline's own rules file (tools/library/edits/<slug>.json). That file
 * is PROVENANCE here and the build never reads it: the source of truth is
 * data/editions/<slug>/versions/<semver>/repairs.json, and the document's rules
 * are DERIVED from it by model §4.0. So the checks below are the same checks —
 * every rule well-formed, in pipeline order, no duplicate find, every one fires,
 * the hit counts recomputed — but they now run over the canonical record, AND
 * they assert the derivation field for field, which is the shape change the plan
 * calls RISK 1: a leak there would leave the reading view with no rules and no
 * error. */
section("the rules are the canonical file's, every one of them fires, and a dead rule fails");
{
  const VERSION = versionOf(SLUG);
  const file = JSON.parse(readFileSync(repairsPath(SLUG, VERSION), 'utf8'));
  const edits = loadEdits(SLUG).edits;
  check(
    Array.isArray(file.rules) && file.rules.length === edits.length && edits.length > 0,
    `the canonical repairs.json (v${VERSION}) loads and carries ${edits.length} rule(s)`,
  );
  check(file.slug === SLUG && file.version === VERSION, `and names the edition and the version it belongs to (${file.slug} v${file.version})`);
  // THE FILE'S SHAPE, the MODEL's: a stable id, the scholarly type, the pipeline
  // apply class, the location, the words, and a rationale.
  const wellFormed = (r) =>
    typeof r.id === 'string' &&
    r.id === `${SLUG}:${r.id.split(':')[1]}` &&
    /:r\d{4,}$/.test(r.id) &&
    typeof r.type === 'string' &&
    ['OCR', 'punctuation', 'transliteration', 'conjectural'].includes(r.type) &&
    typeof r.apply === 'string' &&
    EDIT_CLASSES.includes(r.apply) &&
    r.location &&
    typeof r.location.find === 'string' &&
    r.location.find !== '' &&
    typeof r.rationale === 'string' &&
    r.rationale !== '' &&
    (r.apply === 'review' ? true : typeof r.after === 'string' && r.after !== '');
  check(
    file.rules.every(wellFormed),
    `every rule carries the model's fields (id, type, apply, location.find, before, after, rationale — ` +
      `${file.rules.filter((r) => r.apply === 'review').length} leave(s), ` +
      `${file.rules.filter((r) => r.review).length} flagged for human review)`,
  );
  // THE DERIVATION, field for field (model §4.0, plan RISK 1). A shape change in
  // the canonical record that the adapter did not follow fails HERE.
  const derived = (c, r) =>
    c.find === r.location.find &&
    c.cls === r.apply &&
    c.note === r.rationale &&
    c.repl === (r.apply === 'review' ? r.location.find : r.after) &&
    c.action === (r.apply === 'review' ? 'leave' : 'replace') &&
    Boolean(c.join) === Boolean(r.join);
  check(
    edits.every((c, i) => derived(c, file.rules[i])),
    "the document's rules are the canonical file's rules, derived by model §4.0 (find←location.find, repl←after, cls←apply, note←rationale, action←apply==='review'?'leave':'replace')",
  );
  check(
    doc.corrections.every((c, i) => derived(c, file.rules[i])),
    `and the document ships exactly that derivation (${doc.corrections.length} rule(s))`,
  );
  const ORDER = EDIT_CLASSES;
  const ranks = edits.map((c) => ORDER.indexOf(c.cls));
  check(
    ranks.every((r) => r >= 0) && ranks.every((r, i) => i === 0 || r >= ranks[i - 1]),
    `the classes are grouped in the pipeline's order (${ORDER.join(' → ')}): ${[...new Set(edits.map((c) => c.cls))].join(', ')}`,
  );
  // a reading must change the text; a LEAVE spends no bytes and is allowed to
  // stand as its own find (that is what "left" means)
  check(
    edits.every((c) => c.find !== c.repl || c.action === 'leave'),
    'no reading rule replaces a text with itself',
  );
  check(new Set(edits.map((c) => c.find)).size === edits.length, 'no two rules share a find');

  // the document's rules are the extraction's rules — not a second list
  check(
    doc.corrections.length === edits.length &&
      doc.corrections.every((c, i) => c.find === edits[i].find && c.repl === edits[i].repl && c.cls === edits[i].cls),
    `the document ships the file's rules and no others (${doc.corrections.length})`,
  );

  // THE HIT COUNT, RECOMPUTED HERE: each rule applied in order to every text field
  // of the document, one field at a time, counting what each one actually changes.
  const myHits = edits.map(() => 0);
  for (const b of doc.blocks) {
    if (typeof b.x !== 'string') continue;
    let text = b.x;
    edits.forEach((r, i) => {
      const parts = text.split(r.find);
      if (parts.length > 1) {
        myHits[i] += parts.length - 1;
        if (r.action !== 'leave') text = parts.join(r.repl);
      }
    });
  }
  const dead = edits.filter((_, i) => myHits[i] === 0);
  check(
    dead.length === 0,
    `every rule fires at least once in the served text (${edits.length} rules, ` +
      `${myHits.reduce((a, b) => a + b, 0)} applications)${dead.length ? `: ${dead.map((d) => JSON.stringify(d.find)).join(', ')}` : ''}`,
  );
  check(
    doc.corrections.every((c, i) => c.hits === myHits[i]),
    `the document's own hit counts are the ones recomputed here (${doc.corrections.map((c) => c.hits).join(', ').slice(0, 60)}…)`,
  );
  const repeated = edits.filter((_, i) => myHits[i] > 1);
  // The list is asserted to MATCH the recomputed one, whatever its length: a
  // rule set in which no rule fires twice is legitimate (a longer rule can
  // consume the characters a shorter one would have counted twice — MEASURED:
  // adding `that_jg_the` -> `that is the` before `_the` -> `the` took `_the`
  // from two hits to one). The old assertion required a non-empty list, which
  // was an assumption about this rule set rather than about the mechanism.
  check(
    JSON.stringify(doc.correctionsMeta.repeated.map((r) => r.find)) === JSON.stringify(repeated.map((r) => r.find)),
    `the rules that fire more than once are named as such (${repeated.length} such rule(s)` +
      (repeated.length ? `: ${repeated.map((r) => `${JSON.stringify(r.find)} ×${myHits[edits.indexOf(r)]}`).join(', ')}` : '') +
      `)`,
  );
  const byClass = (k) => edits.filter((c) => c.cls === k).length;
  check(
    Object.entries(doc.correctionsMeta.classes).every(([k, v]) => byClass(k) === v) &&
      Object.entries(doc.correctionsMeta.hits).every(([k, v]) => edits.filter((c) => c.cls === k).reduce((a, r, i) => a + myHits[edits.indexOf(r)], 0) === v),
    `the class and hit totals the document states are the recomputed ones ` +
      `(${Object.entries(doc.correctionsMeta.classes).map(([k, v]) => `${v} ${k}`).join(', ')}; ` +
      `${Object.entries(doc.correctionsMeta.hits).map(([k, v]) => `${v} ${k}`).join(', ')} applications)`,
  );

  // THE ASYMMETRY: the gate must fail on a rule that matches nothing, and name it
  let gate = null;
  try {
    checkEdits(doc);
    gate = 'passed (the gate is a no-op)';
  } catch (e) {
    gate = `threw: ${e.message}`;
  }
  check(gate === 'passed (the gate is a no-op)', `the real rule set passes the acceptance gate: ${gate.slice(0, 40)}`);
  const withDead = {
    ...doc,
    blocks: doc.blocks,
    corrections: [...doc.corrections, { find: 'nothing-in-this-text-matches-this', repl: 'x', cls: 'reading', note: 'a fixture, added deliberately' }],
  };
  let fired = null;
  try {
    checkEdits(withDead);
    fired = 'accepted (the gate is a no-op)';
  } catch (e) {
    fired = e.message;
  }
  check(
    typeof fired === 'string' && fired.includes('unreviewed machinery') && fired.includes('nothing-in-this-text-matches-this'),
    `a rule that matches nothing FAILS the gate and is named: ${fired.split('\n')[0].slice(0, 120)}`,
  );
}

/* ---------- 2b2. THE POLICY, AND THE THREE WORDS THE REVIEW CALLED BLOCKERs ---------- */

section('the policy: substitute-when-recorded, leave otherwise, never delete');
{
  const base = loadBasePolicy();
  const edits = loadEdits(SLUG).edits;
  const meta = doc.correctionsMeta;

  /* (1) THE THREE BLOCKER CASES, AGAINST THE PARALLEL'S OWN WORDS. Each asserted
     against a sentence READ FROM the parallel edition on the shelf, not against a
     string copied out of my own rules file: if the parallel's file changes or the
     passage moves, the substring fails and the case is reopened. FAILS IF any of
     the three readings regresses to the deleted-marker form the review measured. */
  const parFile = 'Porphyry-Taylor-Select-Works-1823.txt';
  const parPath = join(SHELF, parFile);
  const haveParallel = existsSync(parPath);
  if (!haveParallel) {
    skip(`the parallel (${parFile}) is not on the shelf — the three BLOCKER assertions cannot be computed`);
  } else {
    const par = readFileSync(parPath, 'utf8');
    const flattened = par.replace(/\s+/g, ' ');
    const BLOCKERS = [
      {
        // the reading is stated by ONE rule that spans the whole run: the page
        // turn's punctuation and the "but" after it were both misread, and the
        // print's comma (not the transcription's full stop) is part of the same
        // repair (1917 scan, printed page 34).
        find: 'fo~~tlTe~lieavens. _put',
        repl: 'to the heavens, but',
        parallel: 'one of which affords a passage to souls ascending to the heavens, but the other to souls descending to the',
        why: 'the print has "heavens, but the other" — a comma, not a full stop',
      },
      {
        find: '\\he',
        repl: 'the',
        parallel: 'it is requisite to sit at the foot of the olive, and consult with Minerva',
        why: 'the print has "the olive", not "he olive"',
      },
      {
        find: 'cavern*',
        repl: 'caverns',
        parallel: 'because caverns are dark, stony, and humid',
        why: 'the print has the plural "caverns"; the singular changes the number',
      },
    ];
    for (const b of BLOCKERS) {
      const rule = edits.find((e) => e.find === b.find);
      // the parallel's own sentence, with its OCR damage normalised so the words,
      // not its line breaks, are what is being asserted
      const sentence = b.parallel.replace(/[^\w'\s]/g, '').replace(/\s+/g, ' ').trim();
      const found = flattened.replace(/[^\w'\s]/g, '').replace(/\s+/g, ' ').includes(sentence);
      // the reading view's own text at that word
      const shown = applyEditsCounted(b.find, {});
      const view = edits.reduce((t, e) => (e.action === 'leave' ? t : t.split(e.find).join(e.repl)), rawTextAt(b.find) || '');
      check(
        !!rule && rule.repl === b.repl && rule.action !== 'leave' && found,
        `${JSON.stringify(b.find)} -> ${JSON.stringify(b.repl)}: the parallel reads "${b.parallel.slice(0, 44)}..." ` +
          `and the rule records the reading — ${b.why}`,
      );
      check(
        (view || '').length === 0 || !view.includes(b.find),
        `and the reading view does not show ${JSON.stringify(b.find)} (the marker does not survive as a word)`,
      );
      void shown;
    }
  }

  /* (2) THE POLICY IS A POLICY, NOT A LIST OF DELETIONS. checkReadingPolicy walks
     every rule and FAILS on one that resolves a damage character standing INSIDE a
     word by deletion alone. The live rule set passes; the review's own 87 defective
     shapes are used as the asymmetry, so the test is shown to be able to fail. */
  let policyError = null;
  try {
    checkReadingPolicy(edits, SLUG, base);
  } catch (e) {
    policyError = e.message;
  }
  check(policyError === null, `the live rule set records a reading for every word it resolves: ${policyError ? policyError.split('\n')[0] : 'no rule deletes a marker inside a word'}`);
  const DELETING = [
    { find: 'the_jMowers', repl: 'thejMowers', cls: 'reading', note: 'a fixture: the review\'s measured glue' },
    { find: 'pver^wajters', repl: 'pverwajters', cls: 'reading', note: 'a fixture: the review\'s measured glue' },
    { find: 'v^ry', repl: 'vry', cls: 'reading', note: 'a fixture: the review\'s measured non-word' },
  ];
  let caught = null;
  try {
    checkReadingPolicy(DELETING, SLUG, base);
    caught = 'accepted (the policy test is a no-op)';
  } catch (e) {
    caught = e.message;
  }
  check(
    typeof caught === 'string' && caught.includes('without recording a reading') && caught.includes('the_jMowers'),
    `a pure deletion inside a word FAILS the policy test and is named: ${caught.split('\n')[0].slice(0, 110)}`,
  );
  check(
    isPureDeletion('the_jMowers', 'thejMowers') &&
      !isPureDeletion('the_jMowers', 'the powers') &&
      // the SCOPE, stated rather than hidden: a marker at a word's EDGE whose
      // removal IS the printed word is a pure deletion too, and the policy test
      // does not touch it — `_the` -> `the` is in the live rule set and passes.
      isPureDeletion('_the', 'the'),
    'and "pure deletion" means exactly that: the marker dropped, nothing supplied (including at a word\'s edge, where it is allowed)',
  );
  // a LEAVE is not a deletion: it records the decision and spends no bytes
  const leave = edits.filter((e) => e.action === 'leave');
  /* A LEAVE SET MAY BE EMPTY, and that is the good state: a leave records damage
   * whose reading could not be determined, so zero leaves means every damaged
   * place a witness could settle has been settled. The asserts below hold
   * whatever the count — each leave, if there is one, must change nothing and
   * must carry its reason. (MEASURED: this edition's leaves went 2 -> 0 when the
   * destroyed page-break run was reclassified as furniture, page-read.) */
  check(
    leave.length === 0 || leave.every((e) => e.find === e.repl && e.note.length > 0),
    `${leave.length} rule(s) record that a reading is NOT determinable ("leave"), each changing nothing ` +
      `(${leave.map((e) => JSON.stringify(e.find)).join(', ') || 'none — every damaged place is settled'})`,
  );

  /* (3) THE COUNTS, RECOMPUTED HERE from the served text of the READING VIEW:
     how many readings the reading view applies, how many damaged words and how
     many standalone markers it leaves visible, and whether those two classes
     account for every damage character the reading view still shows. FAILS IF the
     document's report and a re-derivation disagree, IF a marker is counted as a
     word (or the reverse), or IF any damage character in the reading view is
     explained by neither class — which is the gap this section exists to catch:
     MEASURED, before it was widened, the document said 2 damaged words while the
     reading view showed 33 damage characters.

     The DOMAIN is recomputed too, not copied: the blocks the app renders in the
     reading view (`Reader.Document.flow` -> FPara from `p`/`verse`, FNote from
     `notedef`), each block corrected on its own, joined as the reader joins them.
     Fails if the extractor counts over a narrower text than the reader is shown
     (the earlier domain was the section-labelled body paragraphs, which left out
     the notes and the unlabelled paragraphs). */
  const readingBlocks = doc.blocks.filter((b) => b.t === 'p' || b.t === 'verse' || b.t === 'notedef');
  const body = readingBlocks.map((b) => b.x.replace(/\n/g, ' ')).join(' ');
  const view = applyEditsCounted(body, doc.corrections.map((c) => ({ find: c.find, repl: c.repl, action: c.action })));
  const leftWords = damageCensus(view, []).words;
  const leftMarkers = markerCensus(view);
  check(
    meta.readings.recorded === edits.filter((e) => e.cls === 'reading').length &&
      meta.readings.applied === meta.readings.recorded &&
      meta.readings.occurrences === doc.corrections.filter((e) => e.cls === 'reading').reduce((a, e) => a + e.hits, 0),
    `every recorded reading fires, and the document says so ` +
      `(${meta.readings.recorded} recorded, ${meta.readings.applied} applied, ${meta.readings.occurrences} occurrence(s))`,
  );
  check(
    meta.leftWordCount === leftWords.length,
    `the damaged WORDS left visible are the recomputed ones (${meta.leftWordCount} stated, ${leftWords.length} recomputed)`,
  );
  check(
    JSON.stringify(meta.leftWords.slice().sort()) === JSON.stringify(leftWords.slice().sort()),
    `and they are named, not merely counted (${meta.leftWords.join(', ')})`,
  );
  check(
    meta.leftMarkerCount === leftMarkers.length &&
      JSON.stringify(meta.leftMarkers.slice().sort()) === JSON.stringify(leftMarkers.slice().sort()),
    `the STANDALONE MARKERS left visible are counted and named apart from the words ` +
      `(${meta.leftMarkerCount} stated, ${leftMarkers.length} recomputed: ${meta.leftMarkers.join(', ')})`,
  );
  check(
    meta.leftWords.every((w) => !leftMarkers.includes(w)) &&
      meta.leftMarkers.every((mk) => !meta.leftWords.includes(mk) && !/[A-Za-z]/.test(mk)),
    `and the two counts are disjoint: no marker is counted as a word, and no word as a marker ` +
      `(a marker is a token with no letter in it — ${meta.leftMarkers.length} marker(s), all letterless)`,
  );
  /* THE ACCOUNTING (fix 3): every damage character the reading view shows stands
     inside one of those words or one of those markers — counted per OCCURRENCE,
     not per distinct token, because `\` occurs three times and `^` twice before the
     reading rule reaches it. FAILS IF a damage character stands in a token that is
     neither (the class the word census could not see), or IF the document's own
     damage-character total is not the one the served text has. */
  const damage = loadBasePolicy().damageList;
  let chars = 0;
  const unexplained = [];
  for (const tok of view.split(/\s+/)) {
    const n = [...tok].filter((c) => damage.includes(c)).length;
    if (n === 0) continue;
    chars += n;
    if (/[A-Za-z]/.test(tok)) {
      const stripped = tok.replace(/^[.,;:?!()"'„“”\[]+/, '').replace(/[.,;:?!()"“”\]|\\]+$/, '');
      if (!leftWords.includes(stripped)) unexplained.push(tok);
    } else if (!leftMarkers.includes(tok)) unexplained.push(tok);
  }
  const rawChars = damageCharCount(body);
  check(
    chars === damageCharCount(view) && chars === meta.leftDamageChars && rawChars > chars,
    `the reading view still shows ${chars} damage character(s) of the ${rawChars} the transcription carries — ` +
      `the document says ${meta.leftDamageChars}, and the rules remove ${rawChars - chars}`,
  );
  check(
    unexplained.length === 0,
    `and every one of those ${chars} characters stands inside one of the ${leftWords.length} damaged word(s) ` +
      `or one of the ${leftMarkers.length} standalone marker(s) — ${unexplained.length} unexplained` +
      `${unexplained.length ? `: ${JSON.stringify(unexplained.slice(0, 6))}` : ''}`,
  );
}

/* ---------- 2c. the front matter is preserved by construction ---------- */

section('no rule touches the front-matter region');
{
  // the region recomputed here AND asserted by the extractor itself
  const front = frontMatterText(doc);
  check(
    front.includes('From the Greeh of Porphyry'),
    'the front matter still carries the reading the title page is cited for ' +
      '("From the Greeh of Porphyry" — the thing the transcription\'s own damage is evidence of)',
  );
  const into = doc.corrections.filter((c) => front.includes(c.find));
  check(into.length === 0, `and no rule's find occurs in it (${into.length} found${into.length ? `: ${into.map((c) => JSON.stringify(c.find)).join(', ')}` : ''})`);
  let real = null;
  try {
    checkFrontMatter(doc);
    real = 'accepted (the assertion is a no-op)';
  } catch (e) {
    real = `threw: ${e.message}`;
  }
  check(
    real === 'accepted (the assertion is a no-op)',
    `the extractor's own front-matter assertion accepts this edition: ${real.slice(0, 60)}`,
  );
  // THE ASYMMETRY, through the extractor's OWN code: the same assertion over a
  // rule that would repair the evidence must fail and name the rule. A fixture
  // that re-stated the assertion would prove only that the fixture can count.
  let bad = null;
  try {
    checkFrontMatter({
      ...doc,
      corrections: [
        ...doc.corrections,
        { find: 'From the Greeh of Porphyry', repl: 'From the Greek of Porphyry', cls: 'reading', note: 'a fixture: this would repair the evidence the reading cites' },
      ],
    });
    bad = 'accepted (the assertion is a no-op)';
  } catch (e) {
    bad = e.message;
  }
  check(
    typeof bad === 'string' && bad.includes('preserved by construction') && bad.includes('From the Greeh of Porphyry'),
    `and a rule that would repair the evidence is refused by that same code: ${bad.split('\n')[0].slice(0, 120)}`,
  );
}

/* ---------- 2d. the titles are the reading's own words ---------- */

section('the section titles are the reading view\'s words, and a damaged one is marked');
{
  const edits = loadEdits(SLUG).edits;
  const apply = (t) => edits.reduce((acc, r) => (acc.includes(r.find) ? acc.split(r.find).join(r.repl) : acc), t);
  const OPENER = /^['\u2018]?(\d{1,2})\.\s/;
  const mine = [];
  for (let i = 0; i < doc.blocks.length; i++) {
    const b = doc.blocks[i];
    if (b.t !== 'sec') continue;
    const body = doc.blocks.slice(i + 1).find((x) => x.t === 'p' || x.t === 'verse');
    const line = body ? body.x.split('\n')[0] : '';
    mine.push({
      n: b.n,
      title: sectionTitle(apply(line).replace(OPENER, '')),
      raw: sectionTitle(line.replace(OPENER, '')),
    });
  }
  check(
    mine.length === doc.toc.length && mine.every((m, i) => m.title === doc.toc[i].title && m.n === doc.toc[i].n),
    `every title is the section's opening words with the rules applied, recomputed here ` +
      `(${mine.filter((m) => m.title !== doc.toc[m.n - 1].title).length} disagreement(s) of ${mine.length})`,
  );
  check(
    mine.every((m, i) => m.raw === doc.toc[i].raw),
    'and every `raw` title is the same words with NO rule applied (the transcription view\'s title)',
  );
  // the flag is a measured statement, recomputed here with the EXTRACTOR's own
  // census (the base policy's measured damage set, not a second regex): a damaged
  // word that no READING rule touches. A `review` rule is a LEAVE, not a reading,
  // so a word it names stays damaged and stays flagged.
  const readings = edits.filter((c) => c.action !== 'leave');
  const mineDamaged = mine.filter((m) => {
    const words = m.raw.replace(/…$/, '').split(' ');
    return words.some(
      (w) => wordDamaged(w) && !readings.some((r) => r.find === w || w.includes(r.find)),
    );
  });
  const docDamaged = doc.toc.filter((t) => t.damaged).map((t) => t.n);
  check(
    JSON.stringify(mineDamaged.map((m) => m.n)) === JSON.stringify(docDamaged),
    `the titles marked damaged are exactly the ones whose damaged words no READING rule repairs ` +
      `(recomputed: ${mineDamaged.map((m) => `§${m.n}`).join(', ')}; the document marks ${docDamaged.map((n) => `§${n}`).join(', ')})`,
  );
  check(
    doc.toc.filter((t) => t.damaged).every((t) => t.damagedWords.length > 0),
    `every marked title names the transcription's own damaged words, so the mark is evidence and not a shrug ` +
      `(${doc.toc.filter((t) => t.damaged).map((t) => `§${t.n}: ${t.damagedWords.join(' ')}`).join('; ') || 'none marked'})`,
  );
  // §11: its opener's damage is a READING (the rule states the print's number), so
  // its title must come out readable and unmarked — the other side of the flag
  const s11 = doc.toc.find((t) => t.n === 11);
  check(
    !s11.damaged && /^Theologists therefore assert/.test(s11.title) && /^\S*[\^_]\S*/.test(s11.raw),
    `§11's title is repaired by its opener rule and NOT marked — the raw form still carries the damage ` +
      `(${JSON.stringify(s11.raw)} → ${JSON.stringify(s11.title)})`,
  );
  /* §2 USED TO BE THE FLAGGED CASE, and it is the policy's own demonstration:
     the print's words there ARE determinable ("The ancients, indeed, very properly
     consecrated a cave to the world", the 1823 parallel), so the policy SUBSTITUTES
     them and the title becomes readable and unmarked. This assertion can fail two
     ways: if a reading rule for those words is dropped (the title goes back to
     carrying damage and is flagged), or if the census stops seeing the damage the
     raw title carried (then the flag would be a lie). */
  const s2 = doc.toc.find((t) => t.n === 2);
  check(
    !s2.damaged && /[\^_]/.test(s2.raw) && s2.title === 'The ancients, indeed…',
    `§2's title is the print's own words, substituted by recorded readings, and NOT flagged ` +
      `(raw ${JSON.stringify(s2.raw)} → ${JSON.stringify(s2.title)})`,
  );
  check(
    doc.toc.every((t) => t.title !== t.raw || !wordDamaged(t.raw)),
    'and no title ships the transcription\'s damaged run as its own title',
  );
  check(
    doc.toc.every((t) => t.title.length > 0 && t.raw.length > 0),
    'and no title is emptied: the flagged entries still carry the reading and the transcription',
  );
}

/* ---------- 3. the notes, and the fitting rule's failability ---------- */

section('25 notes, each defined, each referenced, each resolved');
{
  const live = src.slice(src.indexOf('\nNotes'), src.indexOf('FROM THE GREEK OF PORPHYRY'));
  const defTokens = [...live.matchAll(/^\(([^)\s]{1,3})\)/gm)].map((m) => m[1]);
  const refTokens = [...src.matchAll(/\(note\s+([^)\s]{1,4})\)/g)].map((m) => m[1]);
  check(
    defTokens.length === 25,
    `the transcription carries 25 note definitions in its notes region (${defTokens.length} found)`,
  );
  check(refTokens.length === 25, `and 25 references in the text (${refTokens.length} found)`);
  const defs = doc.blocks.filter((b) => b.t === 'notedef');
  const nums = [...new Set(defs.map((b) => b.n))].sort((a, b) => a - b);
  check(
    nums.length === 25 && nums.every((n, i) => n === i + 1),
    `the document carries all 25 notes, consecutive (${nums.length} distinct, ${defs.length} block(s))`,
  );
  const refs = doc.blocks.filter((b) => b.t === 'ref');
  check(
    new Set(refs.map((r) => r.n)).size === 25,
    `every note is referenced (${new Set(refs.map((r) => r.n)).size} distinct references)`,
  );
  const refTextOk =
    refs.length === refTokens.length &&
    refs.every((r, i) => {
      const want = `(note ${refTokens[i]})`;
      return r.x.startsWith(want) && /^[.,;:!?]*$/.test(r.x.slice(want.length));
    });
  check(
    refTextOk,
    `each reference still carries the transcription's own words beside its number ` +
      `(${JSON.stringify(refs[0].x)} … ${JSON.stringify(refs[refs.length - 1].x)})`,
  );
  check(
    doc.blocks.filter((b) => b.t === 'notedef' && b.n === 6).every((b) => b.lang === 'la'),
    `note (6) is the Latin quotation and says so (${doc.blocks.filter((b) => b.lang === 'la').length} block(s) marked la)`,
  );
  check(
    new Set(doc.blocks.filter((b) => b.lang === 'la').map((b) => b.n)).size === 1,
    'and no other note is marked Latin',
  );

  // the fixtures: the fitting rule is a rule, and it can fail
  // the transcription writes the marker with two spaces after it (its own word
  // spacing), so the fixture must replace the string the file actually holds
  const MARKER = '(_x)'; // a marker of the shape the notes use, and no number
  const N_MARK = '(n)  Hence';
  const broken = src.replace(N_MARK, `${MARKER}  Hence`);
  check(!broken.includes(N_MARK) && broken.includes(MARKER), 'the fixture replaced the one unreadable marker');
  let fitted = null;
  try {
    // a fixture is another edition's bytes, so it is read without the leaf model
    // (which is derived against the stored edition and refuses to be used here)
    const d = extract(broken, { entry: ENTRY, sha256: sha256(broken), leaf: false });
    fitted = [...new Set(d.blocks.filter((b) => b.t === 'notedef').map((b) => b.n))];
  } catch (e) {
    fitted = `threw: ${e.message}`;
  }
  check(
    Array.isArray(fitted) && fitted.length === 25 && fitted[10] === 11,
    `a marker re-spelled as an unknown token still resolves to 11 by the SEQUENCE ` +
      `(not by knowing the string "n"): ${Array.isArray(fitted) ? `${fitted.length} notes, 11th = ${fitted[10]}` : fitted}`,
  );
  const wrong = src.replace(N_MARK, '(9)  Hence');
  check(!wrong.includes(N_MARK) && wrong.includes('(9)  Hence'), 'the fixture made that marker a wrong number');
  let refused = null;
  try {
    extract(wrong, { entry: ENTRY, sha256: sha256(wrong), leaf: false });
    refused = 'accepted (the sequence was not enforced)';
  } catch (e) {
    refused = e.message;
  }
  check(
    typeof refused === 'string' && refused.includes('do not run in order'),
    `and a marker that reads as a WRONG NUMBER fails the extraction: ${refused.slice(0, 120)}`,
  );
}

/* ---------- 4. the page sequence ---------- */

section('the printed pages are monotone, and only the rule refuses');
{
  // recompute every marker, then re-apply the ±1 rule here — over the same
  // lines the extractor reads, i.e. after the library stamp (whose "08" would
  // otherwise read as a bare folio)
  const markers = [];
  for (const ls of rawBlocks(src).slice(doc.dropped.length)) {
    for (const line of ls) {
      const head = runningHead(line);
      const n = head ? normaliseNumber(head.num) : null;
      if (head) markers.push({ raw: line, kind: 'head', value: n ? n.value : null, plain: n ? n.plain : false });
      else {
        const folio = bareFolio(line);
        if (folio) markers.push({ raw: line, kind: 'folio', value: folio.value, plain: folio.plain });
      }
    }
  }
  let last = null;
  const expect = [];
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const next = (() => {
      for (let j = i + 1; j < markers.length; j++) if (markers[j].kind === 'head' && markers[j].value != null) return markers[j].value;
      return null;
    })();
    const ok =
      m.value == null
        ? false
        : m.kind === 'head' && m.plain
          ? last === null || m.value > last
          : m.kind === 'head'
            ? m.value > (last === null ? -Infinity : last) && m.value === (last !== null ? last + 1 : next != null ? next - 1 : m.value)
            : (last !== null && m.value === last + 1) || (last === null && next !== null && m.value === next - 1);
    if (ok) {
      expect.push({ raw: m.raw, page: m.value, how: m.kind === 'head' ? 'head' : 'folio' });
      last = m.value;
    } else {
      expect.push({ raw: m.raw, page: null, how: 'refused' });
    }
  }
  /* The FIRST claim is about the txt-mode document: the phase-1 page model, read
   * again here from the heads and folios alone, with the ±1 rule re-applied. The
   * leaf model must not have rewritten it — it is the thing phase 4 is compared
   * against, and a comparison whose baseline moved measures nothing. */
  const txtPbs = txtDoc.blocks.filter((b) => b.t === 'pb');
  check(
    txtPbs.length === expect.length,
    `the txt-mode document marks every page boundary the transcription carries (${txtPbs.length} of ${expect.length})`,
  );
  check(
    txtPbs.every((b, i) => b.page === expect[i].page && b.how === expect[i].how),
    `each one carries the page and the HOW the rule gives it (${expect.filter((e) => e.page != null).length} numbered, ${expect.filter((e) => e.page == null).length} refused)`,
  );
  check(
    txtPbs.every((b) => b.leaf === undefined),
    'and the txt-mode document names no leaf — there is no leaf model in it to name',
  );

  const pbs = doc.blocks.filter((b) => b.t === 'pb');
  const HOW = new Set(['head', 'folio', 'interpolated', 'leaf', 'refused']);
  check(pbs.every((b) => HOW.has(b.how)), `every pb has a how∈{${[...HOW].join(', ')}}`);
  const numbered = pbs.filter((b) => b.page != null).map((b) => b.page);
  check(
    numbered.every((p, i) => i === 0 || p > numbered[i - 1]),
    `the page sequence is strictly increasing (${numbered[0]}…${numbered[numbered.length - 1]}, ${numbered.length} pages)`,
  );
  check(
    doc.pages.length === pbs.length &&
      doc.pages.every((p, i) => p.page === pbs[i].page && p.how === pbs[i].how && p.leaf === pbs[i].leaf),
    `the page model mirrors the markers — same boundaries, same page, same how, same leaf (${doc.pages.length})`,
  );
  check(
    doc.toc.every((e) => doc.blocks.some((b) => b.t === 'pb' && b.page === e.page)),
    `every contents entry names a page the document actually recovered (${doc.toc.map((e) => e.page).join(', ')})`,
  );
  // the folio-as-heading defect: no block may BE a bare page number
  // the folio-as-heading defect: a FOLIO standing as a heading. An island of
  // digits in the print is a folio only when it is short enough to be one (the
  // bound `bareFolio` uses); the title page's "1917" is the imprint's year and
  // is text, so it is not counted here.
  // skip the library's own marks: its call number carries an "08", which is not
  // the book's folio (the region marks exist so the apparatus is not read as text)
  let reg = null;
  const bare = doc.blocks.filter((b) => {
    if (b.t === 'region') { reg = b.kind; return false; }
    return reg !== 'library' && b.x && b.t !== 'pb' && /^[0-9]{1,3}$/.test(b.x);
  });
  check(bare.length === 0, `no folio stands as a heading of its own (the folio-as-heading defect; ${bare.length} found)`);
}

/* ---------- 4b. the leaf-accurate page model (phase 4) ---------- */

section('every page boundary stands on a leaf, and the three signals are reconciled');
{
  const model = loadDerivs(SLUG, sha256(src));
  if (!model) {
    skip(`no leaf model is stored for ${SLUG} — phase 4 is not in force; make one with node tools/derive.mjs ${SLUG}`);
  } else {
    /* ---- the inventory, ASSERTED against a SECOND reading of the derivatives.
     * derive.mjs parses the item's own files; if they are not on this host (the
     * build does not need them), the artifact's own inventory is checked against
     * the pinned one instead — which is the assertion the phase-4 proof asks for,
     * and it fails if a derivative with a different shape is ever adopted. */
    const facts = ITEM_FACTS[model.item];
    check(!!facts, `the item's inventory is pinned in code (${model.item})`);
    const direct = derivativeFiles(join(process.env.LIBRARY_DERIVS || join(homedir(), 'thework', 'work-derivs'), model.item));
    if (!direct) {
      check(
        model.totals.objects === facts.objects &&
          model.totals.numbered === facts.numbered &&
          model.totals.offset === facts.offset,
        `the artifact's inventory is the pinned one (${model.totals.objects} objects, ${model.totals.numbered} numbered leaves, offset ${model.totals.offset}) — the derivatives themselves are not on this host, so this is the artifact's own record`,
      );
    } else {
      const leaves = parseDjvu(readFileSync(direct.djvu, 'utf8'));
      const pages = readPageNumbers(readFileSync(direct.pages, 'utf8'));
      const sig = pageSignals(src, ENTRY);
      const { table, offset } = leafTable(leaves, pages, sig.flat, model.item);
      check(
        table.length === facts.objects && table.filter((l) => l.page != null).length === facts.numbered && offset === facts.offset,
        `a second reading of the item's own derivatives gives the pinned inventory (${table.length} objects, ${table.filter((l) => l.page != null).length} numbered leaves, offset ${offset}, against the pin ${facts.objects}/${facts.numbered}/${facts.offset})`,
      );
      const same = (l, m2) =>
        ['leaf', 'page', 'conf', 'state', 'start', 'lines', 'words', 'head'].every((k) => JSON.stringify(l[k]) === JSON.stringify(m2[k])) &&
        JSON.stringify(l.num) === JSON.stringify(m2.num);
      const drift = table.filter((l, i) => !same(l, model.leaves[i]));
      check(
        drift.length === 0,
        `and the stored artifact is what those bytes derive (${drift.length} leaf/leaves differ${drift.length ? `, first: ${JSON.stringify(drift[0])}` : ''})`,
      );
    }

    /* ---- THE ALIGNMENT CAN FAIL, proved on the model itself: a model built from
     * other bytes, a model whose line count is not this edition's, a model whose
     * leaf boundary moved, and a model that does not tile the stream must each make
     * the extraction throw rather than place a page boundary at the wrong line.
     * Each of these is the SECOND extraction below, so the passing one above proves
     * the mutations are the difference and not the extraction being broken. */
    const mutant = (over, why) => {
      let got = null;
      try {
        extract(src, { entry: ENTRY, sha256: sha256(src), derivs: over({ ...model }) });
        got = 'accepted (the model is not checked against the edition)';
      } catch (e) {
        got = e.message;
      }
      check(
        typeof got === 'string' && got.includes('node tools/derive.mjs'),
        `${why} FAILS the extraction, naming the command that remakes the model: ${got.split('\n')[0].slice(0, 130)}`,
      );
    };
    mutant((m) => ({ ...m, edition: { ...m.edition, sha256: '0'.repeat(64) } }), 'a model derived from other bytes');
    mutant((m) => ({ ...m, totals: { ...m.totals, lines: m.totals.lines - 1 } }), 'a model whose line count is not this edition’s');
    mutant((m) => ({ ...m, leaves: m.leaves.map((l) => (l.leaf === 13 ? { ...l, head: 'NOT THE LINE THIS LEAF STARTS ON' } : l)) }), 'a model whose leaf boundary lands on another line');
    mutant((m) => ({ ...m, leaves: m.leaves.map((l) => (l.leaf === 20 ? { ...l, start: l.start + 1 } : l)) }), 'a model that does not tile the edition’s line stream');

    /* ---- the alignment is checked against the edition this build reads, which is
     * the artifact's own recorded sha256 — so a stale artifact cannot be used. */
    check(
      model.edition.sha256 === sha256(src),
      `the artifact was derived against this edition (${model.edition.sha256.slice(0, 12)}…)`,
    );
    const lines = pageSignals(src, ENTRY).flat;
    check(model.totals.lines === lines.length, `and its alignment covers the edition's ${lines.length} line(s)`);
    const bad = model.leaves.filter((l) => l.lines > 0 && lines[l.start] !== l.head);
    check(bad.length === 0, `and every leaf's first line is the line at its index (${bad.length} out of step)`);

    /* ---- every marker stands on a leaf, and on the line the leaf gives it ---- */
    const pbs = doc.blocks.filter((b) => b.t === 'pb');
    const byLeaf = new Map(model.leaves.map((l) => [l.leaf, l]));
    check(
      pbs.every((b) => byLeaf.has(b.leaf)),
      `every page marker names a leaf of the volume (${pbs.length} marker(s), ${new Set(pbs.map((b) => b.leaf)).size} distinct leaf/leaves)`,
    );
    check(
      pbs.filter((b) => b.how !== 'head').every((b) => b.leaf != null),
      `and every marker that is not a running head carries one too (${pbs.filter((b) => b.how !== 'head').length} of them)`,
    );
    /* The structural part of the model, as an assertion that can FAIL: inside the
     * numbered span, every leaf that carries text must have a page marker standing
     * on it — the ones the transcription marks with a head or a folio, and the ones
     * it carries no marker for at all, which the leaf structure supplies. A leaf
     * that lost its marker (or gained a second one) fails here. */
    const [lo, hi] = model.totals.span;
    const withText = model.leaves.filter((l) => l.lines > 0 && l.leaf >= lo && l.leaf <= hi);
    const covered = new Set(pbs.map((b) => b.leaf));
    check(
      withText.every((l) => covered.has(l.leaf)),
      `every leaf of the numbered span that carries text has a marker standing on it (${withText.filter((l) => covered.has(l.leaf)).length} of ${withText.length}, leaves ${lo}…${hi})`,
    );

    /* ---- the DIFF against the txt-mode page model: every difference, listed ---- */
    const diff = diffDocs(txtDoc, doc);
    const kinds = {};
    for (const d of diff) kinds[d.kind] = (kinds[d.kind] || 0) + 1;
    const txtPbs = txtDoc.blocks.filter((b) => b.t === 'pb');
    check(
      kinds['pb.leaf'] === txtPbs.length - 1 && kinds['pb.added'] === 1 && kinds['pb.changed'] === 1,
      `the two page models differ in exactly three ways — ${summariseDiff(diff).length} line(s) in the log, ${diff.length} item(s): each txt-mode marker gains its leaf (${kinds['pb.leaf'] || 0}), one boundary is ADDED (${
        kinds['pb.added'] || 0
      }), one marker CHANGES page (${kinds['pb.changed'] || 0})`,
    );
    const added = doc.blocks.filter((b) => b.t === 'pb' && b.how === 'leaf');
    check(
      added.length === 1 && added[0].page === null && added[0].leaf === 28,
      `the added boundary is leaf 28, the page whose running head the transcription does not have — UNNUMBERED (${JSON.stringify(added[0])})`,
    );
    const changed = pbs.find((b) => b.by === 'leaf');
    check(
      changed && changed.page === 43 && changed.leaf === 49 && changed.how === 'folio' && changed.x === '43',
      `the changed marker is the folio "43" at the foot of leaf 49, which the stride rule refused and the leaf confirms (${JSON.stringify(changed)})`,
    );

    /* ---- the reconciliation, recomputed here from the artifact and the text ---- */
    const rows = agreementRows(model);
    const verdicts = {};
    for (const r of rows) verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;
    check(
      (verdicts.disagree || 0) === 0,
      `the two sources agree wherever both have a number — ${rows.length} row(s): ${Object.entries(verdicts).map(([k, v]) => `${v} ${k}`).join(', ')}`,
    );
    check(
      rows.every((r) => r.read == null || r.leafPage == null || r.read.page === r.leafPage || r.verdict === 'disagree'),
      'and no row pairs a reading with a different number without saying so',
    );
    const served = new Set(pbs.filter((b) => b.page != null).map((b) => `p${b.page}`));
    check(
      served.has('p43') && !served.has('p22') && !served.has('p42'),
      `the numbers served are the ones a source READ: page 43 is served, and pages 22 and 42 — which the item's own pass fills in from the leaves around them and nothing on the leaf reads — are NOT`,
    );
    check(
      doc.blocks.filter((b) => b.t === 'pb' && b.page == null).length === 2,
      'two markers remain unnumbered: the transcription\'s own refused "3", and the boundary at leaf 28',
    );

    /* ---- every page finding is in the document, and the diff is accounted for ---- */
    const findings = doc.findings.join('\n');
    check(
      findings.includes('leaf 49') && findings.includes('leaf 28') && findings.includes('line 29 of 29 of leaf 39'),
      'the three page cases are recorded as findings in the document itself (the folio the leaf confirms, the boundary with no head, the damaged folio the leaf refuses)',
    );

    /* ---- the ARTIFACT CANNOT BE LOST QUIETLY. The manifest records that its page
     * anchors came from a leaf model, so an extraction without one fails instead of
     * reporting p43 as a dropped anchor and inviting a re-pin that would drop it. */
    check(
      JSON.parse(readFileSync(anchorPath(SLUG), 'utf8')).model != null,
      'the pinned manifest records that its page anchors came from a leaf model',
    );
    const tmp2 = mkdtempSync(join(tmpdir(), 'anchors-model-'));
    const tmpManifest2 = join(tmp2, 'pinned.json');
    copyFileSync(anchorPath(SLUG), tmpManifest2);
    let guard = null;
    try {
      checkAnchors(txtDoc, tmpManifest2);
      guard = 'accepted (the guard is a no-op)';
    } catch (e) {
      guard = e.message;
    }
    check(
      typeof guard === 'string' && guard.includes('leaf-accurate page model') && guard.includes(`derive.mjs ${SLUG}`),
      `a leaf-model manifest with a txt-mode extraction FAILS, naming the command that restores the model: ${guard.split('\n')[0].slice(0, 140)}`,
    );
    check(statSync(tmpManifest2).size === statSync(anchorPath(SLUG)).size, 'and that path does not rewrite the manifest either');
    rmSync(tmp2, { recursive: true, force: true });
  }
}

/* ---------- 5. the anchors ---------- */

/* ---------- the damage set is per-text ---------- */

section('the damage set is measured per edition');
{
  /* THE BASE SET IS MEASURED ON THE CAVE, and the policy says measured, not
   * guessed. A second edition measures its own: the 1816 Proclus prints `*` as a
   * footnote marker the scanner glues to the word (`four*`, `light*`) and `&` as
   * an ampersand (`&c.`), so neither is damage there. A text declares what its
   * print sets (TEXT_RULES `damageExclude`) and the document ships the effective
   * set, which is what the reader marks against.
   * FAILS IF: the declaration stops reaching the document (footnote markers are
   * counted as damage and marked red again), or it leaks into another text. */
  const base = loadBasePolicy();
  const pro = readExistingEdition(PROCLUS_SLUG);
  const proEntry = TEXTS.find((t) => t.slug === PROCLUS_SLUG);
  const proDoc = extract(pro, { entry: proEntry, sha256: sha256(pro) });
  check(
    !proDoc.damage.includes('*') && !proDoc.damage.includes('&') && proDoc.damage.includes('^'),
    `the Proclus edition's damage set excludes its print's own characters (${JSON.stringify(proDoc.damage)})`,
  );
  check(
    proDoc.damage.length === base.damage.length - 2 && proDoc.damage !== base.damage,
    'and it is the base set minus exactly what the text declares',
  );
  // the CAVE declares nothing, so its set is the base's, character for character
  const caveDoc = doc;
  check(
    caveDoc.damage === base.damage,
    `and a text that declares nothing carries the base set unchanged (${JSON.stringify(caveDoc.damage)})`,
  );
  // the census uses the EDITION's set: a lone '*' is not damage for Proclus
  check(
    markerCensus('the word * stands alone', proDoc.damage).length === 0 &&
      markerCensus('the word * stands alone', base.damage).length === 1,
    'and the census counts a standalone asterisk as damage for the Cave and not for Proclus',
  );
}

section('the notes and the back matter are not the body');
{
  // The review found three symptoms of ONE region bug: the boundary never fired
  // (the plan's rule matched a phrase the title page OCRs differently), so note
  // (25) swallowed the colophon and the list's opening, and the notes and the back
  // matter claimed section-18 paragraph anchors. The back of the volume is now in
  // its three real parts (the printer's colophon, the publisher's list, the
  // library's own marks), each named for what it is.
  const regions = doc.blocks.filter((b) => b.t === 'region').map((b) => b.kind);
  check(regions.join(' ') === 'library front body notes colophon end library',
    `the volume's regions are all present, in order (${regions.join(' ')})`);

  let region = null, outside = 0, verseOutside = 0;
  for (const b of doc.blocks) {
    if (b.t === 'region') region = b.kind;
    else if (b.at && region !== 'body') outside++;
    if (b.t === 'verse' && region !== 'body') verseOutside++;
  }
  check(outside === 0, `no block outside the body claims a paragraph anchor (${outside} found)`);
  check(verseOutside === 0, `no verse block outside the body (${verseOutside} found)`);

  const n25 = doc.blocks.filter((b) => b.t === 'notedef' && b.n === 25);
  check(n25.length === 1 && /The anger of the Gods/.test(n25[0].x),
    `note 25 is its own paragraph, not the colophon and the catalogue (${n25.length} block(s))`);

  // The plain text is emitted by the build; a check needing the emitted files
  // skips rather than failing when the tree has not been built yet.
  const plainPath = join(ROOT, 'site', 'dist', 'texts', SLUG, 'plain');
  if (!existsSync(plainPath)) {
    check(true, 'the plain text is not built — run node build/build.mjs first (skipped)');
  } else {
    const plain = readFileSync(plainPath, 'utf8');
    const inPlain = (plain.match(/\(note /g) || []).length;
    check(inPlain === 25,
      `the plain text carries all 25 note references (${inPlain}; it dropped every one before)`);
  }

  const manifest = JSON.parse(readFileSync(anchorPath(SLUG), 'utf8'));
  check(Array.isArray(manifest.refs) && manifest.refs.length === 25,
    `the pinned manifest covers the return anchors too (${manifest.refs && manifest.refs.length} r<n>)`);
}

section('the anchors are pinned, and a deliberate move fails');
{
  const lists = anchorLists(doc);
  const hash = anchorHash(lists);
  const pinned = JSON.parse(readFileSync(anchorPath(SLUG), 'utf8'));
  check(
    pinned.hash === hash && JSON.stringify(pinned.sections) === JSON.stringify(lists.sections),
    `the committed manifest is this document's anchor list (${lists.sections.length} sections, ` +
      `${lists.pages.length} pages, ${lists.notes.length} notes, hash ${hash.slice(0, 12)}…)`,
  );
  // the fragment grammar, materialised in the artefact that serves it
  const ids = doc.blocks.filter((b) => b.id).map((b) => b.id);
  check(new Set(ids).size === ids.length, `no two blocks claim one anchor (${ids.length} anchors, ${new Set(ids).size} distinct)`);
  const nums = (re) => ids.filter((x) => re.test(x)).length;
  check(
    [...Array(18)].every((_, i) => ids.includes(`s${i + 1}`)) &&
      nums(/^p\d+$/) === 52 &&
      [...Array(25)].every((_, i) => ids.includes(`n${i + 1}`) && ids.includes(`r${i + 1}`)),
    `the grammar #s<n>/#p<n>/#n<n>/#r<n> is carried (${nums(/^s/)} s, ${nums(/^p/)} p, ${nums(/^n/)} n, ${nums(/^r/)} r) — 52 printed-page anchors, one more than the 51 the transcription alone reads`,
  );
  /* THE MIGRATION THAT PHASE 4 FORCED, asserted rather than remembered: the leaf
   * model confirms the folio "43" that the ±1 stride rule had refused, so the
   * printed-page anchor set GAINS p43. Nothing that was pinned may be dropped or
   * moved by that — an added anchor cannot rot a link, a dropped one does — so the
   * page anchors the txt-mode document serves must all still be here, and the one
   * addition must be named. */
  const txtPages = anchorLists(txtDoc).pages;
  check(
    txtPages.every((id) => lists.pages.includes(id)) && txtPages.length === 51,
    `no printed-page anchor the txt-mode page model served has moved or been dropped (${txtPages.length} pinned then, all still carried)`,
  );
  check(
    lists.pages.filter((id) => !txtPages.includes(id)).join(',') === 'p43',
    'and exactly one was added: p43, the folio the leaf model confirms',
  );
  check(
    [...lists.sections, ...lists.pages, ...lists.notes, ...lists.regions].every((id) => ids.includes(id)),
    `every anchor the manifest pins is carried by a block (${lists.sections.length + lists.pages.length + lists.notes.length + lists.regions.length} pinned)`,
  );
  check(
    doc.blocks.filter((b) => b.t === 'ref').every((b) => /^s\d+-\d+$/.test(b.at)),
    `every reference is anchored to its section and paragraph, never to a page (${doc.blocks.filter((b) => b.t === 'ref')[0].at}…)`,
  );
  const before = statSync(anchorPath(SLUG)).size;

  // a mutation that moves an anchor: the head of page 49 removed
  const mut = src.replace('ON  THE  CAVE  OF  THE  NYMPHS     49 \n', '');
  check(mut.length < src.length, 'the fixture removed one running head');
  /* The fixture is a DIFFERENT edition (its bytes are not the stored edition's), so
   * the model derived from the stored edition does not apply to it and the
   * extraction says so; this test is about the ANCHOR GATE, and the gate is the
   * same gate in both modes, so the fixture is read without the leaf model. */
  const movedDoc = extract(mut, { entry: ENTRY, sha256: sha256(mut), leaf: false });
  const tmp = mkdtempSync(join(tmpdir(), 'anchors-'));
  const tmpManifest = join(tmp, 'pinned.json');
  /* The copy drops the `model` record on purpose: this test is about a MOVED
   * anchor, and a leaf-model manifest with a fixture edition fires the phase-4
   * guard first (which has its own test above). The gate's own behaviour is the
   * same either way; only which failure comes first differs. */
  const pinnedCopy = JSON.parse(readFileSync(anchorPath(SLUG), 'utf8'));
  delete pinnedCopy.model;
  writeFileSync(tmpManifest, `${JSON.stringify(pinnedCopy, null, 2)}\n`);
  let gate = null;
  try {
    checkAnchors(movedDoc, tmpManifest);
    gate = 'accepted (the gate is a no-op)';
  } catch (e) {
    gate = e.message;
  }
  check(
    typeof gate === 'string' && gate.includes('p49') && gate.includes('anchors moved'),
    `a moved anchor FAILS the gate, naming it: ${gate.split('\n').slice(0, 2).join(' / ').slice(0, 140)}`,
  );
  check(
    gate.includes('delete') && gate.includes('build again') && gate.includes('alias'),
    'and the failure carries the migration instructions',
  );
  check(
    statSync(anchorPath(SLUG)).size === before,
    'the gate did not write over the pinned manifest',
  );

  // a mutation that breaks the division sequence: the gate for §2's opener
  const bad = src.replace('2.  Thp_anrt', '5.  Thp_anrt');
  let seq = null;
  try {
    extract(bad, { entry: ENTRY, sha256: sha256(bad), leaf: false });
    seq = 'accepted (the sequence is not enforced)';
  } catch (e) {
    seq = e.message;
  }
  check(
    typeof seq === 'string' && seq.includes('divisions do not run 1…18'),
    `a division out of sequence fails the extraction: ${seq.slice(0, 120)}`,
  );
  rmSync(tmp, { recursive: true, force: true });
}

/* ---------- 6. the emitted files ---------- */

section('the document and the plain text are emitted, and leak nothing');
{
  const docFile = join(DIST, 'texts', SLUG, 't');
  const plainFile = join(DIST, 'texts', SLUG, 'plain');
  if (!existsSync(docFile)) {
    skip('the tree is not built — run node build/build.mjs to check the two emitted files');
  } else {
    const tText = readFileSync(docFile, 'utf8');
    const pText = readFileSync(plainFile, 'utf8');
    check(
      tText === serialiseDoc(doc),
      `the emitted document is what the extractor produces now (${Buffer.byteLength(tText)} bytes)`,
    );
    check(
      pText === plainText(doc, ENTRY),
      `the emitted plain text is what the extractor produces now (${Buffer.byteLength(pText)} bytes)`,
    );
    // NO RAW-BYTE BUDGET. `/t` and `/plain` are static assets with their own fetch,
    // gzipped by Caddy; the felt cost is the WIRE size (~35 KB / ~25 KB gz, measured
    // below), not the on-disk bytes. A raw-byte cap was a draft-era estimate (plan §8,
    // "~100 KB raw est.") that predated the decision to serve every repair's provenance
    // to the reader — and it therefore bound on that provenance, whose cheapest
    // satisfaction is to hide it. The document is large because it is auditable.
    check(!/\.(?:json|txt|mjs)$/.test(docFile.replace(DIST, '')), `the documents' name carries no extension (${docFile.slice(DIST.length + 1)})`);

    // an INDEPENDENT leak list, not the build's (see library-smoke for the same
    // reasoning): a test that asks the build what a leak is proves only that the
    // build is self-consistent
    const BANNED = [
      [/(?:^|["'\s(])(?:~|\/home\/[a-z])\/[\w./-]+/, 'local filesystem path'],
      [/\b[\w.-]+\.(?:txt|mjs|json)\b(?=[\s"',.)]|$)/, 'source-file name'],
      [/\btools\/(?:build|viz|check-scope)[\w./-]*/, 'internal path'],
      [/\bthe scan\b|\bthe brief\b|\bthe manifest\b|\bthe plumbing\b|\bthe corpus\b|\bthe extract\b/i, 'workshop wording'],
      [/\b\d[\d,]{2,}\s*(?:bytes|KB|MB)\b/i, 'file size'],
      [/\b\d[\d,]{3,}\s+characters\b/, 'character count'],
      [/\/\*\s*[-=]*\s*[a-z]/i, 'a comment delimiter in emitted code'],
      [/^\s*\/\/\s/m, 'a line comment in emitted code'],
    ];
    const bad = [];
    for (const [name, text] of [['t', tText], ['plain', pText]]) {
      for (const [re, what] of BANNED) {
        const m = re.exec(text);
        if (m) bad.push(`${name}: ${what}: ${JSON.stringify(text.slice(Math.max(0, m.index - 40), m.index + 40))}`);
      }
    }
    check(bad.length === 0, `neither file carries an internal path, a source filename or workshop wording${bad.length ? `\n       ${bad.join('\n       ')}` : ''}`);
    let parsed = true;
    try {
      JSON.parse(tText);
    } catch {
      parsed = false;
    }
    check(parsed, 'the document parses as JSON');
    check(
      pText.includes(ENTRY.edition) && pText.includes('[s1]') && pText.includes('[p58]'),
      'the plain text carries the edition, the division markers and the page markers',
    );
  }
}

/* ---------- 7. the stored edition and the importer ---------- */

section('the edition in the repo is the shelf file, and cannot be silently replaced');
{
  const record = JSON.parse(readFileSync(importPath(SLUG), 'utf8'));
  check(hasEdition(SLUG) && sha256(src) === record.sha256, `the stored edition is the one the import recorded (${record.sha256.slice(0, 12)}…)`);
  check(
    Buffer.byteLength(src, 'utf8') === record.bytes,
    `and its length is the length that was recorded (${Buffer.byteLength(src, 'utf8')} bytes; ` +
      `the file is not ASCII, so this is bytes and not characters)`,
  );
  check(record.shelf === 'Porphyry-On-the-Cave-of-the-Nymphs-Taylor-1917.txt', `the import names the shelf file it came from (${record.shelf})`);
  check(/^\d{4}-\d{2}-\d{2}$/.test(record.imported), `and the day it was imported (${record.imported})`);
  if (existsSync(join(SHELF, record.shelf))) {
    const shelfFile = readFileSync(join(SHELF, record.shelf), 'utf8');
    check(
      sha256(shelfFile) === record.sha256,
      'the shelf file and the stored edition are the same bytes',
    );
  } else {
    skip(`the shelf is not at ${SHELF} — the build does not need it for this text, and the cross-check is skipped`);
  }
  // the importer must refuse a changed shelf file, in a shelf of its own
  const tmp = mkdtempSync(join(tmpdir(), 'shelf-'));
  const name = record.shelf;
  const text = readExistingEdition(SLUG);
  writeFileSync(join(tmp, name), `${text}\nextra line\n`);
  let out = '';
  let failed = false;
  try {
    execFileSync(process.execPath, [join(ROOT, 'tools', 'extract.mjs'), '--import', SLUG], {
      env: { ...process.env, LIBRARY_SHELF: tmp },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (e) {
    failed = true;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  check(
    failed && out.includes('changed since this edition was imported'),
    `re-importing a changed shelf file FAILS loudly: ${out.split('\n').find((l) => l.includes('changed since')) || out.slice(0, 100)}`,
  );
  check(
    readExistingEdition(SLUG) === text,
    'and the stored edition on disk was NOT overwritten',
  );
  rmSync(tmp, { recursive: true, force: true });
}

/* ---------- what the run measured ---------- */

section('measured');
{
  console.log(
    `  document: ${recount.blocks} block(s) — ` +
      `${recount.sections} sections, ${recount.notes} notes, ${recount.refs} references, ` +
      `${recount.pages.detected} page number(s) read (${recount.pages.folio} from a bare folio), ` +
      `${recount.pages.refused} refused, ${recount.pages.interpolated} interpolated`,
  );
  console.log(`  blocks by type: ${Object.entries(recount.byType).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  console.log(
    `  corrections: ${Object.entries(recount.corrections).map(([k, v]) => `${v} ${k}`).join(', ')}` +
      `, every one firing (${Object.entries(recount.correctionHits).map(([k, v]) => `${v} ${k}`).join(', ')} application(s))` +
      `, ${doc.correctionsMeta.unrepairedWords} damaged word(s) no rule names`,
  );
  console.log(`  regions: ${recount.regions.join(' → ')}`);
  console.log(
    `  size: /t ${Buffer.byteLength(serialiseDoc(doc))} bytes raw, /plain ${Buffer.byteLength(plainText(doc, ENTRY))} bytes raw, ` +
      `stored edition ${Buffer.byteLength(src, 'utf8')} bytes`,
  );
  const gz = (await import('node:zlib')).gzipSync;
  console.log(
    `  gzipped as served: /t ${gz(Buffer.from(serialiseDoc(doc))).length} bytes, ` +
      `/plain ${gz(Buffer.from(plainText(doc, ENTRY))).length} bytes, ` +
      `stored edition ${gz(Buffer.from(src)).length} bytes`,
  );
}

console.log(
  failures === 0
    ? `\nlibrary-extract-smoke: all checks passed${skipped ? ` (${skipped} skipped)` : ''}`
    : `\nlibrary-extract-smoke: ${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
