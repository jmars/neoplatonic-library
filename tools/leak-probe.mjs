#!/usr/bin/env node
/**
 * tools/leak-probe.mjs — the leak-gate probe.
 *
 * The gate in build/leak.mjs is a byte test on the SERVED output, and its two
 * hard rules that this probe holds are the ones a relaxation can silently disarm:
 *
 *   1. `source-file name` — a `.json`/`.txt`/`.mjs` name in a reader's page is
 *      this repo's construction, with ONE exception: the two public exports the
 *      data model names (`/data/corpus.json`, `/data/graph.json`, model §8).
 *      MEASURED, the exception was written as a `(?<!\/data\/)` lookbehind, which
 *      exempted EVERY depth-1 name under `/data/` — `/data/secret.txt`,
 *      `/data/internal.json`, `/data/foo.mjs` all shipped green. So this probe
 *      tests BOTH directions: the two sanctioned addresses pass, and every other
 *      spelling of a name in that directory FAILS.
 *   2. `internal file name` — the rule named `blog.css` and could never match it
 *      (`\blog\.css\b` has no word boundary inside `blog.css`). So a rule whose
 *      whole job is to catch the design system's own filename was dead.
 *
 * A leak test that only proves the PASS direction is not a test (it passes when
 * the rule is absent): every exemption below is paired with the case it must not
 * cover, and §1 reads the pattern's own source to assert no lookbehind is back.
 *
 *     node tools/leak-probe.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_PATTERNS, checkWorkshop, stripComments } from '../build/leak.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'site', 'dist');

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};
const section = (name) => console.log(`\n${name}`);

const WHAT = (problems) => problems.map((p) => p.trim().replace(/:.*$/, ''));
const leaks = (html, opts) => checkWorkshop(html, opts);

/* ---------- §1 the pattern is the blog's own, unrelaxed ---------- */

/* The blog's COMMITTED pattern (tools/build.mjs:195 at migration), quoted here so
 * this probe stands alone: nothing in this repo reads the blog (plan §6.6). */
const BLOG_PATTERN = String.raw`/\b[\w.-]+\.(?:txt|mjs|json)\b(?=[\s"',.)]|$)/`;

section('the source-file-name rule carries no directory relaxation');
{
  const entry = GATE_PATTERNS.find(([, what]) => what === 'source-file name');
  check(!!entry, 'the rule is present in GATE_PATTERNS');
  if (entry) {
    const [re, what, kind] = entry;
    check(!re.source.includes('?<!'), `no lookbehind in the pattern (${re})`);
    /* The relaxation WAS the directory exemption; the pattern must then name no
     * directory at all — the exemption belongs to checkWorkshop's exact address
     * test, which §2/§3 prove in both directions. */
    check(!/\/data\//.test(re.source), 'the pattern constrains no directory (the exemption lives in checkWorkshop)');
    check(String(re) === BLOG_PATTERN, `the pattern is the blog's own, character for character (${re})`);
    check(what === 'source-file name' && kind === 'hard', 'the rule is still a HARD rule (it runs on data files too)');
  }
}

/* ---------- §2 the two sanctioned public addresses PASS ---------- */

section('the site’s published addresses pass — on a page and in a data file');
{
  for (const addr of [
    '/data/corpus.json',
    '/data/graph.json',
    /* the apparatus data file (model §7): the edition page links it for a reader
     * whose JavaScript is off, and a pinned page links its own version's */
    '/texts/proclus-elements-of-theology-taylor-1816/apparatus.json',
    '/texts/proclus-elements-of-theology-taylor-1816/v/1.0.0/apparatus.json',
  ]) {
    const page = `<p>The whole record is in <a href="${addr}">the data export</a>.</p>`;
    const p = leaks(page);
    check(p.length === 0, `a page linking ${addr} passes (${p.length} problem(s)${p.length ? `: ${p[0]}` : ''})`);
    const d = leaks(`{"url":"${addr}"}`, { data: true });
    check(d.length === 0, `a data file naming ${addr} passes (${d.length} problem(s)${d.length ? `: ${d[0]}` : ''})`);
  }
  /* The two contexts the build actually emits them in (build/pages.mjs). */
  const editions = readFileSync(join(ROOT, 'build', 'pages.mjs'), 'utf8');
  check(editions.includes('href="/data/corpus.json"'), 'build/pages.mjs links /data/corpus.json (the exemption is exercised, not dead)');
  /* THE APPARATUS ADDRESS IS EXERCISED TOO, in the built tree: the edition page
   * links its own data file in the no-script statement, and its viewer fetches it.
   * An exemption nothing emits is an exemption nobody tests. */
  {
    const lib = readFileSync(join(ROOT, 'build', 'library.mjs'), 'utf8');
    check(lib.includes('apparatus.json'), 'build/library.mjs emits the apparatus address (the exemption is exercised, not dead)');
    const dir = join(DIST, 'texts');
    if (existsSync(dir)) {
      const slugs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('v')).map((d) => d.name);
      const checked = slugs.filter((s) => existsSync(join(dir, s, 'index.html')));
      const bad = checked.filter((s) => {
        const html = readFileSync(join(dir, s, 'index.html'), 'utf8');
        return !html.includes(`href="/texts/${s}/apparatus.json"`) || leaks(html).length;
      });
      check(checked.length > 0 && bad.length === 0,
        `every built edition page carries its apparatus address and passes the full gate (${checked.length} page(s), ${bad.length} bad)`);
    }
  }
  const about = join(DIST, 'about', 'index.html');
  if (existsSync(about)) {
    const html = readFileSync(about, 'utf8');
    check(html.includes('"/data/corpus.json"'), '/about/ carries the sanctioned corpus.json link in the built tree');
    const p = leaks(html, { data: true });
    check(p.length === 0, `the BUILT /about/ page passes the full hard gate (${p.length} problem(s)${p.length ? `: ${p[0]}` : ''})`);
  }
}

