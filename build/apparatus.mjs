/**
 * build/apparatus.mjs — the apparatus as DATA.
 *
 * The edition page used to INLINE the version's whole repair log: 415 rules of
 * markup on proclus (324,245 bytes of a 982,701-byte page), in which the page
 * image a reading was decided from was a small thumbnail buried among 310 rules
 * that carry no image at all. The unit of provenance is the PAGE IMAGE, so the
 * apparatus is emitted as a fetched data file — `/texts/<slug>/apparatus.json`,
 * the same shape of route as `/t` and `/search/index` — and the page carries a
 * viewer that navigates it BY LEAF.
 *
 * This module is the one place the file's shape is decided (DATA-MODEL §7). It
 * reads the CANONICAL record (`versions/<semver>/repairs.json`, model §4.3) and
 * the stored leaves, and derives what the record does not state:
 *
 *   leaves[].readings  how many rules were decided from that leaf;
 *   leaves[].page      the printed page the record stamps for it — NULL when the
 *                      record stamps none or two DIFFERENT ones, because a
 *                      caption may not pick one of two recorded pages (MEASURED:
 *                      proclus leaf n865 is stamped page 360 by r0041 and none
 *                      by r0045);
 *   rules[].evidence   the leaf, the page, the served url and whether the leaf
 *                      is held — carried whole, so a viewer never has to guess
 *                      and a reader can read the file without the page;
 *   rules[].review     the rule AWAITS HUMAN REVIEW (model §4.1) — true where the
 *                      type rested on judgment AND true where the READING rests on
 *                      ONE instrument (a Greek reading one reader gave and no
 *                      second reader corroborates);
 *   rules[].instruments  the readers whose OWN draws carry the reading, when the
 *                      pass that settled it recorded them: ONE entry is why the
 *                      rule is flagged, and the viewer marks it on that fact rather
 *                      than on prose. [] for every rule no such pass read.
 *
 * NO TIMESTAMP: the file is a pure function of the record, so a rebuild that
 * changes nothing writes the same bytes.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repairsPath } from '../tools/extract.mjs';
import { ROOT } from './shell.mjs';

/** The four scholarly types (DATA-MODEL §4.1), in the order the policy names
 * them, so the counts and the viewer's filter read the same order. */
export const APPARATUS_TYPES = ['OCR', 'punctuation', 'transliteration', 'conjectural'];

/** A STORED LEAF'S FILE NAME, and the leaf number it carries. A leaf file is
 * `nNNN.jpg`, or `v<N>-nNNN.jpg` for an edition whose scan comes from more than
 * one archive item: Taylor's 1816 Theology of Plato is cut from TWO volumes and
 * so from two items, whose leaf numbers run over each other (both serve an
 * `n74`), so the stored name carries its volume's prefix. The prefix belongs to
 * the FILE NAME — and therefore to the evidence `file`/`url` — not to the leaf
 * number: `n` stays the leaf's own number in its own item. */
export const LEAF_FILE = /^(?:v\d+-)?n(\d+)\.jpg$/;

/** The leaves stored WITH THE EDITION — its WHOLE scan, held in
 * `data/editions/<slug>/scans/` and served at `/texts/<slug>/scans/<file>`,
 * not only the leaves a reading used. Read from the directory: the list of
 * stored leaves is a fact about the tree, never a number typed into the data.
 * Each entry is `{ n, file }` — the number and the stored name, so the address
 * the page serves is always a name that is really on disk. */
