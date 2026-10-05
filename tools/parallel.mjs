#!/usr/bin/env node
/**
 * tools/library/parallel.mjs — derive a damaged word's reading from a PARALLEL
 * EDITION of the same translation (plan §7, the policy's other witness).
 *
 * WHY THIS EXISTS. The base policy says the reading view shows the print's word
 * where one is recorded and the transcription's damage where it is not. That
 * makes "is the reading determinable?" the deciding question, and for this text
 * the answer is often yes — because the shelf holds Taylor's *Select Works of
 * Porphyry* (1823), which carries the SAME translation of the SAME treatise. A
 * word the 1917 transcription mangled is usually intact in the 1823 print, so the
 * reading is recoverable by looking at the parallel rather than by guessing. The
 * review demonstrated this by hand for ~84 of the 87 defective words; this tool
 * does it mechanically.
 *
 * WHAT IT IS NOT. Like review.mjs, it PROPOSES: it writes a separate
 * `*.parallel.json`, never the rules file, and merges nothing. A human reads the
 * evidence and merges. And it can say NOT FOUND: where the parallel does not
 * locate the passage, the entry is a `notFound`, not a guess. A guess would be
 * the one thing the policy forbids.
 *
 * HOW THE READING IS FOUND, and why this is not a heuristic on the reading:
 *   1. the served text's READING VIEW is tokenised, and every distinct word that
 *      still carries a damage character is a slot to resolve;
 *   2. the parallel is tokenised the same way (letters only, lower-cased), so its
 *      own OCR damage ("the>" for "the") normalises away;
 *   3. the slot's context — up to `WINDOW` clean tokens either side — is slid
 *      over the parallel, scoring exact normalised matches, with the damaged
 *      tokens wildcarded;
 *   4. the best offset is refined by a local alignment (Needleman-Wunsch over the
 *      window), which maps the slot to the parallel's own token(s) even where the
 *      two scans split or merged a token;
 *   5. the parallel's words there are the READING, and they are emitted with the
 *      parallel's line number as their `where`. A single token is emitted only if
 *      the alignment is confident (a minimum score and a minimum share of the
 *      window matched); otherwise the entry is a `notFound` that says why.
 *
 * WHERE THE PARALLEL IS READ FROM. From the SHELF (`LIBRARY_SHELF`), the same
 * directory the shelf's own scans are read from,
 * resolved through `shelfFile` so the name is never guessed. The parallel is NOT
 * copied into the repo: it is a 600 KB scan of another book, and the repo's
 * business is the derivation, not a second copy of a primary source.
 *
 *   node tools/library/parallel.mjs [slug]
 *
 * Environment: LIBRARY_PARALLEL (a shelf filename to use instead of the map
 * below), LIBRARY_SHELF (where the shelf is), LIBRARY_PARALLEL_WINDOW (context),
 * LIBRARY_PARALLEL_MIN (the minimum matched share, 0..1).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { SHELF, TEXTS, shelfFiles, shelfFile } from './shelf.mjs';
import {
  extract,
  loadBasePolicy,
  loadEdits,
  editsPath,
  readEdition,
  editionPath,
  hasEdition,
  witnessPath,
  sha256,
  wordDamaged,
} from './extract.mjs';

/** The parallel edition known for each text: the same translation in another
 * volume. A text with no entry has no parallel, which is a NOT FOUND rather than
 * a reason to look at something else. */
const PARALLELS = {
  'porphyry-on-the-cave-of-the-nymphs-taylor-1917': {
    file: 'Porphyry-Taylor-Select-Works-1823.txt',
    why: "Taylor's Select Works of Porphyry (1823) carries the same translation of the same treatise",
  },
};

const WINDOW = Number(process.env.LIBRARY_PARALLEL_WINDOW || 7);
const MIN_SHARE = Number(process.env.LIBRARY_PARALLEL_MIN || 0.45);
const MIN_SCORE = Number(process.env.LIBRARY_PARALLEL_MINSCORE || 4);

/** Letters only, lower-cased: the form a token is compared in, so the parallel's
 * own OCR debris ("the>", "powers,", "Naiades") matches the same word. */
const norm = (t) => t.toLowerCase().replace(/[^a-z]/g, '');

/** Tokenise a text, keeping each token's line number. */
function tokenise(text) {
  const toks = [];
  const lines = text.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    for (const raw of lines[ln].split(/\s+/)) {
      if (raw === '') continue;
      toks.push({ raw, line: ln + 1, n: norm(raw) });
    }
  }
  return toks;
}

