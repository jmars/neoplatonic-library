#!/usr/bin/env node
/**
 * tools/library/repair.mjs — the LLM repair pass, WITH CONTEXT, for what the
 * single-word rules cannot reach.
 *
 * WHY THIS EXISTS, and why it is not review.mjs. The recorded rules are read one
 * word at a time, and a word at a time is all a census can see: a character the
 * transcription uses where a letter was lost. Two residues survive that
 * machinery, and MEASURED on this edition both are visible in the build's own
 * `correctionsMeta`:
 *
 *   `leftVisible`     7 distinct damaged words the READING VIEW still shows, and
 *   `unrepairedWords` 10 damaged words of the transcription no rule names —
 *                     overlapping, and a LOST RUN is why: `ajid_ajifonls_aj*^^`
 *                     and `-1i"^lHi.n*-iL` lost WORDS, not a character, so there
 *                     is no one word to record a reading for.
 *
 * A damaged token in isolation is unrepairable. The same token inside its
 * sentence, with the parallel edition's own passage beside it, usually is not.
 * This tool therefore builds the model's input from THREE things and sends them
 * TOGETHER:
 *
 *   1. THE TRANSCRIPTION'S OWN CONTEXT — the run's paragraph in full, with the
 *      damaged run marked in place, plus the paragraph before and the paragraph
 *      after, so the argument the run stands in is visible;
 *   2. THE PARALLEL PASSAGE, when it can be located — the 1823 Taylor *Select
 *      Works* carries the same translation, and `parallel.mjs` already knows how
 *      to find it. The SAME machinery is used here (the WINDOW setting, the
 *      same window-anchored scan, the same Needleman-Wunsch alignment; the
 *      helpers are copied from `parallel.mjs` because that module exports only
 *      its writer), and the same shelf volume is used, named by the parallel
 *      pass's own record so the two tools cannot disagree about which book it is.
 *      Where the alignment maps the damaged run, the parallel's OWN WORDS for it
 *      are sent;
 *   3. THE POLICY AND WHAT IS ALREADY KNOWN — the base policy's rule, its damage
 *      set, and the recorded rules that already touch this token, so the model
 *      neither re-proposes what exists nor contradicts a recorded reading.
 *
 * WHAT IT RETURNS. Proposals with EVIDENCE, or an honest `unsure`. A proposal is
 * REJECTED unless its evidence quotes the transcription's own characters (the
 * find) AND the parallel's own words (when a parallel was supplied) — `vetRepair`
 * below is the mechanical test, and `--self-test` proves it can fail. An `unsure`
 * entry carries the question and no guess; the policy is
 * substitute-if-known-else-leave, so an honest "not determinable" is an outcome,
 * not a failure.
 *
 * WHAT IT DOES NOT DO. It never writes the rule list — the output is a separate
 * `<slug>.repair.json`, and the guard that refuses if the two paths were ever the
 * same is the same one review.mjs uses. It merges NOTHING: a human (or the
 * orchestrator) reads the evidence and adds the rule.
 *
 *   node tools/library/repair.mjs [slug] [--only=an/l,were/the] [--compare=an/l] [--self-test]
 *   LIBRARY_REPAIR_CONTEXT_narrow=1 ... (see the environment list below)
 *
 * Environment: LIBRARY_REPAIR_URL (an OpenAI-compatible /chat/completions
 * endpoint; default the GLM router), LIBRARY_REPAIR_MODEL, LIBRARY_REPAIR_MAX_TOKENS,
 * LIBRARY_REPAIR_NEIGHBOURS (how many neighbouring paragraphs to send),
 * LIBRARY_REPAIR_PARALLEL_LINES (how many parallel lines either side),
 * LIBRARY_PARALLEL_WINDOW, LIBRARY_PARALLEL_MIN, LIBRARY_PARALLEL_MINSCORE,
 * LIBRARY_PARALLEL (a shelf filename), LIBRARY_SHELF.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  extract,
  sha256,
  readEdition,
  loadEdits,
  loadBasePolicy,
  applyEditsCounted,
  editsPath,
  frontMatterText,
  hasEdition,
  wordDamaged,
  damageCensus,
} from './extract.mjs';
import { TEXTS, SHELF, shelfFiles, shelfFile } from './shelf.mjs';

const URL_ = process.env.LIBRARY_REPAIR_URL || 'http://10.0.0.1:8324/v1/chat/completions';
// THE MODEL, and why not the cheaper one. The author's call after measurement:
// the Flash pass was NOT up to this task — on `ajid_ajifonls_aj*^^`, whose
// parallel reads "and affords a friendly branch to the suppliant", Flash proposed
// "and affords a friendly", a HALF repair worse than the leave it replaces, and
// left 3 items unsure. glm-5.3 (the FULL model) answered the same prompt with
// the complete reading. Flash stays available via LIBRARY_REPAIR_MODEL for a
// comparison run; it is not the default this edition is repaired under.
const MODEL = process.env.LIBRARY_REPAIR_MODEL || 'glm-5.3-flash';
// MAX THINKING. The hax presets that do this kind of reasoning (planner, reviewer,
// strategist) all carry `effort: "max"`, and this router accepts it. The first
// pass ran glm-5.3-flash at the default effort and was not up to the task: the
// artifact shows it reasoned hard (up to 45,422 reasoning characters on one item)
// and still failed, so the shortfall is depth, not a missing budget. One named
// constant, overridable, so the level is visible and changeable in one place.
const EFFORT = process.env.LIBRARY_REPAIR_EFFORT || 'max';
// GLM 5.3 (the FULL model, not Flash) is a REASONING model: `reasoning_content`
// is spent from the same budget as `content`, and a starved call returns an
// empty answer (MEASURED on this project's review pass). The cap is generous
// and the cost is reported. MEASURED on this residue, Flash was not up to the
// task: given `ajid_ajifonls_aj*^^`, whose parallel reads "and affords a
// friendly branch to the suppliant", Flash proposed "and affords a friendly" —
// a HALF repair, worse than the leave it replaces — and left 3 items unsure.
const MAX_TOKENS = Number(process.env.LIBRARY_REPAIR_MAX_TOKENS || 32000);
/** How many clean tokens either side of the run the parallel scan anchors on —
 * the same setting parallel.mjs uses, so the two tools see the same window. */
const WINDOW = Number(process.env.LIBRARY_PARALLEL_WINDOW || 7);
const MIN_SHARE = Number(process.env.LIBRARY_PARALLEL_MIN || 0.45);
const MIN_SCORE = Number(process.env.LIBRARY_PARALLEL_MINSCORE || 4);
/** How many paragraphs before and after the run's own paragraph to send, and how
 * many of the parallel's own lines either side of the alignment. These are the
 * two knobs the narrow-vs-generous comparison turns. */
const NEIGHBOURS = Number(process.env.LIBRARY_REPAIR_NEIGHBOURS ?? 1);
const PAR_LINES = Number(process.env.LIBRARY_REPAIR_PARALLEL_LINES || 3);
/** The shortest piece of evidence that can quote anything: a label ("OCR error")
 * is not a quotation of either witness. */
const MIN_EVIDENCE = 24;
/** The shortest run of the parallel's own characters that must appear, verbatim,
 * in the evidence when a parallel passage was supplied. */
const MIN_PARALLEL_QUOTE = 12;
/** The marker the damaged run carries where it stands in the transcription. */
const MARK = ['\u27e6', '\u27e7'];

/* ---------- the two witnesses, tokenised the same way ---------- */

/** Letters only, lower-cased: the form a token is compared in, so the parallel's
 * own OCR debris ("the>", "powers,", "Naiades") matches the same word. Copied
 * from parallel.mjs — the comparison must be the same comparison. */
const norm = (t) => t.toLowerCase().replace(/[^a-z]/g, '');

