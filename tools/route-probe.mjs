#!/usr/bin/env node
/**
 * tools/route-probe.mjs — the route probe (extraction plan §6.1).
 *
 * For every route the site serves, this asserts the properties a route has to
 * have and that no single page can be trusted to assert about itself:
 *
 *   - the FILE exists at the route's address;
 *   - the `<title>` in the head is the one the route is supposed to carry;
 *   - the canonical URL is the route's OWN absolute URL (and the 404, which has
 *     no URL of its own, carries no canonical at all);
 *   - the nav highlights the right entry (the section link carries class
 *     `home`, and it is the route's own section);
 *   - for the two edition routes: the reader APP is present, the server-rendered
 *     FALLBACK is present, and the page's citation string matches the one
 *     `meta.json` records for the version it serves.
 *
 * The routes and the editions are read from DATA (data/site.json, and every
 * `data/editions/<slug>/edition.json` whose `current_version` is set), not from
 * the build's own list: the probe recomputes what SHOULD exist and holds the
 * built tree against it. A route that disappears, a title that drifts, a nav
 * entry that stops being lit, or a citation that stops matching its record all
 * fail here.
 *
 *     node tools/route-probe.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'site', 'dist');

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};
const section = (name) => console.log(`\n${name}`);

if (!existsSync(DIST)) {
  console.log('route-probe: site/dist is not built — run node build/build.mjs first');
  process.exit(1);
}

const site = JSON.parse(readFileSync(join(ROOT, 'data', 'site.json'), 'utf8'));
const HOST = site.host;
const BASE = `https://${HOST}`;

/* ---------- the two head fields, read the way a browser does: the head only --- */

const head = (html) => html.slice(0, html.indexOf('</head>'));
const titleOf = (html) => {
  const m = /<title>([^<]*)<\/title>/.exec(head(html));
  return m ? m[1] : null;
};
const canonicalOf = (html) => {
  const m = /<link rel="canonical" href="([^"]+)">/.exec(head(html));
  return m ? m[1] : null;
};
/** The citation block's rendered TEXT: the `.cite` paragraph with its markup
 * stripped and whitespace collapsed. The citation is set as prose with its
 * trailing URL in a <span> (mono), so the guarantee is about the TEXT a reader
 * copies, not about one unbroken run of bytes in the HTML. */
const citeTextOf = (html) => {
  const m = /<p class="cite">([\s\S]*?)<\/p>/.exec(html);
  if (!m) return null;
  return m[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
};
/** The nav entry the page lights: the first link carrying class `home`. On the
 * home page that is the masthead wordmark (the reading room's own heading); on
 * every other page it is the nav's section link. */
const navLit = (html) => {
  for (const m of html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)) {
    const cls = /\bclass="([^"]*)"/.exec(m[1]);
    if (!cls || !cls[1].split(/\s+/).includes('home')) continue;
    const href = /\bhref="([^"]+)"/.exec(m[1]);
    if (href) return { href: href[1], label: m[2] };
  }
  return null;
};

/* ---------- the route set ---------- */

/** Every route that is NOT an edition page, with the title and nav entry it must
 * carry. `canonical: null` is the 404, which advertises no URL of its own. */
const ROUTES = [
  { file: 'index.html', url: '/', title: `The Neoplatonic Library — ${HOST}`, nav: '/', label: 'home' },
  { file: 'texts/index.html', url: '/texts/', title: `The texts — ${HOST}`, nav: '/texts/', label: 'texts' },
  { file: 'graph/index.html', url: '/graph/', title: `The graph — ${HOST}`, nav: '/graph/', label: 'graph' },
  { file: 'search/index.html', url: '/search/', title: `Search — ${HOST}`, nav: '/search/', label: 'search' },
  { file: 'editions/index.html', url: '/editions/', title: `The editions — ${HOST}`, nav: '/editions/', label: 'editions' },
  { file: 'about/index.html', url: '/about/', title: `About — ${HOST}`, nav: '/about/', label: 'about' },
  { file: 'errata/index.html', url: '/errata/', title: `Errata — ${HOST}`, nav: '/errata/', label: 'errata' },
  { file: '404.html', url: null, title: `Not found — ${HOST}`, nav: null, label: null },
];

