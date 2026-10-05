/**
 * build/pages.mjs — the library's own pages: /editions, /about, /errata and the
 * 404 (extraction plan §3, DATA-MODEL §7).
 *
 * These are the site's OWN prose — the corpus is first and the commentary is
 * secondary, so nothing here argues; it states what an edition is, what the
 * licence is, how to cite one, and what the library asserted where a reading
 * rested on judgment. Every provenance string and every repair rationale is the
 * DATA's, not a new claim: the pages read `edition.json`, the version's
 * `repairs.json` and `meta.json`, and site.json.
 *
 * The licence is the split the repo carries: the transcriptions are public
 * domain (LICENSE), the editorial layer is CC BY 4.0 (LICENSE-editorial), and
 * the statement is site.json's.
 */

import { readFileSync } from 'node:fs';
import { repairsPath, readMeta } from '../tools/extract.mjs';
import { REPAIR_LABELS, repairOf, MODERN_EDITIONS } from '../tools/shelf.mjs';
import { esc, SITE } from './shell.mjs';
import { gateSafeText } from './leak.mjs';
import { linkDoi, scanLeafCount, archiveItems } from './library.mjs';

/** The four scholarly repair types (DATA-MODEL §4.1), said once. */
const TYPE_MEANING = {
  OCR: 'a character or word the scanner misread; the print is recovered',
  punctuation: 'a mark of punctuation added, removed or changed',
  transliteration: 'Greek or other script restored from the page image',
  conjectural: 'no witness; an editor’s reading, stated as such',
};

const TYPE_ORDER = ['OCR', 'punctuation', 'transliteration', 'conjectural'];

/** The version's repair log (the canonical file, model §4.3). */
function repairsOf(t) {
  return JSON.parse(readFileSync(repairsPath(t.slug, t.currentVersion), 'utf8'));
}

const countBy = (rules, key) =>
  rules.reduce((a, r) => ((a[r[key]] = (a[r[key]] || 0) + 1), a), {});

/* ---------- /editions ---------- */

/** Editorial policy, standards, provenance. The provenance paragraphs are the
 * library's own text, re-posed for a page that states the policy once and then
 * every served edition against it. */
