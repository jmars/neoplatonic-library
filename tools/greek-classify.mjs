#!/usr/bin/env node
/**
 * greek-classify.mjs — say, for every finding of the two-reader GREEK pass, HOW
 * MANY INSTRUMENTS the reading rests on, and write the one findings file
 * `tools/merge.mjs` folds in.
 *
 * WHY THIS EXISTS. The Greek pass (tools/greek-runs.mjs, google/gemini-2.5-flash +
 * anthropic/claude-haiku-4-5, the two readers MEASURED to not echo this
 * transcription) left `tools/edits/<slug>.greek-two-reader.json`: 171 distinct
 * findings, of which the pass's own strict two-model consensus corroborates a few
 * and one instrument alone reads the rest. `merge.mjs` takes ONE `--from`, and a
 * rule must carry its footing — a two-instrument agreement and a single
 * instrument's reading are different claims and may not be merged as the same
 * thing. This tool turns the pass's artifact into that one file, with each finding
 * classed from the pass's OWN DRAW CACHE.
 *
 * THE CLASS IS MEASURED, from `data/editions/<slug>/greek-vision.json` — the same
 * cache tools/echo-probe.mjs holds the pass to — and not read off the artifact's
 * prose:
 *
 *   an instrument READ the line  ⟺  (the pass recorded it in `agreeModels`: at
 *                                    least one of its draws agreed with the
 *                                    reading character for character)
 *                                ∨  (two of that instrument's own non-echo draws
 *                                    carry the reading's LETTERS, accents and
 *                                    spacing folded — its own draws agree)
 *   instruments = the set of such models; ONE of them means the reading rests on
 *   one instrument, TWO or more means it is corroborated.
 *
 * MEASURED on the Theology of Plato's pass: this reproduces the corroborated set
 * the pass published (`greek-corroborated.json`) EXACTLY — 9 findings, 8 of them
 * standing in the front-matter region — and classes the remaining 162
 * single-instrument. It also reproduces, finding for finding, the two-reader
 * agreement r11688's rationale states and echo-probe.mjs §4 re-derives.
 *
 * THE NOTE IS CORRECTED WHERE THE CLASS CONTRADICTS IT, and only there. The pass's
 * note ends every single-instrument finding with "ONE instrument repeated, not
 * two, so this reading rests on that model alone" — TRUE for the single-instrument
 * class, and a LIE on a corroborated finding whose letters both readers gave (the
 * pass's strict character-for-character comparison missed the pair on accents and
 * quote glyphs; r11688 was merged by hand for exactly this). The sentence is
 * REPLACED with the measured agreement, never left standing beside a two-instrument
 * claim.
 *
 * WRITES `tools/edits/<slug>.greek-merge.json`. Not in the build's module graph: it
 * reads the pipeline's own artifacts.
 *
 *   node tools/greek-classify.mjs <slug> [--out FILE]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEXTS } from './shelf.mjs';
import { tidyPunctuation } from './extract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outIx = argv.indexOf('--out');
const slug = argv.find((a, i) => !a.startsWith('--') && (outIx < 0 || i !== outIx + 1));
if (!slug || !TEXTS.some((t) => t.slug === slug)) {
  console.error('usage: node tools/greek-classify.mjs <slug> [--out FILE]');
  process.exit(2);
}
const outFile = outIx >= 0 && argv[outIx + 1] ? argv[outIx + 1] : join(ROOT, 'tools', 'edits', `${slug}.greek-merge.json`);

const editsDir = join(ROOT, 'tools', 'edits');
const passFile = join(editsDir, `${slug}.greek-two-reader.json`);
const corrFile = join(editsDir, `${slug}.greek-corroborated.json`);
const cacheFile = join(ROOT, 'data', 'editions', slug, 'greek-vision.json');
for (const p of [passFile, corrFile, cacheFile]) {
  if (!existsSync(p)) throw new Error(`greek-classify: no artifact at ${p}`);
}
const pass = JSON.parse(readFileSync(passFile, 'utf8'));
const corroborated = JSON.parse(readFileSync(corrFile, 'utf8'));
const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
const source = readFileSync(join(ROOT, 'data', 'editions', slug, 'versions', '1.0.0', 'source.txt'), 'utf8')
  .replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');

/* THE SAME READER-INDEPENDENT NOTIONS echo-probe.mjs uses, so the class and the
 * probe's own re-derivation cannot drift: the served line as the reader sees it, a
 * draw that returns the transcription's own line verbatim (an ECHO, not a reading),
 * and the letters with case, breathings/accents, the Greek spacing marks and the
 * Latin homoglyphs an instrument prints for a Greek letter folded away. */
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const MARKER = /^\s*(?:[*•†‡§¶%]\s*|\d{1,2}\s*[.)]?\s*|[¹²³⁴⁵⁶⁷⁸⁹⁰]+\s*)/;
const stripMarker = (s) => s.replace(MARKER, '').replace(/\s+/g, ' ').trim();
const servedLine = (l) => tidyPunctuation(collapse(source[l - 1]));
const isVerbatim = (l, t) => stripMarker(collapse(t)) === stripMarker(servedLine(l)) || collapse(t) === collapse(source[l - 1]);
const HOMOGLYPH = { a: 'α', b: 'β', e: 'ε', h: 'η', i: 'ι', k: 'κ', n: 'ν', o: 'ο', p: 'ρ', t: 'τ', u: 'υ', v: 'ν', w: 'ω', x: 'χ', y: 'υ', z: 'ζ', m: 'μ' };
const fold = (s) => [...s.normalize('NFD').replace(/[\u0300-\u036f\u0345\u1fbd-\u1fbf\u1fef\u1ffd]/g, '').toLowerCase()]
  .map((c) => HOMOGLYPH[c] || c).filter((c) => /[a-z\u0370-\u03ff\u1f00-\u1fff]/.test(c)).join('');