/* ---------- §3 every other name under /data/ still FAILS ---------- */

section('every other spelling FAILS (the relaxation must not come back)');
{
  const mustFail = [
    ['/data/secret.txt', 'a depth-1 name under /data/ that is not an export'],
    ['/data/apparatus.json', 'the apparatus name under /data/ — not where it is published'],
    ['/texts/x/y/apparatus.json', 'two slug segments: not the published address'],
    ['/texts/x/apparatus.json.txt', 'the apparatus address with a longer name'],
    ['/texts/x/apparatus.json.bak', 'the apparatus address with a backup suffix'],
    ['apparatus.json', 'the apparatus name with no address at all'],
    ['/answers/apparatus.json', 'the same name in another directory'],
    ['/data/internal.json', 'an internal JSON under /data/'],
    ['/data/foo.mjs', 'an internal module under /data/'],
    ['/data2/corpus.json', 'the same NAME in another directory'],
    ['data/corpus.json', 'the sanctioned name WITHOUT its /data/ root (not the published address)'],
    ['/data/corpus.json.txt', 'the sanctioned address with a longer name (contains the address)'],
    ['/data/corpus.json.bak', 'the sanctioned address with a backup suffix'],
    ['/data/sub/corpus.json', 'the sanctioned name deeper in the tree'],
  ];
  for (const [s, why] of mustFail) {
    const html = `<a href="${s}">the data export</a>`;
    const p = leaks(html);
    check(p.length > 0, `${s} FAILS — ${why} (${p.length} problem(s))`);
    check(WHAT(p).includes('source-file name'), `  ${s}: reported as "source-file name" (got ${JSON.stringify(WHAT(p))})`);
  }
}

/* ---------- §4 blog.css is caught, log.css is not a false positive ---------- */

section('the internal-file-name rule matches the file it names');
{
  const p = leaks('<p>See design/blog.css for the design system.</p>');
  check(WHAT(p).includes('internal file name'), `a real blog.css mention FAILS (${JSON.stringify(WHAT(p))})`);
  check(!leaks('<p>See log.css for the design system.</p>').length,
    'a standalone log.css is no longer a false positive (the old \\blog\\.css\\b matched it, and not blog.css)');
  const css = stripComments(readFileSync(join(ROOT, 'design', 'library.css'), 'utf8'));
  check(!/blog\.css/.test(css), 'design/library.css names the blog only in a COMMENT — the stripped CSS the page inlines is clean');
  check(leaks(css).length === 0, `the stripped design CSS the pages inline passes (${leaks(css).length} problem(s))`);
}

/* ---------- §5 the prose exemption the gate already had is intact ---------- */

section('the exemptions the gate already had still hold');
{
  check(leaks('<p>It is the build in the old sense of the word.</p>').length === 0,
    '"the build in" is still permitted (the allowed-list mechanism, unchanged)');
  check(WHAT(leaks('<p>Read the build log.</p>')).includes('authoring reference'),
    '"the build" itself is still a leak');
  check(leaks('the extract from Zosimus', { data: true }).length === 0,
    'a data file is still read by the hard rules only (the book may say "the extract")');
}

section('the built tree passes the gate the build runs');
{
  for (const rel of ['index.html', 'about/index.html', 'editions/index.html', 'texts/index.html']) {
    const f = join(DIST, rel);
    if (!existsSync(f)) { check(false, `${rel}: not built — run node build/build.mjs first`); continue; }
    const p = leaks(readFileSync(f, 'utf8'));
    check(p.length === 0, `${rel}: clean (${p.length} problem(s)${p.length ? `: ${p[0]}` : ''})`);
  }
}

console.log(failures === 0 ? '\nleak-probe: all checks passed' : `\nleak-probe: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
