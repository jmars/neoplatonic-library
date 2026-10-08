#!/usr/bin/env node
/**
 * tools/fold-probe.mjs — THE READING-VIEW FOLD GATE.
 *
 * WHY THIS EXISTS. On 2026-10-07 the served reading view read
 * `supermundaneessential`, `supermundanemundane` and `about unsure God` while
 * the gates were green. Every one of them measured the BLOCK domain — the
 * extraction's own `editReport`, which walks every block's own text: paragraph
 * text, running heads, page markers, chapter heads. The reader does not fold that
 * domain. It folds the INLINE RUNS IT RENDERS, and it replaces EVERY occurrence
 * of a rule's find (Elm `Reader.Document.applyCorrections`: plain substring, all
 * occurrences, in rule order). A rule whose find is not unique to the point it
 * was written for therefore rewrites every other point carrying the same text —
 * and nothing asserted a rule's SCOPE, only that it fired at least once somewhere
 * (`checkEdits`). `correctionsMeta.repeated` is the same block-domain list and is
 * NOT this instrument: it names the watermark rule that fires 135× in the block
 * domain while the reading view suppresses every one of those 135 running heads.
 *
 * WHAT IT ASSERTS, and what would break each:
 *
 *  1. THE FOLD. The reading-view domain is derived from the served document the
 *     way the reader derives it (`elm/src/Reader/Document.elm`
 *     `flow`/`step`/`appendOrOpen`, `elm/src/Reader.elm` `inlineView`/
 *     `noteTexts`): paragraph and verse text is folded one run at a time, a
 *     note's pieces are joined with a space and folded as one run, and the
 *     running heads, page markers, section heads, region heads and references
 *     are NOT folded at all — the reading view suppresses them
 *     (`FRh x -> if m.view == Transcription … else text ""`) or renders chrome
 *     (a page number) in their place. A rule's reading-view hit count is the
 *     number of occurrences AT THE MOMENT the rule is applied, summed over those
 *     runs.
 *     FAILS IF: the derivation is not the reader's — assertion 5 measures that.
 *
 *  2. SCOPE. A rule that fires in the reading view fires EXACTLY ONCE, unless its
 *     rule file carries `scope`:
 *       "all"     — the find is a form the print cannot set at ANY occurrence (a
 *                   garble, an impossible mark sequence, a word doubled), so the
 *                   rule repairs every one; `scope_why` records what measured it;
 *       "flagged" — the multiplicity is REAL and NOT RESOLVED in this version:
 *                   the rule fires where the print's own text may stand, and the
 *                   evidence to decide it is not in hand. `scope_why` says what
 *                   would decide it. A flagged rule is a FINDING, not a licence.
 *     FAILS IF: a rule without `scope` fires more than once in the reading view —
 *     a rule whose scope is a lie. The fix is a context-unique find.
 *
 *  3. PARITY. `fires` (the model's own number, written from the BLOCK domain,
 *     where the fire contract lives) equals the block-domain count measured here,
 *     and the reading-view count never exceeds it.
 *     FAILS IF: a stored number has gone stale, or a rule fires more in the
 *     reading view than the block domain can account for.
 *
 *  4. THE SENTINEL IS NOT SERVED. No rule may replace text with a bare sentinel
 *     WORD. The model used `unsure` for "no reading is recorded here" and the
 *     reader has NO case for it, so the reading view served the English word
 *     inline — 12 times in 1.0.6, three of them destroying real words (`about
 *     unsure God`, `so Parmenides first unsure`, and a whole damaged critical
 *     note). A rule with no reading to record uses a DAMAGE CHARACTER, which the
 *     reader already marks (`Reader.elm` `damageSpans`, title "damage in the
 *     transcription here — no reading is recorded for this word"), or
 *     `action: "leave"`, which shows the transcription's own characters.
 *     FAILS IF: a rule's `after` is a word on the sentinel list below.
 *
 *  5. WHAT THE READER ACTUALLY RENDERED (against a built tree). The built shell
 *     is booted in happy-dom exactly as `tools/library-app-smoke.mjs` boots it,
 *     the served `/t` is handed to it, and EVERY paragraph's folded text must
 *     appear verbatim in the rendered reading view.
 *     FAILS IF: this gate folds a domain the reader does not fold — the
 *     instrument's own check on itself. MEASURED before this gate existed:
 *     163 of 163 paragraphs (Cave), 2,543 of 2,543 (Theology).
 *
 *  6. WHAT IT REPORTS AND DOES NOT FIX. The other two editions are served at
 *     their own versions under their own DOIs; their unscoped multi-fire rules
 *     are REPORTED with their sites and their counts PINNED — a silent increase
 *     fails. Fixing them is a separate version and a separate deposit, which is a
 *     decision, not this gate's. Rules that fire in the block domain but never in
 *     the reading view are reported the same way: they repair furniture the
 *     reading view suppresses, so they are inert in it and their `fires` is a
 *     block-domain number.
 *
 * Run against a built tree:
 *
 *     node build/build.mjs && node tools/fold-probe.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extract,
  editReport,
  readEdition,
  readMeta,
  repairsPath,
  sha256,
  versionOf,
} from '../tools/extract.mjs';
import { TEXTS, isPublished } from '../tools/shelf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'site', 'dist');

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};
const section = (name) => console.log(`\n${name}`);

if (!existsSync(DIST)) {
  console.error('fold-probe: site/dist is not built — run node build/build.mjs first');
  process.exit(1);
}

/* ---------- 4. the sentinel list, named rather than derived ---------- */