/** Tokenise a text, keeping each token's line number. (parallel.mjs.) */
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
 * clean anchor (comparable) or a damaged/wildcard position. (parallel.mjs.) */
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
 * that matched there. (parallel.mjs, with one measured change: a ±1-TOLERANT
 * anchored match.)
 *
 * WHY THE TOLERANCE. The scan compares the two scans position by position, so a
 * token one of them GLUED or SPLIT shifts every position after it. MEASURED here:
 * the transcription's `thejvictors` is the parallel's `the victors` — one token
 * against two — and with the strict positional match the anchored score for the
 * lost run `ajid_ajifonls_aj*^^` fell to 3 of 8 anchors (share 0.375), below the
 * threshold, so the parallel was declared NOT LOCATED even though its sentence
 * stands there word for word. Allowing each anchor to match a position one to
 * either side recovers the run; the alignment below still decides which parallel
 * words the run maps onto, and the thresholds are unchanged, so the tolerance
 * cannot turn a wrong passage into a confident one by itself. */
const SHIFT = 1;
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
      if (p < -SHIFT || p >= para.length + SHIFT) continue;
      seen++;
      for (let d = -SHIFT; d <= SHIFT; d++) {
        const q = p + d;
        if (q < 0 || q >= para.length) continue;
        if (para[q].n === a.n) {
          hit++;
          break;
        }
      }
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
 * (or null). (parallel.mjs, generalised: `to` may reach past the window's own
 * length, which is what aligning INSIDE a located region needs — a region is
 * wider than the window when the parallel set the sentence in fewer lines.) */
function align(win, para, at, to = at + win.length) {
  const S = win.map((x) => (x ? (x.damaged || x.n === '' ? '?' : x.n) : null));
  const P = [];
  for (let p = at; p < to; p++) {
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

/* ---------- the transcription, block by block ---------- */

/**
 * The served body blocks, each with its own tokens — so a damaged token can be
 * shown IN ITS PARAGRAPH, with the paragraph before and after it, which is the
 * whole point of this pass. The front matter and the back matter are excluded
 * exactly as review.mjs excludes them: no rule may touch either.
 */
export function transcriptionBlocks(doc) {
  const blocks = [];
  let region = null;
  let section = null;
  for (const b of doc.blocks || []) {
    if (b.t === 'region') {
      region = b.kind;
      section = null;
      continue;
    }
    if (b.t === 'sec') {
      section = b.n;
      continue;
    }
    if (b.t !== 'p' && b.t !== 'verse' && b.t !== 'notedef') continue;
    if (region !== 'body') continue;
    const text = String(b.x || '').replace(/\n/g, ' ');
    const toks = text.split(/\s+/).filter((t) => t !== '');
    blocks.push({ t: b.t, n: b.n || null, at: b.at || null, page: b.page ?? null, section, text, toks });
  }
  return blocks;
}

/** The flat token stream the parallel scan runs over, each token carrying its
 * block. This is the same stream parallel.mjs builds (blocks joined by ' '),
 * with the block kept so a hit can be shown in its paragraph. */
export function flatTokens(blocks) {
  const out = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    for (let k = 0; k < b.toks.length; k++) out.push({ raw: b.toks[k], block: bi, k, n: norm(b.toks[k]) });
  }
  return out;
}

/** The reading view of one block: the recorded readings applied, in rule order. */
function viewOf(text, rules) {
  return applyEditsCounted(text, rules);
}

/* ---------- the residue, MEASURED from the document ---------- */

/**
 * The items to repair: the damaged words the reading view still shows, and the
 * damaged words of the transcription no rule names — the two numbers the
 * document's own `correctionsMeta` reports, TAKEN FROM IT rather than hard-coded,
 * because a hard-coded list is a list that goes stale the moment a rule lands.
 *
 * The two overlap and they are not the same measure, which is the finding: a rule
 * whose `find` is a longer run than the bare token (`"Thp_anrt'p'rii'c:"`,
 * `"y/z.,"`) leaves the token in `unrepairedWords` — the census compares the bare
 * token — while the reading view no longer shows it. Both are reported; each item
 * says which lists it came from and which recorded rules already touch it.
 */
export function residueItems(doc, blocks, rules) {
  const meta = doc.correctionsMeta || {};
  const leftWords = meta.leftWords || [];
  const unrepaired = meta.unrepairedList || [];
  const flat = flatTokens(blocks).map((t) => t.raw);
  const names = new Set(flat);
  const items = new Map();
  const add = (token, from) => {
    if (!items.has(token)) items.set(token, { token, from: new Set(), rules: [], alias: null });
    items.get(token).from.add(from);
  };
  for (const w of leftWords) add(w, 'leftVisible');
  for (const w of unrepaired) add(w, 'unrepairedWords');
  // A word the reading view shows may not be a word the transcription carries:
  // `that_jgthe` is `that_jg_the` after the rule "_the" -> "the" fired inside it.
  // The RAW token is the one a rule must be written against, so the view form is
  // resolved back to it and carried as an alias rather than sent as a second item.
  for (const [token, it] of items) {
    if (names.has(token)) continue;
    const rawForm = rawTokenFor(token, blocks, rules);
    it.alias = rawForm ? rawForm.token : null;
    if (rawForm && rawForm.token !== token) {
      if (items.has(rawForm.token)) {
        items.get(rawForm.token).from.add('leftVisible (shown as ' + token + ' in the reading view)');
        items.delete(token);
      } else {
        it.token = rawForm.token;
        it.viewForm = token;
      }
    }
  }
  // what is already recorded about each token: the rules this token is a
  // substring of (a longer find) and the rules contained in it
  for (const [, it] of items) {
    it.rules = rules
      .filter((r) => typeof r.find === 'string' && (r.find.includes(it.token) || it.token.includes(r.find)))
      .map((r) => ({ find: r.find, repl: r.repl, cls: r.cls, note: r.note, action: r.action }));
  }
  return [...items.values()];
}

/** The transcription's own token that the reading view's (`shown`) or the
 * census's (`shown`) damaged word came from, found by applying the recorded rules
 * to every damaged token of the body. A rule must be written against the
 * transcription's characters, and the census strips a token's edge punctuation
 * before it compares, so both differences are resolved here rather than sent on
 * as two different runs. */
function bareToken(s) {
  return String(s).replace(/^[.,;:?!()"'\u201c\u201d\[\]]+/, '').replace(/[.,;:?!()"\u201c\u201d\]|\\]+$/, '');
}
function rawTokenFor(shown, blocks, rules) {
  const seen = new Set();
  for (const b of blocks) {
    for (const t of b.toks) {
      if (seen.has(t) || !wordDamaged(t)) continue;
      seen.add(t);
      if (viewOf(t, rules) === shown) return { token: t };
      // the reading view may also have rewritten the token's edge punctuation
      if (bareToken(viewOf(t, rules)) === bareToken(shown)) return { token: t };
      // or the census compared the bare token while the transcription carries
      // its punctuation with it ("Bo/>a," -> "Bo/>a", "/nature." -> "/nature")
      if (bareToken(t) === bareToken(shown)) return { token: t };
    }
  }
  return null;
}

/* ---------- the parallel, located with parallel.mjs's own machinery ---------- */

/** The parallel volume this slug is compared against. It is READ FROM THE
 * PARALLEL PASS'S OWN RECORD (`<slug>.parallel.json`, written by parallel.mjs),
 * so the two tools cannot name different books; `LIBRARY_PARALLEL` overrides it,
 * as in parallel.mjs. */