/** The slot's context: `WINDOW` tokens either side, each marked whether it is a
 * clean anchor (comparable) or a damaged/wildcard position. */
function windowAt(tokens, i, w) {
  const out = [];
  for (let k = i - w; k <= i + w; k++) {
    if (k < 0 || k >= tokens.length) {
      out.push(null);
      continue;
    }
    const t = tokens[k];
    const damaged = wordDamaged(t.raw) || t.n === '';
    out.push({ i: k, n: t.n, damaged });
  }
  return out;
}

/** The best offset in `para` for a served window, and the share of anchor tokens
 * that matched there. */
function bestOffset(win, para) {
  const anchors = win.filter((x) => x && !x.damaged && x.n.length >= 4);
  if (anchors.length === 0) return { at: -1, score: 0, share: 0 };
  let best = { at: -1, score: 0, share: 0 };
  const n = win.length;
  const w = (n - 1) / 2;
  for (let at = 0; at < para.length; at++) {
    let hit = 0;
    let seen = 0;
    for (let k = 0; k < n; k++) {
      const a = win[k];
      if (!a || a.damaged || a.n.length < 4) continue;
      const p = at + (k - w);
      if (p < 0 || p >= para.length) continue;
      seen++;
      if (para[p].n === a.n) hit++;
    }
    if (seen === 0) continue;
    const share = hit / seen;
    if (hit > best.score || (hit === best.score && share > best.share)) {
      best = { at: at - w, score: hit, share };
    }
  }
  return best;
}

/** Needleman-Wunsch over the window: align the served tokens to the parallel's,
 * so the slot maps to the parallel token(s) even where a scan split or merged
 * one. Returns, for each served window index, the parallel index it aligned to
 * (or null). */
function align(win, para, at) {
  const S = win.map((x) => (x ? (x.damaged || x.n === '' ? '?' : x.n) : null));
  const P = [];
  for (let k = 0; k < win.length; k++) {
    const p = at + k;
    P.push(p >= 0 && p < para.length ? para[p].n : null);
  }
  const m = S.length;
  const n = P.length;
  const GAP = -1;
  const dp = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  for (let i = 1; i <= m; i++) dp[i][0] = i * GAP;
  for (let j = 1; j <= n; j++) dp[0][j] = j * GAP;
  const sc = (a, b) => {
    if (a == null || b == null || a === '' || b === '') return GAP;
    if (a === '?') return 0.5; // a wildcard: neither match nor mismatch
    return a === b ? 2 : -1;
  };
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.max(
        dp[i - 1][j - 1] + sc(S[i - 1], P[j - 1]),
        dp[i - 1][j] + GAP,
        dp[i][j - 1] + GAP,
      );
    }
  }
  const map = new Array(m).fill(null);
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + sc(S[i - 1], P[j - 1])) {
      map[i - 1] = at + (j - 1);
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + GAP) {
      i--;
    } else {
      j--;
    }
  }
  return map;
}

/** One damaged word: try every site the reading view has for it, and keep the
 * best-supported reading. */
function derive(tokens, para, word) {
  const sites = [];
  for (let i = 0; i < tokens.length; i++) if (tokens[i].raw === word) sites.push(i);
  if (sites.length === 0) return { word, notFound: 'the reading view has no such token' };
  let best = null;
  for (const i of sites) {
    const win = windowAt(tokens, i, WINDOW);
    const b = bestOffset(win, para);
    if (b.at < 0 || b.score < MIN_SCORE || b.share < MIN_SHARE) continue;
    const map = align(win, para, b.at);
    const pi = map[WINDOW];
    if (pi == null || pi < 0 || pi >= para.length) continue;
    const hit = { word, at: i, line: para[pi].line, reading: para[pi].raw, score: b.score, share: b.share, pi };
    if (!best || hit.score > best.score || (hit.score === best.score && hit.share > best.share)) best = hit;
  }
  if (!best) {
    return {
      word,
      notFound: 'no passage of the parallel matched this word\u2019s context above the threshold',
      sites: sites.length,
    };
  }
  // the evidence is the parallel's own line, so a human can read the reading in
  // its sentence rather than taking the token on trust
  const lo = Math.max(0, best.pi - 8);
  const hi = Math.min(para.length, best.pi + 9);
  const around = para.slice(lo, hi).map((t) => t.raw).join(' ');
  return {
    find: word,
    replace: best.reading,
    class: 'reading',
    note: `the parallel edition reads "${best.reading}" here`,
    evidence: around,
    where: { file: PARALLEL_FILE, line: best.line, matched: `${best.score}/${best.score + 0}` },
    _score: best.score,
    _share: Number(best.share.toFixed(2)),
  };
}