/** The words the model once used to mean "no reading recorded here". A sentinel
 * is not a reading: the reader has no case for one, so it is served as English
 * prose in the middle of a sentence. Named here so the record survives the
 * field's removal from the data: a future rule that reaches for `unsure` again
 * fails this gate rather than being read as a word by the next reader. */
const SENTINELS = ['unsure'];

/* ---------- 6. the states this gate finds unresolved, and what is done with each ---------- */

/** THE PRE-FIX RECORD — the corruption this instrument exists to see, kept as
 * its own asymmetry proof. `proclus-theology-of-plato-taylor-1816@1.0.6` is
 * FROZEN (a state under its own DOI), so its rule list cannot change: every run
 * of this gate re-derives the same defect and asserts it is still visible. A gate
 * that cannot be shown to fail on a known-bad state is a gate nobody should trust
 * — and this state is the one that twelve green gates walked past. The assertion
 * is that the count MATCHES and the named rules are among them; if this row ever
 * passes with no unscoped rule, the instrument has stopped seeing. */
const PRE_FIX = new Map([
  [
    'proclus-theology-of-plato-taylor-1816@1.0.6',
    {
      unscoped: 135,
      mustInclude: ['r11094', 'r10934'],
      sentinel: 31,
      note: 'the served reading view reads supermundaneessential, supermundanemundane and about unsure God in this state',
    },
  ],
]);

/** THE STATES REPORTED AND NOT FIXED HERE. Each of the other two editions is
 * served under its own version and its own DOI: changing its rules is a separate
 * version and a separate deposit, which is a decision this gate does not make.
 * The count is PINNED, so a silent increase fails here instead of shipping — and
 * MEASURED, every one of them is the same class as the Theology's (a garble or a
 * mis-spaced word: `imparticipate`, `cold ness`, `Capri corn`, `Phcedrus`), i.e.
 * a repair that belongs at every occurrence and simply has no `scope` field yet. */
const NOT_FIXED_HERE = new Map([
  [
    'proclus-elements-of-theology-taylor-1816@1.0.0',
    { unscoped: 1, note: 'reported: a separate version and DOI are a separate decision' },
  ],
  [
    'porphyry-on-the-cave-of-the-nymphs-taylor-1917@1.0.0',
    { unscoped: 7, note: 'reported: a separate version and DOI are a separate decision' },
  ],
]);

/** The versions whose reading-view-inert rule count is pinned. A rule that
 * repairs furniture the reading view suppresses is inert in it; the count is
 * pinned so a rule that STOPS being served cannot arrive unnoticed. */
const INERT = new Map([
  ['proclus-theology-of-plato-taylor-1816@1.0.6', 193],
]);

/* ---------- the fold, as the reader does it ---------- */

/** The reading-view fold domain: the runs the reader passes to `applyIndexed`,
 * in document order. One entry per run, `src` naming the block it came from so a
 * reported site can be traced back. See the header for the exact source lines
 * this reproduces. */
