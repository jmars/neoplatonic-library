#!/usr/bin/env node
/**
 * tools/search-probe.mjs — the /search/ route's client, proved against the
 * emitted index (extraction plan §6, the shelf half of the blog's search-smoke).
 *
 * The probe loads the SAME client the page inlines (tools/search/shelf.js),
 * feeds it the SAME index the build wrote (site/dist/search/index), and holds
 * its answers against ground truth recomputed here by scanning the index's own
 * passages — never against the client's own output, which would assert only that
 * the client is self-consistent:
 *
 *   - the index covers every served edition and every passage row has the shape
 *     the provider decodes;
 *   - a word query reaches every passage the word stands in (recomputed by a scan)
 *     and every result it returns really holds a word with that prefix;
 *   - a `~word` one edit out returns the same passages as the corrected word;
 *   - a `/pattern/` returns only passages holding a word the pattern reaches;
 *   - a quoted phrase returns only passages where the words are adjacent, in order;
 *   - a result links INTO the book at the passage's anchor (/texts/<slug>/#...);
 *   - a query for a word the texts do not use returns nothing and does not throw.
 *
 *     node tools/search-probe.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedTexts } from './shelf.mjs';

/** THE SERVED SET, from the shelf's own publication switch: the search index is
 * built over the SERVED editions, and the data directory may hold one that is
 * held back. */
const SERVED = new Set(publishedTexts().map((t) => t.slug));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'site', 'dist', 'search', 'index');
const CLIENT = join(ROOT, 'tools', 'search', 'shelf.js');

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};
const section = (name) => console.log(`\n${name}`);

if (!existsSync(INDEX)) {
  console.log('search-probe: site/dist/search/index is not built — run node build/build.mjs first');
  process.exit(1);
}

/** The client, evaluated in this process. It is an IIFE that publishes itself as
 * `window.Search`; with a bare `window` it needs no DOM (only `boot`/`wire` do,
 * and neither is called here). */
const sandbox = { window: {} };
// eslint-disable-next-line no-new-func -- running the page's own client IS the check
new Function('window', 'document', `${readFileSync(CLIENT, 'utf8')}`)(sandbox.window, undefined);
const Search = sandbox.window.Search;
if (!Search) {
  console.log('search-probe: the client did not publish itself as window.Search');
  process.exit(1);
}

const index = JSON.parse(readFileSync(INDEX, 'utf8'));
const shelf = Search.init(index);
const docs = shelf.docs;
const pass = index.pass;

function servedSlugs() {
  const dir = join(ROOT, 'data', 'editions');
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(dir, d.name, 'edition.json'))
    .filter(existsSync)
    .map((f) => JSON.parse(readFileSync(f, 'utf8')))
    .filter((e) => e.current_version && SERVED.has(e.slug))
    .map((e) => e.slug)
    .sort();
}

/** Every passage whose text holds a word `[a-z]`-initialled that BEGINS with q —
 * the client's own lookup rule, recomputed from the passage's own words. */
const passagesWithPrefix = (q) => {
  const ql = q.toLowerCase();
  const re = new RegExp(`\\b${ql}[a-z'-]*`, 'i');
  const out = new Set();
  for (let i = 0; i < pass.length; i++) if (re.test(pass[i][5])) out.add(i);
  return out;
};
const passagesWithWord = (w) => {
  const re = new RegExp(`(^|[^a-z])${w.toLowerCase()}([^a-z]|$)`, 'i');
  const out = new Set();
  for (let i = 0; i < pass.length; i++) if (re.test(pass[i][5])) out.add(i);
  return out;
};

section('the index the client decodes');
check(JSON.stringify(docs.map((d) => d.slug).sort()) === JSON.stringify(servedSlugs()), 'covers exactly the served editions');
check(pass.every((r) => Array.isArray(r) && r.length === 6), 'every passage row is [doc, anchor, page, open, sec, text]');
check(pass.every((r) => r[0] >= 0 && r[0] < docs.length), 'every passage names a document that exists');
check(pass.every((r) => typeof r[5] === 'string' && r[5].length > 0), 'every passage carries text');
check(!!(index.words && index.words.dafsa && Array.isArray(index.words.postings)), 'carries the word automaton and its postings');
check(shelf.terms.length === index.words.postings.length, `the automaton walks out ${shelf.terms.length} terms — one per posting list`);

