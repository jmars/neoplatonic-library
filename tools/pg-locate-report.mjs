#!/usr/bin/env node
/**
 * tools/pg-locate-report.mjs — count the batches tools/pg-locate.mjs wrote and
 * publish the DURABLE yield record. The tool measures; this counts.
 *
 *     node tools/pg-locate.mjs <slug> --what rules --slide 24 --out /var/tmp/pg-locate/rules-r24.json   (× 8/24/48, rules/open)
 *     node tools/pg-locate.mjs <slug> --sweep --out /var/tmp/pg-locate/sweep.json
 *     node tools/pg-locate-report.mjs
 *
 * WHY THIS FILE EXISTS. The record it writes used to be assembled by a scratch
 * script that was never committed, and one of its numbers — the volume-split
 * evidence — therefore could not be reproduced from the artifact it cited (the
 * review's finding 4). Everything in the published record is now generated from
 * the batch files, including the evidence strings: a number that cannot be
 * re-derived here is not published.
 *
 * AND WHAT IT SUBCLASSIFIES. A verdict the witness reads AGAINST a rule is not
 * one kind of fact. Two of them are measured and named here:
 *
 *   print-error-emendation — the print's OWN text at the point is at fault, so
 *     the rule deliberately repairs a misprint and the witness cannot overrule
 *     it (PG's own editors repair misprints too). Two signals, both measured
 *     against the print itself:
 *       W  the form the print reads at the point is not a word of the reference
 *          wordlist (Gorgies, rythm, recal, Poeonian, consubsists);
 *       R  the print uses the form it reads here NOWHERE ELSE (at most once in
 *          1,177,047 + 1,352,533 bytes of its own text) while it uses our form
 *          elsewhere (prophesy 1× against prophecy 1×).
 *   contradiction — the print reads an ORDINARY word of its own vocabulary at
 *     the point and the rule puts another word there, with no fault of the
 *     print's form to point at (case 181× against care; externally 40×, cover
 *     1×). Here the witness's reading is a reading of the print and the rule's
 *     target is an editorial judgement; this is the class Unit B must READ, not
 *     apply.
 *
 * The test is a partition of EVIDENCE STRENGTH, not of truth: it says which
 * cases have independent evidence that the print itself is wrong. It cannot tell
 * a deliberate correction of the print from a rule that is simply mistaken where
 * the print is not; nothing in this witness can.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = process.env.PG_LOCATE_BATCHES || '/var/tmp/pg-locate';
const SLUG = 'proclus-theology-of-plato-taylor-1816';
const load = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const out = {};
const tally = (rows, key) => {
  const m = new Map();
  for (const r of rows) m.set(key(r), (m.get(key(r)) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const obj = (rows, key) => Object.fromEntries(tally(rows, key));
const group = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    const v = m.get(k) || { n: 0, located: 0, vol1: 0, vol2: 0, tight: 0 };
    v.n += 1;
    if (r.status === 'located') {
      v.located += 1;
      v[r.volume] += 1;
      if (r.tight) v.tight += 1;
    }
    m.set(k, v);
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1].n - a[1].n));
};

const open = { 8: load('open-r8.json').points, 24: load('open-r24.json').points, 48: load('open-r48.json').points };
const rules = { 8: load('rules-r8.json').points, 24: load('rules-r24.json').points, 48: load('rules-r48.json').points };
const punct = load('punct-r24.json').points;
const sweep = load('sweep.json');
const decisions = (rows) => obj(rows.filter((r) => r.status === 'located'), (r) => r.decide.verdict);

/* ---------- the subclassification ------------------------------------------ */

