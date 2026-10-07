#!/usr/bin/env node
/**
 * tools/echo-probe.mjs — hold the ECHO CHECK to the draws it rests on.
 *
 * WHY. A vision pass over this print's Greek is only evidence where the
 * instrument READ the page: MEASURED here, a draw that returns the transcriber's
 * own line character for character is agreeing with the OCR, not with the print,
 * and on the pass's own two-draw-agreement rule such a draw VOTES for the
 * transcription and can outvote a reader. So the rules a vision pass states are
 * recomputed here against the same thing the pass itself read — the model-keyed
 * draw cache (`data/editions/<slug>/greek-vision.json`) — and the note a rule
 * carries is checked against the draws, not taken on trust.
 *
 * WHAT IT CHECKS.
 *   1. The echo table in the echo-check artifact IS the cache's own numbers:
 *      every configured model's draw count, its verbatim count, and its verbatim
 *      count restricted to the lines where some model read something other than
 *      the transcription. THE CACHE IS APPENDED TO BY LATER PASSES, so the count
 *      is taken over the draws that existed when the artifact was written — the
 *      artifact's own `draws_through` cursor (`at <= draws_through`), MEASURED: a
 *      re-run over the same target set with two of the same models added 144
 *      draws and moved this table (776 -> 864 draws each).
 *   2. NO ECHO INSTRUMENT VOTES. A model whose verbatim share is at or above the
 *      line below (80%, the line this pass's record uses for "an echo, not a
 *      reader") must not be among the artifact's configured models — and the
 *      instrument dropped for exactly this (google/gemma-3-27b-it, 87.4% measured
 *      on the two-model pass) must be absent by name.
 *   3. THE LEDGER of the nine single-instrument Greek rules this pass settled:
 *      every rule the check DROPPED is absent from the edition's rules, and every
 *      rule it KEPT with a second reader's agreement has that agreement in the
 *      cache — the named instrument's non-echo draws must agree with the rule's
 *      own letters, with diacritics and Latin homoglyphs folded, at least twice,
 *      and the instrument must itself be a non-echoing one on this pass. A rule
 *      the check left single-instrument must carry a name in no second
 *      instrument's agreeing draws. The SIXTH withdrawal (r11682) came from the
 *      re-run with the two readers that do not echo, not from the echo check, and
 *      is in the ledger as dropped with that reason.
 *   4. THE RE-RUN'S OWN CLAIM, held to the same cache: the rule the re-run added
 *      (r11688, line 15132) states that the LETTERS of its reading are TWO
 *      instruments', and here each of those two readers — google/gemini-2.5-flash
 *      and anthropic/claude-haiku-4-5 — must have at least two of its own draws
 *      agreeing with those letters (folded). MEASURED: a character-for-character
 *      consensus misses this pair (they differ in accents and quote glyphs), which
 *      is why the claim is checked on the FOLDED letters and not on the tool's own
 *      two-model field.
 *
 *   node tools/echo-probe.mjs            # this edition
 *
 * A gate is the exit code: any FAIL exits 1.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tidyPunctuation } from './extract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'proclus-theology-of-plato-taylor-1816';
const CACHE = join(ROOT, 'data/editions', SLUG, 'greek-vision.json');
const ARTIFACT = join(ROOT, 'tools/edits', `${SLUG}.greek-echo-check.json`);
/* The re-run's artifact (the two readers that do not echo), whose added rule r11688
 * states a two-instrument agreement this probe holds to the same cache. */
const TWO_READER = join(ROOT, 'tools/edits', `${SLUG}.greek-two-reader.json`);
/* WHICH VERSION'S RULES THIS PROBE HOLDS TO THE CACHE: the edition's CURRENT one,
 * read from `edition.json`, never a version number typed here. MEASURED
 * 2026-10-06: this read `versions/1.0.0` literally, which was the edition's ONLY
 * version when it was written; the 1.0.1 bump then made `versions/1.0.0` the
 * FROZEN deposited state (the 3051 rules the old DOI names), so the probe held the
 * echo-check cache to a rule list that predates the Greek pass and reported eight
 * failures — the probe's address, not the data. The decisions it asserts are the
 * ones the SERVED edition carries, which is `current_version`. */
const VERSION = JSON.parse(readFileSync(join(ROOT, 'data/editions', SLUG, 'edition.json'), 'utf8')).current_version;
const RULES = join(ROOT, 'data/editions', SLUG, 'versions', VERSION, 'repairs.json');

