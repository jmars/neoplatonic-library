#!/usr/bin/env node
/**
 * pg-act.mjs — ACT ON THE HUMAN-PROOFREAD WITNESS: clear the review flags the
 * witness EARNS, record the witness in the rule's own `evidence`, and record
 * what the witness says at every rule it reads AGAINST.
 *
 * WHY THIS IS A TOOL AND NOT AN EDIT. Every number this unit acts on is
 * DERIVED, not typed: the verdicts come from the locator's batch
 * (`tools/pg-locate.mjs`, `--what rules --slide 24`), the subclassification of
 * the rules the witness reads against comes from the same tests
 * `tools/pg-locate-report.mjs` applies, and the one editorial intervention —
 * correcting a rule's target to what the print reads — is ASSERTED against the
 * witness's own quoted words before it is written, so a correction cannot be
 * typed in from memory. A future run reproduces the whole file.
 *
 * THE PLACEMENT RULE THIS APPLIES (decided here, stated in the record).
 * The locator places a point by two token runs each occurring EXACTLY ONCE in
 * one volume of the print. When a bound stands on one of our DAMAGED words the
 * print cannot carry that run — the print reads the CORRECTED word there — so
 * the bound is pushed off it, and the placement is SLID. Tightness is therefore
 * a fact about the damage around the point, not about the soundness of the
 * placement: MEASURED, six slid confirmations read perfectly against the
 * witness's own bytes (r8573 `hypostasis of in* telligibles` -> `intelligibles`,
 * r8585 `intclligibles` -> `intelligibles`, r8597 `essence, fife` -> `life`).
 * So a TIGHT placement clears, and a SLID placement clears when the witness
 * carries the rule's WHOLE reading at the point rather than the changed fragment
 * alone — a fragment is one or two common words and is what locates nearby text,
 * not what witnesses a repair. A slid placement confirmed only on the changed
 * words KEEPS the flag, and so does every rule the witness reads AGAINST.
 *
 * WHAT IT REFUSES TO DO:
 *   - clear a rule whose `evidence` would then claim a page image it does not
 *     have (the entry carries no leaf: see `leafEntry` in the build);
 *   - revert a rule that deliberately corrects the PRINT's own misprint — the
 *     witness transcribes the print faithfully, so its agreement there is not
 *     evidence against the emendation;
 *   - write a correction the witness's own quoted words do not carry.
 *
 *   node tools/pg-act.mjs <slug> [--batch FILE] [--from-version V] [--to-version V] [--write]
 *
 * Writes `tools/edits/<slug>.pg-act.json` (the decision record, the committed
 * artifact the rules are re-derivable from) and, with --write, the target
 * version's `repairs.json`. Reads ONLY the source version's rules and the batch.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const FLAG_VALUES = new Set(['--batch', '--from-version', '--to-version', '--out']);
const slug = args.find((a, i) => !a.startsWith('-') && !FLAG_VALUES.has(args[i - 1]));
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const write = args.includes('--write');
if (!slug) {
  console.error('usage: node tools/pg-act.mjs <slug> [--batch FILE] [--from-version V] [--to-version V] [--write]');
  process.exit(2);
}
const EDITION = join(ROOT, 'data', 'editions', slug);
const BATCH = opt('batch', '/var/tmp/pg-locate/rules-r24.json');
const FROM = opt('from-version', '1.0.3');
const TO = opt('to-version', '1.0.4');
const OUT = opt('out', join(ROOT, 'tools', 'edits', `${slug}.pg-act.json`));

const rulesFile = (v) => join(EDITION, 'versions', v, 'repairs.json');

/* ---------- --stamp-open: the evidence on the rules that SETTLE an open question
 * The open questions the witness answers are folded in by `tools/merge.mjs`, which
 * writes the rule and its rationale but knows nothing of `evidence`. This mode
 * runs AFTER the merge and stamps each such rule with the witness entry, taking
 * every field from the batch's own point record and ASSERTING that the finding's
 * replacement is carried by the witness's own quoted words — so the evidence
 * cannot be typed in from memory. It is idempotent: a rule already carrying the
 * witness entry is left alone. */