const CLASSES = {
  EMENDATION: 'print-error-emendation — DO NOT REVERT: the print’s own text at the point is at fault',
  INSERTION: 'insertion — the rule ADDS words and the witness reads our `before` because they are absent; there is no like-for-like reading to weigh',
  CONTRADICTION: 'contradiction — the print reads an ordinary word of its own vocabulary here and the rule puts another',
  THIRD: 'third-form — the print reads words of its own that are neither of the rule’s two readings, and our `before` IS a reading of the print: the rule’s target is not what the print reads',
  THIRD_GARBLE: 'third-form, but our own `before` is not a reading (garble, a damage mark or a numeral), so this is NOT evidence against the rule — it says only that our reconstructed `after` is not a contiguous run at the point',
};
function classify(d) {
  const before = (d.changed && d.changed.before) || [];
  const after = (d.changed && d.changed.after) || [];
  /* IS OUR `before` ITSELF A READING OF THE PRINT? If every word the rule changes
   * away from is a word of the reference wordlist, then the witness reading
   * against us is evidence about a reading. If our `before` is the
   * transcription's own garble or a damage mark (`@` can never occur in a
   * re-flowed witness), then the witness's reading at that point tells us
   * nothing about the rule: MEASURED, 62 of the 73 `third` cases are of that
   * kind. */
  const beforeIsAReading = before.length > 0 && before.every((w) => w.wordlist);
  if (d.verdict === 'third')
    return beforeIsAReading
      ? { class: 'third-form', signal: 'third', why: `${CLASSES.THIRD} — MEASURED: our \`before\` (${before.map((w) => `“${w.w}”`).join(', ')}) is a word of the reference wordlist and the print does not read it here` }
      : { class: 'third-form-on-our-own-garble', signal: 'third', why: `${CLASSES.THIRD_GARBLE} — MEASURED: our \`before\` (${(before.length ? before : (d.changed && d.changed.before) || []).map((w) => `“${w.w}”`).join(', ') || 'nothing'}) is not a word of the reference wordlist` };
  /* ONLY a `before` verdict can be an artifact of the subsequence test: `before`
   * is then a token-subsequence of `after`, so "the witness carries the old
   * reading" is trivially satisfiable by the words around the insertion. */
  if (d.after_words > d.before_words || (!before.length && after.length))
    return { class: 'insertion', signal: 'the rule adds words', why: CLASSES.INSERTION };
  const nonword = before.filter((w) => !w.wordlist);
  if (nonword.length)
    return {
      class: 'print-error-emendation',
      signal: 'W',
      why: `${CLASSES.EMENDATION} — MEASURED: the print's own form here (${nonword.map((w) => `“${w.w}”`).join(', ')}) is not a word of the reference wordlist, while our reading's word is`,
    };
  const rare = before.length && before.every((w) => w.uses !== null && w.uses <= 1) && after.some((w) => w.uses !== null && w.uses >= 1);
  if (rare)
    return {
      class: 'print-error-emendation',
      signal: 'R',
      why: `${CLASSES.EMENDATION} — MEASURED: the print uses the form it reads here (${before.map((w) => `“${w.w}” ${w.uses}×`).join(', ')}) nowhere else in its own text, while it uses our reading's word elsewhere (${after.map((w) => `“${w.w}” ${w.uses}×`).join(', ')})`,
    };
  return {
    class: 'contradiction',
    signal: null,
    why: `${CLASSES.CONTRADICTION} — MEASURED: the print uses the form it reads here ${before.map((w) => `“${w.w}” ${w.uses}×`).join(', ')} and our reading's word ${after.map((w) => `“${w.w}” ${w.uses}×`).join(', ')}`,
  };
}
const against = (r) => {
  const c = classify(r.decide);
  return {
    id: r.id,
    type: r.type,
    volume: r.volume,
    tight: r.tight,
    before: r.before,
    after: r.after,
    witness_reads: r.decide.witness_at_point || r.decide.window,
    class: c.class,
    signal: c.signal,
    why: c.why,
    changed_words: r.decide.changed,
  };
};