export function buildEditionsPage(served) {
  const typesTable =
    `<table class="types"><thead><tr><th>type</th><th>what it is</th></tr></thead><tbody>` +
    TYPE_ORDER.map((t) => `<tr><td><code>${esc(t)}</code></td><td>${esc(TYPE_MEANING[t])}</td></tr>`).join('') +
    `</tbody></table>`;

  const policy =
    `<p><b>An edition here is a transcription of a printed book, kept whole.</b> Nothing is ` +
    `modernised and nothing is silently corrected: the scanner’s own characters stand, and what was done to ` +
    `them is a RECORDED SET OF REPAIRS — a list of rules, each with the words it changes, why, and how many ` +
    `times it fires. The reading view applies them; the transcription view shows the pages with none applied. ` +
    `The difference between the two views is the repair list itself, which is why the list is served beside ` +
    `the text.</p>` +
    `<p><b>What a repair may rest on.</b> A repair is made only where a witness decides it: the ` +
    `transcription’s own context, a parallel edition of the same translation, or the printed page image. Where ` +
    `no witness settles a place, no repair is invented — the damage stays, visible and marked, and a rule may ` +
    `record the decision to leave it. So a repaired edition reads cleanly where the print could be ` +
    `recovered and shows its damage where it could not, and it never says anything the print does not.</p>` +
    `<p><b>The repair classes.</b> Every rule carries one of four types, and the type is a claim about the ` +
    `kind of thing it is:</p>` +
    typesTable +
    `<p>A rule also carries its PIPELINE class (<code>opener</code>, <code>digit</code>, <code>reading</code>, ` +
    `<code>review</code>), which is a different question: it is the order the rules must run in, and it is not ` +
    `the same taxonomy. Both are stored, because a text cannot be re-rendered from the type alone.</p>` +
    `<p><b>The versioning promise.</b> An edition is served as an immutable VERSION: its transcription is ` +
    `frozen bytes, pinned by a checksum recorded with the version, and cited by version number. A citation to ` +
    `v1.0.0 keeps resolving to v1.0.0 forever — shipping v1.1.0 writes a new directory and moves the bare ` +
    `edition address, and leaves the old one standing. The anchors a passage links to are pinned too: a ` +
    `passage that resolved once keeps resolving, and the library refuses to move one.</p>` +
    `<p><b>The licence.</b> ${esc(SITE.licence.statement)}</p>`;

  /* WHAT IS NOT HERE: the modern scholarly editions, named, with the reason — the
   * same statement the shelf makes, kept. */
  const modern = MODERN_EDITIONS.map((m) => `${m.who}’s ${m.what}`).join('; ');
  const notHere =
    `<p>The modern scholarly editions are not here: ${esc(modern)}, and the current occult presses’ editions. ` +
    `They are not absent by oversight — they carry a living translator’s or publisher’s rights and belong to ` +
    `the people who made them. What the library can hold is what nobody owns any more.</p>`;

  const blocks = served.map((t) => {
    const rep = repairsOf(t);
    const meta = readMeta(t.slug, t.currentVersion);
    const byType = countBy(rep.rules, 'type');
    /* The readings supplied with no witness — the places /errata lists. NOT a
     * review count: every rule's type is settled (model §4.1), and the field the
     * migration used to flag work is `false` throughout. */
    const conjectural = rep.rules.filter((r) => r.type === 'conjectural').length;
    const bytes = `<code>${rep.damage.map((c) => esc(JSON.stringify(c))).join(' ')}</code>`;
    /* The items the scan came from, as a LIST: one volume's item, or the two of
     * a work the print divides over two volumes. Naming only the first would
     * misstate where this edition's leaves come from. */
    const items = archiveItems(t);
    const itemsHtml = items
      .map((i) => `<a href="${esc(i.url)}" rel="noreferrer"><code>${esc(i.id)}</code></a>`)
      .join(' and ');
    return (
      `<h3 id="ed-${esc(t.slug)}">${esc(t.title)} — ${esc(t.author)}${t.translator ? `, tr. ${esc(t.translator)}` : ''}</h3>` +
      `<p><b>Source.</b> ${esc(t.record.source_edition.statement)}</p>` +
      `<p><b>Scanned from.</b> ` +
      (items.length
        ? `Internet Archive identifier${items.length === 1 ? '' : 's'}: ${itemsHtml}. ` +
          `The whole import record (the line range, the checksums, the page arithmetic) is in ` +
          `<a href="/data/corpus.json">the data export</a>.`
        : `the archive item is not recorded for this edition.`) +
      `</p>` +
      (scanLeafCount(t.slug)
        ? `<p><b>The source page images.</b> The edition’s whole scan — all ${scanLeafCount(t.slug)} ` +
          `${scanLeafCount(t.slug) === 1 ? 'leaf' : 'leaves'} of it — is stored with it and served, one image per ` +
          `leaf, at <a href="/texts/${esc(t.slug)}/scans/">/texts/${esc(t.slug)}/scans/</a> — so the leaf a repair ` +
          `cites resolves to the image itself, and a leaf no reading used is readable all the same. They are the ` +
          (items.length
            ? `Internet Archive's scan${items.length === 1 ? '' : 's'} of the ${items.length === 1 ? 'volume' : `${items.length} items`} this edition's leaves come from (${itemsHtml})`
            : `archive's scan of this volume`) +
          `, a public-domain work like the transcription; the editorial layer over them — the repairs and ` +
          `their rationales, the page models, the apparatus — is CC BY 4.0.</p>`
        : '') +
      `<p><b>The state.</b> <span class="tag">${esc(REPAIR_LABELS[repairOf(t).state] || repairOf(t).state)}</span> ` +
      `— ${gateSafeText(esc(repairOf(t).note), t.slug)}</p>` +
      (rep.rules.length
        ? `<p><b>What it carries.</b> ${rep.rules.length} repair rule${rep.rules.length === 1 ? '' : 's'} ` +
          `(${TYPE_ORDER.filter((k) => byType[k]).map((k) => `${byType[k]} ${k}`).join(', ')}), ` +
          `${conjectural} of them a reading supplied with no witness (see <a href="/errata/">errata</a>). ` +
          `The base policy is <code>${esc(rep.policy)}</code>, and the damage characters a rule may reach are ` +
          `${bytes}. ` +
          `Version <code>${esc(t.currentVersion)}</code>, ${esc(meta.date)}, transcription checksum ` +
          `<code>${esc(meta.source_sha256.slice(0, 16))}…</code>.</p>`
        : `<p><b>What it carries.</b> No repair rules yet: the transcription is served exactly as it stands and ` +
          `no emendation has been made, so the reading view and the transcription view are the same text. The ` +
          `base policy a rule will be written under is <code>${esc(rep.policy)}</code>, and the damage ` +
          `characters a rule may reach are ${bytes}. ` +
          `Version <code>${esc(t.currentVersion)}</code>, ${esc(meta.date)}, transcription checksum ` +
          `<code>${esc(meta.source_sha256.slice(0, 16))}…</code>.</p>`) +
      `<p><b>Cite it.</b> <code>${linkDoi(esc(t.citation))}</code></p>`
    );
  }).join('');

  return {
    title: `The editions — ${SITE.host}`,
    shareTitle: 'The editions',
    type: 'website',
    description:
      'The editorial policy of the library: what an edition is here, what a repair may rest on, the four repair types, the versioning promise, and each served edition’s provenance.',
    eyebrow: 'Editorial policy',
    heading: 'The editions',
    standfirst: 'What an edition is here, and what was done to it.',
    body:
      `<section><div class="wrap"><h2>Policy and standards</h2>` +
      `<div class="hint">how these texts are made, and what a repair may rest on</div>` +
      `<div class="prose">${policy}${notHere}</div></div></section>` +
      `<section><div class="wrap"><h2>Provenance, edition by edition</h2>` +
      `<div class="hint">${served.length} served edition${served.length === 1 ? '' : 's'}, with the source and the state</div>` +
      `<div class="prose">${blocks}</div></div></section>`,
    navCurrent: '/editions/',
  };
}

