#!/usr/bin/env node
/**
 * build/build.mjs — the site build. Reads data/, writes site/dist/.
 *
 *   node build/build.mjs            the whole site (the two published editions)
 *
 * WHAT IT IS (extraction plan §1.2, §3, §4): the root CLI of the standalone
 * library. It renders the routes §3 names for the editions data/ carries, from
 * the CANONICAL record — `data/editions/<slug>/versions/<semver>/{source.txt,
 * repairs.json,meta.json}` — with the rules derived by `loadEdits` (model §4.3,
 * §4.0) and never read from a second copy. The blog is not consulted: no post,
 * no catalogue, no pandoc, no network. The one outbound reference is the
 * `edition.readings[]` links and site.json's blog.url (plan §6.6).
 *
 * WHAT IT WRITES (model §3.1, §8; plan §4):
 *
 *   /                                  corpus-first home
 *   /texts/                            the corpus, by the shelf's own axis
 *   /texts/<slug>/                     current_version's edition page
 *   /texts/<slug>/t                    current_version's document (the app fetches it)
 *   /texts/<slug>/plain                current_version's plain text
 *   /texts/<slug>/v/<semver>/          a PINNED version's page
 *   /texts/<slug>/v/<semver>/t         its document
 *   /texts/<slug>/v/<semver>/plain     its plain text
 *   /data/corpus.json                  every published edition + its versions
 *   /data/graph.json                   byte copy of data/graph/graph.json
 *   /sitemap.xml, /robots.txt
 *
 * THE GATES, all of them fatal (they are the blog's own, kept):
 *   - `checkEdits`  — every repair rule fires at least once in the served text;
 *   - `checkAnchors`— the anchor manifest is pinned; a moved anchor fails;
 *   - `checkWorkshopAll` — the workshop-leak gate over the rendered output.
 *
 * NO PANDOC. The library renders zero markdown (plan §1.3): the reader's
 * fallback is the transcription rendered by this repo's own reader.mjs, and
 * `plain` is `plainText()`.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import {
  extract,
  counts,
  serialiseDoc,
  plainText,
  checkEdits,
  checkAnchors,
  editionRecord,
  LIBRARY_DIR,
  readMeta,
  readEdition,
  sha256,
} from '../tools/extract.mjs';
import { TEXTS, isPublished } from '../tools/shelf.mjs';
import {
  SITE,
  BASE,
  DIST,
  ROOT,
  writePage,
  writeFile,
  sitemapXml,
  robotsTxt,
} from './shell.mjs';
import { libraryTextPages, buildTextsIndex, buildHome, logPageModel } from './library.mjs';
import { buildShelfIndex, buildSearchPage } from './search.mjs';
import { readGraph, buildGraphPage } from './graph.mjs';
import { apparatusJson, LEAF_FILE } from './apparatus.mjs';
import { buildEditionsPage, buildAboutPage, buildErrataPage, buildNotFoundPage } from './pages.mjs';
import { checkWorkshop, checkWorkshopAll } from './leak.mjs';

const log = (msg) => console.log(`[build] ${new Date().toISOString()} ${msg}`);
const warn = (msg) => console.warn(`[build] WARNING: ${msg}`);

/* ---------- the editions, as the model states them ---------- */

/** The page's view of an edition: the DATA-MODEL §3 record where the repo
 * stores one, the shelf entry only for what it adds (the archive item, the
 * language, the repair note — the pipeline's own evidence). The record is the
 * source of every bibliographic field the page prints; nothing is parsed back
 * out of a prose string, and a field the model leaves empty stays empty. */
function editionView(t) {
  const e = editionRecord(t.slug);
  if (!e) {
    return { ...t, cat: t.cat || [], readings: [], currentVersion: null, place: '', imprint: '' };
  }
  return {
    ...t,
    title: e.title,
    author: e.author,
    translator: e.translator,
    year: e.source_edition.year != null ? e.source_edition.year : t.year,
    edition: e.source_edition.statement,
    place: e.source_edition.place || '',
    imprint: e.source_edition.imprint || '',
    cat: e.cat || [],
    readings: e.readings || [],
    repair: { state: e.repair_state || 'damaged', note: (t.repair && t.repair.note) || '' },
    currentVersion: e.current_version || null,
    licenceEditorial: (e.licence && e.licence.editorial) || SITE.licence.editorial,
    citation: e.citation,
    doi: e.doi,
    record: e,
  };
}

/* ---------- the anchor gate, per version ---------- */

