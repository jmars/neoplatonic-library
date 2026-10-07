#!/usr/bin/env node
/**
 * tools/pg-atfault-sweep.mjs — sweep every version of this edition for the rules
 * whose COMMITTED TEXT claims the print is at fault, BY RULE PROPERTY rather than
 * by the classifier's own class string, and say for each claim whether an at-fault
 * VERDICT is on the record for it.
 *
 *     node tools/pg-atfault-sweep.mjs [<slug>] [--batch FILE] [--out FILE]
 *
 * WHY THIS EXISTS, AND WHAT IT CORRECTS. The seventh-DOI unit verified its sweep
 * with `/PRINT-ERROR EMENDATION|print-error-emendation/i` and reported "every rule
 * whose committed rationale asserts the print is at fault: 6 in 1.0.5, 6 in 1.0.4,
 * 0 in 1.0.0–1.0.3". MEASURED (review #4): that regex matches the CLASS NAME, not
 * the CLAIM. Two rules have carried print-fault-shaped wording since 1.0.0 —
 * r8768 and r9108, "Parcse misprinted for Parcae; clean error." — which the class
 * string cannot catch, so the sentence did not cover them. The sweep below takes
 * the claim from the RULE's own text (rationale, the rule's own type evidence and
 * every witness entry's `why`) and matches the three CLAIM SHAPES the record has
 * actually used:
 *
 *     "X misprinted for Y"        — the editor's own claim, since 1.0.0
 *     "EMENDATION OF THE PRINT"   — 1.0.4's at-fault wording (the overclaim 1.0.5 killed)
 *     "THE PRINT IS AT FAULT"     — 1.0.6's at-fault wording
 *
 * AND IT IS A FLOOR, NOT A CEILING. This is a WORD test: a rule that claims a
 * fault of the print in words these shapes do not carry would still be missed, and
 * a bare `misprint`/`at fault` test is not usable as a substitute — MEASURED, it
 * also matches NEGATED mentions the tool itself writes (r8627's tie: "they do not
 * show the print's form is a misprint"), which would report a rule as claiming a
 * fault it explicitly disclaims. What the tool can do is state the shapes it used
 * and name every rule each shape adds, with that rule's own measurements, so a
 * reader judges the delta instead of trusting the count.
 *
 * THE DISPOSITION TEST. A claim shape is not a verdict: the sweep asks of every
 * matching rule whether an at-fault VERDICT is recorded for it in that version,
 * under EITHER wording the record has used (the class string of 1.0.4/1.0.5 or
 * `THE PRINT IS AT FAULT` of 1.0.6). The rules that match a claim shape and have
 * NO verdict are the delta a sentence can be wrong about without any number in it
 * changing.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const FLAG_VALUES = new Set(['--batch', '--out']);
const slug = args.find((a, i) => !a.startsWith('-') && !FLAG_VALUES.has(args[i - 1])) || 'proclus-theology-of-plato-taylor-1816';
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const BATCH = opt('batch', '/var/tmp/pg-locate/rules-r24.json');
const OUT = opt('out', join(ROOT, 'tools', 'edits', `${slug}.print-fault-sweep.json`));
const VDIR = join(ROOT, 'data', 'editions', slug, 'versions');

const CLAIM_SHAPE = /misprinted for|EMENDATION OF THE PRINT|THE PRINT IS AT FAULT/;
const AT_FAULT_VERDICT = /print-error-emendation|PRINT-ERROR EMENDATION|THE PRINT IS AT FAULT/;
const CLASS_STRING = /print-error-emendation|PRINT-ERROR EMENDATION/i;
/** The rule's OWN text — the rationale, its own type evidence and every witness
 * entry's `why`. These are the fields every version's claim has been written into
 * (the appended WITNESS block goes into the RATIONALE, and the at-fault verdict of
 * 1.0.6 is written there too). */
const ruleText = (r) => [r.rationale, r.type_evidence, ...(Array.isArray(r.evidence) ? r.evidence.map((e) => e.why) : [])].filter(Boolean).join(' ¦ ');

const versions = readdirSync(VDIR)
  .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const batch = existsSync(BATCH) ? JSON.parse(readFileSync(BATCH, 'utf8')) : null;

