/**
 * build/library.mjs — the library's rendering, lifted out of the blog build and
 * adapted to the standalone site (extraction plan §1.3).
 *
 * What came over from tools/build.mjs: DAMAGED_TITLE, LIBRARY_MAX_BYTES,
 * measureDamage, editionHtml, provenanceHtml, unreadableHtml, READER_CSS,
 * READER_BOOT, readerBundle, citationFields, readerTocHtml, readerSectionHtml,
 * readerShell and logPageModel — the apparatus pages and the reader shell.
 *
 * WHAT WAS CUT (plan §1.3, "the citation coupling, cut"): `libraryCitations`,
 * `citations`, `catalogue`, `footnoteDefs`, `sourceGraph`, `mapGraph` all stay
 * behind on the blog. "Where it is cited" is no longer derived at build time
 * from the posts' footnotes; it renders `edition.readings[]` — the hand-seeded
 * list of blog slugs in the edition record (model §6) — as links out to the
 * blog, with the honest empty state. The build therefore never reads a blog
 * post, and never fetches anything.
 *
 * WHAT WAS DROPPED: pandoc and `checkFootnotes` (the library renders zero
 * markdown through pandoc, plan §1.3), `checkLinks`/`POST_META` (blog posts),
 * and the blog's series nav.
 *
 * The base URL of a page and of a version is a PARAMETER here: the same
 * rendering produces `/texts/<slug>/` (current_version) and
 * `/texts/<slug>/v/<semver>/` (pinned), which is what makes an old citation keep
 * resolving after a new version ships (model §3.1, plan §4).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  extract,
  counts,
  readEdition,
  loadDerivs,
  sha256,
  diffDocs,
  summariseDiff,
} from '../tools/extract.mjs';
import { preprocess, renderBlocks, partition, assess, countParagraphs } from '../tools/reader.mjs';
import { MODERN_EDITIONS, REPAIR_LABELS, repairOf } from '../tools/shelf.mjs';
import { agreementRows, printAgreement } from '../tools/derive.mjs';
import { esc, section, toc, stripComments, SITE, BASE, ROOT } from './shell.mjs';
import { gateSafeText, stripJsComments } from './leak.mjs';
/* The four repair types (model §4.1) and the apparatus data-file builder, from
 * ONE module: the file's counts and the page's filter cannot come from two
 * lists. */
import { APPARATUS_TYPES, apparatusData, LEAF_FILE } from './apparatus.mjs';

const log = (msg) => console.log(`[build] ${msg}`);

const DAMAGED_TITLE = '[the opening words are damaged in this transcription]';


/**
 * THE PAGE BUDGET, and the PROSE it leaves for the text.
 *
 * `LIBRARY_PAGE_MAX_BYTES` is the size a single library page may not exceed —
 * the page a reader on a slow link actually waits for. `library-smoke` asserts
 * it, and it reads THIS constant (one source of truth). A text whose prose does
 * not fit is served in PARTS, split where the edition itself divides; nothing is
 * ever split mid-paragraph.
 *
 * The prose budget is NOT the page budget: the reader page inlines the whole
 * transcription (the copy a reader without scripts gets) BESIDE the compiled
 * reader app and the site's own chrome. MEASURED (2026-10-05, the largest page
 * the build emits): the page is 2,180,490 bytes and its prose is 1,784,122, so
 * the fixed chrome — the reader app, its stylesheet, the apparatus statement and
 * the provenance block — is 396,368 bytes. The old constant was 1,800,000, which
 * is prose-only: a text just under it produced a page just OVER the cap, and the
 * two numbers could not both hold. Subtracting the chrome is what makes them
 * agree. Taylor's Theology of Plato is the first text in the library to reach
 * the budget; it is served in parts, with the reader app on the parent page.
 */
export const LIBRARY_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const LIBRARY_CHROME_BYTES = 400000;
const LIBRARY_MAX_BYTES = LIBRARY_PAGE_MAX_BYTES - LIBRARY_CHROME_BYTES;

/** The extracted DOCUMENT of a stored edition, by slug, so the text's page and
 * the document it serves are built from ONE extraction: two extractions of the
 * same bytes would be two chances to disagree about the same book. */
const editionDocs = new Map();

/** Files the build writes that are neither pages nor discovery files, but must
 * pass the workshop leak gate all the same (the fetched search half). */
const gatedFiles = [];

/** The provenance block: the edition, what was done to the text, where it is
 * cited. Required on every page — an unedited transcription that does not say
 * it is unedited, and does not say what was done to it, is not honest about
 * itself. */
/** What a reader of THIS transcription will actually SEE, measured on the source
 * text rather than described in general terms. The library's whole claim is that
 * a reader can trust where a text came from and what was done to it; a page that
 * silently carries OCR damage while naming only the damage that is easy to
 * explain is not keeping that claim. Counts only — nothing is repaired. */
function measureDamage(src, doc) {
  const notSign = (src.match(/\u00ac/g) || []).length;
  const longS = (src.match(/\u017f/g) || []).length;
  // a word whose first letter is 'f' where the print had a long s reads as a
  // substitution ("firft" for "first"); counting words that mix 'f' with a 't'
  // gives a floor on that class without claiming to repair it
  const fConfusions = (src.match(/\b[A-Za-z]*f[A-Za-z]*t[A-Za-z]*\b/g) || []).length;
  const heads = doc && doc.blocks ? doc.blocks.filter((b) => b.type === 'heading') : [];
  const folios = heads.filter((h) => /^[0-9]{1,4}[.,]?$/.test(String(h.text || '').trim())).length;
  return { notSign, longS, fConfusions, folios, headings: heads.length };
}

/**
 * The edition's provenance (plan §7): every number in it MEASURED on the document
 * that is served, and none of them a description. It states
 *
 *   - that this is a transcription of a named edition, and that the transcription
 *     is uncorrected while the reading view is produced by rules;
 *   - the pagination: how many printed page numbers were READ, how many came from
 *     a bare folio (the head's words are gone), how many were interpolated
 *     between two numbered leaves, and how many markers were REFUSED a number;
 *   - that the contents list is generated, because the print has none, and that a
 *     title the transcription damaged beyond repair is stated as a gap;
 *   - the notes: every one defined and every reference resolved;
 *   - the correction classes and their counts, and how many times the rules fire
 *     in the served text, each rule inspectable in the reader's own repairs list.
 *
 * No internal name, path or file size is printed: the counts are of the text, and
 * the text is what a reader can check them against.
 */
function editionHtml(t, lib, base) {
  const m = lib.correctionsMeta || {};
  const cls = m.classes || {};
  const hits = m.hits || {};
  const damagedTitles = m.damagedTitles || [];
  const p = [];
  p.push(
    `<p><b>The edition this page carries.</b> The same text is served here as an ` +
      `edition rather than only as prose: <a href="${base}t">the document</a> holds its ` +
      `${lib.sections} numbered sections, the ${lib.pages.detected} printed page numbers recovered ` +
      `from the volume’s own running heads and bare folios — ${lib.pages.folio} of them from a bare ` +
      `folio whose head’s words are gone, ${lib.pages.interpolated} interpolated between two ` +
      `numbered leaves, and ${lib.pages.refused} marker(s) left UNNUMBERED because no number could ` +
      `be read there — its ${lib.notes} notes, every one of them defined with each of its ` +
      `${lib.refs} references resolved in both directions, and ` +
      `<a href="${base}plain">the whole text as one plain file</a> for reading without ` +
      `scripts and for citing. The words served are the transcription, uncorrected; the repairs ` +
      `travel as rules rather than as a second text, so the difference between the two is a list ` +
      `anyone can read against the words that are served.</p>`,
  );
  /* THE PAGE MODEL, from measured counts (plan §4.6, phase 4). What the page
   * numbers now rest on is the volume's own leaves, and the page the leaves add
   * to what the text could read is the one case where the two modes differ about
   * a number — so it is stated, not left to be inferred from a lighter marker. */
  const leaf = lib.leaf && lib.leaf.model ? lib.leaf : null;
  if (leaf) {
    const n = leaf.model;
    p.push(
      `<p><b>The pages are placed on the volume’s own leaves.</b> Every page marker above stands on the ` +
        `leaf of the volume it was printed on, so a citation by printed page names the leaf as well as the ` +
        `number, and a page ends where the volume’s page ends rather than where a paragraph did. ` +
        `${n.leaves} leaves are accounted for: ${n.withText} of them carry a page of this transcription, ` +
        `${n.numbered} carry a printed number — ${n.detected} of those read from the leaf itself and ` +
        `${n.interpolated} filled in from the leaves on either side of it — and ${n.leaves - n.numbered} ` +
        `carry none at all, which is what the front and the back of a book look like. Every numbered leaf ` +
        `sits at the same distance from its printed page (${Math.abs(n.offset)} leaves — a constant, which is ` +
        `what lets a leaf confirm a page number instead of the number being taken on trust). The volume’s own ` +
        `heads and bare folios ` +
        `read the ${lib.pages.detected} printed numbers this document shows` +
        (n.agreed != null
          ? `; the leaves’ own page numbering reads ${n.numbered}, and on all ${n.agreed} pages the two both ` +
            `have they are the same page`
          : '') +
        (n.textOnly
          ? `; on ${n.textOnly} leaf/leaves the transcription reads a number the leaves’ own numbering does not ` +
            `have, and the transcription’s reading is the one shown`
          : '') +
        (n.leafOnly
          ? `; on ${n.leafOnly} leaf/leaves the leaves’ numbering has one that nothing on the leaf reads, and ` +
            `no number is shown for them`
          : '') +
        (n.disagreed
          ? `; on ${n.disagreed} page(s) the two sources give different numbers — the transcription’s own ` +
            `reading is the one shown, and the difference is a finding about one of the two rather than ` +
            `something to average away`
          : '') +
        `. ` +
        (leaf.reread
          ? `${leaf.reread} page the arithmetic of the text alone had refused is confirmed by its leaf and ` +
            `carries its number here: a folio printed at the foot of a leaf whose own division opens on it, ` +
            `which the text’s rule could not place because the leaf before it carries no text and so no marker. `
          : '') +
        (leaf.structural
          ? `${leaf.structural} page boundary stands where a leaf begins with no number shown, because ` +
            `nothing on that leaf reads as one: the page whose running head the transcription does not have is ` +
            `named by its leaf and left unnumbered rather than given a number from the leaves around it. `
          : '') +
        `${lib.pages.refused} page marker(s) the transcription itself carries remain UNNUMBERED, and the ` +
        `volume’s own words for them stand beside the marker.</p>`,
    );
  }
  p.push(
    `<p><b>The contents list is generated.</b> The printed volume has no contents page — nothing ` +
      `stands between its title page and its first division — so the ${lib.sections} entries above ` +
      `are generated from the divisions the edition itself makes, each titled with its own opening ` +
      `words and each carrying the printed page it opens on. ` +
      (damagedTitles.length
        ? `The opening words of ${damagedTitles.length} of those divisions are damaged in the ` +
          `transcription by more than the repairs can restore, and those entries state the gap ` +
          `instead of showing damaged words as a title: the transcription’s own words stand beside ` +
          `the entry, and no title is invented for it.`
        : `No division’s opening words are damaged in the transcription, so every title above is the ` +
          `division’s own words.`) +
      `</p>`,
  );
  /* A VERSION WITH NO RULES. `cls.opener` and its neighbours are all 0, so this
   * paragraph would read "0 for the divisions, 0 for the numbers … every rule
   * firing at least once" of no rules. An edition published in repair, whose
   * first emendation has not been made, gets the paragraph that says so — and
   * the damage counts, which need no rule, are the same either way. */
  if (!Object.values(cls).some((n) => n)) {
    p.push(
      `<p><b>No repairs recorded yet.</b> This version carries NO repair rules: the reading view and the ` +
        `transcription view are the same text, because no emendation has been made. Nothing is hidden either — ` +
        `every damaged character the scanner left stands visible in the reading view, MARKED as damage so a ` +
        `reader can see it is the scanner’s and not the author’s, and no word is silently corrected. ` +
        `The damage that stands is counted in TWO classes, stated apart because they are different things: ` +
        `<b>${m.leftWordCount} damaged word(s)</b> the transcription carries, and <b>${m.leftMarkerCount} ` +
        `standalone marker(s)</b> — one or more damage characters standing as their own token BETWEEN words ` +
        `(a lost space, or the scanner’s debris) — which are NOT words and are not counted as any. Between ` +
        `them they account for every one of the ${m.leftDamageChars} damage character(s) the text shows over ` +
        `the stretch the reading view renders (the note definitions and the unlabelled paragraphs included). ` +
        `Each emendation will be recorded here as a rule — the words it changes, why, and the page image it was ` +
        `decided from — as it is made. The policy, once rules are written, is: a recorded reading is ` +
        `substituted, and where none is recorded the transcription’s own characters stay.</p>`,
    );
    return p.join('');
  }
  p.push(
    `<p><b>The repairs, as rules.</b> Every repair the reading view makes is a recorded rule applied ` +
      `to the transcription’s own words — ${cls.opener} for the divisions, ` +
      `${cls.digit} for the numbers and note markers the transcription wrote through an OCR digit ` +
      `confusion, and ${cls.reading} for the damaged words whose reading this edition RECORDS (${hits.reading} ` +
      `applications in this text) — ` +
      `${Object.values(hits).reduce((a, b) => a + b, 0)} applications of those rules in all, ` +
      `each rule firing at least once (a rule that fires nowhere is caught before this page is ` +
      `produced, not shipped as machinery nothing reads). The reader’s own list of repairs shows each rule, the words it ` +
      `changes, why, and how many times it fires — that list IS the difference between the two ` +
      `views, so the repairs can be checked against the transcription word by word. ` +
      `<b>The policy is: a recorded reading is substituted, and where none is the transcription’s own ` +
      `characters stay.</b> The reading view therefore shows the print’s word where one is recorded and ` +
      `the transcription’s damage where none is, and that surviving damage is counted in TWO classes, ` +
      `stated apart because they are different things: ` +
      `<b>${m.leftWordCount} damaged word(s)</b> no rule resolved, shown with the damage still in them and ` +
      `named in the reader’s repairs list under “damaged words left visible”, and ` +
      `<b>${m.leftMarkerCount} standalone marker(s)</b> — one or more damage characters standing as their ` +
      `own token BETWEEN words (a lost space, or the scanner’s debris) — which are NOT words and are not ` +
      `counted as any. Between them they account for every one of the ` +
      `${m.leftDamageChars} damage character(s) the reading view still shows, over the text the reading ` +
      `view renders (the note definitions and the unlabelled paragraphs included). ` +
      `Every one is marked, so a reader can see that it is damage and not a typo by the author. ` +
      `Where a reading is not determinable from this transcription, a rule records that decision ` +
      `(${cls.review} rule(s), action “leave”) instead of deleting the marker and saying nothing, and a ` +
      `damaged word no rule names is left the same way. The damage set the marking uses was MEASURED on ` +
      `this transcription (every character standing inside a word of it that its own print cannot set there), ` +
      `not guessed: it is stated once, in the shared base policy every text's rules are written ` +
      `under. No rule removes a damage character without recording a reading; ` +
      `a rule that did would make the edition say something it does not, which is the one thing this ` +
      `architecture exists to prevent.</p>`,
  );
  return p.join('');
}

