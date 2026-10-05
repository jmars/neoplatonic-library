#!/usr/bin/env node
/**
 * tools/review.mjs — the LLM review pass, as a TOOL and not as an editor
 * (plan §7, phase 3).
 *
 * WHAT IT IS FOR. The recorded rules catch what a census can see: a character the
 * transcription uses where a letter was lost, a printed number written through a
 * digit confusion, a division opener the print numbers. They cannot catch a
 * wrong-but-plausible word (`rpmntq` for `periods`), a phrase the transcription
 * mangled into something that still reads as English, or a line the rules made
 * worse. That is a reading job, and this is a reading tool.
 *
 * WHAT IT IS NOT. It never writes the rule list and it never rewrites the
 * transcription. Its output is a SEPARATE file of PROPOSED rules — a human reads
 * them and merges what they agree with. The architecture's promise is that
 * corrections travel as RULES, never as a second text; a pass that edited the text
 * directly would break that promise and destroy the diff, so the guard is explicit
 * in `write()` below: the output path must not be the rule list, and the only file
 * written is the proposals file.
 *
 * EVERY PROPOSAL CARRIES ITS EVIDENCE, OR IT IS REJECTED. A proposal must quote
 * the transcription's own characters — a `find` copied verbatim from the served
 * text plus an `evidence` string that contains it — or there is nothing for a
 * reviewer to check it against. The tool validates that mechanically and REJECTS
 * what fails, rather than passing it on with a shrug; the rejections are reported
 * in the output file and in the cost line, so the failure rate is visible.
 *
 * IT CAN SAY "UNSURE". Where the harm is real but the correct reading cannot be
 * determined from the source — this transcription is the only witness the tool
 * has, and a plausible guess is not a reading — the entry carries
 * `class: "review"` with the passage and the question instead of a guess. That
 * list is a deliverable: how many, and what each asks.
 *
 * WHAT IT COSTS is reported and measured: how much text was sent, how many
 * chunks, how many proposals, how many unsure, how many rejected, and the token
 * usage the endpoint reports. It merges NOTHING.
 *
 *   node tools/review.mjs [slug]
 *
 * Environment: LIBRARY_REVIEW_URL (an OpenAI-compatible /chat/completions
 * endpoint; defaults to the local cache proxy), LIBRARY_REVIEW_MODEL,
 * LIBRARY_REVIEW_BUDGET (characters per chunk), LIBRARY_REVIEW_MAX_TOKENS.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  extract,
  sha256,
  loadEdits,
  applyEditsCounted,
  editsPath,
  proposedPath,
  frontMatterText,
  hasEdition,
  readEdition,
} from './extract.mjs';
import { TEXTS } from './shelf.mjs';

const URL_ = process.env.LIBRARY_REVIEW_URL || 'http://10.0.0.1:8321/v1/chat/completions';
const MODEL = process.env.LIBRARY_REVIEW_MODEL || 'deepseek-flash';
const BUDGET = Number(process.env.LIBRARY_REVIEW_BUDGET || 11000);
// A reasoning model spends most of its budget thinking: MEASURED on this task, a
// ~11k-character chunk of corrected text costs ~20k completion tokens before the
// JSON starts. A small cap truncates the reasoning and returns NO content at all
// (finish_reason "length", an empty string), which reads like a refusal. So the
// cap is generous and the cost is reported.
const MAX_TOKENS = Number(process.env.LIBRARY_REVIEW_MAX_TOKENS || 80000);
/** The effort level to ask for, when the endpoint takes one. Left unset by
 * default: MEASURED, asking for "low" on this task did not shorten the reasoning
 * enough to leave room for an answer at any cap tried. */
const EFFORT = process.env.LIBRARY_REVIEW_EFFORT || null;
/** The classes a PROPOSAL may carry: the rule classes this text's rule list
 * allows. `review` is not among them — it is the class of an entry that asks a
 * question instead of proposing a rule, and it lives in `unsure`. */
const PROPOSAL_CLASSES = ['opener', 'digit', 'ocr'];

/** The shortest a piece of evidence can be and still quote anything: shorter than
 * this is a label ("OCR error"), not the transcription's characters. */