/* ---------- /about ---------- */

/** What this is, the licence, how to cite, and the ONE-LINE relation to the blog
 * (model §2 `blog.relation`), with the one outbound link to the blog's about
 * (extraction plan §3). */
export function buildAboutPage(served) {
  const example = served.length ? served[0].citation : '';
  const body =
    `<section><div class="wrap"><h2>What this is</h2>` +
    `<div class="hint">a public-domain library, and one reader’s readings</div>` +
    `<div class="prose">` +
    `<p><b>${esc(SITE.name)}</b> is a small, self-contained library of the works of the Platonic ` +
    `tradition, in public-domain editions. Each text is a transcription of a ` +
    `printed book — the scanner’s own characters, kept — with the editorial work recorded rather than hidden: ` +
    `the repairs that were made, why, and where none could be, the damage left visible. You can read the ` +
    `repaired text and the raw transcription against each other, and the difference between them is the ` +
    `repair list.</p>` +
    `<p>It is a STATIC site. Every page is a file; there is no database, no account, no tracker, and nothing ` +
    `is sent anywhere. The search runs in your browser over an index served as a file. The transcriptions, the ` +
    `repair logs and the graph are exportable as plain data.</p>` +
    `</div></div></section>` +
    `<section><div class="wrap"><h2>Licence</h2>` +
    `<div class="hint">two licences: the texts, and the work around them</div>` +
    `<div class="prose">` +
    `<p><b>The transcriptions are public domain.</b> Every text here is a transcription of a printed edition ` +
    `published before 1929; the print is out of copyright and so is the transcription.</p>` +
    `<p><b>The editorial layer is CC BY 4.0.</b> ${esc(SITE.licence.statement)} The editorial layer is ` +
    `the repairs and their rationales, the page models and anchor manifests, the apparatus and notes, the ` +
    `graph, and the site’s own prose — released under ` +
    `<a href="https://creativecommons.org/licenses/by/4.0/" rel="license noreferrer">Creative Commons ` +
    `Attribution 4.0 International</a>. You may share and adapt it for any purpose, including commercially, ` +
    `provided you give credit, link the licence, and say what you changed. Credit ` +
    `“${esc(SITE.name)} (${esc(SITE.host)})” with a link to the page the material came from.</p>` +
    `</div></div></section>` +
    `<section><div class="wrap"><h2>How to cite</h2>` +
    `<div class="hint">the edition, the version, and the URL</div>` +
    `<div class="prose">` +
    `<p>${esc(SITE.citation_policy)}</p>` +
    (example ? `<p>The form, for the editions served here:</p><p><code>${linkDoi(esc(example))}</code></p>` : '') +
    `<p>Each edition page carries its own citation string, and a pinned version’s page carries that ` +
    `version’s — so a citation to a particular version keeps naming that version. Every published ` +
    `edition’s record and the graph are also served as plain data, at <a href="/data/corpus.json">the ` +
    `data export</a> and <a href="/data/graph.json">the graph</a>.</p>` +
    `</div></div></section>`;
  return {
    title: `About — ${SITE.host}`,
    shareTitle: 'About',
    type: 'website',
    description:
      'What the library is, its two licences (public-domain texts, CC BY 4.0 editorial layer), and how to cite an edition.',
    eyebrow: 'The library',
    heading: 'About',
    standfirst: 'The texts stand on their own; the essays are one reader’s reading.',
    body,
    navCurrent: '/about/',
  };
}

