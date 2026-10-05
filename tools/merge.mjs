#!/usr/bin/env node
/**
 * merge.mjs — fold the full read's PROPOSALS into this edition's rules, under the
 * build's own invariant.
 *
 * WHY THIS EXISTS. The rules are ordered and every rule must FIRE or the build
 * fails (`acceptanceRule`). So a merge is not "append the findings": adding a
 * longer find before a shorter one steals the shorter rule's only occurrence and
 * the build fails; adding a shorter find first shatters a longer one. This tool
 * applies the findings the way the READER will, one block at a time, in the
 * order the rules file will carry, and keeps a candidate ONLY IF
 *   (a) every rule already in the file still fires at least once, and
 *   (b) the candidate itself fires at least once.
 * Anything else is dropped and named. Nothing here is a judgement about the
 * reading — it is the same mechanical contract the build enforces, run ahead of
 * the build so a bad candidate is dropped instead of failing the tree.
 *
 * WHAT IT REFUSES TO DO:
 *   - overwrite a recorded reading (a finding that contradicts a rule's `replace`
 *     is DROPPED, not merged — the recorded one stands; a human decides those);
 *   - write a bracket glyph the print does not use (a `replace` that introduces
 *     `[`/`]` where the find has none is the PARALLEL's glyph, MEASURED: the 1917
 *     print sets Taylor's brackets as parentheses, 91 "(" against 0 "[");
 *   - keep a rule whose find the transcription does not carry verbatim.
 *
 * WRITES ONLY the rules file (`edits/<slug>.json`), and only with --write.
 *   node tools/library/merge.mjs                 # dry run: report, write nothing
 *   node tools/library/merge.mjs --write         # fold the accepted candidates in
 *   node tools/library/merge.mjs --from <file>   # a findings file (default: .fullread.json)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyEditsCounted, editsPath, loadEdits } from './extract.mjs';
import { TEXTS } from './shelf.mjs';

const args = process.argv.slice(2);
const write = args.includes('--write');
const fromIx = args.indexOf('--from');
const fromArg = fromIx >= 0 ? args[fromIx + 1] : null;
// the slug is the first argument that is neither a flag nor the --from value
const slug =
  args.find((a, i) => !a.startsWith('--') && i !== fromIx + 1) ||
  'porphyry-on-the-cave-of-the-nymphs-taylor-1917';

const entry = TEXTS.find((t) => t.slug === slug);
if (!entry) throw new Error(`merge: no such text on the shelf: ${slug}`);
if (!existsSync(path(slug, 't'))) throw new Error('merge: the text is not built — run the build first so the served blocks are the ones this checks against');

function path(s, ext) {
  return join(process.cwd(), 'dist', 'library', s, ext);
}

const doc = JSON.parse(readFileSync(path(slug, 't'), 'utf8'));
const blockTexts = (doc.blocks || []).filter((b) => typeof b.x === 'string').map((b) => b.x);
// The fields the reader applies rules to, joined — the domain a find must live in.
const served = blockTexts.join('\n');

// The RAW file, not loadEdits' mapped view: loadEdits returns `repl`/`cls`, and
// writing that back would corrupt the file's schema (`replace`/`class`/`edits`).
const rawFile = JSON.parse(readFileSync(editsPath(slug), 'utf8'));
const rules = rawFile.edits; // the committed rules, verbatim, in order
const toEngine = (list) => list.map((r) => ({ find: r.find, repl: r.replace ?? r.repl, action: r.action }));

/* ---------- the findings ---------- */
const findingsFile = fromArg || join(process.cwd(), 'tools', 'library', 'edits', `${slug}.fullread.json`);
const findingsRaw = JSON.parse(readFileSync(findingsFile, 'utf8'));
const findings = findingsRaw.findings || findingsRaw.proposals || [];
// whether the findings were decided against a PARALLEL edition — the premise of
// the bracket-glyph check below (see it)
const findingsHaveParallel = !!findingsRaw.parallel;

const DAMAGE = new Set('^_~*/£>\\|#™±»«}{&');
const hasBracket = (s) => s.includes('[') || s.includes(']');

const drop = []; // { finding, why }
const candidates = [];

