/**
 * build/scans.mjs — the edition's whole scan, browsed.
 *
 * `/texts/<slug>/apparatus/` opens the page images as EVIDENCE: it is navigated
 * by reading, and the leaf a reading was decided from is where it starts. The
 * stored scan is larger than that — it is the edition's whole run of pages, most
 * of which no reading cites — and until now it had no index of its own: the
 * address every page prints (`/texts/<slug>/scans/`) served the images but 404'd
 * on the directory, so a reader who followed it got nothing.
 *
 * This module builds that index: `/texts/<slug>/scans/index.html`, one entry per
 * STORED leaf, in leaf order — its thumbnail (lazy), its leaf key (the key the
 * record addresses it by, `v1-n76` or `n809`), and the printed page where the
 * edition's own record stamps one. Grouped by volume where the edition's work is
 * cut from more than one (the leaf's own prefix is the volume), because the
 * stored names of a two-volume work run their numbers over each other.
 *
 * WHERE THE PRINTED PAGE COMES FROM, and where it does not. The page a leaf
 * carries is the edition's RECORDED page model — `scan.json`, whose offset is
 * fixed by MEASUREMENT at both ends of the run (the record states: n806 is
 * printed page 301 and n946 is page 441, so a leaf's page is `n − offset`). The
 * arithmetic is the record's own and covers the run the record names; a leaf
 * outside it gets NO page rather than a computed one. An edition whose page
 * model is recorded in another shape gets no page column at all — MEASURED,
 * Porphyry's `derivs.json` numbers its leaves 1…71 and 73 over 72 stored files
 * named `n0.jpg`…`n71.jpg`, so its leaf numbers are the archive item's own
 * object index and not the stored names; mapping one onto the other would print
 * a printed page beside the wrong leaf, which is worse than printing none.
 * `interpolated` pages (a number the record fills in from the leaves around it,
 * which nothing on the leaf reads) are not served either — the build's own
 * standing decision, recorded where the page model is read.
 *
 * A LEAF IS COUNTED FROM THE DIRECTORY, never typed: the stored names in
 * `data/editions/<slug>/scans/` ARE the index, so the page cannot advertise a
 * leaf the edition does not hold, nor miss one it does.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { storedLeaves, LEAF_FILE } from './apparatus.mjs';
import { ROOT, SITE, esc, section } from './shell.mjs';
import { contents } from './library.mjs';

/** The leaf's own key in the record — the stored file name without its suffix,
 * which is the name the address and every reading's evidence use. */
const leafKey = (file) => file.replace(/\.jpg$/i, '');

/**
 * THE RECORDED PAGE RUNS of an edition: `[{ prefix, offset, lo, hi, pages }]`,
 * read from `scan.json`. A two-volume work records one run per volume, keyed by
 * the prefix its leaf files carry; a single-item edition records one run with no
 * prefix. A run is used only when the record states its offset AND the leaf range
 * the offset holds over — a run with either missing stamps nothing, because a
 * page computed over an unstated range is a guess wearing a measurement's name.
 */
function pageRuns(t) {
  const file = join(ROOT, 'data', 'editions', t.slug, 'scan.json');
  if (!existsSync(file)) return [];
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const runs = [];
  if (Array.isArray(s.items) && s.items.length) {
    for (const i of s.items) {
      const lo = i.leaves && i.leaves[0];
      const hi = i.leaves && i.leaves[1];
      if (!Number.isInteger(i.archiveOffset) || !Number.isInteger(lo) || !Number.isInteger(hi)) continue;
      runs.push({
        prefix: (i.prefix || '').replace(/-+$/, ''),
        offset: i.archiveOffset,
        lo,
        hi,
        pages: Array.isArray(i.pages) && i.pages.length === 2 ? i.pages : null,
        volume: i.volume || null,
      });
    }
    return runs;
  }
  const v = Array.isArray(s.verified) ? s.verified : [];
  if (Number.isInteger(s.archiveOffset) && v.length) {
    runs.push({
      prefix: '',
      offset: s.archiveOffset,
      lo: v[0].archive,
      hi: v[v.length - 1].archive,
      pages: s.firstPage != null && s.lastPage != null ? [s.firstPage, s.lastPage] : null,
      volume: null,
    });
  }
  return runs;
}

