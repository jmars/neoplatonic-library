#!/usr/bin/env node
/**
 * tools/repair-id-probe.mjs — the repair ids and the four types
 * (extraction plan §6.5, model §4.1/§4.2).
 *
 * WHAT IT ASSERTS, per edition, over the CANONICAL record
 * (`data/editions/<slug>/versions/<semver>/repairs.json`) for EVERY version:
 *
 *  1. every id matches `<slug>:r<NNNN>` and the ids ASCEND in rule order — no
 *     renumbering, no reuse (model §4.2: ids are forever). The sequence runs from
 *     the file's own `id_floor` + 1 — `r0001…` for a first base, and `r8566…`
 *     where a re-sourced base retired the rules that had spent r0001–r8565
 *     (MEASURED, this edition: the retired list ran to r8565);
 *  1a. AND THE SEQUENCE HAS NO GAP, except the ids this repo RECORDS as
 *     withdrawn. MEASURED 2026-10-06: five Greek readings of the Theology of Plato
 *     were withdrawn after an echo check found that no second instrument that
 *     does not echo the transcription agreed with them (2 instruments agreed on
 *     the other readings and those stand), so r11680/r11681/r11683/r11684/r11686
 *     are SPENT, not freed — ids are forever, so the gap is the record of the
 *     withdrawal and is asserted to be exactly those five, nowhere else and never
 *     more. A SIXTH went the same way in the re-run with the two readers that do
 *     NOT echo (google/gemini-2.5-flash and anthropic/claude-haiku-4-5): r11682
 *     ("vofffwy, it is necessary to read vo^tov") had been kept as resting on one
 *     instrument because no second reader had read the passage at all; the re-run
 *     DID get readings of that line and they were five different ones, two of them
 *     settled (gemini νοεῖσθαι/νοητῶν and νόησις/νόητον on two different
 *     leaves, claude νοητοῦ/νοητον, νοσφῶν/νοστόν, νοήσεως/νοήτον), none of them
 *     the rule's νοῦς/νοῦτον, so the reading was withdrawn and the served text
 *     reverts to the transcription's own characters. Any other edition must still
 *     be gap-free;
 *  2. no id is reused ACROSS versions of the same edition (a new version appends;
 *     it never reuses or reorders old ids): every id a version SHARES with an
 *     earlier one must carry the SAME rule record, and the version may only ADD
 *     ids — asserted directly in 2b below: every id an earlier version holds is
 *     still present in each later one, except the ids that version's own record
 *     withdraws (a tail DROP is the failure shape this closes; MEASURED
 *     2026-10-07: without 2b, a version holding exactly 1.0.0's 3051 rules alone
 *     passed every check here). MEASURED 2026-10-06: this check read
 *     `seen.get(id) !== v` ("the id was first seen in another version"), which is
 *     what APPENDING means — it failed on the first edition that ever had two
 *     versions and could only pass on a rule list disjoint from the older one's;
 *  3. `before` !== `after` for every rule that supplies a reading, and every
 *     `type` is one of the four (model §4.1);
 *  4. the rule COUNT is the count in the pipeline's own provenance file
 *     (`tools/edits/<slug>.json`) — the migration is asserted to have lost
 *     nothing, and the check fails on ANY drift (415 / 384);
 *  5. the served document's `corrections` array is that record's rules derived
 *     by model §4.0, in the same order — the shape change cannot leak.
 *
 *     node build/build.mjs && node tools/repair-id-probe.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairsPath, versionDir, extract, loadEdits, sha256, readEdition } from '../tools/extract.mjs';
import { TEXTS, isPublished } from '../tools/shelf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'site', 'dist');
const TYPES = ['OCR', 'punctuation', 'transliteration', 'conjectural'];
/* THE IDS THIS REPO HAS RECORDED AS WITHDRAWN — spent, never reused (model §4.2),
 * so the gap in the sequence IS the record. Named here rather than derived so the
 * gate states the withdrawal instead of accepting any gap:
 * MEASURED 2026-10-06, the echo check (tools/echo-probe.mjs) found that no second
 * vision instrument which does not return the transcription verbatim agreed with
 * these five Greek readings; the other four the check examined stand. MEASURED
 * again in the re-run with the two readers that do not echo
 * (tools/greek-runs.mjs, LIBRARY_GREEK_MODELS=google/gemini-2.5-flash,
 * anthropic/claude-haiku-4-5): r11682 is the sixth — the readers DID read that
 * line, five different readings, none of them the rule's.
 *
 * KEYED BY VERSION, because a gap is the record of the state that SPENT the id, and
 * only that state. MEASURED 2026-10-06: these six were all allocated and withdrawn
 * AFTER the deposit of 1.0.0, whose rule list ends at r11616 with no gap at all —
 * so v1.0.0 is expected gap-free and v1.0.1 is expected to carry exactly these six.
 * Holding every version to the same gap set would fail the frozen state for a
 * withdrawal that happened later and never touched it; it is the same expectation,
 * stated per state. A version with an unrecorded gap still fails. */
