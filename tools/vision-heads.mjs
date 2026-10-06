#!/usr/bin/env node
/**
 * tools/vision-heads.mjs — read a stored scan's RUNNING HEAD with the local
 * vision model, and cache the reading as DATA.
 *
 * WHY THIS EXISTS. The OCR of this edition destroyed its numbering: the running
 * heads carry the book (`ON THE THEOLOGY. BOOK VI.`) and the chapter
 * (`CHAP. VII. OF PLATO.`), and the transcription writes those numerals as
 * `BOOK oe`, `BOOK 1h`, `BOOK actrees`, `CHAP. au.`, `CHAP REX`. A numeral read
 * off the scan by a model that can SEE the page is the only honest source for
 * the divisions; matching the mangled OCR against a fuzzy numeral pattern is
 * what the earlier attempt did, and it attributed divisions to the wrong book
 * (silent-wrong).
 *
 * WHAT IT WRITES. `data/editions/<slug>/heads.json` — one record per leaf,
 * written ATOMICALLY after every completed leaf, so a crash loses at most the
 * requests in flight and a re-run reads the cache instead of calling the model
 * again (a leaf already in the file is never re-asked).
 *
 * Record shape (the brief's): { leaf, page, head, heading, raw } — plus `at`
 * (when the reading was taken) and `model` (which model read it). `raw` is the
 * model's answer verbatim, so a parser bug can be re-run against the readings
 * without another vision pass.
 *
 * USAGE
 *   node tools/vision-heads.mjs <slug> [--limit N] [--concurrency N]
 *
 * The endpoint and the model come from LIBRARY_HEADS_URL / LIBRARY_HEADS_MODEL. The
 * DEFAULT is the DeepInfra VL proxy (10.0.0.1:8322), whose models read this print's
 * page images where the DeepSeek vision model returns EMPTY (its reasoning burns the
 * output budget); the library's standing order still points its text work at the
 * DeepSeek proxy on 10.0.0.1:8321, and setting LIBRARY_HEADS_URL returns this tool
 * there. No key is sent — the proxy injects it. See the `vision` skill. Everything
 * sent is treated as leaving the machine.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = process.env.LIBRARY_HEADS_URL || 'http://10.0.0.1:8322/v1/chat/completions';
const MODEL = process.env.LIBRARY_HEADS_MODEL || 'Qwen/Qwen3-VL-235B-A22B-Instruct';
const REQUEST_TIMEOUT_MS = 300_000;
/* MEASURED CAP. The model's reasoning runs to several thousand tokens on a page
 * that carries TWO chapter headings (v1-n312 reads `CHAPTER VIII.` at the top and
 * `CHAPTER IX.` further down, and the model deliberates over which the prompt
 * wants), so a cap of 3000 truncated it to an EMPTY answer six attempts running.
 * At 8000 the same leaf answers correctly. The cap is a truncation bound, not a
 * budget: an answer that stops early costs what it costs. */
const MAX_TOKENS = 8000;

/** What is asked of the model, verbatim, for every leaf. It asks for the three
 * things the divisions rest on — the running head, a heading printed in the
 * body, and a printed page number — and for nothing else: a caption, a
 * summary, or a reading of the text is not evidence the extraction can use, and
 * asking for more only gives the model more room to invent. */
const PROMPT =
  'Answer immediately with the JSON object only. Do not deliberate.\n' +
  'This is a scanned page from an 1816 book. Read the printed text and report ONLY what is printed, verbatim.\n' +
  'Return a JSON object with exactly these keys:\n' +
  '  "head": the running head — the line or lines at the very top of the page above the main text — verbatim, or "" if none;\n' +
  '  "heading": any chapter or book heading printed IN the page body (e.g. "CHAP. VII.", "CHAPTER XII.", "BOOK VI."), verbatim, or "" if none;\n' +
  '  "page": the printed page number if one is printed, as a string, or "" if none.\n' +
  'Answer with the JSON object only, no prose.';

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
if (!slug) {
  console.error('usage: node tools/vision-heads.mjs <slug> [--limit N] [--concurrency N]');
  process.exit(2);
}
const limit = opt('limit', Infinity);
const concurrency = opt('concurrency', 6);