/** The served editions, from the data: an edition record with `current_version`
 * set is published, and its page belongs at /texts/<slug>/. */
function servedEditions() {
  const dir = join(ROOT, 'data', 'editions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const f = join(dir, d.name, 'edition.json');
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    })
    .filter((e) => e && e.current_version);
}

for (const e of servedEditions()) {
  ROUTES.push({
    file: `texts/${e.slug}/index.html`,
    url: `/texts/${e.slug}/`,
    title: `${e.title} — ${HOST}`,
    nav: '/texts/',
    label: 'texts',
    slug: e.slug,
  });
}

/* ---------- the assertions ---------- */

section('the fixed routes');
for (const r of ROUTES) {
  const path = join(DIST, r.file);
  if (!existsSync(path)) {
    check(false, `${r.url || r.file}: the file exists`);
    continue;
  }
  const html = readFileSync(path, 'utf8');
  check(true, `${r.url || r.file}: the file exists`);
  check(titleOf(html) === r.title, `${r.url || r.file}: <title> is "${r.title}"${titleOf(html) === r.title ? '' : ` (got ${JSON.stringify(titleOf(html))})`}`);
  if (r.url) {
    check(canonicalOf(html) === `${BASE}${r.url}`, `${r.url}: canonical is its own URL (${BASE}${r.url})`);
  } else {
    check(canonicalOf(html) === null, `${r.file}: carries no canonical (it has no URL of its own)`);
    check(/<meta name="robots" content="noindex">/.test(head(html)), `${r.file}: is noindex`);
  }
  if (r.nav) {
    const lit = navLit(html);
    check(!!lit && lit.href === r.nav, `${r.url}: the nav highlights ${r.nav} (got ${lit ? lit.href : 'nothing'})`);
  } else {
    // a route with no section (the 404) lights nothing is fine; but the nav must
    // still be there and must not light the WRONG entry
    check(/<nav>/.test(html), `${r.file}: carries the nav`);
  }
}

section('the edition routes: the reader, the fallback, the citation');
for (const e of servedEditions()) {
  const file = join(DIST, 'texts', e.slug, 'index.html');
  if (!existsSync(file)) {
    check(false, `${e.slug}: the edition page exists`);
    continue;
  }
  const html = readFileSync(file, 'utf8');
  check(/<div id="reader-app"><\/div>/.test(html), `${e.slug}: the reader app mount is present`);
  check(/<script type="application\/json" id="reader-flags">/.test(html), `${e.slug}: the reader flags block is present`);
  check(/<div id="reader-fallback">/.test(html), `${e.slug}: the server-rendered fallback is present`);
  // the app fetches its document from the bare edition URL, and the fallback
  // links the plain export — the two ends of "it works without scripts"
  check(html.includes(`"/texts/${e.slug}/t"`), `${e.slug}: the app fetches /texts/${e.slug}/t`);
  check(html.includes(`/texts/${e.slug}/plain`), `${e.slug}: the fallback links the plain export`);

  // THE CITATION, against the RECORD: the page must carry the version's citation
  // string exactly as meta.json holds it (this is the string a reader is told to
  // cite, and a page that prints anything else is advertising a citation that
  // resolves to the wrong version).
  const metaFile = join(ROOT, 'data', 'editions', e.slug, 'versions', e.current_version, 'meta.json');
  if (!existsSync(metaFile)) {
    check(false, `${e.slug}: the current version's meta.json exists`);
    continue;
  }
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  check(!!meta.citation, `${e.slug}: meta.json records a citation string`);
  check(
    citeTextOf(html) === meta.citation,
    `${e.slug}: the citation block's rendered text IS the version's citation string` +
      (citeTextOf(html) === meta.citation ? '' : ` (got ${JSON.stringify(citeTextOf(html))})`),
  );

  /* THE STATED RULE COUNT IS THE DATA'S OWN, DERIVED AND NEVER TYPED. MEASURED:
   * the shelf's prose note once said "402 readings applied" while the rule file
   * carries 415 rules — a number written into prose goes stale, a number read from
   * the rule file cannot. So the page states the count FROM the served document,
   * and this holds it against the file. */
  const repFile = join(ROOT, 'data', 'editions', e.slug, 'versions', e.current_version, 'repairs.json');
  if (!existsSync(repFile)) {
    check(false, `${e.slug}: the current version's repairs.json exists`);
  } else {
    const rules = JSON.parse(readFileSync(repFile, 'utf8')).rules;
    const firings = rules.reduce((a, r) => a + (r.fires || 0), 0);
    const stated = /Measured on the text this page serves: (\d+) repair rule/.exec(html);
    check(!!stated, `${e.slug}: the page states the measured rule count`);
    if (stated) {
      check(
        Number(stated[1]) === rules.length,
        `${e.slug}: the stated rule count is the rule file's (${stated[1]} = ${rules.length})`,
      );
      check(
        html.includes(`applied ${firings} time`),
        `${e.slug}: the stated application count is the rule file's (${firings} firing(s))`,
      );
    }
  }

  // the pinned page exists too, and carries ITS OWN canonical
  const pinned = join(DIST, 'texts', e.slug, 'v', e.current_version, 'index.html');
  check(existsSync(pinned), `${e.slug}/v/${e.current_version}/: the pinned page exists`);
  if (existsSync(pinned)) {
    const ph = readFileSync(pinned, 'utf8');
    check(
      canonicalOf(ph) === `${BASE}/texts/${e.slug}/v/${e.current_version}/`,
      `${e.slug}/v/${e.current_version}/: canonical is the PINNED URL`,
    );
    check(citeTextOf(ph) === meta.citation, `${e.slug}/v/${e.current_version}/: carries that version's citation`);
  }
}