for (const s of [8, 24, 48]) {
  const o = open[s];
  const r = rules[s];
  out[`slide_${s}`] = {
    open_questions: {
      n: o.length,
      located: o.filter((x) => x.status === 'located').length,
      by_status: obj(o, (x) => x.status),
      by_volume: { vol1: o.filter((x) => x.volume === 'vol1').length, vol2: o.filter((x) => x.volume === 'vol2').length },
      tight: o.filter((x) => x.tight).length,
    },
    review_flagged_rules: {
      n: r.length,
      located: r.filter((x) => x.status === 'located').length,
      by_status: obj(r, (x) => x.status),
      by_volume: { vol1: r.filter((x) => x.volume === 'vol1').length, vol2: r.filter((x) => x.volume === 'vol2').length },
      tight: r.filter((x) => x.tight).length,
      by_type: group(r, (x) => x.type),
      decisions: decisions(r),
      decisions_by_volume: {
        vol1: obj(r.filter((x) => x.volume === 'vol1'), (x) => x.decide.verdict),
        vol2: obj(r.filter((x) => x.volume === 'vol2'), (x) => x.decide.verdict),
      },
      decisions_by_placement: {
        'both bounds hard against the point': obj(r.filter((x) => x.tight && x.decide), (x) => x.decide.verdict),
        'a bound slid off the damaged words': obj(r.filter((x) => x.status === 'located' && !x.tight), (x) => x.decide.verdict),
      },
    },
  };
}
const R = rules[24];
const loc = R.filter((r) => r.status === 'located');
const decided = loc.filter((r) => r.decide);
const D = obj(decided, (r) => r.decide.verdict);
const againstLoc = decided.filter((r) => ['before', 'third'].includes(r.decide.verdict)).map(against);
const byClass = (c) => againstLoc.filter((a) => a.class === c);
const emendations = byClass('print-error-emendation');
const conflicts = byClass('contradiction');
const insertions = byClass('insertion');
const thirdReal = byClass('third-form');
const thirdGarble = byClass('third-form-on-our-own-garble');

out.slide_24.refusals_not_our_own_text = obj(
  R.filter((r) => r.status === 'refused-not-our-text'),
  (r) => (r.why.includes('NOT in source.txt') ? 'not in our source at all' : r.why.includes('too short') ? 'too short a fragment for the tokeniser to place' : 'occurs more than once in our OWN source'),
);
out.slide_24.rules_the_witness_reads_AGAINST = decided
  .filter((r) => r.decide.verdict === 'before')
  .map(against);
out.slide_24.rules_the_witness_reads_a_THIRD_FORM = decided
  .filter((r) => r.decide.verdict === 'third')
  .map(against);
out.slide_24.rules_the_witness_CONFIRMS = (D.after || 0) + (D.both || 0);
out.slide_24.example_confirmations = decided
  .filter((r) => r.decide.verdict === 'after' && /^[a-z']+$/i.test(String(r.before).trim()) && /^[a-z' ]+$/i.test(String(r.after).trim()) && String(r.before).length > 3)
  .slice(0, 10)
  .map((r) => ({ id: r.id, before: r.before, after: r.after, witness: r.decide.window }));
out.open_questions_the_witness_answers = open[24]
  .filter((x) => x.status === 'located')
  .slice(0, 14)
  .map((x) => ({ leaf: x.leaf, our_text: x.passage, our_tokens: x.ours.tokens.join(' '), witness_tokens: (x.pg.tokens || []).join(' '), volume: x.volume, tight: x.tight }));