function provenanceHtml(t, cited, stats, a, dmg, edition, base) {
  const p = [];
  /* WHAT THIS IS, said before anything else about it. A reader who arrives on a
   * library page needs to know, in the first line, that the page is an EDITION OF
   * A TRANSCRIPTION rather than a clean text — because the reading view shows the
   * print's word where one could be determined and the scanner's damage where it
   * could not, and a reader who does not know that will read the second kind as
   * the author's error. "Repaired edition" is the honest short name for it: the
   * transcription is the witness, the repairs are recorded rules applied to it,
   * and nothing is repaired beyond what a witness decides. (MEASURED, this text:
   * 115 reading rules, 3 division openers, 5 digit normalisations, and 2 damaged
   * runs where no reading was determinable — left visible, not guessed.) */
  /* WHAT THIS IS, in the first line, and WHICH ONE IT IS. The paragraph below is
   * written for an edition whose reading view is produced by its rules; an
   * edition published in repair, with no emendation yet, is NOT a repaired
   * edition and must not be called one. The rule count is MEASURED from the
   * served document (`edition` is `counts(doc)`), never typed — the same source
   * the state note's count uses. */
  const ruleCount = edition ? Object.values(edition.corrections).reduce((a, b) => a + b, 0) : null;
  /* ... AND AN EDITION CARRYING RULES IS NOT A REPAIRED ONE UNLESS ITS STATE SAYS
   * SO. MEASURED, and why this branch exists: this page said "A repaired edition"
   * of Taylor's Theology of Plato — which carries rules and is served `in-repair`
   * — in the paragraph directly above the state line that says it is not finished.
   * The state is the SHELF's own (`repairOf`), read here rather than restated, so
   * the two statements on one page cannot drift apart again. */
  const rep = repairOf(t);
  if (ruleCount === 0) {
    p.push(
      `<p><b>A transcription, not a repaired text.</b> What stands here is a transcription of the printed ` +
        `edition below — every character of it kept — and no repair has been made to it yet, so the reading ` +
        `view and the transcription view are the same words. Every damaged character the scanner left stands ` +
        `as it stands, MARKED as damage rather than read as the print's own text, and nothing is silently ` +
        `corrected. Each emendation will be recorded as a rule with the words it changes, why, and the page ` +
        `image it was decided from, as it is made: the book and chapter structure below was recovered from the ` +
        `edition's own page images, and the repairs will be made against those images in the same way. Until ` +
        `they are, this page shows the transcription as imported and says so.</p>`,
    );
  } else if (rep.state === 'in-repair') {
    p.push(
      `<p><b>A transcription being repaired, not a clean text.</b> What stands here is a transcription of the ` +
        `printed edition below — every character of it kept — with the repairs that have been decided recorded ` +
        `as rules and applied to the reading view. Each repair is a rule with the words it changes, why, and ` +
        `the witness it was decided from; the rules are applied by the view and are never baked into the words ` +
        `served, so the transcription is always beside its repairs and the difference between the two views is ` +
        `the repair list itself. Where the print's word could NOT be determined — from the transcription's own ` +
        `context, from a parallel edition of the same translation, or from another copy of the same print — no ` +
        `repair is invented: the scanner's damage stays, marked, and a rule records the decision to leave it. ` +
        `The work is therefore NOT finished: this edition is readable from end to end, and a reader will still ` +
        `meet garble where nothing could settle the print's word — what was settled is settled and shown, what ` +
        `was not is shown as the transcription has it, and nothing is silently said that the print does not.</p>`,
    );
  } else {
    p.push(
      `<p><b>A repaired edition, not a clean text.</b> What stands here is a transcription of the printed ` +
        `edition below — every character of it kept — with a RECORDED SET OF REPAIRS applied to the reading ` +
        `view. Each repair is a rule with the words it changes, why, and how many times it fires; the rules ` +
        `are applied by the view and are never baked into the words served, so the transcription is always ` +
        `beside its repairs and the difference between the two views is the repair list itself. Where the ` +
        `print's word could NOT be determined — from the transcription's own context or from a parallel ` +
        `edition of the same translation — no repair is invented: the scanner's damage stays, marked, and a ` +
        `rule records the decision to leave it. So this edition reads cleanly in most places and shows its ` +
        `damage in the rest, and it never silently says anything the print does not.</p>`,
    );
  }
  /* THE REPAIR STATE, said on the text's own page: the index states it above the
   * list, and this is where a reader who arrived at the text directly meets it. */
  if (rep) {
    /* THE RULE COUNT IS DERIVED FROM THE SERVED DOCUMENT, NEVER TYPED INTO PROSE.
     * MEASURED: the shelf's own note for this edition read "402 readings applied"
     * while v1.0.0 carries 415 rules (416 firings), so the sentence contradicted
     * the data it describes — and the note is rendered on two pages, so a stale
     * number speaks twice. `edition` here is `counts(doc)`: the rules the version
     * actually serves (model §4.3), which is the only source the count has. */
    const rules = edition ? Object.values(edition.corrections).reduce((a, b) => a + b, 0) : 0;
    const firings = edition ? Object.values(edition.correctionHits).reduce((a, b) => a + b, 0) : 0;
    const counted =
      rules > 0
        ? ` Measured on the text this page serves: ${rules} repair rule${rules === 1 ? '' : 's'}, ` +
          `applied ${firings} time${firings === 1 ? '' : 's'}.`
        : '';
    p.push(
      `<p><b>The state of this edition: <span class="tag">${esc(REPAIR_LABELS[rep.state] || rep.state)}</span></b> ` +
        `— ${esc(rep.note)}${counted} A site is cleared by reading the printed page itself (the page images are ` +
        `kept with the edition); where one is still open, the reading view shows the transcription's ` +
        `damaged characters, marked, rather than a guess.</p>`,
    );
  }
  p.push(`<p><b>Edition.</b> ${esc(t.edition)}</p>`);
  /* THE SOURCE SCANS (model §3): the edition's WHOLE SCAN is stored WITH it and
   * served beside the text, so every leaf is citable — not only the leaves a
   * repair was decided from. Named, counted from the directory, and the archive
   * item linked to its own page; the licence split is kept — the scan is the
   * source (public domain, like the transcription), the work over it is the
   * editorial layer. */
  {
    const n = scanLeafCount(t.slug);
    const items = archiveItems(t);
    const itemNote = !items.length
      ? `The archive item the leaves were taken from is not recorded for this edition. `
      : items.length === 1
        ? `They are the Internet Archive's scan of this volume ` +
          `(<a href="${esc(items[0].url)}" rel="noreferrer">item <code>${esc(items[0].id)}</code></a>), a ` +
          `public-domain work like the transcription. `
        : `They are the Internet Archive's scans of the ${items.length} items this edition's leaves come from ` +
          `(${items
            .map((i) => `<a href="${esc(i.url)}" rel="noreferrer">item <code>${esc(i.id)}</code></a>`)
            .join(' and ')}), a public-domain work like the transcription. `;
    if (n) {
      p.push(
        `<p><b>The source page images.</b> The edition’s whole scan — all ${n} ` +
          `${n === 1 ? 'leaf' : 'leaves'} of it — is stored with the edition and served, one image per leaf, at ` +
          `<a href="/texts/${esc(t.slug)}/scans/">/texts/${esc(t.slug)}/scans/</a>. The apparatus opens on them ` +
          `and browses every leaf of it in leaf order, so a leaf a reading was decided from can be opened ` +
          `beside the reading, and a leaf no reading used is readable all the same; the readings that carry no ` +
          `page image are listed in the apparatus in their own right. ` +
          itemNote +
          `The editorial layer over them — the repairs and their rationales, the page models, the apparatus — ` +
          `is the part released under a licence of its own; see the licence below.`,
      );
    }
  }
  if (stats) {
    p.push(
      `<p><b>What was done to the text.</b> This paragraph is the MECHANICAL work, which changes ` +
        `presentation and never a byte: what the text is corrected by is the recorded rule list, ` +
        `described under "the repairs, as rules" below and inspectable in full in the reader's own ` +
        `repairs panel. Nothing here is corrected against the print or modernised — the rules repair ` +
        `the transcription's damage, they do not edit the edition, and the transcription view shows ` +
        `the pages with no rule applied. The mechanical work, and these are all of it — paragraphs break where the ` +
        `print leaves a blank line (${stats.parasIn} read, ${stats.parasOut} written, the same count); ` +
        `hard line breaks inside a paragraph are joined into one line, and runs of spaces collapsed to ` +
        `one; a word broken across a line break is rejoined, its hyphen taken as the printer’s break ` +
        `and dropped, except where the word before it is a compound that carries a hyphen or where the ` +
        `next line begins with a capital, and then the hyphen stays; and a short line that reads as a ` +
        `heading becomes one (${stats.headings} in this text, ${stats.h2} at top level). Whatever was ` +
        `not a heading is a paragraph, so no passage is lost.</p>`,
    );
  }
  if (stats) {
    p.push(
      `<p><b>How to read this page.</b> The transcription runs in the order of the printed volume’s ` +
        `own pages, so the digitiser’s stamp, the title pages and the book’s own contents list stand ` +
        `where the book put them, before the text proper. The contents block at the head of the text ` +
        `jumps to any heading in it, and every passage that is not a heading is a paragraph, so no ` +
        `page of the volume is skipped over.</p>`,
    );
  }
  if (dmg && (dmg.notSign || dmg.longS || dmg.fConfusions || dmg.folios)) {
    const bits = [];
    if (dmg.longS) bits.push(`${dmg.longS.toLocaleString('en')} long-s characters`);
    if (dmg.fConfusions) {
      bits.push(`${dmg.fConfusions.toLocaleString('en')} words that mix an "f" with a "t"`);
    }
    if (dmg.notSign) bits.push(`${dmg.notSign.toLocaleString('en')} negation signs (¬) standing where the print has none`);
    if (dmg.folios) {
      bits.push(`${dmg.folios.toLocaleString('en')} of its ${dmg.headings.toLocaleString('en')} headings are a bare page number`);
    }
    p.push(
      `<p><b>What the transcription gets wrong, and you will see.</b> Measured on the text of this ` +
        `page: ${bits.join('; ')}. These are the defects the repairs do NOT reach: a corrected text is a ` +
        `new edition, and this page is a transcription of a printed one whose damage is repaired only ` +
        `where a reading could be determined (see the repairs, below, for what is reached and what is ` +
        `left). What is left is left in place AND NAMED rather than deleted. ` +
        `A word that reads oddly is usually the transcription and not the edition: the long s of the ` +
        `print is frequently taken for an f, and a page number of the volume stands in the running ` +
        `text where the printer put it. Where a heading is a bare number it is the volume's own ` +
        `pagination, not a division of the work.</p>`,
    );
  }
  if (a && a.flattened) {
    p.push(
      `<p><b>What the transcription did to the Greek.</b> Measured on the transcription itself: it ` +
        `carries no Greek letters at all — ${a.latinLetters.toLocaleString('en')} Latin letters ` +
        `against ${a.greekLetters} Greek-range ones — so the Greek of this edition runs as accented ` +
        `Latin lookalikes and reads as noise, while the Latin (Migne’s Latin of the Greek, and the ` +
        `Latin authors gathered in the same volume) reads. That is a defect of the transcription, ` +
        `not of the edition and not of this reader.</p>`,
    );
  }
  if (edition) p.push(editionHtml(t, edition, base));
  if (t.note) p.push(`<p><b>Note on this volume.</b> ${esc(t.note)}</p>`);
  /* WHERE IT IS CITED — the hand-seeded list, not a build-time derivation
   * (model §6). The library used to compute this by running the blog's own
   * citation derivation over the posts' footnotes; that derivation stays on the
   * blog, and this page renders `edition.readings[]` — the blog slugs recorded
   * in the edition's own record — as links OUT to the essays. The link text is
   * the slug: the essay's title is the blog's to state, and inventing one here
   * would be inventing data this repo does not hold. */
  if (cited.length) {
    const links = cited.map((s) => `<a href="${SITE.blog.url}/${s}/">${esc(s)}</a>`).join(', ');
    p.push(
      `<p><b>Where it is cited.</b> The essays on the blog whose subject is this work: ${links}. ` +
        `The link goes out to the essay — the texts stand on their own; the essays are one reader’s ` +
        `reading — and a passage can be checked against the edition it was taken from.</p>`,
    );
  } else if (t.cat.length === 0) {
    p.push(
      `<p><b>Where it is cited.</b> No essay is attached to this work in the edition's own record. ` +
        `The record names the catalogue works an edition IS, and this one names none: that is a ` +
        `statement about the record, not a claim that no reading touches it.</p>`,
    );
  } else {
    p.push(`<p><b>Where it is cited.</b> No essay is attached to this work yet.</p>`);
  }
  return p.join('');
}

/** The page for a text whose transcription cannot be read. It is still a page,
 * still linked: the honest end of the shelf is a stated gap, not a missing
 * entry the reader cannot find. */
function unreadableHtml(t, a) {
  return (
    `<p>This transcription cannot be served as text, and it is not served as text here. ` +
    `It reads as noise: measured on the file itself, ${a.greekLetters} of its letters are Greek-range ` +
    `against ${a.latinLetters} Latin ones (${(a.greekShare * 100).toFixed(1)}% Greek-range), so an ` +
    `English edition has come through the transcription as a substituted alphabet — the letters are ` +
    `not the letters of the print.</p>` +
    `<p>That is a defect of the transcription, not of the edition. It could be repaired by re-typing the ` +
    `volume or by finding a clean scan of the same printing; neither has been done, and dressing the ` +
    `noise as prose would hide it. The 1827 edition it is a transcription of is on this shelf as an ` +
    `entry; the 2013 translation the readings use is in copyright and is not here by design.</p>`
  );
}

/* ---------- the reader: the app, and the honest floor under it ---------- */

/** The reader's own CSS. Small on purpose: the reading layer is design/library.css
 * (.prose and the tokens the compiled app binds to), and this only adds what a
 * page of a BOOK needs that a leaf of the catalogue does not — the contents
 * drawer, the page markers, the note slides, the print range. Emitted into the
 * page's head (the one place a <style> belongs), stripped of comments like every
 * other inlined stylesheet. */
