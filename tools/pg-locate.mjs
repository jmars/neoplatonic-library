#!/usr/bin/env node
/**
 * tools/pg-locate.mjs — place a passage of OUR text inside a RE-FLOWED witness,
 * and say what that witness reads at the disputed point. Or refuse.
 *
 *     node tools/pg-locate.mjs <slug> --what rules|open --out FILE [--type T] [--all] [--limit N] [--slide N]
 *     node tools/pg-locate.mjs <slug> --probe "TEXT"            an ad-hoc passage
 *     node tools/pg-locate.mjs <slug> --sweep [--window N --step N]
 *
 * `--slide N` is HOW FAR a bound may be slid off the damaged words nearest the
 * point before the point is given up on. It is a knob, not a constant, because it
 * is a trade: MEASURED over the 272 open questions, located is 54 at --slide 8,
 * 87 at 24 and 89 at 48, while the refusals move from "no bound within reach" to
 * "the bounds do not bracket the point". The table this tool reports is taken at
 * --slide 24; the numbers at 8 and 48 are in the same file.
 *
 * It is BATCHABLE, RESUMABLE and SCRIPT-DRIVEN: every placement is written to
 * the --out file as it is made and a re-run skips the points already in it, so a
 * killed run loses at most one point. The report is printed at the end of every
 * run, including one that had nothing left to do.
 *
 * WHY THIS TOOL EXISTS, AND WHY IT IS NOT tools/witness-unsure.mjs. That tool
 * places a passage by PAGE: it reads a copy's own `_djvu.xml`, takes the copy's
 * printed page, and puts its lines beside ours. A witness with no page model —
 * a re-flowed reading text, like the Project Gutenberg volumes of this same 1816
 * print (see tools/witness-import-pg.mjs) — has no page to fetch and no leaf to
 * name, so it cannot be used that way at all. What it has instead is WORDS in a
 * fixed order, and that is enough to place a passage exactly, without ever
 * counting a page:
 *
 *   THE DISCIPLINE IS THE LIBRARY'S OWN (tools/divisions-reanchor.mjs): a token
 *   run that occurs EXACTLY ONCE in the witness is a position; a run that occurs
 *   twice is nothing. A locator that takes the nearest of several matches
 *   manufactures false confirmations at scale, which is the failure this library
 *   treats as cardinal — so this one returns NOTHING when it cannot place a
 *   point, and says why.
 *
 * AND IT PLACES THE POINT, NOT MERELY THE NEIGHBOURHOOD. One unique run says
 * "these words are here"; it does not say how far the disputed word is from the
 * run's end, which differs between our text and a re-flowed one. So the point is
 * BOUNDED: a unique run to its LEFT and a unique run to its RIGHT, each required
 * to occur exactly once IN THE SAME VOLUME. What the witness reads between the
 * two is then the witness's own rendering of the disputed place, quoted
 * verbatim. If either bound fails to be unique, the point is NOT located.
 *
 * WHAT IT NORMALISES, AND WHAT IT THEREFORE CANNOT SETTLE. Our transcription and
 * PG are two readings of the same print by different instruments, so they differ
 * in everything that is not a word: case; the ligatures (æ/œ) and the long s;
 * diacritics; the print's own line-end hyphenation, which our transcription keeps
 * and PG joins; and every mark of punctuation, which is DISCARDED. So this tool
 * can settle a READING (which words are there) and can never settle a
 * PUNCTUATION question — the marks it compared are not in the comparison. It is
 * also blind to page, line, leaf, running head and hyphenation at line end: a
 * re-flowed text does not carry them.
 *
 * THE CONTEXT MUST BE CLEAN. A window that contains our residual garble
 * (`circnlation`, `beaven`) would match nothing or, worse, match loosely. Every
 * token of every fingerprint is therefore required to be a token of the print
 * that something else already reads cleanly — a dictionary word, or a word some
 * witness of this print carries — and a run that fails that test is not tried,
 * it is slid outward until a clean run is found. The garble itself is never
 * quietly tolerated in a fingerprint.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('-')) || 'proclus-theology-of-plato-taylor-1816';
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const num = (name, dflt) => {
  const v = Number(opt(name, ''));
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const EDITION = join(ROOT, 'data', 'editions', slug);
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'neoplatonic-library');
const SCRATCH = join('/var/tmp', 'pg-locate');

/* ---------- the token stream: one definition, used for every text here ------- */

/** The ligatures and the long s. MEASURED on this print: PG writes `æ` and our
 * transcription writes `ae` in the same word, and the 1816 fount's long s (`ſ`)
 * is transcribed both ways. None of that is a disagreement about what the print
 * says. */
const LIGATURES = new Map([
  ['æ', 'ae'], ['œ', 'oe'], ['ß', 'ss'], ['ſ', 's'], ['ﬁ', 'fi'], ['ﬂ', 'fl'], ['ﬀ', 'ff'],
  ['ﬃ', 'ffi'], ['ﬄ', 'ffl'], ['ﬅ', 'st'], ['ﬆ', 'st'], ['ĳ', 'ij'],
]);
/** A HYPHEN IS A JOINER, A DASH IS NOT: `super-celestial` and `supercelestial`
 * are the same token to this tool, while `word—word` is two. The en and em dash
 * (what PG and our OCR both use for the print's dash) separate; two or more
 * hyphens in a row are PG's own em dash and separate too. */