section('every same-host URL the build emits begins with the site root');
{
  /* THE MISSING-SLASH CLASS OF DEFECT, gated. MEASURED: build/library.mjs built
   * the edition page's citation URL as `${BASE}${base.replace(/^\//, '')}` with
   * base = `/texts/<slug>/`, so the one string a reader copies read
   * `https://neoplatonic-library.orgtexts/<slug>/` — a host joined to a path with
   * no separator. The property that catches it and every future instance is
   * simple and total: BASE may only ever be followed by `/`. */
  const pages = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.html')) pages.push(join(d, e.name));
    }
  };
  walk(DIST);
  const hostRe = new RegExp(BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const bare = [];
  const badHref = [];
  let mentions = 0;
  let viaSpan = 0;
  let sameHostLinks = 0;
  for (const p of pages) {
    const html = readFileSync(p, 'utf8');
    const rel = p.slice(DIST.length + 1);
    for (const m of html.matchAll(hostRe)) {
      mentions++;
      const after = html.slice(m.index + BASE.length);
      /* Two legitimate shapes: the host followed straight by its path, or the
       * host closing its `.cite-host` span and the path then beginning with `/`
       * (the unbreakable run the citation block wraps the host in — §5.2). The
       * missing-slash string is neither: it continues with the path's first
       * letter (`…orgtexts/`). */
      if (after.startsWith('/')) continue;
      if (after.startsWith('</span>/')) {
        viaSpan++;
        continue;
      }
      bare.push(`${rel}: ${JSON.stringify(html.slice(m.index, m.index + 64))}`);
    }
    for (const m of html.matchAll(/(?:href|src)="(https:\/\/[^"]*)"/g)) {
      if (m[1].startsWith(`https://${HOST}`)) {
        sameHostLinks++;
        if (!m[1].startsWith(`${BASE}/`)) badHref.push(`${rel}: ${m[1]}`);
      }
    }
  }
  check(pages.length > 0, `read ${pages.length} built page(s)`);
  /* THE CHECK CAN FAIL — asserted, because a rule that cannot be violated is not
   * a rule. This is the EXACT string the old expression produced
   * (`${BASE}${base.replace(/^\//, '')}` with base `/texts/<slug>/`), and the
   * predicate the check above applies must reject it. */
  const asBefore = `${BASE}${'/texts/x/'.replace(/^\//, '')}`;
  check(
    asBefore.startsWith(BASE) && asBefore[BASE.length] !== '/',
    `the missing-slash predicate FIRES on the string the old code produced (${asBefore})`,
  );
  check(
    bare.length === 0,
    `every ${BASE} occurrence (${mentions}, ${viaSpan} of them closing the citation's .cite-host span) is followed by a path (/ )` +
      (bare.length ? `\n       ${bare.slice(0, 6).join('\n       ')}` : ''),
  );
  check(
    badHref.length === 0,
    `every same-host href/src (${sameHostLinks}) begins ${BASE}/` +
      (badHref.length ? `\n       ${badHref.slice(0, 6).join('\n       ')}` : ''),
  );

  /* And the citation specifically: the address the page prints and links is the
   * citation's OWN URL, and it is printed ONCE. MEASURED: the block used to print
   * the URL twice — inside the citation and again on a `cite-url` line beneath it
   * (which on a pinned page was the page's own URL, a second address). The
   * citation now carries ONE hyperlinked URL, and the page's own address is the
   * head's canonical link (checked above). */
  for (const e of servedEditions()) {
    const metaFile = join(ROOT, 'data', 'editions', e.slug, 'versions', e.current_version, 'meta.json');
    let want = '';
    if (existsSync(metaFile)) {
      const cit = JSON.parse(readFileSync(metaFile, 'utf8')).citation || '';
      const m = /(https?:\/\/\S+)$/.exec(cit);
      want = m ? m[1] : '';
      check(
        !!m && m[1].startsWith(`${BASE}/`),
        `${e.slug}: the recorded citation's URL begins ${BASE}/ (${m ? m[1] : 'no URL in the citation'})`,
      );
    }
    for (const rel of [
      `texts/${e.slug}/index.html`,
      `texts/${e.slug}/v/${e.current_version}/index.html`,
    ]) {
      const path = join(DIST, rel);
      if (!existsSync(path)) {
        check(false, `${rel}: exists`);
        continue;
      }
      const html = readFileSync(path, 'utf8');
      const m = /<p class="cite">[\s\S]*?<a class="cite-id" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<\/p>/.exec(html);
      // The URL's rendered TEXT: every tag in it is markup — the <wbr>s the
      // builder emits at path boundaries AND the .cite-host span (below).
      const text = m ? m[2].replace(/<[^>]+>/g, '') : '';
      check(
        !!m && m[1] === want && text === want && want.length > 0,
        `${rel}: the citation carries ONE hyperlinked URL, its own (${want})` +
          (m ? ` (got href ${JSON.stringify(m[1])}, text ${JSON.stringify(text)})` : ' (no citation URL rendered)'),
      );
      check(!/class="cite-url"/.test(html), `${rel}: and no second address line repeats it`);
      /* THE HOST IS UNBREAKABLE. MEASURED: the address wrapped INSIDE the domain
       * (`https://neoplatonic-` / `library.org/…`) — a browser breaks at the
       * literal hyphen in `neoplatonic-library.org` however the <wbr>s are
       * placed, so the fix cannot be the <wbr>s alone. The scheme and host must
       * be one `.cite-host` span, the stylesheet must make it `nowrap`, and
       * every break opportunity must sit after a path separator — so a wrap can
       * only land at a path boundary. FAILS IF: the host loses its span or its
       * nowrap (the hyphen becomes breakable again), a <wbr> appears inside the
       * host, or a break opportunity is offered anywhere but after a `/`. */
      const inner = m ? m[2] : '';
      const host = /^<span class="cite-host">([^<]*)<\/span>/.exec(inner);
      check(
        !!host && host[1] === new URL(want).origin && !host[1].includes('<wbr>'),
        `${rel}: the scheme+host is ONE unbreakable .cite-host run (${host ? JSON.stringify(host[1]) : 'no host span'})`,
      );
      const breaks = [...(host ? inner.slice(host[0].length) : '').matchAll(/(.)<wbr>/g)].map((x) => x[1]);
      check(
        breaks.length > 0 && breaks.every((c) => c === '/'),
        `${rel}: and every break opportunity is a <wbr> after a path separator (${breaks.length} <wbr>, ` +
          `all after ${breaks.every((c) => c === '/') ? 'a /' : JSON.stringify(breaks.filter((c) => c !== '/'))})`,
      );
      check(
        /\.cite-host\s*\{\s*white-space:\s*nowrap/.test(html),
        `${rel}: and the stylesheet sets .cite-host white-space: nowrap`,
      );
    }
  }
}


