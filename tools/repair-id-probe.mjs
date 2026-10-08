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
  /* 1.0.3 carries 1.0.2's rules UNCHANGED (the bump recovers two printed
   * chapters in the section model; not one rule changes), so its rule list
   * carries the same six spent ids as gaps. */
  ['proclus-theology-of-plato-taylor-1816@1.0.3', [11680, 11681, 11682, 11683, 11684, 11686]],
  /* 1.0.4 RETIRES SIX MORE, and for the first time the withdrawal is a READING
   * change rather than a fabricated one. MEASURED 2026-10-07: Project Gutenberg's
   * human-proofread transcription of the same 1816 print reads the print's own
   * words at six points where these rules had GUESSED a different target (our
   * rules were all decided "by the transcription's own context", with no witness
   * at all). The target is corrected to the print's reading — which must not be
   * written under the id a reader cited in 1.0.3 — so the six old rules are
   * retired and the corrected rules are appended as r11843–r11848. The other 1,271
   * rules this unit touched had their READING left alone and are carried. */
  ['proclus-theology-of-plato-taylor-1816@1.0.4', [8600, 8617, 8923, 8991, 10442, 11100, 11680, 11681, 11682, 11683, 11684, 11686]],
  /* 1.0.5 TAKES FOURTEEN RULES OUT, and for the first time some of them are
   * withdrawn WITH NO REPLACEMENT. MEASURED 2026-10-07 (the sixth-DOI unit): at
   * fourteen points the human-proofread witness reads the form OUR RULE CHANGES
   * AWAY FROM — i.e. the print carries the very form the rule altered — and at
   * every one of them the print's own form is an ordinary word of the print's own
   * vocabulary and NEITHER misprint signal fires, so no measurement shows the print
   * at fault. TWELVE of the rules therefore override a print our transcription
   * already reads and are WITHDRAWN (the version serves the print's own text at
   * those points): 8574, 8599, 8611, 8619, 8672, 8683, 8906, 8944, 8995, 8996,
   * 9015, 10291. THREE do real work on a damaged transcription and only their
   * TARGET was wrong, so the target is corrected to the print's own words and the
   * old id is spent: 8961 (the print reads "as in images the"; our target dropped
   * the "in" the transcription's damaged "m" stands for), 9069 (the print reads the
   * participle "inferior being"; our target added a plural "s"), 10120 (the print
   * reads "to united"; our target added "in"). The other 1.0.4 ids stay spent. */
  ['proclus-theology-of-plato-taylor-1816@1.0.5', [8574, 8599, 8600, 8611, 8617, 8619, 8672, 8683, 8906, 8923, 8944, 8961, 8991, 8995, 8996, 9015, 9069, 10120, 10291, 10442, 11100, 11680, 11681, 11682, 11683, 11684, 11686]],
  /* 1.0.6 TAKES TWO MORE OUT, and for the first time one of them is a rule whose
   * TARGET the print never sets. MEASURED 2026-10-07 (the seventh-DOI unit):
   * r9734 mapped `consubsistS` to `consubsist` — a form the print uses ZERO TIMES
   * in its whole vocabulary — while the print reads `consubsists` (1x, and its own
   * `consubsistent` 32x); the transcription's `consubsistS` is that word with its
   * final `s` mis-cased, so the rule does real work on the transcription and only
   * its TARGET was wrong. The target is corrected to the print's own words and the
   * old id is spent: r9734 -> r11856 ("consubsistS" -> "consubsists"). r10277
   * (` , rythm a` -> `, rhythm a`) is WITHDRAWN WITH NO REPLACEMENT: `rythm` is
   * the print's DOMINANT spelling (4x + rythms 1x against rhythm 2x + rhythms
   * 1x), so the rule was modernising the print's own orthography, not repairing a
   * misprint. Both were licensed by the old at-fault signals — a dictionary miss
   * and a rare form — which no longer reach that verdict at all. */
  ['proclus-theology-of-plato-taylor-1816@1.0.6', [8574, 8599, 8600, 8611, 8617, 8619, 8672, 8683, 8906, 8923, 8944, 8961, 8991, 8995, 8996, 9015, 9069, 9734, 10120, 10277, 10291, 10442, 11100, 11680, 11681, 11682, 11683, 11684, 11686]],
  /* 1.0.7's LIST IS LONG BECAUSE TWO MECHANISMS SPENT IDS AT ONCE. (a) FIVE RULES
   * ARE WITHDRAWN WITH NO REPLACEMENT. FOUR are the SAME shape: the human-proofread
   * witness of the same print (Project Gutenberg 77393/78800, Distributed
   * Proofreaders) reads OUR FIND VERBATIM at every site the rule fires at, i.e. the
   * print carries the very form the rule changes away from. MEASURED 2026-10-08 (the
   * reading-view-fold unit), located in the witness by the surrounding words:
   *   r9550  `one or being` -> `one and being`: the witness reads "the one or being"
   *          at BOTH sites ("...the same either with the one or being", "plato calls
   *          the one or being infinite multitude") and `one and being` elsewhere;
   *   r8942  `beings themselves` -> `being itself`: the witness reads `beings
   *          themselves` at ALL THREE sites verbatim, and the rule's own rationale
   *          says "print likely reads" — a guess with no witness at all;
   *   r10812 `honored` -> `honoured`: the witness reads `honored` at both sites
   *          ("much-honored intellect", "let it be honored by us in silence") —
   *          the print's own period spelling, which the rule normalised;
   *   r9707  `uncoarranged` -> `unco-arranged`: the witness reads `uncoarranged` at
   *          both sites and `unco-arranged` NEVER (0 times), so the rule added a
   *          hyphen the print does not set.
   * They are withdrawn rather than scoped because there is no site to scope them to:
   * the rule's target is wrong at every occurrence. THIS IS A CROSS-CLASS FINDING
   * for the unit that owns the wrong-reading class (the 791 bare-rationale rules):
   * the same witness test, run over that class, is what it needs. No replacement
   * rule is added: the version serves the print's own text at those points.
   * The FIFTH is r11094 (`super-` -> `supermundane`). The print sets `super-` at the
   * foot of page 153 and `mundane` at the head of page 154 — its OWN page-break
   * hyphenation, with a footnote and a Greek quotation standing between them — and no
   * find/replace can join them (the parts are not adjacent in the reading view's fold
   * domain). Scoping the find to that one site — this unit's first attempt, and the
   * reviewer's recommendation — made the reading view read `the ruling supermundane`
   * at the foot and `mundane order` at the next page's head: the word TWICE. Withdrawn
   * instead, so all nine occurrences serve the print's own text.
   * (b) THIRTY-SIX RULES HAVE A DIFFERENT READING AND ARE RE-ISSUED UNDER A NEW
   * ID with the old one SPENT — never an edit under a spent id (RULE_FIELDS below
   * includes `after`, so this is the only shape the model allows). FIVE of them are
   * scoped to the one site they were written for by extending the find (r10934
   * `exempts`, r9794 `replenishes`, r11472 `son!`, r11426 `the*`,
   * r9926 `from, their`), and THIRTY-ONE are the rules that recorded "no reading
   * recorded here" by replacing the text with the English word `unsure`, which the
   * reader has no case for and served as prose (`about unsure God` destroyed the
   * print's own `the … first`): they now carry this edition's DAMAGE CHARACTER, or
   * their own correct reading (`the 1 first` -> `the first`, `attri-Proc. Vol. I,
   * 2 E` -> `attri-`). TWO of those 31 (r8729, r8915) are withdrawn with no
   * replacement instead: at the position a fresh id must sit (the end of the list)
   * an earlier rule has already consumed their find, and both stand in RUNNING-HEAD
   * blocks the reading view suppresses, so their effect is invisible in both views.
   * (c) THE RELOCATIONS CASCADE, and this is the model's own consequence, MEASURED
   * by iterating to a fixed point: moving a rule to the end of the list frees the
   * text it used to consume, so the rules that consumed it instead now fire a
   * different number of times — and a changed `fires` is a changed record. TWO rules
   * were re-issued for that reason (r11022 `Proc .` 4 -> 5, r11059 `^ooQie` 3 -> 6,
   * re-issued as r11892/r11895), and of the 37 fresh ids TWO are spent with no rule
   * (at the end of the list an earlier rule consumes their find first, and both
   * stand in running-head blocks the reading view suppresses, so their effect is
   * invisible in both views). The fixed point was reached on the second pass with 0
   * rewritten carried records and 0 dead rules. The 36 fresh ids are r11857-r11894,
   * two of them spent. */
  ['proclus-theology-of-plato-taylor-1816@1.0.7', [8566, 8567, 8570, 8574, 8575, 8593, 8599, 8600, 8611, 8617, 8619, 8654, 8672, 8683, 8685, 8687, 8720, 8729, 8730, 8736, 8741, 8756, 8785, 8837, 8852, 8906, 8915, 8923, 8942, 8944, 8961, 8967, 8991, 8995, 8996, 9002, 9015, 9069, 9550, 9707, 9734, 9794, 9908, 9926, 10003, 10004, 10067, 10120, 10198, 10277, 10291, 10442, 10571, 10738, 10812, 10838, 10934, 11022, 11059, 11094, 11100, 11387, 11426, 11472, 11507, 11563, 11680, 11681, 11682, 11683, 11684, 11686, 11866, 11874]],
  /* 1.0.8 RETIRES FOUR RULES AND APPENDS THE CORRECTED FOUR. MEASURED 2026-10-08 (the echo-probe unit): r11693, r11705, r11707 and r11812 each served a TRANSLITERATION whose reading the print does not carry — r11693's and r11812's both Greek phrases were fabricated (r11812's two words each ended in the wrong letter, while the print's own sentence on the same line says the letter in question "is here an ω"), r11707 had the right five letters in the WRONG ORDER, r11705 carried U+0302 COMBINING CIRCUMFLEX over an epsilon, which Greek cannot set. Their readings were read off the page by a blind instrument and against the human-proofread transcription of the same print, the four ids are SPENT, and the corrected rules are appended as r11895-r11898. TWO further rules of the same class (r11709, r11719) were re-flagged with their reading UPHELD and a witness entry recording the blind read that put them back on the worklist; their ids are carried. */
  ['proclus-theology-of-plato-taylor-1816@1.0.8', [8566, 8567, 8570, 8574, 8575, 8593, 8599, 8600, 8611, 8617, 8619, 8654, 8672, 8683, 8685, 8687, 8720, 8729, 8730, 8736, 8741, 8756, 8785, 8837, 8852, 8906, 8915, 8923, 8942, 8944, 8961, 8967, 8991, 8995, 8996, 9002, 9015, 9069, 9550, 9707, 9734, 9794, 9908, 9926, 10003, 10004, 10067, 10120, 10198, 10277, 10291, 10442, 10571, 10738, 10812, 10838, 10934, 11022, 11059, 11094, 11100, 11387, 11426, 11472, 11507, 11563, 11680, 11681, 11682, 11683, 11684, 11686, 11693, 11705, 11707, 11812, 11866, 11874]],
  /* 1.0.9 CORRECTS ONE READING AND ONE EVIDENCE-LEAF CLASS. MEASURED 2026-10-08
   * (the H2b-i unit): r11842 served the fabricated Greek READING "πραξις" where the
   * print sets "αρχαι" — the print's own sentence on the same line glosses the word
   * as "Principalities, or rulers", and a BLIND read of the plate returns "αρχαι" —
   * so the reading is corrected under the fresh id r11899 and r11842 is SPENT. (No
   * other rule's READING changes in this version: 20 rules have their EVIDENCE LEAF
   * corrected, which is not a rule change at all, and r11895/r11897 only have the
   * old leaf removed from their own prose.) */
  ['proclus-theology-of-plato-taylor-1816@1.0.9', [8566, 8567, 8570, 8574, 8575, 8593, 8599, 8600, 8611, 8617, 8619, 8654, 8672, 8683, 8685, 8687, 8720, 8729, 8730, 8736, 8741, 8756, 8785, 8837, 8852, 8906, 8915, 8923, 8942, 8944, 8961, 8967, 8991, 8995, 8996, 9002, 9015, 9069, 9550, 9707, 9734, 9794, 9908, 9926, 10003, 10004, 10067, 10120, 10198, 10277, 10291, 10442, 10571, 10738, 10812, 10838, 10934, 11022, 11059, 11094, 11100, 11387, 11426, 11472, 11507, 11563, 11680, 11681, 11682, 11683, 11684, 11686, 11693, 11705, 11707, 11812, 11842, 11866, 11874]],
  /* 1.0.10 TAKES TWO RULES OUT, and for the first time in this chain a WITHDRAWAL
   * is made on the ground that the `after` reading is not the print's at all.
   * MEASURED 2026-10-08 (the eleventh-DOI unit, H2b-ii): r8653 served "that which
   * is delicious food," where the plate sets a GREEK WORD and then the bracketed
   * gloss [delicious food] — the rule DELETED the print's Greek word and put
   * English filler in its place, which is nowhere in the print (the human-proofread
   * Gutenberg transcription of the same print reads "but θοινη [delicious food]
   * the united conversion of", and two BLIND reads of the plate agree on that
   * shape). r11652 served "not only' that" — a dangling apostrophe — where the
   * plate sets "not only" and a SUPERSCRIPT FOOTNOTE MARKER: the blind read returns
   * "not only³ that we should" and the page's own footnote "³ The word μονον is
   * omitted in the original", and the human-proofread witness reads "not only that".
   * Both readings are corrected under fresh ids (r11900, r11901) and both old ids
   * are spent, never reused. The other 3,253 ids are carried unchanged; 83 rules
   * have their REVIEW FLAG cleared on a witness and 9 have a witness recorded with
   * the flag kept, neither of which changes any id's standing. */
  ['proclus-theology-of-plato-taylor-1816@1.0.10', [8566, 8567, 8570, 8574, 8575, 8593, 8599, 8600, 8611, 8617, 8619, 8653, 8654, 8672, 8683, 8685, 8687, 8720, 8729, 8730, 8736, 8741, 8756, 8785, 8837, 8852, 8906, 8915, 8923, 8942, 8944, 8961, 8967, 8991, 8995, 8996, 9002, 9015, 9069, 9550, 9707, 9734, 9794, 9908, 9926, 10003, 10004, 10067, 10120, 10198, 10277, 10291, 10442, 10571, 10738, 10812, 10838, 10934, 11022, 11059, 11094, 11100, 11387, 11426, 11472, 11507, 11563, 11652, 11680, 11681, 11682, 11683, 11684, 11686, 11693, 11705, 11707, 11812, 11842, 11866, 11874]],
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
    /* SEMVER, not lexicographic: a plain .sort() puts "1.0.10" between "1.0.1"
     * and "1.0.2", so every guard that compares a version with the one BEFORE it
     * would compare 1.0.2 with 1.0.10 and report the ids 1.0.4 adds as DROPPED.
     * MEASURED 2026-10-08, on the tree that first carried a two-digit minor. */
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const seen = new Map(); // id -> { version, rule } (the FIRST version that allocated it)
  const perVersion = new Map();
  /* THE VERSION IMMEDIATELY BEFORE THIS ONE, so the review-annotation guards below
   * can compare against the STATE THE RULE WAS LAST SEEN IN rather than against the
   * first version that allocated it (which cannot see a flip back to an earlier
   * state — see MUCH later). */
  const prevOf = new Map(versions.map((v, i) => [v, i === 0 ? null : versions[i - 1]]));

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
    /* THE COMPARISON IS OVER THE RULE, and the rule is its READING. MEASURED
     * 2026-10-07 (the Project Gutenberg witness unit): the whole-record compare
     * this replaces failed on 1,271 rules of 1.0.4 whose READING is untouched —
     * they were cleared from the review worklist by a human acting on a
     * human-proofread witness and their `evidence` now names it, which is the one
     * thing `review` and `evidence` exist for (model §4.1: "human review over the
     * worklist is the only thing that flips `review` to `false`"). A whole-record
     * compare also failed `tools/migrate-evidence.mjs`, which is documented as
     * re-runnable and rewrites the `evidence` array and nothing else. So the rule
     * is compared on the fields that CONSTITUTE it — `find`, `after`, `before`,
     * `type`, `apply`, `join`, `fires`, `type_evidence`, `location` — and a
     * carried id whose READING moved under it still fails, which is the silent
     * rewrite the rule is for. A corrected reading is a NEW id with the old one
     * withdrawn (WITHDRAWN below), never an edit under a spent id. */
    const RULE_FIELDS = ['id', 'type', 'apply', 'location', 'before', 'after', 'fires', 'join', 'type_evidence'];
    const reading = (r) => JSON.stringify(RULE_FIELDS.map((k) => r[k]));
    const rewritten = rules.filter((r) => seen.has(r.id) && reading(seen.get(r.id).rule) !== reading(r));
    const appended = rules.filter((r) => !seen.has(r.id)).length;
    /* AND THE ANNOTATIONS THAT MAY NOT MOVE IN EITHER DIRECTION WITHOUT A REASON ON
     * THE RECORD. A rule cleared from the review worklist is a human decision that
     * has been taken; a later version may add evidence but may not re-flag it
     * without saying why. MEASURED 2026-10-07 (the reviewer's Call 4): this guard
     * was ONE-WAY — it caught false→true only — and the narrowed comparison that
     * replaced the whole-record compare does not look at `review` at all, so a rule
     * could be silently UN-FLAGGED: a clear nobody asserted passed every check. The
     * two directions are now one symmetric pair, and each demands the reason be on
     * the record:
     *
     *   true→false (a CLEAR): the rule must have GAINED a non-empty evidence entry.
     *     MEASURED: every clear of 1.0.4 and of 1.0.5 gains exactly one witness
     *     entry naming the witness whose words were read; `tools/repair-id-probe.mjs`
     *     is what refuses a clear that gains nothing.
     *   false→true (a RE-FLAG): the rule's `evidence` or its `rationale` must have
     *     MOVED, so the version says why it is back on the worklist. MEASURED
     *     2026-10-07: 1.0.5 re-flags 8 rules whose clear rested on the CHANGED WORDS
     *     alone (see tools/pg-act.mjs, `call_2_the_clearing_basis`) and each carries
     *     both a rewritten witness entry and a REBASED rationale note.
     *
     * BOTH are compared against the IMMEDIATELY PRECEDING version, not against the
     * first version that allocated the id: `seen` cannot see the flip at all when an
     * earlier version already held the rule in the state it returns to (1.0.3 held
     * these 8 flagged, so a `seen`-based guard is blind to their 1.0.5 re-flag). */
    const prev = prevOf.get(v) || null;
    const prevRules = prev === null ? null : new Map(JSON.parse(readFileSync(repairsPath(slug, prev), 'utf8')).rules.map((r) => [r.id, r]));
    const sameArr = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
    /* WHAT "THE REASON IS ON THE RECORD" MEANS, made checkable. MEASURED
     * 2026-10-07 (the seventh-DOI unit, on a /var/tmp fixture that is a full copy
     * of tools+data): the guard below failed correctly in both directions but was
     * VACUOUSLY SATISFIABLE IN THREE WAYS, and each of the three is closed by the
     * definitions here rather than by a longer sentence:
     *
     *   (a) a CLEAR whose GAINED evidence entry carried NO `why` passed, because
     *       `nowEv.some(e => e.why)` was satisfied by an OLD entry's why. The
     *       justification must be the MOVED entry's OWN: `gained` is the entries
     *       this version added or REWROTE (compared by value), and every one of
     *       them must carry a non-empty `why`. The test is on the MOVED entries,
     *       not on the array's length: MEASURED 2026-10-07, the eight rules 1.0.6
     *       clears from a 1.0.5 RE-FLAG carry a witness entry whose `reads` and
     *       volume are unchanged and whose `why` is REWRITTEN (`the flag stands and
     *       the rule is back on the review worklist` becomes `the witness carries
     *       the rule's WHOLE after reading`), so the array does not grow and a
     *       length test would refuse a clear that IS asserted — while the vacuous
     *       clear appends an entry that says nothing, which the moved-entry test
     *       still refuses. Evidence may MOVE but may not SHRINK.
     *   (b) a RE-FLAG with a ONE-SPACE rationale tweak passed, because any
     *       difference counted as movement. A re-flag must say WHY it is back on
     *       the worklist, so its rationale must have GROWN and must carry a stated
     *       marker naming the re-flag — the library's convention is `REBASED`
     *       (the 8 of 1.0.5 all carry `REBASED 1.0.5:`), and a marker naming the
     *       re-flagging version is accepted beside it.
     *   (c) a RE-FLAG that DELETED all evidence passed, because `sameArr` was
     *       false and "moved" counted DESTRUCTION as movement. Evidence may MOVE
     *       but may not SHRINK.
     *
     * A clear or a re-flag that cannot satisfy these is a change nobody asserted,
     * which is the thing the guard exists to refuse. */
    const whyOf = (e) => (e && typeof e.why === 'string' ? e.why.trim() : '');
    const gainedEntries = (nowEv, wasEv) =>
      (Array.isArray(nowEv) ? nowEv : []).filter((e) => !(Array.isArray(wasEv) ? wasEv : []).some((w) => JSON.stringify(w) === JSON.stringify(e)));
    const RE_FLAG_MARKER = /\b(REBASED|RE-FLAGGED|REOPENED)\b/;
    const namesTheVersion = (t) =>
      new RegExp(`(^|[^0-9.])${v.replace(/\./g, '\\.')}([^0-9.]|$)`).test(String(t || ''));
    const clearedWithoutEvidence = !prevRules
      ? []
      : rules.filter((r) => {
          const was = prevRules.get(r.id);
          if (!was || !(was.review === true && r.review === false)) return false;
          const nowEv = Array.isArray(r.evidence) ? r.evidence : [];
          const wasEv = Array.isArray(was.evidence) ? was.evidence : [];
          const gained = gainedEntries(nowEv, wasEv);
          return !(nowEv.length >= wasEv.length && !sameArr(r.evidence, was.evidence) && gained.length > 0 && gained.every((e) => whyOf(e) !== ''));
        });
    const reflagged = !prevRules
      ? []
      : rules.filter((r) => {
          const was = prevRules.get(r.id);
          if (!was || !(was.review === false && r.review === true)) return false;
          const nowEv = Array.isArray(r.evidence) ? r.evidence : [];
          const wasEv = Array.isArray(was.evidence) ? was.evidence : [];
          const notShrunk = nowEv.length >= wasEv.length;
          const moved = !sameArr(r.evidence, was.evidence);
          const rationaleGrew =
            String(r.rationale).length > String(was.rationale).length &&
            (RE_FLAG_MARKER.test(String(r.rationale)) || namesTheVersion(r.rationale));
          return !(notShrunk && moved && rationaleGrew);
        });
    check(
      rewritten.length === 0,
      `v${v}: every id it shares with an earlier version is the SAME rule — ${appended} id(s) appended, ${rules.length - appended} carried unchanged` +
        (rewritten.length ? `; id(s) rewritten: ${rewritten.map((r) => r.id).slice(0, 5).join(', ')}` : ''),
    );
    check(
      clearedWithoutEvidence.length === 0,
      `v${v}: every rule whose review went true→false GAINED a non-empty evidence entry (${clearedWithoutEvidence.length} did not${clearedWithoutEvidence.length ? `: ${clearedWithoutEvidence.slice(0, 5).map((r) => r.id).join(', ')}` : ''})`,
    );
    check(
      reflagged.length === 0,
      `v${v}: no rule a human had cleared from the review worklist is re-flagged SILENTLY (a re-flag must move the rule’s evidence or its rationale) — ${reflagged.length} silent${reflagged.length ? `: ${reflagged.slice(0, 5).map((r) => r.id).join(', ')}` : ''}`,
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