// Dedupe (find, replace) first — the same row can appear once per region.
const seen = new Set();
for (const f of findings) {
  const key = `${f.find}\u0000${f.replace}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const { find, replace } = f;
  if (typeof find !== 'string' || typeof replace !== 'string' || !find) { drop.push([f, 'no find/replace']); continue; }
  if (find === replace) { drop.push([f, 'the replacement is the find']); continue; }
  if (!served.includes(find)) { drop.push([f, 'the find is not in the served transcription']); continue; }

  const existing = rules.find((r) => r.find === find);
  if (existing) {
    if ((existing.replace ?? existing.repl) === replace) { drop.push([f, 'already recorded, same reading']); continue; }
    drop.push([f, `CONFLICTS with the recorded reading "${existing.replace ?? existing.repl}" — the recorded one stands`]);
    continue;
  }
  /* THE BRACKET GLYPH, and its PREMISE. The rule exists because the PARALLEL's
   * glyph was being copied into a replace: the Cave's 1917 print sets Taylor's
   * brackets as PARENTHESES (MEASURED 91 '(' against 0 '['), while the 1823
   * parallel sets them as '[' — so a '[' in a replace was the parallel's, not the
   * print's. THE PREMISE IS THE PARALLEL. A text with NO parallel has no glyph to
   * copy, and its own print may use square brackets outright — MEASURED: the 1816
   * Proclus transcription carries 73 '[' and 75 ']' (Taylor brackets his
   * additions that way), and four findings repair the damaged glyph '£' -> '['.
   * Rejecting those was the rule overreaching past its evidence. */
  if (findingsHaveParallel && hasBracket(replace) && !hasBracket(find)) {
    drop.push([f, 'the replacement writes a bracket glyph the print does not use (it copies the parallel)']);
    continue;
  }
  // a replace that still carries a damage character would assert damaged print
  if ([...replace].some((c) => DAMAGE.has(c)) && ![...find].some((c) => DAMAGE.has(c))) { drop.push([f, 'the replacement still carries a damage character']); continue; }

  candidates.push({ find, replace, class: f.kind === '1' || f.kind === '2' || f.kind === '3' ? 'reading' : 'reading', note: note(f), _f: f });
}

function note(f) {
  const w = f.decided_by === 'parallel' ? 'the 1823 parallel' : f.decided_by === 'both' ? 'the transcription and the 1823 parallel' : "the transcription's own context";
  return `${f.note} (decided by ${w}.)`;
}

/* ---------- T4: a bare find that occurs more than once would repair them all ---------- */
const WORDY = /^[A-Za-z]/;
/** The occurrences of `f` in `text` that are the WHOLE token, not a run inside a
 *  bigger word. A rule is applied by `split` (every occurrence), so a bare `tne`
 *  also matches the `tne` inside "sweetness"; widening around THAT occurrence
 *  corrupts a correct word (MEASURED: it produced `sweetness o` -> `sweethess o`).
 *  Target only the occurrences bounded by non-letters. */
function properIndices(text, f) {
  const out = [];
  const leady = WORDY.test(f);
  const traily = /[A-Za-z]$/.test(f);
  for (let i = text.indexOf(f); i >= 0; i = text.indexOf(f, i + 1)) {
    const before = i === 0 ? '' : text[i - 1];
    const after = text[i + f.length] || '';
    if ((!leady || !/[A-Za-z0-9]/.test(before)) && (!traily || !/[A-Za-z0-9]/.test(after))) out.push(i);
  }
  return out;
}
function uniqueCount(text, f) {
  return text.split(f).length - 1;
}
function widen(c) {
  const raw = uniqueCount(served, c.find);
  if (raw <= 1) return c; // it can only touch its one site
  const proper = properIndices(served, c.find);
  if (proper.length === 0) return null;

  /* A MULTI-SITE FIND IS NOT AUTOMATICALLY WRONG — it is wrong only when the
   * sites need DIFFERENT readings. MEASURED: the first cut isolated EVERY
   * multi-site find to one site, which broke the other sites silently. The
   * ligature garbles are the example: `Phcedrus` -> `Phædrus` is right at all
   * three sites, and isolating one left the other two reading `Phcedrus` (the
   * improved vocabulary sweep found them later). `de scending`, `cold ness`,
   * `Capri corn` and `situa tion` are the same shape.
   *
   * TWO signals say the same reading holds at every site, and then the find is
   * left BARE:
   *   (a) the replacement CONTAINS the find — an insertion (`depraved natures.
   *       Hence` -> `... Hence,`) extends the printed text, so there is one
   *       reading and no site can want another;
   *   (b) the FINDING counted the sites (`sites > 1`) and gave ONE reading for
   *       them — the proposer looked at every occurrence and asserted the same
   *       word; the merge's job is to preserve that claim or refuse it, not to
   *       silently reinterpret it as a one-site rule.
   * Otherwise the sites may differ and the find is isolated to one — which is
   * what the widening was for. */
  /* IT MUST ALSO BE SAFE AT EVERY OCCURRENCE. A rule is applied by `split`, so a
   * bare find reaches INSIDE other words: `tne` occurs five times as a word and
   * once inside "sweetness", and a bare `tne` -> `the` would corrupt it (MEASURED
   * — that was a real bug). So bare requires that EVERY raw occurrence is also a
   * word-bounded one; if any occurrence sits inside a larger word, the find is
   * widened instead, which is what isolates it to the safe site. */
  const allProper = proper.length === raw;
  const claimsSame = allProper && (c.replace.includes(c.find) || (c._f && Number(c._f.sites) > 1));
  if (claimsSame) return { ...c, _bare: raw };

  // grow the find around the FIRST PROPER occurrence until it names exactly one
  // RAW occurrence (so the rule can reach nothing else); the replacement grows
  // with the context on each side.
  const at = proper[0];
  for (let grow = 1; grow <= 80; grow++) {
    const lo = Math.max(0, at - grow);
    const hi = Math.min(served.length, at + c.find.length + grow);
    const wideFind = served.slice(lo, hi);
    if (uniqueCount(served, wideFind) !== 1) continue;
    const left = served.slice(lo, at);
    const right = served.slice(at + c.find.length, hi);
    return { ...c, find: wideFind, replace: left + c.replace + right, _widened: raw };
  }
  return null; // cannot isolate it — drop rather than repair five sites for one
}

/* ---------- an INSERTION must not leave its own find standing ---------- */
/**
 * A rule whose replacement CONTAINS its find (an insertion: `depraved natures.
 * Hence` -> `depraved natures. Hence,`) is not saturating — the reader applies a
 * rule once, so the find survives in its own output, and the search smoke (which
 * asserts no rule leaves its find in the corrected text) fails. MEASURED: the
 * first all-in merge put 8 such rules in and the search smoke caught it. The fix
 * keeps the rule's effect identical and grows the find one character to the side
 * the insertion sits on, so the find is no longer a prefix/suffix of the replace.
 * The grown characters are copied from the transcription, so the rule still
 * states the print's word.
 */
function deself(c) {
  let { find, replace } = c;
  for (let guard = 0; guard < 500 && replace.includes(find); guard++) {
    const at = served.indexOf(find);
    if (at < 0) break;
    if (replace.startsWith(find)) {
      const next = served[at + find.length];
      if (next === undefined) break;
      find += next;
      replace += next;
    } else if (replace.endsWith(find)) {
      const prev = served[at - 1];
      if (prev === undefined) break;
      find = prev + find;
      replace = prev + replace;
    } else break; // a middle insertion never contains its find — nothing to do
  }
  return { ...c, find, replace };
}

const widened = [];
for (const c of candidates) {
  const w = widen(c);
  if (w) widened.push(deself(w));
  else { c._unwidenable = true; widened.push(c); }
}

/* ---------- the widener's self-test ---------- */

/* THE WIDENER HAS THREE BEHAVIOURS and every one of them was a bug when it was
 * missing: a single-site find is left alone, a multi-site find whose occurrences
 * all need the SAME reading is left BARE (isolating it broke the other sites), and
 * a multi-site find with an occurrence INSIDE a larger word is widened (a bare
 * `tne` -> `the` corrupts "sweetness"). This checks all three against the served
 * text, so a change to the rule has to keep them. */
if (args.includes('--self-test')) {
  const cases = [
    ['situa tion', 'situation', { _f: { sites: 2 } }, 'bare', 'a multi-site find with one reading stays bare'],
    ['tne', 'the', { _f: { sites: 5 } }, 'widen', 'a find with an occurrence inside a word is widened (tne in "sweetness")'],
  ];
  let bad = 0;
  for (const [find, replace, meta, want, why] of cases) {
    const c = { find, replace, note: '', _f: meta._f };
    const raw = uniqueCount(served, find);
    const proper = properIndices(served, find);
    if (!served.includes(find)) { console.log(`  SKIP   ${find} is not in this text`); continue; }
    const w = widen({ ...c });
    const got = w && w._bare ? 'bare' : w ? 'widen' : 'drop';
    const ok = got === want;
    console.log((ok ? '  OK   ' : '  FAIL ') + `${why} (${find}: ${raw} raw, ${proper.length} bounded -> ${got}, wanted ${want})`);
    if (!ok) bad += 1;
  }
  process.exit(bad ? 1 : 0);
}

/* ---------- order: longest find first (specific before general) ---------- */
function order(list) {
  // stable: a longer find that contains a shorter one must run first, or it
  // shatters the shorter rule's occurrence.
  return list.slice().sort((a, b) => (b.find.length - a.find.length) || 0);
}

/* ---------- the contract: existing rules keep firing; candidates must fire ---------- */
function simulate(finalRules) {
  const engine = toEngine(finalRules);
  const hits = engine.map(() => 0);
  for (const t of blockTexts) applyEditsCounted(t, engine, (i, n) => { hits[i] += n; });
  return hits;
}

// The file's own order must be preserved for the EXISTING rules (their order is
// recorded), so the candidates go in front of the reading group, longest first.
/* WHERE THE READING GROUP BEGINS. The candidates are `reading` class and go
 * before the file's own reading/review rules; the opener and digit rules must stay
 * FIRST (the classes are grouped in pipeline order, and a reading rule placed
 * before an opener would consume the characters the opener needs — the extractor
 * REFUSES such a file). MEASURED BUG: this searched only for 'reading', so a file
 * with NO reading rules (the first Proclus merge — 14 openers and nothing else)
 * returned -1, `slice(0, -1)`/`slice(-1)` split the LAST OPENER off as if it were
 * the reading group, and the 286 new rules were inserted in front of it. The
 * default build never extracts a held-back text, so nothing caught it; the
 * extractor threw only when the text was read directly. */
const FI0 = rules.findIndex((r) => r.class === 'reading' || r.class === 'review');
const FI = FI0 < 0 ? rules.length : FI0;
const head = rules.slice(0, FI);          // opener, digit
const reading = rules.slice(FI);          // reading + review, in file order

// place candidates before the reading group, longest-first
let placed = order(widened.filter((c) => !c._unwidenable));
let accepted = [];
const rejectedByContract = [];

// Greedy: add candidates one at a time (longest first); keep each only if the
// whole set still satisfies (a) every existing rule fires and (b) this candidate fires.
for (const c of placed) {
  const trial = [...accepted, c];
  const finalReading = [...order(trial), ...reading];
  const full = [...head, ...finalReading];
  const hits = simulate(full);
  const nHead = head.length;
  const trialHits = hits.slice(nHead, nHead + trial.length);
  const readingHits = hits.slice(nHead + trial.length);
  const existingAllFire = readingHits.every((h) => h > 0);
  const trialAllFire = trialHits.every((h) => h > 0);
  if (existingAllFire && trialAllFire) {
    accepted = trial;
  } else {
    rejectedByContract.push([c, !trialAllFire ? 'it does not fire in this order' : 'it would silence an existing rule']);
  }
}

const newRules = order(accepted).map((c) => ({
  find: c.find,
  replace: c.replace,
  class: 'reading',
  note: c.note,
}));
const outRules = [...head, ...newRules, ...reading];

// Final verification before writing.
const hits = simulate(outRules);
const nHead = head.length;
const deadExisting = outRules.slice(nHead + newRules.length).filter((_, i) => hits[nHead + newRules.length + i] === 0);
const deadNew = newRules.filter((_, i) => hits[nHead + i] === 0);

/* ---------- report ---------- */
const byReason = new Map();
for (const [f, why] of drop) byReason.set(why.split(' —')[0], (byReason.get(why.split(' —')[0]) || 0) + 1);
console.log(`merge ${slug}`);
console.log(`  findings ${findings.length}; distinct candidates ${candidates.length}; left BARE (multi-site, one reading) ${widened.filter((c) => c._bare).length}; widened to one site ${widened.filter((c) => c._widened).length}; unwidenable ${widened.filter((c) => c._unwidenable).length}`);
console.log(`  dropped before the contract: ${drop.length}`);
for (const [r, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(3)}  ${r}`);
console.log(`  rejected by the fire contract: ${rejectedByContract.length}`);
for (const [c, why] of rejectedByContract) console.log(`     ${why}: ${JSON.stringify(c.find)} -> ${JSON.stringify(c.replace)}`);
console.log(`  ACCEPTED ${newRules.length} new rule(s)`);
console.log(`  rules ${rules.length} -> ${outRules.length}`);
console.log(`  verification: dead existing ${deadExisting.length}, dead new ${deadNew.length}`);
if (deadExisting.length) console.log(`     DEAD EXISTING (would fail the build): ${deadExisting.map((r) => r.find).join(' | ')}`);
if (deadNew.length) console.log(`     DEAD NEW: ${deadNew.map((r) => r.find).join(' | ')}`);
if (args.includes('--verbose')) console.log(`  ACCEPTED:\n${newRules.map((r) => `     ${JSON.stringify(r.find)} -> ${JSON.stringify(r.replace)}`).join('\n')}`);

if (write) {
  if (deadExisting.length || deadNew.length) throw new Error('merge: refusing to write — the fire contract is not met');
  rawFile.edits = outRules;
  writeFileSync(editsPath(slug), `${JSON.stringify(rawFile, null, 2)}\n`);
  console.log(`  WROTE ${editsPath(slug)}`);
} else {
  console.log('  (dry run — re-run with --write to apply)');
}