/** The printed page the record stamps for a stored leaf, or null. */
function pageOf(runs, leaf) {
  for (const r of runs) {
    if (r.prefix !== leaf.prefix) continue;
    if (leaf.n < r.lo || leaf.n > r.hi) continue;
    const p = leaf.n - r.offset;
    if (r.pages && (p < r.pages[0] || p > r.pages[1])) continue;
    return p;
  }
  return null;
}

/** The stored leaves, split into the runs the edition's work is printed in —
 * `[{ prefix, volume, run, leaves }]`. An edition with no prefix and one run
 * gives ONE group, and the group's own name is left null so the page titles its
 * single section after the page rather than after a volume that is not named. */
export function editionScans(t) {
  const runs = pageRuns(t);
  const stored = storedLeaves(t.slug);
  const groups = [];
  for (const s of stored) {
    /* The volume prefix is part of the stored NAME (`v1-n76.jpg`) and not part
     * of the leaf number — the regex captures the whole name, so the prefix is
     * read off the name directly. MEASURED: taking it as "everything the regex
     * did not match" gives '' for every leaf, because the regex matches the
     * whole name, which silently collapsed a two-volume work into one group. */
    const prefix = (LEAF_FILE.exec(s.file) && /^(v\d+)-/.exec(s.file)?.[1]) || '';
    let g = groups.find((x) => x.prefix === prefix);
    if (!g) {
      const run = runs.find((r) => r.prefix === prefix) || null;
      g = {
        prefix,
        volume: (run && run.volume) || null,
        run,
        leaves: [],
      };
      groups.push(g);
    }
    g.leaves.push({
      n: s.n,
      key: leafKey(s.file),
      file: s.file,
      url: `/texts/${t.slug}/scans/${s.file}`,
      page: pageOf(runs, { prefix, n: s.n }),
    });
  }
  return { groups, total: stored.length };
}

const leafCell = (l) =>
  `<li class="scan-leaf">` +
  `<a class="scan-leaf-link" href="${esc(l.url)}"><img class="scan-leaf-img" src="${esc(l.url)}" ` +
  `alt="leaf ${esc(l.key)}" loading="lazy" decoding="async"></a>` +
  `<span class="scan-leaf-key">${esc(l.key)}</span>` +
  (l.page != null ? `<span class="scan-leaf-page">p.&nbsp;${l.page}</span>` : '') +
  `</li>`;

const grid = (g) => `<ol class="scan-grid">${g.leaves.map(leafCell).join('')}</ol>`;

/** The one-line caption over a group's grid: the run of leaves, how many, and
 * the printed pages they carry where the record stamps them. Every number is
 * DERIVED from the stored leaves and the recorded run — none is typed, so the
 * caption cannot disagree with the grid beneath it. */
function groupHint(g) {
  const first = g.leaves[0];
  const last = g.leaves[g.leaves.length - 1];
  const n = g.leaves.length;
  const span = n === 1 ? `leaf ${first.key}` : `leaves ${first.key}–${last.key}`;
  const counted = `${n} ${n === 1 ? 'leaf' : 'leaves'}`;
  const pages = g.leaves.filter((l) => l.page != null);
  const printed = pages.length
    ? ` · printed pp. ${Math.min(...pages.map((l) => l.page))}–${Math.max(...pages.map((l) => l.page))}`
    : '';
  return `${span} · ${counted}${printed}`;
}

/* ---------- the page ---------- */