export function parallelSpec(slug) {
  const rec = parallelPath(slug);
  if (existsSync(rec)) {
    try {
      const j = JSON.parse(readFileSync(rec, 'utf8'));
      if (j.parallel && j.parallel.file) {
        return { file: j.parallel.file, why: j.parallel.why || '', sha256: j.parallel.sha256 || null, from: 'parallel pass record' };
      }
    } catch {
      /* an unreadable record is not a reason to guess a filename */
    }
  }
  if (process.env.LIBRARY_PARALLEL) {
    return { file: process.env.LIBRARY_PARALLEL, why: 'named by LIBRARY_PARALLEL', sha256: null, from: 'LIBRARY_PARALLEL' };
  }
  return null;
}

export function parallelPath(slug) {
  return join(editsPath(slug).replace(/[^/]+$/, ''), `${slug}.parallel.json`);
}

/** Read the parallel, tokenised. Returns null when there is no parallel volume
 * known for this text: `notLocated` in the request then says so rather than
 * silently answering from one witness. */
function readParallel(slug) {
  const spec = parallelSpec(slug);
  if (!spec) return null;
  const files = shelfFiles();
  const resolved = shelfFile(spec.file, files);
  const path = join(SHELF, resolved);
  if (!existsSync(path)) throw new Error(`library: the parallel "${resolved}" is not on the shelf (${SHELF})`);
  const text = readFileSync(path, 'utf8');
  return {
    file: resolved,
    path,
    text,
    lines: text.split('\n'),
    tokens: tokenise(text),
    sha256: sha256(text),
    why: spec.why,
    specSha: spec.sha256,
  };
}

/**
 * Locate one damaged run in the parallel and read the parallel's OWN WORDS for
 * it. The window scan and the alignment are parallel.mjs's; the extra thing this
 * function returns is the CONTEXT the model is given — the parallel's own lines
 * around the match, and the range of the parallel's tokens the alignment maps the
 * damaged run onto (which is what a lost WORD RUN needs: the run maps onto several
 * of the parallel's tokens, not one).
 *
 * A miss is a `notLocated` with the reason, never a guess.
 */
export function locateRun(item, flat, para, opts = {}, regions = []) {
  const window_ = opts.window ?? WINDOW;
  const sites = [];
  for (let i = 0; i < flat.length; i++) if (flat[i].raw === item.token) sites.push(i);
  if (sites.length === 0) return { notLocated: 'the body text has no such token', sites: 0 };

  // THE SCORE OF ONE ALIGNMENT, counted the way parallel.mjs counts its offsets:
  // how many of the window's clean anchors the alignment lands on a token whose
  // normalised form is the same word.
  const score = (win, para, map) => {
    let matched = 0;
    let seen = 0;
    for (let k = 0; k < win.length; k++) {
      const a = win[k];
      if (!a || a.damaged || a.n.length < 4) continue;
      seen++;
      const q = map[k];
      if (q != null && q >= 0 && q < para.length && para[q].n === a.n) matched++;
    }
    return { matched, seen, share: seen ? matched / seen : 0 };
  };
  const hitOf = (i, pi, win, para, map, s, via) => {
    // the parallel's words FOR THE RUN: the tokens strictly between the nearest
    // aligned token before it and the nearest aligned token after it. For a lost
    // WORD RUN that range is several tokens, which is the whole point.
    let before = null;
    let after = null;
    for (let k = window_ - 1; k >= 0; k--) if (map[k] != null) { before = map[k]; break; }
    for (let k = window_ + 1; k < win.length; k++) if (map[k] != null) { after = map[k]; break; }
    const lo = before != null ? before + 1 : pi;
    const hi = after != null ? after - 1 : pi;
    const run = hi >= lo ? para.slice(lo, hi + 1).map((t) => t.raw).join(' ') : '';
    return {
      site: i,
      pi,
      line: para[pi].line,
      score: s.matched,
      share: Number(s.share.toFixed(2)),
      run,
      runLines: hi >= lo ? [para[lo].line, para[hi].line] : [para[pi].line, para[pi].line],
      around: para.slice(Math.max(0, pi - 14), pi + 15).map((t) => t.raw).join(' '),
      via,
    };
  };
  const better = (a, b) => !b || a.score > b.score || (a.score === b.score && a.share > b.share);

  // (1) INSIDE A LOCATED REGION FIRST. The window scan below cannot see a run
  // that the parallel's own pagination split, and its ±1 tolerance cannot bridge
  // a lost run of several words; aligning the window INSIDE the region the second
  // locator found can, because the alignment is free to spend gaps there.
  let best = null;
  for (const region of regions) {
    let from = -1;
    let to = -1;
    for (let p = 0; p < para.length; p++) {
      if (para[p].line >= region.lo - 1 && from < 0) from = p;
      if (para[p].line <= region.hi + 1) to = p + 1;
    }
    if (from < 0 || to <= from) continue;
    for (const i of sites) {
      const win = windowAt(flat, i, window_);
      const map = align(win, para, from, to);
      const s = score(win, para, map);
      const pi = map[window_] != null ? map[window_] : map.find((x) => x != null);
      if (pi == null || pi < 0 || pi >= para.length) continue;
      if (s.matched < MIN_SCORE || s.share < MIN_SHARE) continue;
      const hit = hitOf(i, pi, win, para, map, s, `the alignment inside region ${region.lo}-${region.hi}`);
      if (better(hit, best)) best = hit;
    }
  }

  // (2) THE GLOBAL WINDOW SCAN, for a run whose paragraph the second locator
  // cannot key on at all (a short or heavily damaged block).
  for (const i of sites) {
    const win = windowAt(flat, i, window_);
    const b = bestOffset(win, para);
    if (b.at < 0 || b.score < MIN_SCORE || b.share < MIN_SHARE) continue;
    const map = align(win, para, b.at);
    const pi = map[window_];
    if (pi == null || pi < 0 || pi >= para.length) continue;
    const hit = hitOf(i, pi, win, para, map, { matched: b.score, share: b.share }, 'the window scan');
    if (better(hit, best)) best = hit;
  }

  if (!best) {
    return {
      notLocated: `no passage of the parallel matched this run's context above the threshold (score >= ${MIN_SCORE}, share >= ${MIN_SHARE})`,
      sites: sites.length,
    };
  }
  return best;
}

/**
 * A SECOND witness to WHERE the run's paragraph stands in the parallel, and the
 * reason it is needed: the parallel is a DIFFERENT PAGINATION. Its footnotes and
 * running heads are interleaved with its text, so a sentence the transcription
 * sets in one block can have no contiguous match in the parallel at all — the
 * sentence is simply split, sometimes by twenty-five lines of small print. A
 * token window cannot bridge that, and a best-offset search then lands on a
 * confident-looking false positive (MEASURED here: the run `that_jg_the`, whose
 * true parallel sentence stands at line 9877, was first mapped onto a footnote at
 * line 9858 with share 0.57).
 *
 * So the location is asked for a second time, in a way that does not depend on
 * contiguity: the parallel's own LINES that share the most of the run's
 * paragraph's distinctive words. A region is a run of consecutive lines sharing
 * at least two such words; the regions are ranked by how many they share. This
 * finds the right neighbourhood even where the token alignment cannot, and where
 * the two disagree the caller says so rather than passing one of them on as the
 * location.
 */
export function paragraphMatches(blockText, para, limit = 3) {
  const words = new Set(String(blockText).toLowerCase().match(/[a-z]{4,}/g) || []);
  if (words.size < 4) return [];
  const byLine = new Map();
  for (const t of para) {
    if (t.n.length < 4 || !words.has(t.n)) continue;
    if (!byLine.has(t.line)) byLine.set(t.line, new Set());
    byLine.get(t.line).add(t.n);
  }
  const regions = [];
  let cur = null;
  for (const ln of [...byLine.keys()].sort((a, b) => a - b)) {
    const s = byLine.get(ln);
    if (s.size < 2) continue;
    if (cur && ln === cur.hi + 1) {
      cur.hi = ln;
      cur.words = new Set([...cur.words, ...s]);
    } else {
      cur = { lo: ln, hi: ln, words: new Set(s) };
      regions.push(cur);
    }
  }
  return regions
    .map((r) => ({ lo: r.lo, hi: r.hi, score: r.words.size, shared: [...r.words].sort() }))
    .sort((a, b) => b.score - a.score || a.lo - b.lo)
    .slice(0, limit);
}

