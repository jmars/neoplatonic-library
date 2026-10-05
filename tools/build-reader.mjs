#!/usr/bin/env node
/**
 * tools/build-reader.mjs — the reader app's committed-bundle contract.
 *
 * The Elm source is the source of truth; the browser gets a stripped, committed
 * bundle (tools/app.js) inlined into the library pages, committed so the default
 * build needs no Elm at all; READER=1 is the only path that compiles anything.
 *
 * The steps, and why each exists:
 *
 *   make   — elm make elm/src/Reader.elm -> elm/Reader.js (raw output, a build
 *            artifact, not committed: it is not gate-clean);
 *   strip  — the page build's own strip (see `borrow` below). The raw bundle
 *            carries comment delimiters the workshop-leak gate fails on (211
 *            hits, measured), so the emitted copy is stripped while the sources
 *            keep their comments;
 *   gate   — ASSERT the stripped bundle is clean against the page build's own
 *            patterns. A bundle that trips the gate would otherwise fail the page
 *            build much later, pointing at the shell rather than at the strip;
 *   boot   — run the stripped bundle in happy-dom exactly as a browser would:
 *            mount it on a document, hand it a real served document, and check it
 *            rendered and answered. The unresolved risk this closes is measured,
 *            not argued: comment-stripping is unproven on string literals, so if
 *            the strip corrupts the program the BUILD FAILS here — never a
 *            browser.
 *
 * The strip and the gate live in build/leak.mjs and are IMPORTED here: the
 * blog's source-slicing borrow is deleted (the module has no import side
 * effects), so there is one implementation and no string markers to drift.
 *
 *   node tools/build-reader.mjs        (run from the repo root)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RAW = join(ROOT, 'elm', 'Reader.js');
const OUT = join(ROOT, 'tools', 'app.js');
const SLUG = 'porphyry-on-the-cave-of-the-nymphs-taylor-1917';
const DOC = join(ROOT, 'site', 'dist', 'texts', SLUG, 't');

/** The document the boot check feeds the app: the built one when there is one
 * (that is what the page serves), and otherwise the extractor's own output for
 * the stored edition. The regenerator runs BEFORE the page build has written the
 * document — the bundle has to exist before the shell can inline it — so asking
 * the build for it would be a circular dependency, not a check. */
async function sampleDocument() {
  if (existsSync(DOC)) return readFileSync(DOC, 'utf8');
  const { extract, serialiseDoc, hasEdition, editionPath, readEdition, sha256 } = await import(
    './extract.mjs'
  );
  const { TEXTS } = await import('./shelf.mjs');
  const entry = TEXTS.find((t) => t.slug === SLUG);
  if (!entry || !hasEdition(SLUG)) {
    throw new Error(`no stored edition for ${SLUG} — the reader's boot check needs one to render`);
  }
  const src = readEdition(SLUG) || readFileSync(editionPath(SLUG), 'utf8');
  log('the document is not built yet: extracting it here for the boot check');
  return serialiseDoc(extract(src, { entry, sha256: sha256(src) }));
}

const log = (msg) => console.log(`[reader] ${msg}`);

/* ---------- the page build's own strip and gate ---------- */

/** THE BORROW IS GONE (extraction plan §1.4). It existed only because
 * build.mjs is a script that runs the whole site when imported, so its
 * definitions had to be sliced out of its source text by string markers — the
 * one place where the blog's machinery could break silently. build/leak.mjs is
 * a real module with no import side effects, so the strip and the gate are
 * imported like anything else and there is ONE implementation. */
import { stripJsComments, checkWorkshop } from '../build/leak.mjs';

/* ---------- stripping comments ---------- */