section('a word query reaches every passage the word stands in');
{
  const q = 'hyparxis';
  const truth = passagesWithWord(q);
  // the cap is the page's own (RESULT_CAP); raise it here so the check is about
  // REACHING every passage, not about how many a page shows.
  const r = Search.queryShelf(q, { limit: 100000 });
  const got = new Set(r.results.map((x) => x.p));
  const missed = [...truth].filter((p) => !got.has(p));
  check(truth.size > 0, `ground truth: "${q}" stands in ${truth.size} passage(s)`);
  check(missed.length === 0, `every one of them is in the answer (${got.size} returned)`);
  const prefix = passagesWithPrefix(q);
  const bogus = r.results.filter((x) => !prefix.has(x.p));
  check(bogus.length === 0, 'and every passage returned really holds a word with that prefix');
  const capped = Search.queryShelf(q, {});
  check(capped.counts.results >= capped.counts.shown, `the page caps the list at ${capped.counts.shown} of ${capped.counts.results} and counts the rest`);
}

section('a ~word one edit out finds the corrected word');
{
  /* THE WORD QUERY IS A PREFIX QUERY (the client's own rule, §above) and the
   * one-edit query is a WORD query: they answer different questions, and the
   * difference is real rather than a defect. MEASURED after the re-source: the
   * new transcription glues two words on vol. II's title page as one token
   * ('PROCLUSplatonic'), which the prefix query rightly reaches and the one-edit
   * query rightly does not — so the property that holds is:
   *   every passage the one-edit query finds is one the prefix query finds
   *   (fuzzy ⊆ prefix), AND
   *   every passage that holds the word ITSELF is found by the one-edit query
   *   (word ⊆ fuzzy).
   * Asserting set EQUALITY to the prefix query, as this check used to, would
   * assert that the fuzzy query reaches a word it must not: a longer token that
   * merely begins with the word. */
  const prefix = passagesWithPrefix('proclus');
  const word = passagesWithWord('proclus');
  /* THE FULL LIST, not the page's first page of it: the query's own cap is a
   * display rule, and this check is about which passages match at all. */
  const fuzzy = new Set(Search.queryShelf('~proculs', { limit: 100000 }).results.map((x) => x.p));
  check(word.size > 0, `the word itself stands in ${word.size} passage(s)`);
  const outside = [...fuzzy].filter((p) => !prefix.has(p));
  check(outside.length === 0, `~proculs returns the ${fuzzy.size} passage(s) the prefix query also returns (${outside.length} outside it)`);
  const missed = [...word].filter((p) => !fuzzy.has(p));
  check(missed.length === 0, `and every passage holding the word itself is one of them (${missed.length} missed)`);
}

section('a pattern is matched against the words themselves');
{
  const r = Search.queryShelf('/^procl/', {});
  const bad = r.results.filter((x) => !passagesWithPrefix('procl').has(x.p));
  check(r.results.length > 0, `/^procl/ returns ${r.results.length} passage(s)`);
  check(bad.length === 0, 'every result holds a word the pattern reaches');
  const m = Search.matchPattern('theurg');
  check(Array.isArray(m.terms), 'a pattern with nothing anchoring it walks the automaton (returns a term list)');
  const err = Search.queryShelf('/[unclosed/', {});
  check(!!err.counts.reError, 'a pattern that cannot be read is REFUSED, not answered as empty');
}

section('a quoted phrase is adjacency, in order');
{
  const q = '"cave of the nymphs"';
  const r = Search.queryShelf(q, {});
  const re = /cave of the nymphs/i;
  const bad = r.results.filter((x) => !re.test(x.text));
  check(r.results.length > 0, `the phrase returns ${r.results.length} passage(s)`);
  check(bad.length === 0, 'every result holds the words next to each other, in that order');
}

section('a result links into the book');
{
  const box = { innerHTML: '' };
  const status = { textContent: '', innerHTML: '' };
  Search.render(box, status, 'hyparxis', {});
  const links = [...box.innerHTML.matchAll(/href="(\/texts\/[^"#]+#?[^"]*)"/g)].map((m) => m[1]);
  check(links.length > 0, `the rendered results carry links into the texts (${links.length})`);
  const bad = links.filter((h) => !/^\/texts\/[a-z0-9-]+\/(#[a-z0-9-]+)?$/.test(h));
  check(bad.length === 0, `every link is /texts/<slug>/#<anchor>${bad.length ? ` — bad: ${bad.slice(0, 3).join(', ')}` : ''}`);
  check(!box.innerHTML.includes('/library/'), 'no link points at the blog’s old /library/ tree');
  check(/<mark>/.test(box.innerHTML), 'the query’s words are marked in the result');
}

section('a word the texts do not use');
{
  const r = Search.queryShelf('zzzznosuchword', {});
  check(r.counts.results === 0, 'returns nothing');
  check(Array.isArray(r.results), 'and does not throw');
  const box = { innerHTML: '' };
  const status = { textContent: '', innerHTML: '' };
  Search.render(box, status, 'zzzznosuchword', {});
  check(/sr-none/.test(box.innerHTML), 'and the page says so rather than showing an empty list');
}

console.log(failures === 0 ? '\nsearch-probe: all checks passed' : `\nsearch-probe: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