const READER_CSS = `
/* The reading width is a TOKEN (design/library.css \`:root --reader\`), not a
   number here, because the apparatus below the reader is laid out on the same
   width: one page, two halves, one grid. */
.rd-section .wrap { max-width: var(--reader); }
.rd { font-family: var(--serif); color: var(--fg); }
.rd.scale-1 { font-size: .86rem; }
.rd.scale-2 { font-size: .93rem; }
.rd.scale-3 { font-size: 1rem; }
.rd.scale-4 { font-size: 1.08rem; }
.rd.scale-5 { font-size: 1.16rem; }
.rd.scale-6 { font-size: 1.26rem; }
.rd-vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.rd-bar {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  border-bottom: 1px solid var(--line);
  font-family: var(--sans); font-size: 12px; color: var(--dim);
  /* IT STICKS OVER THE TEXT, SO IT NEEDS TO BE OPAQUE. Without a background the
     toolbar's controls were drawn straight over the prose and read as part of it
     (the author's report). var(--bg) rather than the nav's translucent rgba+blur:
     the toolbar carries buttons a reader aims at, and text showing through makes
     them harder to read, not prettier.

     The gap below the bar is PADDING, not a margin, so the background covers it
     and the bar's height INCLUDES it — which is what lets the sidebar stick below
     the bar (see --bar-h). A margin + a box-shadow fill was the first attempt and
     it covered the sidebar's own top: the shadow spanned the full width, over the
     reading-progress meter (the author's next report). */
  padding: 8px 0 18px;
  margin-bottom: 0;
  background: var(--bg);
}
.rd-btn {
  font: inherit; font-family: var(--sans); font-size: 12px; line-height: 1.4;
  color: var(--fg); background: var(--bg2); border: 1px solid var(--line);
  border-radius: 6px; padding: 3px 8px; cursor: pointer;
}
.rd-btn:hover { border-color: var(--dim); }
.rd-btn[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.rd-btn:disabled { opacity: .45; cursor: default; }
/* a button label never wraps mid-word: a wrapped label reads as a broken control */
.rd-btn { white-space: nowrap; }
/* a jumped-to anchor lands BELOW the sticky nav, the page's jump bar and the
   toolbar, not under them */
.rd-p, .rd-sec, .rd-pb, .rd-verse, .rd-note { scroll-margin-top: calc(var(--nav-h, 52px) + var(--jump-h, 0px) + var(--bar-h, 44px) + 12px); }
.rd-x { padding: 1px 6px; }
.rd-views { display: flex; gap: 0; }
.rd-views .rd-btn { border-radius: 0; }
.rd-views .rd-btn:first-child { border-radius: 6px 0 0 6px; }
.rd-views .rd-btn:last-child { border-radius: 0 6px 6px 0; margin-left: -1px; }
.rd-search { display: flex; align-items: center; gap: 4px; }
.rd-search input {
  font: inherit; font-family: var(--sans); font-size: 12px;
  color: var(--fg); background: var(--bg); border: 1px solid var(--line);
  border-radius: 6px; padding: 3px 7px; width: 11rem;
}
.rd-count, .rd-here { font-family: var(--mono); font-size: 11px; color: var(--dim); }
.rd-pager { display: flex; align-items: center; gap: 3px; }
.rd-jump { width: 4.2rem !important; }
.rd-bar-right { display: flex; gap: 4px; margin-left: auto; }
.rd-cols { display: grid; grid-template-columns: 1fr; gap: 0 28px; align-items: start; }
.rd-main { max-width: 44rem; outline: none; }
.rd-flow { position: relative; }
.rd-region, .rd-sec { padding: 0; border: 0; margin: 34px 0 18px; }
.rd-region h2, .rd-sec h2 {
  font-family: var(--sans); font-size: 13px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .08em; color: var(--accent);
}
.rd-sec h2 { text-transform: none; letter-spacing: 0; font-size: 15px; }
.rd-sec-n { font-family: var(--mono); color: var(--fg); }
.rd-sec-page { font-family: var(--mono); font-size: 11px; color: var(--dim); }
.rd-p { margin-bottom: 0.9em; line-height: 1.62; color: var(--fg); }
.rd-verse { display: block; padding-left: 1.4em; font-style: italic; }
.rd-rh { font-family: var(--mono); font-size: 10px; color: var(--dim); border-top: 1px dashed var(--line); margin: 10px 0; padding-top: 2px; }
.rd-rh-inline { font-family: var(--mono); font-size: 10px; color: var(--dim); }
.rd-pb {
  font-family: var(--mono); font-size: 10px; color: var(--dim);
  border: 1px solid var(--line); border-radius: 999px; padding: 1px 6px;
  margin: 0 4px; vertical-align: super; white-space: nowrap;
  /* it sits INSIDE a paragraph now (the marker is inline at the page turn), so it
     is inline by construction — an inline element cannot break the line it is in */
  display: inline;
}
.rd-pb-interp { border-style: dashed; }
.rd-pb-refused { border-color: var(--accent); color: var(--accent); }
.rd-ref a { font-family: var(--mono); font-size: .72em; color: var(--accent2); text-decoration: none; padding: 0 1px; }
.rd-ref a:hover { color: var(--accent); }
.rd-margin { display: none; }
.rd-note { display: grid; grid-template-columns: 2rem 1fr; gap: 8px; margin-bottom: 14px; line-height: 1.55; }
.rd-note-n { font-family: var(--mono); font-size: 11px; color: var(--dim); padding-top: .25em; }
.rd-note-body { font-size: .93em; }
.rd-note-back { grid-column: 2; font-family: var(--sans); font-size: 11px; }
.rd-note-open { background: var(--bg2); }
.rd-hit { background: rgba(164, 38, 44, .10); }
/* THE DAMAGE THE POLICY LEAVES VISIBLE (base policy; plan §7(d)). A character of
   the transcription's damage set that the reading view could not resolve is
   marked so a reader can SEE that it is damage and not a typo by the author. It
   is styled APART from a search hit (.rd-hit, .rd mark) on purpose: this is not a
   match, it is a hole in the print, and the two must not look alike. */
.rd mark.rd-damage { background: none; color: var(--accent); border-bottom: 1px dotted var(--accent); font-weight: 600; }
.rd-damage-word { color: var(--accent); }
.rd-left td { color: var(--dim); }
.rd-left-list { margin-top: 12px; }
.rd-left-h { margin-bottom: 4px; }
.rd-left-list ul { display: flex; flex-wrap: wrap; gap: 4px 14px; list-style: none; padding: 0; margin: 6px 0 0; }
.rd mark { background: var(--accent); color: var(--bg); }
.rd-nav {
  position: static; top: auto; z-index: auto; background: none; border: 0;
  backdrop-filter: none; visibility: visible; transform: none;
  font-family: var(--sans); font-size: 12.5px;
}
.rd-nav h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); margin: 16px 0 6px; }
.rd-nav ul, .rd-nav ol { list-style: none; padding-left: 0; }
.rd-nav li { margin: 0 0 3px; line-height: 1.35; }
.rd-toc a { color: var(--fg); }
.rd-toc .rd-cur > a, .rd-toc li.rd-cur a { color: var(--accent); font-weight: 600; }
.rd-toc-page { font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.rd-toc-raw { font-size: 11px; color: var(--dim); margin-top: 2px; }
.rd-marks li { display: flex; align-items: baseline; gap: 4px; }
.rd-pages { display: flex; flex-wrap: wrap; gap: 3px; }
.rd-pages a { font-family: var(--mono); font-size: 11px; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; color: var(--fg); }
.rd-pages li.rd-cur a { background: var(--fg); color: var(--bg); }
.rd-progress { margin: 4px 0 12px; }
.rd-progress-track { height: 4px; background: var(--line); border-radius: 3px; overflow: hidden; }
.rd-progress-fill { height: 100%; background: var(--accent); }
.rd-progress-label { font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.rd-nav-actions { display: flex; gap: 4px; }
.rd-foot { font-family: var(--sans); font-size: 11.5px; color: var(--dim); margin-top: 34px; padding-top: 12px; border-top: 1px solid var(--line); }
.rd-pop {
  position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
  width: min(38rem, 92vw); max-height: 45vh; overflow: auto;
  background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .18); padding: 12px 14px; z-index: 60;
  font-family: var(--serif); font-size: .95rem; line-height: 1.55;
}
.rd-pop-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-family: var(--sans); font-size: 12px; color: var(--dim); }
.rd-pop-foot { display: flex; gap: 8px; align-items: baseline; margin-top: 10px; font-family: var(--sans); font-size: 11.5px; }
/* The repairs list is an OVERLAY, like the citation panel above and the note
   popover. It was rendered after the whole book in the flow — the same bug the
   citation panel is documented for — so a reader at the top of the volume
   clicked the control, the 125-row table was appended after 18 divisions and the
   footer, and NOTHING VISIBLE HAPPENED. An overlay is the only rendering that
   puts the list where the reader already is.
   The geometry is chosen for a TABLE of 125 rows and five columns (class /
   transcription / reading / fires / why), not for a note: it is a sheet the
   width of the reading column and nearly the height of the window, and it
   scrolls its own content. It does NOT move into the right margin the way
   .rd-cite does — the margin is min(26rem, 30vw), about 36rem at 1920px, and the
   why column alone is capped at 34rem, so a five-column table there would wrap
   every justification to one word per line. The margin is right for a citation
   (one passage, copied by eye while the passage stays visible); it is wrong for
   a table. Centred rather than bottom-anchored like .rd-cite for the same
   reason: the citation is anchored to the passage under the reader, this list is
   the whole book's policy and belongs to no passage. No scrim: a scrim would
   block the page and make a non-modal layer look modal, and the reader is meant
   to be able to keep reading behind it. */
.rd-diff {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: min(76rem, 94vw); max-height: 82vh; overflow: auto;
  box-shadow: 0 18px 50px rgba(0, 0, 0, .35); z-index: 60;
  padding: 16px 18px; background: var(--bg2);
  border: 1px solid var(--line); border-radius: 10px;
  font-family: var(--sans); font-size: 13px;
}
/* On a narrow screen there is less page to keep visible behind the sheet and
   more table to fit, so it takes nearly the whole window. The table is five
   columns of which two hold transcription runs that have no spaces in them (the
   OCR damage is inside words), and those runs alone held the table 154px wider
   than the sheet MEASURED at 420px — so at this width the long runs may break
   anywhere rather than push the sheet sideways. */
@media (max-width: 61.99em) {
  .rd-diff { width: 96vw; max-height: 92vh; padding: 12px; }
  .rd-diff td, .rd-diff code { overflow-wrap: anywhere; }
}
/* The citation panel is an OVERLAY, like the note popover (plan §11 phase 5).
   It was rendered after the whole book in the flow, so opening it either showed
   nothing (the reader is on page 15, the panel is after page 58) or — MEASURED in
   a real browser — yanked the reader to the end of the volume when focus moved to
   it, which moved the reader's position and so changed the citation the panel was
   opened to give. It cites the passage the reader was at: it has to be visible
   from where that reader is. */
.rd-cite {
  position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
  width: min(38rem, 92vw); max-height: 50vh; overflow: auto;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .18); z-index: 60;
  padding: 16px; background: var(--bg2);
  border: 1px solid var(--line); border-radius: 10px;
  font-family: var(--sans); font-size: 13px;
}
/* On a wide screen the panel moves into the right MARGIN — the column the margin
   notes use, which is empty except where a note floats. It then covers no prose
   at all, which is what a citation panel is for: the reader is looking at the
   passage they are citing while they copy the line. */
@media (min-width: 78em) {
  .rd-cite { left: auto; right: 16px; transform: none; width: min(26rem, 30vw); }
}
.rd-cite-head, .rd-diff-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
/* THE CLOSE CONTROL MUST NOT SCROLL AWAY. .rd-diff is its own scroll container
   (overflow: auto, max-height 82vh) and the table is 341 rows; the ✕ lives in
   the head, so scrolling the list carried the only visible close control out of
   view and a reader had to scroll back to the top to dismiss it (MEASURED on the
   published Cave text). The head is stuck to the top of the scrollport instead,
   with the panel's own background so rows pass under it cleanly. The citation
   panel is one passage high, so it is not stuck — a needless overlap there would
   hide the passage the reader opened it to copy. */
.rd-diff-head {
  position: sticky; top: 0; z-index: 2;
  background: var(--bg2);
  padding-bottom: 6px; margin-bottom: 2px;
  border-bottom: 1px solid var(--line);
}
.rd-cite h3, .rd-diff h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); margin-bottom: 8px; }
.rd-cite-line { font-family: var(--serif); font-size: 15px; }
.rd-cite-url { font-family: var(--mono); font-size: 12px; }
.rd-print-controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.rd-diff table { width: 100%; border-collapse: collapse; font-size: 12px; }
.rd-diff th, .rd-diff td { text-align: left; vertical-align: top; padding: 4px 6px; border-bottom: 1px solid var(--line); }
.rd-diff code { font-family: var(--mono); font-size: 11.5px; }
.rd-cls { font-family: var(--mono); font-size: 11px; color: var(--accent); }
.rd-hits { font-family: var(--mono); font-size: 11px; color: var(--dim); text-align: right !important; }
.rd-why { color: var(--dim); max-width: 34rem; }
.rd-dim, .rd .dim { color: var(--dim); font-size: 12px; }
.rd-live { font-family: var(--sans); font-size: 11.5px; color: var(--dim); margin-top: 8px; min-height: 1em; }
.rd-fb-toc { font-family: var(--sans); font-size: 12.5px; margin-bottom: 26px; }
.rd-fb-toc ol { list-style: none; padding-left: 0; columns: 2; column-gap: 28px; }
.rd-fb-toc li { break-inside: avoid; margin-bottom: 3px; }
.rd-status { padding: 18px 0; }

@media (min-width: 62em) {
  /* --nav-h is the site nav's MEASURED height and --jump-h the page's own jump
     bar's, both set by the shell's boot script (each wraps, so neither offset can
     be a constant). The reader's toolbar stacks BELOW both: a constant here put the
     toolbar under the header whenever the nav was taller than the guess — the
     author's report. The fallbacks are the nav's minimum and no jump bar. */
  .rd-bar { position: sticky; top: calc(var(--nav-h, 52px) + var(--jump-h, 0px)); z-index: 45; }
  .rd-cols { grid-template-columns: 17rem minmax(0, 1fr); }
  .rd-nav { position: sticky; top: calc(var(--nav-h, 52px) + var(--jump-h, 0px) + var(--bar-h, 44px)); max-height: 78vh; overflow: auto; padding-right: 8px; }
  .rd-notes-index { display: block; }
}
@media (max-width: 61.99em) {
  .rd-nav {
    position: fixed; inset: 0 auto 0 0; width: min(20rem, 86vw); padding: 16px;
    background: var(--bg); border-right: 1px solid var(--line); z-index: 70;
    overflow: auto; visibility: hidden; transform: translateX(-102%);
  }
  .rd-nav.rd-nav-open { visibility: visible; transform: none; }
}
/* Margin notes, wide viewports only. A FLOAT against the paragraph, not an
   absolutely positioned box: the text then flows BESIDE the note, which is what
   a margin note is. (Measured in a render: an absolutely positioned note lands
   on top of the line it annotates — the position is taken against the
   superscript, which is inline, so "next to it" is "on it".) A clear to the
   right stacks two notes in one paragraph instead of overlapping them, and the
   negative right margin is what carries the note out into the margin of the
   grid column. The text column is narrower than the sweep of the note, so
   nothing is hidden under it. */
@media (min-width: 78em) {
  .rd-flow, .rd-main { overflow: visible; }
  .rd-margin {
    display: block; float: right; clear: right;
    width: 12rem; margin: 0.1rem -13.6rem 0.5rem 1.2rem;
    font-family: var(--serif); font-size: .78rem; line-height: 1.34;
    color: var(--dim); text-align: left; font-style: normal;
  }
}
@media print {
  .rd-bar, .rd-nav, .rd-pop, .rd-cite, .rd-diff, .rd-foot, .rd-live, #reader-fallback { display: none !important; }
  .rd-cols { display: block; }
  .rd-main { max-width: none; }
  .rd-item.rd-out { display: none; }
  .rd-margin, .rd-rh { display: none !important; }
  .rd-flow { position: relative; padding-right: 3.4em; }
  .rd-pb, .rd-pb-refused {
    position: absolute; right: 0; border: 0; padding: 0; margin: 0;
    font-size: 9pt; color: #000;
  }
  .rd-note { break-inside: avoid; }
  .rd-p { color: #000; }
}
`;