const WITHDRAWN = new Map([
  ['proclus-theology-of-plato-taylor-1816@1.0.0', []],
  ['proclus-theology-of-plato-taylor-1816@1.0.1', [11680, 11681, 11682, 11683, 11684, 11686]],
  /* 1.0.2 carries 1.0.1's rules UNCHANGED (the bump moves the section model,
   * not the text), so its rule list carries the same six spent ids as gaps —
   * the withdrawal record travels with the rules it was spent against. */
  ['proclus-theology-of-plato-taylor-1816@1.0.2', [11680, 11681, 11682, 11683, 11684, 11686]],
]);

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};
const section = (name) => console.log(`\n${name}`);

const served = TEXTS.filter(isPublished);

for (const t of served) {
  const slug = t.slug;
  section(`${slug}`);
  const versions = readdirSync(join(versionDir(slug, '1.0.0'), '..'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const seen = new Map(); // id -> { version, rule } (the FIRST version that allocated it)
  const perVersion = new Map();

  for (const v of versions) {
    const file = JSON.parse(readFileSync(repairsPath(slug, v), 'utf8'));
    const rules = file.rules;
    perVersion.set(v, rules.length);
    check(file.slug === slug && file.version === v, `v${v}: the file names ${file.slug} v${file.version}`);

    /* 1. the id grammar and the sequence, from the version's own floor. */
    const floor = Number(file.id_floor || 0) || 0;
    const nums = rules.map((r) => Number((/:r(\d+)$/.exec(r.id) || [])[1]));
    const grammar = rules.filter((r) => !/^[^:]+:r\d{4,}$/.test(r.id));
    const ascending = nums.every((n, i) => Number.isInteger(n) && (i === 0 || n > nums[i - 1]));
    const badFloor =
      file.id_floor != null && (!Number.isInteger(file.id_floor) || file.id_floor < 0)
        ? ` (the file states id_floor ${JSON.stringify(file.id_floor)} — not a non-negative integer)`
        : '';
    const gaps = [];
    if (nums.length) {
      const present = new Set(nums);
      for (let n = floor + 1; n <= nums[nums.length - 1]; n++) if (!present.has(n)) gaps.push(n);
    }
    const expected = WITHDRAWN.get(`${slug}@${v}`) || [];
    check(
      grammar.length === 0 && ascending && gaps.join(',') === expected.join(',') && !badFloor,
      `v${v}: every id is ${slug}:rNNNN and they ASCEND in rule order, gap-free except the ${expected.length} id(s) this repo records as withdrawn` +
        (expected.length ? ` (${expected.map((n) => `r${n}`).join(', ')})` : '') +
        ` — first id ${rules.length ? rules[0].id : '—'}, last ${rules.length ? rules[rules.length - 1].id : '—'}, gaps [${gaps.join(', ')}]` +
        (badFloor || (!ascending ? ' — the ids do not ascend' : '') || (grammar.length ? ` — bad id: ${grammar[0].id}` : '')),
    );
    check(
      new Set(rules.map((r) => r.id)).size === rules.length,
      `v${v}: every id is unique within the version (${rules.length})`,
    );

    /* 2. no id is REUSED across versions, and no id is silently REWRITTEN. Model
     * §4.2: ids are forever, and a new version APPENDS — it never reuses or
     * reorders an old id, and the older version's own directory is untouched. So
     * for every id this version shares with an earlier one the rule must be THE
     * SAME RECORD: an id kept with its reading changed under it is the silent
     * rewrite the rule forbids. MEASURED 2026-10-06: before this, the check tested
     * `seen.get(id) !== v` — "the id was first seen in another version" — which is
     * what APPENDING means, so it FAILED on the Theology of Plato's 1.0.1 (3271
     * rules, 3051 of them 1.0.0's own) and could only have passed on a version whose
     * rule list is DISJOINT from the older one's, which is not a version of this
     * edition. It was green because every edition had exactly ONE version. The
     * check below is the same property stated as the data can satisfy it, and it is
     * STRONGER: it compares the rules, not only their ids. */
    const rewritten = rules.filter((r) => seen.has(r.id) && JSON.stringify(seen.get(r.id).rule) !== JSON.stringify(r));
    const appended = rules.filter((r) => !seen.has(r.id)).length;
    check(
      rewritten.length === 0,
      `v${v}: every id it shares with an earlier version is the SAME rule — ${appended} id(s) appended, ${rules.length - appended} carried unchanged` +
        (rewritten.length ? `; id(s) rewritten: ${rewritten.map((r) => r.id).slice(0, 5).join(', ')}` : ''),
    );
    /* 2b. AND THE VERSION MAY ONLY ADD IDS: every id an EARLIER version holds
     * must still be present here, except the ids THIS version's own record
     * withdraws (WITHDRAWN above, keyed by version — the gap is the record of
     * the state that spent the id). MEASURED 2026-10-07: the check above looks
     * only at the ids the later version PRESENTS, so a version holding exactly
     * 1.0.0's 3051 rules — a tail drop, the very shape of the original
     * incident — passed every check: a tail drop makes no gap in the sequence,
     * rewrites nothing among the ids it still holds, and the provenance count
     * pins only versions[0]. The subset test below is what closes that shape:
     * it fails naming the ids that vanished. */
    if (seen.size) {
      const spent = new Set(WITHDRAWN.get(`${slug}@${v}`) || []);
      const have = new Set(rules.map((r) => r.id));
      const dropped = [...seen.keys()].filter((id) => {
        if (have.has(id)) return false;
        const n = Number((/:r(\d+)$/.exec(id) || [])[1]);
        return !spent.has(n);
      });
      check(
        dropped.length === 0,
        `v${v}: every id an earlier version holds is still here (a version may only ADD ids) — ${rules.length} rule(s), ${appended} appended, ${rules.length - appended} carried` +
          (dropped.length ? `; id(s) DROPPED: ${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? ` … (${dropped.length} in all)` : ''}` : ''),
      );
    }
    for (const r of rules) if (!seen.has(r.id)) seen.set(r.id, { version: v, rule: r });

    /* 3. the four types, before/after. */
    const badType = rules.filter((r) => !TYPES.includes(r.type));
    check(badType.length === 0, `v${v}: every type is one of ${TYPES.join(' / ')} (${[...new Set(rules.map((r) => r.type))].join(', ')})`);
    const same = rules.filter((r) => r.apply !== 'review' && r.before === r.after);
    check(same.length === 0, `v${v}: no rule's before equals its after${same.length ? `: ${same.map((r) => r.id).join(', ')}` : ''}`);
    const noLoc = rules.filter((r) => !r.location || typeof r.location.find !== 'string' || r.location.find === '');
    check(noLoc.length === 0, `v${v}: every rule carries location.find`);
    const flags = rules.filter((r) => typeof r.review !== 'boolean' || typeof r.type_evidence !== 'string' || r.type_evidence === '');
    check(flags.length === 0, `v${v}: every rule states review and the type_evidence it rested on`);

    /* 5. the served document carries the same rules, derived (model §4.0). */
    if (existsSync(join(DIST, 'texts', slug, 'v', v, 't'))) {
      const doc = JSON.parse(readFileSync(join(DIST, 'texts', slug, 'v', v, 't'), 'utf8'));
      const derived = doc.corrections.every(
        (c, i) =>
          c.find === rules[i].location.find &&
          c.repl === (rules[i].apply === 'review' ? rules[i].location.find : rules[i].after) &&
          c.cls === rules[i].apply &&
          c.note === rules[i].rationale,
      );
      check(
        doc.corrections.length === rules.length && derived,
        `v${v}: the served document's ${doc.corrections.length} correction(s) are this record's rules, derived and in order`,
      );
      /* And the corpus/dedup path: the document is what `extract` produces now,
       * not a stale artifact. */
      const src = readEdition(slug, v);
      const fresh = extract(src, { entry: t, sha256: sha256(src), version: v });
      check(
        JSON.stringify(fresh.corrections) === JSON.stringify(doc.corrections),
        `v${v}: the served document is what a fresh extraction produces (no stale artifact)`,
      );
    }
  }

  /* 4. the count against the pipeline's provenance file. */
  const provenance = join(ROOT, 'tools', 'edits', `${slug}.json`);
  if (existsSync(provenance)) {
    const pipe = JSON.parse(readFileSync(provenance, 'utf8'));
    const v1 = versions[0];
    check(
      pipe.edits.length === perVersion.get(v1),
      `v${v1}: the rule count is the pipeline file's (${perVersion.get(v1)} = ${pipe.edits.length}) — the migration lost nothing`,
    );
  } else {
    console.log(`  NOTE no provenance file for ${slug} — the count cross-check is skipped`);
  }
}

console.log(failures === 0 ? '\nrepair-id-probe: all checks passed' : `\nrepair-id-probe: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