function foldDomain(doc) {
  const out = [];
  let note = null;
  const flush = () => {
    if (note) {
      out.push({ src: `note ${note.n}`, s: note.texts.join(' ') });
      note = null;
    }
  };
  for (const b of doc.blocks) {
    if (b.t === 'notedef') {
      if (note && note.n === b.n) note.texts.push(b.x);
      else {
        flush();
        note = { n: b.n, texts: [b.x] };
      }
      continue;
    }
    flush();
    if (b.t === 'p') out.push({ src: 'p', s: b.x });
    else if (b.t === 'verse') for (const line of String(b.x).split('\n')) out.push({ src: 'verse', s: line });
    /* pb, rh, sec, region and ref are not folded: the reading view renders a
     * page NUMBER in a marker's place, suppresses a running head entirely, and
     * takes a reference's words from the note it points at (folded once, as the
     * note). */
  }
  flush();
  return out;
}

/** Apply a rule list to one run, in order, every occurrence — the reader's own
 * `applyCorrections`, with each rule's hits counted AT THE MOMENT it is applied,
 * which is the only count that means anything when order decides. */
function foldHits(rules, domain) {
  const hits = rules.map(() => 0);
  const sites = rules.map(() => []);
  for (const d of domain) {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (!r.find || r.action === 'leave' || r.find === r.repl) continue;
      if (!d.s.includes(r.find)) continue;
      const parts = d.s.split(r.find);
      hits[i] += parts.length - 1;
      if (sites[i].length < 3) sites[i].push({ src: d.src, at: Math.max(0, d.s.indexOf(r.find) - 40), ctx: d.s.slice(Math.max(0, d.s.indexOf(r.find) - 40), d.s.indexOf(r.find) + r.find.length + 30) });
      d.s = parts.join(r.repl);
    }
  }
  return { hits, sites };
}

/** Fold one run with a rule list — the same semantics, no counting. Assertion 5
 * uses it to ask what the reader should have rendered for each paragraph. */
function foldOne(rules, s) {
  let out = s;
  for (const r of rules) {
    if (!r.find || r.action === 'leave' || r.find === r.repl) continue;
    if (!out.includes(r.find)) continue;
    out = out.split(r.find).join(r.repl);
  }
  return out;
}

/* ---------- the versions this gate folds ---------- */

const served = TEXTS.filter(isPublished);

/** The current version of every edition that has one, plus the pinned pre-fix
 * record (a frozen state, so its row is a fact and not a snapshot). */
function rows() {
  const out = [];
  for (const t of served) {
    const v = versionOf(t.slug);
    if (!v) continue;
    out.push({ entry: t, version: v, current: true });
    const key = `${t.slug}@1.0.6`;
    if (v !== '1.0.6' && PRE_FIX.has(key) && existsSync(join(ROOT, 'data', 'editions', ...key.split('@')[0].split('/'), 'versions', '1.0.6'))) {
      out.push({ entry: t, version: '1.0.6', current: false });
    }
  }
  return out;
}

const foldedRows = [];

