/**
 * tools/library-smoke.mjs — runtime test for the standalone library.
 *
 * ADAPTED from the blog's tools/library-smoke.mjs (extraction plan §6): the
 * dist root is site/dist, the library tree is site/dist/texts/, and the two
 * blog-coupled sections are rewritten or dropped —
 *
 *   §5 "readings cited by" now reads `edition.readings[]` from the edition
 *      record instead of recomputing the blog's note derivation;
 *   §6 "the site around the library" now checks the standalone home, sitemap
 *      and command line, and that nothing links the blog's old /library/ tree;
 *   §7 (the blog reading's citations resolving INTO the library) is DROPPED:
 *      that reading is a blog page this repo does not build, and the fragment
 *      promise is the anchor gate plus tools/version-probe.mjs.
 *
 * The build gates prove every page is valid and leaks nothing; they do not prove
 * the library says something TRUE about the shelf. This reads the BUILT pages
 * under site/dist/texts/ and checks them against the shelf and the editions
 * themselves, recomputing every expectation from the source text — nothing here
 * is hard-coded from the build's own report, because an expectation copied from
 * the thing under test asserts only that the build is self-consistent.
 *
 *     node build/build.mjs && node tools/library-smoke.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEXTS, shelfFiles, textSource, isPublished, REPAIR_LABELS } from './shelf.mjs';
import { BASE } from '../build/shell.mjs';
import { LIBRARY_PAGE_MAX_BYTES } from '../build/library.mjs';
import { preprocess, joinLines, assess, countParagraphs } from './reader.mjs';
import { readEdition, hasEdition, editionRecord } from './extract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'site', 'dist');
const LIB = join(DIST, 'texts');

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};
const section = (name) => console.log(`\n${name}`);

/* ---------- 1. the reader's transforms, unit-tested ---------- */

section('the reader (unit)');
const cases = [
  ['double spaces collapse to one', joinLines(['a  double   spaced   line']), 'a double spaced line'],
  ['a hard-wrapped line is joined with a space', joinLines(['the end of one line', 'and the start of the next']), 'the end of one line and the start of the next'],
  ['a hyphen across a line break is dropped (lower case next)', joinLines(['let-', 'ters']), 'letters'],
  ['a compound keeps its hyphen', joinLines(['self-', 'knowledge']), 'self-knowledge'],
  ['a break before a capital keeps its hyphen', joinLines(['Anglo-', 'Saxon']), 'Anglo-Saxon'],
  ['a break inside a capitalised word is still the printer’s', joinLines(['Craty-', 'lus']), 'Cratylus'],
];
for (const [name, got, want] of cases) {
  check(got === want, `${name}: ${JSON.stringify(got)}${got === want ? '' : ` (wanted ${JSON.stringify(want)})`}`);
}
{
  const two = preprocess('one paragraph\n\nand a second one\n');
  check(countParagraphs(two.blocks) === 2 && two.stats.parasIn === two.stats.parasOut,
    `a blank line ends a paragraph (${countParagraphs(two.blocks)} paragraphs read, ${two.stats.parasIn} in / ${two.stats.parasOut} out)`);
  const heading = preprocess('CHAPTER I\n\nsome text follows\n');
  check(heading.stats.headings === 1 && heading.blocks[0].level === 2 && heading.stats.parasOut === 1,
    `an all-caps division line is read as a heading and not as a paragraph (${heading.stats.headings} heading, ${heading.stats.parasOut} paragraph)`);
  const lossy = preprocess('  spaced   text  \n\nsecond  \n');
  check(lossy.stats.parasIn === lossy.stats.parasOut && lossy.stats.parasOut === 2,
    'no paragraph is lost between the read and the write');
}

/* ---------- the shelf ---------- */

/* WHAT THIS TREE SHOULD HOLD (plan §11 phase 5). Publication is per text and it
 * lives on the shelf entry, so the smoke asks the shelf the same question the
 * build asks: the PUBLISHED texts are what a default build serves, and LIBRARY=1
 * (the preview switch) means every entry was built. The two states are asserted
 * ASYMMETRICALLY — a published text MUST have its pages, an unpublished one must
 * have none — because a build that quietly serves a text its entry does not
 * publish is the defect this flag exists to make impossible. */
// LIBRARY=1 is the BUILD's preview flag (it builds every entry regardless), but
// what a page SERVES is the per-text `published` flag (plan §11 phase 5). The two
// were the same thing before phase 5 and are not any more: a previewed tree
// builds the held-back entries so the reader and these checks can see them, while
// the expected page set still follows `published`. So the expectation is built
// from the flag, and the BUILD does not change it.
/* The standalone build has NO preview switch: what is published on the shelf is
 * what the build emits (plan §1.2 — LIBRARY=1 is a blog-build flag and does not
 * come over). So the expected set and the served set are the same one. */
const SERVED = TEXTS.filter(isPublished);
const BUILT_EXTRA = [];
const HELD = TEXTS.filter((t) => !SERVED.includes(t));
// What the TREE carries: the published texts, plus — in a preview build — the
// held-back ones the build was explicitly asked for. The assertions separate the
// two questions: what the shelf PUBLISHES (SERVED) and what this build EMITS.
const EMITTED = TEXTS.filter((t) => SERVED.includes(t) || BUILT_EXTRA.includes(t));
// What this TREE holds back: not published, and not emitted either.
const WITHHELD = TEXTS.filter((t) => !EMITTED.includes(t));
const BUILT = existsSync(LIB);