/** Read the parallel once, from the shelf. */
let PARALLEL_FILE = null;
function readParallel(slug) {
  const spec = PARALLELS[slug];
  const name = process.env.LIBRARY_PARALLEL || (spec && spec.file);
  if (!name) return null;
  // Prefer the LIBRARY's imported copy (the witness beside the rule); fall back
  // to the shelf, which may be absent once the edition is in the repo.
  const imported = witnessPath(slug, name);
  if (imported) {
    const text = readFileSync(imported, 'utf8');
    PARALLEL_FILE = imported;
    return { name: basename(imported), path: imported, text, sha256: sha256(text), why: spec ? spec.why : 'named by LIBRARY_PARALLEL', from: 'library' };
  }
  const files = shelfFiles();
  const resolved = shelfFile(name, files);
  PARALLEL_FILE = resolved;
  const path = join(SHELF, resolved);
  if (!existsSync(path)) {
    throw new Error(`library: the parallel "${resolved}" is not on the shelf (${SHELF}) and not imported into the library`);
  }
  const text = readFileSync(path, 'utf8');
  return { name: resolved, path, text, sha256: sha256(text), why: spec ? spec.why : 'named by LIBRARY_PARALLEL', from: 'shelf' };
}

/** The served text's reading view, and its damaged words. */
function served(slug) {
  const entry = TEXTS.find((t) => t.slug === slug);
  if (!entry) throw new Error(`library: no such text on the shelf: ${slug}`);
  if (!hasEdition(slug)) throw new Error(`library: no stored edition for ${slug}`);
  const src = readEdition(slug) || readFileSync(editionPath(slug), 'utf8');
  const doc = extract(src, { entry, sha256: sha256(src) });
  const raw = doc.blocks
    .filter((b) => (b.t === 'p' || b.t === 'verse') && b.at && /^s\d/.test(b.at))
    .map((b) => b.x.replace(/\n/g, ' '))
    .join(' ');
  // the READING VIEW: the recorded readings applied, so the context the tool
  // anchors on is the text a reader actually meets
  const rules = doc.corrections.map((c) => ({ find: c.find, repl: c.repl, action: c.action }));
  let view = raw;
  for (const r of rules) {
    if (r.action === 'leave') continue;
    view = view.split(r.find).join(r.repl);
  }
  return { entry, doc, raw, view };
}

/** Write the proposals — never the rules. The guard is explicit, as in
 * review.mjs: the two paths must differ. */
export function parallelPath(slug) {
  return join(editsPath(slug).replace(/[^/]+$/, ''), `${slug}.parallel.json`);
}

function write(slug, payload) {
  const out = parallelPath(slug);
  if (out === editsPath(slug)) {
    throw new Error('library: the parallel proposals path and the rules path are the same — refusing to write');
  }
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  return out;
}