for (const row of rows()) {
  const { entry, version, current } = row;
  const key = `${entry.slug}@${version}`;
  section(`${entry.slug} v${version}${current ? ' (current)' : ' (frozen)'} — the reading-view fold`);

  const src = readEdition(entry.slug, version);
  const doc = extract(src, { entry, sha256: sha256(src), version });
  const raw = JSON.parse(readFileSync(repairsPath(entry.slug, version), 'utf8'));
  const rules = doc.corrections;

  /* THE MAPPING THE IDS REST ON: `doc.corrections` is built from this file in
   * order, so index i is repairs.json rule i. Asserted, not assumed — an id
   * reported against the wrong rule is worse than no report. */
  const aligned =
    raw.rules.length === rules.length && raw.rules.every((r, i) => r.location && r.location.find === rules[i].find);
  check(aligned, `the served corrections are repairs.json rule for rule (${rules.length} rules)`);
  if (!aligned) continue;
  const idOf = (i) => raw.rules[i].id.replace(`${entry.slug}:`, '');

  const domain = foldDomain(doc);
  const { hits, sites } = foldHits(rules, domain.map((d) => ({ ...d })));
  const report = editReport(doc.blocks, rules);
  const block = report.map((r) => r.hits);
  foldedRows.push({ key, entry, version, current, doc, domain, rules, hits, raw });

  /* 3. PARITY ------------------------------------------------------------ */
  const stale = [];
  const over = [];
  for (let i = 0; i < rules.length; i++) {
    if (raw.rules[i].fires !== block[i]) stale.push(`${idOf(i)} (stored ${raw.rules[i].fires}, block ${block[i]})`);
    if (hits[i] > block[i]) over.push(`${idOf(i)} (reading ${hits[i]}, block ${block[i]})`);
  }
  check(
    stale.length === 0,
    `every rule's stored \`fires\` is the block-domain count measured here${stale.length ? ` — ${stale.length} stale: ${stale.slice(0, 4).join(', ')}` : ` (${rules.length} rules)`}`,
  );
  check(
    over.length === 0,
    `no rule fires more in the reading view than in the block domain${over.length ? ` — ${over.length}: ${over.slice(0, 4).join(', ')}` : ''}`,
  );

  /* 2. SCOPE ------------------------------------------------------------- */
  const unscoped = [];
  const licensed = { all: 0, flagged: 0 };
  for (let i = 0; i < rules.length; i++) {
    if (hits[i] <= 1) continue;
    const sc = raw.rules[i].scope;
    if (sc === 'all' || sc === 'flagged') licensed[sc]++;
    else unscoped.push(i);
  }
  const names = unscoped.map(idOf);
  const preFix = PRE_FIX.get(key);
  const pinned = NOT_FIXED_HERE.get(key);
  if (preFix) {
    /* THE INSTRUMENT'S OWN ASYMMETRY PROOF: this frozen state is the corruption
     * the scope assertion exists to catch, and it must still be visible. */
    const missing = preFix.mustInclude.filter((x) => !names.includes(x));
    check(
      unscoped.length === preFix.unscoped && missing.length === 0,
      `THE INSTRUMENT SEES THE PRE-FIX CORRUPTION: ${unscoped.length} unscoped multi-fire rules in this frozen state` +
        (missing.length ? ` — NOT seen: ${missing.join(', ')} (the gate has stopped detecting it)` : ``) +
        ` (pinned ${preFix.unscoped}; ${preFix.note})`,
    );
    console.log(`         the same code path FAILS a current version with this result — that is the assertion below, on the version that fixes it.`);
  } else if (pinned) {
    check(
      unscoped.length === pinned.unscoped,
      `the reading view's unscoped multi-fire rules: ${unscoped.length} (pinned ${pinned.unscoped} — ${pinned.note})`,
    );
  } else {
    check(
      unscoped.length === 0,
      `every rule that fires in the reading view fires ONCE, or carries a scope licence (${licensed.all} licensed "all", ${licensed.flagged} flagged)`,
    );
  }
  if (unscoped.length) {
    console.log(`         unscoped multi-fire rules (up to 8 shown):`);
    for (const i of unscoped.slice(0, 8)) {
      console.log(`           ${idOf(i)}  fires ${hits[i]}×  ${JSON.stringify(rules[i].find)} → ${JSON.stringify(rules[i].repl)}`);
      for (const s of sites[i].slice(0, 2)) console.log(`             ${s.src}: …${JSON.stringify(s.ctx)}…`);
    }
    if (names.includes('r11094') && names.includes('r10934')) {
      console.log(`         THE CORRUPTION IS LIVE: r11094 ('super-' → 'supermundane') and r10934 ('exempts' → 'exempt') rewrite text that is not theirs.`);
    }
  }

  /* 4. THE SENTINEL ------------------------------------------------------ */
  const sent = raw.rules.filter((r) => SENTINELS.includes(r.after));
  if (preFix) {
    /* The pre-fix record carries the defect as a COUNT, and the assertion is that
     * the instrument still sees it — the same asymmetry proof as the scope row. */
    check(
      sent.length === preFix.sentinel,
      `THE INSTRUMENT SEES THE PRE-FIX SENTINEL: ${sent.length} rule(s) serve a bare sentinel word in this frozen state (pinned ${preFix.sentinel})` +
        (sent.length !== preFix.sentinel ? ' — the count has moved' : ` — ${sent.slice(0, 3).map((r) => r.id.replace(`${entry.slug}:`, '')).join(', ')}, …`),
    );
  } else {
    check(
      sent.length === 0,
      `no rule serves a sentinel word as a reading (${SENTINELS.join(', ')})${sent.length ? ` — ${sent.length} rule(s): ${sent.slice(0, 4).map((r) => `${r.id.replace(`${entry.slug}:`, '')} → ${JSON.stringify(r.after)}`).join(', ')}` : ''}`,
    );
  }

  /* 6. WHAT IS INERT IN THE READING VIEW -------------------------------- */
  const inert = [];
  for (let i = 0; i < rules.length; i++) if (block[i] > 0 && hits[i] === 0) inert.push(i);
  const inertPin = INERT.get(key);
  if (inertPin !== undefined) {
    check(
      inert.length === inertPin,
      `rules that fire only outside the reading view: ${inert.length} (pinned ${inertPin} for this state)`,
    );
  } else {
    console.log(`  —    ${inert.length} rule(s) fire in the block domain and never in the reading view (furniture the view suppresses; reported, not pinned for this state)`);
  }
  if (inert.length) {
    const kinds = {};
    for (const i of inert) for (const k of report[i].kinds) kinds[k] = (kinds[k] || 0) + 1;
    console.log(`         they stand in blocks of type ${Object.entries(kinds).map(([k, n]) => `${k}:${n}`).join(', ')}`);
  }
}

