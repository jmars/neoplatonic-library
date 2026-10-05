#!/usr/bin/env node
/**
 * tools/library-app-smoke.mjs — the reader app, run as a browser runs it.
 *
 * static checks and the build's leak gate prove the shell is valid and leaks
 * nothing; none of them prove the app BOOTS, resolves a citation, opens a note or
 * comes back to where the reader was. This loads the BUILT shell into a real DOM
 * (happy-dom), evaluates the page's scripts in document order exactly as a
 * browser would — the inlined, stripped bundle and the boot script that mounts it
 * — and drives the reader the way a reader does: by fragment, by click, by key.
 *
 * Every assertion below is paired with what would break it, and each is scoped to
 * `#reader-app` (the app's own output) rather than the page: the shell also
 * server-renders the contents list and the first section for readers without
 * scripts, so an assertion run over the whole page would pass even if the app
 * rendered nothing at all.
 *
 * Run against a built tree:
 *
 *     node build/build.mjs && node tools/library-app-smoke.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'porphyry-on-the-cave-of-the-nymphs-taylor-1917';
const SHELL = join(ROOT, 'site', 'dist', 'texts', SLUG, 'index.html');
const DOC = join(ROOT, 'site', 'dist', 'texts', SLUG, 't');

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

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) failures += 1;
};
const section = (name) => console.log(`\n${name}`);
/** How many PASSAGES the served document holds a query in, recomputed here from
 * the document rather than read off the app — an expectation copied from the
 * thing under test asserts only that the app is self-consistent. The reading
 * view's rules are applied first, because that is the text the app searches. */
function occurrenceCounts(q = 'mithra') {
  const SLUGDOC = JSON.parse(readFileSync(DOC, 'utf8'));
  const rules = SLUGDOC.corrections || [];
  const apply = (s) => rules.reduce((acc, r) => acc.split(r.find).join(r.repl), s);
  // COUNT THE PASSAGES THE READER COUNTS — the reader groups the blocks into
  // paragraphs (by the extractor's own `at` label) and searches THOSE, so counting
  // raw blocks here would disagree the moment a paragraph spans several blocks.
  // This is the reader's grouping, re-stated: a new entry when the paragraph label
  // changes (or when a note begins).
  let region = '';
  let key = null;
  let parts = [];
  let hits = 0;
  const flush = () => {
    if (parts.length) {
      const text = apply(parts.join(''));
      if (text.toLowerCase().includes(q)) hits += 1;
    }
    parts = [];
  };
  for (const b of SLUGDOC.blocks) {
    if (b.t === 'region') { flush(); region = b.kind; key = null; continue; }
    if (region !== 'body' && region !== 'notes') continue;
    // a SECTION ends the open paragraph; a page marker and a running head do NOT
    // (they are inline inside it — that is the fix)
    if (b.t === 'sec') { flush(); key = null; continue; }
    if (b.t === 'pb' || b.t === 'rh') continue;
    if (b.t === 'notedef') {
      const k = `n${b.n}`;
      if (key === k) parts.push(b.x || '');
      else { flush(); key = k; parts = [b.x || '']; }
      continue;
    }
    if (b.t !== 'p' && b.t !== 'verse' && b.t !== 'ref') continue;
    const x = b.t === 'verse' ? (b.x || '').replace(/\n/g, ' ') : b.x || '';
    const k = b.t === 'ref' ? key : `@${b.at || ''}`;
    if (b.t !== 'ref' && key != null && k === key) parts.push(x);
    else if (b.t === 'ref' && key != null) parts.push(x);
    else { flush(); key = k; parts = [x]; }
  }
  flush();
  return { hits };
}

const pctOf = (ctx) => {
  const el = ctx.w.document.querySelector('#reader-app [data-progress]');
  return el ? Number(el.getAttribute('data-progress')) : -1;
};

if (!existsSync(SHELL) || !existsSync(DOC)) {
  console.error(
    `library-app-smoke: ${SHELL.slice(ROOT.length + 1)} is not built.\n` +
      '  Build it first: node build/build.mjs',
  );
  process.exit(1);
}

const Window = happyDom();
const html = readFileSync(SHELL, 'utf8');
const docText = readFileSync(DOC, 'utf8');
const headInner = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'));
const bodyInner = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));

/** A stub's own globals, installed the way a classic script reads them. The
 * compiled bundle captures `document` and `requestAnimationFrame` once, at
 * evaluation, so the DOM has to be on the global object BEFORE the code runs. */
function installGlobals(w, fetchImpl) {
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
  for (const name of names) {
    const value = w[name];
    if (value === undefined) continue;
    Object.defineProperty(globalThis, name, {
      value: bound.has(name) && typeof value === 'function' ? value.bind(w) : value,
      configurable: true,
      writable: true,
    });
  }
  globalThis.fetch = fetchImpl;
  globalThis.setTimeout = w.setTimeout.bind(w);
  globalThis.clearTimeout = w.clearTimeout.bind(w);
}

const settle = async () => {
  // the fetch is a promise chain, then Elm renders on an animation frame (and
  // happy-dom's frames are real time). Node's own timers are used rather than the
  // window's: the window's timer is one of the globals a boot installs, and a
  // test must not measure itself.
  for (let i = 0; i < 8; i += 1) await sleep(12);
};

/** Boot the built shell the way a browser does: parse it, then run its scripts
 * in document order, skipping the data block (which is not a script). */
async function boot({ hash = '', stored = null, doc = null } = {}) {
  const w = new Window({ url: `http://localhost/texts/${SLUG}/${hash}` });
  installGlobals(w, () => Promise.resolve({ ok: true, text: () => Promise.resolve(doc || docText) }));

  const scrolled = [];
  const focused = [];
  w.HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this.id);
  };
  const realFocus = w.HTMLElement.prototype.focus;
  w.HTMLElement.prototype.focus = function () {
    focused.push(this.id);
    if (realFocus) realFocus.call(this);
  };

  w.document.head.innerHTML = headInner;
  w.document.body.innerHTML = bodyInner;
  if (stored !== null) {
    w.localStorage.setItem(`library:${SLUG}`, JSON.stringify(stored));
  }

  const scripts = [...w.document.querySelectorAll('script')].filter((s) => {
    const t = s.getAttribute('type');
    return !t || /javascript|module/i.test(t);
  });
  // a fresh page has a fresh Elm: the compiled bundle refuses to export a module
  // name that is already on the global object, which is exactly what a second
  // boot in one process would look like
  try {
    delete globalThis.Elm;
  } catch (e) {
    globalThis.Elm = undefined;
  }
  for (const s of scripts) {
    // eslint-disable-next-line no-eval -- an indirect eval is how a classic
    // script runs: in the global scope, which is where Elm binds itself
    (0, eval)(s.textContent);
  }
  await settle();

  return {
    w,
    scrolled,
    focused,
    app: () => w.document.getElementById('reader-app'),
    text: () => (w.document.getElementById('reader-app') || { innerHTML: '' }).innerHTML,
    click(el) {
      el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    byText(sel, needle) {
      return [...w.document.querySelectorAll(sel)].find((e) => e.textContent.includes(needle));
    },
  };
}


/* ---------- 1. it boots, renders, and puts the server copy away ---------- */

section('the app boots (the served document, rendered)');
{
  const ctx = await boot();
  const out = ctx.text();
  if (!out.includes('What does Homer obscurely signify')) console.log(`       (rendered: ${JSON.stringify(out.slice(0, 300))})`);
  check(out.includes('What does Homer obscurely signify'), 'section 1 of the served document is in the DOM');
  // FAILS IF: the bundle does not boot, the fetch is not wired, the document
  // decoder rejects it, or the render never happens.
  check(out.includes('rd-sec') && out.includes('id="s18"'), 'all 18 divisions are rendered (s1…s18)');
  // FAILS IF: the flow is truncated, or a block type is dropped by the decoder.
  check(out.includes('id="p58"'), 'the printed pages are rendered to the last one (p58)');
  // FAILS IF: page markers are parsed but not rendered, or the last marker is lost.
  const fallback = ctx.w.document.getElementById('reader-fallback');
  check(fallback === null, 'the server-rendered copy is taken out of the document once the app is up');
  // FAILS IF: the boot script leaves it — the reader would see the whole book
  // twice, and every anchor id would exist twice.
  check(out.includes('rd-fb-toc') === false, 'and the app does not duplicate the contents list');
  // the ids are the citation grammar, so each must exist exactly once in the
  // document the reader is looking at
  const dupes = ['s4', 'p15', 'r1', 's1-1'].filter((aid) => ctx.w.document.querySelectorAll('#' + aid).length !== 1);
  check(dupes.length === 0, `every citation anchor exists exactly once${dupes.length ? ` (duplicated: ${dupes.join(', ')})` : ''}`);
  // FAILS IF: the server-rendered copy is left in place — MEASURED, it did: it
  // came first in the document, so #s4 resolved to the hidden copy and a
  // citation link scrolled nowhere.
  const mine = ctx.w.document.getElementById('s4');
  check(!!mine && !!(mine.closest && mine.closest('#reader-app')), 'and #s4 resolves inside the app, not to a hidden copy');
  // FAILS IF: the document order is inverted again, or the copy is not removed.
}