/** The boot script: the handful of things a DOM does that Elm cannot ask for —
 * fetching the one document, scrolling, writing the fragment, keeping the stored
 * position, and putting the server-rendered copy away once the app is up. Kept
 * in the shell (not in the bundle) because every line of it is about THIS page:
 * the app receives flags and ports and knows nothing about URLs or storage. */
const READER_BOOT = `
(function () {
  var node = document.getElementById('reader-app');
  var held = document.getElementById('reader-flags');
  if (!node || !held || typeof Elm === 'undefined' || !Elm.Reader) { return; }
  var flags = JSON.parse(held.textContent);
  flags.hash = window.location.hash || '';
  flags.stored = null;
  try {
    var kept = window.localStorage.getItem('library:' + flags.slug);
    if (kept) { flags.stored = JSON.parse(kept); }
  } catch (e) { flags.stored = null; }
  var app = Elm.Reader.init({ node: node, flags: flags });
  /* THE STICKY OFFSET. The reader's toolbar sticks BELOW the site nav. The nav's
     height is not a constant: its own .wrap is flex-wrap with a 52px minimum, so
     it grows when its links wrap (a narrow window, a longer label). A hard-coded
     a hard-coded top of 52px therefore puts the toolbar UNDER the header as soon as the nav is
     taller than the guess — MEASURED by the author: "the blog's header covers the
     reader's toolbar" while scrolling. The nav is measured and the offset is set
     from it, on load and whenever it resizes. */
  var sizeNav = function () {
    var nav = document.querySelector('nav');
    if (nav && nav.getBoundingClientRect) {
      var h = nav.getBoundingClientRect().height;
      if (h > 0) { document.documentElement.style.setProperty('--nav-h', h + 'px'); }
    }
    // THE TOOLBAR TOO. It wraps (flex-wrap) and its height therefore varies, and
    // the contents sidebar sticks BELOW it — a constant there put the sidebar's
    // own top (the reading-progress meter) under the bar.
    var bar = document.querySelector('#reader-app .rd-bar');
    if (bar && bar.getBoundingClientRect) {
      var bh = bar.getBoundingClientRect().height;
      if (bh > 0) { document.documentElement.style.setProperty('--bar-h', bh + 'px'); }
    }
  };
  sizeNav();
  window.addEventListener('resize', sizeNav);
  if (window.ResizeObserver) {
    try {
      var ro = new window.ResizeObserver(sizeNav);
      var navEl = document.querySelector('nav');
      if (navEl) { ro.observe(navEl); }
      // the toolbar does not exist until Elm renders it, and it grows when its
      // controls wrap — watching the app's root catches both
      var appEl = document.getElementById('reader-app');
      if (appEl) { ro.observe(appEl); }
    } catch (e) {}
  }
  // Elm renders on an animation frame and runs port commands during the same
  // update, so a jump or a focus asked for now names an element that is not in
  // the DOM yet — the scroll waits one frame. (Measured: without this the app
  // renders and never moves: the anchor is created after the port has fired.)
  app.ports.requestDoc.subscribe(function (url) {
    fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) { throw new Error('the document did not load'); }
      return r.text();
    }).then(function (text) {
      app.ports.docReceived.send(text);
      // the toolbar renders with the document: measure it once the frame that
      // draws it has run (and again shortly after, for a wrapped toolbar)
      soon(sizeNav);
      window.setTimeout(sizeNav, 80);
    }).catch(function (e) {

      app.ports.docFailed.send('failed');
    });
  });
  var soon = function (fn) {
    if (window.requestAnimationFrame) { window.requestAnimationFrame(fn); }
    else { window.setTimeout(fn, 0); }
  };
  // the server-rendered copy carries the same anchors as the app, so it is
  // taken out of the document once the app has rendered the book: two elements
  // with one id is invalid, and the copy's are hidden anyway
  var dropFallback = function () {
    var fb = document.getElementById('reader-fallback');
    if (fb && fb.parentNode) { fb.parentNode.removeChild(fb); }
  };
  app.ports.jumpTo.subscribe(function (id) {
    soon(function () {
      dropFallback();
      var el = document.getElementById(id);
      if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'start' }); }
    });
  });
  // focusOn moves KEYBOARD FOCUS, never the page. A bare focus() also scrolls
  // the element into view, so every focusOn (a note popover, the citation panel)
  // dragged the reader to its target — and on load that is the toolbar, below the
  // bibliographic record. preventScroll is the option that separates the two; an
  // engine that does not take the options object is fallen back to.
  var focusSilently = function (el) {
    try { el.focus({ preventScroll: true }); }
    catch (e) { el.focus(); }
  };
  app.ports.focusOn.subscribe(function (id) {
    soon(function () {
      var el = document.getElementById(id);
      if (el) { dropFallback(); }
      if (el && el.focus) { focusSilently(el); }
    });
  });
  app.ports.setHash.subscribe(function (h) {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '#' + h);
    } else {
      window.location.hash = h;
    }
  });
  app.ports.persist.subscribe(function (value) {
    try { window.localStorage.setItem('library:' + flags.slug, JSON.stringify(value)); } catch (e) {}
  });
  window.addEventListener('hashchange', function () {
    app.ports.hashChanged.send(window.location.hash);
  });
  var fallback = document.getElementById('reader-fallback');
  if (fallback) { fallback.hidden = true; }

  // Where the reader is. Derived from the DOM on every scroll, not from an
  // IntersectionObserver: the app renders on an animation frame, so at this
  // point there is not one [data-rd-i] in the document to observe — MEASURED, the
  // observer was created against an empty list and the position never moved, so
  // the progress meter read 0% at page 16 and resume was dead. Reading the DOM
  // each time is also self-healing: the marks are re-rendered on a view change,
  // a range print and a search jump, and a subscription does not survive that.
  //
  // The rule: the position is the LAST flow item whose top is above 40% of the
  // viewport — the one the reader is looking at. The marks are in document order,
  // so the search is a bisection.
  var lastSent = -1;
  var report = function () {
    var marks = node.querySelectorAll('[data-rd-i]');
    if (!marks.length) { return; }
    var y = (window.innerHeight || 800) * 0.4;
    var lo = 0;
    var hi = marks.length - 1;
    var best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (marks[mid].getBoundingClientRect().top <= y) { best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    var ix = Number(marks[best].getAttribute('data-rd-i'));
    // NO MARK ABOVE THE LINE means the reader is ABOVE THE TEXT — on the
    // bibliographic record or the citation, which is where a landing now stays.
    // Report -1 (a position the app ignores) rather than the first entry:
    // MEASURED, reporting entry 0 there wiped the stored position and reset the
    // meter to 0% on a RESIZE at the top of the page, where the reader had not
    // moved at all.
    if (marks[0].getBoundingClientRect().top > y) { ix = -1; }
    if (ix !== lastSent) {
      lastSent = ix;
      app.ports.scrolled.send(ix);
    }
  };
  var wantReport = false;
  var onScroll = function () {
    if (wantReport) { return; }
    wantReport = true;
    soon(function () { wantReport = false; report(); });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  setTimeout(report, 0);

  soon(function () { if (node.childNodes.length) { dropFallback(); } });
})();
`;

/** The compiled reader, committed. The default build inlines this file and needs
 * no Elm at all — the same contract design/library.css has. READER=1 regenerates it
 * from elm/src/Reader.elm through tools/build-reader.mjs (make -> strip ->
 * gate-assert -> boot-assert -> write) and warns when the result differs from
 * what is checked in, because a bundle that only exists in someone's working tree
 * is not a contract. */
const READER_BUNDLE = join(ROOT, 'tools', 'app.js');
let readerBundleCache = null;
function readerBundle() {
  if (readerBundleCache) return readerBundleCache;
  if (process.env.READER === '1') {
    const before = existsSync(READER_BUNDLE) ? readFileSync(READER_BUNDLE, 'utf8') : null;
    execFileSync(process.execPath, [join(ROOT, 'tools', 'build-reader.mjs')], { stdio: 'inherit' });
    const after = readFileSync(READER_BUNDLE, 'utf8');
    if (before !== null && before !== after) {
      console.log('-----------------------------------------------------------------------');
      console.log('WARNING: the regenerated reader differs from the committed tools/app.js.');
      console.log('  The regenerated bundle is now in place — commit it:');
      console.log('    git add tools/app.js');
      console.log('-----------------------------------------------------------------------');
    }
  }
  readerBundleCache = readFileSync(READER_BUNDLE, 'utf8');
  return readerBundleCache;
}

/** The citation fields the reader app renders (model §3). They come from the
 * EDITION RECORD — `source_edition.place`/`imprint`/`year` — not from a regex
 * over a bibliographic string: the model states each field, so no field has to
 * be parsed back out of prose (the blog's own `citationFields` regex matched the
 * 1917 Watkins imprint and MISSED the 1816 form, which is why the record is the
 * source now). `place`/`publisher` stay empty where the model records null,
 * never guessed. */
function citationFields(t) {
  return {
    author: t.author || '',
    title: t.title || '',
    translator: t.translator || '',
    place: t.place || '',
    publisher: t.imprint || '',
    year: t.year != null ? String(t.year) : '',
  };
}

/** The complete contents list as real HTML: the regions the fragment grammar
 * reserves, then every division with the printed page it opens on. The printed
 * edition has no contents page (measured), so this is generated apparatus — and
 * the page says so, because a generated list that does not admit it is generated
 * is not honest about itself (§7 of the plan).
 *
 * The titles are the GENERATED titles (see `extract`): the division's own opening
 * words with the recorded repairs applied, because a contents list is exactly the
 * surface a reader uses to decide whether to read on and damaged words there cost
 * a section. A title the transcription damaged and the rules cannot read is NOT
 * shown as a title: the entry states the gap and carries the transcription's own
 * words beside it, so nothing is hidden and nothing is invented. MEASURED: two of
 * this volume's eighteen titles are in that state (§2, §9) and §11, whose opener
 * the rules READ, is not. */
function readerTocHtml(doc) {
  const items = [];
  const regionLabel = (k) =>
    k === 'front' ? 'The front matter' : k === 'notes' ? 'Notes' : 'The text';
  for (const b of doc.blocks) {
    if (b.t === 'region' && b.id) items.push({ id: b.id, label: regionLabel(b.kind), page: null });
  }
  for (const e of doc.toc) {
    items.push({
      id: e.id,
      label: e.damaged ? `${e.n} \u00b7 ${DAMAGED_TITLE}` : `${e.n} \u00b7 ${e.title}`,
      asides: e.damaged
        ? [`<span class="dim">the transcription reads \u201c${esc(e.raw)}\u201d</span>`]
        : [],
      page: e.page,
    });
  }
  return (
    `<nav class="rd-fb-toc" aria-label="Contents">` +
    `<ol>` +
    items
      .map(
        (i) =>
          `<li><a href="#${i.id}">${esc(i.label)}</a>` +
          (i.page ? ` <span class="dim">p.\u00a0${i.page}</span>` : '') +
          ((i.asides || []).length ? ` ${i.asides.join(' ')}` : '') +
          `</li>`,
      )
      .join('') +
    `</ol></nav>`
  );
}

/** One division of the volume as plain HTML, from the served document: the
 * blocks of the section, with its note references as links and its page markers
 * where the volume has them. The words are the transcription's (no repair is
 * applied anywhere on the page), so what a reader without scripts sees is exactly
 * what the transcription holds. */
function readerSectionHtml(doc, n) {
  const out = [];
  let on = false;
  let run = [];
  const flush = () => {
    if (run.length) {
      const at = run.find((r) => r.at);
      out.push(`<p${at ? ` id="${at.at}"` : ''}>${run.map((r) => r.html).join('')}</p>`);
    }
    run = [];
  };
  for (const b of doc.blocks) {
    if (b.t === 'region') {
      if (on) break;
      continue;
    }
    if (b.t === 'sec') {
      if (on) break;
      on = b.n === n;
      if (on)
        out.push(
          `<h3 id="${b.id}">${b.n}.${b.page ? ` <span class="dim">p.\u00a0${b.page}</span>` : ''}</h3>`,
        );
      continue;
    }
    if (!on) continue;
    switch (b.t) {
      case 'p':
        run.push({ at: b.at, html: esc(b.x) });
        break;
      case 'verse':
        run.push({ at: b.at, html: esc(b.x).replace(/\n/g, '<br>') });
        break;
      case 'ref':
        run.push({
          html: `<sup><a id="${b.id || `r${b.n}`}" href="#n${b.n}">${b.n}</a></sup>`,
        });
        break;
      case 'pb':
        // the marker belongs INSIDE the paragraph it falls in (the paragraph runs
        // across the page break) — pushing it to `out` put it between two <p>s and
        // split the sentence the print has whole
        run.push({
          html:
            b.page != null
              ? `<span class="rd-pb" id="${b.id}" data-page="${b.page}" title="Printed page ${b.page}">${b.page}</span>`
              : `<span class="rd-pb rd-pb-refused" title="This page marker could not be read as a number">&#10216;unnumbered page&#10217;</span>`,
        });
        break;
      case 'rh':
        // furniture the reading view suppresses; it does not break the paragraph
        break;
      default:
        break;
    }
  }
  flush();
  return out.join('\n');
}

