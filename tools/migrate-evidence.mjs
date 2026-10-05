#!/usr/bin/env node
/**
 * tools/migrate-evidence.mjs — stamps each repair rule with the SCAN EVIDENCE it
 * was decided from (`rule.evidence[]`, DATA-MODEL §4).
 *
 *   node tools/migrate-evidence.mjs [--from /home/jaye/enlighten] [--write]
 *
 * WHY A RULE CARRIES ITS EVIDENCE. The library is citable now: a reader must be
 * able to see WHERE an editorial reading came from. A rule whose rationale cites
 * a page image is a reading taken off a leaf of the printed volume, and the leaf
 * (with the printed page it carries) is recorded here so the edition page can
 * show it and the leaf's own image can be resolved. The evidence is stored on the
 * RULE — not recomputed at build time — so a rule and its leaf cannot drift.
 *
 * THIS IS A MIGRATION, not part of the build. It is RE-RUNNABLE and idempotent:
 * it recomputes every rule's evidence array from the same sources and rewrites
 * only that array. It NEVER renumbers an id and NEVER changes `location.find`,
 * `after` or `type` — it asserts that on every rule it touches before writing
 * (a run that mutated one of them would be a defect, not a migration).
 *
 * WHERE THE EVIDENCE COMES FROM
 *
 *   proclus — the rule's own rationale. A leaf is cited as `archive nNNN` or
 *             `scan nNNN`, and (in the same clause) the printed page it carries:
 *             `printed page 368 = archive n873`, `printed page 422, scan n927`,
 *             or the worklist's rejected `page 306/n811`. Every `nNNN` token in
 *             the rationale is a cited leaf (a rejected attribution is still
 *             cited — the rationale says why — and is recorded with exists:false
 *             where the leaf is not held). The printed page is the page number
 *             that stands IMMEDIATELY before the leaf token; a leaf with no page
 *             clause beside it gets page:null rather than a guessed number.
 *
 *   porphyry — the blog's `tools/library/edits/<slug>.scan.json`. Its proposals
 *             carry `evidence: "scan page (archive.org page/nNN)"` and
 *             `decided_by: "scan"`, and each proposal is matched to the final
 *             rule by `find` (exact, else prefix — a proposal's find may have
 *             been shortened when it became a rule). The printed page, when the
 *             proposal's note states one, is carried too.
 *
 * THE STORED LEAVES DECIDE `exists`. `data/editions/<slug>/scans/` holds the
 * leaves this edition read (copied from the blog at migration — see the
 * edition's own provenance). A cited leaf that is not in that directory is
 * recorded with `exists:false` and `url:null`: honest, and not omitted.
 *
 * MEASURED (2026-10-04):
 *   proclus  — 415 rules, 105 citing a leaf, 60 distinct leaves, 58 held (n811,
 *              n864 not)
 *   porphyry — 384 rules, 4 citing a leaf, 4 distinct, 3 held (n33 not)
 *
 * MEASURED (2026-10-05), after the WHOLE SCAN was fetched (tools/fetch-scans.mjs
 * — proclus n806–n946, porphyry n0–n71): proclus 60 of 60 held, porphyry 4 of 4,
 * so the three entries that had been stamped `exists:false` against the partial
 * leaf set (n811, n864, n33) are stamped `true` with the served url, and no cited
 * leaf is unheld. That is the only change the re-run makes — `exists` and `url`,
 * on those three entries (diffed).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'data', 'editions');

const argv = process.argv.slice(2);
const fromFlag = argv.indexOf('--from');
const BLOG = fromFlag >= 0 ? argv[fromFlag + 1] : '/home/jaye/enlighten';
const WRITE = argv.includes('--write');

/** A leaf token: `nNNN` standing as its own token (not inside a word), which is
 * how every leaf is cited — `archive n873`, `scan n927`, `page 306/n811`. */
const LEAF = /(?<![0-9A-Za-z])n(\d{3})(?![0-9])/g;

/** The printed page standing IMMEDIATELY before a leaf token, or null. "Before"
 * means the page number's relation to the leaf is only a citation separator —
 * `= archive`, `, scan`, or a bare `/` — never an intervening clause. This is
 * what keeps a page named for a DIFFERENT leaf from being attached to this one
 * (MEASURED: `printed page 359 = archive n864 … "y" on the next page (n865's`
 * would otherwise give n865 the page 359, which is n864's). */
function pageBefore(rat, at) {
  const re = /page[s]?\s+(\d+)/gi;
  let page = null;
  let m;
  while ((m = re.exec(rat))) {
    if (m.index >= at) break;
    const tail = rat.slice(m.index + m[0].length, at);
    if (tail.length <= 30 && /^[\s,;:=()/]*(?:archive\s+|scan\s+)?\s*$/i.test(tail)) page = Number(m[1]);
  }
  return page;
}

/** The leaves a rationale cites, with their adjacent printed page (null where
 * none stands beside the leaf). Deduped per rule, preferring an entry that
 * carries a page. */
function leavesInRationale(rat) {
  const out = new Map();
  for (const m of rat.matchAll(LEAF)) {
    const leaf = Number(m[1]);
    const page = pageBefore(rat, m.index);
    const prev = out.get(leaf);
    if (prev === undefined || (prev === null && page !== null)) out.set(leaf, page);
  }
  return out;
}

/** The leaves `data/editions/<slug>/scans/` holds — the ones with a resolution
 * the site can serve. */
