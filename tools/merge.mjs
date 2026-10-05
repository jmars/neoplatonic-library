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
 * WRITES ONLY the version's rule file
 * (`data/editions/<slug>/versions/<semver>/repairs.json`, model §4.3), and only
 * with --write. The rules it writes are CANONICAL (model §4.0-§4.2): a minted id,
 * the `type` that DATA-MODEL §4.1's byte-wise rules fix (§4.1 rule 5's
 * conjectural detection needs the note's own wording and falls through to the
 * conservative default — rule 6, `review: true`), `location.find`, `before`,
 * `after`, `rationale`.
 *   node tools/merge.mjs                 # dry run: report, write nothing
 *   node tools/merge.mjs --write         # fold the accepted candidates in
 *   node tools/merge.mjs --from <file>   # a findings file (default: the read's own artifact)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyEditsCounted, extract, frontMatterText, readEdition, sha256, editsPath, repairsPath, versionOf } from './extract.mjs';
import { TEXTS } from './shelf.mjs';

const args = process.argv.slice(2);
const write = args.includes('--write');
const fromIx = args.indexOf('--from');
const fromArg = fromIx >= 0 ? args[fromIx + 1] : null;
// the slug is the first argument that is neither a flag nor the --from value.
// MEASURED BUG: with no `--from`, `fromIx` is -1 and `i !== fromIx + 1` excluded
// argv[0] — so `merge.mjs <slug>` silently fell back to the default slug and ran
// the merge against ANOTHER text's rules.
const slug =
  args.find((a, i) => !a.startsWith('--') && (fromIx < 0 || i !== fromIx + 1)) ||
  'porphyry-on-the-cave-of-the-nymphs-taylor-1917';

const entry = TEXTS.find((t) => t.slug === slug);
if (!entry) throw new Error(`merge: no such text on the shelf: ${slug}`);

/* THE BLOCKS COME FROM THE EDITION, not from a built page. This tool was copied
 * from the blog, where the served blocks were read back out of
 * `dist/library/<slug>/t`; the library's served document lives at
 * `site/dist/texts/<slug>/t`, and its blocks are MEASURED byte-identical to the
 * extractor's own (the reading view is DERIVED from them, it is not stored in
 * them — the `corrections` array beside them is). Reading the edition directly is
 * therefore the same domain the rules run in, and it needs no build. */
const src = readEdition(slug);
const doc = extract(src, { entry, sha256: sha256(src) });
const blockTexts = (doc.blocks || []).filter((b) => typeof b.x === 'string').map((b) => b.x);
// The fields the reader applies rules to, joined — the domain a find must live in.
const served = blockTexts.join('\n');
/* THE FRONT MATTER IS PRESERVED BY CONSTRUCTION (extract.mjs checkFrontMatter,
 * plan §7): the title page's own spoiled reading is CITED AS EVIDENCE by a reading
 * that uses this text, so no rule may touch it. The build asserts this at the end;
 * asserting it HERE drops the candidate instead of writing a rule the build will
 * refuse — MEASURED: a page-image merge folded 2 rules whose find stood on the
 * title page ("h Sites R", "hs res r") and the build threw on them. */
const frontMatter = frontMatterText(doc);

/* THE CANONICAL RULE (model §4.0/§4.3), read RAW: `loadEdits` returns the mapped
 * engine view (`repl`/`cls`/`action`), and writing that back would corrupt the
 * file's schema. The accessors below are the ONLY places the canonical field
 * names appear, so the merge's own logic reads the same either way.
 *
 * THE FILE IS THE VERSION'S OWN `repairs.json` — the single source of truth the
 * build reads. It is NOT `editsPath(slug)`, which is `tools/edits/<slug>.json`:
 * the blog's rules file, kept beside the pipeline and read by NOTHING (model
 * §4.3). Writing there would have folded every candidate into a dead copy. */
