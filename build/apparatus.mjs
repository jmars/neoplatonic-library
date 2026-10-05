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
 *                      and a reader can read the file without the page.
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

/** The leaves stored WITH the edition — its WHOLE scan, held in
 * `data/editions/<slug>/scans/` and served at `/texts/<slug>/scans/nNNN.jpg`,
 * not only the leaves a reading used. Read from the directory: the list of
 * stored leaves is a fact about the tree, never a number typed into the data. */
export function storedLeaves(slug) {
  const dir = join(ROOT, 'data', 'editions', slug, 'scans');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^n\d+\.jpg$/.test(f))
    .map((f) => Number(f.slice(1, -4)))
    .sort((a, b) => a - b);
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
  const held = new Set(stored);

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
  const cited = new Map(); // leaf -> { readings:Set(rule id), pages:Set }
  for (const r of rules) {
    for (const e of Array.isArray(r.evidence) ? r.evidence : []) {
      if (!cited.has(e.leaf)) cited.set(e.leaf, { readings: new Set(), pages: new Set() });
      const c = cited.get(e.leaf);
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
    leaves: stored.map((n) => {
      const c = cited.get(n);
      const pages = c ? [...c.pages] : [];
      return {
        n,
        url: `/texts/${t.slug}/scans/n${n}.jpg`,
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
      evidence: (Array.isArray(r.evidence) ? r.evidence : []).map((e) => ({
        leaf: e.leaf,
        page: e.page != null ? e.page : null,
        url: e.exists ? e.url : null,
        exists: !!e.exists,
      })),
    })),
  };
}

/** The file's bytes: two-space JSON, a trailing newline, like every other
 * export the build writes. */
export function apparatusJson(t, version) {
  return `${JSON.stringify(apparatusData(t, version), null, 2)}\n`;
}