/** The shell: provenance (elsewhere), the contents list, the first division, the
 * app, and the floor under it. Order is deliberate — the app mounts first and the
 * server-rendered copy is what a reader without scripts gets, and the app hides
 * that copy once it is up (see the boot script), so nothing is shown twice.
 *
 * THE COPY IS BOUNDED WHEN THE TEXT IS SERVED IN PARTS. `legacySection` is the
 * whole transcription rendered for a reader without scripts; a text whose page
 * would exceed `LIBRARY_PAGE_MAX_BYTES` is served in parts instead (the parts
 * are linked from the parent page), and the parent then carries the app and the
 * edition's FIRST section, not the whole book. `legacySection` empty IS that
 * mode, and the no-script statement says it — the whole text is one plain file
 * and the parts, both named there. The app is not affected: it fetches the
 * version's own document and renders the whole of it either way. */
function readerShell(t, doc, legacySection, base) {
  const wholeCopy = legacySection !== '';
  const flags = {
    slug: t.slug,
    url: `${base}t`,
    base,
    citation: citationFields(t),
    // THE EDITION'S REPAIR STATE, so the reader can say it too: a reader inside
    // the book is the one who needs to know whether it is damaged and unrepaired,
    // being cleared, or finished (see `repairOf` — the default state is `damaged`).
    repair: (() => {
      const r = repairOf(t);
      return { state: r.state, label: REPAIR_LABELS[r.state] || r.state, note: r.note || '' };
    })(),
  };
  const noscript = wholeCopy
    ? `<noscript><p><b>This page reads without scripts.</b> Below is the edition's ` +
      `own first section, with its note references and page markers, and then the whole ` +
      `transcription of the volume in its printed order. The same text is also served as ` +
      `<a href="${base}plain">one plain file</a>, which needs no scripts at all.</p></noscript>`
    : `<noscript><p><b>This page reads without scripts.</b> Below is the edition's ` +
      `own first section, with its note references and page markers. The whole transcription is too long ` +
      `for one page, so it is served in PARTS — each linked under “The text, in parts” below — and as ` +
      `<a href="${base}plain">one plain file</a>, which needs no scripts either.</p></noscript>`;
  const app =
    `<div id="reader-app"></div>\n` +
    `<script type="application/json" id="reader-flags">${JSON.stringify(flags)}</script>\n` +
    `<script>\n${readerBundle()}\n</script>\n` +
    `<script>\n${stripJsComments(READER_BOOT)}\n</script>\n`;
  // the same leak gate runs over this copy as over every other rendered block:
  // a page of a book legitimately holds sequences a comment would use, and the
  // character reference keeps the reader's characters identical
  const shown = gateSafeText(readerTocHtml(doc) + `<div class="prose">` + readerSectionHtml(doc, 1) + `</div>`, t.slug);
  const fallback =
    `<div id="reader-fallback">` +
    shown +
    (wholeCopy
      ? `<p class="dim">Every word of the volume follows, exactly as the transcription has it` +
        ((doc.corrections || []).length
          ? `; the reader above shows the same text with the repairs recorded as rules, which is why ` +
            `one page of this book can read two ways.</p>`
          : `. No repair has been recorded for this edition yet, so the reader above and this copy are ` +
            `the same words.</p>`)
      : `<p class="dim">This is the edition’s first section. The whole transcription follows in parts, ` +
        `linked under “The text, in parts” below, and as <a href="${base}plain">one plain file</a>; ` +
        `the reader above shows the whole of it, with the repairs recorded as rules` +
        ((doc.corrections || []).length ? `.</p>` : ` — none of them yet.</p>`)) +
    legacySection +
    `</div>`;
  // The app comes FIRST and the server-rendered copy after it. Both carry the
  // same anchors — that is the point of the copy, it is the same book — and with
  // the copy first, `getElementById('s4')` returned the COPY, so a citation link
  // scrolled to a hidden element while the app's own s4 sat further down the page
  // (MEASURED: the id lookup wins on document order, and the smoke's scroll check
  // caught it). The app first makes every anchor resolve to the rendering the
  // reader is looking at, whether or not scripts have run.
  return (
    `<section class="rd-section" id="the-text"><div class="wrap">` +
    `<h2>The reader</h2>` +
    `<div class="hint">the contents list the printed edition does not have, its first section, and the app</div>` +
    app +
    noscript +
    fallback +
    `</div></section>`
  );
}

/** One text: its page, plus one page per part when it is too big to be one. */
function logPageModel(t, doc, src) {
  const model = loadDerivs(t.slug, sha256(src));
  if (!model) {
    log(
      `library: ${t.slug}: the page model rests on the volume's own running heads and bare folios alone — ` +
        `no leaf model is stored for this text. Build one from the item's own derivatives with ` +
        `node tools/derive.mjs ${t.slug}`,
    );
    return;
  }
  const s = model.totals;
  log(
    `library: ${t.slug}: leaf-accurate page model — ${s.leaves} leaf/leaves, ${s.withText} of them carrying ` +
      `text, ${s.numbered} carrying a printed number (${s.detected} detected on the leaf, ${s.interpolated} ` +
      `filled in from the leaf sequence) and ${s.refused} carrying none; every numbered leaf sits at the same ` +
      `leaf→page offset (${s.offset})`,
  );
  log(`library: ${t.slug}: the agreement table — the item's page-number pass against the volume's own heads:`);
  printAgreement(agreementRows(model), (line) => log(`library: ${line.trimEnd()}`));
  const a = model.agreement;
  log(
    `library:   ${a.agree} page(s) both sources agree on, ${a.textOnly} the transcription reads and the item's pass ` +
      `does not, ${a.refusedAgree} reading(s) the stride rule refused that the leaf confirms, ${a.refusedDisagree} ` +
      `it refuses and the leaf does not, ${a.leafOnly} the item's pass numbers with nothing read on the leaf (NOT ` +
      `served as a number), ${a.refusedOnly} refused with nothing to confirm them, ${a.unread} neither has, ` +
      `${a.disagree} disagreement(s)`,
  );
  // the diff against the txt-mode page model: the same text read with the leaf
  // model and without it, difference by difference
  const txt = extract(src, { entry: t, sha256: sha256(src), leaf: false });
  const diff = diffDocs(txt, doc);
  log(`library: ${t.slug}: against the txt-mode page model (reading the text with no leaves): ${diff.length} difference(s)`);
  for (const line of summariseDiff(diff)) log(`library:   ${line}`);
  for (const f of doc.findings) log(`library:   finding: ${f}`);
}


/* ---------- the edition's scholarly furniture (DESIGN-SYSTEM.md §5) ---------- */

/** The record's language code rendered as a name (the code stays in the DATA —
 * this is presentation, not a second copy of the fact). */
const LANGUAGES = {
  en: 'English',
  grc: 'Ancient Greek',
  la: 'Latin',
  de: 'German',
  fr: 'French',
  it: 'Italian',
};

/** THE SOURCE EDITION AS A BIBLIOGRAPHIC LINE — author, title, translator,
 * imprint — composed from the record's own structured fields. The record's
 * `statement` is a provenance NOTE (Proclus's carries an editorial remark about
 * which part of the volume this edition serves), so the bibliographic line is
 * built from `author`/`title`/`translator`/`place`/`imprint`/`year`, and the
 * statement stands, whole, under Provenance where a note belongs. */
function sourceEditionLine(t) {
  const who = [t.author, t.title].filter(Boolean).join(', ');
  const tr = t.translator ? `, trans. ${t.translator}` : '';
  const press = [t.place, t.imprint].filter(Boolean).join(': ');
  const tail = [press, t.year].filter(Boolean).join(', ');
  return esc(who + tr + (tail ? ` (${tail})` : ''));
}

/** THE BIBLIOGRAPHIC RECORD (DESIGN-SYSTEM.md §5.1): a definition list of what
 * the edition IS — author, title, translator, year, source edition, scan source,
 * language. Every field is the edition record's; a field the model leaves empty
 * is left out rather than guessed. */
function bibRecordHtml(t) {
  const rec = t.record || {};
  const src = rec.scan_source || {};
  const rows = [];
  const row = (k, v) => {
    if (v) rows.push(`<dt>${esc(k)}</dt><dd>${v}</dd>`);
  };
  row('Author', esc(t.author));
  row('Title', esc(t.title));
  row('Translator', t.translator ? esc(t.translator) : null);
  row('Year', t.year != null ? String(t.year) : null);
  row('Source edition', sourceEditionLine(t));
  row(
    'Scanned from',
    src.archive_id
      ? `Internet Archive identifier: ` +
        `<a href="https://archive.org/details/${esc(src.archive_id)}" rel="noreferrer">` +
        `<code>${esc(src.archive_id)}</code></a>`
      : null,
  );
  const lang = rec.lang || t.lang || '';
  row('Language', lang ? esc(LANGUAGES[lang] || lang) : null);
  return `<div class="bib-record"><dl>${rows.join('')}</dl></div>`;
}

/** Wrap a URL only at PATH boundaries: the scheme+host is ONE unbreakable run
 * (a `<span class="cite-host">` set `white-space: nowrap`), and a `<wbr>` after
 * each path separator is the ONLY break opportunity. MEASURED: the citation's
 * address broke mid-domain (`https://neoplatonic-` / `library.org/…`) — the
 * paragraph allowed a break anywhere, and a browser breaks at the literal hyphen
 * in `neoplatonic-library.org` however well the `<wbr>`s are placed. With the
 * host unbreakable, wrapping can land only at a path boundary, so a reader never
 * sees the host split. */
function wrapAtSlashes(url) {
  const m = /^([a-z][\w+.-]*:\/\/[^/]+)(\/.*)?$/i.exec(url);
  if (!m) return esc(url);
  const host = `<span class="cite-host">${esc(m[1])}</span>`;
  return m[2] ? host + m[2].split('/').map(esc).join('/<wbr>') : host;
}

/** THE CITATION'S DOI, AS A LINK (DESIGN-SYSTEM.md §5.2). The citation string is
 * the RECORD and the DOI in it is a bare identifier (`DOI: 10.5281/zenodo.…`).
 * Rendering it as a link must not alter a character of it — only markup is
 * added, and the anchor's text is the identifier itself — so the citation a
 * reader copies is still the stored string. A citation with NO DOI comes back
 * unchanged (never an empty link). The identifier is one unbreakable run: the
 * stylesheet sets `.cite-doi { white-space: nowrap }`, so it cannot wrap
 * mid-DOI. Takes ALREADY-ESCAPED text (the escaping is the caller's, done once,
 * so an escaped `&` is never escaped twice). */
export function linkDoi(escaped) {
  return escaped.replace(
    /(DOI:\s*)(10\.\d{4,}\/\S+?)(\.)?(?=\s|$)/,
    (_, prefix, id, dot = '') => `${prefix}<a class="cite-doi" href="https://doi.org/${id}">${id}</a>${dot}`,
  );
}

/** THE CITATION BLOCK (DESIGN-SYSTEM.md §5.2): the version's own citation string
 * (meta.json) — its PROSE in the reference serif, the URL it ends in as the ONE
 * address, hyperlinked. MEASURED: the block used to print the URL twice — once
 * inside the citation and again on an address line beneath it. The citation's
 * OWN URL is the canonical address here; the page's own address is the head's
 * canonical link, which is where a page's URL belongs. The rendered text is
 * still the citation byte for byte (the `<wbr>`s and the host's `<span>` are
 * markup, not text); route-probe and version-probe read it back and hold it
 * against the record. The DOI, when one is minted, is part of the STRING (the
 * citable identity) — the block adds nothing to it but a link over the
 * identifier, so a page cannot print a DOI its own citation omits, and the
 * reader can resolve the one it prints. */
function citationBlockHtml(base, versionMeta) {
  const citation = String(versionMeta.citation);
  const tail = /\s+(https?:\/\/\S+)\s*$/.exec(citation);
  const prose = tail ? citation.slice(0, tail.index) : citation;
  /* A citation with no trailing URL (a version that records none) still names
   * its address: the page's own, joined with the separator the earlier
   * missing-slash defect forgot. */
  const url = tail ? tail[1] : `${BASE}/${base.replace(/^\//, '')}`;
  return (
    `<div class="citation-block">` +
    `<p class="cite">${linkDoi(esc(prose))} <a class="cite-id" href="${esc(url)}">${wrapAtSlashes(url)}</a>` +
    `</p></div>`
  );
}

/** How many leaf images are stored WITH the edition (model §1/§3). They are the
 * edition's WHOLE SCAN, held in `data/editions/<slug>/scans/` and served beside
 * the text — so the leaf a repair cites resolves, and every other leaf of the
 * edition is readable too. Read from the directory, never typed into prose: a
 * count of the stored leaves must not be able to disagree with the stored
 * leaves. */
export function scanLeafCount(slug) {
  try {
    return readdirSync(join(ROOT, 'data', 'editions', slug, 'scans')).filter((f) => LEAF_FILE.test(f)).length;
  } catch {
    return 0;
  }
}

/** The Internet Archive item page(s) the scan came from — from `edition.json`'s
 * `scan_source.items[]` when it names more than one, else `.archive_id`.
 * MEASURED, and why a LIST: Taylor's 1816 Theology of Plato is printed over two
 * volumes and its transcription is cut from TWO archive items (its stored leaf
 * names carry the volume's prefix). Naming only the first item would misstate
 * where the edition's leaves come from, so every recorded item is named and the
 * count is stated. Returns `[{ id, url }]`, empty when none is recorded. */
export function archiveItems(t) {
  const s = (t.record && t.record.scan_source) || {};
  const ids = Array.isArray(s.items) ? s.items.map((i) => i && i.archive_id).filter(Boolean) : [];
  if (!ids.length && s.archive_id) ids.push(s.archive_id);
  return [...new Set(ids)].map((id) => ({ id, url: `https://archive.org/details/${id}` }));
}

/** THE VIEWER'S CODE, read once and comment-stripped: it is inlined into the
 * edition page (build/shell.mjs `arrive`), and the leak gate reads a comment
 * delimiter in emitted code as a leak. */
const VIEWER_SRC = join(ROOT, 'tools', 'apparatus', 'viewer.js');
let viewerScriptCache = null;
function viewerScript() {
  if (viewerScriptCache === null) viewerScriptCache = stripJsComments(readFileSync(VIEWER_SRC, 'utf8'));
  return viewerScriptCache;
}

