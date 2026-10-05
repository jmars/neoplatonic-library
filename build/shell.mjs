/**
 * build/shell.mjs — the page shell: identity, chrome, page assembly.
 *
 * The library's own chrome, in its own design system (design/library.css,
 * DESIGN-SYSTEM.md): a MASTHEAD (the wordmark in the display serif, a rubric
 * rule, the one-line statement), a quiet scholarly NAV (Texts · Graph · Search ·
 * Editions · About · Errata), the page's own head (eyebrow, heading, standfirst),
 * and a COLOPHON footer (licence, how to cite, provenance). The page is a leaf of
 * an edition, not a screen of a shell.
 *
 * What came over from the blog's tools/build.mjs and is KEPT: esc/xesc,
 * section(), toc(), the viz asset inliner (no route uses a widget; the inliner
 * is kept so a figure page needs no second copy of it), sitemapXml, robotsTxt,
 * writePage/writeFile, and the identity source — every identity string comes
 * from data/site.json, and none is hardcoded twice.
 *
 * What was REMOVED (DESIGN-SYSTEM.md §8): the terminal-prompt hero and its `$`,
 * the blinking cursor, the `ls`/`cat`/`group` command-line palette, the dose
 * meter, the series dropdowns, and the theme toggle with its dark palette. The
 * reading room is paper: light only.
 *
 * PAGE_CSS IS GONE. The site chrome and the .prose reading layer live in
 * design/library.css, which page() inlines (comment-stripped) as the first
 * <style> in the head. The reader's own stylesheet (READER_CSS, build/library.mjs)
 * is layered after it and binds to the same token names.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments, stripJsComments } from './leak.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const DIST = join(ROOT, 'site', 'dist');
const CSS = join(ROOT, 'design', 'library.css');

/** Site-wide identity — the ONE place the identity strings live (plan §1.6).
 * data/site.json is the model §2 record. */
export const SITE = JSON.parse(readFileSync(join(ROOT, 'data', 'site.json'), 'utf8'));

/** Canonical origin. Every absolute URL the build emits (og:url, canonical,
 * sitemap, robots) is derived from this one value. */
export const BASE = `https://${SITE.host}`;

/** The library's own routes, in nav order (plan §1.3): texts · graph · search ·
 * editions · about · errata. NO blog series, no dropdowns. */
/* The library's own routes, in nav order (DESIGN-SYSTEM.md §5): texts · graph ·
 * search · editions · about · errata. NO blog series, no dropdowns. */
export const NAV = [
  { url: '/texts/', label: 'Texts' },
  { url: '/graph/', label: 'Graph' },
  { url: '/search/', label: 'Search' },
  { url: '/editions/', label: 'Editions' },
  { url: '/about/', label: 'About' },
  { url: '/errata/', label: 'Errata' },
];

const log = (msg) => console.log(`[build] ${msg}`);

const esc = (s) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** XML text/attribute escaping — esc plus the apostrophe (RSS descriptions
 * are quoted text, so every literal must be accounted for). */
const xesc = (s) => esc(s).replaceAll("'", '&apos;');


/* ---------- identity (the one place the brand is written) ---------- */

/** The masthead wordmark's text. The name is DATA (data/site.json §2), not a
 * second copy of the string. */
const WORDMARK = SITE.name;

/** The one-line statement of what the library is (DESIGN-SYSTEM.md §2). It
 * belongs to the LIBRARY and not to any page, so it is written once, here. */
const STATEMENT =
  'Restored public-domain editions of the Neoplatonic tradition, with their repair logs and their citation graph.';

/** The masthead: the wordmark (an <h1> on the home page, so the reading room's
 * own heading IS the library's name; a <p> everywhere else, where the page's own
 * heading does that job), the rubric rule, and the statement. */