/* ---------- /errata ---------- */

/** The heading each /errata block names an edition with. */
const editionHeading = (t) =>
  `<h3 id="errata-${esc(t.slug)}">${esc(t.title)} — ${esc(t.author)}` +
  (t.translator ? `, tr. ${esc(t.translator)}` : '') +
  `</h3>`;

/** The leaf a rule records, or the honest statement that it rests on none
 * (model §0.4: an empty state is stated, never omitted). */
function evidenceNote(r) {
  const evs = Array.isArray(r.evidence) ? r.evidence : [];
  if (!evs.length) return 'no page image is held for this reading';
  return (
    'read from ' +
    evs
      .map(
        (e) =>
          `archive leaf n${e.leaf}` +
          (e.page != null ? ` · printed page ${e.page}` : '') +
          (e.exists ? '' : ' (not held)'),
      )
      .join('; ')
  );
}

/** THE DURABLE CORRECTIONS LOG (DESIGN-SYSTEM.md §5, DATA-MODEL §7). An
 * edition's OWN repair log lives on the edition's page, first-class and complete
 * — every rule, in the version. This is the standing record of the two places an
 * erratum is most likely: a reading the library SUPPLIED where no witness
 * settled the place (a rule typed `conjectural`, model §4.1), and a page image a
 * reading rested on that is NOT held with the edition (`evidence[].exists:false`,
 * model §4.4). It is NOT a review worklist: every rule's type is settled, and the
 * way to a correction is a new rule in a new version (the report paragraph
 * below), never a silent edit. The scans themselves live in the edition's
 * apparatus, which is where this page points. */