/** THE APPARATUS (DESIGN-SYSTEM.md §5.4): the version's whole repair log, served
 * as DATA and browsed on TWO AXES — the readings, and the leaves.
 *
 * MEASURED, and the reason this is a viewer and not a list: the log inlined on
 * this page was 324,245 bytes on proclus (`415` rules of markup), and the page
 * image a reading was decided from was a small thumbnail buried among the 310
 * rules that carry no image at all. MEASURED, and the reason it is not a
 * leaf-only viewer: on porphyry only 3 of the 384 readings were read off a page
 * image, and its first stored leaf carries none. So the page carries — server-
 * rendered, for a reader without scripts — what the apparatus is, where the whole
 * log is served as one plain file, and where the page images are; the viewer
 * (inlined below) fetches that file and renders it, opening on the first leaf
 * that HAS readings and listing the readings with no page image in their own
 * right.
 *
 * `base` is the page's own URL, so a pinned page fetches the PINNED version's
 * apparatus (`/texts/<slug>/v/<semver>/apparatus.json`), which the build writes
 * for every version. */
function apparatusViewerHtml(t, version, base) {
  const data = apparatusData(t, version);
  const url = `${base}apparatus.json`;
  const byType = APPARATUS_TYPES.filter((k) => data.counts[k]);
  /* THE BALANCE, MEASURED FROM THE RECORD, never typed: a reading is "read off a
   * page image" when one of its evidence entries is a leaf the edition holds.
   * Most readings have none — porphyry 3 of 384 — so the summary may not present
   * the leaf as the way in without saying how many readings it does not reach. */
  const withImage = data.rules.filter((r) => r.evidence.some((e) => e.exists)).length;
  const noImage = data.ruleCount - withImage;
  const citedLeaves = data.leaves.filter((l) => l.readings).length;
  const unheld = new Set();
  let citingUnheld = 0;
  let unheldOnly = 0;
  for (const r of data.rules) {
    const held = r.evidence.some((e) => e.exists);
    for (const e of r.evidence) if (!e.exists) unheld.add(e.leaf);
    if (r.evidence.some((e) => !e.exists)) citingUnheld += 1;
    if (r.evidence.length && !held) unheldOnly += 1;
  }
  const unheldNames = [...unheld]
    .sort((a, b) => a - b)
    .map((n) => `n${n}`)
    .join(', ');
  const scans = `/texts/${esc(t.slug)}/scans/`;
  /* NO RECORDED REPAIRS YET — a real state, not a broken page. The log is empty;
   * the whole scan is not. The old summary opened on the rule count, so it read
   * "0 recorded repairs in this version — . Every one is a rule" and then said
   * "the other 0 readings carry no page image": machinery describing nothing.
   * An edition published in repair says what it DOES hold (the scan) and what it
   * does not yet (readings), and the empty list is named rather than left blank. */
  const emptyLog =
    `<b>No repairs are recorded for this version yet.</b> The text is served as the transcription stands — ` +
    `the reading view and the transcription view are the same words — every damaged character visible and ` +
    `marked. Each emendation will appear here as a rule, with the words it changes, why it was made, and the ` +
    `page image it was decided from, as it is made. ` +
    (data.leafCount
      ? `THE WHOLE SCAN IS HERE: all ${data.leafCount} lea${data.leafCount === 1 ? 'f' : 'ves'} of the ` +
        `edition’s scan are stored with it, in leaf order, and every one of them opens and reads. No leaf ` +
        `carries a reading yet, which is stated where the leaf is opened and not hidden; the “All readings” ` +
        `entry is the list of readings and says so while it is empty. `
      : `No page image is stored with this edition either, so the page shows the statement of the state and ` +
        `nothing else until the first reading is recorded. `) +
    `The reading view applies every rule and the transcription view applies none, so once rules exist this ` +
    `list is the difference between the two.`;
  const summary = !data.ruleCount
    ? emptyLog
    : `${data.ruleCount} recorded repair${data.ruleCount === 1 ? '' : 's'} in this version — ` +
      byType.map((k) => `${data.counts[k]} ${k}`).join(', ') +
      `. Every one is a rule: the words it changes, why it was made, and the witness it rested on. ` +
      (data.leafCount
        ? `THE WHOLE SCAN IS HERE: all ${data.leafCount} lea${data.leafCount === 1 ? 'f' : 'ves'} of the edition’s ` +
          `scan are stored with it, in leaf order, and every one of them opens and reads. ` +
          (withImage
            ? `${withImage} readings cite a page image of this edition’s own scan — from ${citedLeaves} of ` +
              `the ${data.leafCount} leaves, which the index marks; the other ${noImage} readings carry no ` +
              `page ` +
              `image, and the other ${data.leafCount - citedLeaves} leaves carry no reading at all, which is ` +
              `stated where the leaf is opened and not hidden. `
            : `No reading in this version was decided from a page image, so no leaf carries one; the leaves are ` +
              `stored and shown all the same. `) +
          `The “All readings” entry lists every reading in the version, filtered by type or searched by word. `
        : `No page image is stored with this edition, so the readings are browsable from the “All readings” ` +
          `entry below, filtered by type or searched by word. `) +
      (citingUnheld
        ? `${citingUnheld} of the readings cite${citingUnheld === 1 ? 's' : ''} a leaf that is not held with this ` +
          `edition (${unheldNames}); the viewer names those leaves and shows no image for them` +
          (unheldOnly
            ? `, and ${unheldOnly} of them rest${unheldOnly === 1 ? 's' : ''} on no page image at all`
            : '') +
          `. `
        : '') +
      `The reading view applies every rule and the transcription view applies none, so this list is the ` +
      `difference between the two.`;
  const fallback =
    `<div class="app-fallback prose" id="app-fallback">` +
    `<p><b>The apparatus, and the page images.</b> ` +
    (data.leafCount
      ? `The edition’s WHOLE SCAN — all ${data.leafCount} lea${data.leafCount === 1 ? 'f' : 'ves'} — is stored ` +
        `with it and served beside the text, one image per leaf, at <a href="${scans}">${scans}</a>: every leaf ` +
        `the edition was read against, not only the leaves a reading was decided from. ` +
        (!data.ruleCount
          ? `No repair has been recorded for this version yet, so no reading stands beside a leaf; the leaf ` +
            `index is the whole scan, and the list of readings is empty until the first emendation is made. `
          : withImage
            ? `${withImage} of the readings in this version cite a page image of this edition’s own scan, and ` +
              `each is shown with the leaf it cites, so the evidence for a reading is a page a reader can open ` +
              `rather than a claim about one. ` +
              `The other ${noImage} readings carry no page image; they are listed in their own right, so the ` +
              `viewer is browsed by reading as well as by leaf and neither side is hidden behind the other.`
            : `No reading in this version was decided from a page image, so the apparatus reads from the list ` +
              `of readings rather than from the page images; every leaf of the edition’s scan is served all the ` +
              `same, and all ${noImage} readings carry no page image.`) +
        `</p>`
      : `No page image is stored with this edition, so the apparatus reads from the list of readings.</p>`) +
    `<p><b>The whole log, as data.</b> The apparatus of this version is one plain file, served with the ` +
    `edition: <a href="${esc(url)}">${esc(url)}</a> — ` +
    (data.ruleCount
      ? `every rule, with the words it changes, its reason, its witness, and the leaf it cites where the ` +
        `witness was one of this edition’s own pages, ` +
        `filterable by type and searchable by word there or in any other tool. `
      : `the version’s repair log in full. At this version it carries no rule yet, because no emendation has ` +
        `been made: it is the file each new rule will be written into, and the count of what has been ` +
        `repaired so far can be read from it directly. `) +
    `This page renders it in the viewer below; that viewer needs JavaScript, and without it the file linked ` +
    `here IS the apparatus, in full.</p>` +
    `<noscript><p>JavaScript is off, so the apparatus viewer does not run on this page. Nothing is hidden by ` +
    `that: the apparatus is the data file linked above, and every page image a reading was decided from is ` +
    `one of the leaves served at <a href="${scans}">${scans}</a>.</p></noscript>` +
    `</div>`;
  const html =
    `<div class="apparatus-viewer" id="apparatus-viewer" data-src="${esc(url)}" data-slug="${esc(t.slug)}" ` +
    `data-version="${esc(version)}">` +
    fallback +
    `<p class="app-status" id="app-status" role="status" aria-live="polite"></p>` +
    `<div class="app-controls" id="app-controls"></div>` +
    `<div class="app-browser">` +
    `<div class="app-leaves" id="app-leaves" role="tablist" aria-label="Every reading, and every stored leaf"></div>` +
    `<div class="app-panel" id="app-panel" role="tabpanel" aria-label="The readings of the selected entry"></div>` +
    `</div></div>`;
  return { html, summary, withScan: withImage, url, data };
}

/** The apparatus's SHORT digest, for the door on the edition page. Counted from
 * the record — never typed — so the line cannot advertise leaves or readings the
 * version does not hold: "The apparatus — 141 leaves, 105 readings read from a
 * page image →". A version with no stored leaf says its readings instead. */
function apparatusDigestLine(data) {
  const withImage = data.rules.filter((r) => r.evidence.some((e) => e.exists)).length;
  const bits = [];
  if (data.leafCount) bits.push(`${data.leafCount} lea${data.leafCount === 1 ? 'f' : 'ves'}`);
  /* A VERSION WITH NO RULES SAYS SO, rather than leaving the door to read as a
   * leaf count alone — which would advertise an apparatus of 722 leaves. */
  if (!data.ruleCount) {
    bits.push('no readings recorded yet');
  } else if (withImage) {
    bits.push(`${withImage} reading${withImage === 1 ? '' : 's'} read from a page image`);
  } else if (!data.leafCount) {
    bits.push(`${data.ruleCount} reading${data.ruleCount === 1 ? '' : 's'}`);
  }
  return `The apparatus — ${bits.join(', ')} →`;
}

/** THE APPARATUS'S OWN PAGE (its own route, its own canonical). The viewer is an
 * interface a reader goes to on purpose; on the edition page's eighty screens of
 * text it was buried under the whole reading view, which is the report this route
 * answers. `base` is the EDITION's base (bare or pinned), so the page fetches the
 * version's own apparatus.json and links back to the version's own edition page. */
function apparatusPageHtml(t, version, currentVersion, base, app) {
  const appBase = `${base}apparatus/`;
  const crumbs = [
    { label: 'Library', href: '/' },
    { label: 'Texts', href: '/texts/' },
    { label: t.author },
    { label: t.title, href: base },
    { label: 'The apparatus' },
  ];
  /* THE JUMP BAR (DESIGN-SYSTEM.md §5): the leaf rail and the panel are the page's
   * two regions and both are below the statement, so the page says they are there
   * and jumps to them. They are side by side and each is bounded, so this is a
   * convenience and not an escape — which is the point. */
  const onPage = contents(['app-leaves', 'The leaf index'], ['app-panel', 'The panel']);
  const back =
    `<p class="app-backlink prose">The edition this apparatus belongs to: ` +
    `<a href="${esc(base)}">${esc(t.title)}${version === currentVersion ? '' : ` (version ${esc(version)})`}</a>.</p>`;
  const body = onPage + section('The apparatus', app.summary, back + app.html, { id: 'the-apparatus', prose: false });
  return {
    rel: `${appBase.replace(/^\//, '')}index.html`,
    def: {
      title: `The apparatus of ${t.title} — ${SITE.host}`,
      shareTitle: `The apparatus of ${t.title}`,
      type: 'article',
      description: app.data.ruleCount
        ? `The apparatus of ${t.title}: every recorded repair in this version, with the leaf it was read from — ` +
          `the edition's whole scan in leaf order, and the readings decided from each leaf.`
        : `The apparatus of ${t.title}: the edition's whole scan in leaf order. No repair has been recorded ` +
          `for this version yet, and the page says so.`,
      eyebrow: `Apparatus · ${t.author}`,
      heading: 'The apparatus',
      standfirst: `${t.author} · ${t.year} · version ${version}`,
      navCurrent: appBase,
      crumbs,
      arrive: viewerScript(),
      body,
    },
  };
}

/** OLD `#repair-<id>` LINKS STILL RESOLVE. A reading lived on the edition page
 * until the apparatus moved to its own URL, so `/texts/<slug>/#repair-<id>` is a
 * published address (and the address /errata printed before this route existed),
 * and it must keep working. The edition page sends that fragment to the apparatus
 * page, which is where the viewer reads it. Only `#repair-` is touched: every
 * other fragment (`#the-text`, `#provenance`) belongs to this page. */
function repairRedirect(url) {
  return (
    `(function(){var h=window.location.hash;` +
    `if(/^#repair-/.test(h)){window.location.replace(${JSON.stringify(url)}+h);}})();`
  );
}

/* ---------- the pages: a text at one version, the index, the home ---------- */

/** THE PAGE'S OWN JUMP LIST (DESIGN-SYSTEM.md §5) — "On this page". The restored
 * TEXT, the APPARATUS and the PROVENANCE are below the fold, and the page says so
 * and jumps to them; the list is STICKY under the site nav (design/library.css
 * `.page-contents`), so the three regions stay reachable from anywhere on the
 * page, and it carries the back-to-top control at its end. `items` are
 * `[anchor, label]`. */
function contents(...items) {
  return (
    `<nav class="page-contents" aria-label="On this page"><div class="wrap">` +
    `<span class="pc-label">On this page</span><ol>` +
    items.map(([anchor, label]) => `<li><a href="#${anchor}">${esc(label)}</a></li>`).join('') +
    `</ol><a class="to-top" href="#top">↑ Top</a></div></nav>`
  );
}

/** One served edition AT ONE VERSION (model §3.1, plan §4).
 *
 * `base` is the page's own URL — `/texts/<slug>/` for the version
 * `current_version` selects, `/texts/<slug>/v/<semver>/` for a pinned one — and
 * everything the page links to hangs off it, so a pinned page's document fetch,
 * plain export and part pages are the PINNED ones. The citation shown is the
 * version's own (`meta.json`), so a citation to v1.0.0 keeps naming v1.0.0.
 *
 * Returns `{ pages, urls, doc }`: the pages to write, the URLs the sitemap wants,
 * and the extraction (so the caller writes `/t` and `/plain` from ONE reading of
 * the bytes, never two). */