async function main() {
  const slug = process.argv[2] || 'porphyry-on-the-cave-of-the-nymphs-taylor-1917';
  const policy = loadBasePolicy();
  const { edits } = loadEdits(slug);
  const { doc, view, raw } = served(slug);
  const par = readParallel(slug);
  if (!par) throw new Error(`library: no parallel edition known for ${slug} (set LIBRARY_PARALLEL to a shelf file)`);
  const para = tokenise(par.text);
  // `--check`: derive for EVERY damaged word the transcription carries, not only
  // the ones left visible, and reconcile each against the reading this text has
  // already recorded — that is how "the parallel decides ~N of the damaged words"
  // is TESTED rather than asserted.
  const checking = process.argv.includes('--check') || process.argv.includes('--all');
  const source = checking ? raw : view;
  const tokens = tokenise(source);

  // the slots: distinct words the reading view still shows carrying damage —
  // exactly the words the policy leaves visible (or, in --check, every damaged
  // word the transcription carries)
  const seen = new Set();
  const slots = [];
  for (const t of tokens) {
    if (seen.has(t.raw)) continue;
    if (!wordDamaged(t.raw)) continue;
    seen.add(t.raw);
    slots.push(t.raw);
  }

  const derived = [];
  const notFound = [];
  for (const w of slots) {
    const r = derive(tokens, para, w);
    if (r.notFound) notFound.push({ find: w, why: r.notFound, sites: r.sites || 0 });
    else derived.push(r);
  }
  // a reading that is the same text as the find proposes nothing: the scan used
  // the same characters, so there is nothing to merge
  const clean = derived.filter((d) => d.replace !== d.find);
  const same = derived.filter((d) => d.replace === d.find);

  // In --check, reconcile the derived reading against the RECORDED one, at the
  // WORD the transcription damaged. A rule whose find is that whole token records
  // the reading directly; a rule with a longer find (the review's §10.2 fix for a
  // find that fired at more than one site) contains it, and its replace is then
  // read for the derived word. `new` means no rule names the word at all, which
  // is the coverage gap the tool exists to close.
  let reconcile = null;
  if (checking) {
    const exact = new Map();
    const containing = [];
    for (const e of edits) {
      if (e.action === 'leave') continue;
      if (e.find.split(/\s+/).length === 1) exact.set(e.find, e.repl);
      else containing.push(e);
    }
    const rows = slots.map((w) => {
      const d = derived.find((x) => x.find === w) || null;
      const rec = exact.has(w) ? exact.get(w) : undefined;
      const host = rec === undefined ? containing.filter((e) => e.find.includes(w)).sort((a, b) => a.find.length - b.find.length)[0] : null;
      const recordedText = rec !== undefined ? rec : host ? host.repl : null;
      let verdict;
      if (!d) verdict = 'not-found';
      else if (recordedText == null) verdict = 'new';
      else if (recordedText === d.replace) verdict = 'agree';
      else if (new RegExp(`(^|\\W)${d.replace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(recordedText)) verdict = 'agree';
      else verdict = 'DISAGREE';
      return {
        find: w,
        recorded: recordedText == null ? '(no rule names this word)' : recordedText,
        via: host ? `inside the rule ${JSON.stringify(host.find)}` : 'the rule for the whole token',
        derived: d ? d.replace : null,
        where: d ? `${d.where.file}:${d.where.line}` : null,
        verdict,
      };
    });
    const tally = (v) => rows.filter((r) => r.verdict === v).length;
    reconcile = {
      rows,
      agree: tally('agree'),
      disagree: rows.filter((r) => r.verdict === 'DISAGREE'),
      proposedNew: tally('new'),
      notFound: tally('not-found'),
    };
  }

  const payload = {
    slug,
    tool: 'a parallel-edition derivation: it reads the same translation in another volume and proposes the reading it finds',
    parallel: { file: par.name, sha256: par.sha256, why: par.why, shelf: basename(SHELF) },
    generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    mergesNothing:
      'Nothing here has been merged. To accept a reading, give the damaged word a `reading` rule with this ' +
      'replace in the text\u2019s own rules file and build: every rule must fire at least once or the build ' +
      'fails. A `notFound` is not a reading: the word stays visible under the base policy.',
    policy: { rule: policy.rule, damage: policy.damage },
    stats: {
      damagedLeftVisible: slots.length,
      derived: clean.length,
      sameAsFind: same.length,
      notFound: notFound.length,
      parallelTokens: para.length,
      window: WINDOW,
      minShare: MIN_SHARE,
      minScore: MIN_SCORE,
      checkedAgainstRecorded: checking,
    },
    ...(reconcile
      ? {
          reconcile: {
            agree: reconcile.agree,
            proposedNew: reconcile.proposedNew,
            notFound: reconcile.notFound,
            disagree: reconcile.disagree,
            rows: reconcile.rows,
          },
        }
      : {}),
    proposals: clean.map((d) => ({
      class: d.class,
      find: d.find,
      replace: d.replace,
      note: d.note,
      evidence: d.evidence,
      where: d.where,
      confidence: { matched: d._score, share: d._share },
    })),
    notFound,
  };
  const out = write(slug, payload);
  console.log(`[parallel] ${par.name} (${para.length} tokens), shelf ${SHELF}`);
  console.log(
    `[parallel] ${slots.length} damaged word(s) ${checking ? 'in the transcription' : 'left visible'}: ` +
      `${clean.length} reading(s) derived, ${same.length} read as themselves, ${notFound.length} not found`,
  );
  if (reconcile) {
    console.log(
      `[parallel] against the recorded readings: ${reconcile.agree} agree, ${reconcile.disagree.length} disagree, ` +
        `${reconcile.proposedNew} not recorded but derived, ${reconcile.notFound} not found`,
    );
  }
  console.log(`[parallel] wrote ${out} (proposals only — nothing merged)`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