/* ---------- 5. the reader's own rendering, against this fold ---------- */

section('the fold this gate derives is the fold the reader runs');

function happyDom() {
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.HAPPY_DOM,
    join(ROOT, 'node_modules', 'happy-dom'),
    join(ROOT, '..', 'fixpoint-linux', 'fixpointlinux.org', 'node_modules', 'happy-dom'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return require(c).Window;
  throw new Error(`happy-dom not found (looked in ${candidates.join(', ')}; set HAPPY_DOM=...)`);
}

/** Boot the built shell the way a browser does: parse it, then run its scripts in
 * document order. The same shape as tools/library-app-smoke.mjs, because a
 * second way of booting the app would be a second thing to be wrong. */
async function bootReading(slug, docText) {
  const Window = happyDom();
  const html = readFileSync(join(DIST, 'texts', slug, 'index.html'), 'utf8');
  const w = new Window({ url: `http://localhost/texts/${slug}/` });
  const names = [
    'window', 'document', 'navigator', 'location', 'history', 'customElements', 'performance',
    'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage',
    'getComputedStyle', 'matchMedia', 'IntersectionObserver', 'HTMLElement', 'HTMLDivElement',
    'HTMLSpanElement', 'HTMLAnchorElement', 'HTMLButtonElement', 'HTMLInputElement',
    'HTMLParagraphElement', 'Element', 'Node', 'Document', 'DocumentFragment', 'Text', 'Comment',
    'NodeList', 'HTMLCollection', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'UIEvent',
    'EventTarget', 'MutationObserver',
  ];
  const bound = new Set(['requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia']);
  for (const n of names) {
    const v = w[n];
    if (v === undefined) continue;
    Object.defineProperty(globalThis, n, {
      value: bound.has(n) && typeof v === 'function' ? v.bind(w) : v,
      configurable: true,
      writable: true,
    });
  }
  globalThis.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve(docText) });
  globalThis.setTimeout = w.setTimeout.bind(w);
  globalThis.clearTimeout = w.clearTimeout.bind(w);
  const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'));
  const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  w.document.head.innerHTML = head;
  w.document.body.innerHTML = body;
  const scripts = [...w.document.querySelectorAll('script')].filter((s) => {
    const t = s.getAttribute('type');
    return !t || /javascript|module/i.test(t);
  });
  try {
    delete globalThis.Elm;
  } catch {
    globalThis.Elm = undefined;
  }
  for (const s of scripts) (0, eval)(s.textContent);
  for (let i = 0; i < 12; i += 1) await sleep(15);
  return { app: w.document.getElementById('reader-app'), text: () => (w.document.getElementById('reader-app') || { textContent: '' }).textContent };
}

for (const row of foldedRows.filter((r) => r.current)) {
  const { entry, version } = row;
  const builtDoc = join(DIST, 'texts', entry.slug, 't');
  if (!existsSync(builtDoc)) {
    check(false, `${entry.slug}: the built document exists (${builtDoc.slice(ROOT.length + 1)})`);
    continue;
  }
  const rendered = await bootReading(entry.slug, readFileSync(builtDoc, 'utf8'));
  const R = rendered.text();
  const rules = row.rules;
  let present = 0;
  let absent = 0;
  const misses = [];
  for (const b of row.doc.blocks) {
    if (b.t !== 'p') continue;
    const one = foldOne(rules, b.x);
    if (one.length < 25) continue;
    if (R.includes(one)) present++;
    else {
      absent++;
      if (misses.length < 3) misses.push(JSON.stringify(one.slice(0, 100)));
    }
  }
  check(
    absent === 0,
    `${entry.slug} v${version}: every paragraph the reader rendered is the fold this gate computed (${present} of ${present + absent} present in the reading view)` +
      (absent ? ` — e.g. ${misses.join(' | ')}` : ''),
  );
}

/* ---------- the exit code is the finding ---------- */

console.log(failures === 0 ? '\nfold-probe: all checks passed' : `\nfold-probe: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