/** THE SCANS INDEX of one edition: every page of the whole stored run, one
 * thumbnail per leaf, in leaf order. The page carries the statement of what the
 * images are and where their printed page numbers come from, the jump bar when
 * the work is printed in more than one volume (so the second volume is one click
 * away on a 700-leaf page), and nothing else per leaf but its key and its
 * printed page — an index is for finding a page, not for reading one.
 *
 * THE FIRST SECTION IS NOT CALLED "The scans": the page's own <h1> is, and a
 * section that restates its page's heading is the doubled heading the design
 * review removed. It is named for what it holds — the leaf index — and the
 * heading below it is the volume's own name, or (one volume) nothing more. */
export function scansIndexPage(t) {
  const { groups, total } = editionScans(t);
  const scansBase = `/texts/${t.slug}/scans/`;
  const multi = groups.length > 1;

  const intro =
    `<p><b>Every leaf the edition is built on.</b> The whole stored run of images of ${esc(t.title)} — ` +
    `${total} ${total === 1 ? 'leaf' : 'leaves'} of it` +
    (multi ? `, in ${groups.length} volumes` : '') +
    ` — is served beside the text at <code>${esc(scansBase)}&lt;leaf&gt;.jpg</code>, one image per leaf, ` +
    `at full page size. This page is its index: the leaves in their own order, each opening the image it ` +
    `names. They are the pages the transcription was read against — not only the leaves a recorded reading ` +
    `cites, so a page is here whether or not an emendation rests on it.</p>` +
    `<p><b>The printed page.</b> Where the edition’s record fixes the relation between its leaves and the ` +
    `printed pages — measured at both ends of the run and stored with the edition — the printed page is given ` +
    `beside the leaf key. A leaf the record does not reach carries none, and none is computed for it: a ` +
    `number the record does not stamp is not shown as one.</p>`;

  const overall = `${total} ${total === 1 ? 'leaf' : 'leaves'}${multi ? ` in ${groups.length} volumes` : ''}`;
  const sections = multi
    ? [
        section('The leaf index', overall, intro, { id: 'the-scan' }),
        ...groups.map((g, i) =>
          section(esc(g.volume || `volume ${i + 1}`), esc(groupHint(g)), grid(g), {
            id: `vol-${i + 1}`,
            prose: false,
          }),
        ),
      ]
    : [
        section(
          'The leaf index',
          esc(groupHint(groups[0] || { leaves: [] })),
          `<div class="prose">${intro}</div>` + grid(groups[0] || { leaves: [] }),
          { id: 'the-scan', prose: false },
        ),
      ];

  /* THE JUMP BAR IS FOR THE PAGE'S OWN LENGTH: 700 leaves in two volumes is a
   * page a reader has to be able to cross, and the second volume is otherwise a
   * long scroll away. A single-volume edition has one run and nothing to jump
   * between, so it carries none. */
  const body =
    (multi ? contents(...groups.map((g, i) => [`vol-${i + 1}`, g.volume || `volume ${i + 1}`])) : '') +
    sections.join('');

  return {
    rel: `texts/${t.slug}/scans/index.html`,
    url: scansBase,
    def: {
      title: `The scans of ${t.title} — ${SITE.host}`,
      shareTitle: `The scans of ${t.title}`,
      type: 'article',
      description:
        `The whole stored scan of ${t.title} (${t.author}, ${t.year}), leaf by leaf: ${total} leaf ` +
        `${total === 1 ? 'image' : 'images'}, each opening its own page.`,
      eyebrow: `Scans · ${t.author}`,
      heading: 'The scans',
      standfirst: `${t.author} · ${t.year} · ${total} ${total === 1 ? 'leaf' : 'leaves'} served`,
      navCurrent: scansBase,
      crumbs: [
        { label: 'Library', href: '/' },
        { label: 'Texts', href: '/texts/' },
        { label: t.author },
        { label: t.title, href: `/texts/${t.slug}/` },
        { label: 'The scans' },
      ],
      body,
    },
  };
}