const HYPHEN = new Set(['-', '\u2010', '\u2011']); // hyphen, hyphen, non-breaking hyphen
/** THE LINE-END HYPHEN IS NOT ALWAYS A HYPHEN. MEASURED on this edition's own
 * source.txt: the transcription writes the print's line-end hyphen as `¬`
 * (U+00AC, NOT SIGN) — 2,120 of them, and EVERY one of the 2,120 is the last
 * non-space character on its line, so the glyph has no other job here. The same
 * measurement over the 2,629 line ends that break before a lowercase word gives
 * `¬` 2,119 times, `-` 241, and `*` 162 — and `*` is this transcription's DAMAGE
 * character, a missing letter, not a hyphen, so it is deliberately NOT a joiner:
 * joining on it would weld two words that the print keeps apart. The rare
 * stragglers (`]`, `^`, `«`) are left alone for the same reason. */
const LINE_JOIN = new Set([...HYPHEN, '\u00ac']);
/** THE TRANSCRIPTION'S DAMAGE CHARACTERS, taken from the edition's OWN recorded
 * set (`versions/1.0.3/base.json` `damage`: ^ _ ~ * / £ > \ | # ™ ± » « } { &),
 * MEASURED by this library, not guessed here. They stand for a LETTER THE SCAN
 * LOST. A rule's `before` is written in them — `& whole`, `.triadic`, `&
 * suspended` — so a tokeniser that simply drops them reads `before` as a
 * SUBSET of `after`, and then "is our old reading at this point in the witness?"
 * answers yes for the commonest word in the difference and the witness is
 * recorded as supporting a reading it never carried. They are therefore kept, as
 * one `@` token per run of them: `@` can never occur in a re-flowed witness, so
 * a rule that RESOLVES damage can only ever be confirmed by the witness reading
 * our `after`, which is what it means. */