function masthead(home) {
  /* On the home page the wordmark IS the current location, and the nav has no
   * entry to light for `/` — so the wordmark carries both the marker class the
   * nav uses for its current entry and `aria-current`, and the CSS lights it
   * (MEASURED: the marker was in the markup on the home page alone and nothing
   * styled it, so the current location was invisible there). */
  const link = `<a href="/"${home ? ' class="home" aria-current="page"' : ''}>${esc(WORDMARK)}</a>`;
  return (
    `<header class="masthead"><div class="wrap">` +
    (home ? `<h1 class="wordmark">${link}</h1>` : `<p class="wordmark">${link}</p>`) +
    `<hr class="rule rule--rubric">` +
    `<p class="statement">${esc(STATEMENT)}</p>` +
    `</div></header>`
  );
}

/** The quiet scholarly nav: the library's own routes, in DESIGN-SYSTEM.md §5's
 * order. A page under a section keeps that section's link lit
 * ('/texts/<slug>/' lights 'Texts'), which is what the library needs — a
 * hundred addresses under one nav entry. The wordmark above is the home link. */
function siteNav(current) {
  return (
    `<nav><div class="wrap"><span class="links">` +
    NAV.map((r) => {
      const lit = current === r.url || (r.url !== '/' && current.startsWith(r.url));
      return `<a${lit ? ' class="home"' : ''} href="${r.url}">${esc(r.label)}</a>`;
    }).join('') +
    `</span></div></nav>`
  );
}

/** The page's own head: the eyebrow (a small-caps section label), the heading,
 * and a one-line standfirst. `heading` is HTML (an edition's title is escaped by
 * its caller); `eyebrow` and `standfirst` are text. A page with no heading gets
 * no head block (the home page: the masthead's statement is its lede). */
function pageHead({ eyebrow, heading, standfirst }) {
  if (!heading) return '';
  return (
    `<div class="page-head"><div class="wrap">` +
    (eyebrow ? `<span class="eyebrow">${esc(eyebrow)}</span>` : '') +
    `<h1>${heading}</h1>` +
    (standfirst ? `<p class="standfirst">${standfirst}</p>` : '') +
    `</div></div>`
  );
}

/** A section of a page: its heading, its one-line description, then the reading
 * column. `before` and `after` are chrome that belongs inside the same wrap but
 * OUTSIDE the reading column — the contents list and the part pager, which must
 * not join .prose. `id` makes the section an anchor, so a page's own contents
 * list (and a citation to a section) can reach it.
 *
 * `prose: false` for a body that is an INTERFACE rather than prose — the
 * apparatus viewer is a grid of controls and a page image, and `.prose` caps its
 * child at --measure (544px) on screen, which held the viewer's own grid to a
 * third of the column it is given. Such a body is emitted as it stands; any
 * genuinely prose piece inside it carries `.prose` itself. */
function section(h2, hint, body, { id = '', before = '', after = '', prose = true } = {}) {
  return (
    `<section${id ? ` id="${esc(id)}"` : ''}><div class="wrap">` +
    `<h2>${h2}</h2>` +
    (hint ? `<div class="hint">${hint}</div>` : '') +
    before +
    (prose ? `<div class="prose">${body}</div>` : body) +
    after +
    `</div></section>`
  );
}

/** THE BREADCRUMB: where this page sits in the library, from the front door in
 * (DESIGN-SYSTEM.md §5). `crumbs` is `{ label, href }[]`; the last crumb is the
 * page itself and carries `aria-current`, so it is a statement and not a link.
 * A step with no page of its own (an author) has no `href` and is a statement
 * too. A page with no hierarchy under it passes nothing and gets nothing. */
function breadcrumb(crumbs) {
  if (!crumbs || crumbs.length === 0) return '';
  return (
    `<nav class="crumbs" aria-label="Breadcrumb"><div class="wrap"><ol>` +
    crumbs
      .map((c, i) => {
        const last = i === crumbs.length - 1;
        if (last) return `<li><span aria-current="page">${esc(c.label)}</span></li>`;
        return `<li>${c.href ? `<a href="${esc(c.href)}">${esc(c.label)}</a>` : `<span>${esc(c.label)}</span>`}</li>`;
      })
      .join('') +
    `</ol></div></nav>`
  );
}

/** The colophon: a library's footer — licence, how to cite, provenance — in
 * three columns, with the host and the licence split on one line beneath. Every
 * string is data (data/site.json) or a link to a page that states it in full. */