let ok = 0;
const fails = [];
const check = (cond, msg) => { if (cond) { ok++; } else { fails.push(msg); } };

const source = readFileSync(join(ROOT, 'data/editions', SLUG, 'versions', VERSION, 'source.txt'), 'utf8')
  .replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const servedLine = (l) => tidyPunctuation(collapse(source[l - 1]));
const MARKER = /^\s*(?:[*•†‡§¶%]\s*|\d{1,2}\s*[.)]?\s*|[¹²³⁴⁵⁶⁷⁸⁹⁰]+\s*)/;
const stripMarker = (s) => s.replace(MARKER, '').replace(/\s+/g, ' ').trim();
const GREEK = /[\u0370-\u03ff\u1f00-\u1fff]/;
/* The letters as an instrument may render them: case, breathings/accents, and
 * the Latin letter an instrument prints for a Greek one (λυραίoς for λυραιος).
 * THE GREEK SPACING MARKS COME OFF TOO: the filter below keeps the whole Greek
 * block, and U+1FBD (koronis) / U+1FBF (psili) / U+1FEF (varia) / U+1FFD (oxia)
 * stand INSIDE it, so a reader that renders an elision as ᾽ where another writes ’
 * stopped matching — MEASURED on r11688, where claude-haiku-4-5's second draw
 * (τὰ καθ᾽ ἕνωσιν) folded to a different string from its first (τὰ καθ' ἕνωσιν) and
 * from gemini-2.5-flash's (τὰ καθ’ ἕνωσιν), all three the same letters. */
const HOMOGLYPH = { a: 'α', b: 'β', e: 'ε', h: 'η', i: 'ι', k: 'κ', n: 'ν', o: 'ο', p: 'ρ', t: 'τ', u: 'υ', v: 'ν', w: 'ω', x: 'χ', y: 'υ', z: 'ζ', m: 'μ' };
const fold = (s) => [...s.normalize('NFD').replace(/[\u0300-\u036f\u0345\u1fbd-\u1fbf\u1fef\u1ffd]/g, '').toLowerCase()]
  .map((c) => HOMOGLYPH[c] || c).filter((c) => /[a-z\u0370-\u03ff\u1f00-\u1fff]/.test(c)).join('');

const cache = JSON.parse(readFileSync(CACHE, 'utf8'));
const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
const twoReader = JSON.parse(readFileSync(TWO_READER, 'utf8'));
const rules = JSON.parse(readFileSync(RULES, 'utf8')).rules;
const ids = new Set(rules.map((r) => r.id.split(':r')[1]));

/* ---------- 1. the echo table IS the cache's numbers, as of the artifact ---------- */
const isVerbatim = (l, t) => stripMarker(collapse(t)) === stripMarker(servedLine(l)) || collapse(t) === collapse(source[l - 1]);
/* THE CURSOR. A draw made by a LATER pass is not evidence about an earlier one,
 * and the artifact records the cache state it was computed over; an artifact with
 * no cursor is counted against the whole cache, which is only sound while no later
 * pass has appended draws for its models. */
const drawsThrough = (a) => (rec) => !(a.draws_through && rec.at && rec.at > a.draws_through);
const drawMap = (a) => {
  const live = drawsThrough(a);
  const map = new Map(); // model -> [{line, text}]
  for (const rec of Object.values(cache.leaves)) {
    if (!a.models.includes(rec.model)) continue;
    if (!live(rec)) continue;
    if (!map.has(rec.model)) map.set(rec.model, []);
    for (const [line, text] of Object.entries(rec.reading || {})) {
      const l = Number(line);
      if (l >= 1 && l <= source.length) map.get(rec.model).push({ line: l, text: collapse(text) });
    }
  }
  return map;
};
check(!!artifact.draws_through, 'the echo-check artifact states the cache state it was computed over (draws_through)');
check(!!twoReader.draws_through, 'the two-reader artifact states the cache state it was computed over (draws_through)');
const draws = drawMap(artifact);
const differing = new Set();
for (const list of draws.values()) for (const d of list) if (d.text && d.text !== '?' && !isVerbatim(d.line, d.text)) differing.add(d.line);
for (const model of artifact.models) {
  const list = draws.get(model) || [];
  const verbatim = list.filter((d) => isVerbatim(d.line, d.text));
  const diff = list.filter((d) => differing.has(d.line));
  const t = artifact.echo[model];
  check(!!t, `the artifact carries no echo entry for ${model}`);
  if (!t) continue;
  check(t.draws === list.length, `${model}: artifact says ${t.draws} draws, the cache holds ${list.length}`);
  check(t.verbatim === verbatim.length, `${model}: artifact says ${t.verbatim} verbatim, the cache shows ${verbatim.length}`);
  check(t.differing.draws === diff.length, `${model}: artifact says ${t.differing.draws} draws on the differing lines, the cache shows ${diff.length}`);
  check(t.differing.verbatim === diff.filter((d) => isVerbatim(d.line, d.text)).length,
    `${model}: artifact says ${t.differing.verbatim} verbatim on the differing lines, the cache shows ${diff.filter((d) => isVerbatim(d.line, d.text)).length}`);
}

