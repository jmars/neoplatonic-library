#!/usr/bin/env node
/**
 * merge-input.mjs — build the ONE findings file `tools/merge.mjs` folds in, from
 * the several artifacts a re-read leaves behind, and hold each class of finding to
 * the standard its own instrument supports.
 *
 * WHY THIS EXISTS. `merge.mjs` takes one `--from`. A unit that settles a text
 * from more than one instrument — here: a page-image pass that draws each leaf
 * three times and requires two draws to AGREE (tools/greek-runs.mjs), a
 * page-image pass that reads each line once (tools/vision-unsure.mjs), and a pass
 * that reads the same print through other copies (tools/witness-unsure.mjs) —
 * leaves three artifacts, and they cannot simply be concatenated.
 *
 * THE GREEK EXCLUSION. MEASURED on the Theology of Plato's copy: asked about the
 * print's small Greek type, the vision model SUPPLIES a word that fits the
 * sentence instead of reading the letters. Asked eight times about one footnote
 * lemma it answered five different words; the copies' own page images gave the
 * same `τοῖς θεοῖς` for six unrelated lemmas on six different pages. So a
 * single-draw pass's GREEK-carrying finding is not evidence, and only the pass
 * that requires agreeing draws may state Greek. The excluded findings are KEPT in
 * the artifact under `excludedForFabrication` — the drop is auditable, not silent
 * — and their English/Latin readings from the same passes are folded in as usual
 * (the same measurement shows those are read reliably).
 *
 *   node tools/merge-input.mjs <slug> [--inputs greek,unsure-findings,witness-findings]
 *        [--greek-single-draw unsure-findings,witness-findings] [--out FILE]
 *
 * Writes `tools/edits/<slug>.open-questions.json`. Not in the build's module
 * graph: it reads the pipeline's own artifacts.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEXTS } from './shelf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--inputs', '--greek-single-draw', '--out']);
const slug = argv.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
if (!slug || !TEXTS.some((t) => t.slug === slug)) {
  console.error('usage: node tools/merge-input.mjs <slug> [--inputs a,b,c] [--greek-single-draw a,b] [--out FILE]');
  process.exit(2);
}
const inputs = opt('inputs', 'greek,unsure-findings,witness-findings').split(',').map((s) => s.trim()).filter(Boolean);
const single = new Set(opt('greek-single-draw', 'unsure-findings,witness-findings').split(',').map((s) => s.trim()).filter(Boolean));
const outFile = opt('out', join(ROOT, 'tools', 'edits', `${slug}.open-questions.json`));

const GREEK = /[\u0370-\u03ff\u1f00-\u1fff]/;
const load = (name) => {
  const p = join(ROOT, 'tools', 'edits', `${slug}.${name}.json`);
  if (!existsSync(p)) throw new Error(`merge-input: no artifact at ${p}`);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return { name, findings: j.findings || j.proposals || [], open: j.open || [] };
};

const sources = inputs.map(load);
const excluded = [];
const findings = [];
const counts = {};
for (const s of sources) {
  counts[s.name] = s.findings.length;
  for (const f of s.findings) {
    /* A SINGLE-DRAW PASS MAY NOT STATE GREEK: its reading of this print's Greek is
     * a word that fits the sentence. Its English and Latin readings are folded in
     * — the same measurement shows those are read off the page. */
    if (single.has(s.name) && GREEK.test(f.replace || '')) {
      excluded.push({ ...f, from: s.name, why: 'a single draw of the vision model supplies Greek that fits the sentence rather than reading the print\'s letters (MEASURED: five words over eight draws on one lemma; the same "τοῖς θεοῖς" for six unrelated lemmas over the copies\' page images); Greek is held to the two-draw agreement tools/greek-runs.mjs applies' });
      continue;
    }
    findings.push(f);
  }
}
counts.excludedForFabrication = excluded.length;

const out = {
  slug,
  from: inputs,
  tool: 'tools/merge-input.mjs — the unit\'s artifacts folded into one file for tools/merge.mjs',
  why:
    'The Greek-carrying findings of the single-draw passes are excluded from the merge and kept in this ' +
    'artifact: MEASURED, the vision model supplies Greek that fits the sentence instead of reading the ' +
    'print\'s letters, so Greek is held to the agreement the page-image pass requires (tools/greek-runs.mjs).',
  counts,
  findings,
  excludedForFabrication: excluded,
};
writeFileSync(outFile, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${slug}: ${findings.length} finding(s) folded from ${inputs.join(', ')} (${Object.entries(counts).filter(([k]) => k !== 'excludedForFabrication').map(([k, v]) => `${k} ${v}`).join(', ')})`);
console.log(`  ${excluded.length} Greek-carrying single-draw finding(s) excluded, kept in \`excludedForFabrication\``);
console.log(`  wrote ${outFile}`);
