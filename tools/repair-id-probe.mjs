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
 *     it never reuses or reorders old ids);
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
 * line, five different readings, none of them the rule's. */
const WITHDRAWN = new Map([
  ['proclus-theology-of-plato-taylor-1816', [11680, 11681, 11682, 11683, 11684, 11686]],
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
  const seen = new Map(); // id -> version
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
    const expected = WITHDRAWN.get(slug) || [];
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

    /* 2. no reuse ACROSS versions. */
    const reused = rules.filter((r) => seen.has(r.id) && seen.get(r.id) !== v);
    check(reused.length === 0, `v${v}: no id is reused from another version${reused.length ? `: ${reused.map((r) => r.id).slice(0, 5).join(', ')}` : ''}`);
    for (const r of rules) if (!seen.has(r.id)) seen.set(r.id, v);

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