/* ---------- 2. no echo instrument votes ---------- */
const ECHO_LINE = 80; // per cent — the threshold this pass's record states
check(!artifact.models.includes('google/gemma-3-27b-it'),
  'google/gemma-3-27b-it is measured an echo instrument on this item (87.4%) and must not be a configured model');
for (const model of artifact.models) {
  const t = artifact.echo[model];
  const share = t ? (100 * t.verbatim) / Math.max(1, t.draws) : 100;
  check(share < ECHO_LINE, `${model}: verbatim share ${share.toFixed(1)}% is at or above the ${ECHO_LINE}% echo line and may not vote`);
}

/* ---------- 3. the ledger ---------- */
const LEDGER = [
  { id: '11679', outcome: 'kept', by: 'google/gemini-2.5-flash' },
  { id: '11680', outcome: 'dropped' },
  { id: '11681', outcome: 'dropped' },
  /* THE SIXTH. The echo check KEPT this one because no second reader had read the
   * passage at all; the re-run with the two readers that do not echo did read it —
   * five different readings, two of them settled, none of them the rule's — so it
   * was withdrawn afterwards. The ledger records the outcome and who withdrew it. */
  { id: '11682', outcome: 'dropped', why: 'withdrawn in the re-run (the two readers DID read the line and gave five different readings, none of them this rule\u2019s)' },
  { id: '11683', outcome: 'dropped' },
  { id: '11684', outcome: 'dropped' },
  { id: '11685', outcome: 'kept', by: null },
  { id: '11686', outcome: 'dropped' },
  { id: '11687', outcome: 'kept', by: 'google/gemini-2.5-flash' },
];
const ruleOf = (id) => rules.find((r) => r.id.endsWith(`:r${id}`));
const lineOf = (find) => { for (let i = 1; i <= source.length; i++) if (servedLine(i).includes(find)) return i; return null; };
for (const entry of LEDGER) {
  const r = ruleOf(entry.id);
  if (entry.outcome === 'dropped') {
    check(!r, entry.why
      ? `r${entry.id} was withdrawn and must not stand in the edition's rules — ${entry.why}`
      : `r${entry.id} was dropped by the echo check and must not stand in the edition's rules`);
    continue;
  }
  check(!!r, `r${entry.id} was kept by the echo check and must stand in the edition's rules`);
  if (!r) continue;
  const line = lineOf(r.location.find);
  check(line != null, `r${entry.id}: its find does not stand in the served transcription`);
  const fRule = fold(stripMarker(r.after));
  for (const model of artifact.models.slice(1)) {
    const list = (draws.get(model) || []).filter((d) => d.line === line && d.text && d.text !== '?' && !isVerbatim(d.line, d.text));
    const agree = list.filter((d) => fold(d.text).includes(fRule));
    if (model === entry.by) {
      check(agree.length >= 2, `r${entry.id}: the note names ${model} as agreeing, but its non-echo draws agreeing with these letters number ${agree.length}`);
      const t = artifact.echo[model];
      const share = t ? (100 * t.differing.verbatim) / Math.max(1, t.differing.draws) : 100;
      check(share < 10, `r${entry.id}: ${model} is not a clean reader on the differing lines (${share.toFixed(1)}% verbatim) and may not corroborate a reading`);
    } else {
      check(agree.length === 0, `r${entry.id}: the ledger records no agreement by ${model}, but its draws agree with these letters ${agree.length} time(s)`);
    }
  }
  /* The kept note must state the check's outcome, not the pre-check claim alone. */
  check(/echo check/i.test(r.rationale || ''), `r${entry.id}: the rationale does not record the echo check`);
  if (entry.by) check(r.rationale.includes(entry.by), `r${entry.id}: the rationale does not name ${entry.by}, the instrument that agreed`);
}