/* ---------- 2. #s4 resolves ---------- */

section('#s4 — a section citation');
{
  const ctx = await boot({ hash: '#s4' });
  check(ctx.scrolled.includes('s4'), 'the app scrolled to s4');
  // FAILS IF: the hash is not read at load, the anchor map has no s4, or the
  // scroll port is not wired.
  const sec = ctx.w.document.querySelector('#reader-app #s4');
  check(!!sec, 'the section element carries the anchor s4');
  // FAILS IF: sections render without their own ids.
  const first = ctx.w.document.querySelector('#reader-app #s4-1');
  check(!!first && /theologists/i.test(first.textContent), 'and section 4’s first paragraph is rendered under it');
  // FAILS IF: the divisions are rendered but their paragraphs are not, or the
  // paragraph anchor (the reserved #s4-3 grammar) is not materialised.
  const out = ctx.text();
  check(out.includes('rd-cur'), 'the contents list highlights the section the reader is in');
  // FAILS IF: the current-section derivation ignores the position.
}

/* ---------- 3. #p15 resolves ---------- */

section('#p15 — a citation by printed page');
{
  const ctx = await boot({ hash: '#p15' });
  check(ctx.scrolled.includes('p15'), 'the app scrolled to the page marker p15');
  // FAILS IF: page anchors are not rendered, or #p… is not in the anchor map.
  const p15 = ctx.w.document.querySelector('#reader-app #p15');
  check(!!p15 && p15.textContent.trim() === '15', 'the marker says 15');
  // FAILS IF: the marker prints a fabricated or shifted number.
  check(p15 && p15.getAttribute('data-page') === '15', 'and it is the printed page 15 of the volume');
}

/* ---------- 4. a note reference opens, and returns ---------- */

section('a note: the reference opens it, and coming back');
{
  const ctx = await boot();
  const ref = ctx.w.document.querySelector('#reader-app #r1');
  check(!!ref, 'note 1 has a reference control');
  // FAILS IF: references render as plain text, or the return anchor is missing.
  ctx.click(ref);
  await settle();
  const pop = ctx.w.document.querySelector('#reader-app #rd-pop');
  check(!!pop, 'clicking it opens the note');
  // FAILS IF: the click is not wired to the model, or the popover renders nothing.
  check(!!pop && /Cronius/.test(pop.textContent), 'the note’s own words are in it');
  // FAILS IF: the popover shows the number without the note text (a link, not a note).
  check(ctx.focused.includes('rd-pop'), 'and focus moved into it');
  // FAILS IF: the open leaves focus behind, which a keyboard reader notices at once.
  const back = pop && ctx.byText('#reader-app #rd-pop button', 'return');
  check(!!back, 'the note offers a way back to the reference');
  if (back) {
    ctx.click(back);
    await settle();
    check(!ctx.w.document.querySelector('#reader-app #rd-pop'), 'and taking it closes the note');
    // FAILS IF: the return control does not close, or closes into a dead end.
    check(ctx.scrolled.includes('r1'), 'and puts the reader back at the reference');
    // FAILS IF: the return anchor is not the reference's own id.
  }
}

/* ---------- 5. jump to a printed page ---------- */

section('jump to page');
{
  const ctx = await boot();
  const input = ctx.w.document.getElementById('rd-jump');
  const go = ctx.w.document.querySelector('#reader-app .rd-pager button:not([disabled])');
  check(!!input && !!go, 'the jump control is there');
  // FAILS IF: the pager is not rendered.
  input.value = '15';
  input.dispatchEvent(new ctx.w.Event('input', { bubbles: true }));
  await settle();
  // the "go" button is the one whose text is exactly that
  const goBtn = [...ctx.w.document.querySelectorAll('#reader-app .rd-pager button')].find(
    (b) => b.textContent.trim() === 'go',
  );
  check(!!goBtn, 'the go button is there');
  if (goBtn) {
    ctx.click(goBtn);
    await settle();
    check(ctx.scrolled.includes('p15'), 'it lands on the page marker p15');
    // FAILS IF: the number is not read, the page index is wrong, or the anchor
    // it lands on belongs to a different leaf.
    const here = ctx.w.document.querySelector('#reader-app .rd-here');
    check(!!here && /p\. 15/.test(here.textContent), 'and the reader’s position now says p. 15');
    // FAILS IF: the position readout is derived from something other than the jump.
  }
}

/* ---------- 6. resume ---------- */

section('resume');
{
  const ctx = await boot({ stored: { position: 's4', page: 14, section: 's4', bookmarks: [], view: 'reading', scale: 3 } });
  check(ctx.scrolled.includes('s4'), 'a stored position is restored on load');
  // FAILS IF: the page does not hand the stored record to the app, the position
  // is not consulted, or the scroll port is dead.
  const ctx2 = await boot({ hash: '#p15', stored: { position: 's10', bookmarks: [], view: 'reading', scale: 3 } });
  check(ctx2.scrolled.includes('p15') && !ctx2.scrolled.includes('s10'), 'a fragment wins over the stored position');
  // FAILS IF: a citation link opens at last week's reading position instead.
}

/* ---------- 7. the two views differ, and only one is repaired ---------- */

section('the two views are named for what they are — repaired and as scanned');
{
  const ctx = await boot();
  const reading = ctx.text();
  check(reading.includes('1. What does Homer'), 'the reading view carries the repaired section opener');
  // FAILS IF: the correction rules are not applied client-side.
  check(!reading.includes('I i. What does Homer'), 'and not the transcription’s damaged numeral');
  // FAILS IF: the reading view serves the verbatim blocks.

  /* THE LABELS STATE WHICH VIEW HAS THE REPAIRS. They read "reading" and
     "transcription", which named neither the difference nor the default, and the
     author asked where the repaired text was while looking at the view that has
     it. FAILS IF either button is relabelled back to a word that does not say what
     the view is, if a third button appears, or if the labels are swapped. */
  const buttons = [...ctx.w.document.querySelectorAll('#reader-app .rd-views button')];
  const labels = buttons.map((b) => b.textContent.trim());
  check(
    labels.length === 2 && labels[0] === 'repaired' && labels[1] === 'as scanned',
    `the two view buttons say which is which (${labels.map((l) => JSON.stringify(l)).join(' and ')})`,
  );
  /* THE REPAIRED VIEW IS THE DEFAULT AND IS THE ONE PRESSED. FAILS IF the default
     flips to the transcription, or if aria-pressed stops tracking the view — the
     label and the state must agree, or a reader cannot tell which text is shown. */
  check(
    buttons.length === 2 &&
      buttons[0].getAttribute('aria-pressed') === 'true' &&
      buttons[1].getAttribute('aria-pressed') === 'false' &&
      reading.includes('1. What does Homer'),
    'the repaired view is the default, and its button is the one pressed (aria-pressed)',
  );

  const toggle = ctx.byText('#reader-app .rd-views button', 'as scanned');
  check(!!toggle, 'the "as scanned" view is offered');
  if (toggle) {
    ctx.click(toggle);
    await settle();
    const transcription = ctx.text();
    check(transcription.includes('I i. What does Homer'), 'the as-scanned view carries the verbatim block');
    // FAILS IF: repairs were baked into the served text — the transcription view
    // is the whole reason they are not.
    check(!transcription.includes('1. What does Homer'), 'and not the repair');
    check(reading !== transcription, 'the same block reads two ways');
    // FAILS IF: the two views are the same text with a different label.
    const back = ctx.byText('#reader-app .rd-views button', 'repaired');
    check(!!back, 'and the repaired view can be returned to');
    if (back) {
      ctx.click(back);
      await settle();
      check(ctx.text().includes('1. What does Homer'), 'returning to it shows the repaired text again');
    }
  }
}

/* ---------- 7a1b. the punctuation the print sets tight is tight ---------- */