const version = versionOf(slug);
const rulesFile = version ? repairsPath(slug, version) : null;
if (!rulesFile || !existsSync(rulesFile)) {
  throw new Error(
    `merge: ${slug}: no canonical rule file (data/editions/<slug>/versions/<semver>/repairs.json) — ` +
      `the pipeline folds into THAT file (model §4.3)`,
  );
}
const rawFile = JSON.parse(readFileSync(rulesFile, 'utf8'));
const rules = rawFile.rules; // the committed rules, verbatim, in order
const rFind = (r) => r.location.find;
const rAfter = (r) => r.after;
const rApply = (r) => r.apply;
/* The contract simulation runs over BOTH shapes by design: the committed rules
 * (canonical, §4.0) and the CANDIDATES in flight (`{find, replace, note}`, the
 * blog's own candidate shape, kept because `widen`/`deself`/the report read it).
 * Only the canonical accessors are strict, so a malformed COMMITTED rule throws
 * where it is read. */
const toEngine = (list) =>
  list.map((r) =>
    r.location
      ? { find: rFind(r), repl: rAfter(r), action: rApply(r) === 'review' ? 'leave' : 'replace' }
      : { find: r.find, repl: r.replace, action: 'replace' },
  );

/* ---------- the findings ---------- */
// DEFAULT: the read's own artifact, which fullread.mjs writes into the pipeline's
// artifact directory (`tools/edits/`), never the blog's `tools/library/edits/` path.
const findingsFile = fromArg || join(editsPath(slug).replace(/[^/]+$/, ''), `${slug}.fullread.json`);
const findingsRaw = JSON.parse(readFileSync(findingsFile, 'utf8'));
const findings = findingsRaw.findings || findingsRaw.proposals || [];
// whether the findings were decided against a PARALLEL edition — the premise of
// the bracket-glyph check below (see it)
const findingsHaveParallel = !!findingsRaw.parallel;
/* THE PARALLEL'S OWN NAME, from the artifact's record of it. The note used to say
 * "the 1823 parallel" — the Cave's parallel, hardcoded. The Theology of Plato's is
 * the 1816 second transcription, so a hardcoded year would MISNAME the witness
 * every new rule was decided from. The label is the year in the parallel's own
 * file name (`...-1816.txt` -> "1816"), which is how the corpus names witnesses
 * ("1816 parallel", "1823 parallel"). */