/* ---------- 4. the re-run's own claim: r11688's letters are TWO instruments' ---------- */
/* THE ONE FINDING THE TWO NON-ECHOING READERS CORROBORATE, and the only one whose
 * reading the merge could fold in (the other eight stand in the front-matter region
 * the edition preserves). Its rationale claims the LETTERS are two instruments',
 * so both configured readers must have at least two of their own draws agreeing
 * with those letters — folded, because the pair differs in accents and quote
 * glyphs and the tool's own character-for-character two-model field therefore does
 * not see them as agreeing. */
const twoDraws = drawMap(twoReader);
const r11688 = ruleOf('11688');
check(!!r11688, 'the two-reader pass added r11688 — the reading BOTH non-echoing readers corroborate');
if (r11688) {
  const line = lineOf(r11688.location.find);
  check(line != null, 'r11688: its find does not stand in the served transcription');
  check(/two instruments/i.test(r11688.rationale || ''), "r11688: the rationale does not state the check's outcome (the letters are two instruments')");
  check(/ONE instrument repeated/.test(r11688.rationale || '') === false, 'r11688: the rationale still carries the single-instrument clause');
  if (line != null) {
    const want = fold(r11688.after);
    for (const model of twoReader.models) {
      const agree = (twoDraws.get(model) || []).filter(
        (d) => d.line === line && d.text && d.text !== '?' && !isVerbatim(d.line, d.text) && fold(d.text).includes(want),
      );
      check(agree.length >= 2, `r11688: the rationale names ${model} as reading these letters in both its draws, but its non-echo draws agreeing with them number ${agree.length}`);
    }
  }
}

/* ---------- 5. the CLASSED merge: the single-instrument rules, and the region they stand in ---------- */
/* THE AUTHOR'S CALL OF 2026-10-06: the pass's one-instrument Greek is MERGED, with
 * the uncertainty stated, and the preserved front-matter region admits a rule whose
 * type is `transliteration`. Both are claims about the RULES FILE, so both are held
 * here to the thing they rest on — the draw cache, the classed artifact, and the
 * extractor's own front-matter assertion.
 *
 * THE CLASS IS RE-DERIVED FROM THE CACHE, not read off the artifact: a finding's
 * instruments are the readers whose OWN non-echo draws carry its letters, plus any
 * the pass recorded in `agreeModels`. A drift between the tool that classed the
 * findings and this re-derivation fails.
 */