section('the transcription\'s punctuation spacing is normalized');
{
  /* The OCR split punctuation off as its own word, so the transcription carried a
     space before a closing mark and after an opening quote. The print sets them
     tight, and the normalization is a WHITESPACE pass (tidyPunctuation), not a
     reading: it is applied where the scan's column-padding runs are already
     collapsed. MEASURED: ` ;` 110 times, an opening quote + space 41 times. FAILS
     IF: the pass is dropped — the reading view then shows `shine ;` and `" High`.
     The 13 remaining quote-plus-space and 4 space-plus-quote cases are CLOSING
     quotes followed by a space and OPENING quotes preceded by one, which are
     correct; the assertions below are the artifacts, not those. */
  const ctx = await boot();
  const reading = ctx.w.document.getElementById('reader-app').textContent;
  check(
    reading.includes('in native marble shine;'),
    'a space before a semicolon is gone ("in native marble shine;")',
  );
  check(
    reading.includes('called Naiades?'),
    'and a space before a question mark ("called Naiades?")',
  );
  check(
    reading.includes('high at the head') === false && /[\u201c"] high/i.test(reading) === false,
    'and no space after an opening quote (' + JSON.stringify((reading.match(/[\u201c"][^\u201d"\n]{0,12}/) || [''])[0]) + ')',
  );
  check(
    reading.includes('"Nymphs," says Hermias'),
    'while a CLOSING quote keeps the space that follows it ("Nymphs," says Hermias)',
  );
  // FAILS IF: the pass over-corrects — a space before a punctuation mark is never
  // correct, but a spaced ELLIPSIS is a print convention and is left alone.
  check(
    (reading.match(/ ;/g) || []).length === 0 && (reading.match(/ ,/g) || []).length === 0,
    `and no space survives before a semicolon or comma (${(reading.match(/ ;/g) || []).length} / ${(reading.match(/ ,/g) || []).length})`,
  );
}

/* ---------- 7a2. the damage the policy leaves is VISIBLE (the policy's proof) ---------- */

section('a recorded reading renders, and damage with no reading renders marked');
{
  const DOCJSON = JSON.parse(docText);
  const damage = DOCJSON.damage;
  const ctx = await boot();
  check(
    typeof damage === 'string' && damage.length > 0,
    `the document carries the base policy's damage set (${JSON.stringify(damage)})`,
  );

  /* (1) A DAMAGED WORD WHOSE READING IS RECORDED RENDERS THE READING. The three
     cases the review called BLOCKERs are checked in the extractor's smoke against
     the parallel's own words; here it is what the COMPILED APP shows. FAILS IF the
     rule is not applied client-side, or the app marks a word it has resolved. */
  const reading = ctx.w.document.getElementById('reader-app').textContent;
  const put = DOCJSON.corrections.find((c) => c.find === 'fo~~tlTe~lieavens. _put');
  check(
    !!put && put.repl === 'to the heavens, but' && put.action !== 'leave',
    `the document records the page turn's reading "to the heavens, but" (${put ? JSON.stringify(put.repl) : 'no rule'})`,
  );
  check(
    reading.includes('but the other to souls descending'),
    'and the reading view shows "but the other to souls descending" (the split is joined)',
  );
  /* A JOIN: the two blocks the transcription split at a blank line are ONE
     paragraph in the reading view, and the rule that spans the seam fires. This
     is the display half of the `join` mechanism — the other half is that the rule
     cannot be written per block at all. FAILS IF: the merge is dropped (the blocks
     render separately and the sentence is broken), or a future edit restores the
     split. */
  check(
    reading.includes('patient perseverance'),
    'and a word split across a page break is one paragraph: "patient perseverance" (the join rule)',
  );
  check(
    reading.includes('assumed it as a symbol of all invisible powers'),
    'and the words lost at a blank line are supplied across the join: "assumed it as a symbol of all invisible powers"',
  );

  /* (2) A DAMAGED WORD WITH NO RECORDED READING RENDERS THE TRANSCRIPTION'S OWN
     CHARACTERS, WITH THE DAMAGE VISIBLE. Every character of the damage set that
     survives into the reading view is inside a mark; the count is cross-checked
     against the rendered text, so a wrong mark or a missing one both fail. */
  const marks = [...ctx.w.document.querySelectorAll('#reader-app mark.rd-damage')];
  check(marks.length > 0, `the reading view marks the damage it leaves (${marks.length} mark(s))`);
  check(
    marks.every((m) => [...m.textContent].every((c) => damage.includes(c))),
    'every marked character is one of the document\'s damage set — no printed letter is marked',
  );
  /* Counted over the PROSE the reader meets, not the whole chrome: the reader's own
     furniture happens to contain characters of the damage set ("go\u203a\u00bb" is the
     next-page control and the volume transcribes a \u00bb in "the cavern\u00bb"), and counting
     those would make the assertion about the buttons. */
  const proseEls = [
    ...ctx.w.document.querySelectorAll('#reader-app .rd-p, #reader-app .rd-verse, #reader-app .rd-note-body'),
  ];
  const proseParts = proseEls.map((e) => e.textContent);
  const prose = proseParts.join('\u0000');
  const markedChars = marks.reduce((a, m) => a + m.textContent.length, 0);
  const inView = [...prose].filter((c) => damage.includes(c)).length;
  check(
    markedChars === inView,
    `every damage character in the rendered reading text is marked, and none else ` +
      `(${markedChars} marked of ${inView} present)`,
  );
  /* A LEAVE SET MAY BE EMPTY, and that is the good state: a left word is damage
   * whose reading could not be determined, so zero left words means every damaged
   * word a witness could settle has been settled. MEASURED: this edition went
   * 2 left words -> 0 when the destroyed page-break run was reclassified as
   * furniture (the printed page carries nothing there). The assertion holds at
   * any count — every left word must actually BE in the reading view, marked. */
  const left = DOCJSON.correctionsMeta.leftWords || [];
  check(
    left.length === 0 || marks.some((m) => m.textContent.includes('_') || m.textContent.includes('^')),
    `${left.length} word(s) the policy leaves visible, each shown with its damage marked ` +
      `(${left.slice(0, 3).join(', ') || 'none — every damaged word is settled'})`,
  );
  // The fixture is the document's OWN residue, not a hard-coded token: the word
  // that carries no recorded reading changes as readings are merged (MEASURED:
  // `that_jgthe` was one until `that_jg_the` -> `that is the` was recorded, and
  // the two page artefacts are what remain). Asserting the document's own list
  // keeps the check honest as the rules grow.
  check(
    left.every((w) => reading.includes(w)),
    `and every word with no recorded reading is shown AS THE TRANSCRIPTION HAS IT ` +
      `(${left.join(', ') || 'none'})`,
  );

  /* (2b) THE TWO CLASSES OF DAMAGE, AND THE MARKS THEY ACCOUNT FOR (fix 2, fix 3).
     The marked characters are not enough on their own: a mark on a token that is
     neither a damaged word nor a standalone marker would be damage nothing counts,
     which is exactly the gap the author found (the document said "2 damaged words"
     while the reading view showed 33 damage characters).

     MEASURED, and why this is counted the way it is: the app renders the prose as
     it groups it, not as the document stores it — a margin note is drawn a SECOND
     time inside the paragraph that references it (`.rd-margin`, aria-hidden), and
     a paragraph the transcription split around a reference marker is joined back
     together. So the damage characters are counted over the reading text MINUS the
     margin copies, which is the text the document's own count is over. FAILS IF the
     app marks damage outside the reading text, drops a mark, duplicates one into
     the count, or renders a damage character the document's measurement does not
     account for. */
  const inMargin = (el) => {
    for (let n = el; n; n = n.parentElement) if (n.classList && n.classList.contains('rd-margin')) return true;
    return false;
  };
  const readingMarks = marks.filter((m) => !inMargin(m));
  const readingChars = readingMarks.reduce((a, m) => a + m.textContent.length, 0);
  const marginChars = markedChars - readingChars;
  const marginCopies = [...ctx.w.document.querySelectorAll('#reader-app .rd-margin')];
  check(
    marginCopies.length > 0,
    `the notes ARE drawn as margin copies (${marginCopies.length} .rd-margin element(s)) — the duplication this ` +
      `reconciliation has to account for exists, even though a clean note carries no mark in it`,
  );
  const readingText = proseParts.join('\u0000');
  const markers = DOCJSON.correctionsMeta.leftMarkers || [];
  /* THE RECONCILIATION is `readingChars === leftDamageChars`: the reading text
   * marks exactly the damage the document measured. This is the check that caught
   * the original gap (the document said "2 damaged words" while the reading view
   * showed 33 damage characters).
   *
   * THE MARGIN SUB-ASSERTION is CONDITIONAL and MEASURED to be: `marginChars > 0`
   * holds only while a NOTE carries counted damage, because a margin note is the
   * one thing the app draws TWICE. The notes were the only such place, and the
   * scan repairs left them clean (MEASURED: the only damage left is the page
   * furniture and the end matter — no note), so `marginChars` is legitimately
   * 0 and `markedChars === readingChars`. Asserting it unconditionally would fail
   * a correct build; asserting it never is a check that cannot fail. The margin
   * mechanism itself is asserted below (the notes ARE drawn in margin copies), so
   * this only drops the "and the duplicate carries marks" half, which has nothing
   * to carry while the notes are clean. */
  check(
    readingChars > 0 && readingChars === DOCJSON.correctionsMeta.leftDamageChars,
    `the reading text shows and marks exactly the ${readingChars} damage character(s) the document's two ` +
      `counts account for (${DOCJSON.correctionsMeta.leftDamageChars} stated; the ${marginChars} in the ` +
      `margin copies of the notes are the same text drawn twice, and are marked there too)`,
  );
  check(
    DOCJSON.correctionsMeta.leftWordCount === left.length &&
      DOCJSON.correctionsMeta.leftMarkerCount === markers.length &&
      markers.every((mk) => !/[A-Za-z]/.test(mk)) &&
      !markers.some((mk) => left.includes(mk)),
    `the document states the two counts apart — ${DOCJSON.correctionsMeta.leftWordCount} damaged word(s) and ` +
      `${DOCJSON.correctionsMeta.leftMarkerCount} standalone marker(s), the markers all letterless and none of ` +
      `them counted among the words`,
  );
  const missingInView = [...markers, ...left].filter((name) => !readingText.includes(name));
  check(
    markers.length > 0 && missingInView.length === 0,
    `and every name in both lists stands in the rendered reading text — the ${markers.length} standalone ` +
      `marker(s) (${markers.slice(0, 4).map((m) => JSON.stringify(m)).join(' ')}) and the ${left.length} ` +
      `damaged word(s)` +
      `${missingInView.length ? `; MISSING ${JSON.stringify(missingInView)}` : ''}`,
  );
  /* (2c) AN ADDED READING FOR A STANDALONE MARKER FIRES, AND THE MARKER GOES
     (fix 2's proof 4). The two readings added for markers standing between words
     record the print's SPACE, so the passages read as the 1823 parallel has them.
     FAILS IF either rule is dropped, is mis-spaced and stops matching, or is
     written without the spaces and starts eating the `^`/`_` that stand INSIDE
     words (`in_d^scfi5mga`, `that_jg_the`), which no rule may touch by deletion. */
  check(
    prose.includes('petitioner. Thus, too') &&
      prose.includes('and not of any other matter') &&
      prose.includes('governed by an intellectual nature') &&
      !markers.includes('_') &&
      !markers.includes('^') &&
      [...prose].includes('^'),
    'the readings recorded for the standalone markers " ^ " and " _ " fire: "petitioner. _ Thus" reads ' +
      '"petitioner. Thus", "and not of ^ any" reads "and not of any", "governed ^ by" reads "governed by" — ' +
      'no standalone ^ or _ is left, while the ^ standing INSIDE a left-visible word is untouched',
  );

  /* (3) THE TRANSCRIPTION VIEW IS NOT MARKED: it is the verbatim text, and a mark
     there would claim the transcription's own characters are apparatus. */
  const toggle = ctx.byText('#reader-app .rd-views button', 'as scanned');
  if (toggle) {
    ctx.click(toggle);
    await settle();
    const t = [...ctx.w.document.querySelectorAll('#reader-app mark.rd-damage')];
    check(t.length === 0, `the transcription view marks nothing (${t.length} mark(s)) — it is the verbatim text`);
    /* AND IT STILL SHOWS EVERY MARKER THE READINGS REPAIRED (proof 5). The served
       text is verbatim and the rules are applied by the VIEW, so the markers the
       reading view no longer shows must stand in this one. FAILS IF a repair is
       ever baked into the served blocks, or if the view switch stops re-reading
       the raw text. */
    const raw = [...ctx.w.document.querySelectorAll('#reader-app .rd-p, #reader-app .rd-verse, #reader-app .rd-note-body')]
      .map((e) => e.textContent)
      .join('\u0000');
    check(
      raw.includes('petitioner. _ Thus') &&
        raw.includes('and not of ^ any other matter') &&
        raw.includes('governed ^ by an intellectual nature') &&
        raw.includes('- -1i"^lHi.n*-iL'),
      'and the transcription view still carries every one of them verbatim: "petitioner. _ Thus", ' +
        '"and not of ^ any other matter", "governed ^ by", and the page furniture run',
    );
  } else {
    check(false, 'the transcription view is offered');
  }
}

/* ---------- 7b. the contents list, and the titles that could not be repaired ---------- */

section('the contents list: a damaged title is stated, not shipped');
{
  const DOCJSON = JSON.parse(docText);
  const marked = DOCJSON.toc.filter((t) => t.damaged);
  const DAMAGED = '[the opening words are damaged in this transcription]';

  /* SECTION 2 IS THE POLICY'S OWN DEMONSTRATION, and it used to be the flagged
     case. Its opening words ARE determinable ("The ancients, indeed, very
     properly consecrated a cave to the world", the 1823 parallel), so the policy
     SUBSTITUTES them and the title is now the edition's own words. This assertion
     fails if a reading rule for those words is dropped: the title goes back to
     carrying damage and is flagged. */
  const s2 = DOCJSON.toc.find((t) => t.n === 2);
  check(
    marked.length === 0 &&
      !s2.damaged &&
      /[\^_]/.test(s2.raw) &&
      s2.title === 'The ancients, indeed…',
    `the policy repaired the one title the transcription damaged ` +
      `(§2: raw ${JSON.stringify(s2.raw)} -> ${JSON.stringify(s2.title)}), so no title is flagged (${marked.length})`,
  );

  /* THE FLAG ITSELF, DRIVEN FROM A FIXTURE. The real text now has no flagged
     title, so the mechanism is exercised on a synthetic document: a title the
     repairs cannot restore must be STATED, not shipped, and its own damaged words
     must stand beside the statement as evidence. FAILS IF the app renders the
     damaged words as the entry, or drops the statement, or drops the evidence. */
  const synthetic = JSON.parse(docText);
  const RAW2 = 'Thp_anrt\u2019p\u2019rii\u2019c:, i"Hpfdt v^ry properly con se';
  synthetic.toc = synthetic.toc.map((t) => (t.n === 2 ? { ...t, damaged: true, damagedWords: RAW2, raw: RAW2 } : t));
  const ctx = await boot({ doc: JSON.stringify(synthetic) });
  const toc = ctx.w.document.querySelector('#reader-app .rd-toc');
  check(!!toc, 'the contents list is rendered');
  const labels = [...toc.querySelectorAll('a')].map((a) => a.textContent);
  const fixtureRaw = synthetic.toc.filter((t) => t.damaged).map((t) => t.raw);
  check(
    fixtureRaw.length === 1 && labels.every((l) => !fixtureRaw.some((r) => l.includes(r))),
    `no damaged title is offered as a title in the reading view (${fixtureRaw.length} flagged in the fixture)`,
  );
  check(
    labels.filter((l) => l.includes(DAMAGED)).length === fixtureRaw.length,
    `and the flagged division's entry states the gap instead ` +
      `(${labels.filter((l) => l.includes(DAMAGED)).length} of ${fixtureRaw.length})`,
  );
  check(
    fixtureRaw.every((r) => toc.textContent.includes(`the transcription reads \u201C${r}\u201D`)),
    'and the entry carries those words beside the statement, so nothing is hidden',
  );
  // §11 is the counter-case: its damage is repaired by a READING rule (the opener
  // states the print's number), so its title must be shown, not flagged
  const s11 = synthetic.toc.find((t) => t.n === 11);
  check(
    !s11.damaged && toc.textContent.includes(s11.title) && toc.textContent.includes(DAMAGED),
    `§11's title is shown (its opener rule reads the print's own words) while the flagged entry states the gap ` +
      `(${JSON.stringify(s11.title)})`,
  );
  // the transcription view keeps the flag too
  const toggle = ctx.byText('#reader-app .rd-views button', 'as scanned');
  ctx.click(toggle);
  await settle();
  const toc2 = ctx.w.document.querySelector('#reader-app .rd-toc');
  check(
    [...toc2.querySelectorAll('a')].filter((a) => a.textContent.includes(DAMAGED)).length === fixtureRaw.length,
    `and the flagged entry states the gap in the transcription view too (${fixtureRaw.length})`,
  );
}

/* ---------- 7c. the repairs list, with the measured hit counts ---------- */

section('the repairs list is the rule list, with its measured hits');
{
  const DOCJSON = JSON.parse(docText);
  const ctx = await boot();
  const btn = ctx.byText('#reader-app .rd-bar button', 'repairs');
  check(!!btn, 'the repairs control is there');
  if (btn) {
    // THE LABEL IS SHORT. It read "what was changed (N)"; that label is wide
    // enough to overflow the toolbar at the reading column's width (MEASURED by
    // the author), and the panel itself is titled "The repairs, as rules", so the
    // control says the same in fewer characters.
    const label = btn.textContent.trim();
    check(
      /^repairs \(\d+\)$/.test(label),
      `the control's label is short enough for the toolbar (${JSON.stringify(label)})`,
    );

    ctx.click(btn);
    await settle();
    const panel = ctx.w.document.querySelector('#reader-app .rd-diff');
    check(!!panel, 'and it opens the rule list');
    // THE EDITION'S REPAIR STATE, in the panel the reader opened: a list of
    // repairs should say what the edition's state IS. Read against the document's
    // own flag, so the check follows the state rather than hardcoding one. FAILS
    // IF: the flag stops reaching the reader — a reader then takes an unrepaired
    // edition for a finished one.
    const flag = /<script type="application\/json" id="reader-flags">([\s\S]*?)<\/script>/.exec(html);
    const state = flag ? JSON.parse(flag[1]).repair : null;
    check(
      !!panel && !!state && panel.textContent.includes(`This edition is ${state.label}.`),
      `and the panel states the edition's state (${state ? JSON.stringify(state.label) : 'no flag'})`,
    );
    // FAILS IF: the panel is not rendered, or the toggle is not wired.
    const rows = [...panel.querySelectorAll('tbody tr')];
    check(
      rows.length === DOCJSON.corrections.length,
      `every rule is listed, and no others (${rows.length} of ${DOCJSON.corrections.length})`,
    );
    // FAILS IF: the list is filtered, truncated or derived from something else.
    const tbl = rows.map((tr) => {
      const td = tr.querySelectorAll('td');
      return { cls: td[0].textContent.trim(), find: td[1].textContent, repl: td[2].textContent, hits: td[3].textContent.trim(), why: td[4].textContent };
    });
    // A LEAVE row shows the sentence, not the find repeated: the document stores
    // repl === find for a leave, and the panel must not offer the damaged run as
    // if it were a reading.
    const LEFT = 'no reading recorded — left';
    check(
      tbl.every(
        (r, i) =>
          r.find === DOCJSON.corrections[i].find &&
          r.cls === DOCJSON.corrections[i].cls &&
          r.repl === (DOCJSON.corrections[i].repl === DOCJSON.corrections[i].find ? LEFT : DOCJSON.corrections[i].repl),
      ),
      'each row is the document\'s own rule, in the document\'s order',
    );
    // THE POLICY, ON THE PANEL: a rule that records no reading says so, and the
    // damaged words the policy leaves are listed too — the panel shows BOTH halves.
    const leaves = DOCJSON.corrections.filter((r) => r.repl === r.find);
    check(
      leaves.length === tbl.filter((r) => r.repl === LEFT).length,
      `every rule that records no reading says so in the panel (${leaves.length} of ${tbl.length})`,
    );
    check(
      (DOCJSON.correctionsMeta.leftWords || []).length === 0 ||
        [...panel.querySelectorAll('.rd-left-list li')].map((li) => li.textContent).join('\u0000') ===
          DOCJSON.correctionsMeta.leftWords.join('\u0000'),
      `and the damaged words the policy leaves are listed beside the rules ` +
        `(${(DOCJSON.correctionsMeta.leftWords || []).length} word(s))`,
    );
    // the hit count is the DOCUMENT's measurement, recomputed here from the
    // document: a rule applied in order to every block, counting what it changes
    const mine = DOCJSON.corrections.map(() => 0);
    for (const b of DOCJSON.blocks) {
      if (typeof b.x !== 'string') continue;
      let text = b.x;
      DOCJSON.corrections.forEach((r, i) => {
        const parts = text.split(r.find);
        if (parts.length > 1) {
          mine[i] += parts.length - 1;
          if (r.repl !== r.find) text = parts.join(r.repl);
        }
      });
    }
    check(
      tbl.every((r, i) => r.hits === String(mine[i])) && rows.length > 0,
      `and each row's count is the number of times that rule fires, recomputed from the served document ` +
        `(${tbl.filter((r, i) => r.hits === String(mine[i])).length} of ${tbl.length}; max ${Math.max(...mine)})`,
    );
    // FAILS IF: the count is re-derived in the view from the wrong text (a rule
    // shown as firing twice when it fires once), or any rule shows 0 — which the
    // build would not have let through.
    check(
      tbl.every((r) => r.hits !== '0'),
      `no rule is listed as firing zero times (the build refuses that)`,
    );
    check(
      tbl.filter((r) => r.hits !== '1').length === DOCJSON.correctionsMeta.repeated.length,
      `the rules that fire more than once are the ${DOCJSON.correctionsMeta.repeated.length} the document names ` +
        `(${DOCJSON.correctionsMeta.repeated.map((r) => `${JSON.stringify(r.find)} ×${r.hits}`).join(', ')})`,
    );
    check(
      tbl.every((r) => r.why.length > 0),
      'and every rule says why it is there — a rule with no reason is not reviewable',
    );
  }
}

/* ---------- 7d. the repairs list is an OVERLAY, where the reader already is ---------- */

section('the repairs list opens where the reader is, not at the end of the book');
{
  // The bug this section exists for: `rulesPanel` was rendered in the FLOW, after
  // all 18 divisions and the footer, so a reader at the top of the volume clicked
  // the control and nothing visible happened — this very smoke passed, because
  // happy-dom lays nothing out and the panel was in the DOM either way. The
  // citation panel had the same bug and was fixed by making it fixed-position; the
  // halves below are what happy-dom CAN see of that fix.
  const ctx = await boot();
  const main = ctx.w.document.getElementById('rd-main');
  const btn = ctx.byText('#reader-app .rd-bar button', 'repairs');
  check(!!btn, 'the control is the repairs list (repairs (N))');
  if (btn) {
    const before = { pct: pctOf(ctx), hash: ctx.w.location.hash, scrolled: ctx.scrolled.length };
    ctx.click(btn);
    await settle();
    const panel = ctx.w.document.querySelector('#reader-app .rd-diff');
    check(!!panel, 'clicking it opens the panel');
    if (panel) {
      // FAILS IF: the panel is rendered inside the reading flow (inside `main_`
      // or the `.rd-cols` grid). That is where an in-flow panel lives — the
      // position that made the bug, and the position a later edit would restore.
      check(
        !main.contains(panel) && !panel.closest('.rd-cols'),
        'and the panel is not part of the reading flow (#rd-main / .rd-cols)',
      );
      // FAILS IF: `.rd-diff` loses `position: fixed` — the panel goes back into
      // the flow, which is exactly the bug. happy-dom resolves the page's own
      // stylesheet through getComputedStyle, so the property is readable here
      // even though nothing is laid out: the flow default is `static`.
      const cs = ctx.w.getComputedStyle(panel);
      check(
        cs.position === 'fixed',
        `and it is an OVERLAY: .rd-diff resolves to position:${cs.position || '(static)'} (in the flow it is static, and the reader at the top sees nothing)`,
      );
      const mh = parseFloat(cs.maxHeight);
      check(
        cs.overflow === 'auto' && mh > 0 && mh < ctx.w.innerHeight,
        `with its own scroll and a height capped below the window (${cs.maxHeight} of ${ctx.w.innerHeight}px), so the page stays readable behind it`,
      );
      // FAILS IF: the close control scrolls out of view. The panel is its own
      // scroll container and the table runs to hundreds of rows; the ✕ is in the
      // head, so without `position: sticky` a reader scrolled down must scroll
      // back to the top to dismiss the list (MEASURED on the published text).
      const head = panel.querySelector('.rd-diff-head');
      const hcs = head ? ctx.w.getComputedStyle(head) : null;
      check(
        !!head && hcs.position === 'sticky',
        `and its HEAD is stuck to the scrollport (position:${hcs ? hcs.position : '(no head)'}) so the ✕ stays reachable however far the list is scrolled`,
      );
      check(
        Number(cs.zIndex) >= 60,
        `and it sits above the text (z-index ${cs.zIndex}, the layer the note popover and the citation panel use)`,
      );
      // FAILS IF: opening the panel moves the reader. That is the second half of
      // the documented failure — focus moving into a panel rendered at the end of
      // the book yanked the reader to the end of the volume; and an overlay must
      // leave the reading position exactly where it was.
      check(pctOf(ctx) === before.pct, `opening it does not move the reading position (${before.pct}% before and after)`);
      check(ctx.scrolled.length === before.scrolled, 'and it scrolls nothing into view');
      check(ctx.w.location.hash === before.hash, `and it writes no new position to the fragment (${JSON.stringify(before.hash)})`);
      // FAILS IF: the panel cannot be dismissed from the keyboard, or focus is
      // left inside an element that has just been removed.
      panel.dispatchEvent(new ctx.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      check(!ctx.w.document.querySelector('#reader-app .rd-diff'), 'and Escape closes it');
      check(
        ctx.focused.includes('rd-rules') && ctx.focused.includes('rd-rules-btn'),
        'focus goes into the panel on opening and back to the control on Escape',
      );
      // the label states the open/closed state, as it did before the relabel
      const btn2 = ctx.byText('#reader-app .rd-bar button', 'repairs');
      check(
        btn2 && btn2.getAttribute('aria-pressed') === 'false',
        'and the control still carries its aria-pressed state (pressed=false once closed)',
      );
    }
  }
}

/* ---------- 8. the keys ---------- */

section('keyboard');
{
  const ctx = await boot();
  const main = ctx.w.document.getElementById('rd-main');
  main.dispatchEvent(new ctx.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await settle();
  check(ctx.scrolled.includes('p5'), 'an arrow key from the front matter steps into the text');
  // FAILS IF: the key handler is not bound, needs a click first, or a step from
  // the front matter (which has no printed page) is a no-op.
  const page = await boot({ hash: '#s4' });
  const mainPage = page.w.document.getElementById('rd-main');
  mainPage.dispatchEvent(new page.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await settle();
  check(page.scrolled.includes('p15'), 'the arrow key from section 4 moves one PRINTED PAGE (p15)');
  // FAILS IF: the page grain is not the page index, or s4 does not sit on p14.
  const sec = await boot({ hash: '#s4' });
  const mainSec = sec.w.document.getElementById('rd-main');
  mainSec.dispatchEvent(new sec.w.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
  await settle();
  check(sec.scrolled.includes('s5'), 'shift plus the arrow moves one SECTION (s5)');
  // FAILS IF: the two grains are not distinguished, or shift is ignored.
  check(!sec.scrolled.includes('p15'), 'and the section grain does not take the page grain’s target');
}

section('the running heads, the citation and the progress');
{
  const ctx = await boot({ hash: '#p16' });
  check(ctx.w.document.querySelectorAll('#reader-app .rd-rh').length === 0, 'the reading view shows no running heads');
  // FAILS IF: the furniture is not suppressed — the page numbers inside the
  // heads then read as prose ("6 ON THE CAVE OF THE NYMPHS" mid-sentence).
  const t = ctx.byText('#reader-app .rd-views button', 'as scanned');
  ctx.click(t);
  await settle();
  const heads = ctx.w.document.querySelectorAll('#reader-app .rd-rh').length;
  check(heads > 0, `the transcription view shows them (${heads} running heads)`);
  // FAILS IF: the two views are the same rendering — the transcription is the
  // verbatim blocks, furniture included.

  const cite = await boot({ hash: '#p15' });
  const citeBtn = ctx.byText('#reader-app .rd-bar-right button', 'cite');
  check(!!citeBtn, 'the citation control is there');
  // FAILS IF: the panel has no way in.
}
{
  const ctx = await boot({ hash: '#p15' });
  ctx.click(ctx.byText('#reader-app .rd-bar-right button', 'cite'));
  await settle();
  const line = ctx.w.document.querySelector('#reader-app [data-cite="line"]');
  check(!!line, 'the citation panel opens and carries a citation line');
  // FAILS IF: the panel is not rendered, or the line has no seat.
  const want =
    'Porphyry, On the Cave of the Nymphs, trans. Thomas Taylor (London: John M. Watkins, 1917), p. 15';
  const got = line ? line.textContent.replace(/\s+/g, ' ').trim() : '';
  check(got === want, `and it reads exactly the edition's line (${JSON.stringify(got)})`);
  // FAILS IF: the citation is built from anything but the document's own edition
  // metadata — the plan's string, character for character, with p. 15 because the
  // reader is on #p15.
  // The URL is looked up by its own data-cite name rather than by class: the
  // panel now carries TWO .rd-cite-url elements (the passage's and the page's),
  // and a class selector would assert the citation grammar against whichever one
  // happens to come first in the document.
  const flagsJson = /<script type="application\/json" id="reader-flags">([\s\S]*?)<\/script>/.exec(html);
  const flags = flagsJson ? JSON.parse(flagsJson[1]) : null;
  const url = ctx.w.document.querySelector('#reader-app [data-cite="page-url"]');
  check(!!url && url.getAttribute('href').endsWith(`/texts/${SLUG}/#p15`), 'and it names the URL a citation needs');
  // FAILS IF: the URL is missing or points somewhere the page does not resolve.
  /* THE PER-PASSAGE CITATION (plan §11 phase 5). The page citation above is what
   * a citation by printed page is; this is the passage's OWN anchor, which is
   * what a reader who wants to cite the sentence rather than the page needs.
   * Driven from a PARAGRAPH anchor, because that is the finest unit the document
   * materialises (#s4-3, the reserved grammar) and the case a page citation
   * cannot express. Every expectation is recomputed here: the line's edition head
   * from the shell's own flags block, the division and the page from the served
   * document, the anchor from the fragment the reader arrived by. */
  const pctx = await boot({ hash: '#s4-1' });
  pctx.click(pctx.byText('#reader-app .rd-bar-right button', 'cite'));
  await settle();
  const pline = pctx.w.document.querySelector('#reader-app [data-cite="passage"]');
  const purl = pctx.w.document.querySelector('#reader-app [data-cite="passage-url"]');
  check(!!pline && !!purl, 'and the panel cites the PASSAGE, not only the page');
  // FAILS IF: the panel still offers one citation per page and nothing finer.
  const c = flags && flags.citation;
  const docJson = JSON.parse(docText);
  const head = c ? `${c.author}, ` : '';
  const tail = c ? `, trans. ${c.translator} (${c.place}: ${c.publisher}, ${c.year})` : '';
  const secOf = (b) => (b.t === 'sec' ? b.n : null);
  const pageAt = new Map();
  {
    // the printed page each paragraph anchor stands under, and the division it
    // is in — recomputed from the served document, not read off the app
    let page = null;
    let sec = null;
    for (const b of docJson.blocks) {
      if (b.t === 'pb' && b.page != null) page = b.page;
      if (secOf(b) != null) sec = secOf(b);
      // the paragraph's OWN first page: a paragraph the page turn runs through is
      // one paragraph, and the page it is ON is where it starts (the reader's rule
      // — and the page marker is inside the paragraph now)
      if (b.at && !pageAt.has(b.at)) pageAt.set(b.at, { page, sec });
    }
  }
  const known = docJson.blocks.find((b) => b.at === 's4-1');
  check(!!known, `the served document materialises the paragraph anchor the citation is taken from (${!!known})`);
  const at4 = known ? pageAt.get('s4-1') : null;
  const wantPassage = known
    ? `${head}On the Cave of the Nymphs${tail}, §${at4.sec}, p. ${at4.page}`
    : '';
  const gotPassage = pline ? pline.textContent.replace(/\s+/g, ' ').trim() : '';
  check(
    known && gotPassage === wantPassage,
    `and its line is the edition's, the division's and the page's, read off the document (${JSON.stringify(gotPassage)})`,
  );
  // FAILS IF: the division is taken from the scroll position rather than the
  // anchor, if the page is missing, or if an imprint is written into the app.
  const href = purl ? purl.getAttribute('href') : '';
  check(href.endsWith(`/texts/${SLUG}/#s4-1`), `and its deep link is the passage's own anchor (${href})`);
  // FAILS IF: the link is the page's anchor, or the section's, where the document
  // has a paragraph anchor to cite.
  const target = href.slice(href.indexOf('#') + 1);
  check(
    !!target && !!pctx.w.document.querySelector(`#reader-app #${target}`),
    `and following it lands on the passage: #${target} exists in the app`,
  );
  // FAILS IF: the app cites an anchor it does not itself render — a citation that
  // resolves nowhere is worse than none, and this is the one assertion that can
  // catch the case where the document and the app disagree about an id.
}

{
  // The passage clause is read off the ANCHOR and not off the scroll position
  // (phase 5). A note's anchor is a note: the notes region sits after the last
  // division, so a position-derived clause there would say "§18" about a note to
  // section 3 — a claim about the text that is simply false.
  const docJson = JSON.parse(docText);
  const n5 = docJson.blocks.find((b) => b.t === 'notedef' && b.n === 5);
  const ctx = await boot({ hash: `#${n5.id || `n${n5.n}`}` });
  ctx.click(ctx.byText('#reader-app .rd-bar-right button', 'cite'));
  await settle();
  const pline = ctx.w.document.querySelector('#reader-app [data-cite="passage"]');
  const got = pline ? pline.textContent.replace(/\s+/g, ' ').trim() : '';
  check(
    got.endsWith(`note ${n5.n}`),
    `a note's citation names the note and not the division the notes region sits after (${JSON.stringify(got)})`,
  );
  // FAILS IF: the clause is derived from currentSection — the last division
  // before the notes region is §18, and every note would be cited as §18.
  check(!/§/.test(got), 'and it claims no division for a note');
}

{
  /* THE CITATION IS ABOUT THE PASSAGE IT WAS OPENED ON (plan §11 phase 5).
   * MEASURED in a real browser, and the reason this block exists: with the panel
   * rendered after the book in the flow, opening it moved focus to the bottom of
   * the document, the reader's position followed the scroll, and the panel then
   * cited the LAST note of the volume (§18, note 25) instead of the section the
   * reader had asked about. Happy-dom reproduces the position change exactly:
   * it has no layout, so every flow mark's rect is zero and the scroll report
   * lands on the last entry — which is the same value the real browser produced.
   * The two steps are asserted in order: first that the instrument MOVES the
   * position, then that the citation does not follow it. */
  const moved = await boot({ hash: '#s4-1' });
  const here0 = moved.w.document.querySelector('#reader-app .rd-here').textContent;
  moved.w.dispatchEvent(new moved.w.Event('scroll'));
  await settle();
  const here1 = moved.w.document.querySelector('#reader-app .rd-here').textContent;
  check(here0 !== here1, `a scroll report moves the reader's position (${JSON.stringify(here0)} → ${JSON.stringify(here1)})`);
  // FAILS IF: the scroll port is dead in this environment — the check below would
  // then pass for the wrong reason, asserting nothing.

  const ctx = await boot({ hash: '#s4-1' });
  ctx.click(ctx.byText('#reader-app .rd-bar-right button', 'cite'));
  await settle();
  const before = (ctx.w.document.querySelector('#reader-app [data-cite="passage"]') || {}).textContent;
  const urlBefore = (ctx.w.document.querySelector('#reader-app [data-cite="passage-url"]') || { getAttribute: () => '' }).getAttribute('href');
  ctx.w.dispatchEvent(new ctx.w.Event('scroll'));
  await settle();
  const after = (ctx.w.document.querySelector('#reader-app [data-cite="passage"]') || {}).textContent;
  const urlAfter = (ctx.w.document.querySelector('#reader-app [data-cite="passage-url"]') || { getAttribute: () => '' }).getAttribute('href');
  check(
    !!before && before === after && urlBefore === urlAfter,
    `and a position change while the panel is open does not change the citation it was opened to give (${JSON.stringify(after)})`,
  );
  // FAILS IF: the panel derives its passage from the live position — the citation
  // then follows the scroll, which in a real browser meant the panel answering
  // with the end of the book.
  check(/§4/.test(after || ''), `and the panel still cites the division it was opened on (${JSON.stringify(after)})`);
  // FAILS IF: the freeze is lost in some other way (a re-render that drops it).
}

{
  /* RANGE PRINT (plan §11 phase 5, the notes as endnotes). Setting a printed-page
   * range keeps the passages inside it and prints the notes those passages refer
   * to at the back — the annotations are not stripped out of a range, and the
   * front matter (which has no printed number) is not carried into a print of
   * numbered pages. Both expectations are recomputed from the served document:
   * the references standing on the range's pages, plus the notes whose own page
   * the volume prints inside it. The range itself is CHOSEN FROM THE DOCUMENT —
   * the printed page carrying the most note references — so the instrument
   * cannot quietly test a page with nothing on it. */
  const docJson = JSON.parse(docText);
  const refsByPage = new Map();
  {
    let page = null;
    for (const b of docJson.blocks) {
      if (b.t === 'pb' && b.page != null) page = b.page;
      if (b.t === 'ref' && page != null) {
        if (!refsByPage.has(page)) refsByPage.set(page, []);
        refsByPage.get(page).push(b.n);
      }
    }
  }
  const pick = [...refsByPage.entries()].sort((a, b) => b[1].length - a[1].length)[0] || [15, []];
  const range = [pick[0], pick[0]];
  const refsInRange = new Set();
  const defsInRange = new Set();
  {
    let page = null;
    for (const b of docJson.blocks) {
      if (b.t === 'pb' && b.page != null) page = b.page;
      const inside = page != null && page >= range[0] && page <= range[1];
      if (b.t === 'ref' && inside) refsInRange.add(b.n);
      if (b.t === 'notedef' && inside) defsInRange.add(b.n);
    }
  }
  const wanted = new Set([...refsInRange, ...defsInRange]);
  const ctx = await boot();
  ctx.click(ctx.byText('#reader-app .rd-bar-right button', 'cite'));
  await settle();
  const boxes = [...ctx.w.document.querySelectorAll('#reader-app .rd-print-controls input')];
  check(boxes.length === 2, `the range is picked by printed page — two fields in the panel (${boxes.length})`);
  // FAILS IF: there is no range control, or it is not two printed-page fields.
  boxes[0].value = String(range[0]);
  boxes[0].dispatchEvent(new ctx.w.Event('input', { bubbles: true }));
  await settle();
  boxes[1].value = String(range[1]);
  boxes[1].dispatchEvent(new ctx.w.Event('input', { bubbles: true }));
  await settle();
  const notes = [...ctx.w.document.querySelectorAll('#reader-app .rd-note')].map((el) => ({
    n: Number(el.querySelector('.rd-note-n').textContent.trim()),
    out: el.classList.contains('rd-out'),
  }));
  const kept = notes.filter((x) => !x.out).map((x) => x.n).sort((a, b) => a - b);
  // A note is emitted as one block per paragraph the volume prints it in (note 8
  // and note 10 each stand in two), so the comparison is over the note NUMBERS
  // kept — and then over the blocks, because a rule that kept the first
  // paragraph of a note and dropped the second would pass a numbers-only check.
  const keptSet = [...new Set(kept)];
  const wantedSorted = [...wanted].sort((a, b) => a - b);
  check(
    keptSet.join(',') === wantedSorted.join(','),
    `a ${range[0]}–${range[1]} print keeps exactly the notes its pages refer to or print (${keptSet.join(', ')} of ${notes.length} blocks; wanted ${wantedSorted.join(', ')})`,
  );
  // FAILS IF: a range still prints every note (the rule is not applied) or none
  // of them (the annotations are dropped, which is what the page did before).
  const wantBlocks = notes.filter((x) => wanted.has(x.n)).length;
  check(
    kept.length === wantBlocks,
    `and every block of those notes is kept, not only their first (${kept.length} of ${wantBlocks})`,
  );
  // FAILS IF: the rule is applied per note rather than per block, so a note whose
  // text runs over two paragraphs is printed half-thrown-away.
  check(
    wanted.size > 0 && wanted.size < notes.length,
    `and that is neither all nor none of them (${wanted.size} notes of ${notes.length} blocks)`,
  );
  // FAILS IF: the page the instrument picked carries no note and no note is
  // printed — the equality above would then hold between two empty sets and the
  // assertion would be measuring nothing.
  const front = [...ctx.w.document.querySelectorAll('#reader-app .rd-in-front')];
  const frontOut = front.filter((el) => el.classList.contains('rd-out')).length;
  check(
    front.length > 0 && frontOut === front.length,
    `and the front matter — which has no printed number — is not carried into a print of numbered pages (${frontOut} of ${front.length} out)`,
  );
  // FAILS IF: an entry with no readable page is kept by a ranged print, which is
  // how the title pages and the digitiser's stamp used to ride along with any
  // range at all.
  const clearBtn = [...ctx.w.document.querySelectorAll('#reader-app .rd-print-controls button')].find(
    (b) => /whole text/.test(b.textContent),
  );
  if (clearBtn) {
    ctx.click(clearBtn);
    await settle();
    const all = [...ctx.w.document.querySelectorAll('#reader-app .rd-note')].filter(
      (el) => !el.classList.contains('rd-out'),
    ).length;
    check(all === notes.length, `and the whole text prints every note again (${all} of ${notes.length})`);
    // FAILS IF: the range cannot be cleared — a reader who printed a range would
    // be stuck with a book of missing notes.
  }
}

{
  // the progress meter excludes the front matter and the end matter: the
  // region marks exist for exactly this, and a reader who has finished the notes
  // has finished the book whatever the publisher's catalogue after it says.
  //
  // Driven by JUMPS, not by scrolling: happy-dom has no layout, so every
  // element's rect is zero and a scroll-derived position would report whatever
  // the instrument happens to compute rather than what the page does. The
  // scroll path is checked in a real browser instead (the render pass).
  const atFront = await boot();
  const frontPct = pctOf(atFront);
  check(frontPct === 0, `a reader in the front matter has read 0% (${frontPct}%)`);
  // FAILS IF: the front matter is counted — the book then opens part-read.
  const atNotes = await boot({ hash: '#n25' });
  const notesPct = pctOf(atNotes);
  check(notesPct === 100, `a reader at the last note has read the whole text (${notesPct}%)`);
  // FAILS IF: the end matter is counted — the last note then reads well
  // below 100%, which is the bug the region marks exist to prevent.
  const atAds = await boot({ hash: '#s9' });
  const midPct = pctOf(atAds);
  check(midPct > 20 && midPct < 70, `and a reader in section 9 is part-way through (${midPct}%)`);
  // FAILS IF: the meter is not derived from the position at all, or the region
  // marks are misattributed (every entry reading as the same region).
}

{
  // THE TWO PAGES WITH NO NUMBER, and they are not the same kind of thing (phase
  // 4). One is a marker the TRANSCRIPTION carries — the damaged folio "3" at the
  // foot of a leaf whose own head already reads 33 — so the transcription's own
  // character is shown and the marker says it is not a number. The other is a
  // LEAF BOUNDARY the transcription carries nothing at all for (the page whose
  // running head is missing from the transcription): its number could not be read
  // because there is nothing there to read, so its marker carries no character —
  // and the page model names the leaf it stands on, which is the fact the earlier
  // txt-mode model could not state.
  const ctx = await boot();
  const refused = ctx.w.document.querySelectorAll('#reader-app [data-page="refused"]');
  check(refused.length === 2, `the two page markers with no number are rendered (${refused.length})`);
  // FAILS IF: an unnumbered page is dropped from the rendering (a reader then
  // cannot see that the volume has a gap), or a number is invented for it.
  const texts = [...refused].map((r) => r.textContent);
  check(
    texts.every((t) => !/^\s*\d+\s*$/.test(t)) && texts.some((t) => t.includes('could not be read')),
    `and they say what they are, not a number (${JSON.stringify(texts)})`,
  );
  // FAILS IF: the marker prints a plausible number — the fabrication the plan's
  // refusal rule exists to prevent.
  check(
    [...refused].some((r) => /\[\s*3\s/.test(r.textContent)),
    `the marker the transcription carries shows its own character, not a number (${JSON.stringify(texts)})`,
  );
  /* THE GAP BETWEEN THE DOCUMENT AND THE APP, asserted so it cannot be forgotten
   * (phase 4): the document now names the LEAF every page marker stands on, and
   * the app does not read that field, so the marker of a leaf boundary with no
   * readable number renders as an empty pair of brackets rather than as "leaf 28".
   * The document is right and the app is behind it: this check states the current
   * rendering AND that the fact it should show is in the document. */
  const doc = JSON.parse(readFileSync(DOC, 'utf8'));
  const structural = doc.blocks.filter((b) => b.t === 'pb' && b.how === 'leaf');
  check(
    structural.length === 1 && structural[0].leaf === 28 && structural[0].page === null,
    `the document marks the boundary the transcription carries no head for, and names its leaf (${JSON.stringify(structural)})`,
  );
  check(
    [...refused].every((r) => r.textContent.trim().length > 0),
    'and each unnumbered marker renders something (an empty marker would be invisible)',
  );
  check(
    ![...refused].some((r) => /leaf 28/.test(r.textContent)),
    'the app does NOT yet render the leaf number of an unnumbered boundary — the document names leaf 28 there and the reader is shown an empty marker: the app decodes page/how/id/x and never the leaf, so showing it is a change in the reader app, not in the document',
  );
}

{
  // search runs over the text proper only: the front matter is the title page,
  // and the end matter is the publisher's list of books
  const ctx = await boot();
  const q = ctx.w.document.getElementById('rd-q');
  q.value = 'Watkins';
  q.dispatchEvent(new ctx.w.Event('input', { bubbles: true }));
  await settle();
  const count = ctx.w.document.querySelector('#reader-app .rd-count').textContent.trim();
  check(count === 'no match', `a word in the end matter is not found (${JSON.stringify(count)})`);
  // FAILS IF: the end matter is searched — "Watkins" is on the title page, in the
  // list, and nowhere in the text.
  q.value = 'Mithra';
  q.dispatchEvent(new ctx.w.Event('input', { bubbles: true }));
  await settle();
  const hits = ctx.w.document.querySelector('#reader-app .rd-count').textContent.trim();
  // the count is the number of PASSAGES holding the query, which is what the
  // next/prev controls step between — labelled as such, so the number cannot be
  // read as something it is not
  const { hits: occurrences } = occurrenceCounts();
  check(hits === `1 of ${occurrences} passages`, `a word in the text is found, with its count (${JSON.stringify(hits)})`);
  // FAILS IF: the search is inert, or the count is not what the text holds —
  // recomputed here from the served document, never from the app.
  // FAILS IF: the search is inert, or finds nothing in a word the text holds.
  const next = ctx.byText('#reader-app .rd-search button', '↓');
  check(!!next && !next.disabled, 'and next/prev are enabled once there is a match');
  // FAILS IF: the controls are not wired to the hit list.
}

/* ---------- 12. the toolbar sits below the header, not under it ---------- */

section('the sticky toolbar clears the site header');
{
  /* THE BUG (the author's report): the blog's header covered the reader's toolbar
   * while scrolling. The nav is sticky at top:0 and its height is not a constant
   * (its .wrap is flex-wrap with a 52px minimum, so it grows when the links wrap);
   * the toolbar stuck at a hard-coded 52px, so a taller nav covered it.
   *
   * happy-dom has no layout, so the offset cannot be measured here — what CAN be
   * asserted is the wiring that makes the measurement happen: the toolbar's sticky
   * top is a variable (not a constant), and the shell measures the nav into it. */
  const barRule = /\.rd-bar \{[^}]*position:\s*sticky[^}]*\}/.exec(html);
  check(!!barRule, 'the toolbar has a sticky rule in the shell');
  check(
    !!barRule && /top:\s*var\(--nav-h/.test(barRule[0]),
    `and its sticky top is the measured nav height, not a constant (${barRule ? barRule[0].replace(/\s+/g, ' ').trim().slice(0, 100) : 'no rule'})`,
  );
  check(
    /--nav-h/.test(html) && /getBoundingClientRect/.test(html) && /setProperty\('--nav-h'/.test(html),
    'and the shell MEASURES the nav into it (getBoundingClientRect -> --nav-h)',
  );
  // FAILS IF: the offset goes back to a magic number, which is the bug — the nav
  // is taller than the guess as soon as its links wrap.
  check(
    /scroll-margin-top:\s*calc\(var\(--nav-h/.test(html),
    'and a jumped-to anchor lands below the header and toolbar, not under them',
  );
  // FAILS IF: the toolbar sticks over the prose with no background of its own.
  // That is a real bug the author reported: the controls were drawn straight over
  // the text and read as part of it.
  const barCss = /\.rd-bar \{[^}]*\}/.exec(html);
  check(
    !!barCss && /background:\s*var\(--bg\)/.test(barCss[0]),
    `the toolbar has its OWN opaque background (${barCss && /background:[^;]*/.exec(barCss[0]) ? /background:[^;]*/.exec(barCss[0])[0] : 'none'})`,
  );
  // FAILS IF: the band below the bar is a margin (or a full-width shadow, the
  // first attempt) instead of padding — the background then does not cover it, or
  // it covers the SIDEBAR's top, which is the reading-progress meter.
  check(
    !!barCss && /padding:\s*8px 0 18px/.test(barCss[0]) && !/box-shadow:\s*0 18px/.test(barCss[0]),
    'and the gap below it is padding the background covers, not a margin or a shadow over the sidebar',
  );
  // FAILS IF: the contents sidebar sticks at a constant below the toolbar — its
  // own top (the progress meter) then goes under a wrapped bar.
  check(
    /\.rd-nav \{[^}]*top:\s*calc\(var\(--nav-h[^;]*var\(--bar-h/.test(html),
    'and the sidebar sticks below the MEASURED toolbar height, so the progress meter is not covered',
  );
  check(
    /--bar-h/.test(html) && /#reader-app \.rd-bar/.test(html),
    'and the shell measures the toolbar into --bar-h',
  );
}

console.log(
  failures === 0
    ? `\nAPP SMOKE PASSED (${html.length} B shell, ${docText.length} B document)`
    : `\n${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