const editionDir = join(ROOT, 'data', 'editions', slug);
const scanDir = join(editionDir, 'scans');
const outPath = join(editionDir, 'heads.json');
if (!existsSync(scanDir)) throw new Error(`no scans for ${slug} at ${scanDir}`);

const leaves = readdirSync(scanDir)
  .filter((f) => /\.(?:jpe?g|png|webp)$/i.test(f))
  .sort()
  .slice(0, limit);

/** The cache, read once and rewritten (atomically) after every leaf. A leaf in
 * here is never asked again — that is the whole point of the file. */
const cache = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { slug, model: MODEL, leaves: {} };
if (!cache.leaves) cache.leaves = {};

const write = () => {
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 1));
  renameSync(tmp, outPath);
};

/** The model answers with a JSON object, but a thinking model sometimes fences
 * it or wraps it in a sentence. Take the first balanced {...} that parses; if
 * none does, keep the text as `raw` with empty fields — the reading is not lost,
 * it is just not yet parseable. */
function parseAnswer(text) {
  if (!text) return { head: '', heading: '', page: '' };
  const start = text.indexOf('{');
  if (start >= 0) {
    for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
      try {
        const o = JSON.parse(text.slice(start, end + 1));
        if (o && typeof o === 'object') {
          const s = (v) => (v == null ? '' : String(v));
          return { head: s(o.head), heading: s(o.heading), page: s(o.page) };
        }
      } catch {
        /* try a shorter span */
      }
    }
  }
  return { head: '', heading: '', page: '' };
}

async function readLeaf(leaf) {
  const buf = readFileSync(join(scanDir, leaf));
  const mime = extname(leaf).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // NOTE ON EFFORT. The model is a THINKING model whose reasoning RUNS AWAY
    // nondeterministically on this task: MEASURED, the identical request for
    // v1-n102 spent all 3000 tokens on reasoning and returned empty content
    // twice, then stopped at 2506 reasoning tokens with the right answer on the
    // third try. `reasoning_effort: "low"` suppresses the runaway but ALSO
    // produces empty answers for pages that carry a head (v1-n103 and v1-n105
    // read correctly at the default effort and empty under "low"), so it is not
    // used: the directives in the prompt below are what bound the reasoning, and
    // an empty answer is RETRIED (see readLeaf) rather than cached.
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
        ],
      },
    ],
  };
  for (let attempt = 1; attempt <= 6; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(`HTTP ${res.status}: ${json.error ? json.error.message : ''}`);
      const choice = (json.choices && json.choices[0]) || {};
      const text = (choice.message && choice.message.content) || '';
      // AN EMPTY ANSWER IS A FAILED READING, not a page with no head: the page
      // may well carry one, and the model simply ran its reasoning to the token
      // cap (or stopped) without writing a word (MEASURED: v1-n102 and v1-n106
      // both do this, each answering correctly on a later try). ANY empty answer
      // is retried, whatever the finish reason says. A page that is GENUINELY
      // blank comes back as valid JSON with empty FIELDS — that is a reading and
      // it is kept as one; only a wholly empty answer is a failure.
      if (text.trim() === '' && attempt < 6) continue;
      const { head, heading, page } = parseAnswer(text);
      return { page, head, heading, raw: text, bytes: buf.length, at: new Date().toISOString(), model: MODEL };
    } catch (e) {
      if (attempt === 6) return { error: String(e && e.message ? e.message : e) };
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    } finally {
      clearTimeout(t);
    }
  }
}

const todo = leaves.filter((l) => !cache.leaves[l]);
console.log(
  `${slug}: ${leaves.length} leaf/leaves in view, ${leaves.length - todo.length} already read, ${todo.length} to ask ` +
    `(concurrency ${concurrency})`,
);
let done = 0;
let failed = 0;
let next = 0;
async function worker() {
  while (next < todo.length) {
    const leaf = todo[next++];
    const rec = await readLeaf(leaf);
    done++;
    if (rec.error) {
      failed++;
      console.log(`${leaf} FAILED: ${rec.error}`);
    } else {
      cache.leaves[leaf] = rec;
      write();
      console.log(
        `[${done}/${todo.length}] ${leaf} page=${JSON.stringify(rec.page)} head=${JSON.stringify(rec.head)} ` +
          `heading=${JSON.stringify(rec.heading)}`,
      );
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
write();
console.log(`${slug}: ${done - failed} read, ${failed} failed; cache at ${outPath}`);