if (args.includes('--stamp-open')) {
  /* The same witness assertion the corrections use, defined here so the mode is
   * self-contained (the module-level copy is a `const` and would be in its
   * temporal dead zone this early in the file). */
  const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const tokenizeOur = (s) => flat(s).split(' ').filter(Boolean);
  const carried = (p, text) =>
    flat(`${p.quote || ''} ${p.decide && p.decide.window ? p.decide.window : ''} ${p.pg && p.pg.tokens ? p.pg.tokens.join(' ') : ''}`).includes(flat(text)) &&
    flat(text).length > 0;
  const findingsFile = opt('from', join(ROOT, 'tools', 'edits', `${slug}.open-findings.json`));
  const spec = JSON.parse(readFileSync(findingsFile, 'utf8'));
  const openBatch = JSON.parse(readFileSync(opt('open-batch', '/var/tmp/pg-locate/open-r24.json'), 'utf8')).points;
  const byQ = new Map(openBatch.map((p) => [String(p.id).split(' ')[0], p]));
  const raw = JSON.parse(readFileSync(rulesFile(TO), 'utf8'));
  let stamped = 0;
  const refused = [];
  const alreadySettled = [];
  for (const f of spec.findings || []) {
    const p = byQ.get(f.open_question);
    if (!p) {
      refused.push(`${f.open_question}: no such point in the batch`);
      continue;
    }
    const rule = raw.rules.find((r) => r.location && r.location.find === f.find);
    if (!rule) {
      /* AN OPEN QUESTION ALREADY SETTLED BY A RULE OF THIS EDITION. The finding
       * names the rule; this asserts the witness AGREES with that rule's target on
       * the word that differs (the longest shared run of the witness's changed
       * word and the rule's own reading is at least four characters) and then
       * stamps the witness beside whatever evidence that rule already carries. A
       * disagreement is a REFUSAL, not a stamp. */
      const a = f.already_settled_by;
      const target = a && raw.rules.find((r) => r.id === a.rule);
      if (!a || !target) {
        refused.push(`${f.open_question}: no rule carries the find ${JSON.stringify(f.find)} — the merge may have widened or refused it`);
        continue;
      }
      const changed = (f.replace.split(/\s+/) || []).filter((w) => !f.find.split(/\s+/).includes(w));
      const shared = (x, y) => {
        let best = 0;
        for (let i = 0; i < x.length; i++)
          for (let j = 0; j < y.length; j++) {
            let k = 0;
            while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k++;
            if (k > best) best = k;
          }
        return best;
      };
      const hit = changed.length > 0 && changed.every((w) => shared(flat(w), flat(target.after)) >= 4);
      if (!hit) {
        refused.push(`${f.open_question}: the witness reads ${JSON.stringify(changed)} and the existing rule ${a.rule} records ${JSON.stringify(target.after)} — they DISAGREE`);
        continue;
      }
      const e2 = f.witness_evidence;
      const have2 = Array.isArray(target.evidence) ? target.evidence : [];
      alreadySettled.push(`${f.open_question} — the witness AGREES with the rule already recorded for this point, ${a.rule} (${JSON.stringify(target.location.find)} -> ${JSON.stringify(target.after)}): ${a.agreement}`);
      /* ONE WITNESS ENTRY PER WITNESS, not one per point: a rule that was already
       * cleared against the same witness keeps that entry and this stamp is a
       * no-op — the reading is the same fact. */
      if (have2.some((x) => x.kind === 'witness' && x.witness === e2.witness)) continue;
      target.evidence = have2.concat([e2]);
      stamped++;
      continue;
    }
    const e = f.witness_evidence;
    if (!carried(p, f.replace)) {
      refused.push(`${f.open_question}: the replacement ${JSON.stringify(f.replace)} is NOT carried by the witness's own quoted words`);
      continue;
    }
    if ((p.pg && p.pg.tokens ? p.pg.tokens.join(' ') : '') !== e.reads || (p.quote || '') !== e.quote) {
      refused.push(`${f.open_question}: the recorded witness reading does not match the batch's own point record`);
      continue;
    }
    const have = Array.isArray(rule.evidence) ? rule.evidence : [];
    if (have.some((x) => x.kind === 'witness' && x.witness === e.witness && x.reads === e.reads)) continue;
    rule.evidence = have.concat([e]);
    stamped++;
  }
  /* WHAT BECAME OF THE OTHER OPEN QUESTIONS, measured rather than left silent.
   * The brief's premise was that the witness SETTLES the 80 questions it locates;
   * MEASURED, most are not a like-for-like pair of readings at all, and the reason
   * differs by class. Each located question gets its class here, and the classes
   * are read from the point record, not asserted. */
  const settledIds = new Set((spec.findings || []).map((f) => f.open_question));
  const outcomes = openBatch
    .filter((p) => p.status === 'located')
    .map((p) => {
      const key = String(p.id).split(' ')[0];
      const ours = tokenizeOur(p.passage);
      const wit = (p.pg && p.pg.tokens) || [];
      const witL = wit.map((w) => String(w).toLowerCase());
      let cls;
      if (settledIds.has(key)) cls = 'SETTLED — the witness supplies the reading (a rule in this version)';
      else if (ours.length && witL.join(' ') === ours.join(' ')) cls = 'settled WITHOUT a change — the witness reads the passage exactly as the transcription has it';
      else if (p.pg && p.pg.n <= 3) cls = 'not settled — the witness carries ≤3 tokens at the point (a footnote mark, a numeral or a Greek run it drops)';
      else if (!ours.length) cls = 'not settled — the passage is a mark-only fragment our own tokeniser reads as no words';
      else {
        const del = ours.filter((w) => !witL.includes(w));
        const ins = witL.filter((w) => !ours.includes(w));
        if (del.every((w) => /^[0-9]+$/.test(w)) && ins.every((w) => /^[0-9]+$/.test(w)))
          cls = 'not settled — the only difference is a NUMERAL (a footnote or page number), which a re-flowed witness renumbers';
        else if (del.length + ins.length <= 3 && ins.every((w) => /^[a-z]+$/.test(w)))
          cls = 'SETTABLE but not settled in this version — the words differ by ≤3 tokens and the witness supplies a word';
        else cls = 'not settled — the witness’s stretch is not a like-for-like pair with ours (a running head, a page-break fragment, or a Greek run the witness drops)';
      }
      return { open_question: key, leaf: p.leaf, volume: p.volume, tight: !!p.tight, class: cls, ours_windows: ours.length, witness_tokens: wit.length, witness_reads: wit.join(' ') };
    });
  writeFileSync(opt('out', join(ROOT, 'tools', 'edits', `${slug}.open-outcomes.json`)), `${JSON.stringify({ slug, tool: 'tools/pg-act.mjs --stamp-open', batch: opt('open-batch', '/var/tmp/pg-locate/open-r24.json'), n: outcomes.length, by_class: outcomes.reduce((m, o) => ((m[o.class] = (m[o.class] || 0) + 1), m), {}), outcomes }, null, 1)}\n`);
  console.log(`  ${outcomes.length} located open question(s) classified; wrote ${opt('out', join(ROOT, 'tools', 'edits', `${slug}.open-outcomes.json`))}`);

  if (refused.length) for (const r of refused) console.error(`  REFUSED ${r}`);
  writeFileSync(rulesFile(TO), `${JSON.stringify(raw, null, 1)}\n`);
  for (const a of alreadySettled) console.log(`  ALREADY SETTLED ${a}`);
  console.log(`${slug}: stamped the witness evidence on ${stamped} open-question rule(s); already settled by an existing rule ${alreadySettled.length}; refused ${refused.length}`);
  process.exit(refused.length ? 1 : 0);
}

