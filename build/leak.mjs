/**
 * build/leak.mjs — the workshop-leak gate, and the comment strippers it pairs
 * with. Lifted VERBATIM out of the blog's tools/build.mjs (GATE_PATTERNS,
 * gateSafeText, checkWorkshop, checkWorkshopAll, stripComments,
 * stripJsComments), for two reasons:
 *
 *   1. the page build, the library rendering and tools/build-reader.mjs must
 *      share ONE definition of what a leak is — three copies would drift;
 *   2. build.mjs is a SCRIPT (importing it runs the whole blog build), which
 *      is why build-reader.mjs used to slice these definitions out of its
 *      source text. As a real module with no import side effects, this file
 *      deletes that borrow: `import { stripJsComments, checkWorkshop } from
 *      '../build/leak.mjs'` is the whole of it (extraction plan §1.4).
 *
 * The migration is a copy at a point in time; from here the two repositories
 * evolve separately (stated in the plan).
 */

const log = (msg) => console.log(`[build] ${msg}`);

/**
 * WHAT THE GATE LOOKS FOR, AND WHY SOME RULES ARE MARKED `prose`.
 *
 * A rendered PAGE is the site's own chrome and prose, so a phrase like "the
 * extract" or "the brief" there is workshop vocabulary and a leak.
 *
 * A rendered DATA FILE is a BOOK'S OWN TEXT — the shelf's passages, a document, a
 * feed. MEASURED: the phrase "the extract" occurs in the books themselves ("the
 * whole of the extract likewise is the result of...", "the extract from Zosimus"),
 * and `252KB` turned up inside OCR debris. A phrase rule cannot tell the site's
 * vocabulary from a 19th-century author's, so on a data file it is a false
 * positive by construction.
 *
 * So the rules are split by what they can legitimately mean. `hard` rules — a
 * path, an internal filename, a source-file extension — name the site's
 * construction and can NEVER be a printed book's text; they run everywhere. The
 * `prose` rules run on pages, where they are leaks, and are skipped on data files,
 * where they are the book speaking. Only the paths-and-filenames half can be
 * checked everywhere, and that is the honest half to rely on.
 */