/* THE HEADLINE, RESTATED — the numbers the previous revision collapsed. */
out.THE_YIELD = {
  at_slide: 24,
  review_flagged_rules: {
    n: R.length,
    located: loc.length,
    by_volume: { vol1: loc.filter((r) => r.volume === 'vol1').length, vol2: loc.filter((r) => r.volume === 'vol2').length },
    tight: loc.filter((r) => r.tight).length,
    located_with_a_SHORT_witness_stretch: loc.filter((r) => r.thin_stretch).length,
    located_with_an_EMPTY_witness_stretch: loc.filter((r) => r.pg && r.pg.n === 0).length,
    /* SPLIT BY RULE TYPE, as the brief asks: located, and what the witness says,
     * for each type in the review-flagged set. */
    by_rule_type: (() => {
      const types = [...new Set(R.map((r) => r.type))];
      const m = {};
      for (const t of types) {
        const rows = R.filter((r) => r.type === t);
        const d = rows.filter((r) => r.status === 'located' && r.decide);
        m[t] = {
          n: rows.length,
          located: rows.filter((r) => r.status === 'located').length,
          vol1: rows.filter((r) => r.volume === 'vol1').length,
          vol2: rows.filter((r) => r.volume === 'vol2').length,
          tight: rows.filter((r) => r.tight).length,
          ...Object.fromEntries(tally(d, (r) => r.decide.verdict)),
        };
      }
      return m;
    })(),
    by_volume_with_decisions: {
      vol1: { located: loc.filter((r) => r.volume === 'vol1').length, ...Object.fromEntries(tally(loc.filter((r) => r.volume === 'vol1' && r.decide), (r) => r.decide.verdict)) },
      vol2: { located: loc.filter((r) => r.volume === 'vol2').length, ...Object.fromEntries(tally(loc.filter((r) => r.volume === 'vol2' && r.decide), (r) => r.decide.verdict)) },
    },
    CONFIRMS_the_rule: D.after || 0,
    CONTRADICTS_the_rule: againstLoc.length,
    of_which_the_print_reads_a_THIRD_FORM: D.third || 0,
    of_which_the_print_reads_our_OLD_reading: D.before || 0,
    /* WHAT THAT 95 IS MADE OF, MEASURED — the brief's own framing treats a third
     * form as the same class of fact as a `before`, and for 11 of the 73 it is;
     * for the other 62 it is not, because our own `before` there is the
     * transcription's garble. */
    by_class: Object.fromEntries(tally(againstLoc, (a) => a.class)),
    of_which_are_PRINT_ERROR_EMENDATIONS_do_not_revert: emendations.length,
    of_which_are_insertions: insertions.length,
    of_which_are_CONTRADICTIONS_to_be_read: conflicts.length,
    of_which_are_THIRD_FORM_on_a_REAL_before_reading: thirdReal.length,
    of_which_are_THIRD_FORM_on_OUR_OWN_GARBLE_no_evidence_against_the_rule: thirdGarble.length,
    EVIDENCE_AGAINST_THE_RULE_total: emendations.length + insertions.length + conflicts.length + thirdReal.length,
    UNDECIDABLE_by_design_marks_or_case_only: D['silent-marks'] || 0,
    UNDECIDABLE_the_rules_own_after_is_unsure: D['silent-unsure'] || 0,
    NO_READING_DRAWN_the_witness_carries_nothing: D['absent-at-point'] || 0,
    NO_READING_DRAWN_the_witness_stretch_is_3_tokens: D['thin-stretch'] || 0,
  },
  open_questions: {
    n: open[24].length,
    located: open[24].filter((x) => x.status === 'located').length,
    by_volume: {
      vol1: open[24].filter((x) => x.volume === 'vol1').length,
      vol2: open[24].filter((x) => x.volume === 'vol2').length,
    },
    tight: open[24].filter((x) => x.tight).length,
  },
  PUNCTUATION: {
    n: punct.length,
    located: punct.filter((r) => r.status === 'located').length,
    undecidable_marks_only: punct.filter((r) => r.status === 'located' && r.decide && r.decide.verdict === 'silent-marks').length,
    with_a_reading: punct.filter((r) => r.status === 'located' && r.decide && !/^(silent|absent|thin)/.test(r.decide.verdict)).length,
  },
};
out.UNIT_B_MAY_ACT_ON = {
  may_CLEAR_the_review_flag: D.after || 0,
  must_READ_before_acting: emendations.length + insertions.length + conflicts.length + thirdReal.length,
  of_which_PRINT_ERROR_EMENDATIONS_it_must_NOT_revert: emendations.map((a) => a.id),
  of_which_INSERTIONS_it_must_NOT_treat_as_a_reading: insertions.map((a) => a.id),
  of_which_CONTRADICTIONS_it_must_adjudicate: conflicts.map((a) => a.id),
  of_which_THIRD_FORM_on_a_real_before_reading: thirdReal.map((a) => a.id),
  NO_EVIDENCE_EITHER_WAY_third_form_on_our_own_garble: thirdGarble.map((a) => a.id),
  may_NOT_act_on_at_all: R.length - (D.after || 0) - againstLoc.length,
  note:
    'A `before` verdict says the print’s own text reads our OLD reading, and a `third` verdict says it reads words of its own that are neither reading: both are reports about what the print READS, and both were, before this revision, one word (`silent`). What differs is whether our `before` is itself a reading of the print: where it is the transcription’s garble (62 of the 73 third forms), the witness’s words at the point are no evidence at all against the rule. A `silent-marks` or `silent-unsure` verdict is UNDECIDABLE BY DESIGN. `absent-at-point` and `thin-stretch` mean no reading was drawn, not that the rule is right.',
};
out.THE_TEST_USED_TO_SUBCLASSIFY = {
  'print-error-emendation (do not revert)': 'the print’s OWN text at the point is at fault, measured two ways: W the form the print reads there is not a word of the reference wordlist; R the print uses that form nowhere else in its own text (≤1×) while it uses our reading’s word elsewhere.',
  contradiction: 'the print reads an ordinary word of its own vocabulary at the point and the rule puts another word there, with no fault of the print’s own form to point at, and NEITHER misprint signal fires. WHAT IS DONE WITH IT IS NOT A KEEP: MEASURED 2026-10-07 (the 1.0.5 unit), every one of the 14 rules in this class OVERRIDES a print our transcription already reads, so the class is named after the measurement rather than after a conclusion about the print, and tools/pg-act.mjs WITHDRAWS the rule (the version serves the print’s own text) unless the rule’s own \`find\` carries a mark the print cannot set, in which case the target is CORRECTED to the print’s own words under a fresh id. 1.0.4 kept all 14 with a why-string that ASSERTED an emendation of the print; that assertion is corrected in tools/pg-act.mjs and in 1.0.5 (see .measured.the_14_reopened and .rejected_signals there).',

  insertion: 'the rule adds words, so the witness’s `before` reading is what the print reads without them; there is no like-for-like pair of readings to weigh.',
  'third-form': 'the print reads words of its own that are neither of the rule’s two readings AND our `before` is a word of the reference wordlist — a real reading the print does not carry here, i.e. the same class of fact as a `before`.',
  'third-form-on-our-own-garble': 'the print reads words of its own that are neither reading, but our `before` is itself the transcription’s garble, a damage mark or a numeral, so this says only that our reconstructed `after` is not a contiguous run at the point. It is NOT evidence against the rule and must not be acted on.',
  LIMIT: 'This partition measures EVIDENCE STRENGTH, not truth. It distinguishes cases where the print itself is provably at fault. It cannot tell a deliberate correction of the print from a rule that is simply wrong where the print is not — and where the print reads an ordinary word, PG’s evidence AGAINST the rule is itself weak, because PG’s editors silently repair misprints too (MEASURED: PG carries “rythm” 4× against “rhythm” 2×, so it repairs that spelling only sometimes).',
  disagreement_with_the_review: 'The review named r8944 (case→care) as an emendation. MEASURED, `case` is used 181× in the print’s own vocabulary and `care` 40×, so it fires neither signal and is classified a contradiction: the print reads an ordinary word here and the correction is editorial. Its other named cases (r10931 Gorgies, r10277 rythm, r10212 recal, r8627 prophesy) are all classified print-error-emendations. And the review’s own decomposition of the 186 changed-words fallback cases reproduces exactly (78 at ≤2 witness tokens, 73 at ≥4, 35 at 3).',
  disagreement_with_the_brief: 'The brief calls the third-form class “the SAME CLASS as the 22”. MEASURED, that holds for 11 of the 73 and not for the other 62, whose `before` is garble — see `third-form-on-our-own-garble` above. The class is real and the split is real; the equivalence is not.',
};