const DAMAGE = new Set('^_~*/\u00a3>\\|#\u2122\u00b1\u00bb\u00ab}{&');
const isAlnum = (c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');

/** Fold a text to the alphabet the comparison runs on, and keep, for every
 * folded character, the index of the RAW character it came from — so a span in
 * the raw text can be named as a span in the token stream and back. */
function fold(raw) {
  const out = [];
  const at = [];
  for (let i = 0; i < raw.length; i += 1) {
    const cc = raw.charCodeAt(i);
    if (cc === 0x00ad) continue; // a soft hyphen is not on the print
    if (cc < 128) {
      out.push(cc >= 65 && cc <= 90 ? String.fromCharCode(cc + 32) : raw[i]);
      at.push(i);
      continue;
    }
    const c = raw[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase();
    const piece = LIGATURES.has(c) ? LIGATURES.get(c) : c;
    for (const ch of piece) {
      out.push(ch);
      at.push(i);
    }
  }
  return { s: out.join(''), at };
}

/** Tokens with the raw character span each one covers. A token is a run of
 * letters/digits that a joiner hyphen (or a hyphen at END OF LINE, which is the
 * print's own hyphenation and the reason PG and our transcription disagree about
 * spaces) carries on across the fold. */
function tokenize(raw, damage = null) {
  const { s, at } = fold(raw);
  const toks = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    if (!isAlnum(s[i])) {
      if (damage && damage.has(s[i])) {
        let k = i + 1;
        while (k < n && damage.has(s[k])) k += 1;
        toks.push({ t: '@', a: at[i], b: at[k - 1] + 1 });
        i = k;
        continue;
      }
      i += 1;
      continue;
    }
    const start = i;
    let j = i + 1;
    while (j < n) {
      if (isAlnum(s[j])) {
        j += 1;
        continue;
      }
      if (!LINE_JOIN.has(s[j])) break;
      let k = j;
      while (k < n && HYPHEN.has(s[k])) k += 1;
      if (k - j >= 2) break; // the print's dash, not a joiner
      // the mark here may be `¬`, which the loop above does not consume: step over it
      if (k === j) k = j + 1;
      if (k < n && isAlnum(s[k])) {
        j = k;
        continue;
      }
      // the fold keeps the line break, so a line-end hyphen is visible here
      let m = k;
      let newline = false;
      while (m < n && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n' || s[m] === '\r')) {
        if (s[m] === '\n') newline = true;
        m += 1;
      }
      if (newline && m < n && isAlnum(s[m])) {
        j = m;
        continue;
      }
      break;
    }
    toks.push({ t: s.slice(start, j).replace(/[^a-z0-9]/g, ''), a: at[start], b: at[j - 1] + 1 });
    i = j;
  }
  return toks;
}

/* ---------- the witnesses: the re-flowed volumes, and the print's vocabulary -- */

const witRec = JSON.parse(readFileSync(join(EDITION, 'witnesses.json'), 'utf8'));
/** A re-flowed volume is a witness record with `source.ebook` and NO `model`:
 * the record itself says which shape it is (tools/witness-import-pg.mjs), so
 * this tool never guesses from a filename. */
const VOLS = (witRec.witnesses || [])
  .filter((w) => w.source && w.source.ebook && !w.model)
  .sort((a, b) => a.source.ebook - b.source.ebook)
  .map((w) => ({ id: `vol${w.source.ebook === 77393 ? '1' : '2'}`, rec: w, file: join(EDITION, 'witnesses', `${w.name}.txt`) }));
if (!VOLS.length) {
  console.error(`pg-locate: ${slug} holds no re-flowed witness — import one with tools/witness-import-pg.mjs`);
  process.exit(2);
}

/** The token stream of a volume is 2.5 MB of string work, so it is CACHED under
 * the record's own sha256 of the stored file: a witness that changes has another
 * key and the cache cannot go stale behind it. */
function volumeTokens(vol) {
  mkdirSync(SCRATCH, { recursive: true });
  const key = join(SCRATCH, `${slug}-${vol.rec.sha256.slice(0, 12)}-${vol.id}.tokens.json`);
  if (existsSync(key)) return JSON.parse(readFileSync(key, 'utf8'));
  const toks = tokenize(readFileSync(vol.file, 'utf8')).map((t) => t.t);
  writeFileSync(key, JSON.stringify(toks));
  return toks;
}
for (const v of VOLS) {
  v.tokens = volumeTokens(v);
  v.index = new Map();
  v.tokens.forEach((t, i) => {
    const p = v.index.get(t);
    if (p) p.push(i);
    else v.index.set(t, [i]);
  });
  v.words = new Set(v.tokens);
}

/** THE CLEAN TEST. A fingerprint token must be a word this print is known to
 * carry: a dictionary word, or a token some witness of this print carries. Our
 * garble is in neither, which is the point — `circnlation` and `beaven` fail
 * this test and are slid out of every fingerprint rather than matched loosely. */
const health = (() => {
  const key = join(SCRATCH, `${slug}-health.json`);
  const wkey = createHash('sha256').update(JSON.stringify((witRec.witnesses || []).map((w) => w.sha256))).digest('hex').slice(0, 12);
  if (existsSync(key)) {
    const j = JSON.parse(readFileSync(key, 'utf8'));
    if (j.witnesses === wkey) return new Set(j.words);
  }
  const set = new Set();
  const dict = join(CACHE, 'words.txt');
  if (existsSync(dict)) for (const w of readFileSync(dict, 'utf8').split('\n')) if (/^[a-z]{2,}$/.test(w)) set.add(w);
  for (const w of witRec.witnesses || []) {
    const p = join(EDITION, 'witnesses', `${w.name}.txt`);
    if (!existsSync(p)) continue;
    for (const t of tokenize(readFileSync(p, 'utf8'))) if (t.t.length > 1) set.add(t.t);
  }
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(key, JSON.stringify({ witnesses: wkey, words: [...set] }));
  return set;
})();
const healthy = (t) => t.length > 1 && /^[a-z]+$/.test(t) && health.has(t);

/** Every occurrence of a token run in a volume, capped: the caller only ever
 * needs to know 0, 1, or "more than one", and the cap is recorded. */
const CAP = 33;
function occurrences(vol, run) {
  if (!run.length) return [];
  let pivot = 0;
  let best = null;
  for (let i = 0; i < run.length; i += 1) {
    const p = vol.index.get(run[i]);
    if (!p) return []; // ALWAYS an array: a caller that reads `.length` of the not-found case must see 0
    if (best === null || p.length < best.length) {
      best = p;
      pivot = i;
    }
  }
  const hits = [];
  for (const p of best) {
    const start = p - pivot;
    if (start < 0) continue;
    let ok = true;
    for (let k = 0; k < run.length; k += 1) {
      if (vol.tokens[start + k] !== run[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      hits.push(start);
      if (hits.length >= CAP) break;
    }
  }
  return hits;
}

/* ---------- placing one point ------------------------------------------------ */

const MAX_SLIDE = num('slide', 8); // how far a fingerprint may be slid off the damaged words nearest the point
const WIDTHS = [12, 10, 8, 7, 6, 5];

/** Fingerprint one side of a point, SLIDING OUTWARD past anything unclean.
 * `at` is the token index the point starts at (left side) or ends at (right):
 * the fingerprint's near edge is held as close to it as the attempted slide
 * allows, and a run is accepted only when it occurs EXACTLY ONCE in some
 * volume. ALL such runs are returned, nearest first — a bound that turns out not
 * to bracket the point can then be dropped for the next one, rather than
 * condemning the point. The attempt trace is returned with them, so a refusal
 * can be audited. */
function fingerprint(tokens, side, at, volumes) {
  const trace = [];
  const tally = { tried: 0, unclean: 0, absent: 0, ambiguous: 0 };
  const found = [];
  for (let slide = 0; slide <= MAX_SLIDE; slide += 1) {
    for (const w of WIDTHS) {
      const lo = side === 'left' ? at - w - slide : at + slide;
      const hi = side === 'left' ? at - slide : at + slide + w;
      if (lo < 0 || hi > tokens.length) continue;
      const run = tokens.slice(lo, hi).map((t) => t.t);
      tally.tried += 1;
      if (!run.every(healthy)) {
        tally.unclean += 1;
        trace.push({ slide, w, why: 'unclean', tokens: run.join(' ') });
        continue;
      }
      const occ = {};
      const ats = {};
      for (const v of volumes) {
        const hits = occurrences(v, run);
        occ[v.id] = hits.length;
        if (hits.length === 1) ats[v.id] = hits[0];
      }
      trace.push({ slide, w, occ, tokens: run.join(' ') });
      if (Object.keys(ats).length) {
        found.push({ run, w, slide, occ, at: ats });
        if (found.length >= 6) return { found, trace, tally };
      }
      // a run that occurs nowhere cannot occur when long: stop widening the gap
      if (Object.values(occ).every((n) => n === 0)) {
        tally.absent += 1;
        break;
      }
      // a run that occurs more than once cannot occur once when shortened: stop
      if (Object.values(occ).every((n) => n !== 1)) {
        tally.ambiguous += 1;
        break;
      }
    }
  }
  return { found, trace, tally };
}

/** Place the token span [s0,s1) of `tokens` in the re-flowed volumes.
 *
 * THE GUARD THAT MAKES A PLACEMENT A PLACEMENT. Unique bounds are necessary and
 * not sufficient: MEASURED on this text, a pair of runs can each occur exactly
 * once in vol. I at positions a hundred thousand tokens apart while standing a
 * few words apart in ours — the stretch the witness then reads "between" them is
 * the entire volume, which is not a placement of anything. So the witness's
 * stretch must be the size ours is, allowing for the words the bounds were slid
 * over and for the few words the two transcriptions genuinely differ by. That
 * `excess` is measured and reported, and a combination that blows it is
 * DISCARDED and the next bound tried; if no combination holds, the point is
 * refused rather than placed badly. */
function place(tokens, s0, s1, volumes) {
  const ours = tokens.slice(s0, s1).map((t) => t.t);
  const left = fingerprint(tokens, 'left', s0, volumes);
  const right = fingerprint(tokens, 'right', s1, volumes);
  const out = {
    status: null,
    volume: null,
    ours: { n: ours.length, tokens: ours.slice(0, 24), truncated: ours.length > 24 },
  };
  if (!left.found.length || !right.found.length) {
    out.status = 'refused-no-anchor';
    out.left = summarise(left);
    out.right = summarise(right);
    out.why = !left.found.length && !right.found.length ? 'neither side' : !left.found.length ? 'left side' : 'right side';
    return out;
  }
  const combos = [];
  for (const L of left.found)
    for (const R of right.found) {
      // the volume must be one where BOTH bounds occur exactly once
      const vols = volumes.filter((v) => L.at[v.id] !== undefined && R.at[v.id] !== undefined);
      for (const v of vols) {
        const a = L.at[v.id] + L.run.length;
        const b = R.at[v.id];
        const window = b - a;
        const slid = L.slide + R.slide;
        const expected = ours.length + slid;
        const excess = window - expected;
        const limit = Math.round(0.35 * expected) + 8;
        combos.push({
          v,
          L,
          R,
          a,
          b,
          window,
          excess,
          limit,
          ok: b >= a && Math.abs(excess) <= limit,
          why: b < a ? 'the two bounds stand in the wrong order' : Math.abs(excess) > limit ? `the witness reads ${window} words between the bounds where we read ${expected} — it does not place this point` : null,
        });
      }
    }
  combos.sort((x, y) => (x.ok === y.ok ? 0 : x.ok ? -1 : 1) || x.L.slide + x.R.slide - (y.L.slide + y.R.slide) || Math.abs(x.excess) - Math.abs(y.excess));
  out.combinations = combos.length;
  out.tried = combos.slice(0, 6).map((c) => ({ volume: c.v.id, slide: c.L.slide + c.R.slide, window: c.window, expected: ours.length + c.L.slide + c.R.slide, excess: c.excess, why: c.why }));
  const pick = combos.find((c) => c.ok);
  if (!pick) {
    out.left = summarise(left);
    out.right = summarise(right);
    const byOrder = combos.some((c) => c.b < c.a);
    out.status = !combos.length ? 'refused-no-shared-volume' : byOrder ? 'refused-overlap' : 'refused-divergent';
    out.why = combos.length
      ? 'every pair of bounds that is unique in a volume reads the wrong amount of text between them'
      : 'each side has a unique run, but no single volume holds both of them exactly once';
    return out;
  }
  const v = pick.v;
  const span = v.tokens.slice(pick.a, pick.b);
  out.status = 'located';
  out.volume = v.id;
  /* HOW FAR THE BOUNDS HAD TO BE SLID OFF THE POINT. A tight placement keeps
   * both bounds hard against the point; a slid one means the words nearest the
   * point are unclean in our text, so the witness's stretch between the bounds
   * carries words that are not the disputed ones. MEASURED and reported, because
   * the yield is not one number. */
  out.tight = pick.L.slide === 0 && pick.R.slide === 0;
  out.slide = { left: pick.L.slide, right: pick.R.slide };
  out.left = { tokens: pick.L.run.join(' '), w: pick.L.w, slide: pick.L.slide, occurred: pick.L.occ, at: pick.L.at[v.id] };
  out.right = { tokens: pick.R.run.join(' '), w: pick.R.w, slide: pick.R.slide, occurred: pick.R.occ, at: pick.R.at[v.id] };
  out.pg = {
    n: span.length,
    delta_tokens: span.length - ours.length,
    excess: pick.excess,
    tokens: span.slice(0, 60),
    truncated: span.length > 60,
  };
  out.at = pick.a;
  const from = Math.max(0, pick.a - 8);
  const to = Math.min(v.tokens.length, pick.b + 8);
  out.quote = v.tokens.slice(from, to).join(' ');
  out.quote_note = 'the witness’s own tokens, 8 either side of the placed span — re-flowed, so the line breaks are not the print’s';
  return out;
}
function summarise(f) {
  return f.run
    ? { tokens: f.run.join(' '), w: f.w, slide: f.slide, occurred: f.occ, at: f.at }
    : { tokens: null, attempts: f.trace ? f.trace.slice(-4) : null, attempts_total: f.tally ? f.tally : null, why: 'no clean run on this side occurred exactly once' };
}

/* ---------- what the witness decides about a rule ---------------------------- */

/** The tokens a rule CHANGES, as against the words around it. `before` and
 * `after` cover the same stretch of text; the changed block is what the rule is
 * about, and the words around it are not. Aligned by longest common subsequence,
 * because the two are not always the same length — a rule may insert or drop a
 * word, and then one side's changed block is legitimately EMPTY (`& whole` ->
 * `a whole` removes nothing). An empty side is a measurement, not a failure, and
 * it is left empty rather than refilled with the whole reading. */
function changedBlock(before, after) {
  const a = tokenize(before, DAMAGE).map((t) => t.t);
  const b = tokenize(after, DAMAGE).map((t) => t.t);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const coreBefore = [];
  const coreAfter = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[i][j + 1] >= dp[i + 1][j]) {
      coreAfter.push(b[j]);
      j += 1;
    } else {
      coreBefore.push(a[i]);
      i += 1;
    }
  }
  while (i < n) coreBefore.push(a[i++]);
  while (j < m) coreAfter.push(b[j++]);
  return { a, b, coreBefore, coreAfter };
}

/** Whether the witness at the placed point carries the rule's `after` reading,
 * its `before` reading, both, or neither.
 *
 * THE TEST IS NOT "IS THE CHANGED WORD THERE". It was, and it was WRONG in two
 * separate ways, both MEASURED on this edition's 2,238 review-flagged rules. (1)
 * `before` is written in the transcription's damage characters, so dropping them
 * left `before` a SUBSET of `after` — `& whole` read as `whole` — and the witness
 * was recorded as supporting our damaged reading for 22 rules at once. (2) When a
 * rule INSERTS a word, `before` is a token-subsequence of `after` and any witness
 * carrying the inserted reading carries the old one too, so "both" or the wrong
 * one came back; the test therefore asks which WHOLE reading the witness carries,
 * and where both are present prefers the LONGER, which can only be present if the
 * witness really has the extra words. Only if neither whole reading is there does
 * it fall back to the changed words, and it says which test decided.
 *
 * The search runs over the witness's own tokens with a slack of DECIDE_SLACK
 * either side of the placed span, because a re-flowed text may put a word of its
 * own where ours has none. */
const DECIDE_SLACK = 2;
function decide(rule, placed, vols) {
  const vol = vols.find((v) => v.id === placed.volume);
  if (!vol || placed.status !== 'located') return { verdict: 'not-located' };
  if (rule.after == null || /^unsure$/i.test(String(rule.after).trim()))
    return { verdict: 'silent', why: 'the rule’s own `after` is not a reading (`unsure`)' };
  if (rule.before === rule.after) return { verdict: 'no-change', why: 'the rule changes no mark' };
  const a = tokenize(rule.before, DAMAGE).map((t) => t.t);
  const b = tokenize(rule.after, DAMAGE).map((t) => t.t);
  /* A MARK-ONLY RULE CANNOT BE DECIDED HERE, and calling it "both" would hide
   * that. MEASURED: 122 of the rules this tool called "both" at slide 24 were
   * rules whose two readings are the SAME WORDS — a stray period, a capital
   * letter, a dropped apostrophe — because the token run a re-flowed witness is
   * compared on does not carry marks at all, so both "readings" are that one run
   * and both are found. They are reported as silent, with the reason. */
  if (a.join(' ') === b.join(' ')) {
    return {
      verdict: 'silent',
      basis: 'the two readings are the same WORDS — the change is to MARKS or case',
      why: 'a re-flowed witness carries no punctuation and no case, so this rule is UNDECIDABLE from it even when the passage is located',
    };
  }
  /* THE WINDOW IS THE WHOLE PLACED STRETCH, plus a slack of the few words the
   * two transcriptions differ by at the edges. It is bounded by the divergence
   * guard, so it cannot be absurdly large. */
  const from = Math.max(0, placed.at - DECIDE_SLACK);
  const to = Math.min(vol.tokens.length, placed.at + (placed.pg ? placed.pg.n : 0) + DECIDE_SLACK);
  const window = vol.tokens.slice(from, to);
  const win = { tokens: window, index: indexOf(window) };
  const has = (run) => run.length > 0 && occurrences(win, run).length > 0;
  let inBefore = has(a);
  let inAfter = has(b);
  let basis = 'the whole reading';
  if (!inBefore && !inAfter) {
    const cores = changedBlock(rule.before, rule.after);
    basis = 'the changed words';
    if (cores.coreBefore.join(' ') === cores.coreAfter.join(' ') || (!cores.coreBefore.length && !cores.coreAfter.length)) {
      return {
        verdict: 'silent',
        basis: 'neither — the two readings differ in MARKS only',
        why: 'the rule changes no WORD, and a re-flowed witness carries no marks to compare',
        window: window.join(' '),
      };
    }
    /* THE FALLBACK IS POSITIONAL: the changed words are looked for in the placed
     * stretch ITSELF, with no slack. A single-word core — which is what a rule
     * that resolves a damage character to a letter has — is one of the commonest
     * words in the language, and MEASURED, testing it anywhere in a window padded
     * by the slack confirms `& whole` -> `a whole` at a place where the witness
     * reads `the whole`. Inside the placed stretch it has to be the word AT the
     * point. The stretch is bounded by the divergence guard, so it stays short. */
    const exact = vol.tokens.slice(placed.at, placed.at + (placed.pg ? placed.pg.n : 0));
    const exactWin = { tokens: exact, index: indexOf(exact) };
    const inExact = (run) => run.length > 0 && occurrences(exactWin, run).length > 0;
    inBefore = inExact(cores.coreBefore);
    inAfter = inExact(cores.coreAfter);
    basis = 'the changed words, in the placed stretch itself';
  }
  const verdict =
    inAfter && inBefore ? (b.length > a.length ? 'after' : b.length < a.length ? 'before' : 'both') : inAfter ? 'after' : inBefore ? 'before' : 'silent';
  return {
    verdict,
    basis,
    before_words: a.length,
    after_words: b.length,
    window: window.join(' '),
    why:
      verdict === 'silent'
        ? 'the witness reads neither of the rule’s two forms at this point'
        : verdict === 'both'
          ? 'the witness carries both readings in the window and they are the same length — it does not decide'
          : `the witness carries the rule’s \`${verdict}\` reading at this point (tested on ${basis})`,
  };
}
const indexOf = (toks) => {
  const m = new Map();
  toks.forEach((t, i) => {
    const p = m.get(t);
    if (p) p.push(i);
    else m.set(t, [i]);
  });
  return m;
};

/* ---------- the drivers ------------------------------------------------------ */

const OUT = opt('out', join(SCRATCH, `${slug}.${opt('what', 'probe')}.locate.json`));
const resume = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const doc = resume || {
  slug,
  tool: 'tools/pg-locate.mjs',
  method:
    'each point is bounded by a token run that occurs EXACTLY ONCE in a volume on its left and another on its ' +
    'right; the witness’s own tokens between the two bounds are what it reads at the point. A point with no ' +
    'unique bound, two candidate volumes, or bounds in the wrong order is REFUSED, never guessed.',
  normalised: 'case; ligatures æ/œ and the long s; diacritics; the print’s own line-end hyphenation; ALL punctuation (discarded)',
  blind_to: 'page, printed page number, leaf, line, running head, hyphenation at line end, punctuation, capitalisation',
  volumes: [],
  points: [],
};
doc.volumes = VOLS.map((v) => ({
  id: v.id,
  ebook: v.rec.source.ebook,
  name: v.rec.name,
  sha256: v.rec.sha256,
  bytes: v.rec.bytes,
  tokens: v.tokens.length,
  form: 're-flowed (no page model): word-level only',
}));

const done = new Set((doc.points || []).map((p) => p.id));
const push = (p) => {
  doc.points.push(p);
  done.add(p.id);
};
const what = opt('what', args.includes('--probe') ? 'probe' : 'rules');

if (args.includes('--probe')) {
  const text = opt('probe', '');
  const toks = tokenize(text, DAMAGE);
  if (toks.length < 12) {
    console.error('pg-locate: --probe needs a passage of at least 12 words');
    process.exit(2);
  }
  // the point is the middle third of the passage; the outer thirds are its bounds
  const s0 = Math.floor(toks.length / 3);
  const s1 = Math.floor((2 * toks.length) / 3);
  const placed = place(toks, s0, s1, VOLS);
  console.log(JSON.stringify({ probe: text, span: toks.slice(s0, s1).map((t) => t.t).join(' '), ...placed }, null, 2));
  process.exit(placed.status === 'located' ? 0 : 1);
}

if (!['rules', 'open'].includes(what)) {
  console.error('usage: node tools/pg-locate.mjs <slug> --what rules|open|probe --out FILE [--type T] [--limit N]');
  process.exit(2);
}

/** The source is where a rule’s or a question’s text is found: the `find` of a
 * rule and the `passage` of a question are BOTH spans of the served version’s
 * own source.txt, so the point is named by an offset into our text and not by a
 * page this tool cannot read. Found as an exact substring first, and as a token
 * run second (the full read recorded some passages with the line’s own spacing
 * changed); anything not found in our own source is refused as `not-our-text`,
 * which is a fact about the FINDING, not about the witness. */
const SRC = readFileSync(join(EDITION, 'versions', '1.0.3', 'source.txt'), 'utf8');
/* OUR text is tokenised WITH the damage characters (see DAMAGE): a rule's
 * `before` is written in them, and dropping them makes the witness look as if
 * it carries our damaged reading. A re-flowed witness is tokenised without them:
 * it has no damage characters, and `@` is what our side alone can utter. */
const SRCTOK = tokenize(SRC, DAMAGE);
const SRCTOKS = SRCTOK.map((t) => t.t);
const SRCINDEX = indexOf(SRCTOKS);
function spanOf(text) {
  if (!text || !text.trim()) return { none: 'the recorded text is empty' };
  const i = SRC.indexOf(text);
  if (i >= 0 && SRC.indexOf(text, i + 1) < 0) return { start: i, end: i + text.length, how: 'exact substring (unique in source.txt)' };
  const want = tokenize(text, DAMAGE).map((t) => t.t);
  if (want.length < 2) return { none: `the recorded text is ${want.length} word(s) — too short a fragment for the tokeniser to place in our own source` };
  const hits = occurrences({ tokens: SRCTOKS, index: SRCINDEX }, want);
  if (hits.length !== 1) {
    return {
      none:
        hits.length === 0
          ? `the recorded text (${want.length} words) is NOT in source.txt at all`
          : `the recorded text occurs ${hits.length >= CAP ? `${CAP}+` : hits.length} times in our OWN source.txt — a match that is not unique is not a match`,
    };
  }
  const s0 = hits[0];
  return { s0, s1: s0 + want.length, how: `token run, unique in source.txt (${want.length} tokens)` };
}
function pointFrom(text, id, meta) {
  const span = spanOf(text);
  if (span.none) {
    /* NOT PLACEABLE IN OUR OWN SOURCE. It happens, and it is a fact about the
     * FINDING, not about the witness: the full read recorded some passages from
     * the REPAIRED reading (`Rut` -> `But`, a rule's own work), which is not the
     * bytes of source.txt, and a rule's `find` may be a fragment that occurs on
     * more than one line of our own text. Such a passage can still be placed by
     * its OWN ends — the bounds then sit inside the passage instead of beside it,
     * and the witness's stretch between them is its reading of the middle of the
     * passage. Which placement was used is recorded. */
    const toks = tokenize(text, DAMAGE);
    if (toks.length < 15) {
      return { id, ...meta, status: 'refused-not-our-text', why: `${span.none}, and it is too short to bound by its own ends` };
    }
    const s0 = Math.floor(toks.length / 3);
    const s1 = Math.floor((2 * toks.length) / 3);
    return { id, ...meta, ...place(toks, s0, s1, VOLS), found: `passage-only: ${span.none}; bounded by its own ends instead` };
  }
  let s0;
  let s1;
  if (span.s0 !== undefined) {
    s0 = span.s0;
    s1 = span.s1;
  } else {
    s0 = SRCTOK.findIndex((t) => t.b > span.start);
    let k = SRCTOK.length - 1;
    while (k > 0 && SRCTOK[k].a >= span.end) k -= 1;
    s1 = k + 1;
  }
  const placed = place(SRCTOK, s0, s1, VOLS);
  return { id, ...meta, ...placed, found: span.how, source_offset: span.start ?? null, source_token: s0 };
}

if (args.includes('--sweep')) {
  /* A CROSS-CHECK OF THE BRIEF'S OWN CLAIM, on its own terms: take clean ten-word
   * windows of OUR text at a stride and ask each volume, once, whether that
   * window occurs in it — and how many times. This is a WEAKER test than placing
   * a point (it needs one unique run, not two bracketing one, and it is taken
   * from wherever the stride lands), so it is the CEILING a point locator could
   * reach, not the yield of the locator itself. */
  const W = num('window', 10);
  const step = num('step', 25);
  const rows = [];
  for (let i = 0; i + W <= SRCTOKS.length; i += step) {
    const run = SRCTOKS.slice(i, i + W);
    const ok = run.every(healthy);
    if (!ok) continue;
    const occ = {};
    for (const v of VOLS) occ[v.id] = Math.min(occurrences(v, run).length, CAP);
    rows.push({ i, occ, run: run.join(' ') });
  }
  const one = (o) => Object.entries(o).filter(([, n]) => n === 1).map(([k]) => k);
  const cls = (o) => {
    const u = one(o);
    if (u.length === 1) return `unique in ${u[0]}`;
    if (u.length === 2) return 'unique in both';
    if (u.length === 0 && Object.values(o).every((n) => n === 0)) return 'in neither volume';
    return 'in some volume more than once';
  };
  const t = new Map();
  for (const r of rows) t.set(cls(r.occ), (t.get(cls(r.occ)) || 0) + 1);
  console.log(`clean ${W}-word windows of our text, every ${step}th token: ${rows.length}`);
  for (const [k, n] of [...t.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n} (${((100 * n) / rows.length).toFixed(1)}%)`);
  const inV1 = rows.filter((r) => cls(r.occ) === 'unique in vol1').length;
  const inV2 = rows.filter((r) => cls(r.occ) === 'unique in vol2').length;
  console.log(`  a window unique in exactly one volume: ${inV1 + inV2} of ${rows.length} (${(((inV1 + inV2) * 100) / rows.length).toFixed(1)}%) — vol1 ${inV1}, vol2 ${inV2}`);
  /* where our text crosses from one volume to the other, MEASURED from the
   * windows themselves rather than assumed: the last token of our text that is
   * unique in vol. I and the first that is unique in vol. II. */
  const lastV1 = Math.max(...rows.filter((r) => cls(r.occ) === 'unique in vol1').map((r) => r.i));
  const firstV2 = Math.min(...rows.filter((r) => cls(r.occ) === 'unique in vol2').map((r) => r.i));
  console.log(`  our token ${lastV1} is the last unique-in-vol1 window start and token ${firstV2} the first unique-in-vol2 one (${SRCTOKS.length} tokens in source.txt)`);
  const out = opt('out', join(SCRATCH, `${slug}.sweep.json`));
  writeFileSync(out, `${JSON.stringify({ slug, window: W, step, tokens: SRCTOKS.length, rows }, null, 1)}\n`);
  console.log(`wrote ${out}`);
  process.exit(0);
}

const limit = num('limit', Infinity);
const typeFilter = opt('type', '');

if (what === 'rules') {
  const file = join(EDITION, 'versions', '1.0.3', 'repairs.json');
  const all = JSON.parse(readFileSync(file, 'utf8')).rules;
  const list = all.filter((r) => (args.includes('--all') ? true : r.review === true)).filter((r) => !typeFilter || r.type === typeFilter);
  let n = 0;
  for (const r of list) {
    if (done.has(r.id)) continue;
    if (n >= limit) break;
    n += 1;
    const text = r.location && r.location.find ? r.location.find : r.before;
    const p = pointFrom(text, r.id, { what: 'rule', type: r.type, review: r.review, before: r.before, after: r.after, fires: r.fires });
    p.decide = decide(r, p, VOLS);
    push(p);
    if (n % 100 === 0) {
      writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`);
      console.error(`  … ${n} of ${list.length}`);
    }
  }
} else {
  const file = join(ROOT, 'tools', 'edits', `${slug}.unsure-findings.json`);
  const list = JSON.parse(readFileSync(file, 'utf8')).open;
  let n = 0;
  for (let i = 0; i < list.length; i += 1) {
    const q = list[i];
    const id = `open[${i}] ${q.leaf}: ${(q.passage || '').slice(0, 40)}`;
    if (done.has(id)) continue;
    if (n >= limit) break;
    n += 1;
    push(pointFrom(q.passage, id, { what: 'open', leaf: q.leaf, leaves: q.leaves || null, page: q.page, region: q.region, passage: q.passage, unsure_why: q.why }));
    if (n % 50 === 0) {
      writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`);
      console.error(`  … ${n} of ${list.length}`);
    }
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`);

/* ---------- the report ------------------------------------------------------- */

const tally = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const pts = doc.points;
const located = pts.filter((p) => p.status === 'located');
console.log(`\npoints ${pts.length} — located ${located.length} (${((100 * located.length) / (pts.length || 1)).toFixed(1)}%)`);
console.log('status    ' + tally(pts, (p) => p.status).map(([k, n]) => `${k} ${n}`).join(' · '));
console.log('by volume ' + tally(located, (p) => p.volume).map(([k, n]) => `${k} ${n}`).join(' · '));
console.log(
  'tightness ' +
    tally(located, (p) => (p.tight ? 'both bounds hard against the point' : 'a bound slid off the damaged words')).map(([k, n]) => `${k} ${n}`).join(' · '),
);
const byType = {};
for (const p of pts) {
  const t = p.type || p.what;
  byType[t] = byType[t] || { n: 0, located: 0, vol1: 0, vol2: 0 };
  byType[t].n += 1;
  if (p.status === 'located') {
    byType[t].located += 1;
    byType[t][p.volume] += 1;
  }
}
for (const [t, v] of Object.entries(byType)) console.log(`  ${t.padEnd(16)} ${v.located}/${v.n} located (vol1 ${v.vol1}, vol2 ${v.vol2})`);
const withVerdict = pts.filter((p) => p.decide);
if (withVerdict.length) {
  console.log('decisions on the located rules:');
  for (const [k, n] of tally(withVerdict.filter((p) => p.status === 'located'), (p) => p.decide.verdict)) console.log(`  ${k} ${n}`);
}
{
  const cause = { unclean: 0, absent: 0, ambiguous: 0, sides: 0 };
  for (const p of pts) {
    if (p.status !== 'refused-no-anchor') continue;
    for (const side of ['left', 'right']) {
      const t = p[side] && p[side].attempts_total;
      if (!t || p[side].tokens) continue;
      cause.sides += 1;
      cause.unclean += t.unclean;
      cause.absent += t.absent;
      cause.ambiguous += t.ambiguous;
    }
  }
  if (cause.sides) {
    console.log(
      `refusals with no bound, by cause over the ${cause.sides} failing sides: ` +
        `${((100 * cause.unclean) / (cause.unclean + cause.absent + cause.ambiguous)).toFixed(0)}% of attempts were on UNCLEAN tokens, ` +
        `${cause.absent} attempts found no run in the volume at all, ${cause.ambiguous} found the run more than once`,
    );
  }
}
console.log(`\nwrote ${OUT}`);
