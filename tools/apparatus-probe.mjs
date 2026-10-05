#!/usr/bin/env node
/**
 * tools/apparatus-probe.mjs — the apparatus as DATA, and the leaf viewer.
 *
 * THE CLAIMS this holds, each against something recomputed here rather than
 * against the viewer's own output:
 *
 *   §1  `/texts/<slug>/apparatus.json` exists, parses, and is the version's whole
 *       repair log — every rule, in record order, with the fields the data model
 *       names, plus the counts by type and the stored leaves. Every rule's
 *       evidence is held against `repairs.json` field by field, every
 *       `evidence.url` resolves to a file the site actually ships, and every
 *       stored leaf appears once with the number of readings decided from it.
 *   §2  the same apparatus is served at the PINNED address, and each edition page
 *       fetches its OWN version's file (a pinned page must not render the current
 *       version's log).
 *   §3  the edition HTML no longer carries the rule list — 0 rendered rule rows,
 *       and the page is far smaller than the log it used to inline.
 *   §4  the viewer BOOTS in a real DOM (happy-dom): it fetches the file, takes the
 *       server-rendered statement away, renders the index on TWO AXES — an
 *       `All readings` entry for the whole log and a `Without a page image` entry
 *       for the readings that carry none, both paged 25 at a time, over the leaf
 *       index — and LANDS on the first leaf that HAS readings, never on an empty
 *       one (and on the no-image group when no leaf carries one: booted against a
 *       doctored data file). THE WHOLE STORED SCAN is that index: every stored
 *       leaf, in leaf order, adjacent with nothing separated — the leaves a
 *       reading was decided from MARKED (a badge) and the rest as they are; a
 *       leaf no reading used still shows its page image and says plainly that it
 *       carries none; a pager steps to the next STORED leaf and is disabled at
 *       the ends. For a `#repair-<id>` fragment and for a `#leaf-nNNN` fragment
 *       it opens the entry that reading belongs to, TURNS TO THE PAGE of a paged
 *       list it falls on, renders the leaf and exactly the readings decided from
 *       it, and highlights the reading. The type filter and the word search
 *       narrow both axes; a click on a leaf moves the fragment. §4f exercises the
 *       cited-but-unheld branch (no served citation is unheld any more) on a
 *       doctored data file.
 *   §5  a fetch that FAILS leaves the statement standing and says so: the viewer
 *       never silently shows nothing.
 *   §6  the apparatus is laid out AT THE READER'S WIDTH, measured on the EMITTED
 *       stylesheet (the page's own inlined <style> blocks): `#the-apparatus .wrap`
 *       is --reader, the leaf index is 16rem and the panel takes the rest, and NO
 *       apparatus content rule caps itself short of the reader's own pane — the
 *       summary, the fallback, the status, the notes, the readings and the compact
 *       no-image list all take the column they are given — including the summary,
 *       which is the section's own `.hint` (the `.apparatus-summary` rule the report
 *       named carried no markup at all, and is gone). The leaf in the panel
 *       fills its column and is bounded by the COLUMN, not by a viewport height.
 *   §7  the viewer’s CONTAINING BLOCK is that column, not a `.prose` cap: §6 reads
 *       the RULES, and a rule with no max-width is still capped when an ANCESTOR
 *       carries one — which is what `.prose { max-width: var(--measure) }` (544px ON
 *       SCREEN) did while `#apparatus-viewer` was emitted inside a `.prose` box. §7
 *       walks the EMITTED markup’s own ancestor chain from the viewer to the section,
 *       cascades each element’s max-width and padding off the emitted stylesheet by
 *       specificity, and asserts the chain imposes nothing below the apparatus
 *       column — on the bare AND the pinned page. THE ASYMMETRY IS THE PROOF: the
 *       same walk over the pre-fix structure (the viewer re-wrapped in `.prose`, and
 *       the whole pre-fix page rebuilt) measures 544px and fails, where the emitted
 *       page measures 1192px.
 *
 * Run against a built tree:
 *
 *     node build/build.mjs && node tools/apparatus-probe.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { publishedTexts } from './shelf.mjs';

/** THE SERVED SET, from the shelf's own publication switch: the data directory
 * may hold an edition that is NOT served (an unrepaired transcription is held
 * back), and this probe's scope is the served site. */
const SERVED = new Set(publishedTexts().map((t) => t.slug));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'site', 'dist');

function happyDom() {
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.HAPPY_DOM,
    join(ROOT, 'node_modules', 'happy-dom'),
    join(ROOT, '..', 'fixpoint-linux', 'fixpointlinux.org', 'node_modules', 'happy-dom'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return require(c).Window;
  throw new Error(`happy-dom not found (looked in ${candidates.join(', ')}; set HAPPY_DOM=...)`);
}

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};
const section = (name) => console.log(`\n${name}`);

if (!existsSync(DIST)) {
  console.log('apparatus-probe: site/dist is not built — run node build/build.mjs first');
  process.exit(1);
}

/* ---------- the editions, from the data (never from the build's list) ---------- */

function servedEditions() {
  const dir = join(ROOT, 'data', 'editions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const f = join(dir, d.name, 'edition.json');
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    })
    .filter((e) => e && e.current_version && SERVED.has(e.slug));
}

const rulesFile = (slug, version) =>
  JSON.parse(readFileSync(join(ROOT, 'data', 'editions', slug, 'versions', version, 'repairs.json'), 'utf8'));

/** The stored leaves, as the BUILDER reads them: `{ n, file }`, sorted by the
 * leaf's number and then by name — the order build/apparatus.mjs writes, so the
 * probe and the file cannot disagree about it. The NAME is the identity (an
 * edition cut from two items has two leaves numbered 74); the NUMBER is what the
 * caption and the record's `leaf` field carry. */