export const GATE_PATTERNS = [
  // internal filenames and paths (a reader has none of these) — HARD
  [/\b(?:build|check-scope|extract-css|viz-smoke|viz-shots)\.(?:mjs|sh)\b/, 'internal script name', 'hard'],
  [/\btools\/(?:build|viz|check-scope)[\w./-]*/, 'internal path', 'hard'],
  /* MEASURED: this read `\blog\.css\b`, whose `\b` sits between the `b` and the
   * `l` of `blog.css` — a position with no word boundary, so the rule could never
   * match the file it names (it matched a standalone `log.css` instead, which is
   * not a file here). The gate stayed green on a real `blog.css` mention. */
  [/\bposts\.json\b|\bcontinuity\.md\b|\bblog\.css\b/, 'internal file name', 'hard'],
  // a home path. `~` or `/home/<user>/` — the user is NOT one character: MEASURED,
  // the old pattern's `[a-z]` matched a SINGLE-character home and MISSED a longer
  // one, so a real absolute path could ship while the gate stayed green.
  [/(?:^|["'\s(])(?:~|\/home\/[\w.-]+)\/[\w./-]+/, 'local filesystem path', 'hard'],
  // A source-file name — EXCEPT the site's own published exports. `data/corpus.json`
  // and `data/graph.json` are PUBLIC addresses the data model names (§8); a page
  // must be able to link them, and they are exempted EXACTLY (see PUBLIC_EXPORTS
  // in checkWorkshop — a whole address, and nothing after it).
  //
  // THIS PATTERN IS THE BLOG'S OWN, UNRELAXED. MEASURED: it was relaxed here with
  // a `(?<!\/data\/)` lookbehind so the two exports would pass, and that exempted
  // EVERY depth-1 name under `/data/` — `/data/secret.txt`, `/data/internal.json`
  // and `/data/foo.mjs` all passed. The exemption belongs to the two addresses,
  // not to the directory. Do not relax it again: the directory test is what makes
  // this rule able to fail.
  [/\b[\w.-]+\.(?:txt|mjs|json)\b(?=[\s"',.)]|$)/, 'source-file name', 'hard'],
  // file-size / extraction-mechanics claims — PHRASES, so pages only
  [/\b\d[\d,]{2,}\s*(?:bytes|KB|MB)\b/i, 'file size', 'prose'],
  [/\b\d[\d,]{3,}\s+characters\b/, 'character count', 'prose'],
  [/\bno newline\b|\bwhitespace[- ]collaps|\bjumbled page order\b|\bwatermark-delimited\b|\bthe scan\b|\bthe extract\b/i, 'extraction mechanics', 'prose'],
  // authoring references — PHRASES, so pages only ("the manifest" is ordinary
  // English in a religious book)
  [/\bthe brief\b|\bthe reading list\b|\bthe manifest\b|\bthe plumbing\b|\bthe build\b(?!\s+in\b)|\bthe corpus\b/i, 'authoring reference', 'prose'],
  // a comment delimiter that reached emitted code — CODE, so not in a data file
  [/\/\*\s*[-=]*\s*[a-z]/i, 'source comment in emitted code', 'comment'],
  [/^\s*\/\/\s/m, 'source comment in emitted code', 'comment'],
];

/** Neutralise, in library text only, the sequences the leak gate reads as
 * workshop tokens — by replacing ONE character of each with its numeric HTML
 * character reference.
 *
 * The gate is the site's promise that a reader never sees how the site is
 * built, and it is a byte test on the emitted page. A 400-page scan of a book
 * legitimately contains byte sequences a *comment* would use: an asterisk
 * against a slash in a footnote, and — the ones that actually occur here — the
 * English words the gate's authoring rule names. Neither is a leak; both would
 * fail the build. The character reference makes the emitted bytes different and
 * the RENDERED page identical: the reader sees exactly the character the
 * transcription holds, because that is what `&#47;` renders as. Nothing is
 * dropped and nothing is reworded — the text is the text; only its serialisation
 * differs. Counts are logged, so a text that needed this is visible in the build
 * log rather than silently patched. */
export function gateSafeText(html, what) {
  let out = html;
  let n = 0;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const [re] of GATE_PATTERNS) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      out = out.replace(g, (m) => {
        const i = m.search(/[A-Za-z0-9/]/);
        if (i < 0) return m;
        changed = true;
        n++;
        return m.slice(0, i) + `&#${m.charCodeAt(i)};` + m.slice(i + 1);
      });
    }
    if (!changed) break;
  }
  if (n) log(`${what}: ${n} sequence(s) written as character references so the leak gate reads no workshop token`);
  return out;
}

/** The workshop-leak gate: a page must not tell the reader how the site is
 * built. Two whole audits were needed to find leaks that had reached the public
 * HTML — internal filenames and paths, file sizes, extraction mechanics — and
 * the second found two that the first fix had missed, so this runs on every
 * build rather than when someone remembers to look.
 *
 * It scans the RENDERED output (the same text a reader gets, including inlined
 * widget scripts and CSS), not the sources: a leak can enter through an inlined
 * asset even when the prose is clean, which is exactly how the build.mjs and
 * tools/viz comments got out. Patterns are deliberately tight — a file path, a
 * size claim, a comment delimiter in emitted code — because the posts
 * legitimately contain words like "characters", "the file" in a quotation, or
 * "scan". Where a legitimate use exists it is named in `allowed` or the pattern
 * is narrowed until it cannot match it. Fail loudly rather than warn: a leak
 * that ships is not recoverable by later noticing it. */
export function checkWorkshop(html, opts = {}) {
  // Legitimate uses the tight patterns above could still catch, by exact text.
  const allowed = [
    'the build in', 'the build of', // ordinary prose, not the build process
  ];
  /* THE SITE'S OWN PUBLISHED ADDRESSES, and only these: the source-file-name rule
   * above would otherwise read them as the site's own construction, and a page
   * must be able to link them. They are matched as WHOLE ADDRESSES — the address
   * ending at the match, with a real delimiter after it — and NOT by the
   * window-substring test `allowed` uses for prose, because a substring test
   * cannot tell the sanctioned address from a longer name that merely contains it:
   * MEASURED, '/data/corpus.json.txt' contains '/data/corpus.json', so the
   * substring form would have exempted exactly the leak this rule exists to catch.
   * A name elsewhere under `/data/` (`/data/secret.txt`), a same-named file in
   * another directory (`/data2/corpus.json`, `data/corpus.json`), and a longer
   * name (`/data/corpus.json.txt`) all still fail.
   *
   * The apparatus data file (DATA-MODEL §7) is the third public address: a page
   * the viewer's no-script and failure paths must link, at
   * `/texts/<slug>/apparatus.json` and, for a pinned page,
   * `/texts/<slug>/v/<semver>/apparatus.json`. It is sanctioned as a WHOLE
   * address of that exact shape — one optional `v/<semver>/` segment after ONE
   * slug segment — so `/texts/x/y/apparatus.json`, `/answers/apparatus.json` and
   * `/data/apparatus.json` are still leaks. */
  const PUBLIC_EXPORTS = ['/data/corpus.json', '/data/graph.json'];
  const APPARATUS_ADDRESS = /^\/texts\/[\w.-]+\/(?:v\/[\w.-]+\/)?apparatus\.json$/;
  const isPublicExport = (s, at, len) => {
    // a longer name ('…apparatus.json.txt') is not the address
    if (/[\w.-]/.test(s[at + len] || '')) return false;
    const before = s.slice(0, at + len);
    if (PUBLIC_EXPORTS.some((a) => before.endsWith(a))) return true;
    const tail = before.slice(Math.max(0, before.lastIndexOf('/texts/')));
    return APPARATUS_ADDRESS.test(tail);
  };
  // A base64 data: URI is INLINED BINARY — a reader sees an image, not text, and
  // the payload is not something anyone reads. Its alphabet can contain anything,
  // including a string that matches a pattern below (a header image whose base64
  // happened to contain "615Kb" tripped the file-size rule). Scanning it is
  // scanning noise, and the result was a build that failed or passed depending on
  // which image was inlined. The payload is blanked first; everything readable on
  // the page is still scanned exactly as before, so the check is not weakened —
  // a leak cannot hide in binary, because a reader cannot read binary. Only a run
  // of 32+ base64 characters that ENDS AT A DELIMITER is treated as payload: the
  // base64 alphabet is letters, so a shorter rule would eat the first letters of a
  // word glued to a data URI ('...base64,AAthe brief' would hide 'the brief').
  const scanned = html.replace(/(data:[\w.+-]+\/[\w.+-]+;base64,)[A-Za-z0-9+/=]{32,}(?=["')\s<])/g, '$1<binary>');
  const problems = [];
  for (const [re, what, kind] of GATE_PATTERNS) {
    // On a DATA FILE, the phrase rules are the book speaking, not the site: skip
    // every rule that is not `hard` — a path, an internal filename, a source-file
    // extension, none of which a printed book can contain.
    if (kind !== 'hard' && opts.data) continue;
    /* A PROVENANCE RECORD — the corpus export, which is the edition records
     * TAKEN WHOLE. Those records name the EXTERNAL files they were read from (the
     * archive item's own `.txt`, the shelf file the transcription was imported
     * from, the version's own `repairs.json`), which is provenance the model
     * requires and which the two rules below exist to catch only when the name is
     * THIS repo's construction. The export is generated mechanically from data/,
     * so there is no hand-written prose in it to leak: the exemption is scoped to
     * the export, not to a page. */
    if (opts.provenance && (what === 'local filesystem path' || what === 'source-file name')) continue;
    for (const m of scanned.matchAll(new RegExp(re, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
      const at = m.index;
      const window = scanned.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ');
      if (allowed.some((a) => window.toLowerCase().includes(a))) continue;
      if (isPublicExport(scanned, at, m[0].length)) continue;
      problems.push(`  ${what}: ${JSON.stringify(window.trim())}`);
    }
  }
  return problems;
}

/** Run checkWorkshop over every written page and file, and fail the build. */
export function checkWorkshopAll(written, files) {
  const problems = [];
  for (const { rel, html } of written) {
    for (const p of checkWorkshop(html)) problems.push(`${rel}:${p}`);
  }
  /* EVERYTHING IN `files` IS A DATA FILE, not a page: `written` holds the pages,
   * `files` holds the exports, the sitemap and robots. So the `data` flag is a
   * fact about the list, not a guess from a filename — and that matters, because
   * the document endpoints (`/t`) are EXTENSIONLESS on purpose (a `.json`-looking
   * name reaching emitted text trips the gate itself). A name test missed it; the
   * list cannot. */
  for (const { rel, text } of files) {
    for (const p of checkWorkshop(text, { data: true })) problems.push(`${rel}:${p}`);
  }
  if (problems.length) {
    throw new Error(
      `workshop leak(s) in the rendered output — a reader must never see how the site is built:\n` +
        problems.join('\n'),
    );
  }
}

/** Strip `/* … *\/` comments from text on its way into a page.
 *
 * The source comments in PAGE_CSS, design/ and the widgets name internal
 * files and describe the build. They are for whoever maintains this, not for the
 * reader, and the build inlines the CSS and the widget scripts verbatim into
 * every page — so without this the public HTML carried the workshop's own
 * filenames. Comments are kept in the source files; only the emitted copy is
 * stripped. (CSS has no nested comments and nothing in these files holds a
 * comment delimiter inside a string, so the strip is safe.) */
export const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** The same for the widget scripts, where `//` line comments also occur.
 * The `[^:]` guard keeps a `://` inside a URL intact. */
export const stripJsComments = (s) => stripComments(s).replace(/(^|[^:\/])\/\/[^\n]*/g, '$1');