const MIN_EVIDENCE = 24;

/* ---------- what the tool is given to read ---------- */

/** The CORRECTED text, section by section — the reading view's own text, which is
 * what the pass must review (reviewing the raw transcription would re-derive the
 * repairs the recorded rules already make). Sections are then grouped into chunks
 * by a character budget, so a chunk is a run of WHOLE divisions: a proposal's
 * evidence can always be located in one division of the served text, and the chunk
 * a proposal came from is named by its divisions. */
export function correctedChunks(doc, budget = BUDGET) {
  const sections = [];
  let cur = null;
  let region = null;
  for (const b of doc.blocks) {
    if (b.t === 'region') {
      region = b.kind;
      // The front matter is out of bounds for any rule at all (plan §7: its
      // title page carries a reading a reading of this text cites as evidence),
      // and the back matter is the publisher's list, not the treatise —
      // neither is text this pass may propose a repair for. They are not sent, so
      // no proposal can be made about them.
      if (region !== 'body' && region !== 'notes') cur = null;
      continue;
    }
    if (b.t === 'sec') {
      cur = { n: b.n, parts: [] };
      sections.push(cur);
      continue;
    }
    if (!cur || (b.t !== 'p' && b.t !== 'verse' && b.t !== 'notedef')) continue;
    const text = applyEditsCounted(b.x, doc.corrections);
    cur.parts.push(b.t === 'notedef' ? `[note ${b.n}] ${text}` : text);
  }
  const chunks = [];
  let run = [];
  let size = 0;
  const flush = () => {
    if (!run.length) return;
    const first = run[0].n;
    const last = run[run.length - 1].n;
    chunks.push({
      title: first === last ? `section ${first}` : `sections ${first}\u2013${last}`,
      sections: run.map((s) => s.n),
      text: run.map((s) => s.parts.join('\n\n')).join('\n\n'),
    });
    run = [];
    size = 0;
  };
  for (const s of sections) {
    const len = s.parts.join('\n\n').length;
    if (size && size + len > budget) flush();
    run.push(s);
    size += len;
  }
  flush();
  return chunks;
}

/* ---------- the call ---------- */

const PROMPT = `You are reviewing a corrected OCR transcription of a printed book, for a reader that shows the transcription and a reading view side by side.

The text below is the CORRECTED text: the transcription's own words with the already-recorded repairs applied. The recorded repairs remove characters the transcription uses where a letter was lost, fix printed numbers written through digit confusion, and fix division numbers. They CANNOT catch a word that came through as a plausible but wrong word, a phrase mangled into something that still reads as English, or a passage the recorded rules made worse.

Find those. For each one give a rule, not a rewrite.

Reply with ONE JSON object and nothing else, in exactly this shape:

{"proposals":[{"find":"...","replace":"...","class":"ocr","note":"...","evidence":"..."}],
 "unsure":[{"class":"review","passage":"...","question":"...","note":"...","evidence":"..."}]}

Rules for a proposal:

- "find" MUST be copied character for character out of the text below, and must be long enough to be located there (a word or more). A find that does not occur in the text is worthless and will be rejected.
- "replace" is what the print has there. Do not change punctuation, capitalisation, spelling conventions, or anything that is a matter of style — only the damage.
- "class" is one of "ocr" (a transcription's character where the print has a letter), "digit" (a number the transcription got wrong), "opener" (a division number).
- "evidence" MUST contain the "find" string inside it, and must say what is wrong with those exact characters and why the replacement is warranted. Evidence that does not quote the transcription's own characters is rejected.

Use "unsure" when the harm is real but the correct reading CANNOT be determined from this text alone: put the damaged passage in "passage" and the question a human must answer in "question". Do not guess. Do not propose a rule "to be safe". Report what the text supports and nothing else.

Never rewrite the text. Never propose a change to the book's own wording.

THE TEXT:
`;