/**
 * Remove JS comments the way a browser's lexer reads them: `//` and the block
 * opener are comments wherever they occur, strings are copied verbatim, and a
 * slash that is neither starts a regex or divides.
 *
 * Why this is here and not the page build's stripComments: that one is a REGEX
 * over a block comment, and the compiler's output uses the slash-star/slash-slash
 * idiom (elm/core's Utils.js) to comment out dead branches. A regex matcher finds
 * a block opener INSIDE a line comment and consumes it to the next terminator,
 * leaving a stray slash on the line — which is a syntax error. MEASURED: the page
 * build's strip produces code the engine refuses to parse, and the boot assertion
 * below is what caught it (the plan's own risk 4, met exactly as written). The
 * page build keeps its strip for the scripts it inlines — it is fine for
 * hand-written widgets — and this lexer runs first here, so `stripJsComments`
 * still runs over the bundle as a final pass (a no-op: nothing is left to remove)
 * rather than a second policy replacing it.
 */
function stripCommentsLexed(src) {
  const isId = (c) => /[A-Za-z0-9_$]/.test(c);
  const regexAllowedAfter = (c) =>
    c === undefined ||
    '([{,;=:!&|?+-*%^~<>'.includes(c) ||
    c === '}' ||
    c === ')' ||
    c === '\n';
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // `//` is ALWAYS a line comment; `/*` is ALWAYS a block comment. The lexical
    // grammar decides this before any expression context does — which is exactly
    // how the compiler's `//*‍/` closers work.
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      i += 1;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          out += ch + (src[i + 1] || '');
          i += 2;
          continue;
        }
        out += ch;
        i += 1;
        if (ch === c || ch === '\n') break;
      }
      continue;
    }
    if (c === '`') {
      // a template literal; `${` re-enters code, so the nesting is tracked
      out += c;
      i += 1;
      let depth = 0;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          out += ch + (src[i + 1] || '');
          i += 2;
          continue;
        }
        if (ch === '`' && depth === 0) {
          out += ch;
          i += 1;
          break;
        }
        if (ch === '$' && src[i + 1] === '{') {
          depth += 1;
          out += '${';
          i += 2;
          continue;
        }
        if (ch === '}' && depth > 0) depth -= 1;
        out += ch;
        i += 1;
      }
      continue;
    }
    if (c === '/' && regexAllowedAfter(out.trimEnd().slice(-1))) {
      // a regex literal: copy it verbatim, character classes and escapes intact
      out += c;
      i += 1;
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          out += ch + (src[i + 1] || '');
          i += 2;
          continue;
        }
        out += ch;
        i += 1;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        else if (ch === '\n') break;
      }
      while (i < n && isId(src[i])) {
        out += src[i];
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/* ---------- toolchain ---------- */

function find(dir, what, env) {
  const candidates = [process.env[env], join(ROOT, dir), join(ROOT, '..', 'fixpoint-linux', 'fixpointlinux.org', dir)].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`${what} not found (looked in ${candidates.join(', ')})`);
}

/* ---------- 1. make ---------- */

function make() {
  const elm = find(join('node_modules', '.bin', 'elm'), 'elm', 'ELM');
  log('elm make src/Reader.elm');
  execFileSync(elm, ['make', 'src/Reader.elm', '--optimize', `--output=${RAW}`], {
    cwd: join(ROOT, 'elm'),
    stdio: 'inherit',
  });
  return readFileSync(RAW, 'utf8');
}

/* ---------- the DOM the bundle is booted in ---------- */

/** A classic script reads `document`, `requestAnimationFrame` and the rest from
 * the GLOBAL scope, and the compiled bundle captures them once at load time
 * (`var _VirtualDom_doc = typeof document !== 'undefined' ? document : {}`). So
 * the stub has to put a real DOM on the global object before the code is
 * evaluated — passing them as parameters would leave `document` undefined and
 * Elm would render into a fake node. */
