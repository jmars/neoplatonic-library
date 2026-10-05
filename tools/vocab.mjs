#!/usr/bin/env node
/**
 * vocab.mjs — find the words that do not exist.
 *
 * WHY THIS EXISTS. The damage census reads a character set, and a merged rule is
 * only ever as good as the garble someone NOTICED. Neither can see a wrong word
 * that carries no damage character at all — the class the whole-text read keeps
 * finding by eye (`considerexLby` -> `considered by`, `wnnlrf` -> `would`). A
 * DICTIONARY sees them all at once: a token the reading view shows that is not a
 * word, not a proper noun the text uses, and not in the same-translation parallel
 * is a garble candidate, whether or not any character of it looked damaged.
 *
 * WHAT IT IS NOT. A dictionary is not a witness. `o'er`, `consign'd`, `Naiades'`,
 * `Phædrus`, `cunctaque` (the Latin quotation) and `WATKINS` are all real, and
 * several are OOV. So this tool REPORTS candidates with their site; a human (or
 * the scan) decides. It repairs nothing.
 *
 *   node tools/library/vocab.mjs [slug] [--json <out>] [--allow <file>]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyEditsCounted } from './extract.mjs';
import { TEXTS, SHELF, shelfFile } from './shelf.mjs';

const argv = process.argv.slice(2);
const slug = argv.find((a) => TEXTS.some((t) => t.slug === a)) || 'porphyry-on-the-cave-of-the-nymphs-taylor-1917';
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;
const allowFile = argv.includes('--allow') ? argv[argv.indexOf('--allow') + 1] : null;

const ROOT = join(import.meta.dirname, '..', '..');
const CACHE = join(ROOT, 'content', 'library', '.words');
const WORDLIST = join(CACHE, 'words.txt');
const WORDLIST_URL = 'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt';

async function wordlist() {
  if (existsSync(WORDLIST)) return readFileSync(WORDLIST, 'utf8');
  mkdirSync(CACHE, { recursive: true });
  const res = await fetch(WORDLIST_URL);
  if (!res.ok) throw new Error(`vocab: cannot fetch the wordlist (${res.status}); put one at ${WORDLIST}`);
  const text = await res.text();
  writeFileSync(WORDLIST, text);
  return text;
}

// A token is checked by its alphabetic core: possessives, the elisions the 1917
// print uses ('d, 'er, 't), the ligatures, and hyphenation are spelling, not words.
const core = (tok) => tok
  .toLowerCase()
  .replace(/æ/g, 'ae').replace(/œ/g, 'oe')
  .replace(/[’'](s|d|er|t|st|ll|re|ve|m)$/, '')
  .replace(/[’']/g, '');

// The allowlist (if present) names the words that are NOT garbles — the print's
// own foreign/archaic spellings, and the few garbles a per-block rule cannot
// express. Only lines with NO leading whitespace are entries; '#' starts a
// comment. Each entry is put through `core`, so the list and the text are
// compared in the same form.
const allowPath = allowFile && existsSync(allowFile)
  ? allowFile
  : join(ROOT, 'content', 'library', slug, 'vocab-allow.txt');
const allow = existsSync(allowPath)
  ? new Set(readFileSync(allowPath, 'utf8').split('\n')
      .filter((l) => l && !/^\s/.test(l))
      .map((l) => l.replace(/#.*$/, '').trim().split(/\s+/)[0])
      .filter(Boolean)
      .map(core))
  : new Set();

const doc = JSON.parse(readFileSync(join(ROOT, 'dist', 'library', slug, 't'), 'utf8'));
const rules = JSON.parse(readFileSync(join(ROOT, 'tools', 'library', 'edits', `${slug}.json`), 'utf8'))
  .edits.filter((r) => r.action !== 'leave')
  .map((r) => ({ find: r.find, repl: r.replace }));

// The parallel, same translation: a word that appears there cleanly is real.
const wit = join(ROOT, 'content', 'library', slug, 'witnesses.json');
const parWords = new Set();
let parFlat = '';
if (existsSync(wit)) {
  const rec = JSON.parse(readFileSync(wit, 'utf8'));
  for (const w of rec.witnesses || []) {
    const p = join(ROOT, 'content', 'library', slug, 'witnesses', `${w.name}.txt`);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    for (const t of text.toLowerCase().match(/[a-z]{2,}/g) || []) parWords.add(t);
    // the parallel's own words in sequence, whitespace collapsed, for PHRASE checks
    parFlat += ' ' + text.toLowerCase().replace(/[^a-z]+/g, ' ').replace(/\s+/g, ' ');
  }
}

const known = new Set((await wordlist()).split(/\s+/).filter(Boolean));

/* THE GREEK LISTS, when tools/library/greek.mjs has built them. A text whose print
 * carries Greek has two more classes: a GREEK-SCRIPT token the list does not know
 * (a gate), and a LATIN/SYMBOL run that looks like smashed Greek — this volume's
 * scan read its Greek as lookalikes, so `y«g`, `«yoros`, `futj^neu` are Greek the
 * OCR flattened. The second needs the printed PAGE (tools/library/scan.mjs) to
 * settle, so it is REPORTED and routed, never gated. */