export function storedLeaves(slug) {
  const dir = join(ROOT, 'data', 'editions', slug, 'scans');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => {
      const m = LEAF_FILE.exec(f);
      return m ? { n: Number(m[1]), file: f } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** The version's repair log, as the record holds it. */
function rulesOf(slug, version) {
  return JSON.parse(readFileSync(repairsPath(slug, version), 'utf8')).rules;
}

/**
 * THE APPARATUS OF ONE VERSION, as the data file carries it.
 *
 * A rule carries what a reader needs to check it and nothing the page can derive:
 * its id (the anchor's own form, `rNNNN`), the full id it is cited by
 * (`<slug>:rNNNN`), the located text, the type, the pipeline class, before →
 * after, the rationale, the witness, the date, and its evidence entries.
 */
export function apparatusData(t, version) {
  const rules = rulesOf(t.slug, version);
  const stored = storedLeaves(t.slug);
  const held = new Set(stored.map((s) => s.n));

  const counts = {};
  for (const k of APPARATUS_TYPES) {
    const n = rules.filter((r) => r.type === k).length;
    if (n) counts[k] = n;
  }

  /* The readings decided from each leaf, and the printed page(s) the record
   * stamps for it. A reading is counted ONCE for a leaf however many of the
   * rule's evidence entries name it — a reading is a reading, and the count is
   * the reading's, not the entry's. A rule that cites two leaves belongs to both
   * (the viewer lists it under each), so the two counts are the same rule seen
   * from two pages. */
  /* A READING IS COUNTED AGAINST THE LEAF'S STORED NAME, not its number: an
   * edition cut from two volumes has two leaves numbered n74 (v1-n74 and
   * v2-n74), and keying by the number would merge them — each volume's readings
   * counted on the other's leaf. The evidence carries the file (model §4.4), so
   * the name is there to key on; an evidence entry with no file falls back to its
   * number, which is what every single-volume edition has always carried. */
  const leafKeyOf = (e) => (e.file ? String(e.file).replace(/\.jpg$/i, '') : String(e.leaf));
  /* A LEAF ENTRY IS AN ENTRY THAT NAMES A LEAF. Since 2026-10-07 a rule may also
   * carry a WITNESS entry (kind `witness`) — an outside transcription of the
   * print this reading was checked against, which has no leaf, no page and no
   * image. It is not a leaf: it is carried below under `witnessEvidence` and
   * excluded here, so a witness can move none of the leaf counts. */
  const leafEntry = (e) => e && e.leaf != null;
  const cited = new Map(); // leaf name -> { readings:Set(rule id), pages:Set }
  for (const r of rules) {
    for (const e of (Array.isArray(r.evidence) ? r.evidence : []).filter(leafEntry)) {
      const k = leafKeyOf(e);
      if (!cited.has(k)) cited.set(k, { readings: new Set(), pages: new Set() });
      const c = cited.get(k);
      c.readings.add(r.id);
      if (e.page != null) c.pages.add(e.page);
    }
  }

  return {
    slug: t.slug,
    version,
    ruleCount: rules.length,
    counts,
    leafCount: stored.length,
    leaves: stored.map((s) => {
      const c = cited.get(s.file.replace(/\.jpg$/i, ''));
      const pages = c ? [...c.pages] : [];
      return {
        n: s.n,
        url: `/texts/${t.slug}/scans/${s.file}`,
        page: pages.length === 1 ? pages[0] : null,
        readings: c ? c.readings.size : 0,
      };
    }),
    rules: rules.map((r) => ({
      id: r.id.split(':')[1],
      ref: r.id,
      find: r.location && r.location.find ? r.location.find : '',
      type: r.type,
      apply: r.apply,
      before: r.before,
      after: r.after,
      rationale: r.rationale,
      witness: r.witness || '',
      date: r.date || null,
      /* THE REVIEW FLAG, carried (model §4.1): a rule whose READING rests on one
       * instrument awaits human review however its type was fixed, and the apparatus
       * is where a reader meets it. `!!` because the record may omit the field — an
       * absent flag is not a review, and the file's shape must not depend on which
       * writer wrote the rule. The flag is NOT the class: the migrated rule-6 rules
       * carry it too (their TYPE fell to the conservative default), so a viewer that
       * marked every flagged rule "one instrument" would misname 2,092 of them —
       * `instruments` is the field that says WHICH footing, and the badge reads it. */
      review: !!r.review,
      instruments: Array.isArray(r.instruments) ? r.instruments.slice() : [],
      evidence: (Array.isArray(r.evidence) ? r.evidence : []).filter((e) => e.leaf != null).map((e) => ({
        leaf: e.leaf,
        page: e.page != null ? e.page : null,
        url: e.exists ? e.url : null,
        exists: !!e.exists,
      })),
      /* THE WITNESS A READING WAS CHECKED AGAINST, kept BESIDE the leaves rather
       * than among them: it has no leaf, no printed page and no image, so it is
       * not something the leaf viewer can open. It carries what the viewer needs
       * to SAY it — which witness, at what address, what it reads at the point,
       * and how the point was placed in it. */
      witnessEvidence: (Array.isArray(r.evidence) ? r.evidence : [])
        .filter((e) => e.leaf == null)
        .map((e) => ({
          kind: e.kind || null,
          witness: e.witness || null,
          volume: e.volume || null,
          url: e.url || null,
          reads: e.reads || null,
          placement: e.placement || null,
          why: e.why || null,
        })),
    })),
  };
}

/** The file's bytes: two-space JSON, a trailing newline, like every other
 * export the build writes. */
export function apparatusJson(t, version) {
  return `${JSON.stringify(apparatusData(t, version), null, 2)}\n`;
}