export function buildErrataPage(served) {
  /* 1. READINGS SUPPLIED WITHOUT A WITNESS — per edition, the rules typed
   * `conjectural`: the places an erratum is most likely, listed in full with the
   * words, the reason, and the page image if one is held. */
  const supplied = served.map((t) => {
    const rules = repairsOf(t).rules.filter((r) => r.type === 'conjectural');
    const safe = (s) => gateSafeText(esc(s), t.slug);
    const rows = rules
      .map(
        (r) =>
          `<li id="erratum-${esc(r.id.split(':')[1])}">` +
          `<code>${esc(r.id)}</code> · <b>${esc(r.type)}</b> · <span class="dim">${esc(r.apply)}</span><br>` +
          `“${safe(r.before)}” → “${safe(r.after)}”<br>` +
          `<span class="dim">${safe(r.rationale)}</span><br>` +
          `<span class="dim">${r.witness ? `witness: ${safe(r.witness)}` : 'no witness'} · ` +
          `${safe(evidenceNote(r))}</span></li>`,
      )
      .join('');
    const total = repairsOf(t).rules.length;
    return (
      editionHeading(t) +
      (rules.length
        ? `<ol class="errata">${rows}</ol>`
        : total
          ? `<p>None. Every rule in this version is typed <code>OCR</code>, <code>punctuation</code> or ` +
            `<code>transliteration</code> — no reading here was supplied without a witness.</p>`
          /* NO RULES IS NOT "EVERY RULE IS FINE" — it is no rule at all. Saying
           * "every rule is typed…" of an empty list would read as a clean bill of
           * health for a text whose repair has not begun. */
          : `<p>None yet. This edition carries no recorded repairs, so there is no reading here that was ` +
            `supplied without a witness: the list fills as emendations are made.</p>`)
    );
  }).join('');

  /* 2. LEAVES CITED BUT NOT HELD — per edition, every evidence entry the store
   * does not hold: the page image a reading rested on, named so a reader who can
   * supply one knows which. */
  const unheld = served.map((t) => {
    const rows = [];
    for (const r of repairsOf(t).rules) {
      for (const e of Array.isArray(r.evidence) ? r.evidence : []) {
        if (e.exists) continue;
        const id = r.id.split(':')[1];
        const cap = `archive leaf n${e.leaf}${e.page != null ? ` · printed page ${e.page}` : ''}`;
        rows.push(
          `<li><code>${esc(e.file || `n${e.leaf}`)}</code> — ${esc(cap)} — cited by ` +
            `<a href="/texts/${esc(t.slug)}/apparatus/#repair-${esc(id)}"><code>${esc(id)}</code></a>. ` +
            `The page image is cited here, but the leaf is not stored with the edition.</li>`,
        );
      }
    }
    const n = repairsOf(t).rules.length;
    return (
      editionHeading(t) +
      (rows.length
        ? `<ol class="errata">${rows.join('')}</ol>`
        : n
          ? `<p>None. Every page image this edition’s rules cite is held with the edition.</p>`
          : `<p>None yet. This edition records no repairs, so it cites no page image; the ${scanLeafCount(t.slug)} ` +
            `leaves of its own scan are stored with it and served, one image per leaf, at ` +
            `<a href="/texts/${esc(t.slug)}/scans/">/texts/${esc(t.slug)}/scans/</a>.</p>`)
    );
  }).join('');

  /* 3. THE PER-EDITION SUMMARY — the version and its counts, and the way to the
   * whole record: the edition's APPARATUS, which renders EVERY rule and, for each
   * image-based reading, the leaf it was decided from. The scans live there. */
  const summaries = served.map((t) => {
    const rep = repairsOf(t);
    const base = `/texts/${esc(t.slug)}/`;
    const n = rep.rules.length;
    const withScan = rep.rules.filter((r) => Array.isArray(r.evidence) && r.evidence.some((e) => e.exists)).length;
    const leaves = scanLeafCount(t.slug);
    const state = repairOf(t);
    return (
      editionHeading(t) +
      `<p><b>The version served here.</b> <code>${esc(t.currentVersion)}</code> — ` +
      (n
        ? `${n} repair rule${n === 1 ? '' : 's'} in the version, ${withScan} of ${withScan === 1 ? 'which' : 'them'} ` +
          `read off a page image`
        : `NO recorded repair: the transcription is served exactly as it stands and no emendation has been made`) +
      (leaves ? `; ${leaves} leaf image${leaves === 1 ? '' : 's'} ${leaves === 1 ? 'is' : 'are'} stored with the edition` : '') +
      `. <span class="tag">${esc(REPAIR_LABELS[state.state] || state.state)}</span> — ` +
      `${gateSafeText(esc(state.note), t.slug)}</p>` +
      (n
        ? `<p><b>The whole record, and the page images.</b> Every one of the ${n} rule${n === 1 ? '' : 's'} is in ` +
          `the edition’s <a href="${base}apparatus/">apparatus</a> at ` +
          `<a href="${base}apparatus/">${base}apparatus/</a>, a page of its own, browsable ` +
          `BOTH ways: the edition’s whole scan forms an index in leaf order, and selecting any leaf opens its ` +
          `page image together with the ` +
          `readings decided from it — each with its id, its type, the words it changes, its reason and the witness ` +
          `it rested on, anchored at <code>#repair-&lt;id&gt;</code> so a single reading can be cited — while the ` +
          `readings that carry no page image (${n - withScan} of ${n} here) are listed in their own right, and a ` +
          `list of all ${n} readings is paged 25 at a time for a reader who has no leaf in mind. The whole log is ` +
          `served with the edition as data at <a href="${base}apparatus.json">${base}apparatus.json</a>, so it can be ` +
          `read, filtered and searched without the page. <b>That is where the scans are:</b> the page images are stored ` +
          `with the edition and served beside its text, one image per leaf, at <a href="${base}scans/">${base}scans/</a>` +
          `${leaves ? ` — its whole scan, ${leaves} leaf image${leaves === 1 ? '' : 's'} for this edition` : ''}.</p>`
        : `<p><b>The record so far, and the page images.</b> The repair log is empty at this version, so there ` +
          `is nothing yet to list here; the <a href="${base}apparatus/">apparatus</a> at ` +
          `<a href="${base}apparatus/">${base}apparatus/</a> opens on ` +
          (leaves
            ? `the edition’s WHOLE SCAN in leaf order — ${leaves} leaf image${leaves === 1 ? '' : 's'}, every one ` +
              `openable — and states at each leaf that no reading has been recorded from it yet`
            : `the statement that no repair has been recorded yet and no page image is stored`) +
          `. The log is served with the edition as data at ` +
          `<a href="${base}apparatus.json">${base}apparatus.json</a>, empty of rules at this version, and each ` +
          `emendation will be written into it as it is made.</p>`)
    );
  }).join('');

  const intro =
    `<p><b>What this page is.</b> A standing record of the two places an error is most likely: a reading the ` +
    `library supplied where no witness settled the place, and a page image a reading rested on that is not held ` +
    `with the edition. It is not a worklist. Every rule served here has been read and classified — ` +
    `<code>OCR</code>, <code>punctuation</code>, <code>transliteration</code> or <code>conjectural</code> — and ` +
    `that review is COMPLETE: no rule on this site is flagged for one, and the counts below are the counts of the ` +
    `record itself. An edition whose repair has not begun records no rules yet, and its own block below says so ` +
    `rather than reading as a clean bill of health.</p>` +
    `<p><b>A correction is a new rule.</b> Where a place is wrong the library does not edit the served text in ` +
    `silence: the report becomes a NEW RULE in a NEW VERSION, the old version stands at its own address, and the ` +
    `change is citable (see the <a href="/editions/">versioning promise</a>). The rules are not reworded to fit ` +
    `the software, and nothing is dropped to keep a count tidy.</p>`;

  const contact = (SITE.contact && SITE.contact.errata) || '';
  const report =
    `<p><b>How to report an error.</b> This is a static site: there is no form and no server to ` +
    `receive one, so a report is an email. ` +
    (contact
      ? `Write to <a href="mailto:${esc(contact)}">${esc(contact)}</a>, naming`
      : `The library records no address for reports yet, so this page names none rather than invent one; ` +
        `when the record carries one it will be printed here. What a report carries is the same either ` +
        `way — name`) +
    ` the edition, the repair id above or the section and printed page, and what the print or the page ` +
    `image shows instead. A correction that names a witness is the kind this library is built from — the ` +
    `transcription’s own context, a parallel edition, or the page image — and a report that names one is ` +
    `acted on as a new rule in a new version, never as a silent edit to the served text.</p>`;

  return {
    title: `Errata — ${SITE.host}`,
    shareTitle: 'Errata',
    type: 'website',
    description:
      'The corrections log: the readings a served edition supplied without a witness, the page images its rules cite but do not hold, and how to report an error.',
    eyebrow: 'The library',
    heading: 'Errata',
    standfirst: 'What was asserted where the print left it open, and how to correct it.',
    body:
      `<section><div class="wrap"><h2>The corrections log</h2>` +
      `<div class="hint">what is recorded here, and how a correction is made</div>` +
      `<div class="prose">${intro}</div></div></section>` +
      `<section><div class="wrap"><h2>Readings supplied without a witness</h2>` +
      `<div class="hint">a reading the library supplied where no witness settled the place — an erratum is most likely here</div>` +
      `<div class="prose">${supplied}</div></div></section>` +
      `<section><div class="wrap"><h2>Leaves cited but not held</h2>` +
      `<div class="hint">the page image a reading rested on that is not stored with the edition</div>` +
      `<div class="prose">${unheld}</div></div></section>` +
      `<section><div class="wrap"><h2>The editions, and where their apparatus is</h2>` +
      `<div class="hint">the whole rule record, the page images, and the count read off them</div>` +
      `<div class="prose">${summaries}</div></div></section>` +
      `<section><div class="wrap"><h2>How to report an error</h2>` +
      `<div class="hint">one email, no form and no server</div>` +
      `<div class="prose">${report}</div></div></section>`,
    navCurrent: '/errata/',
  };
}