function installGlobals(w) {
  const names = [
    'window', 'document', 'navigator', 'location', 'history', 'customElements', 'performance',
    'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage',
    'getComputedStyle', 'matchMedia', 'IntersectionObserver',
    'HTMLElement', 'HTMLDivElement', 'HTMLSpanElement', 'HTMLAnchorElement', 'HTMLButtonElement',
    'HTMLInputElement', 'HTMLParagraphElement', 'Element', 'Node', 'Document', 'DocumentFragment',
    'Text', 'Comment', 'NodeList', 'HTMLCollection', 'Event', 'CustomEvent', 'MouseEvent',
    'KeyboardEvent', 'UIEvent', 'EventTarget', 'MutationObserver',
  ];
  const bound = new Set(['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'getComputedStyle', 'matchMedia', 'fetch']);
  for (const name of names) {
    const value = w[name];
    if (value === undefined) continue;
    Object.defineProperty(globalThis, name, {
      value: bound.has(name) && typeof value === 'function' ? value.bind(w) : value,
      configurable: true,
      writable: true,
    });
  }
}

/* ---------- 4. boot in a DOM ---------- */

async function assertBoots(code) {
  const require = createRequire(import.meta.url);
  const { Window } = require(find(join('node_modules', 'happy-dom'), 'happy-dom', 'HAPPY_DOM'));

  const docText = await sampleDocument();

  const window = new Window();
  installGlobals(window);
  const document = window.document;
  globalThis.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve(docText) });

  const node = document.createElement('div');
  node.id = 'reader-app';
  document.body.appendChild(node);

  const scrolled = [];
  window.HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this.id);
  };

  // eslint-disable-next-line no-eval -- indirect eval evaluates in the global
  // scope, which is where a classic script runs and where Elm binds itself
  (0, eval)(code);

  const Elm = globalThis.Elm;
  if (!Elm || !Elm.Reader || typeof Elm.Reader.init !== 'function') {
    throw new Error('the stripped bundle did not define Elm.Reader.init');
  }

  const app = Elm.Reader.init({
    node,
    flags: {
      slug: SLUG,
      url: `/texts/${SLUG}/t`,
      base: `/texts/${SLUG}/`,
      hash: '',
      citation: {
        author: 'Porphyry',
        title: 'On the Cave of the Nymphs',
        translator: 'Thomas Taylor',
        place: 'London',
        publisher: 'John M. Watkins',
        year: '1917',
      },
      // the edition's repair state — the reader shows it in its repairs list.
      // A flag the boot check must carry: Elm's own flags decoder requires the
      // key even when the value is null (a Maybe field is not optional in flags).
      repair: { state: 'in-repair', label: 'in repair', note: 'readable end to end, and not finished.' },
      stored: null,
    },
  });
  app.ports.requestDoc.subscribe((url) => {
    globalThis
      .fetch(url)
      .then((r) => r.text())
      .then((t) => app.ports.docReceived.send(t));
  });
  app.ports.jumpTo.subscribe((id) => scrolled.push(id));
  app.ports.persist.subscribe(() => {});

  const tick = () => new Promise((r) => setTimeout(r, 0));
  await tick();
  await tick();
  await tick();

  const html = node.innerHTML;
  const checks = [
    ['it rendered the document', html.includes('What does Homer obscurely signify')],
    ['the section anchors are there', html.includes('id="s4"')],
    ['the page anchors are there', html.includes('id="p15"')],
    ['the contents list is there', html.includes('Contents')],
  ];
  const bad = checks.filter((c) => !c[1]).map((c) => c[0]);
  if (bad.length) {
    throw new Error(`the stripped bundle booted but ${bad.join('; ')} (${html.length} B of output)`);
  }
  return { bytes: html.length, scrolled };
}

/* ---------- main ---------- */

async function main() {
  const raw = make();
  const stripped = stripJsComments(stripCommentsLexed(raw));
  const problems = checkWorkshop(stripped);
  if (problems.length) {
    throw new Error(
      `the stripped bundle is not gate-clean — it would fail the page build:\n${problems
        .slice(0, 10)
        .join('\n')}\n(${problems.length} problem(s))`,
    );
  }
  const boot = await assertBoots(stripped);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, stripped);
  const gz = (s) => gzipSync(Buffer.from(s)).length;
  log(
    `raw ${raw.length} B -> stripped ${Buffer.byteLength(stripped)} B ` +
      `(${gz(raw)} B gz raw, ${gz(stripped)} B gz stripped)`,
  );
  log(`booted in a DOM: ${boot.bytes} B rendered — wrote tools/app.js`);
}

main().catch((err) => {
  console.error(`[reader] failed: ${err.message}\n${err.stack}`);
  process.exit(1);
});