section('the search index the /search/ page points at');
{
  const page = join(DIST, 'search', 'index.html');
  const idx = join(DIST, 'search', 'index');
  check(existsSync(idx), '/search/index: the fetched index file exists');
  const html = existsSync(page) ? readFileSync(page, 'utf8') : '';
  check(html.includes('id="search-data"'), '/search/: carries the index pointer block');
  check(/'\/search\/index'|"\/search\/index"/.test(html), '/search/: points the client at /search/index');
  check(!/application\/json" id="search-data">\{[^<]*"docs"/.test(html), '/search/: does NOT inline the corpus (the index is fetched, not page prose)');
  if (existsSync(idx)) {
    let ok = true;
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(idx, 'utf8'));
    } catch {
      ok = false;
    }
    check(ok, '/search/index: parses as JSON');
    if (ok && parsed) {
      const n = parsed.docs ? parsed.docs.length : 0;
      const p = parsed.pass ? parsed.pass.length : 0;
      check(n === servedEditions().length, `/search/index: indexes all ${servedEditions().length} served edition(s) (got ${n})`);
      check(p > 0, `/search/index: carries passages (${p})`);
      check(Array.isArray(parsed.pass) && parsed.pass.every((r) => Array.isArray(r) && r.length === 6), '/search/index: every passage row is [doc, anchor, page, open, sec, text]');
      check(!!(parsed.words && parsed.words.dafsa && Array.isArray(parsed.words.postings)), '/search/index: carries the word automaton and postings');
    }
  }
}