const srcRaw = JSON.parse(readFileSync(rulesFile(FROM), 'utf8'));
const batch = JSON.parse(readFileSync(BATCH, 'utf8'));
const points = batch.points;

/* ---------- the witness records the evidence entry names --------------------- */

const wit = JSON.parse(readFileSync(join(EDITION, 'witnesses.json'), 'utf8'));
const PG = new Map();
for (const w of wit.witnesses || []) {
  if (!/^gutenberg-\d+-vol[12]$/.test(w.name || '')) continue;
  PG.set(w.name, w);
}
/** The witness of a volume, by the record's own NAME (`gutenberg-77393-vol1`),
 * which is the last two characters of the name. */
const pgFor = (volume) => {
  for (const w of PG.values()) if (String(w.name).endsWith(`-${volume}`)) return w;
  return null;
};

/** The evidence entry a CLEARED rule carries. It is NOT a leaf entry: it has no
 * `leaf` and no `file`, which is the discriminator the build's consumers read
 * (`leafEntry`), so no count of "read off a page image" moves and the unanswered
 * -leaf worklist does not list a witness as a leaf. */
function witnessEntry(p, why) {
  const w = pgFor(p.volume);
  const srcrec = (w && w.source) || {};
  return {
    kind: 'witness',
    witness: w ? w.name : `Project Gutenberg vol. ${p.volume}`,
    ebook: srcrec.ebook != null ? srcrec.ebook : null,
    /* THE READER-FACING ADDRESS OF THE WITNESS, not the fetch path: the raw
     * address ends in `.txt`, which the leak gate refuses in rendered output (a
     * reader must not meet the workshop's source files). The exact bytes this
     * witness was fetched as are pinned in the edition's own witnesses.json. */
    url: srcrec.ebook != null ? `https://www.gutenberg.org/ebooks/${srcrec.ebook}` : null,
    source: srcrec.credit || 'Project Gutenberg, human-proofread from page images',
    volume: p.volume,
    form: 'WORD-LEVEL transcription of the print, human-proofread: no page, line, running head, mark or word-space is modelled',
    placement: p.tight
      ? 'both bounds stand hard against the point (slide 0/0)'
      : `a bound moved ${Math.max(p.slide.left, p.slide.right)} token(s) off the damaged words (slide ${p.slide.left}/${p.slide.right}) — a bound cannot stand on a word the print corrects`,
    reads: (p.pg && p.pg.tokens ? p.pg.tokens.join(' ') : '') || (p.decide && p.decide.window) || '',
    quote: p.quote || '',
    why,
  };
}