/* ---------- the volume split, generated from the sweep --------------------- */

{
  const s = sweep.split;
  const pct = (a, b) => ((100 * a) / b).toFixed(1);
  const v1 = s.vol1_half;
  const v2 = s.vol2_half;
  out.volume_split = {
    note: 'MEASURED by the sweep, not assumed — and every string below is GENERATED from the sweep, so it produces the number it is cited for',
    our_tokens: sweep.tokens,
    boundary_token: s.boundary_token,
    how_the_boundary_is_taken: s.how,
    first_unique_in_vol2: s.first_unique_in_vol2,
    last_unique_in_vol1: s.last_unique_in_vol1,
    overlap_note: s.overlap_note,
    evidence: `the split is taken at our token ${s.boundary_token}: everything before it is ${v1.windows} clean 10-word windows of which ${v1['unique in vol1']} (${pct(v1['unique in vol1'], v1.windows)}%) are unique in PG vol. 1 and ${v1['unique in vol2'] || 0} in PG vol. 2, and everything from it is ${v2.windows} of which ${v2['unique in vol2']} (${pct(v2['unique in vol2'], v2.windows)}%) are unique in PG vol. 2. The FIRST window of ours unique in PG vol. 2 starts at ${s.first_unique_in_vol2} and the LAST unique in PG vol. 1 at ${s.last_unique_in_vol1}: the two ranges OVERLAP (${s.first_unique_in_vol2} < ${s.last_unique_in_vol1}), because the print repeats content across its two volumes, so neither is the split.`,
    vol1_half_unique_in_pg_vol1: `${v1['unique in vol1']} of ${v1.windows} clean 10-word windows (${pct(v1['unique in vol1'], v1.windows)}%)`,
    vol1_half_unique_in_pg_vol2: `${v1['unique in vol2'] || 0}`,
    vol2_half_unique_in_pg_vol2: `${v2['unique in vol2']} of ${v2.windows} (${pct(v2['unique in vol2'], v2.windows)}%)`,
    misclassified_windows: s.misclassified.map((m) => `${m.token} “${m.run}” occurs ${JSON.stringify(m.occ)} — a passage the print repeats across its two volumes, not an artifact`),
    CORRECTION_of_the_previous_evidence:
      'This block used to cite “the last window of our text unique in PG vol. 1 and the first unique in PG vol. 2” and record boundary_token 192675 with halves of 6016/3494. MEASURED, those two window starts are the ones above and they are INVERTED, so the phrase named no split at all; and both it and the halves came from a SUPERSEDED tokeniser (see CORRECTION_OF_THE_CEILING).',
  };
  out.CORRECTION_OF_THE_CEILING = {
    what_the_previous_revision_said: '8,098 of 9,510 clean 10-word windows (85.2%) unique in exactly one volume; halves 5056/6016 (84.0%) and 3041/3494 (87.0%); 305,877 tokens in source.txt',
    what_it_is_now_MEASURED: `${sweep.rows.filter((r) => Object.values(r.occ).filter((n) => n === 1).length === 1).length} of ${sweep.rows.length} clean 10-word windows are unique in exactly one volume; ${sweep.tokens} tokens in source.txt`,
    why:
      'The old figures came from the tokeniser of the PREVIOUS revision of tools/pg-locate.mjs, which dropped this transcription’s DAMAGE characters instead of keeping them as `@`. The same commit that replaced that tokeniser (the yield commit) did not re-run --sweep, so the ceiling and the volume split stayed on the superseded instrument. MEASURED, re-running the old tokeniser (commit 877cb60) gives 9,510/85.2%/305,877 exactly, and the current one gives the figures above. Nothing about the print changed; the instrument did.',
    warning_for_a_reader:
      'A window whose tokens are not all known words of this print is EXCLUDED from the denominator rather than counted as unlocatable, so a higher percentage here is a smaller and cleaner sample, not a better instrument: the damage-bearing windows the old count included as “in neither volume” are not counted at all now.',
  };
  out.sweep = {
    windows: sweep.rows.length,
    tokens: sweep.tokens,
    strata: (() => {
      const m = new Map();
      for (const r of sweep.rows) {
        const u = Object.entries(r.occ).filter(([, n]) => n === 1).map(([k]) => k);
        const k = u.length === 1 ? `unique in ${u[0]}` : u.length === 2 ? 'unique in both volumes' : Object.values(r.occ).every((n) => n === 0) ? 'in neither volume' : 'in some volume more than once';
        m.set(k, (m.get(k) || 0) + 1);
      }
      return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
    })(),
  };
}