const MERGE_INPUT = join(ROOT, 'tools/edits', `${SLUG}.greek-merge.json`);
const classed = existsSync(MERGE_INPUT) ? JSON.parse(readFileSync(MERGE_INPUT, 'utf8')) : null;
check(!!classed, 'the classed merge input exists (tools/greek-classify.mjs) and states each finding\'s instruments');
if (classed) {
  const twoDrawsAll = drawMap(classed);
  const instrumentsOf = (f) => {
    const want = fold(f.replace);
    const out = new Set(Array.isArray(f.agreeModels) ? f.agreeModels : []);
    for (const model of classed.models) {
      if (out.has(model)) continue;
      const agree = (twoDrawsAll.get(model) || []).filter(
        (d) => d.line === f.line && d.text && d.text !== '?' && !isVerbatim(d.line, d.text) && fold(d.text).includes(want),
      );
      if (agree.length >= 2) out.add(model);
    }
    return [...out];
  };
  const same = (a, b) => a.slice().sort().join('|') === b.slice().sort().join('|');
  const drift = classed.findings.filter((f) => !same(instrumentsOf(f), f.instruments || []));
  check(
    drift.length === 0,
    `every classed finding's instruments are what its own draws say (${drift.length} drift${drift.length ? `, first: line ${drift[0].line} ${JSON.stringify(drift[0].instruments)} vs ${JSON.stringify(instrumentsOf(drift[0]))}` : ''})`,
  );
  const one = classed.findings.filter((f) => (f.instruments || []).length === 1).length;
  const two = classed.findings.filter((f) => (f.instruments || []).length >= 2).length;
  check(
    one + two === classed.findings.length,
    `every finding is classed (${one} single-instrument, ${two} corroborated, ${classed.findings.length} distinct)`,
  );

  /* EVERY MERGED RULE CARRIES ITS OWN FOOTING. A rule born of a classed finding is
   * matched by its `find`, and the rule's `instruments`, `review` and rationale must
   * agree with the class — one instrument means the clause naming that model and the
   * review flag; two means the flag is NOT the single-instrument one and the pass's
   * "ONE instrument repeated" sentence has been corrected. */
  /* EVERY RULE THE MERGE FOLDED CARRIES ITS FOOTING, and only those rules do. A
   * `find` can be WIDENED by the merge to isolate one site (` geous ` for `geous`,
   * MEASURED once on this pass), so a folded rule is matched to its classed finding
   * by containment; and a rule that predates this pass carries no `instruments` and
   * is not re-classed here — its own unit's instrument set and its own stated
   * footing are the record for it (three of them, r11679/r11685/r11687, come from
   * the EARLIER echo check, whose configured set included an instrument this pass
   * excludes). */
  const classedFinds = classed.findings.map((f) => f.find);
  const backingAll = (r) => classed.findings.filter((f) => r.location && (r.location.find === f.find || r.location.find.includes(f.find)));
  const backing = (r) => backingAll(r)[0];
  /* THE MATCH ABOVE IS BY CONTAINMENT, so it is only sound while ONE classed
   * finding can contain a rule's `find`. If a later pass folds in a finding whose
   * own `find` is a substring of another's, `backing` would silently take the
   * earlier one and every footing below would be checked against the wrong
   * instrument set — so the ambiguity is a FAILURE here, not a reading. */
  const ambiguous = classed.findings.filter((f) => classedFinds.filter((g) => g !== f.find && f.find.includes(g)).length);
  check(
    ambiguous.length === 0,
    `no classed finding's find contains another's (${ambiguous.length} do${ambiguous.length ? `, first: ${JSON.stringify(ambiguous[0].find)}` : ''}) — otherwise a rule's footing below could be read against the wrong finding`,
  );
  const foldedRules = rules.filter((r) => Array.isArray(r.instruments) && r.instruments.length);
  const stray = foldedRules.filter((r) => !backing(r));
  check(
    stray.length === 0,
    `every rule carrying instruments has a classed finding behind it (${stray.length} without${stray.length ? `: ${stray[0].id}` : ''})`,
  );
  const multi = foldedRules.filter((r) => backingAll(r).length !== 1);
  check(multi.length === 0, `and exactly ONE classed finding behind each (${multi.length} not${multi.length ? `: ${multi[0].id}` : ''})`);
  /* THE SPLIT IS MEASURED, not asserted in the message: the counts below are what
   * the rules file yields, so the line cannot state a split the rules do not have. */
  const foldedOne = foldedRules.filter((r) => r.instruments.length === 1).length;
  const foldedTwo = foldedRules.length - foldedOne;
  check(
    foldedRules.length === 154,
    `the merge folded 154 rules off this pass (${foldedRules.length} carry instruments) — MEASURED ${foldedOne} one-instrument and ${foldedTwo} two-instrument; the artifact classes ${classed.findings.filter((f) => (f.instruments || []).length === 1).length} of its ${classed.findings.length} findings as one instrument's`,
  );
  const clauseFail = [];
  const flagFail = [];
  for (const r of foldedRules) {
    const f = backing(r);
    const names = f ? f.instruments || [] : [];
    if (!same(r.instruments || [], names)) {
      flagFail.push(`${r.id} carries instruments ${JSON.stringify(r.instruments || [])} against the classed ${JSON.stringify(names)}`);
      continue;
    }
    if (names.length === 1) {
      if (!r.review) flagFail.push(`${r.id} is one instrument's reading and is not flagged for review`);
      if (!/ONE INSTRUMENT'S READING/.test(r.rationale)) clauseFail.push(`${r.id} does not state that it is one instrument's reading`);
      else if (!r.rationale.includes(names[0])) clauseFail.push(`${r.id} does not name ${names[0]} as the one reader`);
    } else if (names.length >= 2) {
      if (r.review) flagFail.push(`${r.id} is corroborated by ${names.join(' and ')} and is flagged for review`);
      if (/ONE instrument repeated/.test(r.rationale)) clauseFail.push(`${r.id} still carries the pass's single-instrument sentence beside a two-instrument claim`);
    }
  }
  check(clauseFail.length === 0, `every merged single-instrument rule states its one instrument in its own rationale (${clauseFail.length} wrong${clauseFail.length ? `: ${clauseFail[0]}` : ''})`);
  check(flagFail.length === 0, `and every one is flagged for review, with the class the artifact measures (${flagFail.length} wrong${flagFail.length ? `: ${flagFail[0]}` : ''})`);

  /* THE PRESERVED REGION, on the REAL document, through the extractor's OWN code.
   * MEASURED at the merge: 68 of the folded rules stand inside it. The policy admits
   * a rule there IFF its type is `transliteration` — the assertion ACCEPTS the served
   * document when it is given the rules' canonical types, and REFUSES it (naming the
   * rules) when it is not. That asymmetry is what proves the exception is the reason
   * they are served, rather than the check having been weakened. */
  const { extract, frontMatterText, checkFrontMatter, loadEdits, sha256, versionOf, hasEdition } = await import('./extract.mjs');
  const { TEXTS } = await import('./shelf.mjs');
  const src = source.join('\n');
  const { meta } = loadEdits(SLUG);
  /* THE EXTRACTOR ITSELF IS THE FIRST GATE: it runs `checkFrontMatter` while it
   * builds the document, so a rule of another type standing in the preserved region
   * fails HERE — and the probe reports that as a FAIL rather than a stack trace. */
  let doc = null;
  try {
    doc = extract(src, { entry: TEXTS.find((t) => t.slug === SLUG), sha256: sha256(src), version: VERSION });
  } catch (e) {
    check(false, `the served document extracts under the front-matter policy (${String(e.message).split('\n')[0].slice(0, 120)})`);
  }
  if (doc) {
    const front = frontMatterText(doc);
    const inFront = rules.filter((r) => r.location && front.includes(r.location.find));
    check(inFront.length > 0, `rules stand inside the preserved front-matter region (${inFront.length})`);
    const notGreek = inFront.filter((r) => r.type !== 'transliteration');
    check(notGreek.length === 0, `and every one of them is a Greek restoration (${notGreek.length} of another type${notGreek.length ? `: ${notGreek[0].id} ${notGreek[0].type}` : ''})`);
    const inFrontUnbacked = inFront.filter((r) => !backing(r));
    check(
      inFrontUnbacked.length === 0,
      `and every rule standing there is one the classed artifact read (${inFront.length} rule(s) there, ${inFrontUnbacked.length} without a classed finding)`,
    );
    const typeMap = new Map((meta.types ? [...meta.types] : []));
    let acceptedWith = null;
    let refusedWithout = null;
    try {
      checkFrontMatter(doc, typeMap);
      acceptedWith = 'accepted';
    } catch (e) {
      acceptedWith = `threw: ${e.message.split('\n')[0]}`;
    }
    try {
      checkFrontMatter(doc);
      refusedWithout = 'accepted';
    } catch (e) {
      refusedWithout = e.message;
    }
    check(acceptedWith === 'accepted', `the extractor's own front-matter assertion accepts the served document GIVEN its rules' types (${String(acceptedWith).slice(0, 80)})`);
    check(
      typeof refusedWithout === 'string' && refusedWithout.includes('preserved by construction'),
      `and REFUSES it — naming the rules — when the types are not passed (${String(refusedWithout).split('\n')[0].slice(0, 90)})`,
    );
    check(
      typeof refusedWithout === 'string' && refusedWithout.startsWith(`library: ${SLUG}: ${inFront.length} correction rule(s)`),
      `the refusal counts exactly the ${inFront.length} rule(s) standing in the region (${String(refusedWithout).split('\n')[0].slice(0, 70)})`,
    );
  }
  /* THE OTHER EDITIONS ARE NOT TOUCHED BY THE POLICY: neither has a rule in its
   * front-matter region, which is why their documents are byte-identical either way
   * (the build's parity gate and the deploy's live check are the record of that). */
  for (const other of TEXTS.filter((t) => t.slug !== SLUG && hasEdition(t.slug))) {
    const oRules = JSON.parse(readFileSync(join(ROOT, 'data/editions', other.slug, 'versions', versionOf(other.slug), 'repairs.json'), 'utf8')).rules;
    const moved = oRules.filter((r) => Array.isArray(r.instruments) && r.instruments.length);
    check(moved.length === 0, `${other.slug}: no rule of another edition was classed by the Greek pass (${moved.length} found)`);
  }
}

console.log(`echo-probe: ${ok} OK, ${fails.length} FAIL`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (fails.length) process.exit(1);