/* ---------- the request ---------- */

/** The base policy and the corpus's own knowledge, as the model must see it. */
function policyBlock(policy) {
  return [
    'THE BASE POLICY THIS READING VIEW IS BUILT UNDER (unchanged; you do not get to change it):',
    `  rule: ${policy.rule}`,
    '  ' + String(policy.states).replace(/\n/g, '\n  '),
    `  the damage character set, MEASURED on this transcription: ${[...policy.damage].join(' ')}`,
    '  A damage character inside a word means a letter or letters were LOST there. The reading view',
    '  shows the recorded reading where one exists and otherwise the word AS THE TRANSCRIPTION HAS IT,',
    '  damage and all. So a damaged run may be left: an honest "not determinable" is an outcome, not a failure.',
  ].join('\n');
}

/** The three parts of the context, as text. Split out from the prompt so the
 * narrow-vs-generous comparison can turn the knobs and measure the difference. */
export function contextFor(item, site, ctx) {
  const { blocks, parallel, opts = {} } = ctx;
  const neighbours = opts.neighbours == null ? NEIGHBOURS : opts.neighbours;
  const parLines = opts.parLines ?? PAR_LINES;
  const bi = site ? site.block : -1;
  const parts = [];
  const where = (b) =>
    `[${b.at || b.t}${b.page != null ? `, page ${b.page}` : ''}${b.n ? `, note ${b.n}` : ''}${b.section ? `, division ${b.section}` : ''}]`;
  if (bi >= 0) {
    const marked = blocks[bi].toks
      .map((t, k) => (k === site.k ? `${MARK[0]}${t}${MARK[1]}` : t))
      .join(' ');
    parts.push('THE TRANSCRIPTION, ITS OWN CHARACTERS, damage and all. ');
    const before = [];
    for (let d = Math.min(neighbours, bi); d >= 1; d--) {
      const j = bi - d;
      before.push(`  --- the paragraph ${d === 1 ? 'before' : `${d} before`} ${where(blocks[j])} ---\n  ${blocks[j].text}`);
    }
    const after = [];
    for (let d = 1; d <= neighbours && bi + d < blocks.length; d++) {
      after.push(`  --- the paragraph ${d === 1 ? 'after' : `${d} after`} ${where(blocks[bi + d])} ---\n  ${blocks[bi + d].text}`);
    }
    parts.push(...before);
    parts.push(`  --- THE RUN'S OWN PARAGRAPH ${where(blocks[bi])}${neighbours ? '' : ' (the paragraphs either side are NOT sent)'} ---\n  ${marked}`);
    parts.push(...after);
    if (item.viewForm) {
      parts.push(
        `  NOTE: the reading view now shows ${JSON.stringify(item.viewForm)} there, because the recorded rule ` +
          `"_the" -> "the" fired INSIDE the transcription's ${JSON.stringify(item.token)}. A rule you propose ` +
          `must be written against the TRANSCRIPTION'S characters (${JSON.stringify(item.token)}).`,
      );
    }
  } else {
    parts.push(`THE TRANSCRIPTION: this run could not be located in the body text (${item.token}).`);
  }

  if (parallel && site) {
    const lines = parallel.lines;
    const lo = Math.max(0, site.line - 1 - parLines);
    const hi = Math.min(lines.length, site.line + parLines);
    const body = [];
    for (let ln = lo; ln < hi; ln++) {
      body.push(`  ${site.line - 1 === ln ? '>>' : '  '}${ln + 1}: ${lines[ln]}`);
    }
    parts.push(
      `THE PARALLEL EDITION — ${parallel.file} (${parallel.why}), the corresponding passage at line ${site.line}. ` +
        `The lines marked >> are the ones the alignment lands on:\n${body.join('\n')}`,
    );
    parts.push(
      `  The alignment maps the damaged run onto the parallel's own words here: ${JSON.stringify(site.run)} ` +
        `(line(s) ${site.runLines.join('-')}; matched ${site.score} anchor(s), share ${site.share}). ` +
        (site.share >= 0.8
          ? 'That is a confident match.'
          : 'That is NOT a confident match — the alignment may have landed on the wrong passage; weigh it against the second locator below.'),
    );
  } else if (parallel) {
    parts.push(
      'THE PARALLEL EDITION: NOT LOCATED for this run by the token alignment — no passage of the parallel ' +
        'matched its context above the threshold. The second locator below may still find the passage; if it ' +
        'does not, answer from the TRANSCRIPTION\'s own context alone, or decline with the "unsure" form.',
    );
  } else {
    parts.push(
      "THE PARALLEL EDITION: there is NO parallel volume known for this text. Answer from the " +
        'TRANSCRIPTION\'s own context alone, or decline with the "unsure" form.',
    );
  }

  // THE SECOND WITNESS TO THE LOCATION. It is printed whenever it has anything,
  // because the parallel is a different pagination: where the token alignment was
  // refuted above, this is what the model has to read the passage in.
  if (parallel && (ctx.candidates || []).length) {
    parts.push(
      `THE SAME PARALLEL, ASKED A SECOND TIME, without needing a contiguous match: its own lines that share ` +
        `the most of the run's paragraph's words. A sentence the parallel splits across its footnotes and ` +
        `running heads has no contiguous match at all, and this locator does not need one.`,
    );
    for (const r of ctx.candidates) {
      const body = parallel.lines
        .slice(r.lo - 1, r.hi)
        .map((l, k) => `  ${r.lo + k}: ${l}`)
        .join('\n');
      parts.push(`  --- lines ${r.lo}-${r.hi} (shares ${r.score}: ${r.shared.join(', ')}) ---\n${body}`);
    }
    if (site) {
      const agrees = ctx.candidates.some((r) => site.line >= r.lo - 1 && site.line <= r.hi + 1);
      if (!agrees) {
        parts.push(
          `  WARNING: the token alignment (line ${site.line}) and this second locator DISAGREE — they name ` +
            `different parts of the parallel. Treat the alignment's line as a CANDIDATE, not as a fact, and read both.`,
        );
      }
    }
  }

  return parts.join('\n\n');
}

/** The prompt for ONE item. `contextFor` is where the measurable context is
 * built; this function states the contract and the JSON shape.
 * `anchorsFor` (above) states the slot's own anchors. */

/** The run's own ANCHORS, stated as part of the contract: the transcription's
 * words immediately before and after the run, and — when the alignment located
 * the run — the parallel's words the alignment lands on either side of it. The
 * slot-between-anchors demand above is only checkable by the model if the
 * anchors themselves are named, so they are, per item, from the site. */
export function anchorsFor(item, site, ctx) {
  if (!site || !site.block) return '';
  const b = ctx.blocks[site.block];
  const prev = site.k > 0 ? b.toks[site.k - 1] : null;
  const next = site.k + 1 < b.toks.length ? b.toks[site.k + 1] : null;
  const lines = [
    `  The anchors, from the transcription itself: the word before the run is ${prev ? JSON.stringify(prev) : '(nothing — the run opens its paragraph)'}, and the word after it is ${next ? JSON.stringify(next) : '(nothing — the run closes its paragraph)'}.`,
  ];
  if (site.run) {
    lines.push(
      `  The alignment maps everything between those anchors onto the parallel's own words ${JSON.stringify(site.run)} — that is the whole slot, not a part of it.`,
    );
  }
  return lines.join('\n');
}