const storedLeaves = (slug) => {
  const dir = join(ROOT, 'data', 'editions', slug, 'scans');
  if (!existsSync(dir)) return [];
  const re = /^(?:v\d+-)?n(\d+)\.jpg$/;
  return readdirSync(dir)
    .map((f) => {
      const m = re.exec(f);
      return m ? { n: Number(m[1]), file: f } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

const TYPES = ['OCR', 'punctuation', 'transliteration', 'conjectural'];
const seen = new Map(); // slug -> the parity of one edition's apparatus data

/** THE APPARATUS PAGE'S OWN FILE. The viewer lives on its own route now
 * (`/texts/<slug>/apparatus/`, and the pinned `/texts/<slug>/v/<semver>/apparatus/`),
 * so every check ABOUT the viewer reads THAT page; checks about the edition
 * page's own text read the edition page. */
const appPage = (slug, version = null) =>
  version
    ? join(DIST, 'texts', slug, 'v', version, 'apparatus', 'index.html')
    : join(DIST, 'texts', slug, 'apparatus', 'index.html');

/* ---------- §1 the data file ---------- */

section('the apparatus file is the version’s whole repair log, and every leaf url resolves');
const editions = servedEditions();
check(editions.length > 0, `read ${editions.length} served edition(s) from the data`);

for (const e of editions) {
  const rel = `texts/${e.slug}/apparatus.json`;
  const file = join(DIST, rel);
  if (!existsSync(file)) {
    check(false, `${rel}: exists`);
    continue;
  }
  check(true, `${rel}: exists (${statSync(file).size} bytes)`);
  let data = null;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    check(false, `${rel}: parses as JSON (${err.message})`);
    continue;
  }
  check(true, `${rel}: parses as JSON`);
  check(data.slug === e.slug && data.version === e.current_version, `${rel}: names ${e.slug} v${e.current_version}`);

  const rec = rulesFile(e.slug, e.current_version).rules;
  check(data.ruleCount === rec.length && data.rules.length === rec.length,
    `${rel}: carries all ${rec.length} rules of the version (ruleCount ${data.ruleCount})`);

  /* the counts are recomputed from the record, not read off the file */
  const want = {};
  for (const k of TYPES) {
    const n = rec.filter((r) => r.type === k).length;
    if (n) want[k] = n;
  }
  check(JSON.stringify(data.counts) === JSON.stringify(want),
    `${rel}: the counts by type are the record’s (${JSON.stringify(data.counts)})`);

  /* the rules, field by field, in record order */
  const bad = [];
  rec.forEach((r, i) => {
    const d = data.rules[i];
    if (!d) return bad.push(`r${i + 1}: missing`);
    const wantEv = (Array.isArray(r.evidence) ? r.evidence : []).map((x) => ({
      leaf: x.leaf,
      page: x.page != null ? x.page : null,
      url: x.exists ? x.url : null,
      exists: !!x.exists,
    }));
    const ok =
      d.id === r.id.split(':')[1] &&
      d.ref === r.id &&
      d.find === (r.location && r.location.find ? r.location.find : '') &&
      d.type === r.type &&
      d.apply === r.apply &&
      d.before === r.before &&
      d.after === r.after &&
      d.rationale === r.rationale &&
      d.witness === (r.witness || '') &&
      d.date === (r.date || null) &&
      JSON.stringify(d.evidence) === JSON.stringify(wantEv);
    if (!ok) bad.push(r.id);
  });
  check(bad.length === 0,
    `${rel}: every rule matches the record field for field, in order (${bad.length} differ${bad.length ? `: ${bad.slice(0, 3).join(', ')}` : ''})`);

  /* every evidence url RESOLVES — the built tree holds the leaf */
  const leaves = storedLeaves(e.slug);
  const unresolved = [];
  let citedHeld = 0;
  let citedUnheld = 0;
  for (const d of data.rules) {
    for (const ev of d.evidence) {
      if (ev.exists) citedHeld++;
      else citedUnheld++;
      if (!ev.url) continue;
      const f = join(DIST, ev.url.replace(/^\//, ''));
      if (!existsSync(f)) unresolved.push(ev.url);
      if (ev.url !== `/texts/${e.slug}/scans/n${ev.leaf}.jpg`) unresolved.push(`wrong address: ${ev.url}`);
    }
  }
  check(unresolved.length === 0,
    `${rel}: every held leaf’s url resolves to a shipped file (${citedHeld} entr(ies), ${unresolved.length} unresolved${unresolved.length ? `: ${unresolved[0]}` : ''})`);
  /* A CITED LEAF THE EDITION DOES NOT HOLD keeps its entry with url null (model
   * §4.4). MEASURED 2026-10-05: the WHOLE SCAN is stored, so no served citation
   * is unheld; the branch is exercised on a doctored data file in §4f, because a
   * path nothing calls is a path nobody has tested. */
  const unheldWithUrl = data.rules.flatMap((d) => d.evidence).filter((x) => !x.exists && x.url !== null);
  check(unheldWithUrl.length === 0, `${rel}: a cited-but-unheld leaf claims no url (${unheldWithUrl.length} do)`);
  console.log(`  NOTE ${rel}: ${citedUnheld} cited-but-unheld entr(ies) — the whole scan is stored, so none is expected`);

  /* the leaves: one entry per stored leaf, with the readings decided from it */
  check(data.leafCount === leaves.length && data.leaves.length === leaves.length,
    `${rel}: carries all ${leaves.length} stored leaves (leafCount ${data.leafCount})`);
  const badLeaf = data.leaves.filter((l, i) => l.n !== leaves[i].n || l.url !== `/texts/${e.slug}/scans/${leaves[i].file}`);
  check(badLeaf.length === 0, `${rel}: the leaf entries are the stored leaves, in order, at the served address (${badLeaf.length} wrong)`);
  /* A READING IS COUNTED AGAINST THE LEAF'S STORED NAME, not its number: two
   * volumes' leaves numbered 74 are two leaves (v1-n74, v2-n74). The apparatus
   * data carries each evidence entry's url, so the name is the url's basename. */
  const wantReadings = new Map(leaves.map((l) => [l.file, new Set()]));
  for (const d of data.rules) for (const ev of d.evidence) {
    if (!ev.exists) continue;
    const f = String(ev.url).split('/').pop();
    if (wantReadings.has(f)) wantReadings.get(f).add(d.id);
  }
  const badCount = data.leaves.filter((l, i) => l.readings !== wantReadings.get(leaves[i].file).size);
  check(badCount.length === 0, `${rel}: every leaf’s reading count is the record’s (${badCount.length} wrong)`);
  /* EVERY LEAF'S CARD IS ITS OWN: a duplicate key (two leaves of the same number)
   * would give two index cards one id and make the second unclickable — MEASURED
   * before the leaf key became the stored name. */
  const leafIds = data.leaves.map((l) => String(l.url).split('/').pop().replace(/\.jpg$/i, ''));
  check(new Set(leafIds).size === leafIds.length,
    `${rel}: every leaf's index key is unique (${leafIds.length - new Set(leafIds).size} duplicate(s))`);
  console.log(`  NOTE ${rel}: ${data.rules.length} rule(s), ${data.leaves.length} leaf/leaves, ` +
    `${data.leaves.filter((l) => l.readings).length} cited, ${[...wantReadings.values()].reduce((a, b) => a + b.size, 0)} reading(s) with a leaf`);

  seen.set(e.slug, { data, rec, leaves });
}

/* ---------- §2 the pinned address, and which file each page fetches ---------- */

section('the pinned version carries its own apparatus, and each page fetches its own');
for (const e of editions) {
  const bare = join(DIST, 'texts', e.slug, 'apparatus.json');
  const pinned = join(DIST, 'texts', e.slug, 'v', e.current_version, 'apparatus.json');
  check(existsSync(pinned), `${e.slug}/v/${e.current_version}/apparatus.json: exists`);
  if (existsSync(bare) && existsSync(pinned)) {
    check(readFileSync(bare).equals(readFileSync(pinned)),
      `${e.slug}: the bare file IS the current version’s (byte-identical)`);
  }
  const html = readFileSync(appPage(e.slug), 'utf8');
  check(html.includes(`data-src="/texts/${e.slug}/apparatus.json"`),
    `${e.slug}: the apparatus page fetches the edition’s own bare apparatus file`);
  const ph = appPage(e.slug, e.current_version);
  if (existsSync(ph)) {
    const phtml = readFileSync(ph, 'utf8');
    check(phtml.includes(`data-src="/texts/${e.slug}/v/${e.current_version}/apparatus.json"`),
      `${e.slug}/v/${e.current_version}/: the pinned apparatus page fetches the PINNED file, not the bare one`);
  }
  /* AND THE EDITION PAGE NO LONGER CARRIES A VIEWER AT ALL: the door to the
   * apparatus page is what stands there now. */
  const ed = readFileSync(join(DIST, 'texts', e.slug, 'index.html'), 'utf8');
  check(!/id="apparatus-viewer"/.test(ed), `${e.slug}: the edition page carries no viewer (it links the apparatus page)`);
  check(ed.includes(`href="/texts/${e.slug}/apparatus/"`), `${e.slug}: and links the apparatus page`);
}

/* ---------- §3 the page no longer inlines the log ---------- */

section('the edition page no longer carries the rule list');
/** The weight of the reader the edition page mounts — MEASURED from the compiled
 * bundle, not typed: every edition page inlines it, so it is part of what the
 * page is, and the size bound below has to allow for it. */
const readerBytes = statSync(join(ROOT, 'tools', 'app.js')).size;
for (const e of editions) {
  const html = readFileSync(join(DIST, 'texts', e.slug, 'index.html'), 'utf8');
  check(!/id="repair-/.test(html), `${e.slug}: 0 rendered rule rows in the page (the anchors are the viewer’s to make)`);
  check(!/class="apparatus-entry"/.test(html), `${e.slug}: 0 rendered apparatus entries`);
  check(!/data-type="(?:OCR|punctuation|transliteration|conjectural)"/.test(html),
    `${e.slug}: the page states no rule type (the type is in the data)`);
  const appBytes = statSync(join(DIST, 'texts', e.slug, 'apparatus.json')).size;
  console.log(`  NOTE ${e.slug}: page ${html.length} bytes, apparatus.json ${appBytes} bytes`);
  /* THE PAGE IS NOT THE LOG. The markers above prove the rule list is not
   * inlined; this bounds the page's weight, and the bound is not the data alone:
   * every edition page is a PAGE, and it carries the reader (MEASURED: the
   * compiled reader is `tools/app.js`, inlined on both the edition page and the
   * apparatus page). MEASURED before this bound was stated: Taylor's Theology
   * of Plato's apparatus.json is small (106,751 bytes, mostly the 722-leaf index)
   * while its page is 334,600 — a page serving a book and mounting the reader,
   * not a page carrying a log. An inlined log would add the version's whole rule
   * set on top of that. */
  check(html.length < appBytes * 3 + readerBytes,
    `${e.slug}: the page is HTML, not the log (${html.length} vs ${appBytes} bytes of data + ${readerBytes} bytes of reader)`);
}

section('the apparatus page carries the viewer, server-rendered');
for (const e of editions) {
  const html = readFileSync(appPage(e.slug), 'utf8');
  const appBytes = statSync(join(DIST, 'texts', e.slug, 'apparatus.json')).size;
  check(/<noscript>/.test(html) && html.includes(`href="/texts/${e.slug}/apparatus.json"`),
    `${e.slug}: the apparatus page states the whole log and links the data file without scripts`);
  check(html.includes('id="apparatus-viewer"') && html.includes('id="app-leaves"') && html.includes('id="app-panel"'),
    `${e.slug}: the viewer’s containers are server-rendered`);
  /* THE PAGE'S OWN STATEMENT NAMES THE WHOLE SCAN (server-rendered, so a reader
   * without scripts gets it too), and it counts the leaves from the directory. */
  check(html.includes('THE WHOLE SCAN IS HERE') && html.includes(`all ${seen.get(e.slug).data.leafCount} leaves`),
    `${e.slug}: the apparatus page states the whole scan and its ${seen.get(e.slug).data.leafCount} leaves without scripts`);
  check(!/\bleafes\b|\bleafves\b|\bleafss\b/.test(html.replace(/class="[^"]*"/g, '')),
    `${e.slug}: and pluralises "leaf" as "leaves"`);
  console.log(`  NOTE ${e.slug}: apparatus page ${html.length} bytes, apparatus.json ${appBytes} bytes`);
}
/* THE SIZE DROP, measured against the tree this unit replaced: the page inlined
 * the whole log, so the log's bytes were ON the page. */
{
  const row = (slug) => {
    const html = statSync(join(DIST, 'texts', slug, 'index.html')).size;
    const app = statSync(join(DIST, 'texts', slug, 'apparatus.json')).size;
    const errata = statSync(join(DIST, 'texts', slug, 't')).size;
    return { html, app, errata, pct: (100 - (100 * html) / (html + app)).toFixed(0) };
  };
  for (const e of editions) {
    const r = row(e.slug);
    console.log(`  NOTE ${e.slug}: page ${r.html} bytes; the same log as data ${r.app} bytes ` +
      `(the page is ${r.pct}% smaller than page+log inlined)`);
  }
}

/* ---------- §4 the viewer, booted as a browser boots it ---------- */

section('the viewer boots, renders a leaf, its readings, the filter and the fragment');
const Window = happyDom();

/** Every fetch the page makes, served from the built tree (a URL the tree does
 * not hold rejects, the way a 404 would). */
function fetchFromDist(url) {
  const rel = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '').split(/[?#]/)[0];
  const f = rel === '' ? join(DIST, 'index.html') : join(DIST, rel);
  if (!existsSync(f)) return Promise.reject(new Error(`no file at ${rel}`));
  const text = readFileSync(f, 'utf8');
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });
}

function installGlobals(w, fetchImpl) {
  const names = [
    'window', 'document', 'navigator', 'location', 'history', 'customElements', 'performance',
    'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage',
    'getComputedStyle', 'matchMedia', 'IntersectionObserver', 'HTMLElement', 'HTMLDivElement',
    'HTMLSpanElement', 'HTMLAnchorElement', 'HTMLButtonElement', 'HTMLInputElement',
    'HTMLParagraphElement', 'HTMLLabelElement', 'HTMLLIElement', 'HTMLImageElement', 'HTMLUListElement',
    'Element', 'Node', 'Document', 'DocumentFragment', 'Text', 'Comment', 'NodeList', 'HTMLCollection',
    'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'UIEvent', 'EventTarget', 'MutationObserver',
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
  globalThis.fetch = fetchImpl;
  globalThis.setTimeout = w.setTimeout.bind(w);
  globalThis.clearTimeout = w.clearTimeout.bind(w);
}

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await sleep(12);
};

/** Boot the BUILT page the way a browser does: parse it, run its scripts in
 * document order (skipping the JSON blocks). The viewer lives on the apparatus
 * page now, so that is the page booted by default. */
async function boot(slug, { hash = '', fetchImpl = null, page = null, url = null } = {}) {
  const html = readFileSync(page || appPage(slug), 'utf8');
  const headInner = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'));
  const bodyInner = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  const w = new Window({ url: `http://localhost${url || `/texts/${slug}/apparatus/`}${hash}` });
  installGlobals(w, fetchImpl || fetchFromDist);
  const scrolled = [];
  w.HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this.id || this.className);
  };
  w.document.head.innerHTML = headInner;
  w.document.body.innerHTML = bodyInner;
  const scripts = [...w.document.querySelectorAll('script')].filter((s) => {
    const t = s.getAttribute('type');
    return !t || /javascript|module/i.test(t);
  });
  try {
    delete globalThis.Elm;
  } catch {
    globalThis.Elm = undefined;
  }
  for (const s of scripts) (0, eval)(s.textContent);
  await settle();
  return { w, scrolled, text: (sel) => (w.document.querySelector(sel) || { textContent: '' }).textContent };
}

const VIEWER_EDITIONS = editions.map((e) => e.slug).filter((s) => seen.has(s));
const allBtnOf = (ctx) => ctx.w.document.getElementById('leaf-all');
const noneBtnOf = (ctx) => ctx.w.document.getElementById('leaf-none');
for (const SLUG of VIEWER_EDITIONS) {
  section(`the viewer, booted — ${SLUG}`);
  const { data } = seen.get(SLUG);
  /* A VERSION WITH NO RECORDED RULES is a state, not a smaller edition: it has
   * no readings to page, filter or search, and the viewer says so. The reading-by-
   * reading half of this section is exercised on the editions that have them; the
   * zero-rule edition gets its own assertions (below, and §4g). */
  const hasRules = data.rules.length > 0;
  /** The key the VIEWER builds for a leaf: the stored name without its extension
   * (the served url's basename). An edition cut from two items has two leaves
   * numbered 74, and this is what tells them apart. */
  const keyOfLeaf = (l) => String(l.url).split('/').pop().replace(/\.jpg$/i, '');
  const unheldLeaves = [...new Set(data.rules.flatMap((r) => r.evidence.filter((e) => !e.exists).map((e) => e.leaf)))];
  const none = data.rules.filter((r) => !r.evidence.length);
  const wantEntries = data.leaves.length + unheldLeaves.length + 2;

  /* THE LEAVES' OWN COUNTS, recomputed from the record (never read off the
   * viewer): which leaf has readings, and which has none. */
  const leafReadings = new Map(data.leaves.map((l) => [l.n, 0]));
  for (const r of data.rules) {
    for (const e of r.evidence) {
      if (e.exists && leafReadings.has(e.leaf)) leafReadings.set(e.leaf, leafReadings.get(e.leaf) + 1);
    }
  }
  const firstWithReadings = data.leaves.find((l) => leafReadings.get(l.n) > 0) || null;
  const emptyLeaf = data.leaves.find((l) => !leafReadings.get(l.n)) || null;
  /* THE VIEWER'S OWN LANDING RULE, recomputed: the first leaf that HAS readings;
   * failing that the readings that carry no page image; failing that the whole
   * log. MEASURED on the zero-rule edition: with no readings at all the landing
   * is the whole log — the old expectation said `leaf-none`, which holds only
   * when some readings rest on no leaf. */
  const wantLanding = firstWithReadings
    ? `leaf-${keyOfLeaf(firstWithReadings)}`
    : none.length
      ? 'leaf-none'
      : 'leaf-all';

  const ctx = await boot(SLUG);
  check(!!ctx.w.Apparatus && typeof ctx.w.Apparatus.boot === 'function', 'the viewer published itself as window.Apparatus');
  check(ctx.w.document.getElementById('apparatus-viewer').getAttribute('data-booted') === '1', 'and it booted');
  check(ctx.w.document.getElementById('app-fallback') === null,
    'the server-rendered statement is taken away once the viewer is up (nothing is said twice)');
  const leaves = ctx.w.document.getElementById('app-leaves');
  check(leaves.children.length === wantEntries,
    `the index has ${wantEntries} entries: the all-readings and no-image axes + ${data.leaves.length} stored leaves + ${unheldLeaves.length} cited-but-not-held (got ${leaves.children.length})`);
  const imgs = [...leaves.querySelectorAll('img.app-leaf-img')];
  check(imgs.length === data.leaves.length, `every stored leaf carries a thumbnail (${imgs.length})`);
  check(imgs.every((i) => i.getAttribute('loading') === 'lazy'), 'and every thumbnail is lazy — no leaf is fetched until it is scrolled to');
  check(imgs.every((i) => existsSync(join(DIST, i.getAttribute('src').replace(/^\//, '')))),
    'and every thumbnail src is a file the site ships');
  check(!ctx.w.document.getElementById('app-leaves').innerHTML.includes('<details'),
    'no leaf is hidden behind a collapsed disclosure');
  check(
    hasRules
      ? ctx.text('#app-controls').includes('Filter by type') && ctx.text('#app-controls').includes('Search the readings')
      : !/Filter by type|Search the readings/.test(ctx.text('#app-controls')) &&
          ctx.text('#app-controls').includes('Go to leaf'),
    hasRules
      ? 'the controls are rendered: a filter by type and a search'
      : 'a version with NO rules renders no filter and no search — only the leaf jump, which is what it has',
  );
  check(ctx.w.document.querySelector('#apparatus-viewer p.app-data a') &&
    ctx.w.document.querySelector('#apparatus-viewer p.app-data a').getAttribute('href') === `/texts/${SLUG}/apparatus.json`,
    'and the data file stays reachable (the address is restated under the viewer)');

  /* ---------- §4g A VERSION WITH NO RECORDED RULES ----------
   * The edition is published IN REPAIR, before its first emendation: the log is
   * empty and the SCAN is not. What the viewer must do — measured here on the
   * built page — is say that plainly, keep every leaf of the scan openable, and
   * land somewhere that is not a blank panel. The reading half of this section
   * (§4a-§4f) is about a version that HAS readings and is exercised on the two
   * that do; this branch is what the third one is. */
  if (!hasRules) {
    const keyed = data.leaves.map((l) => ({ key: keyOfLeaf(l), l }));
    const ids = [...leaves.querySelectorAll('button')].map((b) => b.id);
    check(new Set(ids).size === ids.length,
      `every index card has its own id (${ids.length - new Set(ids).size} duplicate(s))`);
    /* TWO VOLUMES, TWO LEAVES NUMBERED 74: both cards are in the index, each with
     * its own id and its own page image — the collision this unit fixed. */
    const dup = [...new Set(keyed.map(({ l }) => l.n))]
      .map((n) => keyed.filter(({ l }) => l.n === n))
      .filter((g) => g.length > 1);
    if (dup.length) {
      const g = dup[0];
      check(
        g.every(({ key }) => !!ctx.w.document.getElementById(`leaf-${key}`)),
        `${g.length} leaves are stored under the number n${g[0].l.n} (${g.map(({ key }) => key).join(', ')}) — each is its own card`,
      );
      for (const { key, l } of g) {
        const b = ctx.w.document.getElementById(`leaf-${key}`);
        const img = b && b.querySelector('img.app-leaf-img');
        check(!!img && img.getAttribute('src') === l.url,
          `and the card ${key} carries ITS OWN page image (${img ? img.getAttribute('src') : 'none'})`);
      }
    }
    const sel = ctx.w.document.querySelector('#app-leaves .app-leaf.selected');
    check(!!sel && sel.id === 'leaf-all',
      `with no reading recorded anywhere, the viewer lands on the whole log (${sel ? sel.id : 'none'}), not on an empty leaf`);
    check(/NO recorded repairs yet/.test(ctx.text('#app-panel')),
      'and the panel says the version carries no recorded repairs yet');
    check(!/carries no recorded reading/.test(ctx.text('#app-panel')),
      'not the leaf-empty wording — this is the version, not a leaf');
    check(ctx.w.document.querySelector('#app-panel img.app-panel-img') === null,
      'and it claims no page image for the whole-log entry (there is no single leaf to show)');
    const zero = (b) => (b ? b.querySelector('.app-leaf-n').textContent : '');
    check(zero(allBtnOf(ctx)) === 'no readings' && zero(noneBtnOf(ctx)) === 'no readings',
      `the two reading axes read "no readings" (${zero(allBtnOf(ctx))} / ${zero(noneBtnOf(ctx))})`);
    /* A LEAF WITH NO READING STILL OPENS ON ITS PAGE — and on ITS OWN page. */
    for (const { key, l } of keyed.slice(0, 1).concat(dup.length ? dup[0] : [])) {
      const lctx = await boot(SLUG, { hash: `#leaf-${key}` });
      const b = lctx.w.document.getElementById(`leaf-${key}`);
      check(!!b && b.className.includes('selected'), `#leaf-${key} opens`);
      check(b.className.includes('app-leaf-quiet') && b.querySelector('.app-leaf-n').textContent === 'no readings',
        `and it is set apart as a leaf no reading was decided from (${key})`);
      const img = lctx.w.document.querySelector('#app-panel img.app-panel-img');
      check(!!img && img.getAttribute('src') === l.url,
        `and its own page image is shown (${img ? img.getAttribute('src') : 'none'})`);
      check(lctx.text('#app-panel .app-caption').startsWith(`archive leaf ${key}`),
        `captioned by its stored name (${JSON.stringify(lctx.text('#app-panel .app-caption'))})`);
      /* The version-level statement wins over the leaf-level one when the whole
       * log is empty: "no reading was decided from THIS leaf" would imply other
       * leaves have readings, and none has. */
      check(/NO recorded repairs yet/.test(lctx.text('#app-panel')),
        'and it says plainly that the version records no repairs yet');
    }
    /* THE JUMP SAYS WHICH LEAF IT MEANS when a number names two volumes. */
    if (dup.length) {
      const g = dup[0];
      const jctx = await boot(SLUG);
      const jinput = jctx.w.document.getElementById('app-leaf-jump');
      const jgo = jctx.w.document.querySelector('.app-jump-go');
      check(!!jinput && !!jgo, 'the leaf jump is rendered');
      jinput.value = String(g[0].l.n);
      jgo.dispatchEvent(new jctx.w.MouseEvent('click', { bubbles: true, cancelable: true }));
      await settle();
      check(/stored 2 times/.test(jctx.text('#app-status')) &&
        g.every(({ key }) => jctx.text('#app-status').includes(key)),
        `a number that names two volumes is STATED, with both names (${JSON.stringify(jctx.text('#app-status').slice(0, 90))})`);
      jinput.value = g[0].key;
      jgo.dispatchEvent(new jctx.w.MouseEvent('click', { bubbles: true, cancelable: true }));
      await settle();
      check(jctx.w.document.getElementById(`leaf-${g[0].key}`).className.includes('selected'),
        `and the stored name opens the one it names (${g[0].key})`);
    }
    check(/app-leaf-jump/.test(readFileSync(join(ROOT, 'tools', 'apparatus', 'viewer.js'), 'utf8')),
      'and the control the viewer builds is the leaf jump (it is rendered by the viewer, not server-side)');
    continue;
  }

  /* ---------- §4a THE LANDING IS NEVER EMPTY ---------- */
  const selected = ctx.w.document.querySelector('#app-leaves .app-leaf.selected');
  check(!!selected, `an entry is selected on arrival (${selected ? selected.id : 'none'})`);
  check(!!selected && selected.id === wantLanding,
    `and it is the FIRST leaf that HAS readings (${wantLanding}), not the first stored leaf`);
  if (data.leaves.length && !leafReadings.get(data.leaves[0].n)) {
    check(!!selected && selected.id !== `leaf-n${data.leaves[0].n}`,
      `the first stored leaf (n${data.leaves[0].n}) carries none, so it is not what the reader lands on`);
  }
  const landingRows = [...ctx.w.document.querySelectorAll('#app-panel .apparatus-entry')];
  check(landingRows.length > 0, `the panel has ${landingRows.length} reading(s) on load — the landing is never an empty panel`);
  check(!/No reading recorded for this entry/.test(ctx.text('#app-panel')),
    'and it does not tell the reader the filter matches nothing');
  check(ctx.w.document.querySelector('#app-panel img.app-panel-img') !== null,
    'and the panel shows the selected leaf at a readable size');
  if (firstWithReadings) {
    const wantRows = data.rules.filter((r) => r.evidence.some((e) => e.exists && e.leaf === firstWithReadings.n)).map((r) => `repair-${r.id}`);
    if (wantRows.length <= 25) {
      check(landingRows.map((li) => li.id).join() === wantRows.join(),
        `and exactly the ${wantRows.length} readings decided from n${firstWithReadings.n}`);
    }
  }

  /* ---------- §4b THE TWO AXES: a leaf no reading was taken from, and the two
   * reading entries ---------- */
  if (emptyLeaf) {
    const b = ctx.w.document.getElementById(`leaf-n${emptyLeaf.n}`);
    check(!!b && b.className.includes('app-leaf-quiet'), `a leaf no reading was decided from is set apart (n${emptyLeaf.n})`);
    check(!!b && b.querySelector('.app-leaf-n').textContent === 'no readings', 'and it says so rather than reading 0');
    const lit = firstWithReadings ? ctx.w.document.getElementById(`leaf-n${firstWithReadings.n}`) : null;
    check(!!lit && !lit.className.includes('app-leaf-quiet'), 'while a leaf that HAS readings is not marked empty');
  }
  const allBtn = ctx.w.document.getElementById('leaf-all');
  const noneBtn = ctx.w.document.getElementById('leaf-none');
  check(!!allBtn && !!noneBtn, 'the two reading axes are in the index (leaf-all, leaf-none)');
  check(!!allBtn && allBtn.querySelector('.app-leaf-n').textContent === `${data.rules.length} readings`,
    `the all-readings entry carries the version's count (${allBtn ? allBtn.querySelector('.app-leaf-n').textContent : ''})`);
  check(!!noneBtn && noneBtn.querySelector('.app-leaf-n').textContent === `${none.length} readings`,
    `and the no-image entry carries the ${none.length} readings decided without a page image`);
  check(!!allBtn && /All readings/.test(allBtn.textContent) && /Without a page image/.test(noneBtn.textContent),
    'named for what they are, not for a leaf');

  /* ---------- §4b2 THE WHOLE SCAN IS ONE RUN, IN LEAF ORDER ---------- */
  /* MEASURED, and what this unit changed: the index is EVERY stored leaf — 141
   * for proclus, 72 for porphyry — not only the leaves a reading used. The
   * leaves a reading WAS decided from are marked, and the rest are neither moved
   * out of the run nor hidden behind anything. */
  const evidenceLeaves = data.leaves.filter((l) => l.readings > 0);
  const quietLeaves = data.leaves.filter((l) => !l.readings);
  check(evidenceLeaves.length > 0, `${evidenceLeaves.length} of the ${data.leaves.length} stored leaves carry a reading`);
  check(quietLeaves.length > 0, `and ${quietLeaves.length} carry none (the common case: the whole scan is stored)`);
  const idxN = [...leaves.querySelectorAll('button')]
    .filter((b) => /^leaf-n\d+$/.test(b.id))
    .map((b) => Number(b.id.slice('leaf-n'.length)));
  check(idxN.join() === data.leaves.map((l) => l.n).join(),
    `the index lists all ${data.leaves.length} stored leaves in leaf order, adjacent (evidence and non-evidence interleaved, nothing separated)`);
  check(
    evidenceLeaves.every((l) => {
      const b = ctx.w.document.getElementById(`leaf-n${l.n}`);
      return b && b.className.includes('app-leaf-evidence') && !!b.querySelector('.app-leaf-badge');
    }),
    'every leaf a reading was decided from is MARKED (app-leaf-evidence + a badge)',
  );
  check(
    quietLeaves.every((l) => {
      const b = ctx.w.document.getElementById(`leaf-n${l.n}`);
      return b && !b.className.includes('app-leaf-evidence') && !b.querySelector('.app-leaf-badge');
    }),
    'and a leaf no reading was decided from carries no evidence mark',
  );
  check(
    !!ctx.w.document.getElementById(`leaf-n${data.leaves[0].n}`) &&
      !!ctx.w.document.getElementById(`leaf-n${data.leaves[data.leaves.length - 1].n}`),
    `the first (n${data.leaves[0].n}) and last (n${data.leaves[data.leaves.length - 1].n}) leaf of the scan are both in the index`,
  );

  /* ---------- §4b3 A LEAF WITH NO READING STILL SHOWS ITS PAGE ----------
   * The point of storing the whole scan: the page image is readable whether or
   * not a rule used it, and the panel says which of the two it is instead of
   * looking empty. */
  {
    const q = quietLeaves[0];
    const qctx = await boot(SLUG, { hash: `#leaf-n${q.n}` });
    check(qctx.w.document.getElementById(`leaf-n${q.n}`).className.includes('selected'),
      `#leaf-n${q.n} — a leaf no reading used — opens`);
    check(qctx.w.document.querySelector('#app-panel img.app-panel-img') !== null,
      `and its PAGE IMAGE is shown (at the panel's width), not an empty panel`);
    check(qctx.text('#app-panel .app-caption').startsWith(`archive leaf n${q.n}`),
      `with its caption (${JSON.stringify(qctx.text('#app-panel .app-caption'))})`);
    check(/carries no recorded reading/.test(qctx.text('#app-panel')),
      'and it says plainly that the leaf carries no recorded reading');
    check(!/matches the current filter/.test(qctx.text('#app-panel')),
      'not the filter-empty message — that one is about the filter, this one about the leaf');
    check(qctx.text('#app-panel .app-count') === 'no reading recorded here',
      `and the count states it rather than 0 of N (${JSON.stringify(qctx.text('#app-panel .app-count'))})`);
  }

  /* ---------- §4b4 PAGING THROUGH THE SCAN ---------- */
  {
    const seq = data.leaves;
    const at = Math.floor(seq.length / 2);
    const mid = seq[at];
    const mctx = await boot(SLUG, { hash: `#leaf-n${mid.n}` });
    const nav = mctx.w.document.getElementById('app-leafnav');
    check(!!nav, 'the panel carries a leaf pager');
    const back = nav && nav.querySelector('.app-leaf-prev');
    const fwd = nav && nav.querySelector('.app-leaf-next');
    check(!!back && !back.disabled && back.textContent === `Previous leaf · n${seq[at - 1].n}`,
      `Previous names the leaf BEFORE it in the scan (${back ? JSON.stringify(back.textContent) : ''})`);
    check(!!fwd && !fwd.disabled && fwd.textContent === `Next leaf · n${seq[at + 1].n}`,
      `and Next the leaf AFTER (${fwd ? JSON.stringify(fwd.textContent) : ''})`);
    const where = nav && nav.querySelector('.app-leafnav-at');
    check(!!where && where.textContent === `leaf ${at + 1} of ${seq.length}`,
      `and it says where the reader is (${where ? JSON.stringify(where.textContent) : ''})`);
    /* the step is the NEXT STORED LEAF — the next entry of the index, recorded
     * evidence or not — which is the point: the scan is paged as a scan. */
    fwd.dispatchEvent(new mctx.w.MouseEvent('click', { bubbles: true, cancelable: true }));
    check(mctx.w.location.hash === `#leaf-n${seq[at + 1].n}`,
      `Next turns to n${seq[at + 1].n}, the next leaf of the run (${mctx.w.location.hash})`);
    mctx.w.dispatchEvent(new mctx.w.Event('hashchange'));
    await settle();
    check(mctx.w.document.getElementById(`leaf-n${seq[at + 1].n}`).className.includes('selected'),
      'and the hash change opens it');
    check(mctx.w.document.querySelector('#app-panel img.app-panel-img').getAttribute('src') === seq[at + 1].url,
      'showing that leaf’s own page image');
    /* the ends of the run are STATED by a disabled control, not by silence */
    const fctx = await boot(SLUG, { hash: `#leaf-n${seq[0].n}` });
    check(fctx.w.document.querySelector('.app-leaf-prev').disabled,
      `on the scan's first leaf (n${seq[0].n}) Previous is disabled`);
    const lctx = await boot(SLUG, { hash: `#leaf-n${seq[seq.length - 1].n}` });
    check(lctx.w.document.querySelector('.app-leaf-next').disabled,
      `on its last (n${seq[seq.length - 1].n}) Next is disabled`);
  }

  /* ---------- §4c THE ALL-READINGS VIEW, PAGED ---------- */
  const all = await boot(SLUG, { hash: '#leaf-all' });
  const allRows = [...all.w.document.querySelectorAll('#app-panel .app-compact-row')];
  check(allRows.length === Math.min(25, data.rules.length),
    `the all-readings view renders 25 at a time (${allRows.length} of ${data.rules.length})`);
  check(allRows.map((li) => li.id).join() === data.rules.slice(0, 25).map((r) => `repair-${r.id}`).join(),
    'and its first page is the record’s first 25 rules, in order');
  const pager = all.w.document.getElementById('app-pager');
  const range = pager ? pager.querySelector('.app-range').textContent : '';
  check(!!pager && range.includes(`of ${data.rules.length}`) && /page 1 of \d+/.test(range),
    `with the range and the total stated (${JSON.stringify(range)})`);
  const next = pager ? pager.querySelector('.app-page-next') : null;
  if (next) {
    next.dispatchEvent(new all.w.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();
    const after = [...all.w.document.querySelectorAll('#app-panel .app-compact-row')];
    check(after.map((li) => li.id).join() === data.rules.slice(25, 50).map((r) => `repair-${r.id}`).join(),
      'and Next turns to the next 25, in order');
    const r2 = all.w.document.querySelector('#app-pager .app-range').textContent;
    check(/page 2 of \d+/.test(r2), `and the stated page moves with it (${JSON.stringify(r2)})`);
  }
  /* the filter and the search reach the WHOLE LOG, not only the no-image group */
  const abox = [...all.w.document.querySelectorAll('input[data-ap-type]')];
  const adrop = abox[0];
  const atype = adrop.getAttribute('data-ap-type');
  adrop.checked = false;
  adrop.dispatchEvent(new all.w.Event('change'));
  await settle();
  const leftAll = [...all.w.document.querySelectorAll('#app-panel .app-compact-row')];
  const wantAll = data.rules.filter((r) => r.type !== atype);
  check(leftAll.map((li) => li.id).join() === wantAll.slice(0, 25).map((r) => `repair-${r.id}`).join(),
    `unticking ${atype} in the all-readings view drops exactly its readings (${data.rules.length} → ${wantAll.length}, paged)`);
  check(all.text('#app-panel .app-count').includes(String(wantAll.length)),
    `and the panel states the filtered count (${JSON.stringify(all.text('#app-panel .app-count'))})`);
  const aword = (wantAll.find((r) => r.after.split(/\s+/).some((x) => x.length > 5)) || { after: '' })
    .after.split(/\s+/)
    .find((x) => x.length > 5);
  if (aword) {
    const ain = all.w.document.getElementById('app-q');
    ain.value = aword;
    ain.dispatchEvent(new all.w.Event('input'));
    await settle();
    const aHits = [...all.w.document.querySelectorAll('#app-panel .app-compact-row')];
    const aWant = wantAll.filter((r) => (r.find + '\n' + r.after + '\n' + r.rationale).toLowerCase().includes(aword.toLowerCase()));
    check(aHits.map((li) => li.id).join() === aWant.slice(0, 25).map((r) => `repair-${r.id}`).join(),
      `searching “${aword}” over find/after/rationale returns exactly the ${aWant.length} readings that hold it (${aHits.length} on the first page)`);
    check(aWant.length > 0 && aWant.length < wantAll.length, 'and it narrows the list rather than emptying it');
  }

  /* ---------- §4d A DEEP LINK OPENS THE RIGHT ENTRY, ON THE RIGHT PAGE ---------- */
  const withLeaf = data.rules.filter((r) => r.evidence.some((e) => e.exists));
  const target = withLeaf[Math.floor(withLeaf.length / 2)];
  const targetLeaf = target.evidence.find((e) => e.exists).leaf;
  const deep = await boot(SLUG, { hash: `#repair-${target.id}` });
  check(deep.w.document.getElementById(`leaf-n${targetLeaf}`).className.includes('selected'),
    `#repair-${target.id} opens the entry of the leaf it was decided from (n${targetLeaf})`);
  const ruled = deep.w.document.getElementById(`repair-${target.id}`);
  check(!!ruled, `and the reading is rendered (#repair-${target.id})`);
  check(!!ruled && ruled.className.includes('target'), 'and it is marked as the linked one');
  check(deep.scrolled.includes(`repair-${target.id}`), 'and it was scrolled to');
  const ids = [...deep.w.document.querySelectorAll('#app-panel li.apparatus-entry')].map((li) => li.id);
  const wantIds = data.rules.filter((r) => r.evidence.some((e) => e.exists && e.leaf === targetLeaf)).map((r) => `repair-${r.id}`);
  if (wantIds.length <= 25) {
    check(JSON.stringify(ids) === JSON.stringify(wantIds),
      `the panel holds exactly the ${wantIds.length} readings decided from n${targetLeaf}`);
  }
  const rows = [...deep.w.document.querySelectorAll('#app-panel li.apparatus-entry')];
  const row = rows[0];
  check(!!row && /^r\d{4}$/.test(row.querySelector('.rp-id').textContent) &&
    TYPES.includes(row.querySelector('.rp-type').textContent) &&
    !!row.querySelector('.rp-apply') && !!row.querySelector('.rp-change .before') && !!row.querySelector('.rp-change .after') &&
    !!row.querySelector('.rp-rationale') && !!row.querySelector('.rp-witness'),
    'a reading carries its id, type, pipeline class, before → after, rationale and witness');
  check(deep.text('#app-panel .app-caption').startsWith(`archive leaf n${targetLeaf}`),
    `the panel captions the leaf (${JSON.stringify(deep.text('#app-panel .app-caption'))})`);

  /* THE ENTRY A DEEP LINK OPENS is the entry the reading BELONGS to — its first
   * held leaf, else the leaf it cites without holding it, else the no-image
   * group. Recomputed here from the data, and exercised on all three kinds. */
  const keyOf = (r) => {
    const heldFirst = r.evidence.find((e) => e.exists);
    if (heldFirst) return `leaf-n${heldFirst.leaf}`;
    if (r.evidence.length) return `leaf-u${r.evidence[0].leaf}`;
    return 'leaf-none';
  };
  const samples = [
    withLeaf[0], // decided from a leaf the edition holds
    none[0], // decided with no page image at all
    data.rules.find((r) => r.evidence.length && r.evidence.every((e) => !e.exists)), // cites a leaf it does not hold
  ].filter(Boolean);
  for (const r of samples) {
    const sctx = await boot(SLUG, { hash: `#repair-${r.id}` });
    const el = sctx.w.document.getElementById(keyOf(r));
    check(!!el && el.className.includes('selected'), `#repair-${r.id} opens ${keyOf(r)} — the entry that reading belongs to`);
    check(!!sctx.w.document.getElementById(`repair-${r.id}`), `and the reading is rendered there (#repair-${r.id})`);
  }
  /* A READING WITH NO PAGE IMAGE AT THE END OF A PAGED LIST: the viewer must turn
   * to the page it falls on, or the deep link would point at a page not shown. */
  const late = none[none.length - 1];
  if (late && none.length > 25) {
    const lctx = await boot(SLUG, { hash: `#repair-${late.id}` });
    const el = lctx.w.document.getElementById(`repair-${late.id}`);
    check(!!el && el.className.includes('target'),
      `#repair-${late.id} — the last reading with no page image — is rendered and marked, on the page it falls on`);
    check(lctx.w.document.getElementById('leaf-none').className.includes('selected'), 'inside the no-image group');
    const wantPage = Math.floor(none.findIndex((r) => r.id === late.id) / 25) + 1;
    const pr = lctx.w.document.querySelector('#app-pager .app-range');
    check(!!pr && pr.textContent.includes(`page ${wantPage} of`),
      `and the viewer turned to its page (${JSON.stringify(pr ? pr.textContent : '')})`);
  }

  /* a deep link to a leaf, and the click that sets one */
  const other = data.leaves.filter((l) => l.readings && l.n !== targetLeaf).pop();
  if (other) {
    const lctx = await boot(SLUG, { hash: `#leaf-n${other.n}` });
    check(lctx.w.document.getElementById(`leaf-n${other.n}`).className.includes('selected'),
      `#leaf-n${other.n} opens that leaf`);
    check(lctx.text('#app-panel .app-caption').startsWith(`archive leaf n${other.n}`), 'and its caption is the leaf’s');
    const btn = lctx.w.document.getElementById(`leaf-n${targetLeaf}`);
    btn.dispatchEvent(new lctx.w.MouseEvent('click', { bubbles: true, cancelable: true }));
    check(lctx.w.location.hash === `#leaf-n${targetLeaf}`, `clicking a leaf moves the fragment (${lctx.w.location.hash})`);
    lctx.w.dispatchEvent(new lctx.w.Event('hashchange'));
    await settle();
    check(lctx.w.document.getElementById(`leaf-n${targetLeaf}`).className.includes('selected'),
      'and the fragment change opens it');
  }

  /* ---------- §4f THE UNHELD BRANCH, ON A DOCTORED DATA FILE ----------
   * MEASURED 2026-10-05: the whole scan is stored, so no served citation is
   * unheld and this branch would never run. It is the model's honest other half
   * — a cited leaf the edition does not hold keeps its entry, url null — so it is
   * opened here from a DOCTORED data file: one reading's held leaf is changed to
   * a leaf the edition does not hold. */
  {
    const donor = data.rules.find((r) => r.evidence.some((e) => e.exists));
    const MISSING = 99999;
    const doctored = {
      ...data,
      rules: data.rules.map((r) =>
        r === donor
          ? {
              ...r,
              evidence: r.evidence.map((e) =>
                e.exists ? { leaf: MISSING, page: null, url: null, exists: false } : e,
              ),
            }
          : r,
      ),
    };
    const dctx = await boot(SLUG, {
      hash: `#leaf-u${MISSING}`,
      fetchImpl: (url) =>
        String(url).includes('apparatus.json')
          ? Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(doctored)) })
          : fetchFromDist(url),
    });
    const ubtn = dctx.w.document.getElementById(`leaf-u${MISSING}`);
    check(!!ubtn && ubtn.className.includes('selected'),
      `a cited leaf the edition does not hold (n${MISSING}) is an entry of the index and opens`);
    check(/not held/.test(dctx.text('#app-panel')), 'and the panel STATES that it is not held');
    check(dctx.w.document.querySelectorAll('#app-panel img').length === 0, 'while claiming no image for it');
    check(dctx.w.document.querySelectorAll('#app-panel li.apparatus-entry').length > 0, 'and its readings are listed');
    check(!!dctx.w.document.getElementById(`repair-${donor.id}`), `the reading itself is rendered (#repair-${donor.id})`);
  }
  const nctx = await boot(SLUG, { hash: '#leaf-none' });
  check(nctx.w.document.getElementById('leaf-none').className.includes('selected'), '#leaf-none opens the no-image group');
  const compact = [...nctx.w.document.querySelectorAll('#app-panel li.app-compact-row')];
  check(compact.length === Math.min(25, none.length),
    `and lists the ${none.length} readings decided with no page image, 25 at a time (${compact.length} on the first page)`);
  check(compact.every((li) => li.querySelector('a.rp-id') && li.querySelector('.app-compact-change')),
    'compactly: an id to jump to and the change itself');
  if (none.length > 25) {
    const nr = nctx.w.document.querySelector('#app-pager .app-range');
    check(!!nr && nr.textContent.includes(`of ${none.length}`) && /page 1 of \d+/.test(nr.textContent),
      `with the count stated (${JSON.stringify(nr ? nr.textContent : '')})`);
  }

  /* the filter, and the word search */
  const box = [...nctx.w.document.querySelectorAll('input[data-ap-type]')];
  check(box.length === Object.keys(data.counts).length, `one filter per type the version carries (${box.length})`);
  const drop = box[0];
  const droppedType = drop.getAttribute('data-ap-type');
  drop.checked = false;
  drop.dispatchEvent(new nctx.w.Event('change'));
  await settle();
  const left = [...nctx.w.document.querySelectorAll('#app-panel li.app-compact-row')];
  const leftWant = none.filter((r) => r.type !== droppedType);
  check(left.length === Math.min(25, leftWant.length),
    `unticking ${droppedType} drops exactly its readings (${none.length} → ${leftWant.length}, paged)`);
  check(left.every((li) => li.getAttribute('data-type') !== droppedType), 'and none of them is that type');

  const input = nctx.w.document.getElementById('app-q');
  const word = (leftWant.find((r) => r.after.split(/\s+/).find((x) => x.length > 5)) || { after: '' })
    .after.split(/\s+/)
    .find((x) => x.length > 5);
  if (word) {
    input.value = word;
    input.dispatchEvent(new nctx.w.Event('input'));
    await settle();
    const hits = [...nctx.w.document.querySelectorAll('#app-panel li.app-compact-row')];
    const want = leftWant.filter(
      (r) => (r.find + '\n' + r.after + '\n' + r.rationale).toLowerCase().includes(word.toLowerCase()),
    );
    check(hits.map((li) => li.id).join() === want.slice(0, 25).map((r) => `repair-${r.id}`).join(),
      `searching “${word}” over find/after/rationale returns exactly the ${want.length} readings that hold it (${hits.length} on the first page)`);
    check(want.length > 0 && want.length < none.length, 'and it narrows the list rather than emptying it');
  }
}

/* ---------- §4e THE LANDING WHEN NO LEAF CARRIES A READING ---------- */

section('with no leaf carrying a reading the viewer lands on the readings with no page image');
{
  const SLUG = VIEWER_EDITIONS[0];
  const { data } = seen.get(SLUG);
  /* A DOCTORED DATA FILE, fetched in place of the built one: every held-leaf
   * evidence entry removed, so no stored leaf has a reading. The landing rule has
   * to answer this — both real editions have leaves with readings. */
  const stripped = {
    ...data,
    rules: data.rules.map((r) => ({ ...r, evidence: r.evidence.filter((e) => !e.exists) })),
  };
  const ctx = await boot(SLUG, {
    fetchImpl: (url) =>
      String(url).includes('apparatus.json')
        ? Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(stripped)) })
        : fetchFromDist(url),
  });
  const sel = ctx.w.document.querySelector('#app-leaves .app-leaf.selected');
  check(!!sel && sel.id === 'leaf-none',
    `the first leaf with readings being none, the landing is the no-image group (${sel ? sel.id : 'none'})`);
  check(ctx.w.document.querySelectorAll('#app-panel li.app-compact-row').length > 0,
    'and the panel carries the readings themselves — not an empty state');
}

/* ---------- §5 a failed fetch leaves the statement, and says so ---------- */

section('the failure path states what happened and where the apparatus is');
{
  const SLUG = VIEWER_EDITIONS[0];
  const ctx = await boot(SLUG, { fetchImpl: () => Promise.reject(new Error('offline')) });
  check(ctx.w.document.getElementById('app-fallback') !== null,
    'the server-rendered statement stays when the data does not arrive (nothing is shown silently)');
  const status = ctx.text('#app-status');
  check(/could not load/i.test(status), `the status line says the viewer did not run (${JSON.stringify(status.slice(0, 70))})`);
  check(/plain file|served with this edition/i.test(status), 'and points at the apparatus the statement names');
  check(ctx.w.document.getElementById('app-fallback').textContent.includes(`/texts/${SLUG}/apparatus.json`),
    'the statement still names the data file');
  check(/<noscript>/.test(readFileSync(appPage(SLUG), 'utf8')),
    'and the apparatus page carries a <noscript> for a reader whose JavaScript is off');
}

/* ---------- §6 the apparatus is laid out AT THE READER'S WIDTH ----------
 *
 * MEASURED from the EMITTED stylesheet (the page's own inlined <style> blocks —
 * what a browser is actually served, not the source file): the width contract is
 * arithmetic over what the browser resolves. The reader's PANE is --reader less the
 * wrap's own padding less the reader's grid (17rem of contents + a 28px gutter);
 * the apparatus's PANEL is the same again with its own index. A rule that caps
 * apparatus content below the reader's pane is exactly what the author reported as
 * "narrower than the reader". A cap in rem resolves against the browser default
 * 16px — asserted below: neither :root nor html sets a font-size. */

/* the JPEG's own pixel size, read from the SERVED file (not from a manifest) */
function jpegSize(file) {
  const d = readFileSync(file);
  let i = 2;
  while (i < d.length - 9) {
    if (d[i] !== 0xff) { i++; continue; }
    const m = d[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: d.readUInt16BE(i + 5), w: d.readUInt16BE(i + 7) };
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + d.readUInt16BE(i + 2);
  }
  return null;
}

/* ---------- reading the EMITTED stylesheet ----------
 *
 * A depth-aware parse: a rule inside @media is recorded with its media context,
 * so a base rule and the narrow-screen override are never confused — and only the
 * BASE rules are read for layout, because the print stylesheet's uncapped `.prose`
 * says nothing about the screen the reader is looking at. */

function parseCss(css) {
  const rules = [];
  (function walk(text, media) {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open === -1) return;
      const sel = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (sel.startsWith('@')) walk(body, sel);
      else rules.push({ sel, body, media });
      i = j;
    }
  })(css, '');
  return rules;
}