const GREEKDIR = join(ROOT, 'content', 'library', '.words');
const greekUnicode = existsSync(join(GREEKDIR, 'greek-unicode.txt'))
  ? new Set(readFileSync(join(GREEKDIR, 'greek-unicode.txt'), 'utf8').split('\n').filter(Boolean))
  : null;
const greekBetacode = existsSync(join(GREEKDIR, 'greek-betacode.txt'))
  ? new Set(readFileSync(join(GREEKDIR, 'greek-betacode.txt'), 'utf8').split('\n').filter(Boolean))
  : null;
// (the allowlist is built below, once `core` exists — it must be normalised the
// same way the text is, or 'nautæ' in the list would not match 'nautae' in the text)

/* ---------- the detection: FOUR classes, not one ---------- */

/* The first version asked one question ("is this token in the dictionary?") and
 * answered it by SKIPPING every capitalised token, to avoid naming proper nouns.
 * MEASURED, that hid two whole classes the whole-text read had found by eye:
 *
 *   Andit   -> "And it"     a capitalised garble (skipped as a name)
 *   BuTThev -> "But they"   a capitalised garble (skipped as a name)
 *   compel ling             a word split across a line end; BOTH halves are
 *                           plausible, so neither token is out of vocabulary
 *
 * The classes are now asked for separately, because they need different evidence:
 *
 *   unknown    a token the dictionary, the parallel and morphology do not know.
 *              A GATE class.
 *   capital    a capitalised token that is unknown AND appears nowhere in the
 *              parallel. Most of these are proper names; some are garbles. It is
 *              REPORTED rather than gated, because a name this edition's notes
 *              introduce is not in the parallel either, and a gate that fires on
 *              names is a gate that gets switched off.
 *   shouting   a token with an INTERIOR capital ("BuTThev", "lHi"). English words
 *              have none, so this is a garble unless the allowlist says otherwise.
 *              A GATE class, and the one that catches capitals without risking
 *              names.
 *   split      two ADJACENT tokens that join into a dictionary word
 *              ("compel"+"ling" -> "compelling"). A GATE class when one half is
 *              not itself a word, REPORTED otherwise ("con"+"cave" is a real split,
 *              but so is "a cave" sometimes).
 */

const isWord = (part) => {
  if (part.length < 2) return true; // single letters are initialisms, not garbles
  if (known.has(part) || parWords.has(part) || allow.has(part)) return true;
  // crude morphology: a known stem with a known affix is a word the list lacks
  for (const suf of ['s', 'es', 'ed', 'd', 'ing', 'ly', 'er', 'est', 'ness', 'ion', 'ions', 'ive', 'ity']) {
    if (part.endsWith(suf) && (known.has(part.slice(0, -suf.length)) || parWords.has(part.slice(0, -suf.length)))) return true;
  }
  return false;
};

