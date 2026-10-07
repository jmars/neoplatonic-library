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
 * THE CLEARING BASIS IS ONE TEST, THE SAME FOR A TIGHT PLACEMENT AND A SLID ONE:
 * the witness must carry the rule's WHOLE `after` reading at the point. Until
 * 1.0.5 a TIGHT placement ALSO cleared on the CHANGED WORDS alone, which a slid
 * placement was rightly refused — the same rule cleared or kept according to how
 * the point happened to sit. MEASURED, that basis certified more than the witness
 * holds: at r8961 the witness reads `as in images the` while the rule's own
 * `after` is `as images the`, so the clear stood on a reading the witness does not
 * carry. A changed fragment is one or two common words and is what LOCATES nearby
 * text; it is not what witnesses a repair. The record states, per clear, which
 * test decided it (`basis`).
 *
 * WHAT IT REFUSES TO DO:
 *   - clear a rule whose `evidence` would then claim a page image it does not
 *     have (the entry carries no leaf: see `leafEntry` in the build);
 *   - KEEP a rule that puts a reading the print does not carry into the edition
 *     on the strength of a conclusion no measurement supports. Where the witness
 *     reads our `before`, the print's own form there is MEASURED, and unless one
 *     of the two misprint signals fires (see `classify`) the rule is not a
 *     repaired misprint: it OVERRIDES the print. The print's own text is what the
 *     version then serves (the rule is WITHDRAWN, its id spent), except where the
 *     rule's own `find` carries a mark the print cannot set — there the rule does
 *     real work and only its target was wrong, so the target is CORRECTED to the
 *     print's own words and the old id retired (model 4.2). MEASURED on 1.0.4: 12
 *     withdrawn, 2 corrected.
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
 * own worklist below, so a drift in either is caught.
 *
 * WHAT A CLASS NAME MAY CLAIM, AND WHAT IT MAY NOT. A class name is a claim about
 * the print, and it may claim only what was MEASURED. `print-error-emendation` is
 * the ONLY class that says the print's own form is at fault, and since 1.0.6 it
 * requires a POSITIVE TEST of the print — THREE measurements, ALL of which must
 * hold (see `printIsAtFault`):
 *
 *   (1) the form the print reads here is NOT a word of the reference wordlist;
 *   (2) the print uses that form NOWHERE ELSE in its own text (<=1x in both
 *       volumes together) — a form it sets four times is its own ORTHOGRAPHY;
 *   (3) the rule's target IS what the print reads ELSEWHERE, used MORE OFTEN
 *       than the form it changes away from.
 *
 * WHAT THIS REPLACED, MEASURED 2026-10-07 (the seventh-DOI unit), and why a
 * "signal" is not a test: 1.0.5's two signals were W (a changed word is absent
 * from the reference wordlist) and R (the form is used <=1x while the target is
 * used >=1x). W licensed the at-fault verdict on r9734 (the print sets
 * `consubsists` once, a real form merely missing from the dictionary, and the
 * rule's target `consubsist` occurs 0x in the print's whole vocabulary) and on
 * r10277 (`rythm`, the print's DOMINANT spelling: 4x + rythms 1x against rhythm
 * 2x + rhythms 1x). R licensed it on r8627 from a 1x-vs-1x TIE (prophesy 1x,
 * prophecy 1x). A tie and a minority-spelling modernisation decided that the
 * PRINT was at fault in a DOI-minted edition. The verdict is now unreachable
 * without a positive measurement, and the TIE has its own class
 * (`indeterminate-tie`) whose action is to KEEP the flag: what it records is
 * that the witness's own counts decide nothing.
 *
 * Until 1.0.5 the class the third signal-less case fell into was called
 * `contradiction` and its why-string then ASSERTED "this is an EMENDATION OF THE
 * PRINT ... the reading left standing" — a conclusion the measurement does not
 * entail. The measurement (the witness reads our `before`) is the DEFINITION of a
 * `before` verdict, so it distinguished nothing, and NO TEST ASKED WHETHER THE
 * PRINT'S FORM IS AN ERROR. That is the whole defect: the class was named after
 * the conclusion it wanted. The class is now named after what was measured —
 * `print-carries-our-before` — and its action follows from the rule's own `find`,
 * not from a verdict about the print (see `printImpossibleMark`).
 *
 * A THIRD CANDIDATE SIGNAL WAS TRIED AND REJECTED, because a test that passes the
 * wrong cases is not a test. `phrase-idiolect`: the rule's target PHRASE occurs in
 * the print while the form the rule changes occurs nowhere else. MEASURED on the
 * 14 rules of 1.0.4 the reviewer reopened, it fires for the rules the measurement
 * REFUTES — r8906 (`the once for` 1x against `the one for` 62x over both PG volumes — 36x in vol. I and 26x in vol. II; the 1.0.4 record's `36x` was the vol. I count alone, recorded under a heading that said 'both volumes'), where the print
 * sets `_the once_` in ITALICS and glosses it with the Greek (τῷ ἅπαξ, its own
 * bytes at gutenberg-78800-vol2.txt:19967), and r8619 (`these celestial` 1x
 * against `the celestial` 178x), a determiner the reviewer called a taste swap —
 * and it does NOT fire for r8574/r8599/r8683/r8944, the four the reviewer called
 * defensible (`the first intellectual` 19x against `first intellectuals` 4x;
 * `and bound` 15x against `and bounds` 7x; `though their` 3x against `through
 * their` 30x with `parts though` 2x against `parts through` 2x). It partitions
 * nothing, and the numbers are in the record under `rejected_signals`.
 */
const CLASSES = {
  emendation: 'print-error-emendation',
  insertion: 'insertion',
  contradiction: 'print-carries-our-before',
  tie: 'indeterminate-tie',
  third: 'third-form',
  thirdGarble: 'third-form-on-our-own-garble',
};
/** THE POSITIVE TEST FOR `THE PRINT IS AT FAULT`. All three conditions are
 * measurements OF THE PRINT, and all three must hold; ANYTHING ELSE fails the
 * test and the rule may not claim the print is at fault. Restated here from
 * tools/pg-locate-report.mjs (the two records must agree) and asserted against
 * that record's own worklist below, so a drift in either is caught. */
const topUses = (ws) => Math.max(...ws.filter((w) => w.uses !== null).map((w) => w.uses), -1);
function printIsAtFault(before, after) {
  if (!before.length || !after.length) return null;
  const b = before.filter((w) => w.uses !== null);
  const a = after.filter((w) => w.uses !== null);
  if (b.length !== before.length) return null; // a damage token is not a form the print can set
  if (!b.every((w) => !w.wordlist)) return null; // (1) not a word of the language
  if (!b.every((w) => w.uses === 1)) return null; // (2) used nowhere else in the print
  if (!a.length) return null;
  if (!(topUses(a) > topUses(b))) return null; // (3) the print reads our target elsewhere, MORE often
  return {
    signal: 'F',
    why:
      `THE PRINT IS AT FAULT — MEASURED: the print’s own form here (${b.map((w) => `“${w.w}”`).join(', ')}) is not a word of the reference wordlist and the print uses it NOWHERE ELSE in its own text ` +
      `(${b.map((w) => `${w.uses}×`).join(', ')}), while it reads our target (${a.map((w) => `“${w.w}” ${w.uses}×`).join(', ')}) elsewhere and MORE often — so this rule deliberately repairs a misprint of the print, and the witness, which transcribes the print faithfully, cannot overrule it`,
  };
}
/** THE TIE. The print uses the form at the point and the rule's target the SAME
 * number of times, so neither the print's habit nor a fault of its own form is
 * measured. The flag STANDS: this is a case for a human, not for a verdict. */
function theTie(before, after) {
  const b = before.filter((w) => w.uses !== null);
  const a = after.filter((w) => w.uses !== null);
  if (!b.length || !a.length || b.length !== before.length) return null;
  if (!(topUses(a) === topUses(b) && topUses(b) >= 1)) return null;
  return {
    signal: 'T',
    why:
      `INDETERMINATE BY TIE — MEASURED: the print uses the form it reads here (${b.map((w) => `“${w.w}” ${w.uses}×`).join(', ')}) and this rule’s target (${a.map((w) => `“${w.w}” ${w.uses}×`).join(', ')}) the SAME number of times, so the witness’s own counts decide NOTHING: they do not show the print’s form is a misprint and they do not show it is the reading. A 1×-vs-1× tie from a re-flowed witness licenses no verdict in either direction, so the flag STANDS and the point is left for a human`,
  };
}
function classify(d) {
  const before = (d.changed && d.changed.before) || [];
  const after = (d.changed && d.changed.after) || [];
  const beforeIsAReading = before.length > 0 && before.every((w) => w.wordlist);
  if (d.verdict === 'third') return beforeIsAReading ? CLASSES.third : CLASSES.thirdGarble;
  if (d.after_words > d.before_words || (!before.length && after.length)) return CLASSES.insertion;
  if (printIsAtFault(before, after)) return CLASSES.emendation;
  if (theTie(before, after)) return CLASSES.tie;
  return CLASSES.contradiction;
}
/** The measured fact a name may not overstate, as ONE string: what the print reads
 * at the point, how often the print uses that form anywhere in its own text, and
 * whether either misprint signal fired. Stated identically everywhere it is
 * written, so no consumer can drift into the old conclusion. */
const carriesOurBefore = (d) => {
  const before = (d.changed && d.changed.before) || [];
  const after = (d.changed && d.changed.after) || [];
  return (
    `THE PRINT CARRIES THE FORM THIS RULE CHANGES — MEASURED: the witness reads our \`before\` here; the print’s own form is an ordinary word of its own vocabulary ` +
    `(${before.map((w) => `“${w.w}” ${w.uses === null ? 'not countable' : `${w.uses}×`}`).join(', ')}) against the rule’s target ` +
    `(${after.map((w) => `“${w.w}” ${w.uses === null ? 'not countable' : `${w.uses}×`}`).join(', ') || 'nothing'}), and the POSITIVE TEST FOR A FAULT OF THE PRINT’S OWN FORM DOES NOT HOLD ` +
    `(${before.some((w) => w.uses === null) ? 'the form it changes away from carries a damage token, so there is no form of the print to measure' : before.some((w) => w.wordlist) ? 'the print’s form is a word of the reference wordlist' : before.some((w) => w.uses > 1) ? 'the print uses that form elsewhere in its own text, so it is the print’s own spelling' : 'the print uses the rule’s target no more often than the form it changes away from'}) — so no measurement shows the print at fault. ` +
    `ACTION FROM THE RULE’S OWN \`find\`, not from a verdict about the print: see \`printImpossibleMark\`.`
  );
};
/** Whether the rule's own `find` carries a mark the print cannot set — the test
 * that says a rule is doing REAL work on the transcription and only its TARGET was
 * wrong (so the target is corrected, model 4.2), as against a rule that overrides
 * a print the transcription already reads. The print sets marks BETWEEN words (a
 * comma, a period, an apostrophe, a quotation mark); it does not set one INSIDE a
 * word, which is what OCR damage looks like (`to-.united`, `inferior- being`). So
 * the test strips the between-word marks from each whitespace piece and asks
 * whether a non-letter, non-digit character is still standing. */
const BETWEEN_WORD_MARKS = /^[,.;:!?'’"()[\]—]+|[,.;:!?'’"()[\]—]+$/g;
const printImpossibleMark = (find) =>
  String(find || '')
    .split(/\s+/)
    .filter(Boolean)
    .some((piece) => /[^A-Za-z0-9]/.test(piece.replace(BETWEEN_WORD_MARKS, '')));


/* ---------- the one editorial intervention: correct the TARGET --------------
 * Cases where our rule's target is not what the print reads. Each correction is
 * ASSERTED: the new target's tokens must occur in the witness's own quoted stretch
 * (`carriedBy`), so it is taken from the witness and not from memory. Two shapes:
 *
 *   - a rule whose `find` carries a mark the print cannot set (`to-.united`,
 *     `inferior- being`): the rule does real work on a damaged transcription and
 *     only its TARGET was a guess, so the target is corrected to the print's own
 *     words (r10120, r9069 — 1.0.5);
 *   - a rule whose `after` is not what the print reads where the witness's own
 *     quoted words show it (r8961: the witness reads `as in images the` and our
 *     target drops `in` — the damaged `m` of `as m intages die` IS the print's
 *     `in`) — 1.0.5, the one case of the 9 changed-words clears with a real WORD
 *     difference rather than a mark or a page number;
 *   - the SIX third-form cases of 1.0.4, where the witness reads a word of the
 *     print's own where our rule's target was a different guess.
 *
 * The SIX of 1.0.4 were applied as NEW ids r11843-r11848 with the old ids retired;
 * an id carries one rule forever (model 4.2), so re-running this tool over 1.0.4
 * (where those ids are already spent and absent) SKIPS them and records the skip —
 * it does not mint them a second time.
 */
const CORRECTIONS = {
  'r8600': { after: 'to introduce in this dialogue', why: 'the print reads "to introduce in this dialogue" — our target added "into", which the print does not carry' },
  'r8617': { after: 'For hebdomadic multitude', why: 'the print sets "hebdomadic" as ONE word; our target invented "the hebdomad is a"' },
  'r8923': { after: 'beginning, or end', why: 'the print reads "or"; our target guessed "nor"' },
  'r8991': { after: 'of the past, and', why: 'the print reads "past"; our target guessed "monad"' },
  'r10442': { after: 'coextended', why: 'the print reads "coextended"; our target corrected only as far as "connected"' },
  'r11100': { after: 'unical', why: 'the print reads "unical"; our target guessed "united"' },
  'r10120': { after: 'to united', why: 'the print reads "to united" — our target added "in", which duplicates the "into" the print sets two words later, and the transcription’s own `find` (`to-.united`) carries a mark the print cannot set' },
  'r9069': { after: 'inferior being', why: 'the print reads the participle "inferior being suspended"; our target added a plural "s" the print does not carry, and the transcription’s own `find` (`inferior- being`) carries a stray hyphen the print cannot set' },
  'r8961': { after: 'as in images the', why: 'the print reads "as in images the" — our target dropped the "in" that the transcription’s damaged `m` stands for' },
  /* r9734 (1.0.6). THE TARGET WAS THE ONE FORM THE PRINT NEVER SETS. MEASURED on
   * the print's own two volumes: the print reads `consubsists` at this point
   * (1x), `consubsistent` 32x — its own coinage — and the rule's target
   * `consubsist` NOWHERE AT ALL (0x). The transcription's own `find`
   * (`consubsistS`) is the print's word with its final `s` mis-cased, so the rule
   * does real work on the transcription and only its TARGET was wrong; the
   * target is corrected to the print's own form and the old id is spent (model
   * 4.2). So the served reading is the print's word, not the transcription's
   * case damage and not the rule's invented singular. */
  'r9734': { after: 'consubsists', why: 'the print reads "consubsists" (1x; and its own `consubsistent` 32x) — our target "consubsist" occurs 0x in the print’s whole vocabulary, and the transcription’s `consubsistS` is the print’s own word with its final `s` mis-cased' },
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
const withdrawn = [];
const bad = [];

for (const p of points) {
  const id = p.id.split(':')[1];
  if (p.status !== 'located') continue; // refused: not acted on, the flag stands
  const d = p.decide || { verdict: 'not-decided' };
  if (d.verdict === 'after') {
    /* ONE BASIS FOR EVERY PLACEMENT. The witness must carry the rule's WHOLE
     * `after` reading; the changed-words fallback never clears, tight or not. */
    const whole = d.basis === 'the whole reading';
    if (whole) {
      cleared.push({
        id,
        why: p.tight
          ? 'the witness carries the rule’s WHOLE `after` reading at this point, both bounds hard against it'
          : `the witness carries the rule’s WHOLE \`after\` reading at this point, not the changed fragment (a bound moved ${Math.max(p.slide.left, p.slide.right)} token(s) off the damaged words)`,
        verdict: d.verdict,
        basis: d.basis,
        volume: p.volume,
        tight: p.tight,
        slide: p.slide,
        at: p.at,
        before: p.before,
        after: p.after,
        reads: (p.pg && p.pg.tokens) || null,
        quote: p.quote || null,
      });
      continue;
    }
    /* The witness carries the reading CONFIRMED ON THE CHANGED WORDS ALONE, which
     * is not the rule's assertion. Where its own words show the rule's target is
     * the wrong reading the target is CORRECTED; otherwise the flag stands. */
    if (CORRECTIONS[id]) {
      const c = CORRECTIONS[id];
      if (!carriedBy(p, c.after)) {
        bad.push(`${id}: the correction ${JSON.stringify(c.after)} is NOT carried by the witness’s own quoted words — refused`);
        kept.push({ id, why: 'the proposed correction failed its own witness assertion — the flag stands', verdict: d.verdict, basis: d.basis, volume: p.volume, tight: p.tight, before: p.before, after: p.after, reads: (p.pg && p.pg.tokens) || null });
        continue;
      }
      corrected.push({
        id,
        class: 'after-on-the-changed-words',
        action: 'correct-the-target',
        new_after: c.after,
        why: c.why,
        verdict: d.verdict,
        basis: d.basis,
        volume: p.volume,
        tight: p.tight,
        before: p.before,
        after: p.after,
        reads: (p.pg && p.pg.tokens) || null,
        quote: p.quote || null,
      });
      continue;
    }
    kept.push({
      id,
      why:
        'THE CONFIRMATION RESTS ON THE CHANGED WORDS ALONE: the witness carries the changed fragment inside the placed stretch, but NOT the rule’s whole `after` reading — and the whole reading is what a clear requires, on a tight placement as much as on a slid one. The flag stands',
      verdict: d.verdict,
      basis: d.basis,
      class: 'changed-words-only',
      volume: p.volume,
      tight: p.tight,
      before: p.before,
      after: p.after,
      reads: (p.pg && p.pg.tokens) || null,
      quote: p.quote || null,
    });
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
  /* THE ACTION FOLLOWS FROM THE CLASS AND THE RULE'S OWN `find` — never from a
   * verdict about the print. A rule the witness reads our `before` at, with no
   * measured misprint signal, OVERRIDES the print; where its own `find` carries a
   * mark the print cannot set it is doing real work and must be corrected instead
   * (and a `find` with a mark but no declared correction is a REFUSAL, not a silent
   * keep). */
  const mark = printImpossibleMark(p.before);
  if (cls === CLASSES.contradiction && !mark) {
    withdrawn.push({ ...entry, action: 'withdraw', why: carriesOurBefore(d) });
  } else {
    against.push({
      ...entry,
      action: 'keep',
      why:
        cls === CLASSES.emendation
          ? printIsAtFault((d.changed && d.changed.before) || [], (d.changed && d.changed.after) || []).why
          : cls === CLASSES.insertion
            ? 'NOT A READING: the rule ADDS words, so the witness’s `before` is what the print reads without them; there is no like-for-like pair of readings to weigh'
            : cls === CLASSES.thirdGarble
              ? 'NO EVIDENCE EITHER WAY: the witness reads words of its own at the point and our own `before` is the transcription’s GARBLE, so the witness’s words are not evidence about this rule at all'
              : cls === CLASSES.tie
                ? theTie((d.changed && d.changed.before) || [], (d.changed && d.changed.after) || []).why
                : cls === CLASSES.contradiction
                  ? `${carriesOurBefore(d)} A correction to the print’s own words is DECLARED for this point in CORRECTIONS and is asserted against the witness’s quote, so this entry is a REFUSAL of that correction, not a keep.`
                  : 'THE PRINT READS A THIRD FORM: our `before` IS a reading of the print and the witness reads neither of the rule’s two readings here',
    });
  }
}

/* ---------- ASSERT the subdivision against the record’s own worklist -------- */

const record = JSON.parse(readFileSync(join(ROOT, 'tools', 'edits', `${slug}.pg-locate.json`), 'utf8'));
const names = record.UNIT_B_MAY_ACT_ON;
const idsOf = (a) => a.map((s) => s.split(':')[1]);
const expect = new Map([
  [CLASSES.emendation, idsOf(names.of_which_PRINT_ERROR_EMENDATIONS_it_must_NOT_revert)],
  [CLASSES.insertion, idsOf(names.of_which_INSERTIONS_it_must_NOT_treat_as_a_reading)],
  [CLASSES.contradiction, idsOf(names.of_which_CONTRADICTIONS_it_must_adjudicate)],
  [CLASSES.tie, idsOf(names.of_which_are_INDETERMINATE_TIES_the_flag_stands)],
  [CLASSES.third, idsOf(names.of_which_THIRD_FORM_on_a_real_before_reading)],
  [CLASSES.thirdGarble, idsOf(names.NO_EVIDENCE_EITHER_WAY_third_form_on_our_own_garble)],
]);
for (const [cls, want] of expect) {
  /* THE WORKLIST IS THE SET OF RULES THE WITNESS READS AGAINST, whatever this tool
   * does with them: `withdrawn` and `corrected` are ACTIONS on members of it, so the
   * drift guard counts them beside `against`. */
  const got = against
    .concat(corrected, withdrawn)
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
  of_which_changed_words_only: kept.filter((k) => k.class === 'changed-words-only').length,
  EVIDENCE_AGAINST: against.length + corrected.length + withdrawn.length,
  of_which_INDETERMINATE_TIES_kept: against.filter((a) => a.class === CLASSES.tie).length,
  of_which_corrected_target: corrected.length,
  of_which_WITHDRAWN: withdrawn.length,
  refused_not_acted_on: points.filter((p) => p.status !== 'located').length,
};
const out = {
  slug,
  tool: 'tools/pg-act.mjs',
  what:
    'the human-proofread witness ACTED ON: the review flags it EARNS cleared with the witness recorded in the rule’s own `evidence`, ' +
    'the rules it reads AGAINST recorded with the print’s own words, the rules that override the print on no measured evidence ' +
    'WITHDRAWN, and the corrections (a target taken from the witness’s own quoted words) asserted against that quote',
  batch: {
    file: BATCH,
    derived_by: `node tools/pg-locate.mjs ${slug} --what rules --version ${FROM} --slide 24`,
    witnesses: record.witnesses,
  },
  from_version: FROM,
  to_version: TO,
  placement_rule:
    'ONE BASIS, THE SAME ON EVERY PLACEMENT: the witness must carry the rule’s WHOLE `after` reading at the point — compared, since 1.0.6, on the reading’s WORDS (see `whole_reading_basis_decision`). The changed-words fallback — the changed fragment inside the placed stretch — NEVER clears, tight or slid, because 1–2 common words locate text without witnessing a repair. ' +
    'MEASURED (corrected in 1.0.5): the 1.0.4 rule cleared TIGHT placements on either basis and SLID ones only on the whole reading, so 9 rules cleared on the changed words alone; their flags stand again. See `call_2_the_clearing_basis`.',
  /* THE BASIS DECISION THE REVIEW ASKED FOR, MADE AND STATED. */
  whole_reading_basis_decision: {
    the_finding: 'the whole-reading test required the witness to carry the rule’s `after` TOKEN RUN AS WRITTEN, which includes two things the witness’s own record says it does not model ("WORD-LEVEL transcription of the print, human-proofread: no page, line, running head, mark or word-space is modelled", witnesses.json) — this transcription’s own damage/apparatus token `@` (a footnote asterisk, or an undischarged damage character) and a printed PAGE NUMBER, ours or PG’s inline one (which can fall INSIDE our run and split it).',
    decision:
      'THE BASIS WAS WRONG AND IS FIXED. A test that requires the witness to carry what the tool itself declares the witness cannot carry measures OUR apparatus, not the print — the same shape as a residual the size of the scan step. Since 1.0.6 the whole-reading test is tried twice: first on the exact token run (unchanged), then, only if that fails, on the rule’s WORD run against the witness’s own words with its numerals dropped. The exact test is still tried first, so the filtered one can only ADD confirmations.',
    the_three_guards_that_keep_this_from_over_clearing: [
      'the filtered match is taken ONLY where the rule’s change ADDS A WORD to the reading (the tool’s own `changedBlock` core). MEASURED on a first cut without it: 48 rules flipped, including r8652 (`progression, * superior` -> `progression, 3 superior`, a damage MARK for a page NUMERAL, where the witness reads `64`) — the words agree and the numeral does not, so a word-level match would have certified a numeral the print does not carry.',
      'a SECOND cut guarded on the two readings’ word RUNS instead, and still flipped r10587 (`parts Y*` -> `parts?*`, our own damaged `Y` resolved to a QUESTION MARK) — the runs differ only because our damage is a letter.',
      'and a rule typed `punctuation` is excluded: at r8832 (`[in the Cratylus3,` -> `[in the Cratylus]3,`) the word runs differ only because the transcription GLAZED the footnote numeral onto the word, and a word-level match would report the witness as confirming a BRACKET the tool’s own doctrine says it can never settle.',
    ],
    THE_BEFORE_SIDE_IS_DELIBERATELY_UNCHANGED:
      '`@` in a rule’s `before` is what distinguishes our DAMAGED reading from the clean one; dropping it there would read `& whole` as `whole` and record the witness as supporting our damaged reading — the defect that token was introduced for (MEASURED in 1.0.3: 22 rules at once). The `before` run is compared exactly as written.',
    measured_effect: {
      command: 'node tools/pg-locate.mjs <slug> --what rules --version 1.0.3 --slide {8,24,48} --out … and --what rules --type punctuation --all --slide 24',
      decide_changes: 8,
      of_which: ['r8576', 'r8594', 'r8998', 'r9122', 'r9270', 'r9542', 'r10219 — after, on the changed words, now confirmed by the whole reading — and r10517 (`soullife` -> `soul; life`, which the witness reads as two words: `beyond soul 170 life`) moves out of the third-form class and CONFIRMS'],
      placement_status_changes: 0,
      punctuation_surface_changes: 0,
      slide_curve: 'tight placements and their verdicts are IDENTICAL at every slide before and after; the slid after/third counts move by exactly one per slide (301/464/483 and 31/66/73)',
      served_text_changes: 'NONE — the change moves `review` flags and evidence only; no verdict became `before` that was not, and no rule newly reaches the withdraw branch',
    },
  },
  call_2_the_clearing_basis: {
    what_changed:
      'A rule is cleared only where the witness carries what the rule ASSERTS — its whole `after` reading — compared, since 1.0.6, on the reading’s WORDS (see `whole_reading_basis_decision`: the exact token run is tried first and the word run second, so the fix can only ADD confirmations), and the record states, per clear, which test decided it (`basis`) and what the rule asserted (`before`, `after`).',
    measured_in_1_0_4: {
      cleared: 1265,
      of_which_on_the_whole_reading: 1256,
      of_which_ON_THE_CHANGED_WORDS_ALONE: 9,
    },
    /* THE CLASS IS THE BATCH'S, NOT THE CLEAR HISTORY'S, WHICH IS WHY ITS SIZE IS
     * NOT THE SIZE OF ANY CLEAR HISTORY. MEASURED 2026-10-07: `basis` is a
     * property of the PLACEMENT, so every rule whose point the locator placed on
     * the changed words alone is in this class whether or not an earlier version
     * had cleared it. 1.0.5's class held TEN, and the review measured that against
     * the 9 of 1.0.4's clear history: 1.0.4 cleared 9 rules on that basis (the 8
     * re-flagged by 1.0.5 + r8961, corrected instead), and r9270 and r11692 carry
     * the same basis in the batch but were ALREADY `review: true` in 1.0.4 (slid
     * placements, never cleared), so they never appeared in a clear history to be
     * re-flagged. 1.0.6's whole-reading fix then CONFIRMED SEVEN of the ten
     * (r8576 r8594 r8998 r9122 r9270 r9542 r10219), so the class holds THREE
     * today and the historical decomposition is kept beside it, because those
     * seven are exactly the rules whose review reason this unit had to correct. */
    the_class_TODAY: kept.filter((k) => k.class === 'changed-words-only').map((k) => ({ id: k.id, find_before: k.before, after: k.after, witness_reads: k.reads })),
    the_class_in_1_0_5_held_TEN_and_where_those_numbers_come_from: {
      class_members_in_1_0_5: 10,
      cleared_on_this_basis_by_1_0_4: 9,
      of_which_RE_FLAGGED_by_1_0_5: ['r8576', 'r8594', 'r8998', 'r9122', 'r9542', 'r10219', 'r10558', 'r11093'],
      of_which_CORRECTED_by_1_0_5: ['r8961'],
      already_flagged_in_1_0_4_never_cleared: ['r9270', 'r11692'],
      of_which_CONFIRMED_by_1_0_6_s_whole_reading_fix: ['r8576', 'r8594', 'r8998', 'r9122', 'r9270', 'r9542', 'r10219'],
    },
    /* WHAT ACTUALLY DIFFERS AT EACH OF THE 10 — MEASURED, per rule, because
     * 1.0.5's record said the other 8 "differ from the witness in PG's own inline
     * PAGE NUMBERS or in marks" and that is FALSE for two of them and incomplete
     * for a third. The review found this (its Should-Fix 3); the measurement
     * below is a replay of its own token comparison over the batch's recorded
     * witness tokens:
     *
     *   - SEVEN carry the rule's WHOLE reading as WORDS (and are the seven 1.0.6
     *     CONFIRMS, so this difference was the instrument's, not the rule's) and differ only in the
     *     witness's own apparatus: our footnote asterisk (*) and/or a printed PAGE
     *     NUMBER, which is the witness's, ours, or both (r8576 `1` against PG's
     *     `212`; r8594 `being,*` against `being 188`; r8998 ` imparticipable*`;
     *     r9122 `desert,*` against `desert 221`; r9270 `sensibles*,` against
     *     `sensibles 213`; r9542 `invariable*`; r10219 `All souls` against
     *     `all 268 souls` — there the witness's page number falls INSIDE our run).
     *   - TWO differ by a PAGE-BREAK WORD FRAGMENT, which is not a number and not
     *     a mark: the transcription broke a word at the line end and kept the
     *     break, so the rule begins MID-WORD. r10558's `after` is `d has a` where
     *     the witness reads `and has a` — our `d` is the tail of `and`
     *     (source.txt: "...solid, and lias a \nboundary..."); r11093's `after` is
     *     `t is e` where the witness reads `it is evidently` — our `t` and `e` are
     *     the head of `it` and the head of `evidently` (source.txt: "...it js
     *     evidently necessary..."). Their flags are RIGHT (the rule's own `after`
     *     is not the print's whole reading) and the real fix is WIDER than this
     *     unit: the rule must be re-joined to whole words (`and lias a` ->
     *     `and has a`; `it js evidently` -> `it is evidently`) under a NEW id,
     *     which is a CHANGED READING and therefore a new rule — and the batch this
     *     pass acts on is a snapshot of 1.0.3's rules, which does not contain such
     *     a rule at all. Recorded as a separate job with its own measured numbers
     *     rather than papered over.
     *   - ONE (r11692) differs by a Greek/transliteration run the witness does not
     *     carry at all (our `after` opens `IANOIA, διάνοια,` and the witness reads
     *     `dianoia, from whence dianoetic...`). */
    what_actually_differs_at_each_of_THOSE_TEN: {
      every_word_carried_apparatus_only: ['r8576', 'r8594', 'r8998', 'r9122', 'r9270', 'r9542', 'r10219'],
      page_break_word_fragments: ['r10558', 'r11093'],
      a_transliteration_run_the_witness_does_not_carry: ['r11692'],
    },
    the_one_with_a_real_WORD_difference:
      'r8961 — the witness reads `as in images the` and the rule’s `after` is `as images the`, dropping the `in` that the transcription’s damaged `m` (`as m intages die`) stands for. Its target is CORRECTED (a new id, the old one spent). The other rules of the class are decomposed above, measured: SEVEN differ from the witness only in the witness’s own apparatus (our footnote asterisk and/or a printed page number — the witness carries every WORD of the rule’s `after`), TWO differ by a PAGE-BREAK WORD FRAGMENT (r10558, r11093 — the 1.0.5 record called these page numbers or marks and that was false), and one (r11692) is a transliteration run. The flag stands for all of them and the record shows the words.',
  },
  /* THE TEST THAT WAS REJECTED, WITH ITS NUMBERS, SO THE REJECTION IS CHECKABLE.
   * A candidate signal that passes the cases the measurement REFUTES is not a
   * signal; recording the numbers is what keeps the next unit from re-proposing it
   * from the same intuition. */
  rejected_signals: [
    {
      name: 'phrase-idiolect',
      test:
        'the rule’s target PHRASE (the changed word with one neighbouring word from the point’s own window) occurs elsewhere in the print while the form the rule changes occurs ONLY at the point',
      why_rejected:
        'it fires for the rules the measurement REFUTES and does not fire for the rules a reader would defend, so it partitions nothing',
      measured: {
        command: 'node /var/tmp/unitc/s3.mjs <id…> (token-run counts over both PG volumes; RE-MEASURED 2026-10-07 with the same tokeniser on the cached volume streams — see `vol_scope_corrected`)',
        vol_scope_corrected:
          'MEASURED 2026-10-07: the count recorded by 1.0.5 for `the one for` — 36× — is the VOL. I count alone (vol. I 36, vol. II 26), printed under a heading that said the counts were over both volumes. Over both it is 62×. The conclusion is unaffected (the form is still one the print sets in bulk while `the once for` occurs once, in vol. II) but the number as recorded was wrong and is corrected here rather than left standing.',
        fires_for_the_REFUTED: [
          'r8906: `the once for` 1× at the point against `the one for` 62× over both volumes (36× vol. I, 26× vol. II — the figure 36× recorded in 1.0.5 was the vol. I count alone) — but the print sets `_the once_` in ITALICS and glosses it with the Greek τῷ ἅπαξ (gutenberg-78800-vol2.txt:9768 and :19967-19968, `the once` 3× in the print), so the form is a DEFINED TECHNICAL TERM, not a misprint',
          'r8619: `these celestial` 1× against `the celestial` 178× — a determiner swap with no misprint shape',
        ],
        does_not_fire_for_the_FOUR_a_human_defended: [
          'r8574 `the first intellectual` 19× against `first intellectuals` 4×',
          'r8599 `and bound` 15× against `and bounds` 7×; `bound the` 6× against `bounds the` 9×',
          'r8683 `parts though` 2× against `parts through` 2×',
          'r8944 `providential case` 1× against `providential care` 28× — the ONE case of the 14 where this test would have agreed with a human, and it is not separable from r8906 and r8619 by the test alone',
        ],
      },
    },
  ],
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
    evidence_against_the_rule: against.length + corrected.length + withdrawn.length,
    refused_not_acted_on: points.filter((p) => p.status !== 'located').length,
    of_the_brief_s_95: {
      print_error_emendation_not_reverted: against.concat(corrected).filter((a) => a.class === CLASSES.emendation).length,
      insertion: against.concat(corrected).filter((a) => a.class === CLASSES.insertion).length,
      contradiction_the_print_carries_our_before: against.concat(corrected).filter((a) => a.class === CLASSES.contradiction).length,
      third_form_on_a_real_before_reading: against.concat(corrected).filter((a) => a.class === CLASSES.third).length,
      third_form_on_our_own_garble: against.concat(corrected).filter((a) => a.class === CLASSES.thirdGarble).length,
    },
    the_14_reopened: {
      what_the_1_0_4_record_claimed: 'that all 14 are emendations of the print’s own misprint, and that the reading is therefore left standing',
      what_is_measured:
        'the witness reads our `before` at all 14 (reproduced); the print’s own form is an ordinary word of the print’s OWN vocabulary at ALL 14; neither misprint signal fires at any of them',
      the_12_WITHDRAWN: withdrawn.map((w) => ({ id: w.id, print_reads: w.before, rule_wanted: w.after })),
      the_2_CORRECTED: corrected.filter((c) => c.class === CLASSES.contradiction).map((c) => ({ id: c.id, print_reads: c.new_after, rule_wanted: c.after, why: c.why })),
      the_four_the_reviewer_called_defensible_and_why_no_measurement_supports_them: [
        'r8574 `The first intellectual,` -> `intellectuals`: the print’s own form is `intellectual` (1236x of the print’s vocabulary). The print’s own sentence around it is plural (`proceed`, `their`, `themselves`) — an EDITORIAL argument from the print’s grammar, and NOT one of the two measured signals. WITHDRAWN; the edition serves the print’s own words. The argument is recorded here so a later unit can put it in an explicitly conjectural layer rather than in an OCR claim.',
        'r8599 `bound` -> `bounds`: the print uses `bound` 268x and `and bound` 15x, and its own parallel at gutenberg-77393-vol1.txt:3754 sets `into order and bound,` WITH a comma. Editorial; WITHDRAWN.',
        'r8683 `though` -> `through`: the print sets `through` six words earlier in the SAME sentence (`through the perfection of the recipients`) — an EDITORIAL argument, and the strongest of the four after r8944; `though their` stands 3x in the print. WITHDRAWN.',
        'r8944 `case` -> `care`: the print sets `providential care` 28x and `providential case` EXACTLY ONCE, here. The strongest of the four — and it is exactly the shape the REJECTED phrase-idiolect test fires on at r8906 and r8619 as well, so that test cannot separate them. WITHDRAWN and recorded.',
      ],
      the_reviewer_s_8: 'all 8 withdrawn or corrected with the print’s own words recorded. r8906 additionally MEASURED as a DEFINED TECHNICAL TERM: the print sets `_the once_` in italics and glosses it with the Greek (gutenberg-78800-vol2.txt:9768; :19967-19968 “characterise this deity by the epithet of _the once_; (τῳ απαξ)”), so the rule was emending away the very term the sentence defines — and the unit itself corrected post->past (r11846) in that same sentence.',
    },
    brief_refutations: [
      'REFUTATION #0, CORRECTED IN 1.0.5 BECAUSE IT OVERCLAIMED IN THE OTHER DIRECTION. It read: the 14 rules whose `before` the print reads are “emendations of the print’s own misprint”, so this unit does not revert a print misprint. THE MEASUREMENT IS TRUE AND I REPRODUCED IT (the witness reads our `before` at all 14 points); the CONCLUSION DOES NOT FOLLOW FROM IT, and the class it rested on was named after the conclusion it wanted (see the classifier note above). NO TEST ASKED WHETHER THE PRINT’S FORM IS AN ERROR, and against the two tests that do ask it NONE of the 14 fires either: every changed form is a word of the reference wordlist AND a form the print uses elsewhere in its own text (uses 114, 12944, 40+1, 58, 2529, 196, 2144, 2, 2144, 4, 1236, 268, 196, 181). So at those 14 points the print carries no MEASURED misprint: 12 of the rules override a print our transcription already reads and 2 do real work with a wrong target. A refutation that overclaims is the same sin as the claim it refutes.',
      'The brief’s "62 third forms that carry no evidence are not confirmations and must NOT be cleared" is RIGHT and is done: they keep the flag and their rationale now says the witness’s words there are no evidence about the rule, because our own `before` is the transcription’s garble.',
            'The brief says the 1,267 confirmations clear. MEASURED and decided: 1,256 clear. The 1.0.4 rule cleared a TIGHT placement on EITHER basis and a SLID one only on the whole reading, so 9 rules cleared on the CHANGED WORDS alone — a basis the slid branch already refused; their flags stand again. Of those 9, 8 differ from the witness in PG’s own inline page numbers or in marks and merely keep the flag, and 1 (r8961) is a real WORD difference whose target is corrected instead. See call_2_the_clearing_basis.',
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
  /* THE RULES THIS VERSION TAKES OUT, with the print's own words. Recorded here as
   * the DECISION as well as in `measured.the_14_reopened`, so a dry run names them
   * before anything is written. */
  withdrawn,
  /* THE RETIREMENT, derived the same way the write derives it: a corrected target
   * may not be written under the id a reader cited in the previous version, so the
   * old rule is retired (its id stays spent and is recorded as withdrawn) and the
   * corrected rule is appended under a fresh id. The ids are allocated from the
   * source version's own maximum, so a dry run names exactly what the write will. */
  retired: (() => {
    let n = Math.max(...srcRaw.rules.map((r) => Number((/:r(\d+)$/.exec(r.id) || [])[1]) || 0)) + 1;
    return corrected
      .map((c) => {
        const was = srcRaw.rules.find((r) => r.id.endsWith(`:${c.id}`));
        /* AN ID ALREADY SPENT IS CARRIED, NOT RE-MINTED (model 4.2): a correction
         * applied by an earlier version is not re-derived over that version. */
        if (!was) return { id: c.id, already_spent: true, now: c.new_after, why: 'the id is already spent — the correction is CARRIED from an earlier version' };
        const out = { old_id: was.id, new_id: `${slug}:r${String(n).padStart(4, '0')}`, find: was.location.find, was: was.after, now: c.new_after, why: c.why };
        n += 1;
        return out;
      })
      .filter(Boolean);
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
const sameWitnessEntry = (e, w) => e && e.kind === 'witness' && e.witness === w.witness && e.reads === w.reads && e.volume === w.volume;

const rules = srcRaw.rules.map((r) => JSON.parse(JSON.stringify(r)));
const byId = new Map(rules.map((r) => [r.id.split(':')[1], r]));
/* THE APPLY IS IDEMPOTENT STATE-SETTING, not an append-forever pass, because it is
 * run over a version that may ALREADY carry part of the yield: 1.0.5 is derived from
 * 1.0.4 (1,265 flags already cleared, six ids already spent), and a re-run must not
 * duplicate a witness entry, must not re-mint a spent id, and must be able to
 * UNSET a clear the fixed basis no longer earns. */
let nClear = 0;
let nUnclear = 0;
let nWithdraw = 0;
let nCorr = 0;
let nNote = 0;
let nSkip = 0;
for (const c of cleared) {
  const r = byId.get(c.id);
  if (!r) { nSkip++; continue; }
  const p = points.find((x) => x.id.endsWith(`:${c.id}`));
  const w = witnessEntry(p, c.why);
  const have = Array.isArray(r.evidence) ? r.evidence : [];
  if (!r.review && have.some((e) => sameWitnessEntry(e, w))) continue; // already in this state
  r.review = false;
  r.evidence = have.some((e) => sameWitnessEntry(e, w)) ? have.map((e) => (sameWitnessEntry(e, w) ? w : e)) : have.concat([w]);
  /* AND THE RATIONALE MUST NOT STILL SAY THE FLAG STANDS. A rule this pass CLEARS
   * may be one whose own note was written by the previous version to say why the
   * flag was UP (`REBASED 1.0.5: … the flag stands and the rule is back on the
   * review worklist`) — MEASURED 2026-10-07: the whole-reading fix cleared 8 rules
   * of which 8 carried such a note, and a rule whose rationale contradicts its own
   * `review` is worse than no note. The superseded tail is REPLACED (the same
   * shape the `against` annotation writes), so every rule this version clears
   * carries ONE statement of what this version measured. */
  const tail = String(r.rationale).replace(/\s*(WITNESS|REBASED) \d+\.\d+\.\d+:[\s\S]*$/, '');
  r.rationale = `${tail} WITNESS ${TO}: Project Gutenberg’s human-proofread transcription of the 1816 print reads ${JSON.stringify((p.pg && p.pg.tokens) || [])} at this point (${c.volume}${p.tight ? ', tight' : ', slid'}). ${c.why}`;
  nClear++;
}
/* THE REBASED BASIS, APPLIED AS A STATE. A tight placement confirmed on the CHANGED
 * WORDS alone is not a clear under the one basis; it goes BACK on the worklist, and
 * the witness entry it carries is rewritten to say what was actually measured
 * rather than to repeat the claim the basis no longer supports (a record that lies
 * is worse than no record). */
for (const k of kept.filter((x) => x.class === 'changed-words-only')) {
  const r = byId.get(k.id);
  if (!r) { nSkip++; continue; }
  if (r.review) continue; // already flagged
  const p = points.find((x) => x.id.endsWith(`:${k.id}`));
  const w = witnessEntry(p, k.why);
  r.review = true;
  const have = Array.isArray(r.evidence) ? r.evidence : [];
  r.evidence = have.map((e) => (e && e.kind === 'witness' && e.volume === k.volume ? w : e));
  if (!r.evidence.length) r.evidence = [w];
  r.rationale = `${String(r.rationale).replace(/\s*WITNESS \d+\.\d+\.\d+:[\s\S]*$/, '')} REBASED ${TO}: the clear this rule carried was made on the CRITICAL BASIS THE SLID BRANCH REFUSES — the CHANGED WORDS alone, not the rule’s whole \`after\` reading. Project Gutenberg’s human-proofread transcription reads ${JSON.stringify((p.pg && p.pg.tokens) || [])} at this point, and the rule asserts ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)}; the flag stands and the rule is back on the review worklist.`;
  nUnclear++;
}
/* A WITHDRAWN RULE. The witness reads our `before` there, the print’s own form is an
 * ordinary word of its own vocabulary, and NEITHER misprint signal fires, so the
 * rule overrides a print our transcription already reads. It is REMOVED — its id
 * spent and recorded as withdrawn in tools/repair-id-probe.mjs, exactly as r11680-
 * r11686 are — and the version then serves the print’s own text at that point. */
const withdrawnApplied = [];
for (const w of withdrawn) {
  const r = byId.get(w.id);
  if (!r) { nSkip++; continue; }
  const at = rules.findIndex((x) => x.id === r.id);
  if (at < 0) throw new Error(`pg-act: ${w.id} is not in the rule list`);
  rules.splice(at, 1);
  byId.delete(w.id);
  withdrawnApplied.push({ id: w.id, find: r.location.find, was: r.after, print_reads: w.before, why: w.why });
  nWithdraw++;
}
/* A CORRECTED TARGET IS A NEW RULE, NOT AN EDITED ONE. Model §4.2 + tools/repair-id-probe.mjs:
 * an id carries ONE rule forever, so "the print reads what the witness says" may
 * not be written under the old id — a reader who cited r8617 in 1.0.3 would find a
 * different rule under it. So the old rule is RETIRED (removed; its id stays spent
 * and is recorded as withdrawn, exactly as r11680–r11686 are) and the corrected
 * rule is APPENDED under a fresh id. The find is unchanged, so the rule still
 * fires; only where in the order it is applied moves, and the build's own fire
 * contract is what proves that moving it is safe. A correction whose old id is
 * ALREADY SPENT (the six of 1.0.4, re-run over 1.0.4) is SKIPPED and recorded. */
let nextId = Math.max(...rules.map((r) => Number((/:r(\d+)$/.exec(r.id) || [])[1]) || 0)) + 1;
const retired = [];
const skippedAlreadySpent = [];
for (const c of corrected) {
  const r = byId.get(c.id);
  if (!r) { skippedAlreadySpent.push({ id: c.id, already: c.new_after, why: 'the id is already spent — the correction was applied by an earlier version and is CARRIED, not re-minted (model 4.2)' }); continue; }
  const p = points.find((x) => x.id.endsWith(`:${c.id}`));
  const at = rules.findIndex((x) => x.id === r.id);
  if (at < 0) throw new Error(`pg-act: ${c.id} is not in the rule list`);
  const nid = `${slug}:r${String(nextId).padStart(4, '0')}`;
  nextId += 1;
  const fresh = JSON.parse(JSON.stringify(r));
  /* THE OVERCLAIM MUST NOT TRAVEL WITH THE RULE. The old rationale may carry a
   * WITNESS block an earlier version appended (1.0.4's contradiction class asserted
   * "this is an EMENDATION OF THE PRINT"); that text asserted a conclusion the
   * measurement does not support, so it is STRIPPED here rather than carried onto a
   * corrected rule — a comment that lies is worse than no comment. */
  const base = String(r.rationale).replace(/\s*WITNESS \d+\.\d+\.\d+:[\s\S]*$/, '');
  fresh.id = nid;
  fresh.after = c.new_after;
  fresh.rationale = `${base} CORRECTED ${TO}: the print reads ${JSON.stringify(c.new_after)} here — the corrected target is taken from Project Gutenberg’s human-proofread transcription of the 1816 print (${c.volume}, its own words: ${JSON.stringify((p.pg && p.pg.tokens) || [])}), not from ours. ${c.why}.`;
  fresh.review = false;
  /* A STALE WITNESS ENTRY MUST NOT TRAVEL WITH THE CORRECTED RULE. An entry an
   * earlier version wrote for the same witness states the claim THAT version made
   * (at r8961, "the witness carries the rule’s after reading, both bounds hard
   * against it" — which the whole-reading test refutes); it is REPLACED, not
   * stacked, so the evidence says what this version measured. */
  const oldEv = Array.isArray(r.evidence) ? r.evidence : [];
  const w = witnessEntry(p, c.why);
  fresh.evidence = oldEv.some((e) => sameWitnessEntry(e, w)) ? oldEv.map((e) => (sameWitnessEntry(e, w) ? w : e)) : oldEv.concat([w]);
  rules.splice(at, 1);
  rules.push(fresh);
  retired.push({ old_id: r.id, new_id: nid, find: r.location.find, was: r.after, now: c.new_after, why: c.why });
  nCorr++;
}
/* THE OTHER RULES THE WITNESS READS AGAINST: annotated in their own rationale with
 * the print's own words. AND THE OVERCLAIM ALREADY IN THE RECORD IS CORRECTED HERE,
 * in the rules that stay: 1.0.4 appended the contradiction string to 14 rationales,
 * all of which are now withdrawn or corrected, so nothing carrying it survives — and
 * this pass asserts that rather than assuming it. */
let nOverclaimStripped = 0;
for (const r of rules) {
  if (/EMENDATION OF THE PRINT/.test(String(r.rationale))) {
    r.rationale = String(r.rationale).replace(/\s*THE PRINT CARRIES THE FORM THIS RULE CHANGES: the witness reads our `before` here, so this is an EMENDATION OF THE PRINT[^.]*\.\s*/g, ' ');
    nOverclaimStripped++;
  }
}
for (const a of against.concat(kept.filter((k) => !k.class))) {
  const r = byId.get(a.id);
  if (!r) continue;
  if (!r.review) continue;
  const p = points.find((x) => x.id.endsWith(`:${a.id}`));
  /* A NOTE THAT STACKS A SECOND WITNESS BLOCK ON THE FIRST IS NOISE, AND A STALE ONE
   * IS WORSE THAN NOISE: the block an earlier version appended is REPLACED, so the
   * rule carries ONE statement of what this version measured. */
  const tail = String(r.rationale).replace(/\s*WITNESS \d+\.\d+\.\d+:[\s\S]*$/, '');
  r.rationale = `${tail} WITNESS ${TO}: Project Gutenberg’s human-proofread transcription of the 1816 print reads ${JSON.stringify((p.pg && p.pg.tokens) || [])} at this point (${a.volume}${p.tight ? ', tight' : ', slid'}). ${a.why}`;
  nNote++;
}
writeFileSync(rulesFile(TO), `${JSON.stringify({ ...srcRaw, version: TO, rules }, null, 1)}\n`);
for (const t of retired) console.log(`  RETIRED ${t.old_id} -> ${t.new_id}: ${JSON.stringify(t.find)} ${JSON.stringify(t.was)} -> ${JSON.stringify(t.now)}`);
for (const t of withdrawnApplied) console.log(`  WITHDRAWN ${t.id}: ${JSON.stringify(t.find)} ${JSON.stringify(t.was)} -> the print reads ${JSON.stringify(t.print_reads)}`);
console.log(`  WROTE ${rulesFile(TO)}: ${nClear} flag(s) cleared, ${nUnclear} clear(s) UNSET by the rebased basis, ${nWithdraw} rule(s) WITHDRAWN, ${nCorr} target(s) corrected (each as a NEW id, the old id retired), ${nNote} rationale(s) annotated, ${skippedAlreadySpent.length} correction(s) skipped as already spent, ${nSkip} point(s) skipped (the rule is not in this version)`);
const rec = JSON.parse(readFileSync(OUT, 'utf8'));
rec.retired = retired;
rec.withdrawn = withdrawnApplied;
rec.skipped_corrections_already_spent = skippedAlreadySpent;
rec.how_to_rederive = [
  `node tools/pg-locate.mjs ${slug} --what rules --version 1.0.3 --slide 24 --out ${BATCH}`,
  `cp -r data/editions/${slug}/versions/${FROM} data/editions/${slug}/versions/${TO}   # the version directory, meta.json rewritten for ${TO}`,
  `node tools/pg-act.mjs ${slug} --from-version ${FROM} --to-version ${TO} --batch ${BATCH} --write`,
  `node tools/pg-act.mjs ${slug} --to-version ${TO} --stamp-open   # idempotent; the open-question evidence is already on the rules this version carries`,
];
rec.how_to_rederive_why =
  `The batch is derived at --version 1.0.3 because that is the state that still carries ALL 2,238 review flags: a batch derived at ${FROM} would see only the rules ${FROM} still flags and could neither re-adjudicate a rule ${FROM} cleared nor unset a clear. The pass over ${FROM} is IDEMPOTENT (it sets state, it does not append), so a re-run reproduces this version. Corrections whose old id is already spent are SKIPPED and recorded: an id carries one rule forever, so the six corrections of 1.0.4 (r11843-r11848) are CARRIED, not re-minted.`;
writeFileSync(OUT, `${JSON.stringify(rec, null, 1)}\n`);