function heldLeaves(slug) {
  const dir = join(LIB, slug, 'scans');
  if (!existsSync(dir)) return new Set();
  const set = new Set();
  for (const f of readdirSync(dir)) {
    const m = /^n(\d+)\.jpg$/.exec(f);
    if (m) set.add(Number(m[1]));
  }
  return set;
}

function evidenceEntry(slug, leaf, page, held) {
  const exists = held.has(leaf);
  return {
    kind: 'scan',
    leaf,
    page: page === undefined ? null : page,
    file: `n${leaf}.jpg`,
    url: exists ? `/texts/${slug}/scans/n${leaf}.jpg` : null,
    exists,
    source: 'archive.org',
  };
}

/** The proposals of the blog's own scan pass for a slug, if the blog (or wherever
 * `--from` points) still holds them. This is the ONLY place this migration reads
 * the blog: the leaf numbers the blog's scan pass recorded. */
function proposalsFor(slug) {
  const file = join(BLOG, 'tools', 'library', 'edits', `${slug}.scan.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')).proposals || null;
  } catch {
    return null;
  }
}

/** Match a proposal to a rule by `find`: exact, then either-way prefix (a
 * proposal's find is sometimes the rule's find with a wider span, or the rule's
 * find is the head of the proposal's). Returns the rule index or -1. */
function matchProposal(rules, find) {
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].location && rules[i].location.find === find) return i;
  }
  for (let i = 0; i < rules.length; i++) {
    const rf = rules[i].location && rules[i].location.find;
    if (typeof rf === 'string' && rf && (find.startsWith(rf) || rf.startsWith(find))) return i;
  }
  return -1;
}

const pageOfText = (s) => {
  const m = /printed page[s]?\s+(\d+)/i.exec(s || '');
  return m ? Number(m[1]) : null;
};

let totalRules = 0;
let totalCited = 0;
const coverage = [];

for (const slug of readdirSync(LIB, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  const versionsDir = join(LIB, slug, 'versions');
  if (!existsSync(versionsDir)) continue;
  const held = heldLeaves(slug);
  const proposals = proposalsFor(slug);
  for (const version of readdirSync(versionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const file = join(versionsDir, version, 'repairs.json');
    if (!existsSync(file)) continue;
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const rules = doc.rules;
    if (!Array.isArray(rules)) continue;

    /* porphyry: a leaf per rule, from the proposals matched by find. */
    const byRule = new Map();
    if (proposals) {
      for (const p of proposals) {
        const em = /page\/n(\d+)/.exec(p.evidence || '');
        if (!em) continue;
        const leaf = Number(em[1]);
        const idx = matchProposal(rules, p.find);
        if (idx < 0) {
          console.log(`  NOTE ${slug}: a proposal citing leaf n${leaf} matched no rule (find ${JSON.stringify(p.find).slice(0, 60)})`);
          continue;
        }
        const page = pageOfText(p.note) ?? pageOfText(rules[idx].rationale);
        if (!byRule.has(idx)) byRule.set(idx, new Map());
        byRule.get(idx).set(leaf, page);
      }
    }

    let cited = 0;
    const distinct = new Set();
    const next = rules.map((r, i) => {
      /* The evidence for a rule: the proposals' leaves when the edition has a
       * scan pass, else (and also) the leaves its own rationale cites. */
      const found = byRule.get(i) ? new Map(byRule.get(i)) : new Map();
      for (const [leaf, page] of leavesInRationale(r.rationale || '')) {
        if (!found.has(leaf) || found.get(leaf) == null) found.set(leaf, page);
      }
      const evidence = [...found.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([leaf, page]) => evidenceEntry(slug, leaf, page, held));
      if (evidence.length) {
        cited++;
        for (const e of evidence) distinct.add(e.leaf);
      }
      /* NEVER renumber an id or change what a rule matches or to what: assert it
       * here, where the old and the new rule are both in hand. */
      const fresh = { ...r, evidence };
      if (fresh.id !== r.id || fresh.location.find !== r.location.find || fresh.after !== r.after || fresh.type !== r.type) {
        throw new Error(`${slug}:${r.id}: the migration would change an id/find/after/type — refusing`);
      }
      return fresh;
    });

    const out = { ...doc, rules: next };
    const text = `${JSON.stringify(out, null, 2)}\n`;
    const changed = text !== readFileSync(file, 'utf8');
    totalRules += rules.length;
    totalCited += cited;
    const missing = [...distinct].filter((l) => !held.has(l)).sort((a, b) => a - b);
    coverage.push({ slug, version, rules: rules.length, cited, leaves: distinct.size, missing });
    console.log(
      `${slug} v${version}: ${rules.length} rule(s), ${cited} citing a leaf, ${distinct.size} leaf/leaves` +
        `, ${[...distinct].filter((l) => held.has(l)).length} held` +
        (missing.length ? `, not held: ${missing.map((l) => `n${l}`).join(', ')}` : '') +
        (changed ? '  (CHANGED)' : ''),
    );
    if (changed && WRITE) writeFileSync(file, text);
  }
}

console.log(
  `migrate-evidence: ${totalRules} rule(s), ${totalCited} citing a leaf; ` +
    `${coverage.reduce((a, c) => a + c.missing.length, 0)} cited leaf/leaves not held` +
    (WRITE ? ' (written)' : ' — re-run with --write to stamp the evidence'),
);