/**
 * WHICH MANIFEST A VERSION IS CHECKED AGAINST.
 *
 * `tools/anchors/<slug>.json` is the manifest the migration copied from the
 * blog — the pin for the version the blog served, which is this edition's
 * `current_version` at migration time. A version that is not that one gets its
 * own manifest, `<slug>@<semver>.json`, written once and then pinned in turn.
 * The result is the property §4 promises: v1.0.0's anchors cannot move when
 * v1.1.0 ships, and a version that WAS pinned fails the build if its anchors
 * change rather than silently re-pinning.
 */
const anchorVersionPath = (slug, version) => join(ROOT, 'tools', 'anchors', `${slug}@${version}.json`);
const primaryAnchorPath = (slug) => join(ROOT, 'tools', 'anchors', `${slug}.json`);
function pinAnchors(doc, slug, version, currentVersion) {
  const perVersion = anchorVersionPath(slug, version);
  if (existsSync(perVersion)) return { ...checkAnchors(doc, perVersion), file: perVersion };
  if (version === currentVersion && existsSync(primaryAnchorPath(slug))) {
    return { ...checkAnchors(doc, primaryAnchorPath(slug)), file: primaryAnchorPath(slug) };
  }
  return { ...checkAnchors(doc, perVersion), file: perVersion };
}

/* ---------- the build ---------- */

log(`building ${SITE.name} -> ${DIST}`);
if (!existsSync(join(ROOT, 'data', 'site.json'))) throw new Error('data/site.json is missing');
if (!existsSync(join(ROOT, 'design', 'library.css'))) throw new Error('design/library.css is missing');
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const served = TEXTS.filter(isPublished).map(editionView);
if (served.length === 0) throw new Error('no published edition on the shelf — nothing to build');


const written = []; // pages, for the leak gate
const writtenFiles = []; // data files, for the leak gate
const sitemapUrls = [];
const corpus = { site: SITE, editions: [] };

let ruleTotal = 0;
let anchorsPinned = 0;
let scanTotal = 0;
/** The CURRENT version's extracted document per slug — the search index is built
 * over the same extraction the pages are rendered from, so the index and the
 * pages cannot disagree about what a passage says. */
const currentDocs = new Map();