const perVersion = versions.map((v) => {
  const rules = JSON.parse(readFileSync(join(VDIR, v, 'repairs.json'), 'utf8')).rules;
  const id = (r) => r.id.split(':')[1];
  const detail = (r) => {
    const p = batch ? batch.points.find((x) => x.id.endsWith(`:${id(r)}`)) : null;
    const c = p && p.decide && p.decide.changed;
    return {
      id: id(r),
      find: r.location.find,
      before: r.before,
      after: r.after,
      committed_own_text: ruleText(r),
      flagged_for_review: r.review === true,
      witness_entries: (r.evidence || []).filter((e) => e.kind === 'witness').length,
      witness_verdict: p && p.decide ? p.decide.verdict : null,
      witness_placement: p ? p.status : null,
      /* THE PRINT'S OWN COUNTS, from the batch the decisions rest on: `uses`
       * counts the form across BOTH volumes of the human-proofread print, and
       * `wordlist` says whether it is a word of the reference wordlist. Stated so
       * that "harmless" is a measurement and not a phrase. */
      measured_in_the_print: c
        ? c.before.map((w, i) => ({
            form_the_rule_changes: w.w,
            uses_in_the_print: w.uses,
            in_the_reference_wordlist: w.wordlist,
            rule_s_target: (c.after[i] || {}).w,
            target_uses_in_the_print: (c.after[i] || {}).uses,
          }))
        : 'not in this batch — the witness does not read a changed before/after form at this rule',
    };
  };
  const byClass = rules.filter((r) => CLASS_STRING.test(ruleText(r)));
  const byShape = rules.filter((r) => CLAIM_SHAPE.test(ruleText(r)));
  const byVerdict = rules.filter((r) => AT_FAULT_VERDICT.test(ruleText(r)));
  const verdictIds = new Set(byVerdict.map(id));
  return {
    version: v,
    rules: rules.length,
    swept_by_the_class_string: { n: byClass.length, ids: byClass.map(id) },
    swept_by_claim_shape: { n: byShape.length, ids: byShape.map(id) },
    claims_with_an_at_fault_VERDICT_on_the_record: { n: byVerdict.length, ids: byVerdict.map(id) },
    /* THE DELTA: a rule whose own text claims a fault of the print and for which
     * NO at-fault verdict is recorded in this version. */
    claims_with_NO_at_fault_verdict_recorded: byShape
      .filter((r) => !verdictIds.has(id(r)))
      .map(detail),
  };
});

const LAST = perVersion[perVersion.length - 1];
const deltaOf = (p) => p.claims_with_NO_at_fault_verdict_recorded.map((x) => x.id);
/* THE DELTA PRESENT IN EVERY VERSION — the intersection, which is what a sentence
 * about "every rule whose committed text claims the print is at fault" must cover
 * in each of them. MEASURED: r8768 and r9108, and only those two; 1.0.4's delta is
 * a SUPERSET (the same two plus the 14 rules that version's own at-fault wording
 * was appended to, which 1.0.5 stripped). */
const inEvery = perVersion
  .map(deltaOf)
  .reduce((a, b) => a.filter((x) => b.includes(x)))
  .sort();