/* ---------- the subclassification of a rule the witness reads AGAINST --------
 * The same ordered decision tools/pg-locate-report.mjs applies, so the two
 * records can be read against each other. It is NOT re-derived by importing the
 * report (which reads its own hardcoded batch names): the tests are the
 * classifier's, restated here, and the counts are ASSERTED against the record's
 * own worklist below, so a drift in either is caught. */
const CLASSES = {
  emendation: 'print-error-emendation',
  insertion: 'insertion',
  contradiction: 'contradiction',
  third: 'third-form',
  thirdGarble: 'third-form-on-our-own-garble',
};
function classify(d) {
  const before = (d.changed && d.changed.before) || [];
  const after = (d.changed && d.changed.after) || [];
  const beforeIsAReading = before.length > 0 && before.every((w) => w.wordlist);
  if (d.verdict === 'third') return beforeIsAReading ? CLASSES.third : CLASSES.thirdGarble;
  if (d.after_words > d.before_words || (!before.length && after.length)) return CLASSES.insertion;
  if (before.some((w) => !w.wordlist)) return CLASSES.emendation;
  if (before.length && before.every((w) => w.uses !== null && w.uses <= 1) && after.some((w) => w.uses !== null && w.uses >= 1))
    return CLASSES.emendation;
  return CLASSES.contradiction;
}

/* ---------- the one editorial intervention: correct the TARGET --------------
 * Six third-form cases where the witness reads a word of the print's own where
 * our rule's target was a different guess. Each correction is ASSERTED: the new
 * target's tokens must occur in the witness's own quoted stretch, so it is taken
 * from the witness and not from memory. */
const CORRECTIONS = {
  'r8600': { after: 'to introduce in this dialogue', why: 'the print reads "to introduce in this dialogue" — our target added "into", which the print does not carry' },
  'r8617': { after: 'For hebdomadic multitude', why: 'the print sets "hebdomadic" as ONE word; our target invented "the hebdomad is a"' },
  'r8923': { after: 'beginning, or end', why: 'the print reads "or"; our target guessed "nor"' },
  'r8991': { after: 'of the past, and', why: 'the print reads "past"; our target guessed "monad"' },
  'r10442': { after: 'coextended', why: 'the print reads "coextended"; our target corrected only as far as "connected"' },
  'r11100': { after: 'unical', why: 'the print reads "unical"; our target guessed "united"' },
};
const plain = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const carriedBy = (p, text) => {
  const hay = plain(`${p.quote || ''} ${p.decide && p.decide.window ? p.decide.window : ''} ${p.pg && p.pg.tokens ? p.pg.tokens.join(' ') : ''}`);
  const needle = plain(text);
  return needle.length > 0 && hay.includes(needle);
};

/* ---------- the decisions --------------------------------------------------- */

/* The cleared list: one entry per rule whose flag this unit clears, with the
 * witness's own words at the point — the record of what was acted on. */
const cleared = [];
const kept = [];
const against = [];
const corrected = [];
const bad = [];

