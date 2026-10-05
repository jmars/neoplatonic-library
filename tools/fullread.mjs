#!/usr/bin/env node
/**
 * tools/fullread.mjs — the WHOLE-TEXT read the census cannot do.
 *
 * WHY THIS EXISTS. The author read the published text and reported "a fair
 * amount of damage", and the build's own `leftVisible` count answered 2. The
 * MEASURED gap between those two numbers is the instrument, not the author:
 *
 *   - `damageCensus` (extract.mjs) counted a damage character standing INSIDE
 *     a word, in the BODY, with no rule naming it. It was blind to (a) a rule
 *     that HALF-repaired a word — the marker consumed, the word left wrong
 *     (MEASURED in the reading view: `jwjth water`, `\4 darkand obscure`,
 *     `iThrough matter`, `\ But he is placed`, `sus pected`), (b) a wrong word
 *     with NO damage character at all — a substituted or missing letter is
 *     invisible to a character census by construction, and (c) everything in
 *     the NOTES and the back-matter regions, which the census never scanned.
 *   - counted directly here (whole reading view, every region): the body still
 *     showed 31 damage characters after the rules, the notes 9, the back matter 3.
 *   - COMMIT f53d4e9 has since taught the census the standalone marker; this
 *     read remains the instrument for the classes a count cannot hold: the
 *     wrong-but-CLEAN word, the fused/split word, the half-repair.
 *
 * So the instrument for this question is a STRONGER MODEL reading the text
 * WHOLE, in meaningful units, with BOTH witnesses: the reading view (what the
 * reader sees) AND the transcription's own characters (what the scanner did),
 * plus the PARALLEL EDITION's passage for the same span — located with
 * repair.mjs's own second locator (`paragraphMatches`), which does not need a
 * contiguous match and is the reason 18 of 18 body sections locate where the
 * word-level locator found only ~46 of 100 words.
 *
 * WHAT IT SENDS, per region (a body section, the notes, the back matter):
 *   1. the READING VIEW of every block in the region, in order — the corrected
 *      text as the reader sees it, so the argument is visible and a damaged
 *      word can be read against its neighbours;
 *   2. the TRANSCRIPTION'S OWN CHARACTERS for the same blocks, so what the
 *      scanner did is visible too (the reading view hides it);
 *   3. the PARALLEL'S OWN LINES for the region, when the locator finds them.
 * Input is bounded per request the way repair.mjs bounded it: the two
 * transcription views are the region itself, and the parallel excerpt is capped
 * (`MAX_PAR_CHARS`, default 9000) by taking the located lines and, when they
 * exceed the cap, the longest contiguous run around the densest line.
 *
 * WHAT IT ASKS FOR. Findings in THREE classes, because they need different
 * handling: (1) damage the reading view still SHOWS, (2) a wrong-but-CLEAN word
 * — the dangerous class, invisible to any character census, (3) broken or
 * merged words. Each finding is the repair contract's `{find, replace, note,
 * evidence, decided_by}`: `find` copied CHARACTER FOR CHARACTER from the
 * TRANSCRIPTION (rules are written against the transcription's characters, the
 * reading view is derived), `replace` the print's own words with no paraphrase,
 * `evidence` quoting BOTH witnesses where a parallel was supplied.
 *
 * WHAT IT DOES NOT DO. It merges NOTHING and touches no rules file: the output
 * is `<slug>.fullread.json`, proposals with evidence, and the guard that refuses
 * if the two paths were ever the same is the one review.mjs and repair.mjs use.
 *
 *   node tools/fullread.mjs [slug] [--only=1,2,15] [--append]
 *                                   [--self-test] [--dry-run]
 *
 * Environment: LIBRARY_FULLREAD_URL (default the local DeepSeek proxy at
 * 10.0.0.1:8321), LIBRARY_FULLREAD_MODEL (default deepseek-flash — the read
 * PROPOSES and never merges, so its failure mode is "finds less"; raise it per
 * run for depth AND raise the effort with it),
 * LIBRARY_FULLREAD_EFFORT (default high — at max a reasoning model spends the
 * budget thinking and returns no answer, MEASURED),
 * LIBRARY_FULLREAD_MAX_TOKENS (a starved call
 * returns an EMPTY answer, MEASURED), LIBRARY_FULLREAD_MAX_PAR_CHARS,
 * LIBRARY_FULLREAD_ATTEMPTS, LIBRARY_FULLREAD_TIMEOUT_MS,
 * LIBRARY_FULLREAD_NOTES_CHUNK.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  extract,
  sha256,
  readEdition,
  loadEdits,
  loadBasePolicy,
  applyEditsCounted,
  editsPath,
  hasEdition,
  witnessPath,
} from './extract.mjs';
import { TEXTS, SHELF, shelfFiles, shelfFile } from './shelf.mjs';
import {
  transcriptionBlocks,
  parallelSpec,
  paragraphMatches,
  longestShared,
  parseReply,
} from './repair.mjs';

const URL_ = process.env.LIBRARY_FULLREAD_URL || 'http://10.0.0.1:8321/v1/chat/completions';
/* THE MODEL: deepseek-flash on the local DeepSeek proxy (8321), the default for
 * this repo's library work — NOT the GLM router (8324). It is a cheap tier rather
 * than the deepest model available, and it need not be deeper, for a reason that
 * is about the SHAPE of its output, not about the model's depth:
 *
 *   THIS PASS PROPOSES AND NEVER MERGES. Its findings go through merge.mjs, which
 *   refuses anything that does not fire, contradicts a recorded reading, or would
 *   silence a rule, and then through a human read against a witness. So a weaker
 *   read's failure mode is FINDS LESS or PROPOSES SOMETHING BAD THAT IS CAUGHT —
 *   never corrupts the text. (repair.mjs's recorded failure was the other shape: it
 *   writes readings straight into the repair pipeline, where a half repair reaches
 *   the reader.)
 *
 * THE TWO EARLIER DEFAULTS, kept because their measurements still bound what a
 * read may expect: it was glm-5.3 (the FULL model) — the author's call after
 * repair.mjs measured a Flash failure on this same text — and then glm-5.3-flash,
 * the cheap tier of the scarce GLM quota. MEASURED on glm-5.3-flash there: it
 * failed the REPAIR pass at effort max with 45k reasoning characters, so the
 * shortfall was depth, not budget — which is why a cost decision here has a known
 * ceiling, not a free lunch.
 *
 * Raise it per run with LIBRARY_FULLREAD_MODEL=glm-5.3 (on 8324) when a read must
 * be deeper. */