const cssBody = (rules, sel, media = '') =>
  rules.filter((r) => r.sel === sel && r.media === media).map((r) => r.body).join(';');

const cssProp = (rules, sel, name, media = '') => {
  const m = cssBody(rules, sel, media).match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
};

/** one rule as a number of px: var(--x) resolved through :root, rem at 16px,
 * `none` as Infinity, and null for anything that is not a length */
function cssNum(rules, v) {
  if (v == null) return null;
  const s = v.trim();
  if (s === 'none') return Infinity;
  const vm = s.match(/^var\((--[\w-]+)\)$/);
  if (vm) return cssNum(rules, cssProp(rules, ':root', vm[1]));
  if (/^[\d.]+rem$/.test(s)) return parseFloat(s) * 16;
  if (/^[\d.]+px$/.test(s)) return parseFloat(s);
  return null;
}

/* A minimal CSS selector matcher — enough for the selectors this sheet actually
 * writes against a container: `#id`, `.class`, a tag, and descendant/child
 * combinators over them. Nothing here reads a property; it answers "does this
 * rule's selector select THIS element and this ancestor chain?" */
function selectorMatches(rules, sel, el) {
  const parts = sel.trim().split(/\s+(?![^\[]*\])/);
  let i = parts.length - 1;
  let node = el;
  const simple = (part, n) => {
    const tag = part.match(/^[a-zA-Z][\w-]*/);
    if (tag && n.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
    for (const m of part.matchAll(/\.([\w-]+)/g)) {
      if (!n.classList || !n.classList.contains(m[1])) return false;
    }
    const id = part.match(/#([\w-]+)/);
    if (id && n.id !== id[1]) return false;
    return true;
  };
  if (!node || !simple(parts[i], node)) return false;
  const child = i > 0 && parts[i - 1] === '>';
  if (child) {
    i -= 1;
    node = node.parentElement;
    if (!node || !simple(parts[i], node)) return false;
  }
  i -= 1;
  for (; i >= 0; i--) {
    node = node.parentElement;
    let found = false;
    while (node) {
      if (simple(parts[i], node)) { found = true; break; }
      node = node.parentElement;
    }
    if (!found) return false;
  }
  return true;
}

section('the apparatus takes the reader’s width, and no rule caps content short of it');
{
  const SLUG = VIEWER_EDITIONS[0];
  /* THE READER CONTRACT IS EMITTED ON THE EDITION PAGE (the reader's own
   * stylesheet goes with the reader), while the apparatus rules are emitted on
   * the apparatus page; both are the served stylesheets of the SAME edition, so
   * the rules are read from both pages together. */
  const styleBlocks = (h) => [...h.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const appBlocks = styleBlocks(readFileSync(appPage(SLUG), 'utf8'));
  const edBlocks = styleBlocks(readFileSync(join(DIST, 'texts', SLUG, 'index.html'), 'utf8'));
  const blocks = [...appBlocks, ...edBlocks];
  const css = blocks.join('\n');
  check(appBlocks.length >= 1 && edBlocks.length >= 2,
    `the stylesheets are IN the served pages (${appBlocks.length} block(s) on the apparatus page, ${edBlocks.length} on the edition page: the site's, then the reader's)`);

  const rules = parseCss(css);
  const bodyOf = (sel, media = '') => cssBody(rules, sel, media);
  const prop = (sel, name, media = '') => cssProp(rules, sel, name, media);
  const num = (v) => cssNum(rules, v);

  check(prop(':root', 'font-size') === null && prop('html', 'font-size') === null,
    'neither :root nor html sets a font-size, so rem resolves at the browser default 16px (the arithmetic below)');
  const READER = num(prop(':root', '--reader'));
  const MEASURE = num(prop(':root', '--measure'));
  const SPACE4 = num(prop(':root', '--space-4'));
  check(READER === 1240, `--reader = ${READER}px — the ONE width token the reader and the apparatus share`);
  check(MEASURE === 544, `--measure = ${MEASURE}px (34rem) — the measure the apparatus content used to be capped at`);

  const padPx = parseFloat((prop('.wrap', 'padding') || '').match(/[\d.]+px/g)?.pop() || 'NaN');
  check(padPx === 24, `.wrap's own padding is ${padPx}px each side (the reader's column and the apparatus's are measured inside it)`);

  const readerWrap = num(prop('.rd-section .wrap', 'max-width'));
  const readerCols = rules.filter((r) => r.sel === '.rd-cols' && /min-width:\s*62em/.test(r.media)).pop();
  const rdIdx = readerCols
    ? num((readerCols.body.match(/grid-template-columns:\s*([^\s;]+)/) || [])[1])
    : null;
  const rdGap = num((prop('.rd-cols', 'gap') || '').match(/^[\d.]+(?:px)?\s+([\d.]+px)$/)?.[1]);
  const rdMain = num(prop('.rd-main', 'max-width'));
  check(readerWrap === READER, `the reader's own section is --reader wide (${readerWrap}px)`);
  check(rdIdx === 272 && rdGap === 28, `and on a desktop it is a two-column grid (a ${rdIdx}px contents index + a ${rdGap}px gutter, the 62em rule being the one measured)`);
  check(rdMain === 704, `the reader's own prose is capped at ${rdMain}px (.rd-main, 44rem — the reader contract, unchanged here)`);

  const readerPane = READER - 2 * padPx - rdIdx - rdGap;
  const readerText = Math.min(readerPane, rdMain);
  check(readerPane === 892, `so the reader's text PANE is ${readerPane}px (${READER} − 2×${padPx} − ${rdIdx} − ${rdGap}), i.e. the ${readerText}px prose column sits in an ${readerPane}px pane`);

  /* THE APPARATUS, from the emitted rules */
  const appWrapRaw = prop('#the-apparatus .wrap', 'max-width');
  const appWrap = num(appWrapRaw);
  check(appWrapRaw === 'var(--reader)' && appWrap === READER,
    `#the-apparatus .wrap declares max-width: ${appWrapRaw} (${appWrap}px) — the SAME width token as the reader above it`);

  const idxRaw = (prop('.app-browser', 'grid-template-columns') || '').match(/minmax\(0,\s*([^)]+)\)/)?.[1];
  const appIdx = num(idxRaw);
  const appGap = SPACE4;
  const panel = READER - 2 * padPx - appIdx - appGap;
  check(idxRaw === '16rem' && appIdx === 256, `the leaf index is ${idxRaw} (${appIdx}px) wide`);
  check(/minmax\(0,\s*1fr\)/.test(prop('.app-browser', 'grid-template-columns') || ''),
    'and the panel takes everything else (minmax(0, 1fr), not a track of its own)');
  check(panel === 916 && panel >= readerPane,
    `so the readings' PANEL is ${panel}px (${READER} − 2×${padPx} − ${appIdx} − ${appGap}) — at least the reader's ${readerPane}px pane`);

  /* NO APPARATUS CONTENT RULE CAPS ITSELF SHORT OF THE READER'S PANE. A missing
   * max-width is the whole column; a present one has to be at least the pane. */
  const CONTENT = ['.app-fallback p', '.app-status', '.app-note',
    '.apparatus-entry', 'ul.app-compact', '.app-data'];
  for (const sel of CONTENT) {
    const raw = prop(sel, 'max-width');
    const cap = raw == null ? Infinity : num(raw);
    check(cap >= readerPane,
      `${sel}: ` + (raw == null ? `no max-width at all — the whole ${panel}px column`
        : raw === 'none' ? 'max-width: none — the whole column (the generic .hint cap it overrides is checked below)'
        : `${raw} = ${cap}px, at least the reader's ${readerPane}px pane`));
  }
  /* THE SUMMARY IS THE SECTION'S OWN .hint — and the rule the report NAMED
   * (.apparatus-summary) styled nothing: no markup ever carried that class. This is
   * the check that has to be EFFECTIVE, not merely declared: the summary's cap is
   * whatever the scoped rule says, and with no scoped rule it is the generic .hint
   * cap (--measure), which is exactly the state the author reported. */
  const hintCap = prop('#the-apparatus .hint', 'max-width') == null
    ? num(prop('.hint', 'max-width'))
    : num(prop('#the-apparatus .hint', 'max-width'));
  check(hintCap >= readerPane,
    `the summary the reader sees — .hint INSIDE the apparatus — is capped at ${hintCap === Infinity ? 'nothing (the whole column)' : `${hintCap}px`}, at least the reader's ${readerPane}px pane`);
  check(num(prop('.hint', 'max-width')) === MEASURE,
    `while .hint itself still caps every OTHER section at --measure (${MEASURE}px) — the override is scoped, not site-wide`);
  check(prop('.apparatus-entry', 'max-width') === null,
    'and the readings (.apparatus-entry) carry no max-width declaration at all');
  const summaryClass = VIEWER_EDITIONS.map((s) => readFileSync(appPage(s), 'utf8'))
    .filter((h) => /class="apparatus-summary"/.test(h)).length;
  check(!/\.apparatus-summary\s*\{/.test(css) && summaryClass === 0,
    'and .apparatus-summary is GONE: the rule carried no markup at all (0 elements in the built pages), so it styled nothing while reading as if it styled the summary');

  const imgW = prop('.app-panel-img', 'width');
  const imgMaxH = prop('.app-panel-img', 'max-height');
  check(imgW === '100%' && prop('.app-panel-img', 'max-width') === '100%',
    `the leaf in the panel fills its column (width: ${imgW} of the ${panel}px panel)`);
  check(imgMaxH === 'none' && !/[\d.]+\s*vh/.test(bodyOf('.app-panel-img')),
    `and is bounded by the COLUMN, not by a viewport height (max-height: ${imgMaxH}, no vh anywhere in the rule)`);

  const collapse = rules.find((r) => r.sel === '.app-browser' && /max-width:\s*56em/.test(r.media));
  check(!!collapse && /grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(collapse.body),
    'below 56em the browser collapses to ONE column, so the panel takes the viewport instead');

  /* THE LEAF ITSELF, measured from the SERVED jpeg: it fills the panel and is not
   * upscaled above its own pixels. */
  const scanDir = join(DIST, 'texts', SLUG, 'scans');
  const leafName = existsSync(scanDir)
    ? readdirSync(scanDir).filter((f) => /^n\d+\.jpg$/.test(f)).sort((a, b) => Number(a.slice(1, -4)) - Number(b.slice(1, -4)))[0]
    : null;
  const leaf = leafName ? { name: leafName, size: jpegSize(join(scanDir, leafName)) } : null;
  check(!!leaf && !!leaf.size, `a served leaf can be measured (${leaf ? `${SLUG}/scans/${leaf.name} ${leaf.size ? `${leaf.size.w}×${leaf.size.h}` : 'unreadable'}` : 'no scans'})`);
  if (leaf && leaf.size) {
    const w = Math.min(leaf.size.w, panel);
    check(leaf.size.w >= panel,
      `and it is wider than the panel (${leaf.size.w}px ≥ ${panel}px), so it FILLS it rather than sitting as a strip`);
    console.log(`  NOTE measured widths: --reader ${READER}px · reader pane ${readerPane}px (its prose column ${rdMain}px, inside .rd-main) · apparatus panel ${panel}px; before this change the summary/notes were 544px and the readings 736px`);
    console.log(`  NOTE the first stored leaf renders ${w}px wide and ${Math.round((w * leaf.size.h) / leaf.size.w)}px tall (the 82vh cap it used to carry would have held it to ≈430px wide on a 900px-tall viewport, ≈560px on a 1120px one)`);
  }
}

/* ---------- §7 the viewer’s CONTAINING BLOCK ----------
 *
 * §6 reads the RULES. A rule that declares no max-width is still capped when an
 * ANCESTOR carries one — and that was exactly this unit’s defect: the viewer was
 * emitted INSIDE `<div class="prose">`, and `.prose { max-width: var(--measure) }`
 * is 544px ON SCREEN (its `max-width: none` is inside `@media print` only), so the
 * grid, the leaf index and the panel were all held to a third of the column
 * whatever `#the-apparatus .wrap` said. A rule-by-rule reading cannot see that;
 * only the MARKUP’s own ancestor chain can. So this section walks the emitted
 * page’s chain from `#apparatus-viewer` up to the section, cascades each
 * element’s max-width and horizontal padding off the EMITTED stylesheet (by
 * specificity, the way a browser does), and asserts the chain imposes NOTHING
 * below the apparatus column.
 *
 * THE ASYMMETRY IS THE PROOF: the same walk runs over the pre-fix structure,
 * reconstructed in the DOM from that same emitted page (the viewer wrapped in a
 * `div.prose` again) — and there it must FAIL, at exactly --measure. The
 * arithmetic is viewport-independent: a real window narrower than --reader makes
 * everything proportionally narrower, and the chain still imposes nothing. */
section('the viewer’s containing block is the apparatus column — no ancestor caps it');
{
  const pageCss = (slug) =>
    parseCss(readFileSync(appPage(slug), 'utf8')
      .match(/<style[^>]*>([\s\S]*?)<\/style>/g)
      .map((s) => s.replace(/^<style[^>]*>/, '').replace(/<\/style>$/, ''))
      .join('\n'));
  const rules7 = pageCss(VIEWER_EDITIONS[0]);
  const n7 = (sel, name, media = '') => cssNum(rules7, cssProp(rules7, sel, name, media));
  const READER = n7(':root', '--reader');
  const MEASURE = n7(':root', '--measure');
  /* .wrap's own padding, off the emitted shorthand (`padding: 0 24px`); §6 checks it is 24. */
  const padToks = (cssProp(rules7, '.wrap', 'padding') || '').trim().split(/\s+/).map(parseFloat);
  const padPx = padToks.length === 1 ? padToks[0] : padToks[1];   // 1 value → all sides, else the 2nd is horizontal
  const idx = 256;                                     // the leaf index track — checked in §6
  const gap = n7(':root', '--space-4');
  const wrapContent = READER - 2 * padPx;              // 1192px
  const panel = wrapContent - idx - gap;               // 916px
  const px = (v) => (typeof v === 'number' ? `${v}px` : String(v));
  const descOf = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}` +
    (el.className ? String(el.className).split(/\s+/).filter(Boolean).map((c) => `.${c}`).join('') : '');

  /* THE PRINT SHEET IS NOT WHAT THE SCREEN IS MEASURED AGAINST: the same `.prose`
   * is uncapped on paper and capped at --measure on screen. */
  check(cssProp(rules7, '.prose', 'max-width') === 'var(--measure)' && n7('.prose', 'max-width') === MEASURE,
    `.prose caps at ${MEASURE}px ON SCREEN (the emitted base rule — this is the cap that held the viewer)`);
  check(/max-width:\s*none/.test(cssBody(rules7, '.prose, .citation-block .cite', '@media print')),
    'and the same selector is uncapped only inside @media print, so the print correction was never the screen’s layout');

  /* one rule’s weight, the browser’s way: ids, then classes/attributes, then tags */
  function specificity(g) {
    const ids = (g.match(/#[\w-]+/g) || []).length;
    const cl = (g.match(/\.[\w-]+/g) || []).length + (g.match(/\[[^\]]*\]/g) || []).length;
    const tg = (g.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
    return ids * 10000 + cl * 100 + tg;
  }
  function matchesGroup(g, el) {
    const parts = g.trim().split(/\s*(>)\s*|\s+/).filter(Boolean);
    let i = parts.length - 1;
    let node = el;
    const simple = (part, n) => {
      const tag = part.match(/^[a-zA-Z][\w-]*/);
      if (tag && n.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
      for (const m of part.matchAll(/\.([\w-]+)/g)) if (!n.classList || !n.classList.contains(m[1])) return false;
      const id = part.match(/#([\w-]+)/);
      if (id && n.id !== id[1]) return false;
      return true;
    };
    if (!node || !simple(parts[i], node)) return false;
    if (parts[i - 1] === '>') {
      i -= 2;
      node = node.parentElement;
      if (!node || !simple(parts[i], node)) return false;
    }
    i -= 1;
    for (; i >= 0; i--) {
      if (parts[i] === '>') { i -= 1; node = node.parentElement; if (!node || !simple(parts[i], node)) return false; continue; }
      node = node.parentElement;
      let found = false;
      while (node) { if (simple(parts[i], node)) { found = true; break; } node = node.parentElement; }
      if (!found) return false;
    }
    return true;
  }
  /* -1 = no match; otherwise the weight of the strongest matching group */
  function selectorMatches(sel, el) {
    let best = -1;
    for (const group of String(sel).split(',')) {
      const g = group.trim();
      if (!g || g.includes('*')) continue;             // `* { margin: 0; padding: 0 }` caps nothing
      if (matchesGroup(g, el)) best = Math.max(best, specificity(g));
    }
    return best;
  }
  /** one element’s own contribution: its cascaded max-width, and the horizontal
   * padding that comes off its content box */
  function boxOf(el) {
    let cap = Infinity, capRule = null, capSpec = -1, padX = 0, padSpec = -1;
    for (const r of rules7) {
      if (r.media !== '') continue;                    // base (screen) rules only
      const spec = selectorMatches(r.sel, el);
      if (spec < 0) continue;
      const mw = (r.body.match(/(?:^|;)\s*max-width\s*:\s*([^;]+)/) || [])[1];
      const c = cssNum(rules7, mw);
      if (c != null && spec >= capSpec) { cap = c; capRule = `${r.sel} { max-width: ${mw} }`; capSpec = spec; }
      const g = (re) => { const m = r.body.match(re); return m ? m[1].trim() : null; };
      const pl = g(/(?:^|;)\s*padding-left\s*:\s*([^;]+)/);
      const pr = g(/(?:^|;)\s*padding-right\s*:\s*([^;]+)/);
      const sh = g(/(?:^|;)\s*padding\s*:\s*([^;]+)/);
      if (pl || pr || sh) {
        let l = 0, rr = 0;
        if (sh) { const t = sh.trim().split(/\s+/); const h = t.length === 1 ? t[0] : t[1]; l = rr = parseFloat(h); }
        if (pl) l = parseFloat(pl);
        if (pr) rr = parseFloat(pr);
        if (spec >= padSpec) { padX = l + rr; padSpec = spec; }
      }
    }
    return { cap, capRule, padX };
  }

  /** walk the chain and return the width the viewer is actually given */
  function containingWidth(html, wrapInProse) {
    const w = new Window();
    w.document.write(html);
    const v = w.document.getElementById('apparatus-viewer');
    if (!v) return { v: null, chain: [], width: null, narrowest: null };
    if (wrapInProse) {                                  // rebuild the pre-fix structure
      const d = w.document.createElement('div');
      d.className = 'prose';
      v.parentElement.insertBefore(d, v);
      d.appendChild(v);
    }
    const chain = [];
    for (let el = v; el && el.tagName; el = el.parentElement) chain.push(el);
    chain.reverse();                                    // html → … → the viewer
    let width = Infinity, narrowest = null;
    for (const el of chain) {
      const b = boxOf(el);
      if (b.cap < width) { width = b.cap; narrowest = { el: descOf(el), rule: b.capRule, cap: b.cap }; }
      width = Math.max(0, width - b.padX);
    }
    return { v, chain, width, narrowest };
  }

  for (const slug of VIEWER_EDITIONS) {
    const version = editions.find((e) => e.slug === slug).current_version;
    for (const [label, rel] of [
      [`/texts/${slug}/apparatus/`, join('texts', slug, 'apparatus', 'index.html')],
      [`/texts/${slug}/v/${version}/apparatus/ (pinned)`, join('texts', slug, 'v', version, 'apparatus', 'index.html')],
    ]) {
      const path = join(DIST, rel);
      if (!existsSync(path)) { check(false, `${label}: the page exists`); continue; }
      const html = readFileSync(path, 'utf8');
      const after = containingWidth(html, false);
      const before = containingWidth(html, true);
      if (!after.v) { check(false, `${label}: #apparatus-viewer is in the served markup`); continue; }
      const chainNames = after.chain.map(descOf);
      const parent = after.v.parentElement;
      check(parent && parent.tagName === 'DIV' && parent.classList.contains('wrap'),
        `${label}: #apparatus-viewer’s PARENT is the section’s own .wrap — the viewer is not wrapped in .prose (parent: ${descOf(parent)})`);
      check(!chainNames.some((c) => c.split(/[.#]/).includes('prose')),
        `${label}: no .prose anywhere in its ancestor chain (${chainNames.join(' < ')})`);
      check(after.width === wrapContent,
        `${label}: so the viewer’s containing width is ${px(after.width)} — the .wrap content box (--reader ${READER} − 2×${padPx} padding), the WHOLE apparatus column`);
      check(after.width >= panel,
        `${label}: and the .app-browser grid spans it, leaving the panel its ${panel}px (${wrapContent} − ${idx}px index − ${gap}px gap)`);
      check(before.width === MEASURE && before.width < panel,
        `${label}: THE ASYMMETRY — the SAME walk over the pre-fix structure (the viewer wrapped in .prose again) measures ${px(before.width)}, below the panel’s ${panel}px`);
      check(!!before.narrowest && before.narrowest.el.split(/[.#]/).includes('prose') && before.narrowest.cap === MEASURE,
        `${label}: and the box that capped it is the .prose parent at ${MEASURE}px (${before.narrowest ? before.narrowest.rule : 'no cap found'}) — the root cause, named on the ancestor chain`);
      const fb = after.v.querySelector('#app-fallback');
      check(!!fb && fb.classList.contains('prose') && boxOf(fb).cap === MEASURE,
        `${label}: while the ONE genuinely prose piece inside the viewer — the no-script fallback — carries .prose itself and keeps the ${MEASURE}px measure (which is what it had before too: the .prose ancestor capped it at the same ${MEASURE}px)`);
      check(boxOf(parent).cap === READER,
        `${label}: and the chain’s ONLY cap is #the-apparatus .wrap at ${READER}px (--reader) — the same token the reader above it uses`);
      console.log(`  NOTE ${label}: viewer containing width BEFORE ${px(before.width)}` +
        `${before.narrowest ? ` (${before.narrowest.rule})` : ''} → AFTER ${px(after.width)}; ` +
        `chain ${chainNames.join(' < ')}`);
    }
  }
}

/* ---------- §8 the leaf RAIL is bounded and the panel holds its place --------
 *
 * THE LEAF INDEX HAS BEEN WRONG IN BOTH DIRECTIONS, and §8 is written from the
 * pair of reports, so it can tell the fix from the bug:
 *   1. `max-height: 36rem; overflow: auto` ALONE (plus 18rem below 56em) made it a
 *      nested scroll region a reader was held in.
 *   2. REMOVING that cap — the state this section was written against until now —
 *      made the OTHER trap: 141 cards flowed down the left column for ~15 screens,
 *      so a late leaf was reached by scrolling the PAGE, with the panel (whose top
 *      is level with the rail's) off-screen above: down for the leaf, back up for
 *      the panel, for every leaf.
 * So the assertions are the shape of the fix, not "no cap": the rail is BOUNDED and
 * scrolls ITSELF (§8b), its cap is the WINDOW less the two sticky bars so the rail
 * is wholly on screen while it is used, it does NOT stop the scroll chaining with
 * `overscroll-behavior: contain` (§8c — the property of trap 1 the fix must not
 * bring back), the panel is STICKY in the wide layout (§8d), and on a narrow screen
 * both panes are bounded with the panel above the rail (§8e) and the index carries a
 * DIRECT JUMP to a leaf (§8f — exercised BOOTED, not only read in the markup).
 *
 * THE ASYMMETRY IS ASSERTED FIRST: §8b's predicate must FAIL on the index as it
 * flows NOW (no cap, no overflow — the state the report was filed against) and pass
 * on the bounded rail; §8c's must FIRE on a rule that sets `overscroll-behavior:
 * contain`. If neither could fail, a green run here would prove nothing. */
section('the leaf rail is bounded and scrolls itself, the panel holds, and a leaf is one jump away');

/** The `.app-leaves` rules of a stylesheet, with their media context. */
const appLeavesRules = (css) => parseCss(css).filter((r) => r.sel === '.app-leaves');

/** THE RAIL'S BOUNDING DECLARATIONS: a height cap, and an overflow that is not
 * `visible`. EMPTY means the index FLOWS in the page — the state the second report
 * was filed against, so this predicate FIRING is the fix and silence is the bug. */
function railBound(rules) {
  const out = [];
  for (const r of rules) {
    const media = r.media ? ` (${r.media})` : '';
    const mh = /(?:^|;)\s*max-height\s*:\s*([^;]+)/.exec(r.body);
    if (mh) out.push(`max-height: ${mh[1].trim()}${media}`);
    const ov = /(?:^|;)\s*overflow(?:-y)?\s*:\s*([^;]+)/.exec(r.body);
    if (ov && !/^\s*(?:visible|clip)\s*$/.test(ov[1])) out.push(`overflow-y: ${ov[1].trim()}${media}`);
  }
  return out;
}

/** THE TRAP PREDICATE — what a rail must NOT do: refuse to let the scroll go at
 * its end (`overscroll-behavior: contain`, or `none`). A rail that chains is a
 * place to scroll; one that contains is a place to be stuck. */
function railTraps(rules) {
  const out = [];
  for (const r of rules) {
    const media = r.media ? ` (${r.media})` : '';
    const os = /(?:^|;)\s*overscroll-behavior(?:-y)?\s*:\s*([^;]+)/.exec(r.body);
    if (os && !/^\s*auto\s*$/.test(os[1])) out.push(`overscroll-behavior: ${os[1].trim()}${media}`);
  }
  return out;
}

/* THE ASYMMETRY, ASSERTED FIRST. (a) The bounded predicate FAILS on the index as
 * it flows now — no cap, no overflow — which is the state the report was filed
 * against; (b) the trap predicate FIRES on the rule that would make it a trap. If
 * either could not fail, a green run here would prove nothing. */
{
  const flowing = '.app-leaves { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); ' +
    'gap: 8px; align-content: start; padding-right: 8px; border-right: 1px solid; ' +
    'scroll-margin-top: calc(var(--nav-h, 52px) + var(--jump-h, 0px) + 8px); }';
  check(railBound(appLeavesRules(flowing)).length === 0,
    'THE ASYMMETRY: the BOUNDED check FAILS on the index as it flowed (no cap, no overflow — the reported state)');
  check(railBound(appLeavesRules('.app-leaves { max-height: calc(100vh - var(--nav-h) - var(--jump-h)); overflow-y: auto; }')).length === 2,
    'and passes on a bounded rail (a cap AND its own scroll) — so it is a test, not a tautology');
  check(railTraps(appLeavesRules('.app-leaves { max-height: 36rem; overflow-y: auto; overscroll-behavior: contain; }')).length === 1,
    'THE TRAP predicate FIRES on `overscroll-behavior: contain` (the rail that will not let the page take over)');
  check(railTraps(appLeavesRules(flowing)).length === 0,
    'and stays SILENT on a rail that leaves the property at its default (chaining is the default)');
}

/** The shell's own boot measures the jump bar, on every page it emits. */
function html_has_jump_measure(html) {
  return /--jump-h/.test(html) && /getBoundingClientRect/.test(html) && /setProperty\('--jump-h'/.test(html);
}

for (const e of editions) {
  const appHtml = readFileSync(appPage(e.slug), 'utf8');
  const edHtml = readFileSync(join(DIST, 'texts', e.slug, 'index.html'), 'utf8');
  const appCss = [...appHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const edCss = [...edHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

  const css = appCss + '\n' + edCss;
  const rules = parseCss(css);

  /* THE RAIL, §8b: BOUNDED, AND SCROLLING ITSELF. MEASURED on the EMITTED
   * stylesheet of both editions, at both widths. */
  const rail = railBound(appLeavesRules(css));
  const caps = rail.filter((d) => d.startsWith('max-height'));
  const scrolls = rail.filter((d) => d.startsWith('overflow-y'));
  check(caps.length > 0 && scrolls.length > 0,
    `${e.slug}: the leaf rail is BOUNDED and scrolls ITSELF — ${rail.length} declaration(s)` +
      (rail.length ? ` (${rail.join('; ')})` : ' (none: the 141 cards flow in the page and the panel is a screen away)'));
  const cap = caps[0] || '';
  check(/100vh/.test(cap) && /--nav-h/.test(cap) && /--jump-h/.test(cap),
    `${e.slug}: and its cap is the WINDOW less both sticky bars (${cap.split(' (')[0]}) — the rail is wholly on screen while it is used, never a window to leave`);
  check(rail.some((d) => /@media \(max-width: 56em\)/.test(d)),
    `${e.slug}: with a bound of its own on a narrow screen too (${caps.filter((d) => /56em/.test(d)).join('; ') || 'NONE'})`);

  /* §8c NOT A TRAP: the scroll CHAINS to the page at the rail's end. */
  const traps = railTraps(appLeavesRules(css));
  check(traps.length === 0,
    `${e.slug}: and it does not contain the scroll (${traps.length ? traps.join('; ') : 'no overscroll-behavior at all — the page takes over at either end'})`);

  /* §8d THE PANEL HOLDS ITS PLACE beside the rail — in the WIDE layout, which is
   * the layout the base rules describe. */
  const pTop = cssProp(rules, '.app-panel', 'top');
  check(cssProp(rules, '.app-panel', 'position') === 'sticky' && /var\(--nav-h/.test(pTop || '') && /var\(--jump-h/.test(pTop || ''),
    `${e.slug}: the selected-leaf panel is STICKY at ${pTop} — below the nav AND the jump bar, both measured`);

  /* §8e ONE COLUMN below 56em: both panes bounded, the panel ABOVE the rail. */
  const narrow = (sel) => rules.filter((r) => r.sel === sel && /max-width:\s*56em/.test(r.media)).map((r) => r.body).join(';');
  const nPanel = narrow('.app-panel');
  const nRail = narrow('.app-leaves');
  check(/max-height/.test(nPanel) && /overflow/.test(nPanel) && /max-height/.test(nRail),
    `${e.slug}: on a NARROW screen both panes are bounded too (panel: ${/max-height/.test(nPanel) ? 'capped, and scrolls itself' : 'UNCAPED'}; rail: ${/max-height/.test(nRail) ? 'capped' : 'UNCAPED'})`);
  check(/grid-row:\s*1/.test(nPanel) && /grid-row:\s*2/.test(nRail),
    `${e.slug}: and the panel stands ABOVE the rail there, so a tap updates what is directly above it with no travel`);

  /* §8f THE DIRECT JUMP: the viewer renders a "go to leaf" number input beside
   * the filter and the search — the rail is 141 cards on proclus, and a leaf a
   * reader has in mind is one action, not a scroll. The inlined viewer is what
   * carries it (so it cannot be a control that exists only in a stylesheet). */
  check(/app-leaf-jump/.test(appHtml) && /app-jump-go/.test(appHtml),
    `${e.slug}: the viewer carries a DIRECT JUMP to a leaf (#app-leaf-jump + a Go control, inlined on the page)`);

  /* THE JUMP BAR: sticky under the nav, its top the nav's MEASURED height. */
  const jTop = cssProp(rules, '.page-contents', 'top');
  check(cssProp(rules, '.page-contents', 'position') === 'sticky' && /var\(--nav-h/.test(jTop || ''),
    `${e.slug}: the in-page jump bar is sticky at ${jTop} — the nav's measured height, not a constant`);

  for (const [where, html] of [['the apparatus page', appHtml], ['the edition page', edHtml]]) {
    check(html.includes('class="page-contents"') && html.includes('class="to-top"'),
      `${e.slug}: ${where} carries the jump bar and the back-to-top control`);
  }
  check(/href="#app-leaves"/.test(appHtml) && /href="#app-panel"/.test(appHtml),
    `${e.slug}: the apparatus page's jump bar reaches the leaf index and the panel`);
  check(/href="#the-text"/.test(edHtml) && /href="#the-apparatus"/.test(edHtml) && /href="#provenance"/.test(edHtml),
    `${e.slug}: the edition page's jump bar reaches the text, the apparatus and the provenance`);
  check(/\.app-panel \{[^}]*scroll-margin-top:\s*calc\(var\(--nav-h/.test(appCss),
    `${e.slug}: and a jump to the panel lands below the two sticky bars`);
  /* THE READER'S OWN CHROME OFFSETS BY THE JUMP BAR TOO, or the toolbar would sit
   * under it — the trap, one layer up. */
  check(/\.rd-bar \{[^}]*top:\s*calc\(var\(--nav-h[^;]*var\(--jump-h/.test(edCss),
    `${e.slug}: the reader's sticky toolbar stacks BELOW the nav AND the jump bar (--nav-h + --jump-h)`);
  check(/\.rd-nav \{[^}]*top:\s*calc\(var\(--nav-h[^;]*var\(--jump-h[^;]*var\(--bar-h/.test(edCss),
    `${e.slug}: and its contents sidebar below both of those and the toolbar`);
  check(html_has_jump_measure(appHtml),
    `${e.slug}: the shell MEASURES the jump bar into --jump-h (getBoundingClientRect -> setProperty)`);
}

/* §8f THE JUMP, BOOTED. A control that is only read in the markup is a seat
 * nobody sits in: this BOOTS the apparatus page and uses it — a leaf the edition
 * holds is turned to (the card selected and brought into the rail's view), and a
 * number it does not hold is STATED, with nothing moved. */
{
  const SLUG = VIEWER_EDITIONS[0];
  const { data } = seen.get(SLUG);
  const ns = data.leaves.map((l) => l.n).sort((a, b) => a - b);

  const j = await boot(SLUG);
  /* The control is looked up the way a reader finds it; if it is absent the checks
   * below still RUN (against a stand-in that cannot navigate), so a missing control
   * fails the battery instead of quietly removing its checks from it. */
  const live = j.w.document.getElementById('app-leaf-jump');
  const liveGo = j.w.document.querySelector('.app-jump-go');
  check(!!live && !!liveGo, 'the direct jump is in the DOM, booted: a number field and a Go control');
  const field = live || { value: '', getAttribute: () => null };
  const go = liveGo || { dispatchEvent: () => {} };
  check(!!field && field.getAttribute('min') === String(ns[0]) && field.getAttribute('max') === String(ns[ns.length - 1]),
    `and it carries the range this edition holds (min ${field && field.getAttribute('min')}, max ${field && field.getAttribute('max')} — the ARCHIVE leaf numbers, n806–n946 on proclus: not a count from 1)`);
  check(j.text('#app-controls').includes(`n${ns[0]}–n${ns[ns.length - 1]}`),
    `... and STATES that range beside the field (${JSON.stringify(j.text('.app-jump-hint'))})`);
  field.value = String(ns[ns.length - 1]);
  go.dispatchEvent(new j.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  check(j.w.location.hash === `#leaf-n${ns[ns.length - 1]}`,
    `typing the last leaf it holds (n${ns[ns.length - 1]}) and clicking Go turns to it (${j.w.location.hash})`);
  j.w.dispatchEvent(new j.w.Event('hashchange'));
  await settle();
  const card = j.w.document.getElementById(`leaf-n${ns[ns.length - 1]}`);
  check(!!card && card.className.includes('selected'),
    'and the rail shows it selected — the number is an action, not a journey down 141 cards');
  check(j.scrolled.includes(`leaf-n${ns[ns.length - 1]}`),
    'and the card is brought into the RAIL’s own view (scrollIntoView on the card, so a jump is not blind within it)');
  const gone = ns[ns.length - 1] + 500;
  field.value = String(gone);
  go.dispatchEvent(new j.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  const said = j.text('#app-status');
  check(j.w.location.hash === `#leaf-n${ns[ns.length - 1]}` && /No leaf n/.test(said) && said.includes(`n${ns[0]}–n${ns[ns.length - 1]}`),
    `a number the edition does NOT hold (n${gone}) moves nothing and says so (${JSON.stringify(said)})`);
}

/* THE OLD ADDRESS STILL RESOLVES — IN A DOM, NOT ONLY IN THE MARKUP. A reading
 * lived on the edition page until the apparatus moved here, so a published
 * `/texts/<slug>/#repair-<id>` (the address /errata printed) is redirected to the
 * apparatus page, which is where the fragment is read. Booted, so the redirect
 * script actually runs. */
{
  const SLUG = VIEWER_EDITIONS[0];
  const rule = seen.get(SLUG).data.rules[0];
  const rctx = await boot(SLUG, {
    page: join(DIST, 'texts', SLUG, 'index.html'),
    url: `/texts/${SLUG}/`,
    hash: `#repair-${rule.id}`,
  });
  const href = String(rctx.w.location.href || rctx.w.location);
  check(href.includes(`/texts/${SLUG}/apparatus/#repair-${rule.id}`),
    `an old #repair-${rule.id} on the edition page is REDIRECTED to the apparatus page (${href.slice(-70)})`);
}

console.log(failures === 0 ? '\napparatus-probe: all checks passed' : `\napparatus-probe: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