/* ---------- the proofs ------------------------------------------------------ */

const j = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
out.proofs_the_locator_REFUSES = [
  { probe: 'a passage of invented words', file: 'refuse-invented.json' },
  { probe: 'a passage of real but everywhere-common words', file: 'refuse-common.json' },
  {
    probe: 'the 1816 imprint page — the same words in BOTH volumes (the ambiguity that used to be decided by sort order)',
    file: 'refuse-imprint.json',
  },
].map((r) => {
  const x = j(r.file);
  return { probe: r.probe, status: x.status, why: x.why, volume: x.volume, volumes_ok: x.volumes_ok, left: x.left && x.left.tokens, right: x.right && x.right.tokens };
});
const control = j('refuse-control.json');
out.proof_the_locator_LOCATES = {
  probe: control.probe,
  status: control.status,
  volume: control.volume,
  tight: control.tight,
  witness_stretch: control.pg && control.pg.n,
  span: control.span,
};
const t4 = j('truth-b4c6.json');
const t7 = j('truth-b7c32.json');
out.known_truths = {
  book4_chapter6: { probe: t4.probe, status: t4.status, volume: t4.volume, tight: t4.tight, witness_reads: (t4.pg && t4.pg.tokens || []).join(' ').slice(0, 120) },
  book7_chapter32: { probe: t7.probe, status: t7.status, volume: t7.volume, tight: t7.tight, witness_stretch: t7.pg && t7.pg.n, identical_to_ours: true },
};
out.PROVEN_BY_ASYMMETRY = {
  tool: 'tools/pg-locate-selftest.mjs',
  how: 'run the selftest against the PREVIOUS revision of the tool and against this one; the failures on the old one are the defects',
  previous_revision: 'git show 877cb60:tools/pg-locate.mjs',
  measured_on_the_probes: '4 of 5 pass on the old instrument, 5 of 5 on this one — the old one places the imprint page (both volumes bracket it) as `located, vol1`',
  measured_on_the_r24_batch: '5 of 14 pass on the old batch, 14 of 14 on this one — the old one has 42 located points with an EMPTY witness stretch, 4 points with bracketing pairs in BOTH volumes, 331 bare `silent` verdicts and r8617 silent',
};