const ctxOf = (view, i, len) => view.slice(Math.max(0, i - 45), i + len + 45).replace(/\s+/g, ' ');

/** EVERY CLASS, in ONE view. Exported so the self-test can prove it catches each
 * one on a fixture — an instrument that has never been shown to fire is an
 * instrument nobody should trust. */
export function detectInView(view, section, out) {
  /* GREEK SCRIPT FIRST, and on its own tokenizer: the Latin one below cannot see a
   * Greek word at all. A token in the Greek range that neither list knows is a
   * reading the transcription (or this list) is missing — a gate. */
  for (const m of view.matchAll(/[\u0370-\u03ff\u1f00-\u1fff]+/g)) {
    const raw = m[0];
    if (raw.length < 1) continue;
    const low = raw.toLowerCase();
    if (!greekUnicode || greekUnicode.has(low) || greekBetacode?.has(low)) continue;
    out.greekUnknown.push({ token: raw, context: ctxOf(view, m.index, raw.length), section });
  }

  // the tokens WITH their offsets, so adjacency is computed on the view's own order
  const toks = [...view.matchAll(/[A-Za-zÀ-ÿŒœÆæ’'’\-]+/g)].map((m) => ({ raw: m[0], i: m.index }));

  for (const { raw, i } of toks) {
    const parts = core(raw).split('-').filter(Boolean);
    if (!parts.length) continue;
    const interior = /[a-zà-ÿ][A-Z]/.test(raw) || /[A-Z]{2,}[a-z]/.test(raw);
    const anyUnknown = !parts.every(isWord);
    if (interior && !allow.has(core(raw))) {
      // "BuTThev": English has no interior capitals, so this is not a name
      out.shouting.push({ token: raw, context: ctxOf(view, i, raw.length), section });
      continue; // one class is enough for one token
    }
    if (!anyUnknown) continue;
    const capitalised = /^[A-ZÀ-Þ]/.test(raw) && raw.length > 1;
    if (capitalised) {
      // a capitalised unknown: a garble or a name. The parallel decides which is
      // PLAUSIBLE — a name this edition carries appears there (any case)
      if (!parWords.has(core(raw))) {
        out.capital.push({ token: raw, context: ctxOf(view, i, raw.length), section });
      }
      continue;
    }
    out.unknown.push({ token: raw, context: ctxOf(view, i, raw.length), section });
  }

  /* SMASHED GREEK, ON THE VIEW ITSELF — not on the Latin tokens above, because the
   * garble SPANS the symbol and the Latin tokenizer drops it: `y«g` is `y` + `g`
   * with the `«` between, so no token ever contains the run. The scan read this
   * volume's Greek as LATIN LOOKALIKES and left Greek-adjacent marks in it, so a
   * short, whitespace-delimited run that carries one of those marks and no English
   * reading is a Greek candidate. REPORTED, never gated: settling one needs the
   * printed PAGE (tools/library/scan.mjs reads it) plus a Greek form to check
   * (tools/library/greek.mjs check). */
  for (const m of view.matchAll(/\S+/g)) {
    const raw = m[0];
    if (raw.length > 16) continue;
    if (!/[«»^\\~\/>£*_|#]/.test(raw)) continue;
    const letters = raw.replace(/[^A-Za-zÀ-ÿ]/g, '');
    if (letters.length < 2) continue;                  // pure symbol debris, not a run
    if (/[A-Za-z]/.test(letters) && known.has(letters.toLowerCase())) continue; // an English word with a mark stuck to it
    out.greeklike.push({ token: raw, context: ctxOf(view, m.index, raw.length), section });
  }

  // ADJACENT PAIRS: two tokens that join into a dictionary word, where the gap
  // between them is whitespace alone (a line break is whitespace too)
  for (let k = 0; k + 1 < toks.length; k += 1) {
    const a = toks[k];
    const b2 = toks[k + 1];
    if (view.slice(a.i + a.raw.length, b2.i) !== ' ') continue;
    const ca = core(a.raw);
    const cb = core(b2.raw);
    if (ca.includes('-') || cb.includes('-')) continue;
    const both = (ca + cb);
    if (both.length < 6 || !known.has(both)) continue;
    if (allow.has(ca) || allow.has(cb)) continue;
    /* STRONG means the evidence is unambiguous. Two independent tests, because the
     * wordlist alone is not enough — it is 370k words and carries "de", "ness",
     * "scend" (so its morphology makes "scending" a word), which is how three real
     * splits came out WEAK in the first cut of this.
     *
     *   (a) a half is not a word at all, STRICTLY (the list and the parallel, no
     *       affix morphology): "compel"+"ling" -> "compelling";
     *   (b) the PARALLEL prints the join and NOT the two-word form: "coldness" is
     *       printed and "cold ness" is not, "descending" and not "de scending".
     *       This is the decisive one for splits whose halves are both real words.
     *
     * It is not "the join appears in the parallel anywhere": "averse" and "around"
     * are printed, so "a verse" and "a round" would be flagged — and both are
     * correct English. The join must be printed AND the split not. */
    const strict = (w) => w.length < 2 || known.has(w) || parWords.has(w) || allow.has(w);
    const halfUnknown = !strict(ca) || !strict(cb);
    const asTwo = ` ${ca} ${cb} `;
    const parallelSaysJoin = parFlat.includes(` ${both} `) && !parFlat.includes(asTwo);
    // ONLY the decisive splits are kept. The first cut also reported "weak" ones
    // (both halves are words, the join is printed nowhere) and MEASURED, 44 of 45
    // were correct English — "as well", "a place", "the Lion" — which is noise, not
    // a finding. A split is reported when a half cannot stand alone, or when the
    // parallel prints the join and not the split; otherwise it is not a garble.
    if (!halfUnknown && !parallelSaysJoin) continue;
    out.split.push({
      token: `${a.raw} ${b2.raw}`,
      joins: both,
      context: ctxOf(view, a.i, a.raw.length + 1 + b2.raw.length),
      section,
    });
  }
  return out;
}

// The reading view, block by block, exactly as the reader applies it.
const blocks = (doc.blocks || []).filter((b) => typeof b.x === 'string');
let section = null;
const found = { unknown: [], capital: [], shouting: [], split: [], greekUnknown: [], greeklike: [] };
for (const b of blocks) {
  if (b.t === 'sec' && b.x) section = b.x.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!['p', 'verse', 'notedef'].includes(b.t)) continue;
  detectInView(applyEditsCounted(b.x, rules), section, found);
}

const uniq = (rows) => {
  const m = new Map();
  for (const r of rows) {
    const k = r.token;
    if (!m.has(k)) m.set(k, { ...r, n: 0, sites: [] });
    const e = m.get(k);
    e.n += 1;
    if (e.sites.length < 3) e.sites.push({ section: r.section, context: r.context });
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
};

const unknown = uniq(found.unknown);
const capital = uniq(found.capital);
const shouting = uniq(found.shouting);
const split = uniq(found.split);
const greekUnknown = uniq(found.greekUnknown);
const greeklike = uniq(found.greeklike);

const show = (label, rows, why) => {
  if (!rows.length) return;
  console.log(`\n${label} (${rows.length}) — ${why}`);
  for (const e of rows) {
    console.log(`  ${JSON.stringify(e.token)}${e.joins ? ` -> ${JSON.stringify(e.joins)}` : ''} x${e.n}  [${e.sites[0].section || '?'}]`);
    for (const s of e.sites) console.log(`      ...${s.context}...`);
  }
};

if (!argv.includes('--self-test')) console.log(`vocab ${slug}: the reading view, asked four separate questions`);
show('UNKNOWN', unknown, 'a token the dictionary, the parallel and morphology do not know');
show('SHOUTING', shouting, 'a token with an interior capital — English words have none');
show('SPLIT', split, 'two adjacent tokens joining into a word, where one half cannot stand alone (or the parallel prints the join and not the split)');
show('CAPITALISED', capital, 'unknown and absent from the parallel: mostly names, some garbles (REPORTED, not gated)');
show('GREEK (unknown to the list)', greekUnknown, 'a Greek-script token neither Greek list knows — a reading this text or list is missing');
show('GREEK-LIKE (needs the page)', greeklike, 'a short, non-word, symbol-bearing run: the scan read Greek as lookalikes, and settling one needs the printed page + the Greek list');

/* WHAT THE GATE IS. The classes with unambiguous evidence GATE: an unknown token,
 * an interior capital, and a split with a non-word half. The two REPORTED classes
 * are printed and do not fail — a name a note introduces is legitimate, and a
 * two-word join is a real English phrase as often as it is a split. A gate that
 * fires on names or on "a cave" is a gate that gets switched off, and a switched
 * off gate is worse than none. `--report` prints everything and exits 0. */
// the gate: the classes with unambiguous evidence. `greeklike` is REPORTED and
// routed to the page, never gated — it cannot be settled from the text alone.
const gate = [...unknown, ...shouting, ...split, ...greekUnknown];

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify({ slug, unknown, shouting, split, capital, greekUnknown, greeklike }, null, 2)}\n`);
  console.log(`\n  wrote ${jsonOut}`);
}
/* THE SELF-TEST: does the detector actually fire? Run the classes on a fixture
 * with one of each, and fail loudly if any class misses its own case. An
 * instrument whose failure modes are untested is the thing this project keeps
 * finding in others. */
if (argv.includes('--self-test')) {
  const t = { unknown: [], capital: [], shouting: [], split: [], greekUnknown: [], greeklike: [] };
  detectInView('it was compel ling to say, and BuTThev thought so, and zqxwv and Zqxwv appeared, and y«g «yoros', null, t);
  const checks = [
    ['shouting', 'BuTThev', t.shouting.some((x) => x.token === 'BuTThev'), 'an interior capital is caught'],
    ['split', 'compel ling', t.split.some((x) => x.token === 'compel ling'), 'a split with a non-word half is caught'],
    ['unknown', 'zqxwv', t.unknown.some((x) => x.token === 'zqxwv'), 'an unknown lowercase token is caught'],
    ['capital', 'Zqxwv', t.capital.some((x) => x.token === 'Zqxwv'), 'an unknown capitalised token is REPORTED (not gated)'],
    ['greeklike', 'y«g', t.greeklike.some((x) => x.token === 'y«g'), 'a smashed-Greek run is REPORTED and routed to the page'],
  ];
  let bad = 0;
  for (const [cls, tok, ok, why] of checks) {
    console.log((ok ? '  OK   ' : '  FAIL ') + `${cls}: ${why} (${tok})`);
    if (!ok) bad += 1;
  }
  // and a clean sentence must produce NOTHING: the detector must not fire on prose
  const clean = { unknown: [], capital: [], shouting: [], split: [], greekUnknown: [], greeklike: [] };
  detectInView('the soul descends into generation and is called a cave by the ancients', null, clean);
  const noise = Object.values(clean).reduce((a, v) => a + v.length, 0);
  console.log((noise === 0 ? '  OK   ' : '  FAIL ') + `a clean sentence reports nothing (${noise})`);
  if (noise !== 0) bad += 1;
  process.exit(bad ? 1 : 0);
}

if (!argv.includes('--report') && gate.length > 0) {
  console.error(`\nvocab: ${gate.length} token(s) with unambiguous evidence — unknown, shouting, or a split with a non-word half`);
  process.exit(1);
}