for (const p of points) {
  const id = p.id.split(':')[1];
  if (p.status !== 'located') continue; // refused: not acted on, the flag stands
  const d = p.decide || { verdict: 'not-decided' };
  if (d.verdict === 'after') {
    const whole = d.basis === 'the whole reading';
    if (p.tight || whole) {
      cleared.push({
        id,
        why: p.tight
          ? 'the witness carries the rule’s `after` reading at this point, both bounds hard against it'
          : `the witness carries the rule’s WHOLE \`after\` reading at this point, not the changed fragment (a bound moved ${Math.max(p.slide.left, p.slide.right)} token(s) off the damaged words)`,
        verdict: d.verdict,
        basis: d.basis,
        volume: p.volume,
        tight: p.tight,
        slide: p.slide,
        at: p.at,
        reads: (p.pg && p.pg.tokens) || null,
        quote: p.quote || null,
      });
    } else {
      kept.push({
        id,
        why: 'the witness confirms the reading, but the placement is SLID and the confirmation rests on the CHANGED fragment alone (1–2 common words) — the whole reading is what anchors a slid placement, so the flag stands',
        verdict: d.verdict,
        basis: d.basis,
        volume: p.volume,
        tight: p.tight,
        reads: (p.pg && p.pg.tokens) || null,
      });
    }
    continue;
  }
  /* EVERY OTHER LOCATED VERDICT IS EVIDENCE THE WITNESS READS AGAINST THE RULE. */
  const cls = classify(d);
  if (d.verdict === 'silent-marks' || d.verdict === 'silent-unsure' || d.verdict === 'absent-at-point' || d.verdict === 'thin-stretch' || d.verdict === 'no-change') {
    kept.push({
      id,
      why:
        d.verdict === 'silent-marks'
          ? 'UNDECIDABLE BY DESIGN: the two readings are the same WORDS (the change is to marks or case) and a re-flowed witness carries neither'
          : d.verdict === 'silent-unsure'
            ? 'the rule’s own `after` is not a reading (`unsure`) — the witness has no second reading to weigh'
            : d.verdict === 'absent-at-point'
              ? 'the witness carries 0–2 tokens at the point (footnote marker, numeral, Greek or nothing) — the passage is not in the witness'
              : d.verdict === 'thin-stretch'
                ? 'the witness carries exactly 3 tokens at the point — neither a reading nor nothing'
                : 'the rule changes no mark',
      verdict: d.verdict,
      class: d.verdict === 'silent-marks' ? 'undecidable-marks' : 'undecidable',
      volume: p.volume,
      tight: p.tight,
      reads: (p.pg && p.pg.tokens) || null,
    });
    continue;
  }
  const entry = {
    id,
    class: cls,
    verdict: d.verdict,
    basis: d.basis,
    volume: p.volume,
    tight: p.tight,
    before: p.before,
    after: p.after,
    reads: (p.pg && p.pg.tokens) || null,
    quote: p.quote || null,
    changed: d.changed || null,
  };
  if (CORRECTIONS[id]) {
    const c = CORRECTIONS[id];
    if (!carriedBy(p, c.after)) {
      bad.push(`${id}: the correction ${JSON.stringify(c.after)} is NOT carried by the witness’s own quoted words — refused`);
      against.push({ ...entry, action: 'keep', why: 'the proposed correction failed its own witness assertion' });
      continue;
    }
    corrected.push({ ...entry, action: 'correct-the-target', new_after: c.after, why: c.why });
    continue;
  }
  against.push({
    ...entry,
    action: 'keep',
    why:
      cls === CLASSES.emendation
        ? 'PRINT-ERROR EMENDATION, NOT REVERTED: the print’s own text at the point is at fault and this rule deliberately corrects it; the witness transcribes the print faithfully, so its agreement there is not evidence against the emendation'
        : cls === CLASSES.insertion
          ? 'NOT A READING: the rule ADDS words, so the witness’s `before` is what the print reads without them; there is no like-for-like pair of readings to weigh'
          : cls === CLASSES.thirdGarble
            ? 'NO EVIDENCE EITHER WAY: the witness reads words of its own at the point and our own `before` is the transcription’s GARBLE, so the witness’s words are not evidence about this rule at all'
            : cls === CLASSES.contradiction
              ? 'THE PRINT CARRIES THE FORM THIS RULE CHANGES: the witness reads our `before` here, so this is an EMENDATION OF THE PRINT and not an OCR repair — recorded, the reading left standing, the flag kept'
              : 'THE PRINT READS A THIRD FORM: our `before` IS a reading of the print and the witness reads neither of the rule’s two readings here',
  });
}

/* ---------- ASSERT the subdivision against the record’s own worklist -------- */

const record = JSON.parse(readFileSync(join(ROOT, 'tools', 'edits', `${slug}.pg-locate.json`), 'utf8'));
const names = record.UNIT_B_MAY_ACT_ON;
const idsOf = (a) => a.map((s) => s.split(':')[1]);
const expect = new Map([
  [CLASSES.emendation, idsOf(names.of_which_PRINT_ERROR_EMENDATIONS_it_must_NOT_revert)],
  [CLASSES.insertion, idsOf(names.of_which_INSERTIONS_it_must_NOT_treat_as_a_reading)],
  [CLASSES.contradiction, idsOf(names.of_which_CONTRADICTIONS_it_must_adjudicate)],
  [CLASSES.third, idsOf(names.of_which_THIRD_FORM_on_a_real_before_reading)],
  [CLASSES.thirdGarble, idsOf(names.NO_EVIDENCE_EITHER_WAY_third_form_on_our_own_garble)],
]);
for (const [cls, want] of expect) {
  const got = against
    .concat(corrected)
    .filter((a) => a.class === cls)
    .map((a) => a.id)
    .sort();
  const w = want.slice().sort();
  if (JSON.stringify(got) !== JSON.stringify(w))
    throw new Error(
      `pg-act: the ${cls} subclass disagrees with the record's own worklist — derived ${got.length} (${got.slice(0, 4).join(', ')}), record ${w.length} (${w.slice(0, 4).join(', ')})`,
    );
}