export function libraryTextPages(t, doc, base, version, currentVersion, versionMeta) {
  const src = readEdition(t.slug, version);
  const a = assess(src, t.lang);
  const dir = base.replace(/^\//, '');
  const title = esc(t.title);
  const byline = `${esc(t.author)}${t.translator ? ` · tr. ${esc(t.translator)}` : ''} · ${t.year}`;
  const description =
    `${t.title} — ${t.author}${t.translator ? `, translated by ${t.translator}` : ''}, ${t.year}. ` +
    `A public-domain transcription of the printed edition, with the repairs recorded as rules.`;
  const page = (over) => ({
    // page() escapes the title once; `title` above is already escaped for the
    // heading and would be escaped twice here.
    title: `${t.title} — ${SITE.host}`,
    shareTitle: title,
    type: 'article',
    description,
    eyebrow: `Edition · ${t.author}`,
    heading: title,
    standfirst: byline,
    ...over,
  });

  /* THE SCHOLARLY ORDER (DESIGN-SYSTEM.md §5): the bibliographic record, the
   * citation block, the text, the apparatus, the provenance. The apparatus has
   * its OWN PAGE now (`/texts/<slug>/apparatus/`) — it was an interface buried
   * under the whole reading view — and what stands here is the SHORT summary and
   * the door to it, at the same `#the-apparatus` anchor the jump lists and
   * /errata used before, so no published link moved. /errata remains the
   * site-wide corrections log, not the place an edition's own rules are read.
   *
   * THE HEADINGS ARE NOT DOUBLED. MEASURED on the review's screenshot: a
   * section's small-caps sub-label read as a SECOND heading beside its own
   * ("The edition" over "THE BIBLIOGRAPHIC RECORD"), and the version was printed
   * three times. So the two section descriptions that merely restated the
   * heading are gone, and the version is stated where it belongs: inside the
   * citation string and in the version notice below. */
  const bib = section('The edition', null, bibRecordHtml(t), { id: 'the-edition' });
  const cite = section('How to cite', null, citationBlockHtml(base, versionMeta), { id: 'how-to-cite' });
  const app = apparatusViewerHtml(t, version, base);
  const appPath = `${base}apparatus/`;
  /* THE DOOR TO THE APPARATUS. Its counts come from the record the viewer
   * fetches (never typed), and its own page carries the whole interface — the
   * edition page keeps the text, which is what it is for. */
  const apparatus = section(
    'The apparatus',
    'the version’s whole repair log — its own page',
    `<p class="app-link"><a class="app-open" href="${esc(appPath)}">${apparatusDigestLine(app.data)}</a></p>` +
      (app.data.ruleCount
        ? `<p>Every recorded repair, with the words it changes, why it was made and the witness it rested on, ` +
          `browsed on its own page by reading and by leaf: the edition’s whole scan in leaf order, the readings ` +
          `decided from each leaf, and the readings that carry no page image listed in their own right. The log is ` +
          `also served with the edition as one plain file at <a href="${esc(app.url)}">${esc(app.url)}</a>.</p>`
        : `<p>No repair has been recorded for this version yet, so the apparatus carries no reading: it opens ` +
          `on the edition’s WHOLE SCAN in leaf order, every leaf of it readable, and says so where each leaf is ` +
          `opened. The log is also served with the edition as one plain file at ` +
          `<a href="${esc(app.url)}">${esc(app.url)}</a>, and each emendation will be written into it as it is ` +
          `made.</p>`),
    { id: 'the-apparatus' },
  );

  /* WHERE THE PAGE SITS, and what is on it. A breadcrumb back into the shelf,
   * and an in-page contents list — because the restored TEXT and the APPARATUS
   * are below the fold and a reader has to be told they are there (DESIGN-SYSTEM
   * §5). The sections carry ids for it; nothing else about them moves. */
  const crumbs = [
    { label: 'Library', href: '/' },
    { label: 'Texts', href: '/texts/' },
    { label: t.author },
    { label: t.title },
  ];
  /* The apparatus entry names the page images only when the version actually
   * carries a leaf — derived from the apparatus, never typed, so the label
   * cannot advertise images an edition does not hold. */
  const appLabel = app.withScan ? 'The apparatus, with the page images' : 'The apparatus';

  if (!a.readable) {
    const body =
      contents(['the-edition', 'The edition'], ['how-to-cite', 'How to cite'], ['the-apparatus', appLabel]) +
      bib +
      cite +
      apparatus +
      section('Why there is no text here', 'measured on the transcription itself', unreadableHtml(t, a), {
        id: 'no-text',
      }) +
      section(
        'Provenance',
        'the edition, and what was done to it',
        provenanceHtml(t, t.readings || [], null, a, null, null, base),
        { id: 'provenance' },
      );
    const appPage = apparatusPageHtml(t, version, currentVersion, base, app);
    return {
      urls: [base, appPath],
      pages: [
        { rel: `${dir}index.html`, def: page({ body, navCurrent: base, crumbs, arrive: repairRedirect(appPath) }) },
        appPage,
      ],
    };
  }

  const plainDoc = preprocess(src, {});
  const stats = {
    ...plainDoc.stats,
    h2: plainDoc.blocks.filter((b) => b.type === 'heading' && b.level === 2).length,
  };
  const parts = partition(plainDoc, LIBRARY_MAX_BYTES).map((p) => ({
    title: p.title,
    html: gateSafeText(renderBlocks(p.blocks), t.slug),
    paragraphs: countParagraphs(p.blocks),
    headings: p.blocks.filter((b) => b.type === 'heading').length,
  }));

  const lib = counts(doc);
  /* THE VERSION NOTICE: a pinned page says it is pinned, and where the current
   * version is. Not decoration — a reader who followed a citation to v1.0.0 is
   * owed the fact that the library has moved on (and vice versa). */
  const current = version === currentVersion;
  const versionNotice = current
    ? `<p><b>Version ${esc(version)} — current.</b> This is the version a bare ` +
      `<a href="/texts/${t.slug}/">/texts/${esc(t.slug)}/</a> serves. A new version is a new URL; this one is ` +
      `kept, so a citation to it keeps resolving.</p>`
    : `<p><b>Version ${esc(version)} — pinned.</b> The current version is ` +
      `<a href="/texts/${t.slug}/">${esc(currentVersion)}</a>, which may differ. This page is the edition as ` +
      `it stood at ${esc(version)}, and it is never rewritten.</p>`;
  const licence =
    `<p><b>Licence.</b> The transcription is <b>public domain</b>; the editorial work — repairs, page ` +
    `models, apparatus, notes — is <b>${esc(t.licenceEditorial)}</b>. ` +
    `${esc(SITE.licence.statement)} See <a href="/about/">about</a> for the full statement.</p>`;
  const readings =
    t.readings && t.readings.length
      ? `<p><b>Attached readings.</b> ${t.readings
          .map((s) => `<a href="${SITE.blog.url}/${s}/">${esc(s)}</a>`)
          .join(', ')} — essays on the blog, linked out.</p>`
      : `<p><b>Attached readings.</b> No essay is attached to this edition yet.</p>`;

  const prov =
    versionNotice +
    provenanceHtml(t, t.readings || [], stats, a, measureDamage(src, plainDoc), lib, base) +
    readings +
    licence;
  const urls = [base];
  const pages = [];

  if (parts.length === 1) {
    const hint = `the transcription, unedited — ${stats.parasOut} paragraphs`;
    const transcription = section('The text', hint, parts[0].html, { before: toc(parts[0].html) });
    /* THE TEXT COMES BEFORE THE APPARATUS and the provenance stands BELOW both
     * (the blog's own correction, kept): the page exists for the book; the
     * apparatus is what a reader goes looking for after they have the text. */
    const provSection = section('Provenance', 'the edition, what was done to it, and what it gets wrong', prov, {
      id: 'provenance',
    });
    const onPage = contents(
      ['the-edition', 'The edition'],
      ['how-to-cite', 'How to cite'],
      ['the-text', 'The text'],
      ['the-apparatus', appLabel],
      ['provenance', 'Provenance'],
    );
    const def = doc
      ? page({
          body: onPage + bib + cite + readerShell(t, doc, transcription, base) + apparatus + provSection,
          navCurrent: base,
          crumbs,
          head: `<style>\n${stripComments(READER_CSS)}</style>`,
          arrive: repairRedirect(appPath),
        })
      : page({
          body: onPage + bib + cite + transcription + apparatus + provSection,
          navCurrent: base,
          crumbs,
          arrive: repairRedirect(appPath),
        });
    pages.push({ rel: `${dir}index.html`, def });
    pages.push(apparatusPageHtml(t, version, currentVersion, base, app));
    urls.push(appPath);
    return { urls, pages, doc };
  }

  /* TOO BIG FOR ONE PAGE: the parent carries the furniture, the READER APP and
   * the way in; each part carries its own stretch of the text and the way to its
   * neighbours. The parent no longer inlines the whole transcription — inlining
   * it is what made the page too big — so the server-rendered copy it carries is
   * the edition's first section (`readerShell` with an empty legacy section), and
   * the whole text is the app's own document, the plain file, and the parts. The
   * app is not optional: a served edition's page mounts the reader (DATA-MODEL
   * §3.1, and route-probe checks it), and the app fetches `/texts/<slug>/t` — the
   * WHOLE document, whatever the prose is split into here. */
  const partPath = (i) => `${base}part-${i + 1}/`;
  const partRel = (i) => `${dir}part-${i + 1}/index.html`;
  const index =
    `<ol>` +
    parts
      .map(
        (p, i) =>
          `<li><a href="${partPath(i)}">${esc(p.title || `part ${i + 1}`)}</a> ` +
          `<span class="dim">— ${p.paragraphs} paragraphs</span></li>`,
      )
      .join('') +
    `</ol>`;
  pages.push({
    rel: `${dir}index.html`,
    def: page({
      body:
        contents(
          ['the-edition', 'The edition'],
          ['how-to-cite', 'How to cite'],
          ['the-text', 'The text'],
          ['the-apparatus', appLabel],
          ['the-parts', 'The text, in parts'],
          ['provenance', 'Provenance'],
        ) +
        bib +
        cite +
        (doc ? readerShell(t, doc, '', base) : '') +
        apparatus +
        section('Provenance', 'the edition, and what was done to it', prov, { id: 'provenance' }) +
        section(
          'The text, in parts',
          `this text is served in ${parts.length} parts, split where the edition itself divides`,
          index,
          { id: 'the-parts' },
        ),
      navCurrent: base,
      crumbs,
      // the app's own stylesheet, as on the single-page edition: the reader is
      // mounted here too, and without it the app renders unstyled
      ...(doc ? { head: `<style>\n${stripComments(READER_CSS)}</style>` } : {}),
      arrive: repairRedirect(appPath),
    }),
  });
  pages.push(apparatusPageHtml(t, version, currentVersion, base, app));
  urls.push(appPath);
  parts.forEach((p, i) => {
    urls.push(partPath(i));
    const pager =
      `<div class="hint">` +
      parts.map((_, j) => (j === i ? `<b>${j + 1}</b>` : `<a href="${partPath(j)}">${j + 1}</a>`)).join(' · ') +
      ` · <a href="${base}">the whole text</a></div>`;
    const body =
      contents(
        ['the-text', 'The text'],
        ['provenance', 'Provenance'],
        ['the-parts', 'Where this part sits'],
      ) +
      section('The text', `part ${i + 1} of ${parts.length} — ${p.headings} headings`, p.html, {
        id: 'the-text',
        before: toc(p.html),
        after: pager,
      }) +
      section('Provenance', 'the edition, and what was done to it', prov, { id: 'provenance' }) +
      section('Where this part sits', 'the other parts of this text', index, { id: 'the-parts' });
    pages.push({
      rel: partRel(i),
      def: page({
        heading: `${title} — part ${i + 1}`,
        standfirst: byline,
        body,
        navCurrent: partPath(i),
        crumbs: [...crumbs.slice(0, -1), { label: `${t.title} — part ${i + 1}` }],
      }),
    });
  });
  return { urls, pages, doc };
}

/* ---------- the index and the home ---------- */

/* ---------- the catalogue (DESIGN-SYSTEM.md §5) ---------- */

/** WHAT A REPAIR STATE MEANS, in plain words, kept beside the label so the pill
 * beside a title is explained where it is met (the legend and each pill's
 * `title` both read from here). The states are DATA-MODEL §3's values. */
const REPAIR_MEANING = {
  repaired: 'finished — every residue settled or deliberately left and recorded',
  'in-repair': 'readable end to end, not yet finished',
  damaged: 'readable, with the transcription’s own damaged characters shown throughout',
};

/** The states a served edition can be in, in the order the catalogue names them
 * when it explains them (worst first, as the shelf page always has). */
const REPAIR_STATES = ['damaged', 'in-repair', 'repaired'];

/** The factual axes the catalogue can be ordered by: the corpus's own metadata —
 * the author's name, the work's title, the year of the printed edition. None of
 * these is a reading of what the texts mean, and the list carries no
 * interpretation. */
const CATALOGUE_SORT = [
  ['author', 'Author'],
  ['title', 'Title'],
  ['year', 'Year'],
];

/** A catalogue sorts an author under a SURNAME. Most of these authors are known
 * by a single name — "Plotinus", "Proclus", "Porphyry" — which IS their
 * cataloguing name, so the rule is the last word of the name, with the article
 * of an anonymous or title-work entry dropped ("The Pali canon" → "Pali canon")
 * and a trailing epithet stripped ("Dionysius the Areopagite" → "Dionysius",
 * "Hildegard of Bingen" → "Hildegard"). The three names where the last word is
 * still not the cataloguing name are listed explicitly. A name the map does not
 * know falls through to the rule, so a new shelf entry sorts sensibly. */
const SORT_NAME = {
  'Hermes Trismegistus': 'Hermes',
  'Marcus Aurelius Antoninus': 'Marcus Aurelius',
  'Evagrius Ponticus': 'Evagrius',
};
function surnameOf(author) {
  let s = String(author || '').trim();
  s = s.split(/\s+and\s+/i)[0].trim(); // the first of several authors
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ').trim(); // drop a qualifier such as (attrib.)
  if (!s) return '';
  const comma = s.indexOf(',');
  if (comma >= 0) s = s.slice(0, comma).trim(); // "Surname, Forename"
  if (Object.prototype.hasOwnProperty.call(SORT_NAME, s)) return SORT_NAME[s];
  if (/^(the|a|an)\b/i.test(s) || /^anon\b/i.test(s)) return s.replace(/^(the|a|an)\s+/i, '');
  const ep = /^(.*?)\s+(?:the|of)\s+\S/i.exec(s);
  if (ep) s = ep[1].trim();
  const words = s.split(/\s+/);
  return words[words.length - 1];
}

/** A sort key: case- and diacritic-insensitive, so a title or a name with an
 * accent sorts beside the unaccented spelling. The catalogue's data- attributes
 * carry this SAME key, so the control's order and the served order cannot
 * disagree about what "by author" or "by title" means. */
const sortKey = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** The default order (DESIGN-SYSTEM.md §5): author (surname), then title. This
 * is the order a reader without scripts is served, and the order the control's
 * Author button restores. */
function byAuthorThenTitle(a, b) {
  const ka = sortKey(surnameOf(a.author));
  const kb = sortKey(surnameOf(b.author));
  if (ka !== kb) return ka < kb ? -1 : 1;
  const ta = sortKey(a.title);
  const tb = sortKey(b.title);
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

/** The catalogue entry: author · translator · year · version · repair state
 * (DESIGN-SYSTEM.md §5). The title is the link; the state is the pill beside it,
 * legible and explained (its `title` is the plain-language meaning); the rest is
 * one line of facts. The data- attributes are the catalogue's own keys. */
function catalogueEntry(t) {
  const rep = repairOf(t);
  const state = rep ? rep.state : '';
  const label = rep ? REPAIR_LABELS[state] || state : '';
  const badge = rep
    ? ` <span class="tag tag-${esc(state)}" title="${esc(REPAIR_MEANING[state] || label)}">${esc(label)}</span>`
    : '';
  const meta = [
    t.author,
    t.translator ? `tr. ${t.translator}` : '',
    String(t.year),
    t.currentVersion ? `v${t.currentVersion}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    `<li class="cat-entry" data-a="${esc(sortKey(surnameOf(t.author)))}"` +
    ` data-t="${esc(sortKey(t.title))}" data-y="${esc(String(t.year))}"` +
    ` data-state="${esc(state)}">` +
    `<p class="title"><a href="/texts/${t.slug}/">${esc(t.title)}</a>${badge}</p>` +
    `<p class="cat-meta">${esc(meta)}</p></li>`
  );
}

/** THE CATALOGUE — the served editions, on the library's OWN terms: one list,
 * ordered by author (surname) then title, with a factual control to re-order it
 * (Author · Title · Year) and a factual filter (the repair state), and a legend
 * that says what the state pill means. No collection labels and no interpretive
 * line: a corpus is described as a corpus. Shared by `/` and `/texts/` — the
 * same component on both (DESIGN-SYSTEM.md §5). */
export function catalogueHtml(served) {
  const states = REPAIR_STATES.filter((s) => served.some((t) => repairOf(t).state === s));
  const sorts =
    `<div class="cc-group"><span class="cc-label">Sort</span>` +
    CATALOGUE_SORT.map(
      ([key, label]) =>
        `<button type="button" class="cc-sort${key === 'author' ? ' cc-on' : ''}" data-sort="${esc(key)}"` +
        ` aria-pressed="${key === 'author'}">${esc(label)}</button>`,
    ).join('') +
    `</div>`;
  const filter = states.length
    ? `<div class="cc-group"><span class="cc-label">Show</span>` +
      states
        .map((s) => {
          const n = served.filter((t) => repairOf(t).state === s).length;
          return (
            `<label class="cc-state">` +
            `<input type="checkbox" data-cstate="${esc(s)}" checked> ` +
            `<span class="tag tag-${esc(s)}">${esc(REPAIR_LABELS[s] || s)}</span> ` +
            `<span class="cc-n">${n}</span></label>`
          );
        })
        .join('') +
      `</div>`
    : '';
  const legend =
    `<p class="cat-legend">The tag beside a title is the edition’s repair state: ` +
    states
      .map(
        (s) =>
          `<span class="tag tag-${esc(s)}">${esc(REPAIR_LABELS[s] || s)}</span> ${esc(REPAIR_MEANING[s])}`,
      )
      .join(' · ') +
    `.</p>`;
  const entries = [...served].sort(byAuthorThenTitle).map(catalogueEntry).join('');
  return (
    `<div class="catalogue" data-catalogue>` +
    `<div class="catalogue-controls">${sorts}${filter}</div>` +
    legend +
    `<ul class="entries">${entries}</ul>` +
    `</div>`
  );
}

/** The catalogue's control: a comment-free inline script (the leak gate reads a
 * comment delimiter in emitted code as a leak). It re-orders the entries by the
 * keys the build already wrote (data-a / data-t / data-y) and hides the states
 * whose box is unticked. Without scripts the reader keeps the served order (by
 * author) and the whole catalogue — the control only narrows what is already
 * there. */
const CATALOGUE_JS = `(function () {
  var cat = document.querySelector('[data-catalogue]');
  if (!cat) return;
  var list = cat.querySelector('ul.entries');
  if (!list) return;
  var items = [].slice.call(list.children);
  var boxes = [].slice.call(cat.querySelectorAll('input[data-cstate]'));
  var buttons = [].slice.call(cat.querySelectorAll('button[data-sort]'));
  var key = 'author';
  function cmp(a, b) {
    if (key === 'year') {
      var ya = a.getAttribute('data-y') || '';
      var yb = b.getAttribute('data-y') || '';
      if (ya !== yb) return ya < yb ? -1 : 1;
    } else {
      var an = key === 'title' ? 'data-t' : 'data-a';
      var ka = a.getAttribute(an) || '';
      var kb = b.getAttribute(an) || '';
      if (ka !== kb) return ka < kb ? -1 : 1;
    }
    var ta = a.getAttribute('data-t') || '';
    var tb = b.getAttribute('data-t') || '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  }
  function paint() {
    var on = {};
    for (var i = 0; i < boxes.length; i++) on[boxes[i].getAttribute('data-cstate')] = boxes[i].checked;
    for (var j = 0; j < items.length; j++) {
      var st = items[j].getAttribute('data-state');
      items[j].hidden = on[st] === false;
    }
    items.sort(cmp);
    for (var k = 0; k < items.length; k++) list.appendChild(items[k]);
    for (var m = 0; m < buttons.length; m++) {
      var sel = buttons[m].getAttribute('data-sort') === key;
      buttons[m].classList.toggle('cc-on', sel);
      buttons[m].setAttribute('aria-pressed', sel ? 'true' : 'false');
    }
  }
  for (var i = 0; i < boxes.length; i++) boxes[i].addEventListener('change', paint);
  for (var j = 0; j < buttons.length; j++) {
    buttons[j].addEventListener('click', function () {
      key = this.getAttribute('data-sort');
      paint();
    });
  }
})();`;

/** `/texts/` — the catalogue (DESIGN-SYSTEM.md §5): the SAME component as the
 * home, on the corpus's own terms. It states what the shelf holds, what is
 * served here now, and what is not here at all — and then lists the editions,
 * ordered by author. Nothing on it reads the corpus as an argument. */
export function buildTextsIndex(served, allTexts) {
  const heldBack = allTexts.filter((t) => !served.some((s) => s.slug === t.slug));
  const servedNow = heldBack.length
    ? `<p><b>What is served here now.</b> The shelf names ${allTexts.length} texts. ` +
      `${served.length} of them ${served.length === 1 ? 'is' : 'are'} served here — ` +
      `${served.map((t) => `<a href="/texts/${t.slug}/">${esc(t.title)}</a>`).join(', ')} — and ` +
      `${heldBack.length} ${heldBack.length === 1 ? 'is' : 'are'} held back until its transcription is ` +
      `worth reading. A text is served when its own edition has been through the whole pipeline, not ` +
      `when the library as a whole is.</p>`
    : '';
  const modern = MODERN_EDITIONS.map((m) => `${m.who}’s ${m.what}`).join('; ');
  const preamble =
    `<p>This is the catalogue: public-domain editions of the works of the Platonic tradition, ` +
    `each a transcription of a printed book — the scanner’s own characters, kept — and some ` +
    `carrying REPAIRS, applied by the reading view and never baked into the words served. A ` +
    `repaired edition reads cleanly where a reading could be determined from a witness — the ` +
    `transcription’s own context, or a parallel edition of the same translation — and shows its ` +
    `damage, marked, where none could be: it never silently says anything the print does not. ` +
    `Every repair is a rule with the words it changes, why, and how often it fires, listed in the ` +
    `reader, so the two views can be read against each other and the difference between them is ` +
    `that list.</p>` +
    `<p><b>Each edition carries its whole scan.</b> ` +
    `Every leaf of it is stored with the edition and served beside its text, one image per leaf, so ` +
    `the leaf a repair cites can be opened and checked against the words it was decided from, and a ` +
    `leaf no reading used is readable all the same. Where a reading cites a leaf the edition does ` +
    `not hold, the citation stands and the edition’s own page says so.</p>` +
    `<p>The catalogue is ordered by author, then by title, and can be re-ordered by title or by ` +
    `year and narrowed to the editions in a given repair state. Every text page says which edition ` +
    `it is, what was done to it and what was not, and which essays are attached to that work — so a ` +
    `quotation can be checked against the edition it came from.</p>` +
    `<p><b>What is not here, and why.</b> The modern scholarly editions are not here: ${esc(modern)}, ` +
    `and the current occult presses’ editions. They are not absent by oversight. They carry a living ` +
    `translator’s or publisher’s rights, they belong to the people who made them, and this shelf ` +
    `stops where their work begins. What the shelf can hold is what nobody owns any more.</p>`;
  const notes =
    `<section><div class="wrap"><h2 id="about-the-shelf">About this shelf</h2>` +
    `<div class="hint">what it is, what was done to the texts, and what is not here</div>` +
    `<div class="prose">${preamble}</div></div></section>`;

  /* WHAT A READER NEEDS BEFORE THEY OPEN A TEXT, stated ABOVE the list: some of
   * these editions are readable and NOT FINISHED. The tag beside a title says
   * which state an edition is in; this paragraph says what the states mean, and
   * covers every state a served edition is actually in (the same statement the
   * blog's index made, kept because the model's `repair_state` exists to be
   * shown, not stored). */
  const byState = (st) => served.filter((t) => repairOf(t).state === st);
  const damaged = byState('damaged');
  const inRepair = byState('in-repair');
  const repaired = byState('repaired');
  const names = (ts) => ts.map((t) => `<a href="/texts/${t.slug}/">${esc(t.title)}</a>`).join(', ');
  const tag = (st) => `<span class="tag">${esc(REPAIR_LABELS[st] || st)}</span>`;
  const sentences = [];
  if (damaged.length) {
    sentences.push(
      `${damaged.length === 1 ? 'One is' : `${damaged.length} are`} ${tag('damaged')} — ${names(damaged)}: ` +
        `readable, damaged, and not yet repaired, so the reading view shows the transcription's own characters ` +
        `throughout.`,
    );
  }
  if (inRepair.length) {
    sentences.push(
      `${inRepair.length === 1 ? 'One is' : `${inRepair.length} are`} ${tag('in-repair')} — ${names(inRepair)}: ` +
        `readable end to end and NOT finished — its repair is still open. A place the transcription's own ` +
        `context and a parallel edition of the same translation could not settle is cleared against the printed ` +
        `page image itself and recorded as a rule; until it is cleared, the reader shows the transcription's own ` +
        `damaged characters, marked — it never guesses in the print's name. An edition that has not yet had its ` +
        `first emendation recorded carries no rules and says so on its own page, and its damage shows the same ` +
        `way.`,
    );
  }
  if (repaired.length) {
    sentences.push(
      `${repaired.length === 1 ? 'One is' : `${repaired.length} are`} ${tag('repaired')} — ${names(repaired)}: ` +
        `finished, every residue settled or deliberately left and recorded.`,
    );
  }
  const heldBackNote = heldBack.length
    ? ` The ${heldBack.length} held back are not served as editions yet, and none has been repaired: ` +
      `they are ${tag('damaged')} — every transcription here carries the scanner's damage, and these have not ` +
      `been worked on.`
    : '';
  const unfinished = damaged.length + inRepair.length;
  const head = unfinished
    ? `<b>Some of these editions are not finished.</b> `
    : `<b>These editions are ${esc(REPAIR_LABELS[repaired.length ? 'repaired' : 'damaged'])}.</b> `;
  const repairNote = sentences.length
    ? `<p>${head}An edition here can be readable and not yet ` +
      `repaired, being repaired, or finished, and the tag beside its name says which. ${sentences.join(' ')}` +
      `${heldBackNote} The tag is repeated on each text's own page, where the apparatus opens ` +
      `the corrections that edition carries: by leaf, with the page image each was read from, and as a list ` +
      `of every reading for the many that have no page image.</p>`
    : '';

  return {
    title: `The texts — ${SITE.host}`,
    shareTitle: 'The texts',
    type: 'website',
    description:
      'The catalogue: public-domain editions of the works of the Platonic tradition, ordered by author — with the modern editions, and the reasons, named as absent.',
    eyebrow: 'The shelf',
    heading: 'The texts',
    standfirst: 'Public-domain editions of the printed originals, ordered by author.',
    arrive: CATALOGUE_JS,
    body:
      `<section><div class="wrap"><div class="prose">${repairNote}${servedNow}</div></div></section>` +
      `<section><div class="wrap">${catalogueHtml(served)}</div></section>` +
      notes,
    navCurrent: '/texts/',
  };
}

/** `/` — the reading room (DESIGN-SYSTEM.md §5): the catalogue IS the home page,
 * with the collection's scope, the search field and the doors stated ABOVE it —
 * MEASURED on the deployed home, the search block sat stranded below the
 * catalogue, past a dead stretch of page. No blog hero, no feed. */
export function buildHome(served) {
  const n = served.length;
  /* THE COLLECTION'S SCOPE, stated before the catalogue: how much is here, how
   * to search it, and the way to the shelf page. Both the count and the link are
   * DERIVED (the count from the served list, the link to the shelf's own route),
   * so the component scales with the corpus and cannot go stale. */
  const scope =
    `<p class="scope-count"><b>${n} edition${n === 1 ? '' : 's'}</b> ${n === 1 ? 'is' : 'are'} served here — ` +
    `each a transcription of a printed book, with every repair recorded as a rule and readable beside its own text.</p>`;
  const search =
    `<form class="search-field" action="/search/" method="get" role="search">` +
    `<label for="q">Search the texts</label>` +
    `<div class="row">` +
    `<input type="search" id="q" name="q" placeholder="proclus, hyparxis, cave of the nymphs…" ` +
    `autocomplete="off"> <button type="submit">Search</button></div></form>`;
  const more =
    `<p class="scope-more"><a class="all-texts" href="/texts/">All texts →</a> ` +
    `<span class="dim">the whole catalogue, and what is not here.</span></p>`;
  const doors =
    `<p class="home-doors">` +
    `<a href="/graph/">the transmission graph</a><span class="sep">·</span>` +
    `<a href="/editions/">editorial policy</a><span class="sep">·</span>` +
    `<a href="/about/">about &amp; licence</a><span class="sep">·</span>` +
    `<a href="/errata/">errata</a></p>`;
  return {
    title: `The Neoplatonic Library — ${SITE.host}`,
    shareTitle: 'The Neoplatonic Library',
    type: 'website',
    description:
      'A public-domain library of the Platonic tradition: transcriptions of the printed originals, their repairs recorded as rules, and one reading’s essays linked out to the blog.',
    arrive: CATALOGUE_JS,
    body:
      `<section class="collection-scope"><div class="wrap">${scope}${search}${more}${doors}</div></section>` +
      `<section><div class="wrap">${catalogueHtml(served)}</div></section>`,
    navCurrent: '/',
  };
}

export { measureDamage, editionHtml, provenanceHtml, unreadableHtml, readerShell, readerTocHtml, readerSectionHtml, logPageModel, READER_CSS, READER_BOOT, DAMAGED_TITLE, LIBRARY_MAX_BYTES, editionDocs };