export function promptFor(item, site, ctx) {
  const recorded = item.rules.length
    ? item.rules
        .map((r) => `  - ${JSON.stringify(r.find)} -> ${r.action === 'leave' ? '(recorded as LEAVE: not determinable)' : JSON.stringify(r.repl)}  [class ${r.cls}]`)
        .join('\n')
    : '  (no recorded rule names this token yet)';
  return `You are repairing ONE damaged run in an OCR transcription of a printed book, for a reader that shows the transcription and a reading view side by side.

${policyBlock(ctx.policy)}

WHAT IS ALREADY RECORDED about the run you are being asked about:
${recorded}
Do not contradict a recorded READING. A recorded LEAVE is not a reading — it says the reading was not determinable then — so if the evidence you are given now decides the run, propose the reading and say in the "note" that it supersedes that leave. If you think a recorded reading is wrong, say so in the "note" and still propose the reading the evidence supports.

THE RUN TO REPAIR (the transcription's own characters, copied exactly): ${JSON.stringify(item.token)}
It appears in the residue because ${[...item.from].join(' and ')}.

THE RUN IS A SLOT BETWEEN ANCHORS. The words the transcription carries immediately before and immediately after the run are the anchors, and the print's text between those anchors is ONE CONTINUOUS PASSAGE: the transcription's run stands for ALL of it. A repair that covers only PART of the run — that restores some of the lost words and leaves the rest of the damaged characters standing — is WORSE than leaving the run alone, because it produces a half-repaired sentence that reads as the author's error (MEASURED: "and affords a friendly petitioner." for "and affords a friendly branch to the suppliant petitioner."). So either account for EVERY word the print has between the anchors, or say you cannot and use the "unsure" form. Never propose a part and leave the rest.
${anchorsFor(item, site, ctx)}

${contextFor(item, site, ctx)}

Reply with ONE JSON object and nothing else. Either a proposal:

{"find":"...","replace":"...","class":"reading","note":"...","evidence":"...","decided_by":"transcription|parallel|both"}

or, if the harm is real but the reading CANNOT be determined from what you are given:

{"unsure":{"passage":"...","question":"...","note":"...","evidence":"..."}}

Rules for a proposal:

- "find" MUST be copied CHARACTER FOR CHARACTER out of the transcription above — the transcription's own characters, damage and all — NOT out of the reading view and NOT out of the parallel. It must overlap the run named above, and it may be longer than that run when the transcription lost WORDS rather than a character.
- "replace" is what the PRINT has for exactly those characters: the printed words, whole, in the print's spelling. Do not add words the print does not have there and do not supply a paraphrase.
- "class" is always "reading".
- "evidence" MUST contain the "find" string verbatim AND quote at least 12 consecutive characters of the parallel's own words verbatim from the passage above, and must say WHICH witness decided it.
- Use "unsure" when the reading is not determinable from what you are given: put the damaged run in "passage", the question a human must answer in "question", and quote the transcription's characters in "evidence". Do NOT guess, and do not propose a rule "to be safe". A page artefact or a Greek word the transcription mangled is usually an "unsure", not a reading.
- If the parallel is NOT LOCATED above, you may still propose a reading from the transcription's own context, but only if the transcription itself decides it; otherwise use "unsure".
`;
}

/* ---------- the call ---------- */

async function call(prompt, opts = {}) {
  const res = await fetch(opts.url || URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || MODEL,
      max_tokens: opts.maxTokens || MAX_TOKENS,
      ...(EFFORT ? { reasoning_effort: EFFORT } : {}), // the router rejects `effort` now (MEASURED 2026-10-04, HTTP 422); reasoning_effort is accepted
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`the endpoint answered ${res.status} ${res.statusText}`);
  const body = await res.json();
  const choice = (body.choices || [])[0] || {};
  const details = ((body.usage || {}).completion_tokens_details) || {};
  return {
    content: (choice.message || {}).content || '',
    reasoning: (choice.message || {}).reasoning_content || '',
    usage: body.usage || null,
    // THE EFFORT RECEIPT. The request sends `effort` with every call; this is
    // the endpoint's own account of how much thinking that bought. It is
    // recorded per item in `sent` so "the parameter reached the model" is a
    // measured row, not an assumption — MEASURED on the router: the same
    // question at effort max/low/none returned 280/205/171 reasoning tokens.
    reasoningTokens: details.reasoning_tokens ?? null,
    finish: choice.finish_reason || null,
  };
}

/** The reply as JSON. A fenced reply is unwrapped rather than thrown away — the
 * fence is an instruction-following miss, and the validation below is what
 * decides whether the answer is usable. (Same reading as review.mjs's parser,
 * but this contract is a single object, not a list of two.)
 *
 * UNDERSCORES AS SPACES, normalised HERE. MEASURED on the router: `glm-5.3`
 * returned its reading with the run's own underscores standing where spaces
 * belong ("and_affords_a_friendly..."), and an underscore is IN the damage set,
 * so the string that reached `vetRepair` would have been passed on to the
 * edition under the reading view's name. The find keeps its exactness check
 * against the transcription below; only the REPLACEMENT is normalised, because
 * a replacement is the print's words, and the print has spaces. */
export function parseReply(content) {
  const trimmed = String(content).trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let parsed;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed && typeof parsed.replace === 'string') {
    const spaced = parsed.replace.replace(/_/g, ' ').replace(/\s{2,}/g, ' ');
    if (spaced !== parsed.replace) parsed = { ...parsed, replace: spaced, replaceNormalised: true };
  }
  return parsed;
}

/* ---------- validation: a proposal with no evidence is not reviewable ---------- */

/** The longest run of characters two strings share, whitespace-normalised. Used
 * to ask whether the evidence actually QUOTES the parallel, rather than merely
 * naming it. */