if (!BUILT && SERVED.length > 0) {
  console.error(
    `library-smoke: ${SERVED.length} text(s) are published on the shelf ` +
      `(${SERVED.map((t) => t.slug).join(', ')}) but site/dist/texts/ is not built — ` +
      'the build did not serve what the shelf publishes.',
  );
  process.exit(1);
}
if (!BUILT) {
  // Nothing is published and nothing is previewed: the shelf is held back whole,
  // so the library's own pages have nothing to check. What is still checked —
  // because this is the state the whole per-text flag is FOR — is that nothing
  // on the site points at the library: no nav entry, no command-line entry, no
  // sitemap address, no line in the 404. (A tree with pages for a held-back text
  // does not reach this branch: it falls through to the checks above and fails
  // there.) That is a skip of the library's pages, not of the publication rule.
  console.log(
    `library-smoke: nothing is published (${TEXTS.length} texts on the shelf, none marked published) and this is not a preview build`,
  );
  const files = [
    ['index.html', readFileSync(join(DIST, 'index.html'), 'utf8')],
    ['404.html', readFileSync(join(DIST, '404.html'), 'utf8')],
    ['sitemap.xml', readFileSync(join(DIST, 'sitemap.xml'), 'utf8')],
  ];
  let leak = 0;
  for (const [rel, text] of files) {
    const hits = (text.match(/\/texts\//g) || []).length;
    if (hits) leak += hits;
    check(hits === 0, `${rel}: no reference to /texts/ with nothing published (${hits})`);
  }
  check(leak === 0, 'and the site is silent about a library it does not serve');
  // FAILS IF: the nav entry, the command-line entries, the sitemap addresses or
  // the 404's list are emitted whatever the shelf publishes — the trace of the
  // library on a site that has none.
  console.log('library-smoke: PASSED (the library is held back whole)');
  process.exit(failures === 0 ? 0 : 1);
}
let shelfFileSet = null;
/* The external scan shelf (~/thework/work-text) need not exist for the BUILD, and
 * the standalone repo does not consult it for a text with a stored edition. It is
 * read lazily, and only for a text that has NO stored edition. */
const files = () => (shelfFileSet = shelfFileSet || shelfFiles());
/* A text with a STORED EDITION is read from the edition, not the shelf — the
 * same decision the build makes (tools/build.mjs `libraryTextPages`): the page
 * serves the edition the repo stores, so the paragraph and heading counts it is
 * compared against are the edition's. The shelf entry of a slice edition (the
 * 1816 Proclus Elements) names the WHOLE VOLUME it was carved from, whose
 * counts are four works', so the shelf is not the text this check wants even
 * when it is the only place the bytes exist. */
const srcOf = (t) =>
  hasEdition(t.slug) ? readEdition(t.slug) : readFileSync(textSource(t, files()), 'utf8');
/* The repair state the INDEX prints comes from the edition record (model §3),
 * which is what the build reads — not from the shelf entry. */
const editionRepair = (slug) => {
  const e = editionRecord(slug);
  return e && e.repair_state ? e.repair_state : 'damaged';
};
const stored = (t) => hasEdition(t.slug);
const builtPages = (slug) => {
  const dir = join(LIB, slug);
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      /* THE APPARATUS IS ITS OWN PAGE, NOT A TEXT PAGE. It carries the leaf
       * viewer and no stretch of the text, so it is not a page of the edition
       * whose paragraphs this walk counts — the text pages are the edition page
       * and its `part-N` pages. */
      if (e.isDirectory()) {
        if (e.name === 'apparatus') continue;
        walk(join(d, e.name));
      } else if (e.name === 'index.html') out.push(join(d, e.name));
    }
  };
  walk(dir);
  return out.sort();
};

/** The `<p>`s of a page's text region — the div that follows <h2>The text</h2>.
 * The reader emits no nested div there, so the region ends at the first close. */
function textParagraphs(html) {
  const at = html.indexOf('<h2>The text</h2>');
  if (at < 0) return null;
  const from = html.indexOf('<div class="prose">', at);
  if (from < 0) return null;
  const to = html.indexOf('</div>', from);
  const region = html.slice(from, to);
  return { count: (region.match(/<p>/g) || []).length, headings: (region.match(/<h[23]\b/g) || []).length, region };
}

/* ---------- 2. every text page, with the reader's own paragraph count ---------- */