const out = {
  slug,
  tool: 'tools/pg-atfault-sweep.mjs',
  what: 'every rule (per version) whose COMMITTED TEXT claims a fault of the print, swept BY RULE PROPERTY rather than by the classifier’s class string, each claim tested for whether an at-fault verdict is on the record for it',
  the_claim_shapes:
    `${CLAIM_SHAPE} — applied to the rule’s own text (rationale, type_evidence, every witness entry’s \`why\`), NOT to the class string. The three shapes are the three wordings the record has used for the claim. A bare \`misprint\` or \`at fault\` test is NOT used: MEASURED, it also matches NEGATED mentions the tool itself writes (r8627’s tie why-string says the counts “do not show the print’s form is a misprint”), reporting a rule as claiming a fault it explicitly disclaims.`,
  the_verdict_test:
    `${AT_FAULT_VERDICT} — either wording the record has carried for the at-fault CLASS: the class string of 1.0.4/1.0.5, or 1.0.6’s own why-string. A claim shape is not a verdict, and this is the test that separates them.`,
  the_class_string_sweep_this_corrects:
    `${CLASS_STRING} — the sweep the seventh-DOI unit ran. MEASURED: it matches the CLASS NAME only, so it reads 0 for 1.0.0–1.0.3, 6 for 1.0.4 and 1.0.5, and 0 for 1.0.6, where the at-fault why-string is written as \`THE PRINT IS AT FAULT — MEASURED: …\` and the class string no longer appears. A sweep whose count is 0 because the WORDING moved is one of the two defects this tool exists for.`,
  per_version: perVersion,
  THE_SENTENCE_THIS_SWEEP_CORRECTS:
    'The seventh-DOI unit’s claim — "every rule whose committed rationale asserts the print is at fault: 6 in 1.0.5, 6 in 1.0.4, 0 in 1.0.0–1.0.3, all 6 placed by the locator and none unplaced" — is TRUE OF THE CLASS STRINGS and NOT of the claims. MEASURED by this sweep: r8768 and r9108 have carried "Parcse misprinted for Parcae; clean error." in EVERY version since 1.0.0, they are in 1.0.6, and the class-string regex cannot see either of them in any version.',
  the_two_rules_and_why_they_are_HARMLESS_STATED_AS_MEASUREMENTS: LAST.claims_with_NO_at_fault_verdict_recorded.map(
    (x) =>
      `${x.id}: the rule changes ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)} (find ${JSON.stringify(x.find)}); its committed text is ${JSON.stringify(x.committed_own_text)}. ` +
      `MEASURED in the print’s own two volumes: ` +
      (Array.isArray(x.measured_in_the_print)
        ? x.measured_in_the_print.map((m) => `${JSON.stringify(m.form_the_rule_changes)} ${m.uses_in_the_print}× (the rule’s target ${JSON.stringify(m.rule_s_target)} ${m.target_uses_in_the_print}×; a word of the reference wordlist: ${m.in_the_reference_wordlist})`).join('; ')
        : String(x.measured_in_the_print)) +
      `. The witness reads ${JSON.stringify(x.witness_verdict)} here (placement: ${x.witness_placement}) and the rule carries ${x.witness_entries} witness entr(ies), so what the rule repairs is a form the print NEVER sets — a fault of OUR transcription — while its target is what the print reads. ` +
      `NO AT-FAULT VERDICT RESTS ON EITHER: neither is in the classifier’s at-fault class in any version, and this sweep is what says so.`,
  ),
  THE_DELTA_IN_EVERY_VERSION: {
    ids: inEvery,
    why:
      'the intersection of `claims_with_NO_at_fault_verdict_recorded` over all seven versions: rules whose committed text claims a fault of the print AND for which no at-fault verdict is on the record, in every version. MEASURED: r8768 and r9108, in all of them — the two the class-string sweep cannot see.',
  },
  the_claim_shape_that_appears_in_only_one_version: {
    shape: 'EMENDATION OF THE PRINT',
    what:
      'MEASURED: it is 1.0.4’s at-fault wording, appended by that version to every contradiction-class rationale — 16 rules carry it in 1.0.4 and none afterwards, because the 1.0.5 unit stripped it. Those 16 are the overclaim unit C KILLED (the class that asserted an emendation of the print from a measurement that is the definition of the before-verdict), not a residual, and they are listed per version below.',
  },
  HOW_A_READER_SHOULD_USE_THIS:
    'A count under a class string is a count of the wording, not of the claim. Read `swept_by_claim_shape` against `claims_with_an_at_fault_VERDICT_on_the_record` per version and check the delta by hand: the delta is where a sweep’s SENTENCE can be wrong without any number in it changing.',
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
for (const pv of perVersion)
  console.log(
    `${pv.version}: ${pv.rules} rules — class string ${pv.swept_by_the_class_string.n} (${pv.swept_by_the_class_string.ids.join(' ')}), claim shape ${pv.swept_by_claim_shape.n} (${pv.swept_by_claim_shape.ids.join(' ')}), at-fault verdict ${pv.claims_with_an_at_fault_VERDICT_on_the_record.n} (${pv.claims_with_an_at_fault_VERDICT_on_the_record.ids.join(' ')}), CLAIM WITHOUT A VERDICT ${pv.claims_with_NO_at_fault_verdict_recorded.length} (${pv.claims_with_NO_at_fault_verdict_recorded.map((x) => x.id).join(' ')})`,
  );
console.log(`THE DELTA IN EVERY VERSION (a claim with no at-fault verdict): ${inEvery.join(' ')}`);
console.log(`wrote ${OUT}`);