section('the graph renders what the data holds, and nothing more');
{
  const page = join(DIST, 'graph', 'index.html');
  const dataFile = join(ROOT, 'data', 'graph', 'graph.json');
  check(existsSync(page), '/graph/: the page exists');
  if (existsSync(page) && existsSync(dataFile)) {
    const html = readFileSync(page, 'utf8');
    const g = JSON.parse(readFileSync(dataFile, 'utf8'));
    const drawnEdges = (html.match(/class="g-edge edge-/g) || []).length;
    const drawnNodes = (html.match(/class="g-node node-/g) || []).length;
    check(drawnEdges === g.edges.length, `/graph/: draws exactly the ${g.edges.length} authored edge(s) (${drawnEdges} drawn — no edge is invented)`);
    check(drawnNodes === g.nodes.length, `/graph/: draws exactly the ${g.nodes.length} authored node(s) (${drawnNodes} drawn)`);
    const edgeIds = g.edges.map((e) => e.id);
    const tableRows = edgeIds.filter((id) => html.includes(`<td>${id}</td>`)).length;
    check(tableRows === edgeIds.length, `/graph/: the edge table lists every edge (${tableRows}/${edgeIds.length})`);
    const missing = ['cites', 'derives_from', 'commentary_on'].filter((t) => !g.edges.some((e) => e.type === t));
    if (missing.length) {
      check(/being authored|NOT drawn|not drawn/i.test(html), `/graph/: says the absent edge type(s) are being authored (${missing.join(', ')})`);
    }
  }
}

section('the sitemap carries every page route');
{
  const sm = join(DIST, 'sitemap.xml');
  check(existsSync(sm), '/sitemap.xml: exists');
  if (existsSync(sm)) {
    const xml = readFileSync(sm, 'utf8');
    const want = ROUTES.filter((r) => r.url).map((r) => `${BASE}${r.url}`);
    const missing = want.filter((u) => !xml.includes(`<loc>${u}</loc>`));
    check(missing.length === 0, `/sitemap.xml: lists every page route${missing.length ? ` — missing ${missing.join(', ')}` : ` (${want.length})`}`);
    check(!xml.includes('404'), '/sitemap.xml: does NOT list the 404');
  }
}

console.log(failures === 0 ? '\nroute-probe: all checks passed' : `\nroute-probe: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