const MODEL = process.env.LIBRARY_FULLREAD_MODEL || 'deepseek-flash';
/* THE EFFORT, and why it is HIGH and not max. The models served here are
 * REASONING models: `reasoning_content` is spent from the SAME budget as
 * `content`, so a call that thinks too much returns an empty or truncated answer.
 * MEASURED on glm-5.3-Flash with an 8k prompt, the same call four ways:
 *     effort max,  max_tokens 8000   -> empty / no answer
 *     effort max,  max_tokens 16000  -> empty / no answer
 *     effort max,  max_tokens 32000  -> 869 chars, 632 reasoning
 *     effort max,  max_tokens 48000  -> empty / no answer
 *     effort high, max_tokens 8000   -> 1327 chars, 710 reasoning, VALID JSON
 *     effort high, max_tokens 16000  ->  891 chars, 834 reasoning, VALID JSON
 * — high is both RELIABLE and better here, because the pass wants FINDINGS, not
 * deliberation, and at max the model deliberates until the answer is gone.
 * (The FULL glm-5.3 on the GLM router is the exception measured to want max — it
 * has the headroom, and glm-5.3 is what the whole-volume reads first ran on; it
 * is no longer this tool's default.) */
const EFFORT = process.env.LIBRARY_FULLREAD_EFFORT || 'high';
const MAX_TOKENS = Number(process.env.LIBRARY_FULLREAD_MAX_TOKENS || 48000);
/** The cap on the parallel excerpt sent with one region. The parallel prints
 * the same translation in fewer lines and interleaves footnotes and running
 * heads, so the located region is usually LONGER than the section; the excerpt
 * keeps the request bounded the way repair.mjs's per-token windows did. */
const MAX_PAR_CHARS = Number(process.env.LIBRARY_FULLREAD_MAX_PAR_CHARS || 9000);
const WINDOW = Number(process.env.LIBRARY_PARALLEL_WINDOW || 7);
const MIN_SHARE = Number(process.env.LIBRARY_PARALLEL_MIN || 0.45);
const MIN_SCORE = Number(process.env.LIBRARY_PARALLEL_MINSCORE || 4);
/** The same evidence floor repair.mjs uses: a label ("OCR error") is not a
 * quotation of either witness. */
const MIN_EVIDENCE = 24;
const MIN_PARALLEL_QUOTE = 12;

const DAMAGE = '^_~*£/>\\|#™±»«}{&';

/* ---------- the regions: what "the whole text" means here ---------- */

/**
 * The reading order this read covers: every BODY section, then the NOTES, then
 * the BACK MATTER. The notes and the back matter are served by the same
 * reading view (the build's own region walk), they carry MEASURED damage the
 * body census never counts (9 and 3 damage characters respectively), and the
 * author's "a fair amount of damage" was a reading of the published text, which
 * shows all three regions. Nothing is skipped: the coverage table in the
 * artifact names every region and its block count, and a region with no blocks
 * would be listed with zero rather than dropped.
 */
export function regionsOf(doc, rules, { whole = false, chunk = 1 } = {}) {
  const body = transcriptionBlocks(doc);
  const sections = [...new Set(body.map((b) => b.section))].sort((a, b) => a - b);
  const out = [];
  /* ONE REGION FOR THE WHOLE VOLUME. The regioning exists for MODELS THAT CANNOT
   * HOLD THE TEXT: a section at a time keeps every request small and the reply
   * budget unspent. A model with a large context does not need it, and a whole-text
   * read in one call is strictly better when it fits — the reader sees the
   * argument whole, a finding cannot be missed because its section came late, and
   * ONE artifact is the record of the read. MEASURED: this edition is 63,623
   * characters (~16k tokens); `deepseek-flash` is served with a 1M-token context,
   * so the text AND the 1823 parallel (~150k tokens) fit many times over. */
  if (whole) {
    const all = [];
    let region2 = null;
    for (const b of doc.blocks || []) {
      if (b.t === 'region') { region2 = b.kind; continue; }
      // the book's own text: the body and the notes. The apparatus (the library's
      // marks, the front matter, the colophon, the publisher's list) is not read
      // here — a rule is not written against a catalogue blurb.
      if (region2 !== 'body' && region2 !== 'notes') continue;
      if (b.t !== 'p' && b.t !== 'verse' && b.t !== 'notedef') continue;
      const text = String(b.x || '').replace(/\n/g, ' ');
      if (!text) continue;
      all.push({ t: b.t, n: b.n || null, at: b.at || null, page: b.page ?? null, section: b.section ?? null, text, toks: text.split(/\s+/).filter(Boolean) });
    }
    // ONE REGION, OR N CONTIGUOUS ONES. `--chunk=N` splits the volume into N
    // contiguous parts at block boundaries: the read is still the whole text, in
    // reading order, every block, but each request is smaller. It exists because
    // a single whole-volume request to a REASONING model can outlive the router's
    // stream (MEASURED: glm-5.3 at effort high/max on this 595k-char prompt ran
    // 14-28 minutes and ended with no final frame and no content, while the same
    // prompt capped at 4k tokens answered in 49s). One artifact still records the
    // read; only the request boundaries change.
    const n = Math.max(1, Math.floor(chunk) || 1);
    if (n > 1) {
      const size = Math.ceil(all.length / n);
      const parts = [];
      for (let k = 0; k < n; k++) {
        const part = all.slice(k * size, (k + 1) * size);
        if (!part.length) continue;
        parts.push({
          name: `the whole volume (part ${k + 1} of ${n})`,
          kind: 'body',
          key: `whole:${k + 1}`,
          blocks: part,
          view: part.map((b) => applyEditsCounted(b.text, rules)),
          raw: part.map((b) => b.text),
        });
      }
      return parts;
    }
    return [
      {
        name: 'the whole volume',
        kind: 'body',
        key: 'whole',
        blocks: all,
        view: all.map((b) => applyEditsCounted(b.text, rules)),
        raw: all.map((b) => b.text),
      },
    ];
  }
  for (const s of sections) {
    const blocks = body.filter((b) => b.section === s);
    out.push({
      name: `section ${s}`,
      kind: 'body',
      key: String(s),
      blocks,
      view: blocks.map((b) => applyEditsCounted(b.text, rules)),
      raw: blocks.map((b) => b.text),
    });
  }
  for (const kind of ['notes', 'end']) {
    const blocks = [];
    let region = null;
    for (const b of doc.blocks || []) {
      if (b.t === 'region') { region = b.kind; continue; }
      if (region !== kind) continue;
      if (b.t !== 'p' && b.t !== 'verse' && b.t !== 'notedef') continue;
      const text = String(b.x || '').replace(/\n/g, ' ');
      if (!text) continue;
      blocks.push({ t: b.t, n: b.n || null, at: b.at || null, page: b.page ?? null, section: null, text, toks: text.split(/\s+/).filter(Boolean) });
    }
    if (!blocks.length) continue;
    // The notes are chunked into CONSECUTIVE runs bounded like a body section
    // (~12k transcription chars): a whole-section read needs the argument
    // visible, and one 20k-char notes region would both dwarf every other
    // request and starve the reply budget. The chunks are whole blocks, in
    // reading order, and none is skipped — the coverage table names each.
    const CHUNK = Number(process.env.LIBRARY_FULLREAD_NOTES_CHUNK || 12000);
    const label = kind === 'notes' ? 'the notes' : "the publisher's book list";
    let part = 0;
    for (let i = 0; i < blocks.length; ) {
      let size = 0;
      let j = i;
      while (j < blocks.length && (size === 0 || size + blocks[j].text.length <= CHUNK)) {
        size += blocks[j].text.length;
        j++;
      }
      part++;
      const chunkBlocks = blocks.slice(i, j);
      out.push({
        name: `${label} (part ${part})`,
        kind,
        key: `${kind}:${part}`,
        blocks: chunkBlocks,
        view: chunkBlocks.map((b) => applyEditsCounted(b.text, rules)),
        raw: chunkBlocks.map((b) => b.text),
      });
      i = j;
    }
  }
  return out;
}