section('the pages (built vs. the shelf)');
const expected = new Map(); // slug -> { paras, headings, readable, parts, pages }
for (const t of TEXTS) {
  const pages = builtPages(t.slug);
  /* A HELD-BACK text is ABSENT — not skipped, asserted absent. This is the
   * asymmetry the publication flag turns on: a build that emits a page for a text
   * the shelf does not publish fails HERE. There is no preview escape hatch (the
   * standalone build has no LIBRARY=1), so the assertion is unconditional. */
  if (!SERVED.includes(t)) {
    check(pages.length === 0, `${t.slug}: not published, and no page is built for it (${pages.length} found)`);
    if (pages.length === 0) continue;
  }
  const src = srcOf(t);
  const a = assess(src, t.lang);
  if (!a.readable) {
    expected.set(t.slug, { paras: 0, headings: 0, readable: false, pages: pages.length });
    check(pages.length === 1, `${t.slug}: one page for a text that cannot be served (${pages.length})`);
    if (pages.length === 1) {
      const html = readFileSync(pages[0], 'utf8');
      check(html.includes('cannot be served as text'), `${t.slug}: the page says the text cannot be read`);
      check(textParagraphs(html) === null, `${t.slug}: and serves no prose region`);
      check(
        html.includes(`${a.greekLetters}`) && html.includes(`${a.latinLetters}`),
        `${t.slug}: the page carries the measured letter counts (${a.greekLetters} Greek-range, ${a.latinLetters} Latin)`,
      );
    }
    continue;
  }
  const doc = preprocess(src);
  /* TWO WAYS A TEXT HAS MORE THAN ONE PAGE, and they count differently.
   *
   *  - SERVED IN PARTS: one parent page carries the list of parts and each part
   *    its own stretch of the text, so the paragraphs ADD UP to the source's.
   *  - SERVED AT TWO URLS: the current version's page and the pinned
   *    `/v/<semver>/` page carry the SAME text (plan §4), so each carries the
   *    whole of it and the count MULTIPLIES by the number of URLs.
   *
   * The check tells them apart by whether any page is a part page, rather than
   * assuming the bare page is the lone one — which is what it was before the
   * version layout existed. */
  const partPages = pages.filter((p) => /\/part-\d+\/index\.html$/.test(p));
  /* EVERY NON-PART PAGE IS A PARENT when the text is served in parts: a stored
   * edition is served at TWO URLs (the bare one and the pinned `/v/<semver>/`),
   * and both carry the parts list instead of the text. MEASURED, and why this is
   * a SET and not one page: the single `find` here matched the bare page only, so
   * the pinned parent — which no longer inlines the whole transcription — was
   * counted as a part-less text page and failed the text-region check. */
  const parents = new Set(pages.filter((p) => !/\/part-\d+\/index\.html$/.test(p)));
  let gotParas = 0;
  let gotHeadings = 0;
  let missing = 0;
  for (const p of pages) {
    const region = textParagraphs(readFileSync(p, 'utf8'));
    if (partPages.length > 0 && parents.has(p)) {
      check(
        readFileSync(p, 'utf8').includes('<h2>The text, in parts</h2>'),
        `${t.slug}: the parent page lists the parts instead of carrying the text`,
      );
      continue;
    }
    if (!region) {
      missing++;
      continue;
    }
    gotParas += region.count;
    gotHeadings += region.headings;
  }
  /* HOW MANY TIMES THE TEXT IS CARRIED. Without parts, each page carries the
   * whole of it (the bare and the pinned URL). With parts, each PARENT carries a
   * complete set of part pages, so the multiplication is by the number of parents
   * — MEASURED: the old `1` counted one set and failed a text served in parts at
   * both its URLs, whose paragraphs then added up to twice the source. */
  const factor = partPages.length > 0 ? parents.size : pages.length;
  expected.set(t.slug, {
    paras: doc.stats.parasOut * factor,
    headings: doc.stats.headings * factor,
    readable: true,
    pages: pages.length,
  });
  check(missing === 0, `${t.slug}: every text page carries a text region (${missing} without)`);
  check(
    gotParas === doc.stats.parasOut * factor,
    `${t.slug}: ${gotParas} paragraph(s) in the built pages, ${doc.stats.parasOut} in the source ` +
      `(${pages.length} page(s)${partPages.length > 0 ? ', split in parts' : ', the same text at each URL'})`,
  );
  check(gotHeadings === doc.stats.headings * factor, `${t.slug}: ${gotHeadings} heading(s) built, ${doc.stats.headings} detected`);
}
{
  const dirs = readdirSync(LIB, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const unwritten = EMITTED.filter((t) => !dirs.includes(t.slug)).map((t) => t.slug);
  const extra = dirs.filter((d) => !EMITTED.some((t) => t.slug === d));
  check(
    unwritten.length === 0,
    `every text this build serves has a built page (${EMITTED.length} of ${TEXTS.length} entries${unwritten.length ? `; missing ${unwritten.join(', ')}` : ''})`,
  );
  check(extra.length === 0, `no built library page belongs to no text this build serves${extra.length ? `: ${extra.join(', ')}` : ''}`);
  // FAILS IF: a published text is missing its page, or a page exists for a text
  // the shelf does not serve — the two failures the flag's two states are.
}

/* ---------- 3. nothing internal on a page ---------- */

section('what a page may not say');
// An INDEPENDENT list, not the build's: a test that asks the build what a leak
// is proves only that the build is self-consistent.
/* WHICH RULES RUN ON WHICH FILE. The walk below reads EVERY emitted text file
 * under site/dist/texts/ — the pages, and the two DATA files a stored edition
 * serves (the document and the plain text) — but a data file is the BOOK'S OWN
 * TEXT, and a book's words cannot be the site's vocabulary. MEASURED, and why
 * this split is here: Taylor's Theology of Plato prints "e,/*u" (a comment
 * delimiter in OCR debris) and "enlightens", and the gate's own module states
 * the same rule for the same reason (build/leak.mjs: a phrase rule cannot tell
 * the site's vocabulary from a 19th-century author's). The first three rules
 * name the site's CONSTRUCTION — a path, a tool, a source-file name — and no
 * printed book contains one, so they run everywhere; the rest are PHRASES and a
 * comment delimiter, and run on the rendered pages, which is where a leak is
 * that a reader would see. */
const BANNED = [
  [/(?:^|["'\s(])(?:~|\/home\/[a-z])\/[\w./-]+/, 'local filesystem path', true],
  [/\b[\w.-]+\.(?:txt|mjs|json)\b(?=[\s"',.)]|$)/, 'source-file name', true],
  [/\btools\/(?:build|viz|check-scope)[\w./-]*/, 'internal path', true],
  [/\bthe scan\b|\bthe brief\b|\bthe manifest\b|\bthe plumbing\b|\bthe corpus\b|\bthe extract\b/i, 'workshop wording', false],
  [/\b\d[\d,]{2,}\s*(?:bytes|KB|MB)\b/i, 'file size', false],
  [/\/\*\s*[-=]*\s*[a-z]/i, 'a comment delimiter in emitted code', false],
  [/^\s*\/\/\s/m, 'a line comment in emitted code', false],
];
/* THE SITE'S OWN PUBLISHED ADDRESSES ARE NOT A LEAK. The data model names them
 * (model §7/§8) and a page must be able to link them: the corpus and graph
 * exports, and — since the apparatus became a fetched data file — the edition's
 * own repair log, which the edition page links for a reader whose JavaScript is
 * off. Written HERE, independently of build/leak.mjs, and matched as WHOLE
 * addresses: every other spelling of the same names still fails (the gate's own
 * rule, both directions, is held in tools/leak-probe.mjs). */
const PUBLISHED = [
  /\/data\/corpus\.json$/,
  /\/data\/graph\.json$/,
  /\/texts\/[\w.-]+\/(?:v\/[\w.-]+\/)?apparatus\.json$/,
];
const ADDRESS_TAIL = 120; // enough for the longest published address
/** Is the match at `at` one of ITS OWN published addresses? The address must END
 * at the match and no word/dot/dash character may follow it — a longer name that
 * merely contains an address (`apparatus.json.bak`, `corpus.json.txt`) is not the
 * address, and is a leak. The build's own gate tests the same two things. */
function isPublishedAddress(text, at, len) {
  if (/[\w.-]/.test(text[at + len] || '')) return false;
  const tail = text.slice(0, at + len).slice(-ADDRESS_TAIL);
  return PUBLISHED.some((r) => r.test(tail));
}
{
  // EVERY emitted file under site/dist/texts/, not only the pages: MEASURED, the
  // walk here used to read `index.html` only and so never scanned the library's
  // data files — the document a text serves beside its page, and its plain text
  // (plan §5/§8, the smoke-walk bug). Those are emitted text like any other, so
  // the gate that reads this list must see them.
  const pages = [];
  const images = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      // THE LEAF IMAGES ARE BINARY, and the leak gate is a TEXT gate: a JPEG's
      // bytes contain `/*` and `//` by chance, which is not a comment that
      // reached emitted code. The build copies these files rather than rendering
      // them (so its own gate never sees them either); they are counted apart
      // here, and tools/scan-probe.mjs is what asserts their coverage and urls.
      else if (/\.(?:jpe?g|png|gif|webp)$/i.test(e.name)) images.push(join(d, e.name));
      else pages.push(join(d, e.name));
    }
  };
  walk(LIB);
  const bad = [];
  let empty = 0;
  let threeNewlines = 0;
  for (const p of pages) {
    const html = readFileSync(p, 'utf8');
    const rel = p.slice(DIST.length + 1);
    if (/<p>\s*<\/p>/.test(html)) empty++;
    const region = textParagraphs(html);
    if (region && /\n{3,}/.test(region.region)) threeNewlines++;
    // A PAGE is an .html file; every other emitted text file is DATA (the
    // document, the plain text, an apparatus.json) and a book's own words.
    const isPage = p.endsWith('.html');
    for (const [re, what, hard] of BANNED) {
      if (!isPage && !hard) continue;
      // EVERY occurrence, not the first: a page legitimately carries a published
      // address AND must still be caught for a leak anywhere else on it.
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      for (const m of html.matchAll(g)) {
        if (isPublishedAddress(html, m.index, m[0].length)) continue;
        bad.push(`${rel}: ${what}: ${JSON.stringify(html.slice(Math.max(0, m.index - 40), m.index + 40))}`);
      }
    }
  }
  // The floor is derived from the SERVED texts, not fixed: a build that serves
  // one text emits far fewer files than one that serves thirty-eight, and a
  // hard-coded 40 would either be a tautology in a preview or a false failure in
  // a default build. Each served text contributes at least its page, and each
  // stored edition its document and its plain text — counted here so the walk is
  // asserted to have found the files the build must have written.
  const floor = EMITTED.length + EMITTED.filter((t) => hasEdition(t.slug)).length * 2;
  check(
    pages.length >= floor,
    `scanned ${pages.length} emitted text file(s) under site/dist/texts/ (at least ${floor} for ${EMITTED.length} text(s) this build serves: pages, documents and plain texts); ` +
      `${images.length} leaf image(s) are binary and are not read as text`,
  );
  check(bad.length === 0, `no page carries an internal path, a source filename or workshop wording${bad.length ? `\n       ${bad.slice(0, 6).join('\n       ')}` : ''}`);
  /* THE EXEMPTION ABOVE IS A FILTER, NOT AN AMNESTY — the half that makes it a
   * check. MEASURED here, on the filter itself: every near-miss spelling of a
   * published address is still a leak, so the list cannot be widened by accident
   * into covering a name that is not the published one. */
  {
    const mustFail = [
      '/data/secret.txt',
      '/data/apparatus.json',
      'data/corpus.json',
      '/data2/corpus.json',
      '/texts/x/y/apparatus.json',
      '/texts/x/apparatus.json.txt',
      '/texts/x/v/1.0.0/apparatus.json.bak',
      '/texts/x/apparatus.json.gitignore',
      '/answers/apparatus.json',
    ];
    const leakRe = BANNED.find(([, what]) => what === 'source-file name')[0];
    const escapees = [];
    for (const str of mustFail) {
      const g = new RegExp(leakRe.source, 'g');
      for (const m of str.matchAll(g)) if (isPublishedAddress(str, m.index, m[0].length)) escapees.push(str);
    }
    check(escapees.length === 0,
      `the published-address exemption covers no near-miss spelling (${escapees.length} escapee(s)${escapees.length ? `: ${escapees.join(', ')}` : ''})`);
    check(PUBLISHED.some((r) => r.test('/texts/proclus-elements-of-theology-taylor-1816/apparatus.json')) &&
      PUBLISHED.some((r) => r.test('/texts/proclus-elements-of-theology-taylor-1816/v/1.0.0/apparatus.json')),
      'and it does cover the two addresses the build actually emits (the bare and pinned apparatus files)');
  }
  check(empty === 0, `no page has an empty paragraph (${empty})`);
  check(threeNewlines === 0, `no text region has a run of three or more newlines (${threeNewlines})`);
}

/* ---------- 3b. the chrome every page carries ---------- */

/* DESIGN-SYSTEM.md §5: every page is masthead -> nav -> content -> colophon.
 * This checks the FRAME on the built pages, and — the half that matters after a
 * redesign — that the blog's terminal chrome is really GONE: no prompt line, no
 * blinking cursor, no command-line palette, no dose meter and no theme toggle
 * anywhere in the emitted HTML. FAILS IF: a page loses the frame, or a page
 * still ships the shell it was re-skinned away from. */
section('the chrome every page carries');
{
  const pages = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name === 'index.html' || e.name === '404.html') pages.push(join(d, e.name));
    }
  };
  walk(DIST);
  const ROUTES = ['/texts/', '/graph/', '/search/', '/editions/', '/about/', '/errata/'];
  const bad = [];
  for (const p of pages) {
    const html = readFileSync(p, 'utf8');
    const rel = p.slice(DIST.length + 1);
    if (!/<header class="masthead">/.test(html)) bad.push(`${rel}: no masthead`);
    if (!/<a href="\/"[^>]*>The Neoplatonic Library<\/a>/.test(html)) bad.push(`${rel}: no wordmark link home`);
    if (!/<p class="statement">/.test(html)) bad.push(`${rel}: no statement`);
    if (!/<a class="skip" href="#main">/.test(html.slice(html.indexOf('<body>')))) bad.push(`${rel}: no skip link`);
    if (!/<main id="main">/.test(html)) bad.push(`${rel}: no main landmark`);
    if (!/<nav>/.test(html)) bad.push(`${rel}: no nav`);
    for (const r of ROUTES) if (!html.includes(`href="${r}"`)) bad.push(`${rel}: nav is missing ${r}`);
    if (!/<footer class="colophon">/.test(html)) bad.push(`${rel}: no colophon`);
    // THE TERMINAL IS GONE (DESIGN-SYSTEM.md §8).
    for (const [needle, what] of [
      ['class="prompt"', 'the terminal prompt line'],
      ['class="blink"', 'the blinking cursor'],
      ['id="palette"', 'the command-line palette'],
      ['class="dose"', 'the dose meter'],
      ['id="theme-toggle"', 'the theme toggle'],
      ['data-theme', 'the dark-theme machinery'],
      ['class="home-search"', 'the blog hero search'],
    ]) {
      if (html.includes(needle)) bad.push(`${rel}: still ships ${what}`);
    }
  }
  const floor = EMITTED.length + 7; // 7 fixed routes (/, texts, graph, search, editions, about, errata) + 404
  check(pages.length >= floor, `read the chrome of ${pages.length} page(s) (at least ${floor})`);
  check(bad.length === 0, `every page carries the masthead, nav and colophon, and none carries the blog's shell${bad.length ? `\n       ${bad.slice(0, 8).join('\n       ')}` : ''}`);
}

/* ---------- 4. the index and the pages agree both ways ---------- */

section('the index');
{
  const index = readFileSync(join(LIB, 'index.html'), 'utf8');
  const linked = new Set([...index.matchAll(/href="\/texts\/([a-z0-9-]+)\/"/g)].map((m) => m[1]));
  const present = new Set(readdirSync(LIB, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
  const unlinked = [...present].filter((s) => !linked.has(s));
  const dead = [...linked].filter((s) => !existsSync(join(LIB, s, 'index.html')));
  check(unlinked.length === 0, `every text with a page is linked from the index${unlinked.length ? `: ${unlinked.join(', ')}` : ` (${linked.size})`}`);
  check(dead.length === 0, `every link on the index resolves to a built page${dead.length ? ` (404: ${dead.join(', ')})` : ''}`);
  /* THE CATALOGUE, on the LIBRARY's own terms (DESIGN-SYSTEM.md §5). MEASURED:
   * the index used to group its editions by the blog's argumentative axis — the
   * blog's framing, not the library's. The catalogue is now ONE list ordered by
   * author (surname) then title, with a factual sort control and a repair-state
   * filter, and it draws no collection heading anywhere. FAILS IF: the blog's
   * grouping comes back, or the list loses the library's own order. */
  check(
    !/<h2 id="group-/.test(index) &&
      !/class="catalogue-group"/.test(index) &&
      !/class="group-line"/.test(index),
    'the index draws no argumentative collection heading (the blog’s grouping is gone)',
  );
  const entries = [
    ...index.matchAll(
      /<li class="cat-entry" data-a="([^"]*)" data-t="([^"]*)" data-y="([^"]*)" data-state="([^"]*)">/g,
    ),
  ].map((m) => ({ a: m[1], t: m[2], y: m[3], state: m[4] }));
  check(
    entries.length === EMITTED.length,
    `the catalogue lists every served edition once (${entries.length} of ${EMITTED.length})`,
  );
  // The order is asserted against the keys the page itself DECLARES, so the
  // check does not re-run the build's surname rule: the served order must be the
  // order its own sort keys put it in (author, then title).
  check(
    entries.every(
      (e, i) => i === 0 || entries[i - 1].a < e.a || (entries[i - 1].a === e.a && entries[i - 1].t <= e.t),
    ),
    'and it is served in its own declared order — author (surname), then title',
  );
  check(
    entries.every((e) => e.a.length > 0 && e.t.length > 0 && /^\d+$/.test(e.y)),
    'every entry carries its author, title and year keys',
  );
  check(
    ['author', 'title', 'year'].every((k) => index.includes(`data-sort="${k}"`)) &&
      /data-catalogue/.test(index) &&
      /class="catalogue-controls"/.test(index),
    'the catalogue carries its factual sort control (Author · Title · Year)',
  );
  {
    const statesPresent = [...new Set(EMITTED.map((t) => editionRepair(t.slug)))].filter(Boolean);
    const boxes = [...index.matchAll(/data-cstate="([^"]*)"/g)].map((m) => m[1]);
    check(
      boxes.length === statesPresent.length && statesPresent.every((s) => boxes.includes(s)),
      `the catalogue filters by the repair state, one box per state served (${boxes.join(', ') || 'none'})`,
    );
    check(/class="cat-legend"/.test(index), 'and it explains the state pill in plain words (a legend)');
  }
  /* THE REPAIR STATE, stated ABOVE the list (the author's ask): a reader meeting
   * the shelf is told which editions are readable and NOT finished. FAILS IF: the
   * badge or the statement is dropped — a reader then takes an edition in repair
   * for a finished one. */
  {
    // the states a served text can be in: damaged (the default — unrepaired),
    // in repair, repaired. Every one present is named above the list and tagged
    // beside the title. FAILS IF: a state is dropped from the statement, or the
    // statement sinks below the catalogue.
    const firstGroup = index.indexOf('<ul class="entries">');
    // a stable marker: the lede sentence, not the header (which adapts to the states present)
    const noteAt = index.indexOf('An edition here can be readable and not yet repaired');
    check(
      noteAt >= 0 && firstGroup >= 0 && noteAt < firstGroup,
      `the index states the repair state ABOVE the catalogue (note at ${noteAt}, list at ${firstGroup})`,
    );
    // the note REGION: from the statement to the list, so a label found only
    // beside a title does not count as "named above the list"
    const noteRegion = noteAt >= 0 && firstGroup > noteAt ? index.slice(noteAt, firstGroup) : '';
    for (const st of ['damaged', 'in-repair', 'repaired']) {
      const ts = EMITTED.filter((t) => editionRepair(t.slug) === st);
      const label = REPAIR_LABELS[st];
      if (!ts.length) continue; // nothing to name: the held-back note may still use the word
      check(
        new RegExp(`<span class="tag[^"]*">${label}</span>`).test(noteRegion) &&
          ts.every((t) => noteRegion.includes(`/texts/${t.slug}/`)),
        `the ${label} state is named above the list, with its texts (${ts.length})`,
      );
      check(
        ts.every((t) =>
          new RegExp(
            `<a href="/texts/${t.slug}/">[^<]*</a> <span class="tag tag-${st}" title="[^"]+">${label}</span>`,
          ).test(index),
        ),
        `and each ${label} text carries an explained tag beside its name (${ts.map((t) => t.slug).join(', ')})`,
      );
    }
    // the default, asserted directly: a text that declares no repair state is
    // DAMAGED, not state-less — an unrepaired transcription is a damaged one
    check(
      editionRepair('no-such-edition') === 'damaged' && REPAIR_LABELS.damaged === 'damaged',
      'an edition with no declared repair state reports damaged (the default)',
    );
  }

  /* WHAT AN INDEX THAT SERVES PART OF THE SHELF MUST SAY (phase 5). The library's
   * own paragraphs describe the shelf — the held-back entries and the modern
   * editions that are not free included — so a page that serves one text out of
   * thirty-eight has to say which it serves, or its description reads as a claim
   * about the page in front of the reader. */
  if (WITHHELD.length) {
    check(
      index.includes('What is served here now') &&
        EMITTED.every((t) => new RegExp(`<a href="/texts/${t.slug}/">`).test(index)),
      `the index states what is served and what is held back (${EMITTED.length} served here, ${WITHHELD.length} held back in this tree)`,
    );
    // FAILS IF: a partial shelf is described as the whole one — the page then
    // claims to hold texts it does not serve.
  } else {
    check(!index.includes('What is served here now'), 'and says nothing about a held-back shelf when there is none');
    // FAILS IF: the sentence is emitted unconditionally, which would leave the
    // preview build reading "38 of 38 texts served" beside a paragraph about
    // held-back texts.
  }
}


/* ---------- 5. the citation line is the citation record ---------- */

/* ADAPTED (extraction plan §6): the blog's version of this section recomputed
 * the citing readings by running the blog's own note-reading derivation over
 * tools/catalogue.json and the posts' footnote definitions. That derivation is
 * the blog's and STAYS there (plan §1.3); here the record is
 * `edition.readings[]` — the hand-seeded list of blog slugs in the edition
 * record (model §6) — and the check is that the page renders exactly that list,
 * as links out to the blog, and nothing else. */
section('readings cited by');
{
  let compared = 0;
  for (const t of EMITTED) {
    const e = editionRecord(t.slug);
    const html = readFileSync(join(LIB, t.slug, 'index.html'), 'utf8');
    const at = html.indexOf('<b>Where it is cited.</b>');
    check(at >= 0, `${t.slug}: the page states where it is cited`);
    if (at < 0) continue;
    const para = html.slice(at, html.indexOf('</p>', at));
    const want = new Set(e.readings || []);
    const got = new Set([...para.matchAll(/href="https:\/\/blog\.jaye\.ch\/([a-z0-9-]+)\/"/g)].map((m) => m[1]));
    const same = got.size === want.size && [...want].every((w) => got.has(w));
    check(
      same,
      `${t.slug}: links {${[...got].sort().join(', ') || 'nothing'}} — the edition record reads {${[...want].sort().join(', ') || 'nothing'}}`,
    );
    compared++;
  }
  check(compared === EMITTED.length, `compared the citation line of every served edition (${compared} of ${EMITTED.length})`);
  /* THE RECORD'S OWN STATE, asserted honestly. Every migrated `readings[]` is
   * EMPTY (MIGRATION-NOTES: "the migration runs no derivation, so no list is
   * asserted. seed these by hand after review") — seeding them is the migration
   * plan's §2.4, not this build's work. So the check does not fail on an empty
   * record; it asserts the HONEST EMPTY STATE is what the pages render, and says
   * what the record would have to carry for the links to appear. */
  const attached = TEXTS.map((t) => editionRecord(t.slug)).filter((e) => e && (e.readings || []).length > 0);
  if (attached.length === 0) {
    console.log(
      '  NOTE no edition carries readings[] yet — the pages render the honest empty state. The plan §2.4 seed ' +
        'values (MEASURED on the blog) are proclus: proclus-elements-of-theology, proclus-theology-of-plato; ' +
        'porphyry: porphyry-cave-of-the-nymphs. Seed them in the edition records to exercise the links.',
    );
    for (const t of EMITTED) {
      const html = readFileSync(join(LIB, t.slug, 'index.html'), 'utf8');
      check(
        /<b>Where it is cited\.<\/b>/.test(html),
        `${t.slug}: renders the stated empty state, not a blank`,
      );
    }
  } else {
    check(true, `the record is not inert (${attached.length} edition(s) carry readings)`);
  }
  // FAILS IF: the page derives its own citation list again (the blog coupling
  // plan §1.3 cuts), or loses a reading the record names.
}

/* ---------- 6. what the site puts up around the texts ---------- */

/* ADAPTED from the blog's "the site around the library": there is no blog 404 or
 * blog nav here — this IS the site — so the check is that the HOME, the sitemap
 * and every page's command line carry exactly the served editions and never a
 * held-back one, and that nothing anywhere links the old /library/ tree. */
section('the site around the texts');
{
  const home = readFileSync(join(DIST, 'index.html'), 'utf8');
  const sitemap = readFileSync(join(DIST, 'sitemap.xml'), 'utf8');
  const sitemapLocs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check(
    sitemapLocs.includes(`${BASE}/texts/`),
    `the sitemap addresses the index (${sitemapLocs.length} address(es))`,
  );
  const missing = EMITTED.map((t) => `/texts/${t.slug}/`).filter((rel) => !sitemapLocs.includes(`${BASE}${rel}`)).length
    ? EMITTED.map((t) => `/texts/${t.slug}/`).filter((rel) => !sitemapLocs.includes(`${BASE}${rel}`))
    : [];
  check(missing.length === 0, `and every served edition${missing.length ? `: missing ${missing.join(', ')}` : ` (${EMITTED.length})`}`);
  const heldInSitemap = WITHHELD.map((t) => `/texts/${t.slug}/`).filter((rel) => sitemapLocs.includes(`${BASE}${rel}`));
  check(heldInSitemap.length === 0, `and no held-back edition is addressed${heldInSitemap.length ? `: ${heldInSitemap.join(', ')}` : ''}`);
  // FAILS IF: an address that 404s is advertised — worse than an absent one.

  /* THE HOME IS THE CATALOGUE (DESIGN-SYSTEM.md §5): every served edition is an
   * entry on it, and nothing else is. This is the component that replaced the
   * command line's `cat` list — the same guarantee, in the library's own
   * vocabulary. FAILS IF: an edition this build serves is missing from the home
   * page, or the home advertises an edition it does not serve. */
  const listed = new Set(
    [...home.matchAll(/<a href="\/texts\/([a-z0-9-]+)\/">/g)].map((m) => m[1]),
  );
  check(
    listed.size === EMITTED.length && EMITTED.every((t) => listed.has(t.slug)) && WITHHELD.every((t) => !listed.has(t.slug)),
    `and the home catalogue carries exactly the editions this build serves (${listed.size} of ${EMITTED.length})`,
  );

  /* THE OLD TREE IS GONE AND NOTHING POINTS AT IT. The blog's /library/ tree is
   * the thing this site replaces; a stale link in the new tree would 404 the day
   * the blog's redirects stop or before they land (plan §5/§6.4). */
  const walkAll = (d, out = []) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walkAll(join(d, e.name), out);
      else out.push(join(d, e.name));
    }
    return out;
  };
  const legacy = [];
  for (const p of walkAll(DIST)) {
    const text = readFileSync(p, 'utf8');
    // The sanctioned outbound references are the readings links (blog.jaye.ch/<slug>/)
    // and site.json's blog.url; a /library/ path is not one of them.
    if (/\/library\//.test(text)) legacy.push(p.slice(DIST.length + 1));
  }
  check(legacy.length === 0, `no emitted file links the blog's old /library/ tree${legacy.length ? `: ${legacy.join(', ')}` : ''}`);
}

/* ---------- 7. the reading's citations resolve ---------- */

/* DROPPED, deliberately (extraction plan §6). The blog's section 7 followed the
 * links from the blog's own reading of the Cave into the library pages. The
 * reading is a BLOG page and this repo does not build it; the citation
 * relationship is one-way (library → blog, model §6) and the outbound links are
 * checked in section 5. The fragments those links carry are checked where they
 * belong: the version probe (`tools/version-probe.mjs`) and the anchor gate the
 * build itself enforces (`checkAnchors`). */

/* ---------- 8. the print stylesheet is emitted, and says what print does ---------- */

/* The print rules are checked by LOOKING at a print rendering (a headless Chrome
 * screenshot, in the phase's own proof); what a smoke can assert is that the
 * rules are in the built page at all — a print block dropped in a refactor
 * renders as the screen page on paper, and nothing else here would notice. */
section('print');
{
  // The reader exists only for a text whose EDITION the repo stores (the shelf
  // alone has no document, no anchors and no app).
  const readerText = SERVED.find((t) => hasEdition(t.slug));
  if (!readerText) {
    console.log('  SKIP no served text has a stored edition, so there is no reader stylesheet to check');
  } else {
    const shell = readFileSync(join(LIB, readerText.slug, 'index.html'), 'utf8');
    // The READER's own stylesheet, found by what only it declares: the page also
    // carries the design system's print rules (the site's chrome), so taking the
    // first <style> or the first @media print would check the wrong block.
    const blocks = [...shell.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    const css = blocks.find((b) => b.includes('.rd-flow') && b.includes('@media print')) || '';
    const print = css.slice(css.indexOf('@media print'));
    const needs = [
      ['.rd-bar, .rd-nav', 'the app chrome is dropped'],
      ['display: none !important', 'and really dropped, not faded'],
      ['.rd-item.rd-out', 'the items outside the range do not print'],
      ['.rd-pb', 'the printed page numbers are restyled for paper'],
      ['position: absolute', 'and placed in the margin'],
      ['.rd-margin, .rd-rh', 'the margin notes and the running heads do not print'],
      ['.rd-note { break-inside: avoid', 'and a note is not split across two sheets'],
    ];
    const missing = needs.filter(([frag]) => !print.includes(frag)).map(([, what]) => what);
    check(
      print.length > 0 && missing.length === 0,
      `the reader's print block is emitted with every rule it needs${missing.length ? ` — missing: ${missing.join('; ')}` : ` (${blocks.length} style block(s) in ${readerText.slug})`}`,
    );
  }
}

/* ---------- what the run measured ---------- */

section('measured');
{
  const { execFileSync } = await import('node:child_process');
  const bytes = (p) => Number(execFileSync('du', ['-sb', p], { encoding: 'utf8' }).split('\t')[0]);
  const libBytes = bytes(LIB);
  const pages = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name === 'index.html') pages.push(join(d, e.name));
    }
  };
  walk(LIB);
  const sized = pages.map((p) => ({ p, size: statSync(p).size })).sort((a, b) => b.size - a.size);
  /* THE CAP IS THE BUILD'S OWN CONSTANT, not a second number typed here: the
   * page budget and the prose budget it leaves (LIBRARY_PAGE_MAX_BYTES minus the
   * fixed chrome) are what decide whether a text is served in parts, and a smoke
   * that carried its own copy of the number could not tell the two agreeing from
   * the two drifting. */
  const over = sized.filter((x) => x.size > LIBRARY_PAGE_MAX_BYTES);
  console.log(`  texts: ${pages.length} page(s), ${libBytes} bytes across site/dist/texts/`);
  console.log(`  largest page: ${sized[0].size} bytes (${sized[0].p.slice(DIST.length + 1)})`);
  check(over.length === 0, `no page exceeds 2 MB (${over.length} over; largest ${(sized[0].size / 1048576).toFixed(2)} MB)`);
  const split = [...expected.entries()].filter(([, e]) => e.pages > 1);
  console.log(`  texts served in parts: ${split.length ? split.map(([s, e]) => `${s} (${e.pages} pages)`).join(', ') : 'none'}`);
  console.log(`  shelf: ${TEXTS.length} entries, ${EMITTED.length} served`);
}

console.log(failures === 0 ? '\nlibrary-smoke: all checks passed' : `\nlibrary-smoke: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
