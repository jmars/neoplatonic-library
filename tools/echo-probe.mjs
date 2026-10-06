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
 *      the transcription.
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
 *      instrument's agreeing draws.
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
const RULES = join(ROOT, 'data/editions', SLUG, 'versions/1.0.0', 'repairs.json');

let ok = 0;
const fails = [];
const check = (cond, msg) => { if (cond) { ok++; } else { fails.push(msg); } };

const source = readFileSync(join(ROOT, 'data/editions', SLUG, 'versions/1.0.0/source.txt'), 'utf8')
  .replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const servedLine = (l) => tidyPunctuation(collapse(source[l - 1]));
const MARKER = /^\s*(?:[*•†‡§¶%]\s*|\d{1,2}\s*[.)]?\s*|[¹²³⁴⁵⁶⁷⁸⁹⁰]+\s*)/;
const stripMarker = (s) => s.replace(MARKER, '').replace(/\s+/g, ' ').trim();
const GREEK = /[\u0370-\u03ff\u1f00-\u1fff]/;
/* The letters as an instrument may render them: case, breathings/accents, and
 * the Latin letter an instrument prints for a Greek one (λυραίoς for λυραιος). */
const HOMOGLYPH = { a: 'α', b: 'β', e: 'ε', h: 'η', i: 'ι', k: 'κ', n: 'ν', o: 'ο', p: 'ρ', t: 'τ', u: 'υ', v: 'ν', w: 'ω', x: 'χ', y: 'υ', z: 'ζ', m: 'μ' };
const fold = (s) => [...s.normalize('NFD').replace(/[\u0300-\u036f\u0345]/g, '').toLowerCase()]
  .map((c) => HOMOGLYPH[c] || c).filter((c) => /[a-z\u0370-\u03ff\u1f00-\u1fff]/.test(c)).join('');

const cache = JSON.parse(readFileSync(CACHE, 'utf8'));
const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
const rules = JSON.parse(readFileSync(RULES, 'utf8')).rules;
const ids = new Set(rules.map((r) => r.id.split(':r')[1]));

/* ---------- 1. the echo table IS the cache's numbers ---------- */
const isVerbatim = (l, t) => stripMarker(collapse(t)) === stripMarker(servedLine(l)) || collapse(t) === collapse(source[l - 1]);
const draws = new Map(); // model -> [{line, text}]
for (const rec of Object.values(cache.leaves)) {
  if (!artifact.models.includes(rec.model)) continue;
  if (!draws.has(rec.model)) draws.set(rec.model, []);
  for (const [line, text] of Object.entries(rec.reading || {})) {
    const l = Number(line);
    if (l >= 1 && l <= source.length) draws.get(rec.model).push({ line: l, text: collapse(text) });
  }
}
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
  { id: '11682', outcome: 'kept', by: null },
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
    check(!r, `r${entry.id} was dropped by the echo check and must not stand in the edition's rules`);
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

console.log(`echo-probe: ${ok} OK, ${fails.length} FAIL`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (fails.length) process.exit(1);