async function call(model, prompt) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      ...(EFFORT ? { effort: EFFORT } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`the endpoint answered ${res.status} ${res.statusText}`);
  const body = await res.json();
  const choice = (body.choices || [])[0] || {};
  return {
    content: (choice.message || {}).content || '',
    usage: body.usage || null,
    finish: choice.finish_reason || null,
  };
}

/** The model's reply as JSON. A reply wrapped in a code fence is unwrapped rather
 * than thrown away: the fence is an instruction-following miss, not a failure to
 * answer, and the tool's own validation is what decides whether the answer is
 * usable. */
export function parseReply(content) {
  const trimmed = String(content).trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    return {
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      unsure: Array.isArray(parsed.unsure) ? parsed.unsure : [],
    };
  } catch {
    return null;
  }
}

/* ---------- validation: a proposal with no evidence is not reviewable ---------- */

/**
 * Check one proposal against the text it claims to repair, and either return the
 * entry that will be written out or a REASON it is rejected. Every rejection is a
 * mechanical fact about the proposal (it is not in the text, it quotes nothing,
 * its class is not one of the text's), never a judgement about the reading — the
 * reading is the human's job, and the tool's is to hand them only what can be
 * checked.
 */
export function vetProposal(p, { text, front, taken }) {
  const find = typeof p.find === 'string' ? p.find : '';
  const replace = typeof p.replace === 'string' ? p.replace : '';
  const cls = typeof p.class === 'string' ? p.class : '';
  const note = typeof p.note === 'string' ? p.note : '';
  const evidence = typeof p.evidence === 'string' ? p.evidence : '';
  if (!find) return { reject: 'no find' };
  if (!replace) return { reject: 'no replace' };
  if (find === replace) return { reject: 'the replacement is the find' };
  if (!text.includes(find)) return { reject: 'the find does not occur in the corrected text' };
  if (front && front.includes(find)) return { reject: 'the find stands in the front matter, which no rule may touch' };
  if (taken.has(find)) return { reject: 'a recorded rule already matches this find' };
  if (!PROPOSAL_CLASSES.includes(cls)) return { reject: `class "${cls}" is not one of ${PROPOSAL_CLASSES.join('/')}` };
  if (evidence.length < MIN_EVIDENCE) return { reject: `the evidence is ${evidence.length} characters — too short to quote anything` };
  if (!evidence.includes(find)) return { reject: 'the evidence does not quote the transcription\'s own characters (the find is not in it)' };
  if (!note) return { reject: 'no note' };
  return { class: cls, find, replace, note, evidence };
}

/** One unsure entry: the harm is stated, the question is asked, and there is no
 * `replace` — because the tool does not know one, and inventing it is the thing
 * this branch exists to avoid. */
export function vetUnsure(u, { text }) {
  const passage = typeof u.passage === 'string' ? u.passage : '';
  const question = typeof u.question === 'string' ? u.question : '';
  const note = typeof u.note === 'string' ? u.note : '';
  const evidence = typeof u.evidence === 'string' ? u.evidence : '';
  if (!passage) return { reject: 'no passage' };
  if (!question) return { reject: 'no question — an unsure entry must ask something specific' };
  if (evidence.length < MIN_EVIDENCE) return { reject: 'no evidence quoted' };
  // whether the passage could be LOCATED is worth stating: an unsure entry whose
  // passage is not in the text is a question about something the reviewer cannot
  // find, and saying so is cheaper than having them hunt for it
  return { class: 'review', passage, question, note, evidence, inText: text.includes(passage) };
}

/* ---------- the run ---------- */

function write(slug, payload) {
  const out = proposedPath(slug);
  // THE GUARD, stated where it can fail: this tool writes PROPOSALS and nothing
  // else. If the two paths were ever the same, the next line would overwrite the
  // reviewable rule list with a machine's suggestions and quietly destroy the
  // record of what a human approved.
  if (out === editsPath(slug)) throw new Error('library: the proposals path and the rules path are the same — refusing to write');
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  return out;
}