/** The transcription lines of one region, numbered, with the READING VIEW
 * beside them — the two witnesses this read needs for its own text. */
function twoColumn(region) {
  const parts = [];
  for (let i = 0; i < region.blocks.length; i++) {
    const b = region.blocks[i];
    const where = `[${b.at || b.t}${b.page != null ? `, page ${b.page}` : ''}${b.n != null ? `, note ${b.n}` : ''}]`;
    parts.push(`--- block ${i + 1} ${where} ---`);
    parts.push(`READING VIEW : ${region.view[i]}`);
    parts.push(`TRANSCRIPTION: ${region.raw[i]}`);
  }
  return parts.join('\n');
}

/** The parallel's own lines for a region, capped. The locator is
 * repair.mjs's `paragraphMatches` over the region's whole text — the second,
 * non-contiguous locator — with the best candidate extended by a little context
 * (`PAD`) and capped at `MAX_PAR_CHARS` around its densest line. A miss is
 * reported as a miss, never filled with a neighbouring passage. */
const PAD = 12;
export function parallelFor(region, parallel, { whole = false } = {}) {
  if (!parallel) return { status: 'no parallel volume known for this text' };
  /* THE WHOLE PARALLEL, when the caller asked for the whole text: the locator
   * exists to find a section's passage in a volume too large to send; with the
   * whole volume in hand there is nothing to locate, and a cap would hide the
   * very lines a reading is decided from. */
  if (whole) {
    return {
      status: 'located',
      lines: [1, parallel.lines.length],
      matchedWords: null,
      excerpt: parallel.lines.join('\n'),
      capped: false,
      whole: true,
      allCandidates: [],
    };
  }
  if (region.kind !== 'body') {
    return {
      status:
        'NOT SUPPLIED for this region: the parallel edition (a different printing) carries the treatise, not this volume\'s notes or back matter; read this region from the transcription\'s own context alone',
    };
  }
  const text = region.raw.join(' ');
  const cands = paragraphMatches(text, parallel.tokens, 3);
  if (!cands.length) {
    return { status: 'NOT LOCATED: no run of the parallel\'s lines shared at least two of this section\'s distinctive words' };
  }
  const best = cands[0];
  let lo = Math.max(1, best.lo - PAD);
  let hi = Math.min(parallel.lines.length, best.hi + PAD);
  let excerpt = parallel.lines.slice(lo - 1, hi).join('\n');
  let capped = false;
  if (excerpt.length > MAX_PAR_CHARS) {
    capped = true;
    // the widest contiguous run of whole lines around the densest shared-word
    // line: the located region is printed with footnotes and running heads
    // interleaved, so the passage the section actually shares is densest there
    const density = new Map();
    for (const w of best.shared) {
      for (const t of parallel.tokens) if (t.n === w) density.set(t.line, (density.get(t.line) || 0) + 1);
    }
    const centre = ([...density.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] || [Math.floor((lo + hi) / 2)])[0];
    const lineAt = (n) => parallel.lines[n - 1] || '';
    let l = centre;
    let r = centre;
    let size = lineAt(centre).length;
    for (;;) {
      const before = `${l}:${r}`;
      if (l - 1 >= lo && size + lineAt(l - 1).length + 1 <= MAX_PAR_CHARS) {
        l--;
        size += lineAt(l).length + 1;
      }
      if (r + 1 <= hi && size + lineAt(r + 1).length + 1 <= MAX_PAR_CHARS) {
        r++;
        size += lineAt(r).length + 1;
      }
      if (`${l}:${r}` === before) break;
    }
    excerpt = parallel.lines.slice(l - 1, r).join('\n');
    lo = l;
    hi = r;
  }
  return {
    status: 'located',
    lines: [lo, hi],
    matchedWords: best.score,
    excerpt,
    capped,
    allCandidates: cands.map((c) => ({ lo: c.lo, hi: c.hi, score: c.score })),
  };
}

/* ---------- the prompt ---------- */

export function policyBlock(policy) {
  return [
    'THE BASE POLICY THIS READING VIEW IS BUILT UNDER (unchanged; you do not get to change it):',
    `  rule: ${policy.rule}`,
    '  ' + String(policy.states).replace(/\n/g, '\n  '),
    `  the damage character set, MEASURED on this transcription: ${[...policy.damage].join(' ')}`,
  ].join('\n');
}

/** One region's prompt. The contract is repair.mjs's, extended from one damaged
 * run to a whole region: the classes are three because they need different
 * handling, and the model is asked to work in reading order. */