/* ---------- the 404 ---------- */

/** The not-found page. Served with a real 404 status by the web server; the build
 * only produces the document. noindex: it has no URL of its own to advertise, and
 * the links it carries are the site's own routes. */
export function buildNotFoundPage() {
  const body =
    `<section><div class="wrap"><h2>Nothing here</h2>` +
    `<div class="hint">every address this site serves, and nothing else</div>` +
    `<div class="prose">` +
    `<p>Every address on this site is one of the pages below. There is no other content, and nothing was ` +
    `removed to hide it.</p>` +
    `<ul>` +
    `<li><a href="/">Home — the texts, and where to start</a></li>` +
    `<li><a href="/texts/">The texts — every published edition, ordered by author</a></li>` +
    `<li><a href="/graph/">The graph — the texts and the relations recorded between them</a></li>` +
    `<li><a href="/search/">The search — every passage, by words, patterns and phrases</a></li>` +
    `<li><a href="/editions/">The editions — policy, standards and provenance</a></li>` +
    `<li><a href="/about/">About — what this is, the licence, how to cite</a></li>` +
    `<li><a href="/errata/">Errata — what was asserted, and how to report an error</a></li>` +
    `</ul>` +
    `<p>If you followed a link from somewhere else, the link is stale.</p>` +
    `</div></div></section>`;
  return {
    title: `Not found — ${SITE.host}`,
    shareTitle: 'Not found',
    type: 'website',
    noindex: true,
    description: 'No page at this address. The published pages are listed here.',
    eyebrow: 'The library',
    heading: '404 — no such page',
    standfirst: 'The path you asked for is not one of the pages.',
    body,
    navCurrent: '/404.html',
  };
}