async function main() {
  const slug = process.argv[2] || (TEXTS.find((t) => hasEdition(t.slug)) || {}).slug;
  if (!slug || !hasEdition(slug)) {
    console.error('usage: node tools/review.mjs <slug>\n  The slug must have a stored edition (data/editions/<slug>/).');
    process.exit(2);
  }
  const entry = TEXTS.find((t) => t.slug === slug);
  const src = readEdition(slug);
  const doc = extract(src, { entry, sha256: sha256(src) });
  const { edits } = loadEdits(slug);
  const taken = new Set(edits.map((c) => c.find));
  const front = frontMatterText(doc);
  const chunks = correctedChunks(doc);
  const sentChars = chunks.reduce((a, c) => a + c.text.length, 0);

  console.log(
    `library review: ${slug}\n` +
      `  reading ${sentChars} characters of corrected text in ${chunks.length} chunk(s), ` +
      `${edits.length} recorded rule(s), model ${MODEL}\n` +
      `  endpoint ${URL_}`,
  );

  const proposals = [];
  const unsure = [];
  const rejected = [];
  const failed = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for (const chunk of chunks) {
    let reply;
    try {
      reply = await call(MODEL, `${PROMPT}${chunk.text}\n`);
    } catch (e) {
      failed.push({ chunk: chunk.title, error: e.message });
      console.log(`  ${chunk.title}: FAILED — ${e.message}`);
      continue;
    }
    if (!reply.content.trim()) {
      failed.push({ chunk: chunk.title, error: `no answer: finish ${reply.finish} (the budget was spent before the answer began)` });
      console.log(`  ${chunk.title}: FAILED — no answer (finish ${reply.finish})`);
      continue;
    }
    if (reply.usage) {
      for (const k of Object.keys(usage)) usage[k] += reply.usage[k] || 0;
    }
    const parsed = parseReply(reply.content);
    if (!parsed) {
      failed.push({ chunk: chunk.title, error: `the reply was not the JSON asked for (${reply.content.slice(0, 80)})` });
      console.log(`  ${chunk.title}: FAILED — the reply was not JSON`);
      continue;
    }
    let kept = 0;
    let asked = 0;
    for (const p of parsed.proposals) {
      const v = vetProposal(p, { text: chunk.text, front, taken });
      if (v.reject) rejected.push({ reason: v.reject, proposal: p });
      else {
        proposals.push(v);
        kept++;
        taken.add(v.find); // two proposals for one find are one proposal
      }
    }
    for (const u of parsed.unsure) {
      const v = vetUnsure(u, { text: chunk.text });
      if (v.reject) rejected.push({ reason: v.reject, proposal: { class: 'review', ...u } });
      else {
        unsure.push(v);
        asked++;
      }
    }
    console.log(
      `  ${chunk.title}: ${kept}/${parsed.proposals.length} proposal(s) kept, ` +
        `${asked}/${parsed.unsure.length} unsure, finish ${reply.finish}`,
    );
  }

  const payload = {
    slug,
    tool: 'an LLM review pass over the corrected text: it proposes rules and a human merges them',
    model: MODEL,
    generated: new Date().toISOString().slice(0, 19) + 'Z',
    mergesNothing:
      'Nothing here has been merged. To accept a proposal, add it to the rules file with the same ' +
      'class and note, in its class group, and build: every rule must fire at least once or the ' +
      'build fails. To accept an "unsure" entry, someone has to answer its question from a source ' +
      'this tool does not have — the transcription is the only witness it was given.',
    proposals,
    unsure,
    rejected,
    failed,
    cost: {
      chunks: chunks.length,
      sentChars,
      recordedRules: edits.length,
      proposals: proposals.length,
      unsure: unsure.length,
      rejected: rejected.length,
      failed: failed.length,
      usage,
    },
  };
  const out = write(slug, payload);
  console.log(
    `\nlibrary review: ${out.split('/').slice(-1)[0]} — ${proposals.length} proposal(s), ` +
      `${unsure.length} unsure, ${rejected.length} rejected, ${failed.length} chunk(s) failed\n` +
      `  cost: ${sentChars} characters sent in ${chunks.length} chunk(s); tokens ` +
      `${usage.prompt_tokens} in / ${usage.completion_tokens} out\n` +
      `  NOTHING WAS MERGED. The rules file is untouched.`,
  );
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