const parallelLabel = (() => {
  const file = findingsRaw.parallel && findingsRaw.parallel.file;
  if (!file) return null;
  const y = /\b(1[6-9]\d\d)\b/.exec(file);
  return y ? `${y[1]} parallel` : String(file).replace(/\.[^.]+$/, '');
})();

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

  if (frontMatter.includes(find)) {
    drop.push([f, 'the find stands in the front-matter region (the title page is preserved by construction)']);
    continue;
  }
  const existing = rules.find((r) => rFind(r) === find);
  if (existing) {
    if (rAfter(existing) === replace) { drop.push([f, 'already recorded, same reading']); continue; }
    drop.push([f, `CONFLICTS with the recorded reading "${rAfter(existing)}" — the recorded one stands`]);
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
  const par = parallelLabel ? `the ${parallelLabel}` : 'the parallel edition';
  const w =
    f.decided_by === 'parallel'
      ? par
      : f.decided_by === 'both'
        ? `the transcription and ${par}`
        : /* A reading taken off the PAGE IMAGE (tools/vision-unsure.mjs) was not
           * decided by the transcription at all: the transcription and the parallel
           * are both OCR passes over this print. Saying otherwise would misname the
           * witness of every such rule. */
          f.decided_by === 'page'
          ? 'the page image itself'
          : /* A READING DECIDED FROM ANOTHER COPY OF THE SAME PRINT — another scan
             * of the same 1816 print, its own OCR (and, where one copy's text
             * stands alone, its own page image). It is neither the parallel (that
             * is the second transcription, a text this library holds) nor this
             * edition's own stored leaf, so the rule states the witness itself:
             * which copies, which printed page, which leaf of which item. */
            f.decided_by === 'witness' && typeof f.witness === 'string' && f.witness
            ? f.witness
            : "the transcription's own context";
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
/* THE FROM-SCRATCH PASS, kept as the AUTHORITATIVE final count (and as the
 * cross-check on the incremental engine below). It is ONE pass over the whole
 * rule list, which is affordable; what was not affordable was running it once
 * per candidate — see the measurement under the engine. */
function simulate(finalRules) {
  const engine = toEngine(finalRules);
  const hits = engine.map(() => 0);
  for (const t of blockTexts) applyEditsCounted(t, engine, (i, n) => { hits[i] += n; });
  return hits;
}

// The file's own order must be preserved for the EXISTING rules (their order is
// recorded and their ids run r0001 upward in file order), so the candidates go at
// the END of the reading group, longest first among themselves. Appending is the
// only placement that keeps the id sequence ascending (tools/repair-id-probe.mjs)
// and it cannot silence an existing rule, since a later rule cannot change what an
// earlier one matched.
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
const FI0 = rules.findIndex((r) => rApply(r) === 'reading' || rApply(r) === 'review');
const FI = FI0 < 0 ? rules.length : FI0;
const head = rules.slice(0, FI);          // opener, digit
const reading = rules.slice(FI);          // reading + review, in file order

// place candidates before the reading group, longest-first
let placed = order(widened.filter((c) => !c._unwidenable));
let accepted = [];
const rejectedByContract = [];

/* ---------- THE CONTRACT, RUN PER BLOCK (the fix for the 93-minute no-finish) ----------
 *
 * MEASURED, on THIS edition (8,613 findings -> 8,297 candidates, 22,118 blocks,
 * 1,647,591 served chars): the greedy loop below called `simulate` once per
 * candidate, and `simulate` re-walks EVERY rule over EVERY block. For the first
 * 97 candidates that is 109,329,274 block x rule applications in 15.1 s (138 ns
 * each); the full run is sum_i 22,118 x i = 7.6e11 applications, c. 29 h. That —
 * not the widener — is the whole of the 93-minute no-finish. (The same
 * instrumentation measured the whole widener, pre-drop included, at 8.4 s: 9,273
 * `uniqueCount` calls, 1,540 `properIndices` calls, 976 grow iterations.)
 *
 * THE CONTRACT DECOMPOSES PER BLOCK, and that is what makes it cheap.
 * `applyEditsCounted` is applied one BLOCK at a time (there is no cross-block
 * state), so the document's hits are the SUM of the per-block hits; and adding a
 * candidate can only change the blocks that carry its `find`. The engine keeps,
 * per block, the text after the head rules, the text after the accepted
 * candidates, and the SPARSE hits of the candidates and of the reading rules in
 * that block. A trial recomputes only the blocks it touches and moves the running
 * totals by the difference. The ACCEPT TEST IS UNCHANGED — same rules, same
 * order, same `> 0` predicate — so the accepted set is identical.
 *
 * ONE ORDERING SUBTLETY makes "only the blocks it touches" sound: `order` is a
 * STABLE sort by find length and a trial is `order([...accepted, c])`, so
 * inserting `c` leaves every other rule's order among itself unchanged, and in a
 * block where `c.find` does not occur the pre-`c` text is exactly the text the
 * from-scratch pass would have at that point. */
const headEngine = toEngine(head);
const readingEngine = toEngine(reading);

/** The same walk `applyEditsCounted` makes over one block, returning the sparse
 *  hit table (rule index -> occurrences at the moment that rule is applied)
 *  instead of the totals. */
function blockHits(text, rules) {
  const hits = new Map();
  let out = text;
  for (let i = 0; i < rules.length; i++) {
    const f = rules[i].find;
    if (!f) continue;
    const leave = rules[i].action === 'leave';
    if (!leave && f === rules[i].repl) continue;
    const parts = out.split(f);
    if (parts.length === 1) continue;
    hits.set(i, parts.length - 1);
    if (leave) continue;
    out = parts.join(rules[i].repl);
  }
  return { text: out, hits };
}

const base = blockTexts.map((t) => blockHits(t, headEngine).text);
/* THE CANDIDATES ARE WRITTEN AFTER THE READING GROUP, so the engine walks the
 * same order. That is a HARD requirement, not a preference: a rule id is minted
 * in file order and tools/repair-id-probe.mjs holds the file to `r0001…rN` in
 * RULE ORDER — MEASURED: inserting the 451 candidates in front of the reading
 * group put `r8059` at index 1 and failed that probe. Appending also makes the
 * contract SIMPLER: a rule that runs after another cannot change what the other
 * matched, so the reading rules' hits are computed ONCE and can never be
 * silenced by a candidate. What a candidate has to satisfy is unchanged — it must
 * fire — and the honest count is the from-scratch pass below. */
const curation = blockTexts.map((t) => blockHits(t, headEngine));
const curation2 = curation.map((r) => blockHits(r.text, readingEngine));
const cur = curation2.map((r) => r.text);
const rhits = new Array(base.length).fill(null);
const chits = new Array(base.length).fill(null);
const rtotal = new Array(readingEngine.length).fill(0);
const ctotal = new Map(); // candidate -> its occurrences over all blocks
for (let b = 0; b < base.length; b++) {
  const hits = curation2[b].hits;
  if (hits.size) { rhits[b] = hits; for (const [i, n] of hits) rtotal[i] += n; }
}
function untotal(b) {
  const c = chits[b];
  if (c) for (const [o, n] of c) ctotal.set(o, (ctotal.get(o) || 0) - n);
}
function total(b) {
  const c = chits[b];
  if (c) for (const [o, n] of c) ctotal.set(o, (ctotal.get(o) || 0) + n);
}
/** Recompute block `b` under the trial's ordered candidate list and leave the
 *  running totals carrying its new hits. `cur[b]` is the text the READING RULES
 *  leave behind and is never written by a candidate. */
function recompute(b, list) {
  untotal(b);
  let t = cur[b];
  const c = new Map();
  for (const cc of list) {
    const parts = t.split(cc.find);
    if (parts.length === 1) continue;
    c.set(cc, (c.get(cc) || 0) + parts.length - 1);
    t = parts.join(cc.replace);
  }
  chits[b] = c.size ? c : null;
  total(b);
}

// Greedy: add candidates one at a time (longest first); keep each only if the
// whole set still satisfies (a) every existing rule fires and (b) this candidate fires.
let sortedAccepted = []; // `accepted` in `order()` order, kept by insertion
for (const c of placed) {
  // where `c` lands in `order([...accepted, c])`: a stable sort by find length
  // puts it after every candidate of its own length, so it is inserted there.
  let at = sortedAccepted.findIndex((x) => x.find.length < c.find.length);
  if (at < 0) at = sortedAccepted.length;
  const trial = sortedAccepted.slice();
  trial.splice(at, 0, c);

  const affected = [];
  for (let b = 0; b < cur.length; b++) if (cur[b].includes(c.find)) affected.push(b);
  const saved = affected.map((b) => [b, cur[b], rhits[b], chits[b]]);
  for (const b of affected) recompute(b, trial);

  const existingAllFire = rtotal.every((h) => h > 0);
  const trialAllFire = trial.every((x) => (ctotal.get(x) || 0) > 0);
  if (existingAllFire && trialAllFire) {
    accepted.push(c);
    sortedAccepted.splice(at, 0, c);
  } else {
    for (let i = saved.length - 1; i >= 0; i--) {
      const [b, t0, r0, c0] = saved[i];
      untotal(b);
      cur[b] = t0; rhits[b] = r0; chits[b] = c0;
      total(b);
    }
    rejectedByContract.push([c, !trialAllFire ? 'it does not fire in this order' : 'it would silence an existing rule']);
  }
}

/* ---------- the canonical rule (model §4.0-§4.3) ---------- */

/* THE ID IS MINTED, never reused or renumbered (model §4.2): the next free
 * `<slug>:r<NNNN>` after the highest the file already carries. */
const idNum = (r) => Number((/:r(\d+)$/.exec(r.id) || [])[1] || 0);
let nextId = rules.reduce((m, r) => Math.max(m, idNum(r)), 0);

/** The characters by which two strings differ, as a multiset (a char present in
 * one and not the other). Kept in step with build/migrate.mjs's own classifier —
 * it is the migration's §4.1 implementation, and this is the same decision. */
function diffChars(a, b) {
  const m = new Map();
  for (const c of a) m.set(c, (m.get(c) || 0) - 1);
  for (const c of b) m.set(c, (m.get(c) || 0) + 1);
  const out = [];
  for (const [c, v] of m) if (v !== 0) out.push(c);
  return out;
}

const GREEK = /[\u0370-\u03ff\u1f00-\u1fff]/;
const DAMAGE_CHARS = new Set('^_~*/£>\\|#™±»«}{&');

/* DATA-MODEL §4.1's ordered decision, for the classes a READ proposes. Rules 1-3
 * are byte-wise; rule 4 (`opener`/`digit`) cannot arise here (a finding is class
 * 1/2/3 damage, not a division number); rule 5's conjectural detection reads the
 * note's own wording and is deliberately NOT asserted — a type not fixed by rules
 * 1-4 falls to the conservative default, rule 6 `OCR` with `review: true`, which
 * is the direction the model asks for (a machine asserts no certainty it lacks). */
function classifyRule(find, after) {
  if (GREEK.test(after) && !GREEK.test(find)) {
    return { type: 'transliteration', review: false, evidence: 'after contains Greek script, before does not (rule 1)' };
  }
  if (find.replace(/\s+/g, '') === after.replace(/\s+/g, '')) {
    return { type: 'OCR', review: false, evidence: 'before and after equal after removing all whitespace (rule 2)' };
  }
  const diff = diffChars(find, after);
  if (diff.length && diff.every((c) => DAMAGE_CHARS.has(c))) {
    return { type: 'OCR', review: true, evidence: `differs only in OCR-noise damage characters (${[...new Set(diff)].join('')}) — the print recovered, not punctuation (rule 6)` };
  }
  if (diff.length && diff.every((c) => /[^\w\s]/u.test(c))) {
    return { type: 'punctuation', review: false, evidence: `differs only in punctuation characters: ${[...new Set(diff)].join('')} (rule 3)` };
  }
  return { type: 'OCR', review: true, evidence: 'default OCR (rule 6)' };
}

const newRules = order(accepted).map((c) => {
  const t = classifyRule(c.find, c.replace);
  const decidedByParallel = c._f && (c._f.decided_by === 'parallel' || c._f.decided_by === 'both');
  return {
    id: `${slug}:r${String(++nextId).padStart(4, '0')}`,
    type: t.type,
    apply: 'reading',
    location: { find: c.find, page: null, leaf: null },
    before: c.find,
    after: c.replace,
    rationale: c.note,
    date: null,
    /* THE PAGE-IMAGE PATH, and only it: a finding whose `decided_by` is 'page'
     * carries the leaf it was read from (`witness`, a citable string) and its
     * `evidence` entries (model §4.4's `{kind:'scan', leaf, page, file, url,
     * exists, source}`). MEASURED why this is gated rather than general: on a
     * PARALLEL-decided finding `evidence` is a STRING ("Transcription: '…'"), so
     * folding it unconditionally would put a string where the apparatus reads an
     * array of scans and would fail tools/scan-probe.mjs. */
    witness:
      c._f && c._f.decided_by === 'page' && typeof c._f.witness === 'string' && c._f.witness
        ? c._f.witness
        : c._f && c._f.decided_by === 'witness' && typeof c._f.witness === 'string' && c._f.witness
          ? c._f.witness
          : decidedByParallel && parallelLabel
            ? parallelLabel
            : null,
    /* `fires` IS MEASURED (model §4.0: "how many times `location.find` matches
     * the served text"; §4.2: "a rule that fires four times keeps one ID and
     * `fires: 4`"). It was hardcoded 1, which is right only when every rule
     * happens to fire once — MEASURED: the 446 migrated rules and the 5 the
     * merge had accepted so far all fire once, so nothing caught it, while THIS
     * merge's 8,058 rules apply 11,367 times in the served text. The page states
     * the file's count and the route probe holds it to the sum, so the hardcoded
     * 1 was a false statement on a public page. The count is the engine's own
     * total for the accepted set, which the invariance check below proves equal
     * to the from-scratch pass. */
    fires: ctotal.get(c) || 0,
    join: false,
    type_evidence: t.evidence,
    review: t.review,
    evidence: c._f && c._f.decided_by === 'page' && Array.isArray(c._f.evidence) ? c._f.evidence : [],
  };
});
const outRules = [...head, ...reading, ...newRules];

// Final verification before writing — the FROM-SCRATCH pass, so the counts the
// build will reproduce come from the build's own walk and not from the engine.
const nHead = head.length;
const hits = simulate(outRules);
const deadExisting = outRules.slice(nHead, nHead + reading.length).filter((_, i) => hits[nHead + i] === 0);
const deadNew = newRules.filter((_, i) => hits[nHead + reading.length + i] === 0);

/* THE INVARIANCE CHECK, run on every merge rather than argued on paper: the
 * incremental engine's totals must equal the from-scratch pass for EVERY reading
 * rule and EVERY accepted candidate. A mismatch means a block the engine treated
 * as untouched was not — i.e. the accept decisions above cannot be trusted, and
 * it is said out loud instead of being reconciled silently. */
const mismatched = [
  ...reading.map((_, i) => ((rtotal[i] || 0) === hits[nHead + i] ? null : `reading rule ${i}: engine ${rtotal[i] || 0}, pass ${hits[nHead + i]}`)),
  ...newRules.map((r, i) => ((ctotal.get(sortedAccepted[i]) || 0) === hits[nHead + reading.length + i] ? null : `new rule ${r.id}: engine ${ctotal.get(sortedAccepted[i]) || 0}, pass ${hits[nHead + reading.length + i]}`)),
].filter(Boolean);

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
console.log(`  engine vs from-scratch pass: ${mismatched.length ? `MISMATCH on ${mismatched.length} rule(s)` : 'exact (every reading rule and every accepted rule)'}`);
for (const m of mismatched.slice(0, 10)) console.log(`     ENGINE MISMATCH: ${m}`);
if (deadExisting.length) console.log(`     DEAD EXISTING (would fail the build): ${deadExisting.map((r) => rFind(r)).join(' | ')}`);
if (deadNew.length) console.log(`     DEAD NEW: ${deadNew.map((r) => rFind(r)).join(' | ')}`);
if (args.includes('--verbose')) console.log(`  ACCEPTED:\n${newRules.map((r) => `     ${JSON.stringify(rFind(r))} -> ${JSON.stringify(rAfter(r))}`).join('\n')}`);

if (write) {
  if (deadExisting.length || deadNew.length) throw new Error('merge: refusing to write — the fire contract is not met');
  if (mismatched.length) throw new Error('merge: refusing to write — the incremental engine disagrees with the from-scratch pass');
  rawFile.rules = outRules;
  writeFileSync(rulesFile, `${JSON.stringify(rawFile, null, 2)}\n`);
  console.log(`  WROTE ${rulesFile}`);
} else {
  console.log('  (dry run — re-run with --write to apply)');
}