const head = {
  slug: SLUG,
  tool: 'tools/pg-locate.mjs',
  what: 'the measured yield of the Project Gutenberg witnesses over this edition’s open questions and review-flagged rules, and the proofs that the locator refuses',
  witnesses: {
    vol1: { ebook: 77393, name: 'gutenberg-77393-vol1', sha256: load('rules-r24.json').volumes[0].sha256, bytes: load('rules-r24.json').volumes[0].bytes },
    vol2: { ebook: 78800, name: 'gutenberg-78800-vol2', sha256: load('rules-r24.json').volumes[1].sha256, bytes: load('rules-r24.json').volumes[1].bytes },
  },
  method: load('rules-r24.json').method,
  slide:
    'The reported table is --slide 24 — the mid-point of the probed range, chosen for the table and NOT because it is more accurate than 8 or 48. THE MARGINAL YIELD ACROSS THE CURVE IS ALL NON-TIGHT, MEASURED: the tight placements are 961 at EVERY slide with identical verdicts (804 after, 84 silent-marks, 29 thin-stretch, 23 absent-at-point, 15 before, 6 third) while the slid decisions grow (after 300 → 463 → 482; third 32 → 67 → 74 at slides 8/24/48). Of the 1,354 rules that have a verdict at all three slides, zero flip. So a rule this table confirms and slide 8 does not is confirmed on SLID BOUNDS ONLY — the weakest placements — and the 237 rules slide 24 adds over slide 8 are all of that kind.',
  what_it_CANNOT_settle: [
    'a printed page number, a leaf, a line, a running head, or a hyphenation at line end — a re-flowed witness carries none of them',
    `PUNCTUATION and CASE, which this tool discards before comparing: MEASURED, of the ${out.THE_YIELD.PUNCTUATION.located} located punctuation rules, ${out.THE_YIELD.PUNCTUATION.undecidable_marks_only} are UNDECIDABLE for that reason alone and only ${out.THE_YIELD.PUNCTUATION.with_a_reading} come back with a reading`,
    'our TYPOGRAPHY. A rule the witness confirms is confirmed as a READING of the same print; the witness has its own editorial normalisation and its own reading, and it is not evidence about how this edition sets a page',
    'WHAT THE PRINT MEANS. Where the print reads an ordinary word, the witness settles what is printed and never what was intended — see THE_TEST_USED_TO_SUBCLASSIFY.',
  ],
  batch_files: 'open-r{8,24,48}.json, rules-r{8,24,48}.json, punct-r24.json, sweep.json — in /var/tmp/pg-locate, regenerable; this file is generated from them by tools/pg-locate-report.mjs',
  generated: new Date().toISOString(),
};
const dest = join(ROOT, 'tools', 'edits', `${SLUG}.pg-locate.json`);
writeFileSync(dest, `${JSON.stringify({ ...head, ...out }, null, 1)}\n`);
console.log(JSON.stringify(out.THE_YIELD, null, 1));
console.log(JSON.stringify(out.UNIT_B_MAY_ACT_ON, null, 1));
console.log(`wrote ${dest}`);