for (const t of served) {
  const versions = readdirSync(join(LIBRARY_DIR, t.slug, 'versions'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (versions.length === 0) throw new Error(`library: ${t.slug}: no versions/ directory — an edition must have one`);
  const current = t.currentVersion;
  if (!current || !versions.includes(current)) {
    throw new Error(`library: ${t.slug}: current_version "${current}" is not one of versions/ (${versions.join(', ')})`);
  }
  log(`${t.slug}: ${versions.length} version(s), current ${current}`);

  if (!t.record) throw new Error(`library: ${t.slug}: published but data/editions/${t.slug}/edition.json is missing`);
  corpus.editions.push({
    ...t.record,
    versions: versions.map((v) => {
      const m = readMeta(t.slug, v);
      return { version: v, date: m.date, note: m.note, source_sha256: m.source_sha256, citation: m.citation, supersedes: m.supersedes };
    }),
  });

  for (const version of versions) {
    const src = readEdition(t.slug, version);
    const meta = readMeta(t.slug, version);
    if (!meta) throw new Error(`library: ${t.slug} v${version}: meta.json is missing — a version states its own date, note and citation`);
    const sha = sha256(src);
    /* THE VERSION IS PINNED BY ITS BYTES (model §3.1): meta.json records the
     * sha256 of source.txt, and a build whose bytes differ from the record is a
     * version that has been edited in place. Fail rather than emit it. */
    if (meta.source_sha256 && meta.source_sha256 !== sha) {
      throw new Error(
        `library: ${t.slug} v${version}: source.txt hashes ${sha} but meta.json records ${meta.source_sha256} — ` +
          `a version is frozen bytes; a change belongs in a NEW version directory`,
      );
    }
    if (!meta.citation) throw new Error(`library: ${t.slug} v${version}: meta.json carries no citation string`);

    const doc = extract(src, { entry: t, sha256: sha, version });
    if (version === current) currentDocs.set(t.slug, doc);
    /* THE ACCEPTANCE RULE: every rule must fire at least once (plan §7). The
     * report is printed, one line per rule, because a table that is only checked
     * is a table nobody reviews. */
    const report = checkEdits(doc);
    ruleTotal += report.length;
    const byCls = report.reduce((a, r) => ((a[r.cls] = (a[r.cls] || 0) + 1), a), {});
    log(
      `library: ${t.slug} v${version}: ${report.length} rule(s) — ` +
        `${Object.entries(byCls).map(([k, n]) => `${n} ${k}`).join(', ')} — every one fires; ` +
        `${report.reduce((a, r) => a + r.hits, 0)} application(s) in the served text`,
    );
    for (const r of report.filter((r) => r.hits > 1)) {
      log(`library:   (fires ${r.hits}×) ${JSON.stringify(r.find)} → ${JSON.stringify(r.repl)}`);
    }

    const pinned = pinAnchors(doc, t.slug, version, current);
    if (pinned.pinned) anchorsPinned += 1;
    logPageModel(t, doc, src);

    /* A VERSION'S PAGE EXISTS AT ITS OWN URL ALWAYS — `/texts/<slug>/v/<semver>/`
     * — and, when it is the CURRENT version, at the bare `/texts/<slug>/` as well
     * (plan §4). The two are rendered separately because they are not the same
     * page: each carries its own URL as canonical (page() derives it from
     * navCurrent), so a copy of the other's HTML would advertise the wrong
     * canonical. The bare page is regenerated on each release; the version's own
     * directory is never touched again. */
    const bases = [`/texts/${t.slug}/v/${version}/`];
    if (version === current) bases.unshift(`/texts/${t.slug}/`);
    for (const base of bases) {
      const rendered = libraryTextPages(t, doc, base, version, current, meta);
      for (const p of rendered.pages) written.push({ rel: p.rel, html: writePage(p.rel, p.def) });
      sitemapUrls.push(...rendered.urls);
    }

    /* THE APPARATUS, AS DATA (model §7). The edition page no longer inlines the
     * version's repair log — it fetches this file and renders it in a viewer
     * navigated by the page image each reading was decided from. It is written at
     * the version's own address, and at the bare one when this IS the current
     * version, so the page and the file it fetches are the same version's: a
     * pinned page reads the apparatus of the version it pins. It holds the book's
     * own words, so it is a DATA FILE (like /search/index) and the leak gate reads
     * it as one. */
    const appJson = apparatusJson(t, version);
    writtenFiles.push({ rel: `texts/${t.slug}/v/${version}/apparatus.json`, text: writeFile(`texts/${t.slug}/v/${version}/apparatus.json`, appJson) });
    if (version === current) {
      writtenFiles.push({ rel: `texts/${t.slug}/apparatus.json`, text: writeFile(`texts/${t.slug}/apparatus.json`, appJson) });
    }

    /* THE DOCUMENT AND THE PLAIN TEXT, at the version's own URL — and, when this
     * is the current version, at the bare URL too: that is the address a
     * citation to "the edition" resolves to, and the address an old bookmarked
     * reader page fetches. The two are serialised from ONE extraction, so the
     * bare document and the pinned one cannot disagree about the same bytes. */
    const serial = serialiseDoc(doc);
    const plain = plainText(doc, t);
    const dirs = [`texts/${t.slug}/v/${version}/`];
    if (version === current) dirs.push(`texts/${t.slug}/`);
    for (const dir of dirs) {
      writtenFiles.push({ rel: `${dir}t`, text: writeFile(`${dir}t`, serial) });
      writtenFiles.push({ rel: `${dir}plain`, text: writeFile(`${dir}plain`, plain) });
    }
    const c = counts(doc);
    log(
      `library: ${t.slug} v${version}: document ${c.blocks} block(s) — ${c.sections} sections, ${c.notes} notes, ` +
        `${c.pages.detected} page number(s) read, ${c.pages.refused} refused; ` +
        `anchors pinned at ${pinned.file.replace(ROOT + '/', '')}` +
        (pinned.pinned ? ' (written now — commit it: it is the promise that a citation keeps resolving)' : ''),
    );
  }

  /* THE SOURCE SCANS, SERVED BESIDE THE TEXT (model §1/§3). Each served
   * edition's stored leaf images are copied to the STABLE address
   * `/texts/<slug>/scans/nNNN.jpg` that a rule's evidence cites, so a repair's
   * leaf resolves to the image itself. They are binary images — not pages and
   * not data files — so they never enter the leak gate; they are copied, not
   * rendered. The deploy carries them (tools/deploy.sh has no --delete, so a
   * leaf the current build drops is retained server-side); the honest cost is
   * the SIZE (≈59M for the two editions, MEASURED 2026-10-05), stated in tools/deploy.sh. */
  const scansFrom = join(LIBRARY_DIR, t.slug, 'scans');
  if (existsSync(scansFrom)) {
    const scansTo = join(DIST, 'texts', t.slug, 'scans');
    cpSync(scansFrom, scansTo, { recursive: true });
    const n = readdirSync(scansTo).filter((f) => LEAF_FILE.test(f)).length;
    scanTotal += n;
    log(`library: ${t.slug}: ${n} source leaf image(s) -> texts/${t.slug}/scans/`);
  }
}

/* ---------- the index, the home, the exports ---------- */

written.push({ rel: 'texts/index.html', html: writePage('texts/index.html', buildTextsIndex(served, TEXTS)) });
written.push({ rel: 'index.html', html: writePage('index.html', buildHome(served)) });
sitemapUrls.push('/texts/');

/* ---------- /search, /graph, /editions, /about, /errata, 404 ---------- */

/* THE SEARCH INDEX is a DATA FILE, not page prose: it is the books' own text, and
 * the leak gate reads a page and a data file differently (a book's words are not
 * the site's vocabulary — see build/leak.mjs). So it goes through writeFile and
 * is gated with the other data files, and the page carries only its address. */
const search = buildShelfIndex(served, currentDocs);
writeFile('search/index', JSON.stringify(search.index));
writtenFiles.push({ rel: 'search/index', text: JSON.stringify(search.index) });
written.push({ rel: 'search/index.html', html: writePage('search/index.html', buildSearchPage(search.totals)) });
sitemapUrls.push('/search/');
log(
  `search index: ${search.totals.passages} passage(s) of ${search.totals.docs} text(s), ` +
    `${search.totals.words} word(s) in the list, ${search.totals.dafsaStates} automaton states ` +
    `(${search.totals.dafsaBytes} bytes)` +
    (search.totals.skipped ? `; ${search.totals.skipped} served text(s) not indexed` : ''),
);

/* THE GRAPH is rendered from data/graph/graph.json AS AUTHORED — no edge is
 * inferred. The seed is sparse and the page says so (§7 risk 6). The served
 * slugs go with it: the graph is authored data and can name an edition before
 * that edition's text is served, and only a node whose page exists is a link. */
const graph = readGraph();
written.push({ rel: 'graph/index.html', html: writePage('graph/index.html', buildGraphPage(graph, served.map((t) => t.slug))) });
sitemapUrls.push('/graph/');
log(`graph: ${graph.nodes.length} node(s), ${graph.edges.length} edge(s) — rendered as authored (the seed is sparse)`);

written.push({ rel: 'editions/index.html', html: writePage('editions/index.html', buildEditionsPage(served)) });
written.push({ rel: 'about/index.html', html: writePage('about/index.html', buildAboutPage(served)) });
written.push({ rel: 'errata/index.html', html: writePage('errata/index.html', buildErrataPage(served)) });
written.push({ rel: '404.html', html: writePage('404.html', buildNotFoundPage()) });
sitemapUrls.push('/editions/', '/about/', '/errata/');

/* THE EXPORTS (model §8, plan §3): plain files in the static tree, nothing
 * server-side. corpus.json is the CITED record — the edition.json of every
 * published edition plus its version list — so a reader can take the corpus
 * without the HTML. */
/* The corpus export is a PROVENANCE RECORD and is gated as one: it is the
 * edition records taken whole, so it names the external files they came from
 * (see checkWorkshop's `provenance` scope). Everything else goes through the
 * full gate. */
const corpusText = `${JSON.stringify(corpus, null, 2)}\n`;
writeFile('data/corpus.json', corpusText);
{
  const problems = checkWorkshop(corpusText, { data: true, provenance: true });
  if (problems.length) {
    throw new Error(`workshop leak(s) in data/corpus.json:\n${problems.join('\n')}`);
  }
}
const graphRaw = readFileSync(join(ROOT, 'data', 'graph', 'graph.json'), 'utf8');
writtenFiles.push({ rel: 'data/graph.json', text: writeFile('data/graph.json', graphRaw) });

writtenFiles.push({ rel: 'sitemap.xml', text: writeFile('sitemap.xml', sitemapXml(sitemapUrls)) });
writtenFiles.push({ rel: 'robots.txt', text: writeFile('robots.txt', robotsTxt()) });

/* ---------- the gates ---------- */

checkWorkshopAll(written, writtenFiles);

log(
  `${served.length} edition(s), ${ruleTotal} repair rule(s), ${written.length} page(s), ` +
    `${writtenFiles.length} data file(s), ${scanTotal} source leaf image(s) -> ${DIST}`,
);
if (anchorsPinned) log(`${anchorsPinned} anchor manifest(s) written — commit them`);