export function promptFor(region, par, policy, book) {
  /* WHICH BOOK, said per-text. This prompt used to name Porphyry's Cave of the
   * Nymphs and the 1917 printing in its opening line, which is right for THAT
   * text and wrong for every other — a reader told the wrong book cannot judge
   * what the print's own wording is. The caller passes the description from the
   * shelf entry; the default is the Cave's, so its recorded reads are unchanged. */
  const desc = book || "Taylor's translation of Porphyry's *Cave of the Nymphs*, 1917 printing";
  const parBlock =
    par.status === 'located' && par.whole
      ? `THE PARALLEL EDITION — ${par.file} — the SAME TRANSLATION in another printing, given IN FULL below ` +
        `(${par.lines[1]} lines). Its line numbers are its own; the treatise is one part of a volume that also ` +
        `carries other works, so use the words, not the position. ` +
        `The parallel has its own OCR damage; where it differs from the transcription, quote what it actually says:\n` +
        par.excerpt
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n')
      : par.status === 'located'
      ? `THE PARALLEL EDITION — ${par.file} — the same translation in another printing, located at its own lines ${par.lines[0]}-${par.lines[1]} ` +
        `(${par.matchedWords} of this section's distinctive words shared${par.capped ? '; the excerpt is capped and does not reach every line of the located region' : ''}). ` +
        `The parallel has its own OCR damage; where it differs from the transcription, quote what it actually says:\n` +
        par.excerpt
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n')
      : `THE PARALLEL EDITION: ${par.status}.`;
  return `You are reading a whole section of an OCR transcription of a printed book (${desc}), to find damage a character-counting instrument is blind to. The instrument counts a damage character standing inside a word; it cannot see (a) a word a recorded rule HALF-repaired (the marker consumed, the word left wrong), (b) a word that is wrong but has NO damage character in it (a substituted or missing letter — a plausible-looking non-word), or (c) a word broken in two or two words fused into one. Those are what you are looking for. You are the stronger instrument; the author has read the published text and reports "a fair amount of damage" where the build's own count says two.

${policyBlock(policy)}

Below, for each block in reading order, are TWO lines: the READING VIEW (the corrected text exactly as the reader of the published edition sees it, recorded readings applied) and the TRANSCRIPTION (the scanner's own characters, damage and all). A repair rule is written against the TRANSCRIPTION's characters — that is where your "find" must come from, CHARACTER FOR CHARACTER, never from the reading view and never from the parallel.

${twoColumn(region)}

${parBlock}

Work through the section in reading order. Report EVERY defect you find, however small, in one of THREE classes:
  1 "visible"  — damage the READING VIEW still shows: a damage character (^ _ ~ * £ > / \\ | # ™ ± » « } { &) or an artefact standing in the reading view's own text. This INCLUDES a marker standing ALONE BETWEEN words ("of ^ any other matter", "petitioner. _ Thus") — very often the print's own SPACE the scanner read as a symbol, and sometimes running-head or page furniture debris. Where it is the lost space, say so and give the space; where it is furniture (a page number, a running head), do NOT invent a reading — use "unsure".
  2 "clean"    — a word that is WRONG but carries no damage character: a substituted letter, a missing letter, a plausible-looking non-word, a wrong English word (the dangerous class — invisible to any character census);
  3 "broken"   — a word split in two ("sus pected" for "suspected", a word broken across a line or by a hyphen the print does not carry) or two words fused ("darkand" for "dark and").

A fourth shape sits across the classes and MUST be reported rather than skipped: a RUN-TOGETHER FRAGMENT where several words collapsed into noise ("«*•<* anH js collected" for "and is collected") — report it as class 1 if the reading view still shows it, class 3 if the words are merely fused; the point is that it is reported.

For each finding reply with:
{"class":"1|2|3","find":"...","replace":"...","note":"...","evidence":"...","decided_by":"transcription|parallel|both"}
- "find" is copied CHARACTER FOR CHARACTER from the TRANSCRIPTION column above (the scanner's own characters, damage and all). It must be enough to identify the place uniquely: the damaged word, or the words either side when the damage spans a boundary.
- "replace" is what the PRINT has for exactly those characters: the printed words, whole, in the print's spelling. NO paraphrase, no words the print does not have, and do not "improve" the prose — where the print itself is odd, that is the print, not damage.
- "note" says in one sentence what the harm is and which class it is.
- "evidence" MUST quote the transcription's own characters (the find, verbatim) AND, where the parallel above carries the passage, at least 12 consecutive characters of the parallel's own words verbatim, and must say WHICH witness decided the reading.
- Where the reading is NOT determinable from what you are given, reply with {"unsure":{"passage":"...","question":"...","note":"...","evidence":"..."}} — the passage as the transcription has it, and the specific question a human must answer. A guess is worse than a stated gap; this is the project's own policy.

Three cautions, MEASURED on this project:
- Do not "repair" Greek transliterations, proper names, or period spellings the print genuinely carries ("mun dane" set as two words is a broken word, but "shew" is the print's spelling, not damage).
- Verse quotations and the verse block's lineation are the print's own.
- The parallel is a DIFFERENT PRINTING with its own OCR damage: it decides a reading only where its own text is clean.

Reply with ONE JSON object and nothing else: {"findings":[ ... ],"unsure":[ ... ]}. An empty "findings" array is a valid answer — do not manufacture findings to fill it.`;
}

/* ---------- the call ---------- */

class FatalError extends Error {}

/** Reassemble one SSE stream into the same shape the non-streaming call
 * returned. MEASURED on this router: a non-streaming completion of a
 * whole-section prompt (>=13k chars) at effort max delivers its first byte
 * only when generation finishes, and the proxy kills the read at ~300s
 * ("proxy error: The read operation timed out", and undici's own
 * UND_ERR_HEADERS_TIMEOUT at the same mark) — while the SAME request streamed
 * completes in ~500s. Streaming keeps bytes flowing through the thinking, so
 * the idle-read timer never fires. The usage/effort receipt rides the final
 * frame, which the router emits with finish_reason "stop". */
export async function callStream(prompt, { url = URL_, model = MODEL, maxTokens = MAX_TOKENS, effort = EFFORT, timeoutMs = Number(process.env.LIBRARY_FULLREAD_TIMEOUT_MS || 1800000) } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      // THE EFFORT KEY, and why it is `reasoning_effort`. This router took `effort`
      // when this tool was written and REJECTS it now (MEASURED 2026-10-04: HTTP 422
      // "Extra inputs are not permitted" for body.effort on both glm-5.3 and
      // glm-5.3-flash, while the OpenAI-standard `reasoning_effort` is accepted and
      // changes the reply's length). The env var still names the level; only the wire
      // key changed.
      ...(effort ? { reasoning_effort: effort } : {}),
      stream: true,
      // ask the router to put usage on the final frame (OpenAI-compatible
      // routers do this by default; the flag costs nothing if ignored)
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`the endpoint answered ${res.status} ${res.statusText}${text.slice(0, 120) ? ` — ${text.slice(0, 120)}` : ''}`);
  }
  if (!res.body) throw new Error('the endpoint returned no body');
  const content = [];
  const reasoning = [];
  let usage = null;
  let finish = null;
  const decoder = new TextDecoder();
  let buf = '';
  // WHATWG ReadableStream in Node's fetch: getReader(), not .read() on the body
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let d;
      try {
        d = JSON.parse(payload);
      } catch {
        continue; // a malformed frame does not sink the region
      }
      if (d.usage) usage = d.usage;
      for (const ch of d.choices || []) {
        if (ch.finish_reason) finish = ch.finish_reason;
        const delta = ch.delta || {};
        if (delta.content) content.push(delta.content);
        if (delta.reasoning_content) reasoning.push(delta.reasoning_content);
      }
    }
  }
  const details = ((usage || {}).completion_tokens_details) || {};
  return {
    content: content.join(''),
    reasoning: reasoning.join(''),
    usage,
    reasoningTokens: details.reasoning_tokens ?? null,
    finish,
    retries: 0,
  };
}