/* EVERY DRAW OF THE PASS, by model and line, up to the cache state the pass's own
 * artifact was computed over (`draws_through`): a draw a LATER pass appended is not
 * evidence about this pass. */
const draws = new Map(); // model -> line -> [text]
for (const rec of Object.values(cache.leaves)) {
  if (!pass.models.includes(rec.model)) continue;
  if (pass.draws_through && rec.at && rec.at > pass.draws_through) continue;
  if (!draws.has(rec.model)) draws.set(rec.model, new Map());
  for (const [line, text] of Object.entries(rec.reading || {})) {
    const l = Number(line);
    if (l < 1 || l > source.length) continue;
    const at = draws.get(rec.model);
    at.set(l, [...(at.get(l) || []), collapse(text)]);
  }
}
const nonEcho = (model, line) => (draws.get(model)?.get(line) || []).filter((t) => t && t !== '?' && !isVerbatim(line, t));

/* THE CLASS. `agreeModels` is the pass's own record of which instruments returned
 * the reading character for character; the folded-letters test adds the pair whose
 * draws carry the same LETTERS and differ only in accents and quote glyphs, which
 * the strict comparison cannot see. */
const instrumentsOf = (f) => {
  const want = fold(f.replace);
  const out = new Set(Array.isArray(f.agreeModels) ? f.agreeModels : []);
  for (const model of pass.models) {
    if (out.has(model)) continue;
    if (nonEcho(model, f.line).filter((t) => fold(t).includes(want)).length >= 2) out.add(model);
  }
  return [...out];
};

/* THE ONE SENTENCE THE CLASS CAN CONTRADICT. MEASURED on this pass: it stands on 3
 * of the 9 corroborated findings (lines 3992, 4001, 4023 — the two readers' draws
 * carry the same letters and differ only in accents), and r11688's rationale was
 * the same correction made by hand before this tool existed. */
const ONE_CLAUSE = /; the \d+ draw\(s\) that read these characters were [^—;]*— ONE instrument repeated, not two, so this reading rests on that model alone\.?/;
const correctNote = (note, instruments) => {
  if (instruments.length < 2 || !ONE_CLAUSE.test(note)) return { note, corrected: false };
  return {
    note: note.replace(
      ONE_CLAUSE,
      `; the letters are TWO instruments': ${instruments.join(' and ')} each carries them in its own draws, ` +
        `with accents, breathing and spacing aside.`,
    ),
    corrected: true,
  };
};

const seen = new Set();
const corrKeys = new Set(corroborated.findings.map((f) => `${f.find}\u0000${f.replace}`));
const findings = [];
const counts = { corroborated: 0, singleInstrument: 0, inTheCorroboratedSet: 0, notesCorrected: 0, corroboratedNotInTheSet: 0, inTheSetNotCorroborated: 0 };
const instrumentTally = {};
for (const f of pass.findings) {
  const key = `${f.find}\u0000${f.replace}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const instruments = instrumentsOf(f);
  const inSet = corrKeys.has(key);
  if (instruments.length >= 2) counts.corroborated += 1;
  else counts.singleInstrument += 1;
  if (inSet) counts.inTheCorroboratedSet += 1;
  if (instruments.length >= 2 && !inSet) counts.corroboratedNotInTheSet += 1;
  if (inSet && instruments.length < 2) counts.inTheSetNotCorroborated += 1;
  const who = instruments.join('+') || 'none';
  instrumentTally[who] = (instrumentTally[who] || 0) + 1;
  const { note, corrected } = correctNote(f.note || '', instruments);
  if (corrected) counts.notesCorrected += 1;
  findings.push({ ...f, note, instruments });
}

const out = {
  slug,
  from: [`${slug}.greek-two-reader.json`, `${slug}.greek-corroborated.json`, 'data/editions/<slug>/greek-vision.json'],
  tool: 'tools/greek-classify.mjs — the two-reader Greek pass classed by the instruments that read each line',
  models: pass.models,
  draws_through: pass.draws_through || null,
  method:
    'A finding\'s `instruments` are the readers whose OWN draws carry its letters: a model the pass recorded in ' +
    '`agreeModels` (a draw agreeing character for character), or a model with two of its own non-echo draws ' +
    'agreeing with the letters folded (accents, breathings and spacing aside). ONE instrument means the reading ' +
    'rests on that model alone — merge.mjs states it in the rule and sets `review: true` — and TWO or more means ' +
    'the letters are two instruments\'. The pass\'s own "ONE instrument repeated" sentence is REPLACED on a ' +
    'corroborated finding whose strict comparison merely missed the pair.',
  counts,
  instruments: instrumentTally,
  findings,
};
writeFileSync(outFile, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${slug}: ${findings.length} distinct finding(s) classed`);
console.log(`  corroborated (two instruments): ${counts.corroborated}, of which ${counts.corroboratedNotInTheSet} the pass\'s own corroborated set did not carry`);
console.log(`  single-instrument: ${counts.singleInstrument}`);
console.log(`  the pass\'s published corroborated set: ${counts.inTheCorroboratedSet} member(s), ${counts.inTheSetNotCorroborated} of them NOT two-instrument here`);
console.log(`  the "ONE instrument repeated" sentence replaced: ${counts.notesCorrected}`);
console.log(`  instruments: ${Object.entries(instrumentTally).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  wrote ${outFile}`);
