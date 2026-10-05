#!/usr/bin/env node
/**
 * greek.mjs — A GREEK WORD LIST, for repairing OCR'd Greek.
 *
 * WHY. The 1816 Proclus prints Greek inside Taylor's brackets (the etyma, the
 * lemmas), and the scan read it as LATIN LOOKALIKES — so the transcription carries
 * runs like `y«g`, `K»g`, `futj^neu` where the print has Greek. Deciding what those
 * say needs (a) the printed page (tools/library/scan.mjs reads it) and (b) a way to
 * ask whether a candidate is a real Greek word. This is (b).
 *
 * TWO LISTS, because two scripts are in play:
 *   - BETACODE headwords from the Perseus LSJ (the standard Greek-English lexicon).
 *     LSJ's own text is Betacode — Latin letters with accents (`cai/nw` = χαίνω) —
 *     which is also what a Latin-lookalike garble is closest to.
 *   - UNICODE tokens from the Greek texts ON THIS SHELF (Dodds' Elements carries the
 *     Greek of the very work being repaired, 6,722 distinct forms).
 *
 * A GATE LIST IS NOT A DICTIONARY OF MEANINGS: it answers "does this form occur",
 * which is what a repair needs. Nor is it evidence about THIS print — Dodds is a
 * different edition; see the witness rules in the library's own policy.
 *
 *   node tools/library/greek.mjs fetch                 # build/refresh the lists
 *   node tools/library/greek.mjs check <word> [...]    # is this a Greek form?
 *   node tools/library/greek.mjs list                  # sizes and paths
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = join(ROOT, 'content', 'library', '.words');
const BETACODE = join(CACHE, 'greek-betacode.txt');
const UNICODE = join(CACHE, 'greek-unicode.txt');
const SHELF = process.env.LIBRARY_SHELF || join(process.env.HOME || '', 'thework', 'work-text');

// The Perseus LSJ, split into parts. Fetched once and reduced to its headwords: the
// DEFINITIONS are not needed to answer "is this a form", and the parts are ~300 MB.
const LSJ_DIR = 'https://raw.githubusercontent.com/PerseusDL/lexica/master/CTS_XML_TEI/perseus/pdllex/grc/lsj';
const LSJ_PARTS = 27;

const GREEK = /[\u0370-\u03ff\u1f00-\u1fff]/;

async function fetchLsJ() {
  const heads = new Set();
  for (let i = 1; i <= LSJ_PARTS; i++) {
    const url = `${LSJ_DIR}/grc.lsj.perseus-eng${i}.xml`;
    const res = await fetch(url);
    if (!res.ok) { console.log(`  eng${i}: HTTP ${res.status} — skipped`); continue; }
    const xml = await res.text();
    const n = heads.size;
    // `<orth ...>form</orth>` — the headword(s) of an entry. Betacode.
    for (const m of xml.matchAll(/<orth[^>]*>([^<]+)<\/orth>/g)) {
      const w = m[1].trim();
      if (w && !GREEK.test(w) && /[a-z]/i.test(w)) heads.add(w.toLowerCase());
    }
    console.log(`  eng${i}: +${heads.size - n} headwords (${heads.size})`);
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(BETACODE, [...heads].sort().join('\n') + '\n');
  return heads.size;
}

function shelfGreek() {
  if (!existsSync(SHELF)) return { forms: [], files: 0 };
  const words = new Set();
  let files = 0;
  for (const f of readdirSync(SHELF)) {
    if (!f.endsWith('.txt')) continue;
    const text = readFileSync(join(SHELF, f), 'utf8');
    if (!GREEK.test(text)) continue;
    files++;
    for (const m of text.matchAll(/[\u0370-\u03ff\u1f00-\u1fff]+/g)) {
      // GREEK HAS ONE-LETTER WORDS (ο, η, the article; εν, εις prepositions),
      // so unlike the English list there is no length floor here.
      const w = m[0].toLowerCase();
      if (w.length >= 1) words.add(w);
    }
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(UNICODE, [...words].sort().join('\n') + '\n');
  return { forms: [...words], files };
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === 'fetch') {
  /* ONE FETCH, then reuse. The LSJ is ~300 MB across 27 parts; fetching it on every
   * run would be absurd, so an existing list is kept unless --force. (The shelf's
   * own Greek is re-read each time: it is local, and a new Greek text on the shelf
   * should join the list.) */
  const force = argv.includes('--force');
  if (existsSync(BETACODE) && !force) {
    console.log(`Perseus LSJ headwords: already built (${readFileSync(BETACODE, 'utf8').split('\n').filter(Boolean).length} form(s)) — --force to refresh`);
  } else {
    console.log('Perseus LSJ headwords (Betacode):');
    const bh = await fetchLsJ();
    console.log(`  ${bh} headword(s) -> ${BETACODE.slice(ROOT.length + 1)}`);
  }
  const s = shelfGreek();
  console.log(`the shelf's own Greek (Unicode), from ${s.files} text(s): ${s.forms.length} form(s) -> ${UNICODE.slice(ROOT.length + 1)}`);
} else if (cmd === 'check') {
  const want = argv.slice(1);
  const bh = existsSync(BETACODE) ? new Set(readFileSync(BETACODE, 'utf8').split('\n')) : new Set();
  const un = existsSync(UNICODE) ? new Set(readFileSync(UNICODE, 'utf8').split('\n')) : new Set();
  for (const w of want) {
    const low = w.toLowerCase();
    const inB = bh.has(low);
    const inU = un.has(low);
    console.log(`  ${w.padEnd(20)} betacode:${inB ? 'yes' : 'no '}  unicode:${inU ? 'yes' : 'no '}  ${inB || inU ? 'A GREEK FORM' : 'not found'}`);
  }
} else {
  const sizes = (p) => (existsSync(p) ? `${readFileSync(p, 'utf8').split('\n').filter(Boolean).length} form(s)` : 'not built');
  console.log(`greek word lists (${CACHE.slice(ROOT.length + 1)}):`);
  console.log(`  betacode (Perseus LSJ headwords): ${sizes(BETACODE)}`);
  console.log(`  unicode  (this shelf's Greek):    ${sizes(UNICODE)}`);
  console.log('  fetch to build, check <word> to ask.');
}