/* ---------- the record ------------------------------------------------------ */

const counts = {
  review_flagged_rules_considered: points.length,
  CLEARED: cleared.length,
  of_which_TIGHT: cleared.filter((c) => c.tight).length,
  of_which_SLID_ON_THE_WHOLE_READING: cleared.filter((c) => !c.tight).length,
  KEPT_FLAGGED_on_a_located_point: kept.length,
  of_which_undecidable_marks: kept.filter((k) => k.class === 'undecidable-marks').length,
  EVIDENCE_AGAINST: against.length + corrected.length,
  of_which_corrected_target: corrected.length,
  refused_not_acted_on: points.filter((p) => p.status !== 'located').length,
};
const out = {
  slug,
  tool: 'tools/pg-act.mjs',
  what:
    'the human-proofread witness ACTED ON: the review flags it EARNS cleared with the witness recorded in the rule’s own `evidence`, ' +
    'the rules it reads AGAINST recorded with the print’s own words, and the one editorial intervention (a corrected target) asserted against the witness’s quote',
  batch: {
    file: BATCH,
    derived_by: `node tools/pg-locate.mjs ${slug} --what rules --version ${FROM} --slide 24`,
    witnesses: record.witnesses,
  },
  from_version: FROM,
  to_version: TO,
  placement_rule:
    'A TIGHT placement (both bounds hard against the point) clears. A SLID placement — a bound pushed off a damaged word, which is what the print FORCES because the print reads the corrected word there — ' +
    'clears when the witness carries the rule’s WHOLE after-reading at the point, because a whole reading is the print’s own words in the right place while the changed fragment is 1–2 common words that locate text without witnessing a repair. ' +
    'MEASURED: the marginal yield of the slide knob is ENTIRELY non-tight, so this split is reported rather than hidden.',
  counts,
  /* THE HEADLINE, from the batch: what was placed, what the witness reads, and the
   * brief's own numbers where they are refuted by measurement. */
  measured: {
    review_flagged_rules: points.length,
    located: points.filter((p) => p.status === 'located').length,
    located_by_volume: { vol1: points.filter((p) => p.status === 'located' && p.volume === 'vol1').length, vol2: points.filter((p) => p.status === 'located' && p.volume === 'vol2').length },
    located_tight: points.filter((p) => p.status === 'located' && p.tight).length,
    CLEARED: cleared.length,
    cleared_tight: cleared.filter((c) => c.tight).length,
    cleared_slid_on_the_whole_reading: cleared.filter((c) => !c.tight).length,
    kept_flagged_on_a_located_point: kept.length,
    evidence_against_the_rule: against.length + corrected.length,
    refused_not_acted_on: points.filter((p) => p.status !== 'located').length,
    of_the_brief_s_95: {
      print_error_emendation_not_reverted: against.concat(corrected).filter((a) => a.class === CLASSES.emendation).length,
      insertion: against.concat(corrected).filter((a) => a.class === CLASSES.insertion).length,
      contradiction_the_print_carries_our_before: against.concat(corrected).filter((a) => a.class === CLASSES.contradiction).length,
      third_form_on_a_real_before_reading: against.concat(corrected).filter((a) => a.class === CLASSES.third).length,
      third_form_on_our_own_garble: against.concat(corrected).filter((a) => a.class === CLASSES.thirdGarble).length,
    },
    brief_refutations: [
      'The brief reads the 33 as "6 print-error emendations do not get reverted" and the rest as contradictions or third forms to correct or withdraw. MEASURED: 14 of the 25 are rules whose target the print does not read AND whose `before` IS a reading of the print — i.e. the print carries the very form the rule changes. Whether that is a wrong guess or an emendation of the print’s own misprint is an EDITORIAL decision the witness cannot make, and this unit does not revert a print misprint into a published edition: they are recorded, with the print’s own words, and the flag stays.',
      'The brief’s "62 third forms that carry no evidence are not confirmations and must NOT be cleared" is RIGHT and is done: they keep the flag and their rationale now says the witness’s words there are no evidence about the rule, because our own `before` is the transcription’s garble.',
      'The brief says the 1,267 confirmations clear. MEASURED and decided: 1,265 clear. The two that do not are SLID placements confirmed on the CHANGED FRAGMENT alone — see placement_rule above.',
      'Only 4 of the 80 located open questions are settled by a new rule; 2 more are already settled by rules the edition records and the witness AGREES with, and 9 the witness reads identically. The other 65 are refused with a measured reason — the brief’s "the witness answers 80" is true of PLACEMENT, not of settlement.',
    ],
  },
  /* THE PUNCTUATION SURFACE, STATED LOUDLY BECAUSE IT IS THE ONE THE WITNESS
   * CANNOT TOUCH. A re-flowed, case-normalised, unpunctuated transcription
   * confirms a READING and never our typography: MEASURED, of this edition's 786
   * punctuation rules 578 have their point placed and 473 of those differ from
   * the witness in MARKS OR CASE ALONE — undecidable BY DESIGN, not a fact about
   * the witness. NONE of them is cleared: the review worklist this unit acts on
   * carries none of them (they are typed `punctuation` and were never flagged), so
   * a located-but-identical span is recorded here as undecidable and the rule is
   * left exactly as it stands. */
  punctuation: (() => {
    const batch = JSON.parse(readFileSync('/var/tmp/pg-locate/punct-r24.json', 'utf8')).points;
    const withD = batch.filter((p) => p.decide);
    const marks = withD.filter((p) => p.decide.verdict === 'silent-marks').length;
    return {
      rules: batch.length,
      located: batch.filter((p) => p.status === 'located').length,
      undecidable_on_marks_or_case_alone: marks,
      cleared_by_this_unit: 0,
      why:
        'a re-flowed witness carries no punctuation and no case, so a rule whose two readings are the same WORDS cannot be decided from it however exactly the passage is located — the located-but-identical span is NOT evidence for the typography',
    };
  })(),
  /* WHAT BECAME OF THE OPEN QUESTIONS the witness places, from the outcome file
   * this tool's own --stamp-open mode writes. */
  open_questions: (() => {
    const f = join(ROOT, 'tools', 'edits', `${slug}.open-outcomes.json`);
    if (!existsSync(f)) return null;
    const o = JSON.parse(readFileSync(f, 'utf8'));
    return { n_located: o.n, by_class: o.by_class };
  })(),
  cleared,
  kept,
  against,
  corrected,
  /* THE RETIREMENT, derived the same way the write derives it: a corrected target
   * may not be written under the id a reader cited in the previous version, so the
   * old rule is retired (its id stays spent and is recorded as withdrawn) and the
   * corrected rule is appended under a fresh id. The ids are allocated from the
   * source version's own maximum, so a dry run names exactly what the write will. */
  retired: (() => {
    let n = Math.max(...srcRaw.rules.map((r) => Number((/:r(\d+)$/.exec(r.id) || [])[1]) || 0)) + 1;
    return corrected.map((c) => {
      const was = srcRaw.rules.find((r) => r.id.endsWith(`:${c.id}`));
      const out = { old_id: was.id, new_id: `${slug}:r${String(n).padStart(4, '0')}`, find: was.location.find, was: was.after, now: c.new_after, why: c.why };
      n += 1;
      return out;
    });
  })(),
  refusals: bad,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${slug}: CLEARED ${cleared.length} (tight ${counts.of_which_TIGHT}, slid-on-the-whole-reading ${counts.of_which_SLID_ON_THE_WHOLE_READING})`);
console.log(`  KEPT FLAGGED on a located point ${kept.length} (marks-only ${counts.of_which_undecidable_marks})`);
console.log(`  EVIDENCE AGAINST ${counts.EVIDENCE_AGAINST} — corrected target ${corrected.length}, kept ${against.length}`);
console.log(`  REFUSED, not acted on ${counts.refused_not_acted_on}`);
console.log(`  wrote ${OUT}`);
if (bad.length) for (const b of bad) console.error(`  REFUSED CORRECTION ${b}`);

/* ---------- apply ----------------------------------------------------------- */

if (!write) {
  console.log('  dry run (no --write): the rules were NOT touched');
  process.exit(bad.length ? 1 : 0);
}
if (!existsSync(rulesFile(TO))) {
  console.error(`pg-act: ${rulesFile(TO)} does not exist — copy the version first (docs/DOI.md)`);
  process.exit(2);
}
const rules = srcRaw.rules.map((r) => JSON.parse(JSON.stringify(r)));
const byId = new Map(rules.map((r) => [r.id.split(':')[1], r]));
let nClear = 0;
let nCorr = 0;
let nNote = 0;
for (const c of cleared) {
  const r = byId.get(c.id);
  if (!r) throw new Error(`pg-act: no rule ${c.id}`);
  if (!r.review) throw new Error(`pg-act: ${c.id} is not review-flagged — the clear would claim nothing`);
  r.review = false;
  r.evidence = (Array.isArray(r.evidence) ? r.evidence : []).concat([witnessEntry(points.find((p) => p.id.endsWith(`:${c.id}`)), c.why)]);
  nClear++;
}
/* A CORRECTED TARGET IS A NEW RULE, NOT AN EDITED ONE. Model §4.2 + tools/repair-id-probe.mjs:
 * an id carries ONE rule forever, so "the print reads what the witness says" may
 * not be written under the old id — a reader who cited r8617 in 1.0.3 would find a
 * different rule under it. So the old rule is RETIRED (removed; its id stays spent
 * and is recorded as withdrawn, exactly as r11680–r11686 are) and the corrected
 * rule is APPENDED under a fresh id. The find is unchanged, so the rule still
 * fires; only where in the order it is applied moves, and the build's own fire
 * contract is what proves that moving it is safe. */
let nextId = Math.max(...rules.map((r) => Number((/:r(\d+)$/.exec(r.id) || [])[1]) || 0)) + 1;
const retired = [];
for (const c of corrected) {
  const r = byId.get(c.id);
  if (!r) throw new Error(`pg-act: no rule ${c.id}`);
  const p = points.find((x) => x.id.endsWith(`:${c.id}`));
  const at = rules.findIndex((x) => x.id === r.id);
  if (at < 0) throw new Error(`pg-act: ${c.id} is not in the rule list`);
  const nid = `${slug}:r${String(nextId).padStart(4, '0')}`;
  nextId += 1;
  const fresh = JSON.parse(JSON.stringify(r));
  fresh.id = nid;
  fresh.after = c.new_after;
  fresh.rationale = `${r.rationale} CORRECTED ${TO}: the print reads ${JSON.stringify(c.new_after)} here — the corrected target is taken from Project Gutenberg’s human-proofread transcription of the 1816 print (${c.volume}, its own words: ${JSON.stringify((p.pg && p.pg.tokens) || [])}), not from ours. ${c.why}.`;
  fresh.review = false;
  fresh.evidence = (Array.isArray(r.evidence) ? r.evidence : []).concat([witnessEntry(p, c.why)]);
  rules.splice(at, 1);
  rules.push(fresh);
  retired.push({ old_id: r.id, new_id: nid, find: r.location.find, was: r.after, now: c.new_after, why: c.why });
  nCorr++;
}
for (const a of against.concat(kept.filter((k) => !k.class))) {
  const r = byId.get(a.id);
  if (!r) continue;
  if (!r.review) continue;
  const p = points.find((x) => x.id.endsWith(`:${a.id}`));
  r.rationale = `${r.rationale} WITNESS ${TO}: Project Gutenberg’s human-proofread transcription of the 1816 print reads ${JSON.stringify((p.pg && p.pg.tokens) || [])} at this point (${a.volume}${p.tight ? ', tight' : ', slid'}). ${a.why}`;
  nNote++;
}
writeFileSync(rulesFile(TO), `${JSON.stringify({ ...srcRaw, version: TO, rules }, null, 1)}\n`);
for (const t of retired) console.log(`  RETIRED ${t.old_id} -> ${t.new_id}: ${JSON.stringify(t.find)} ${JSON.stringify(t.was)} -> ${JSON.stringify(t.now)}`);
console.log(`  WROTE ${rulesFile(TO)}: ${nClear} flag(s) cleared, ${nCorr} target(s) corrected (each as a NEW id, the old id retired), ${nNote} rationale(s) annotated`);
const rec = JSON.parse(readFileSync(OUT, 'utf8'));
rec.retired = retired;
rec.how_to_rederive = [
  `node tools/pg-locate.mjs ${slug} --what rules --version ${FROM} --slide 24 --out ${BATCH}`,
  `node tools/pg-act.mjs ${slug} --from-version ${FROM} --to-version ${TO} --batch ${BATCH} --write`,
  `node tools/merge.mjs ${slug} --from tools/edits/${slug}.open-findings.json --write`,
  `node tools/pg-act.mjs ${slug} --to-version ${TO} --stamp-open`,
];
writeFileSync(OUT, `${JSON.stringify(rec, null, 1)}\n`);