/** A short, bounded retry around the streaming call: the router measured 502
 * Bad Gateway and bare "fetch failed" INTERMITTENTLY on this project (five
 * regions of the first run died to them), and one transport hiccup must not
 * cost a region. Bounded — 4 attempts, exponential backoff — because a down
 * endpoint must end the run in minutes, not hang it for an hour holding its
 * output. */
async function call(prompt) {
  const ATTEMPTS = Number(process.env.LIBRARY_FULLREAD_ATTEMPTS || 4);
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const reply = await callStream(prompt);
      return { ...reply, retries: attempt - 1 };
    } catch (e) {
      lastErr = e;
      if (e instanceof FatalError) throw e;
      if (attempt < ATTEMPTS) {
        const wait = 2000 * 2 ** (attempt - 1);
        console.log(`    transport error (${e.message}) — retry ${attempt}/${ATTEMPTS - 1} after ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

/* ---------- validation: the mechanical test ---------- */

/**
 * Check one finding, and either return the entry that will be written out or a
 * REASON it is rejected. Every rejection is a mechanical fact about the finding
 * — it is not in the transcription, it quotes no witness, it names no class —
 * never a judgement about the reading, which stays the human's job.
 */
export function vetFinding(f, { rawBody, front, parallelShown, region }) {
  if (!f || typeof f !== 'object') return { reject: 'not an object' };
  const cls = String(f.class ?? f.cls ?? '');
  const find = typeof f.find === 'string' ? f.find : '';
  const replace = typeof f.replace === 'string' ? f.replace : '';
  const note = typeof f.note === 'string' ? f.note : '';
  const evidence = typeof f.evidence === 'string' ? f.evidence : '';
  const decided = typeof f.decided_by === 'string' ? f.decided_by : '';
  if (!['1', '2', '3', 'visible', 'clean', 'broken'].includes(cls)) return { reject: `class "${cls}" — a finding must be class 1, 2 or 3` };
  const kind = cls.length === 1 ? cls : cls === 'visible' ? '1' : cls === 'clean' ? '2' : '3';
  if (!find) return { reject: 'no find' };
  if (!replace) return { reject: 'no replace' };
  if (find === replace) return { reject: 'the replacement is the find' };
  if (!rawBody.includes(find)) {
    return { reject: "the find does not occur in the transcription's own characters (it may come from the reading view or the parallel — either way no rule can be written against it)" };
  }
  if (front && front.includes(find)) return { reject: 'the find stands in the front matter, which no rule may touch' };
  if (evidence.length < MIN_EVIDENCE) return { reject: `the evidence is ${evidence.length} characters — too short to quote anything` };
  if (!evidence.includes(find)) return { reject: "the evidence does not quote the transcription's own characters (the find is not in it)" };
  /* THE PARALLEL QUOTE IS REQUIRED ONLY WHEN THE EVIDENCE CLAIMS THE PARALLEL
   * DECIDED IT. MEASURED: the first full read rejected 34 of 76 proposals, ALL for
   * one reason — "the evidence quotes only 9 character(s) of the parallel's own
   * words" — and the proposals were good readings decided from the transcription
   * itself ("wnnlrf" -> "would", "ahgrn-j" -> "absurd", "fpr" -> "for"), whose own
   * evidence says "No parallel coverage; decided by the transcription". A guard
   * that fires on a proposal which never claimed the parallel is a guard rejecting
   * work the policy explicitly permits: substitute the reading when a witness
   * decides it, and the transcription is a witness.
   *
   * So the claim is read from the evidence. If it names the parallel as the
   * decider, the quote is required and the floor stands. If it says there is no
   * parallel coverage, or names only the transcription, then the TRANSCRIPTION
   * quote (checked above) is the evidence and that is enough. */
  const claimsParallel = /parallel/i.test(evidence) && !/no\s+parallel\s+coverage/i.test(evidence);
  if (parallelShown && claimsParallel) {
    const shared = longestShared(evidence, parallelShown);
    if (shared < MIN_PARALLEL_QUOTE) {
      return {
        reject: `the evidence names the parallel as the decider but quotes only ${shared} character(s) of its words — it names the parallel without quoting it`,
      };
    }
  }
  if (!note) return { reject: 'no note' };
  // HOW MANY SITES the find names — a mechanical fact the human merger needs:
  // a find occurring in N places changes N places when written as a rule, and
  // a multi-site find that was meant for ONE of them is the classic way a
  // machine proposal asserts something the print does not.
  const sites = rawBody.split(find).length - 1;
  return { kind, find, replace, note, evidence, decided_by: decided || 'unstated', region, sites };
}

/* ---------- the run ---------- */

/* WHERE A READ LANDS. The first read is `<slug>.fullread.json`; a SECOND read is
 * its own artifact (`--out=<suffix>` gives it one, e.g. `<slug>.fullread-flash.json`),
 * because overwriting a read would destroy the record a merge was made from — and
 * a read is evidence, not scratch. A suffix is a NAME segment, never a path: the
 * file always lands beside the rules. */
function fullreadPath(slug, suffix) {
  const name = suffix ? `${slug}.fullread-${suffix}.json` : `${slug}.fullread.json`;
  return join(editsPath(slug).replace(/[^/]+$/, ''), name);
}

function write(slug, payload, suffix) {
  const out = fullreadPath(slug, suffix);
  if (out === editsPath(slug)) throw new Error('library: the fullread path and the rules path are the same — refusing to write');
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  return out;
}

// the suffix this run writes under, set by --out in main(); module-level so the
// append path can read the SAME location the write will use
let SOME_SUFFIX = '';

export function readParallel(slug) {
  const spec = parallelSpec(slug);
  if (!spec) return null;
  // Prefer the LIBRARY's imported witness; fall back to the shelf.
  const imported = witnessPath(slug, spec.file);
  const resolved = spec.file;
  const path = imported || join(SHELF, shelfFile(spec.file, shelfFiles()));
  if (!existsSync(path)) throw new Error(`library: the parallel "${resolved}" is not on the shelf (${SHELF}) and not imported into the library`);
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const tokens = [];
  lines.forEach((l, i) => {
    for (const raw of l.split(/\s+/)) if (raw !== '') tokens.push({ raw, line: i + 1, n: raw.toLowerCase().replace(/[^a-z]/g, '') });
  });
  return { file: resolved, path, text, lines, tokens, sha256: sha256(text), why: spec.why };
}

async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--')) || (TEXTS.find((t) => hasEdition(t.slug)) || {}).slug;
  const only = (args.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
  SOME_SUFFIX = (args.find((a) => a.startsWith('--out=')) || '').slice('--out='.length);
  if (SOME_SUFFIX && !/^[A-Za-z0-9_-]+$/.test(SOME_SUFFIX)) {
    throw new Error('library: --out takes a name segment (letters, digits, _ or -), not a path');
  }
  const selfTest = args.includes('--self-test');
  const dryRun = args.includes('--dry-run');

  const entry = TEXTS.find((t) => t.slug === slug);
  if (!entry) throw new Error(`library: no such text on the shelf: ${slug}`);
  if (!hasEdition(slug)) throw new Error(`library: no stored edition for ${slug}`);
  /* WHICH BOOK, for the prompt: the shelf entry's own description of the edition.
   * The prompt used to hardcode the Cave's; a read of another text was told the
   * wrong book, which is a fact the model needs to judge the print's wording. */
  const BOOK_DESC =
    `${entry.author || ''}'s ${entry.title || ''}` +
    `${entry.translator ? `, translated by ${entry.translator}` : ''} (${entry.year || ''})`;
  const src = readEdition(slug);
  const doc = extract(src, { entry, sha256: sha256(src) });
  const { edits } = loadEdits(slug);
  const rules = doc.corrections.map((c) => ({ find: c.find, repl: c.repl, action: c.action }));
  const policy = loadBasePolicy();
  const front = (await import('./extract.mjs')).frontMatterText(doc);
  const rawAll = (doc.blocks || []).map((b) => (typeof b.x === 'string' ? b.x : '')).join('\n');
  const parallel = readParallel(slug);

  if (selfTest) return selfTestMain({ doc, rules, front, rawAll });

  const whole = args.includes('--whole');
  const chunk = Number((args.find((a) => a.startsWith('--chunk=')) || '').slice('--chunk='.length)) || 1;
  let regions = regionsOf(doc, rules, { whole, chunk });
  if (only) {
    const want = new Set(only.split(',').map((s) => s.trim()));
    regions = regions.filter((r) => want.has(r.key));
  }

  const findings = [];
  const unsure = [];
  const rejected = [];
  const failed = [];
  const sent = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  // APPEND MODE, for re-running the regions a dead endpoint failed: the run
  // writes as it goes, so a re-run that overwrote the file would throw away
  // every region that had already succeeded. `--append` keeps the existing
  // rows and findings, replaces the rows whose region is re-sent, and records
  // the merge in `appended` so the artifact's history is visible. (The
  // accumulators are declared ABOVE this block: reading them here from below
  // their declaration was a temporal-dead-zone crash on the first resume.)
  const append = args.includes('--append');
  if (append) {
    const prevPath = fullreadPath(slug, SOME_SUFFIX);
    if (existsSync(prevPath)) {
      const prev = JSON.parse(readFileSync(prevPath, 'utf8'));
      const again = new Set(regions.map((r) => r.name));
      for (const row of prev.sent || []) if (!again.has(row.region)) sent.push(row);
      for (const f of prev.findings || []) if (!again.has(f.region)) findings.push(f);
      for (const u of prev.unsure || []) if (!again.has(u.region)) unsure.push(u);
      for (const r of prev.rejected || []) if (!again.has(r.region)) rejected.push(r);
      for (const f of prev.failed || []) if (!again.has(f.region)) failed.push(f);
      if (prev.cost && prev.cost.usage) for (const k of Object.keys(usage)) usage[k] += prev.cost.usage[k] || 0;
    }
  }

  const damageInView = (r) =>
    [...r.view.join(' ')].reduce((m, c) => (DAMAGE.includes(c) ? ((m[c] = (m[c] || 0) + 1), m) : m), {});

  console.log(
    `library fullread: ${slug}${whole ? ' [THE WHOLE VOLUME IN ONE CALL]' : ''}\n` +
      `  regions: ${regions.length} (${regions.filter((r) => r.kind === 'body').length} body sections, ` +
      `${regions.filter((r) => r.kind !== 'body').map((r) => r.kind).join(', ') || 'no other regions'})\n` +
      `  model ${MODEL} at effort ${EFFORT}, max_tokens ${MAX_TOKENS} · ${URL_}\n` +
      `  parallel: ${parallel ? `${parallel.file} (${parallel.tokens.length} tokens)` : 'NONE KNOWN'}`,
  );

  const buildPayload = () => {
    const chars = sent.map((s) => s.promptChars);
    const byClass = { '1': 0, '2': 0, '3': 0 };
    for (const f of findings) byClass[f.kind]++;
    return {
      slug,
      tool: `a whole-text read by ${MODEL} at effort ${EFFORT}, in sections, with both witnesses (reading view + transcription) and the parallel edition located per section: it PROPOSES findings in three classes and a human merges them`,
      model: MODEL,
      effort: EFFORT,
      endpoint: URL_,
      generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      mergesNothing:
        'Nothing here has been merged. These are PROPOSALS with evidence; the last machine-merge attempt would have asserted readings the print does not have ("but" -> "put", "the" -> "he", "caverns" -> "cavern"). To accept one, add it to the rules file by hand (class "reading", the transcription-find verbatim) and build.',
      policy: { rule: policy.rule, damage: policy.damage },
      parallel: parallel ? { file: parallel.file, sha256: parallel.sha256, why: parallel.why } : null,
      coverage: {
        // the WHOLE reading order, not only what this invocation re-sent, so
        // the coverage table is the same artifact however many times the run
        // was resumed
        regions: regionsOf(doc, rules, { whole, chunk }).map((r) => ({
          region: r.name,
          blocks: r.blocks.length,
          chars: r.raw.join(' ').length,
          damageInView: damageInView(r),
        })),
        requests: sent.length,
        regionsSent: [...new Set(sent.map((s) => s.region))],
        everyRegionSent: [...new Set(sent.map((s) => s.region))].length === regionsOf(doc, rules, { whole, chunk }).length,
        appended: append || undefined,
      },
      context: {
        maxParallelChars: MAX_PAR_CHARS,
        charsPerRequest: chars,
        minChars: chars.length ? Math.min(...chars) : 0,
        maxChars: chars.length ? Math.max(...chars) : 0,
        meanChars: chars.length ? Math.round(chars.reduce((a, b) => a + b, 0) / chars.length) : 0,
      },
      sent,
      findings,
      findingsByClass: byClass,
      unsure,
      rejected,
      failed,
      cost: {
        regions: regionsOf(doc, rules, { whole, chunk }).length,
        sent: sent.length,
        findings: findings.length,
        unsure: unsure.length,
        rejected: rejected.length,
        failed: failed.length,
        usage,
      },
    };
  };
  const checkpoint = () => write(slug, buildPayload(), SOME_SUFFIX);

  for (const region of regions) {
    const par = parallelFor(region, parallel ? { ...parallel } : null, { whole });
    if (par.status === 'located') par.file = parallel.file;
    const parallelShown = par.status === 'located' ? par.excerpt : '';
    const prompt = promptFor(region, par, policy, BOOK_DESC);
    if (dryRun) {
      console.log(`  ${region.name}: ${prompt.length} chars (parallel ${par.status}${par.lines ? ` ${par.lines.join('-')}` : ''})`);
      continue;
    }
    let reply;
    try {
      reply = await call(prompt);
    } catch (e) {
      failed.push({ region: region.name, error: e.message });
      console.log(`  ${region.name}: FAILED — ${e.message}`);
      checkpoint();
      continue;
    }
    const row = {
      region: region.name,
      promptChars: prompt.length,
      parallel: par.status === 'located' ? { lines: par.lines, matchedWords: par.matchedWords, capped: !!par.capped } : { status: par.status },
      finish: reply.finish,
      reasoningTokens: reply.reasoningTokens,
      thinkingChars: reply.reasoning.length,
      rawBodyChars: region.raw.join(' ').length,
      ...(reply.retries ? { retried: reply.retries } : {}),
    };
    sent.push(row);
    if (reply.usage) for (const k of Object.keys(usage)) usage[k] += reply.usage[k] || 0;
    if (!reply.content.trim()) {
      failed.push({ region: region.name, error: `no answer: finish ${reply.finish} (the budget was spent before the answer began)`, reasoningTokens: reply.reasoningTokens });
      console.log(`  ${region.name}: FAILED — no answer (finish ${reply.finish}, ${reply.reasoningTokens} reasoning tokens)`);
      checkpoint();
      continue;
    }
    const parsed = parseRegionReply(reply.content);
    if (!parsed) {
      failed.push({ region: region.name, error: `the reply was not the JSON asked for (${reply.content.slice(0, 100)})` });
      console.log(`  ${region.name}: FAILED — not JSON`);
      checkpoint();
      continue;
    }
    const beforeRejected = rejected.length;
    for (const f of parsed.findings || []) {
      const v = vetFinding(f, { rawBody: rawAll, front, parallelShown, region: region.name });
      if (v.reject) {
        rejected.push({ region: region.name, reason: v.reject, proposal: f });
        console.log(`    REJECTED — ${v.reject}`);
      } else {
        findings.push(v);
        console.log(`    [${v.kind}] ${JSON.stringify(v.find).slice(0, 60)} -> ${JSON.stringify(v.replace).slice(0, 60)}`);
      }
    }
    for (const u of parsed.unsure || []) {
      if (!u || typeof u !== 'object' || !u.passage || !u.question) {
        rejected.push({ region: region.name, reason: 'an unsure entry without a passage or a question', proposal: u });
        continue;
      }
      unsure.push({ region: region.name, passage: u.passage, question: u.question, note: u.note || '', evidence: u.evidence || '' });
      console.log(`    UNSURE — ${String(u.question).slice(0, 80)}`);
    }
    console.log(
      `${region.name}: ${(parsed.findings || []).length} finding(s), ${rejected.length - beforeRejected} rejected, ${(parsed.unsure || []).length} unsure`,
    );
    checkpoint();
  }

  if (dryRun) return { dryRun: true };
  const out = write(slug, buildPayload(), SOME_SUFFIX);
  console.log(
    `\nlibrary fullread: ${out.split('/').slice(-1)[0]} — ${findings.length} finding(s) ` +
      `(${findings.filter((f) => f.kind === '1').length} visible, ${findings.filter((f) => f.kind === '2').length} clean, ` +
      `${findings.filter((f) => f.kind === '3').length} broken), ${unsure.length} unsure, ${rejected.length} rejected, ${failed.length} failed\n` +
      `  coverage: ${[...new Set(sent.map((s) => s.region))].length} of ${regionsOf(doc, rules, { whole, chunk }).length} region(s) sent; ` +
      `${buildPayload().context.minChars}-${buildPayload().context.maxChars} chars/request (mean ${buildPayload().context.meanChars})\n` +
      `  tokens ${usage.prompt_tokens} in / ${usage.completion_tokens} out\n` +
      `  NOTHING WAS MERGED. The rules file is untouched.`,
  );
  return buildPayload();
}

/** The reply is one object with two arrays. Fences are unwrapped rather than
 * thrown away (repair.mjs's reading), and a truncated JSON tail is salvaged by
 * cutting back to the last complete object — a whole-section reply is long, and
 * an unsalvageable one is a failed region, which is recorded, not hidden. */
export function parseRegionReply(content) {
  const trimmed = String(content).trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = unfenced.indexOf('{');
  if (start < 0) return null;
  // try the whole object first
  const whole = unfenced.slice(start, unfenced.lastIndexOf('}') + 1);
  try {
    const p = JSON.parse(whole);
    if (p && typeof p === 'object') return p;
  } catch {
    /* fall through to salvage */
  }
  // salvage: the largest prefix that parses, object by object
  const salvage = { findings: [], unsure: [] };
  const arrays = [['"findings"', []], ['"unsure"', []]];
  let any = false;
  for (const [key] of arrays) {
    const kAt = unfenced.indexOf(key, start);
    if (kAt < 0) continue;
    const arrStart = unfenced.indexOf('[', kAt);
    if (arrStart < 0) continue;
    let depth = 0;
    let objStart = -1;
    for (let i = arrStart; i < unfenced.length; i++) {
      const c = unfenced[i];
      if (c === '{') {
        if (depth === 0) objStart = i;
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0 && objStart >= 0) {
          try {
            salvage[key === '"findings"' ? 'findings' : 'unsure'].push(JSON.parse(unfenced.slice(objStart, i + 1)));
            any = true;
          } catch {
            /* one unparseable object does not sink the region */
          }
          objStart = -1;
        }
      } else if (c === ']' && depth === 0) break;
    }
  }
  return any ? salvage : null;
}

/* ---------- the self-test: the rejections are shown to be able to fail ---------- */

/* THE FIXTURE TOKEN IS TAKEN FROM THE TRANSCRIPTION UNDER TEST, not from one
 * edition. It was the literal `jwjth`, noted as a MEASURED half-repair "standing
 * in the body's own text" — MEASURED, but measured in PORPHYRY: `jwjth` stands in
 * the Cave's transcription at source line 565 ("not  to  be  filled  jwjth
 * water,  but  with  h_qney_-"), the very passage the parallel fixture below
 * quotes. MEASURED consequence: `--self-test` PASSES for porphyry and FAILS the
 * two ACCEPT cases for BOTH other editions, refused by the vetting guard's own
 * message — "the find does not occur in the transcription's own characters".
 * That is the guard working, not a repointing bug: it vetted the RIGHT text (the
 * edition named on the command line, through the same `rawAll` the real run
 * uses) and the FIXTURE named a token that edition does not contain. A fixture
 * tied to one edition is no gate for the others, and `--self-test` is the
 * pre-flight check for a read of ANY edition — so the token is derived here.
 *
 * It must stand ONCE (a multi-site find changes every site, so a one-site find
 * is the honest fixture), carry a damage character from the transcription's own
 * alphabet (class-1 damage, the class a rule is written against), and be absent
 * from the front matter (which no rule may touch) — those are exactly the guards
 * `vetFinding` applies, mirrored so the fixture can never be the thing that
 * fails. */
function fixtureToken(rawAll, front) {
  const counts = new Map();
  for (const w of rawAll.split(/\s+/)) if (w) counts.set(w, (counts.get(w) || 0) + 1);
  const token = [...counts].find(
    ([w, n]) => n === 1 && w.length >= 4 && /[A-Za-z]/.test(w) && [...w].some((c) => DAMAGE.includes(c)) && !(front || '').includes(w),
  )?.[0];
  if (!token) {
    throw new Error('library: the self-test found no once-only damaged token in the transcription to stand as its fixture');
  }
  return token;
}

function selfTestMain({ doc, rules, front, rawAll }) {
  const token = fixtureToken(rawAll, front); // a token of THIS edition's own characters
  const parallelShown = 'not to be filled with water, but with honeycombs; for in these, Homer says, the bees deposit their honey';
  const cases = [
    { name: 'no evidence at all', f: { class: '1', find: token, replace: 'with', note: 'n', evidence: '' }, expect: 'reject' },
    {
      name: 'evidence that does not contain the find',
      f: { class: '1', find: token, replace: 'with', note: 'n', evidence: 'OCR error, the word is obviously wrong here' },
      expect: 'reject',
    },
    {
      name: 'evidence that names the parallel without quoting it',
      f: { class: '1', find: token, replace: 'with', note: 'n', evidence: `the parallel edition confirms the reading for ${token} plainly` },
      expect: 'reject',
    },
    {
      name: 'a find that is not in the transcription at all',
      f: { class: '2', find: 'notaword', replace: 'a word', note: 'n', evidence: 'the transcription reads notaword here, plainly wrong' },
      expect: 'reject',
    },
    {
      name: 'no class',
      f: { find: token, replace: 'with', note: 'n', evidence: `the transcription reads ${token}; the print reads with, as the parallel shows` },
      expect: 'reject',
    },
    {
      name: 'right evidence, quoting both witnesses',
      f: {
        class: '1',
        find: token,
        replace: 'with',
        note: 'n',
        evidence: `the transcription reads ${token}; the parallel reads "not to be filled with water, but with honeycombs"`,
      },
      expect: 'accept',
    },
  ];
  let bad = 0;
  for (const c of cases) {
    const v = vetFinding(c.f, { rawBody: rawAll, front, parallelShown });
    const got = v.reject ? 'reject' : 'accept';
    const ok = got === c.expect;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.name}: ${got}${v.reject ? ` (${v.reject})` : ''}`);
  }
  const noPar = vetFinding(
    { class: '2', find: token, replace: 'with', note: 'n', evidence: `the transcription's own context decides it: ${token} reads as with, plainly` },
    { rawBody: rawAll, front, parallelShown: '' },
  );
  const okNoPar = !noPar.reject;
  if (!okNoPar) bad++;
  console.log(
    `  ${okNoPar ? 'ok  ' : 'FAIL'} without a parallel excerpt the same evidence is accepted (the quote rule applies only when a parallel was supplied): ${noPar.reject || 'accepted'}`,
  );
  // parseRegionReply can salvage a truncated reply and must refuse a non-JSON one
  const good = parseRegionReply('{"findings":[{"class":"1","find":"a","replace":"b","note":"n","evidence":"e"},{"class":"2","find":"c","replace":"d","note":"n","evidence":"e"}],"unsure":[]}');
  const okParse = good && good.findings.length === 2;
  if (!okParse) bad++;
  console.log(`  ${okParse ? 'ok  ' : 'FAIL'} a whole reply parses: ${good ? good.findings.length + ' findings' : 'null'}`);
  const truncated = parseRegionReply('{"findings":[{"class":"1","find":"a","replace":"b","note":"n","evidence":"e"},{"class":"2","find":"c","repla');
  const okTrunc = truncated && truncated.findings.length === 1;
  if (!okTrunc) bad++;
  console.log(`  ${okTrunc ? 'ok  ' : 'FAIL'} a truncated reply is salvaged to its complete objects: ${truncated ? truncated.findings.length + ' findings' : 'null'}`);
  const okNonJson = parseRegionReply('I cannot answer that.') === null;
  if (!okNonJson) bad++;
  console.log(`  ${okNonJson ? 'ok  ' : 'FAIL'} a reply that is not JSON is refused`);
  console.log(bad === 0 ? 'fullread self-test: all assertions passed' : `fullread self-test: ${bad} assertion(s) FAILED`);
  return { selfTest: bad === 0 };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((r) => {
      if (r && r.selfTest === false) process.exit(1);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