function colophon() {
  return (
    `<footer class="colophon"><div class="wrap">` +
    `<div class="colophon-grid">` +
    `<div><h2>Licence</h2>` +
    `<p>Texts public domain · editorial work ${esc(SITE.licence.editorial)}.</p>` +
    `<p><a href="/about/">The full statement</a></p></div>` +
    `<div><h2>How to cite</h2>` +
    `<p>Cite the edition, the version, and the URL — each edition page carries its own citation.</p>` +
    `<p><a href="/about/">Citation policy</a></p></div>` +
    `<div><h2>Provenance</h2>` +
    `<p>Every edition is a transcription of a printed book, with its repairs recorded as rules.</p>` +
    `<p><a href="/editions/">Editorial policy</a> · <a href="/errata/">Errata</a></p></div>` +
    `</div>` +
    `<p class="colophon-foot">${esc(SITE.host)} · self-contained · no trackers</p>` +
    `</div></footer>`
  );
}


/* ---------- interactive figures (tools/viz/) ---------- */

const VIZ_DIR = join(ROOT, 'tools', 'viz');
const VIZ_ENGINE = join(VIZ_DIR, 'engine.js');
const VIZ_CSS = join(VIZ_DIR, 'viz.css');

/** Widget names a rendered body asks for, in first-use order. */
function vizSlots(body) {
  const names = [];
  // both quote styles: an author writing data-viz='runaway' must not be
  // silently shipped an empty box with no script and no viz.css
  for (const m of body.matchAll(/data-viz=(["'])([a-z0-9-]+)\1/g)) {
    if (!names.includes(m[2])) names.push(m[2]);
  }
  return names;
}

/**
 * The figure assets a page needs — or null, so a page with no [data-viz] slot
 * is built exactly as it was before this feature existed.
 *
 * The engine and the page's widgets are concatenated into one IIFE: the page
 * carries only the code it uses (tree-shaken by concatenation, the build is
 * the bundler) and nothing is fetched at runtime.
 */
function vizAssets(body) {
  const slots = vizSlots(body);
  if (slots.length === 0) return null;
  const widgets = slots.map((name) => {
    const file = join(VIZ_DIR, `${name}.js`);
    if (!existsSync(file)) throw new Error(`data-viz="${name}" has no widget at tools/viz/${name}.js`);
    return stripJsComments(readFileSync(file, 'utf8'));
  });
  const js = ['(function () {', "'use strict';", stripJsComments(readFileSync(VIZ_ENGINE, 'utf8')), ...widgets, '})();'].join('\n');
  return { slots, css: stripComments(readFileSync(VIZ_CSS, 'utf8')), script: `<script>\n${js}\n</script>\n` };
}

/** Full self-contained document. The order is the design system's: masthead,
 * nav, content, colophon (§5). A skip link is the first thing in the tab order
 * and <main> is the landmark it reaches. */
function page({ title, description, navCurrent, eyebrow, heading, standfirst, body, type = 'article', shareTitle, noindex = false, arrive, head, crumbs }) {
  const designCss = stripComments(readFileSync(CSS, 'utf8'));
  const viz = vizAssets(body);

  // Share metadata. The URL is derived from navCurrent (the same value that
  // drives the nav highlight), so a page cannot advertise a canonical URL that
  // is not its own. og:title strips markup — a heading may carry a <span>.
  // An index-excluded page (the 404) has no URL of its own to advertise, so it
  // carries no canonical and no og:url.
  const url = navCurrent === '/' ? `${BASE}/` : `${BASE}${navCurrent}`;
  const share = (shareTitle || title).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const meta =
    `<title>${esc(title)}</title>\n` +
    `<meta name="description" content="${esc(description)}">\n` +
    (noindex ? `<meta name="robots" content="noindex">\n` : `<link rel="canonical" href="${url}">\n`) +
    `<meta property="og:type" content="${type}">\n` +
    `<meta property="og:site_name" content="${esc(SITE.name)}">\n` +
    `<meta property="og:title" content="${esc(share)}">\n` +
    `<meta property="og:description" content="${esc(description)}">\n` +
    (noindex ? `` : `<meta property="og:url" content="${url}">\n`) +
    `<meta name="twitter:card" content="summary">\n` +
    `<meta name="twitter:title" content="${esc(share)}">\n` +
    `<meta name="twitter:description" content="${esc(description)}">`;

  const home = navCurrent === '/';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${meta}
<style>
${designCss}</style>
${viz ? `<style>\n${viz.css}</style>\n` : ''}${head || ''}
</head>
<body>
<a class="skip" href="#main">Skip to the text</a>
${masthead(home)}
${siteNav(navCurrent)}
<main id="main">
${breadcrumb(crumbs)}
${pageHead({ eyebrow, heading, standfirst })}
${body}
</main>
${colophon()}
${viz ? viz.script : ''}${arrive ? `<script>\n${arrive}\n</script>` : ''}</body>
</html>
`;

  // A widget or page that writes '\\u2014' where it meant '\u2014' escapes the
  // escape: the page renders a literal backslash-u sequence. Only a rendered page
  // can show it (the string usually lives in an inlined widget script), so gate
  // the assembled document — an invisible defect other checks cannot see.
  const escaped = html.match(/\\\\u[0-9a-fA-F]{4}/);
  if (escaped) {
    throw new Error(
      `literal escape sequence ${escaped[0]} in the rendered page ('${String(heading || title).slice(0, 40)}…') — ` +
        `a backslash was doubled somewhere, usually in a widget string.`,
    );
  }
  return html;
}

const TOC_MIN = 5;
function toc(body) {
  // pandoc wraps a long heading's attributes across lines, so the tag must be
  // matched loosely and the id read out of it (same reason as the footnote refs)
  const headings = [...body.matchAll(/<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g)];
  if (headings.length < TOC_MIN) return '';
  const items = headings
    .map(([, id, text]) => `<li><a href="#${id}">${text.replace(/\s+/g, ' ').trim()}</a></li>`)
    .join('');
  return (
    `<details class="toc"><summary>Contents <span class="toc-n">${headings.length} sections</span></summary>` +
    `<ol>${items}</ol></details>`
  );
}

/* ---------- the sitemap and robots ---------- */

/** The library's own URL set — the routes, plus whatever the build passes in
 * (the edition pages and their pinned versions). The blog's sitemap used to
 * carry the library's URLs; here the relation inverts (plan §1.1). */
export function sitemapXml(extra = []) {
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${BASE}/`, lastmod: null },
    ...extra.map((rel) => ({ loc: `${BASE}${rel}`, lastmod })),
  ]
    .map(
      (u) =>
        `  <url>\n    <loc>${u.loc}</loc>\n` +
        (u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : '') +
        `  </url>`,
    )
    .join('\n');
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${urls}\n` +
    `</urlset>\n`
  );
}

export function robotsTxt() {
  return (
    `# ${SITE.host} — every published page is public; there is nothing to disallow.\n` +
    `User-agent: *\n` +
    `Allow: /\n` +
    `\n` +
    `Sitemap: ${BASE}/sitemap.xml\n`
  );
}

/* ---------- writing ---------- */

export function writePage(rel, pageDef) {
  const out = join(DIST, rel);
  mkdirSync(dirname(out), { recursive: true });
  const html = page(pageDef);
  writeFileSync(out, html);
  log(`wrote ${rel} (${Buffer.byteLength(html)} bytes)`);
  const slots = vizSlots(html);
  if (slots.length) log(`  \u21b3 inlined figures: ${slots.join(', ')}`);
  return html;
}

/** A generated non-page file (sitemap, robots, an export). Written like a page,
 * but the caller decides whether the leak gate scans it as a page or as data. */
export function writeFile(rel, text) {
  const out = join(DIST, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  log(`wrote ${rel} (${Buffer.byteLength(text)} bytes)`);
  return text;
}

export {
  esc,
  xesc,
  stripComments,
  WORDMARK,
  STATEMENT,
  masthead,
  siteNav,
  pageHead,
  section,
  colophon,
  breadcrumb,
  toc,
  vizSlots,
  vizAssets,
};