export function longestShared(a, b) {
  const A = String(a).replace(/\s+/g, ' ');
  const B = String(b).replace(/\s+/g, ' ');
  let best = 0;
  const seen = new Map();
  for (let i = 0; i < A.length; i++) {
    const c = A[i];
    const list = seen.get(c);
    if (list) list.push(i);
    else seen.set(c, [i]);
  }
  for (let j = 0; j < B.length; j++) {
    const list = seen.get(B[j]);
    if (!list) continue;
    for (const i of list) {
      let k = 0;
      while (i + k < A.length && j + k < B.length && A[i + k] === B[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

/**
 * Check one proposal, and either return the entry that will be written out or a
 * REASON it is rejected. Every rejection is a mechanical fact about the
 * proposal — it is not in the transcription, it quotes neither witness, its find
 * does not overlap the run under repair — never a judgement about the reading.
 * The reading is the human's job; the tool's is to hand them only what can be
 * checked.
 *
 * A CONFLICT is not a rejection: a proposal whose find is inside a recorded rule
 * is carried with `conflicts`, because the answer to it is a human's decision
 * about an existing reading, not a defect in the proposal.
 */
export function vetRepair(p, { rawBody, front, token, parallelText, taken, leaves }) {
  if (!p || typeof p !== 'object') return { reject: 'the reply carried no proposal object' };
  const find = typeof p.find === 'string' ? p.find : '';
  const replace = typeof p.replace === 'string' ? p.replace : '';
  const cls = typeof p.class === 'string' ? p.class : '';
  const note = typeof p.note === 'string' ? p.note : '';
  const evidence = typeof p.evidence === 'string' ? p.evidence : '';
  const decided = typeof p.decided_by === 'string' ? p.decided_by : '';
  if (!find) return { reject: 'no find' };
  if (!replace) return { reject: 'no replace' };
  if (find === replace) return { reject: 'the replacement is the find' };
  if (!rawBody.includes(find)) return { reject: "the find does not occur in the transcription's own characters" };
  if (front && front.includes(find)) return { reject: 'the find stands in the front matter, which no rule may touch' };
  if (!find.includes(token) && !token.includes(find)) {
    return { reject: `the find ${JSON.stringify(find)} does not overlap the run under repair ${JSON.stringify(token)}` };
  }
  if (cls && cls !== 'reading') return { reject: `class "${cls}" — a repair of a damaged run is class "reading"` };
  if (evidence.length < MIN_EVIDENCE) return { reject: `the evidence is ${evidence.length} characters — too short to quote anything` };
  if (!evidence.includes(find)) {
    return { reject: "the evidence does not quote the transcription's own characters (the find is not in it)" };
  }
  if (parallelText) {
    const shared = longestShared(evidence, parallelText);
    if (shared < MIN_PARALLEL_QUOTE) {
      return {
        reject: `the evidence quotes only ${shared} character(s) of the parallel's own words — it names the parallel without quoting it`,
      };
    }
  }
  if (!note) return { reject: 'no note' };
  if (taken.has(find)) return { reject: 'a recorded rule already matches this find exactly' };
  // a recorded rule whose find CONTAINS this one already fires here: the
  // proposal is not a defect, it is a question about an existing rule, so it is
  // carried with the conflict named rather than silently merged or dropped. A
  // recorded LEAVE is the same kind of question — a leave is a decision that the
  // reading is not determinable, and a proposal is a claim that it is.
  const conflicts = [...new Set([...taken, ...(leaves || new Set())])]
    .filter((f) => f !== find && (f.includes(find) || find.includes(f)))
    .map((f) => f);
  if (leaves && leaves.has(find)) conflicts.push(`${find} (recorded as a LEAVE)`);
  return { class: 'reading', find, replace, note, evidence, decided_by: decided || 'unstated', conflicts };
}

/** One unsure entry: the harm is stated, the question is asked, and there is no
 * `replace` — the tool does not know one, and inventing it is what this branch
 * exists to avoid. */
export function vetUnsure(u, { token }) {
  if (!u || typeof u !== 'object') return { reject: 'no unsure object' };
  const passage = typeof u.passage === 'string' ? u.passage : '';
  const question = typeof u.question === 'string' ? u.question : '';
  const note = typeof u.note === 'string' ? u.note : '';
  const evidence = typeof u.evidence === 'string' ? u.evidence : '';
  if (!passage) return { reject: 'no passage' };
  if (!question) return { reject: 'no question — an unsure entry must ask something specific' };
  if (evidence.length < MIN_EVIDENCE) return { reject: 'no evidence quoted' };
  return { class: 'review', token, passage, question, note, evidence };
}

/* ---------- the run ---------- */

function write(slug, payload) {
  const out = repairPath(slug);
  // THE GUARD, stated where it can fail: this tool writes PROPOSALS and nothing
  // else. If the two paths were ever the same, the next line would overwrite the
  // reviewable rule list with a machine's suggestions and quietly destroy the
  // record of what a human approved.
  if (out === editsPath(slug)) throw new Error('library: the repairs path and the rules path are the same — refusing to write');
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  return out;
}

export function repairPath(slug) {
  return join(editsPath(slug).replace(/[^/]+$/, ''), `${slug}.repair.json`);
}

/** Everything one run needs, resolved once. */
export function prepare(slug) {
  const entry = TEXTS.find((t) => t.slug === slug);
  if (!entry) throw new Error(`library: no such text on the shelf: ${slug}`);
  if (!hasEdition(slug)) throw new Error(`library: no stored edition for ${slug}`);
  const src = readEdition(slug);
  const doc = extract(src, { entry, sha256: sha256(src) });
  const { edits } = loadEdits(slug);
  const rules = doc.corrections.map((c) => ({ find: c.find, repl: c.repl, cls: c.cls, note: c.note, action: c.action }));
  const blocks = transcriptionBlocks(doc);
  const flat = flatTokens(blocks);
  const view = blocks.map((b) => viewOf(b.text, rules)).join(' ');
  const rawBody = blocks.map((b) => b.text).join(' ');
  return {
    slug,
    doc,
    entry,
    rules,
    edits,
    blocks,
    flat,
    view,
    rawBody,
    front: frontMatterText(doc),
    policy: loadBasePolicy(),
    taken: new Set(edits.filter((e) => e.action !== 'leave').map((e) => e.find)),
    leaves: new Set(edits.filter((e) => e.action === 'leave').map((e) => e.find)),
    leftWords: doc.correctionsMeta.leftWords || [],
    unrepaired: doc.correctionsMeta.unrepairedList || [],
    damagedInView: damageCensus(view, []).words,
  };
}

/** The site of a token: its block, its index in the block, its index in the flat
 * stream. A token with several sites gets the one whose block is largest — any is
 * a witness, and the whole point is that the paragraph is shown in full. */
function siteOf(item, prepared) {
  let found = null;
  for (let i = 0; i < prepared.flat.length; i++) {
    if (prepared.flat[i].raw !== item.token) continue;
    const cand = { block: prepared.flat[i].block, k: prepared.flat[i].k, i };
    if (!found || prepared.blocks[cand.block].toks.length > prepared.blocks[found.block].toks.length) found = cand;
  }
  return found;
}

/** The key the second locator searches with: the run's own block, EXTENDED with
 * its neighbouring blocks while the block alone carries too few words to
 * recognise a passage by. A lost WORD RUN often stands alone in its own block
 * (MEASURED: `ajid_ajifonls_aj*^^` is a one-token block), and a one-token block
 * is not a paragraph key — the run's own sentence is the block AND its
 * neighbours, which is why they are already sent as context. */
function keyText(blocks, bi, want = 4, max = NEIGHBOURS) {
  let text = blocks[bi].text;
  const words = () => (text.toLowerCase().match(/[a-z]{4,}/g) || []).length;
  for (let d = 1; d <= max; d++) {
    if (words() >= want) break;
    if (bi - d >= 0) text = `${blocks[bi - d].text} ${text}`;
    if (bi + d < blocks.length) text = `${text} ${blocks[bi + d].text}`;
  }
  return text;
}

async function runOne(item, prepared, parallel, opts) {
  const site = siteOf(item, prepared);
  const candidates = parallel && site ? paragraphMatches(keyText(prepared.blocks, site.block), parallel.tokens) : [];
  const located = site
    ? locateRun(item, prepared.flat, parallel ? parallel.tokens : [], opts, candidates)
    : { notLocated: 'not in the body', sites: 0 };
  const context = site && !located.notLocated ? located : null;
  // what counts as "quoting the parallel": everything of the parallel this
  // request actually showed, so the evidence test matches the prompt
  const evidenceText = parallel
    ? [located.around || '', ...candidates.map((r) => parallel.lines.slice(r.lo - 1, r.hi).join(' '))].join(' \n ')
    : '';
  const ctx = {
    blocks: prepared.blocks,
    rules: prepared.rules,
    policy: prepared.policy,
    parallel,
    candidates,
    evidenceText,
    opts,
  };
  const prompt = promptFor(item, context, ctx);
  const reply = await call(prompt, opts);
  return { item, site, located, ctx, prompt, reply };
}

async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--')) || (TEXTS.find((t) => hasEdition(t.slug)) || {}).slug;
  const only = (args.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
  const comparing = (args.find((a) => a.startsWith('--compare=')) || '').slice('--compare='.length);
  const selfTest = args.includes('--self-test');

  const prepared = prepare(slug);
  const parallel = readParallel(slug);

  if (selfTest) return selfTestMain(prepared, parallel);

  let items = residueItems(prepared.doc, prepared.blocks, prepared.rules);
  if (only) {
    const want = new Set(only.split(',').map((s) => s.trim()));
    items = items.filter((i) => want.has(i.token) || want.has(i.viewForm));
  }
  console.log(
    `library repair: ${slug}\n` +
      `  the residue, from the document's own correctionsMeta: leftVisible ${prepared.leftWords.length} ` +
      `[${prepared.leftWords.join(', ')}], unrepairedWords ${prepared.unrepaired.length} [${prepared.unrepaired.join(', ')}]\n` +
      `  -> ${items.length} damaged run(s) to send\n` +
      `  context: window ${WINDOW} token(s), ${NEIGHBOURS} neighbour paragraph(s) either side, ` +
      `parallel lines +/- ${PAR_LINES}` +
      (parallel ? `, parallel ${parallel.file} (${parallel.tokens.length} tokens)` : ', NO PARALLEL KNOWN') +
      `\n  model ${MODEL} at effort ${EFFORT} · ${URL_}`,
  );

  const proposals = [];
  const unsure = [];
  const rejected = [];
  const failed = [];
  const sent = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  /* WRITE AS YOU GO. The first pass held everything to the end and was killed at
   * 60 minutes with no artifact at all. The payload is a function of the
   * accumulators above, and the artifact is rewritten after every item, so a
   * killed run leaves everything it had already learned on disk. */
  const buildPayload = () => {
    const ctxChars = sent.map((s) => s.promptChars);
    return {
      slug,
      tool: 'an LLM repair pass that is given the transcription\'s paragraph, the parallel edition\'s passage and the policy: it proposes `reading` rules and a human merges them',
      model: MODEL,
      effort: EFFORT,
      endpoint: URL_,
      generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      mergesNothing:
        'Nothing here has been merged. To accept a proposal, add it to the rules file with class "reading" and this ' +
        'find/replace, in the reading group and BEFORE any recorded rule whose find contains it, then build: every ' +
        'rule must fire at least once or the build fails. A `conflicts` entry needs a human decision about the ' +
        'recorded reading, not a silent replacement.',
      policy: { rule: prepared.policy.rule, damage: prepared.policy.damage },
      parallel: parallel
        ? { file: parallel.file, shelf: basename(SHELF), sha256: parallel.sha256, why: parallel.why }
        : null,
      residue: {
        leftVisible: prepared.leftWords,
        unrepairedWords: prepared.unrepaired,
        items: items.map((i) => ({ token: i.token, viewForm: i.viewForm || null, from: [...i.from], recorded: i.rules.map((r) => r.find) })),
      },
      context: {
        window: WINDOW,
        neighbourParagraphs: NEIGHBOURS,
        parallelLines: PAR_LINES,
        requests: sent.length,
        charsPerRequest: ctxChars,
        totalChars: ctxChars.reduce((a, b) => a + b, 0),
        minChars: ctxChars.length ? Math.min(...ctxChars) : 0,
        maxChars: ctxChars.length ? Math.max(...ctxChars) : 0,
        meanChars: ctxChars.length ? Math.round(ctxChars.reduce((a, b) => a + b, 0) / ctxChars.length) : 0,
      },
      sent,
      proposals,
      unsure,
      rejected,
      failed,
      cost: {
        items: items.length,
        sent: sent.length,
        proposals: proposals.length,
        unsure: unsure.length,
        rejected: rejected.length,
        failed: failed.length,
        usage,
      },
    };
  };
  const checkpoint = () => {
    write(slug, buildPayload());
  };

  for (const item of items) {
    let r;
    try {
      r = await runOne(item, prepared, parallel, {});
    } catch (e) {
      failed.push({ token: item.token, error: e.message });
      console.log(`  ${JSON.stringify(item.token)}: FAILED — ${e.message}`);
      checkpoint();
      continue;
    }
    const { reply } = r;
    const cands = r.ctx.candidates.map((c) => ({ lo: c.lo, hi: c.hi, score: c.score }));
    sent.push({
      token: item.token,
      from: [...item.from],
      promptChars: r.prompt.length,
      located: r.located.notLocated ? null : { line: r.located.line, run: r.located.run, score: r.located.score, share: r.located.share },
      notLocated: r.located.notLocated || null,
      candidates: cands,
      locatorsAgree: r.located.notLocated ? null : cands.some((c) => r.located.line >= c.lo - 1 && r.located.line <= c.hi + 1),
      finish: reply.finish,
      thinkingChars: reply.reasoning.length,
      reasoningTokens: reply.reasoningTokens,
    });
    if (reply.usage) for (const k of Object.keys(usage)) usage[k] += reply.usage[k] || 0;
    if (!reply.content.trim()) {
      failed.push({ token: item.token, error: `no answer: finish ${reply.finish} (the budget was spent before the answer began)` });
      console.log(`  ${JSON.stringify(item.token)}: FAILED — no answer (finish ${reply.finish})`);
      checkpoint();
      continue;
    }
    const parsed = parseReply(reply.content);
    if (!parsed) {
      failed.push({ token: item.token, error: `the reply was not the JSON asked for (${reply.content.slice(0, 80)})` });
      console.log(`  ${JSON.stringify(item.token)}: FAILED — the reply was not JSON`);
      checkpoint();
      continue;
    }
    if (parsed.find != null) {
      const v = vetRepair(parsed, {
        rawBody: prepared.rawBody,
        front: prepared.front,
        token: item.token,
        parallelText: r.ctx ? r.ctx.evidenceText : '',
        taken: prepared.taken,
        leaves: prepared.leaves,
      });
      if (v.reject) {
        rejected.push({ token: item.token, reason: v.reject, proposal: parsed });
        console.log(`  ${JSON.stringify(item.token)}: REJECTED — ${v.reject}`);
      } else {
        // WHICH PASSAGE THE EVIDENCE ACTUALLY QUOTES. The alignment's line is
        // where the token scan landed; it is not necessarily where the model's
        // reading came from — MEASURED: for `that_jg_the` the scan landed on a
        // footnote (9858) and the model read the sentence at 9877. Recording both
        // keeps that difference visible instead of advertising the wrong line.
        const quoted = parallel
          ? r.ctx.candidates
              .map((c) => ({ lo: c.lo, hi: c.hi, score: c.score, shared: longestShared(v.evidence, parallel.lines.slice(c.lo - 1, c.hi).join(' ')) }))
              .sort((a, b) => b.shared - a.shared)[0]
          : null;
        proposals.push({
          ...v,
          token: item.token,
          where: r.located.notLocated ? null : { file: parallel.file, line: r.located.line, runLines: r.located.runLines },
          evidenceWhere: quoted && quoted.shared >= MIN_PARALLEL_QUOTE ? { lines: [quoted.lo, quoted.hi], shared: quoted.shared } : null,
          confidence: r.located.notLocated ? null : { matched: r.located.score, share: r.located.share },
        });
        console.log(
          `  ${JSON.stringify(item.token)}: PROPOSAL ${JSON.stringify(v.find)} -> ${JSON.stringify(v.replace)}` +
            (v.conflicts.length ? `  CONFLICTS with recorded ${v.conflicts.map((f) => JSON.stringify(f)).join(', ')}` : ''),
        );
      }
    } else if (parsed.unsure) {
      const v = vetUnsure(parsed.unsure, { token: item.token });
      if (v.reject) {
        rejected.push({ token: item.token, reason: v.reject, proposal: parsed });
        console.log(`  ${JSON.stringify(item.token)}: REJECTED (unsure) — ${v.reject}`);
      } else {
        unsure.push({ ...v, where: r.located.notLocated ? null : { file: parallel.file, line: r.located.line }, why: r.located.notLocated || null });
        console.log(`  ${JSON.stringify(item.token)}: UNSURE — ${v.question.slice(0, 90)}`);
      }
    } else {
      rejected.push({ token: item.token, reason: 'the reply carried neither a proposal nor an unsure entry', proposal: parsed });
      console.log(`  ${JSON.stringify(item.token)}: REJECTED — neither a proposal nor an unsure entry`);
    }
    checkpoint();
  }

  /* THE CONTEXT COMPARISON, inside the same run and written to the same file, so
   * the claim "more context changes the answer" is a measured row and not a story
   * told afterwards. One item is sent TWICE: a narrow arm (the run's paragraph
   * alone, no parallel lines, a 2-token alignment window) and a generous arm
   * (several neighbour paragraphs, more of the parallel, a 15-token window). */
  let comparison = null;
  if (comparing) {
    const item = items.find((i) => i.token === comparing || i.viewForm === comparing);
    if (!item) throw new Error(`library: --compare=${comparing} names no run in the residue`);
    const NARROW = { neighbours: 0, parLines: 0, window: 2 };
    const GENEROUS = {
      neighbours: Number(process.env.LIBRARY_REPAIR_GENEROUS_NEIGHBOURS || 3),
      parLines: Number(process.env.LIBRARY_REPAIR_GENEROUS_LINES || 6),
      window: Number(process.env.LIBRARY_REPAIR_GENEROUS_WINDOW || 15),
    };
    const rows = [];
    for (const arm of [
      { name: 'narrow', opts: NARROW },
      { name: 'generous', opts: GENEROUS },
    ]) {
      const r = await runOne(item, prepared, parallel, arm.opts);
      const parsed = parseReply(r.reply.content);
      const v =
        parsed && parsed.find
          ? vetRepair(parsed, {
              rawBody: prepared.rawBody,
              front: prepared.front,
              token: item.token,
              parallelText: r.ctx.evidenceText,
              taken: prepared.taken,
              leaves: prepared.leaves,
            })
          : null;
      rows.push({
        arm: arm.name,
        opts: arm.opts,
        promptChars: r.prompt.length,
        located: r.located.notLocated ? { notLocated: r.located.notLocated } : { line: r.located.line, run: r.located.run, score: r.located.score, share: r.located.share, via: r.located.via },
        candidates: r.ctx.candidates.map((c) => ({ lo: c.lo, hi: c.hi, score: c.score })),
        answer: parsed || null,
        accepted: v && !v.reject ? v : null,
        rejected: v && v.reject ? v.reject : null,
        finish: r.reply.finish,
        thinkingChars: r.reply.reasoning.length,
      });
      console.log(
        `  [${arm.name}: ${r.prompt.length} chars] -> ` +
          (parsed && parsed.find
            ? `${JSON.stringify(parsed.find)} -> ${JSON.stringify(parsed.replace)}`
            : parsed && parsed.unsure
              ? 'UNSURE'
              : 'no JSON') +
          (r.located.notLocated ? ' (parallel not located)' : ` (parallel ${r.located.via}, line ${r.located.line}, share ${r.located.share})`),
      );
      if (r.reply.usage) for (const k of Object.keys(usage)) usage[k] += r.reply.usage[k] || 0;
    }
    const same = JSON.stringify(rows[0].answer) === JSON.stringify(rows[1].answer);
    const sameReading = rows[0].accepted && rows[1].accepted && rows[0].accepted.replace === rows[1].accepted.replace;
    comparison = {
      token: item.token,
      narrow: rows[0].opts,
      generous: rows[1].opts,
      sameAnswer: same,
      sameReading: !!sameReading,
      rows,
    };
    console.log(
      `  narrow vs generous: ${same ? 'the SAME answer both ways' : `a DIFFERENT answer (${rows[0].accepted ? JSON.stringify(rows[0].accepted.replace) : 'none'} vs ${rows[1].accepted ? JSON.stringify(rows[1].accepted.replace) : 'none'})`}`,
    );
  }

  // WRITE AS YOU GO (the declarations stand before the loop): a final rewrite so
  // the artifact carries the comparison rows too, if any.
  const payload = { ...buildPayload(), ...(comparison ? { comparison } : {}) };
  const out = write(slug, payload);
  console.log(
    `\nlibrary repair: ${out.split('/').slice(-1)[0]} — ${proposals.length} proposal(s), ${unsure.length} unsure, ` +
      `${rejected.length} rejected, ${failed.length} failed\n` +
      `  context: ${payload.context.totalChars} characters sent in ${sent.length} request(s) ` +
      `(${payload.context.minChars}-${payload.context.maxChars}, mean ${payload.context.meanChars})\n` +
      `  tokens ${usage.prompt_tokens} in / ${usage.completion_tokens} out\n` +
      `  NOTHING WAS MERGED. The rules file is untouched.`,
  );
  return payload;
}

/* ---------- the self-test: the rejections are shown to be able to fail ---------- */

/** A proposal with no evidence is REJECTED — this is the proof, and it fails if
 * vetRepair ever starts passing an unevidenced entry through. */
function selfTestMain(prepared, parallel) {
  const token = prepared.leftWords[0] || prepared.unrepaired[0];
  const parallelText = parallel ? parallel.tokens.slice(0, 40).map((t) => t.raw).join(' ') : '';
  const cases = [
    {
      name: 'no evidence at all',
      p: { find: token, replace: 'x', class: 'reading', note: 'n', evidence: '' },
      expect: 'reject',
    },
    {
      name: 'evidence that does not contain the find',
      p: { find: token, replace: 'x', class: 'reading', note: 'n', evidence: 'OCR error, the word is obviously wrong here' },
      expect: 'reject',
    },
    {
      name: 'evidence that names the parallel without quoting it',
      p: { find: token, replace: 'x', class: 'reading', note: 'n', evidence: `the parallel edition confirms the reading for ${token} plainly` },
      expect: 'reject',
    },
    {
      name: 'right evidence, with a quoted line of the parallel',
      p: {
        find: token,
        replace: 'x',
        class: 'reading',
        note: 'n',
        evidence: `the transcription reads ${token}; the parallel reads ${parallelText}`,
      },
      expect: 'accept',
    },
  ];
  let bad = 0;
  for (const c of cases) {
    const v = vetRepair(c.p, {
      rawBody: prepared.rawBody,
      front: prepared.front,
      token,
      parallelText,
      taken: new Set(),
    });
    const got = v.reject ? 'reject' : 'accept';
    const ok = got === c.expect;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.name}: ${got}${v.reject ? ` (${v.reject})` : ''}`);
  }
  const noParallel = vetRepair(
    {
      find: token,
      replace: 'x',
      class: 'reading',
      note: 'n',
      evidence: `the transcription's own context decides it: ${token} reads as x here, plainly`,
    },
    { rawBody: prepared.rawBody, front: prepared.front, token, parallelText: '', taken: new Set() },
  );
  const okNoPar = !noParallel.reject;
  if (!okNoPar) bad++;
  console.log(
    `  ${okNoPar ? 'ok  ' : 'FAIL'} without a parallel passage the same evidence is accepted ` +
      `(the parallel-quote rule only applies when a parallel is supplied): ${noParallel.reject || 'accepted'}`,
  );
  const taken = vetRepair(cases[3].p, {
    rawBody: prepared.rawBody,
    front: prepared.front,
    token,
    parallelText: parallelText,
    taken: new Set([token]),
  });
  const okTaken = !!taken.reject;
  if (!okTaken) bad++;
  console.log(`  ${okTaken ? 'ok  ' : 'FAIL'} a find a recorded rule already matches exactly is rejected: ${taken.reject || 'ACCEPTED'}`);
  console.log(bad === 0 ? 'repair self-test: all assertions passed' : `repair self-test: ${bad} assertion(s) FAILED`);
  return { selfTest: bad === 0 };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((r) => {
      if (r && r.selfTest === false) process.exit(1);
      if (r && r.selfTest === true) process.exit(0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
