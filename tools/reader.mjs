/**
 * tools/library/reader.mjs — the shelf's reader.
 *
 * The shelf holds archive.org OCR transcriptions (`_djvu.txt`) of the
 * public-domain editions the readings rest on. Those files are not prose: the
 * MEASURED shape of every one of them (probed on the files themselves) is
 *
 *   - paragraphs separated by a BLANK LINE;
 *   - inside a paragraph, HARD LINE BREAKS at roughly 60 characters;
 *   - DOUBLE SPACES between words, one space per physical line break;
 *   - words HYPHENATED ACROSS A LINE BREAK ("let-" / "ters").
 *
 * So the reader does four things, in this order, per text:
 *
 *   1. split the file into blocks on blank lines;
 *   2. classify a block as a HEADING (see `isHeading`) or as a paragraph —
 *      nothing is ever dropped: whatever is not a heading is a paragraph;
 *   3. inside a paragraph, join the lines, collapse runs of spaces to one, and
 *      DE-HYPHENATE across the line break;
 *   4. give every heading an id, so the page can carry a contents block (the
 *      site's own `toc()`, which reads `<h2 id="…">`).
 *
 * DE-HYPHENATION — the choice, and why. A line ending in "-" is treated as a
 * PRINTER'S LINE BREAK (the common case by far: dropped, and the two halves
 * joined with no space) whenever the next line begins with a lower-case letter
 * or a digit. It is treated as a REAL hyphen — kept, and still joined with no
 * space — when the next line begins with anything else (an upper-case letter,
 * i.e. a broken proper noun: "Craty-" / "lus"), or when the word before the
 * break is one of a short list of compounds that genuinely carry a hyphen
 * (`COMPOUND`). Joining is the safer default and it is what this reader does:
 * a false join ("self-knowledge" → "selfknowledge") is rarer, and less
 * damaging to read, than a false break in every other line of a 400-page scan.
 *
 * TEXT IS NEVER DROPPED. A block that is not confidently a heading is a
 * paragraph, and the reader reports its counts (`stats`) so a page can state
 * them: a text with zero detected headings still gets a page.
 */

/** Blank line(s) separate blocks. A line of spaces counts as blank. */
const BLOCK_SEP = /\n[ \t]*\n+/;

/** A heading's own shape. Kept tight on purpose: a false heading splits a
 * paragraph in two in the table of contents; a missed one leaves an all-caps
 * line inside the prose, which is what the scan looks like anyway. */
const HEADING_KEYWORD = /^(CHAPTER|BOOK|SECTION|TRACTATE|ENNEAD|PROPOSITION|HYMN|PART|CAPUT|LIBER|TRACTATUS)\b/i;
const ROMAN = /^[IVXLCDM]{1,4}\.?$/;
const ARABIC = /^\d{1,3}[.)]?$/;
const MAX_HEADING_CHARS = 64;
const MAX_HEADING_WORDS = 12;
// An all-caps heading must be a WORD, not the scan's debris: "IO" and "S" are
// single glyphs or numerals with letters OCR'd into them, and both would
// otherwise stand as headings in every one of these volumes.
const MIN_CAPS_CHARS = 4;
const MIN_LETTER_RATIO = 0.5;

/** Compound prefixes kept as a real hyphen when the break falls after them.
 * Deliberately short: every entry added is a chance to keep a hyphen that was
 * really a line break ("re-" in "re-moved"), so only the compounds that occur
 * hyphenated in these editions are here. */
const COMPOUND = new Set(['self', 'half', 'non', 'semi', 'well', 'all', 'ever', 'cross', 'quasi', 'two']);

const HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s) => s.replace(/[&<>]/g, (c) => HTML[c]);

/** Is this whole block a heading?
 *
 * A block is a heading only if it is SHORT (≤ 2 lines, ≤ 64 characters, ≤ 12
 * words) and one of: it opens with a division keyword; it is a bare roman or
 * arabic numeral; or it is ALL CAPS and word-like (≥ 4 characters, ≥ half of
 * them letters). A longer block is never scanned for an inner heading — a
 * paragraph that happens to open with a capitalised line stays one paragraph,
 * because splitting it would put half a sentence in the contents. */
function isHeading(lines) {
  if (lines.length === 0 || lines.length > 2) return null;
  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > MAX_HEADING_CHARS) return null;
  if (text.split(/\s+/).length > MAX_HEADING_WORDS) return null;
  const kw = HEADING_KEYWORD.exec(text);
  if (kw) return { level: 2, text };
  if (/\d/.test(text) && /[A-Za-z]{3}/.test(text)) return null; // a numeral inside a real phrase is not a numeral heading
  if (ROMAN.test(text) || ARABIC.test(text)) return { level: 3, text };
  // ALL CAPS: at least one letter, no lower-case letter.
  if (!/[A-Z]/.test(text) || /[a-z]/.test(text)) return null;
  const letters = (text.match(/[A-Z]/g) || []).length;
  if (text.length < MIN_CAPS_CHARS || letters / text.length < MIN_LETTER_RATIO) return null;
  return { level: 2, text };
}

/** A URL-safe id from a heading's text. Latin script only, so a Greek or
 * Fraktur heading (the Migne volumes) yields nothing and falls back to its
 * position — an id is required, and a stable positional one is not a claim
 * about the text. */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Join a block's lines into one paragraph: collapse spaces, de-hyphenate. */
export function joinLines(lines) {
  let out = '';
  for (const raw of lines) {
    const ln = raw.replace(/\s+/g, ' ').trim();
    if (ln === '') continue;
    if (out === '') {
      out = ln;
      continue;
    }
    // THE LINE-END HYPHEN comes in two glyphs in these scans: `-` (the Porphyry
    // volume) and `¬` (the 1816 Proclus, MEASURED — 166 occurrences, every one at
    // a line's end and none mid-line). Both mean "the printer broke the word here",
    // so both take the same de-hyphenation: a compound keeps its hyphen, a broken
    // word is rejoined. Without this the Proclus reading view showed `partici¬
    // pation` — the scan's hyphen standing in the prose.
    if ((out.endsWith('-') || out.endsWith('\u00ac')) && !out.endsWith('--')) {
      const stem = out.slice(0, -1);
      const head = ln[0];
      const lastWord = stem.slice(stem.lastIndexOf(' ') + 1).toLowerCase();
      // a real hyphen: compounds, and a broken capitalised word
      if (COMPOUND.has(lastWord) || !/[a-z0-9]/.test(head)) out = stem + '-' + ln;
      else out = stem + ln; // a printer's line break
    } else {
      out = out + ' ' + ln;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Preprocess one text.
 *
 * Returns `{ blocks, stats }`. A block is `{ type: 'heading', level, text, id }`
 * or `{ type: 'para', text }`. `stats` carries the counts the page states:
 * `parasIn` (paragraph blocks read), `parasOut` (paragraphs written) and
 * `headings` — they are equal by construction unless a block was empty, and the
 * reader asserts that they are (see `assertShape`).
 */
export function preprocess(src, { maxParagraphs = 0 } = {}) {
  const text = src.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const raws = text.split(BLOCK_SEP);
  const blocks = [];
  const ids = new Map();
  let parasIn = 0;
  for (const raw of raws) {
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (lines.length === 0) continue;
    const head = isHeading(lines);
    if (head) {
      let id = slugify(head.text) || `h${blocks.length + 1}`;
      const n = (ids.get(id) || 0) + 1;
      ids.set(id, n);
      if (n > 1) id = `${id}-${n}`;
      blocks.push({ type: 'heading', level: head.level, text: head.text, id });
      continue;
    }
    parasIn++;
    blocks.push({ type: 'para', text: joinLines(lines) });
  }
  const doc = {
    blocks,
    stats: {
      parasIn,
      parasOut: blocks.filter((b) => b.type === 'para').length,
      headings: blocks.filter((b) => b.type === 'heading').length,
      chars: text.length,
    },
  };
  assertShape(doc);
  return doc;
}

/** What the reader promises about its own output. Throws rather than shipping a
 * page with an empty paragraph, a lost paragraph, or a blank-line run that the
 * HTML would render as a gap. */
export function assertShape(doc, what = 'text') {
  const { parasIn, parasOut } = doc.stats;
  if (parasIn !== parasOut) throw new Error(`reader: ${what}: ${parasIn} paragraphs in, ${parasOut} out`);
  if (parasOut === 0) throw new Error(`reader: ${what}: no paragraphs — is this the right file?`);
  for (const b of doc.blocks) {
    const t = b.type === 'para' ? b.text : b.text;
    if (t.replace(/\s+/g, '') === '') throw new Error(`reader: ${what}: an empty ${b.type} block`);
  }
  const html = renderBlocks(doc.blocks);
  if (/\n{3,}/.test(html)) throw new Error(`reader: ${what}: the emitted text has a run of 3+ newlines`);
}

/** Render blocks as prose: headings as <h2>/<h3> with ids, paragraphs as <p>. */
export function renderBlocks(blocks) {
  return blocks
    .map((b) => {
      if (b.type === 'heading') return `<h${b.level} id="${b.id}">${esc(b.text)}</h${b.level}>`;
      return `<p>${esc(b.text)}</p>`;
    })
    .join('\n');
}

/** How many paragraphs a rendered block list contributes. The smoke test
 * counts the same thing in the built page. */
export const countParagraphs = (blocks) => blocks.filter((b) => b.type === 'para').length;

/**
 * What the transcription's alphabet says about it.
 *
 * MEASURED, never assumed, and measured on the object it describes. Two defects
 * leave a signature in the LETTERS, and neither can be fixed by paragraph
 * joining:
 *
 *  - a SUBSTITUTED alphabet — an English or Latin volume whose transcription
 *    came out as Greek-range letters, so it reads as noise. The signature is
 *    only a defect against the language the entry declares: a Greek edition is
 *    legitimately Greek (Cousin's Proclus is 79% Greek-range and perfectly
 *    readable), so the test is a CONTRADICTION between measurement and declared
 *    language, not the presence of an alphabet.
 *  - a FLATTENED alphabet — a Greek edition whose transcription carries no
 *    Greek letters at all, because they came out as accented Latin lookalikes.
 *    The volume is still legible where its Latin runs, so it is served, with the
 *    defect stated.
 *
 * A text with no letters at all (neither) is not judged here.
 */
export function assess(src, lang) {
  const greek = (src.match(/[\u0370-\u03ff\u1f00-\u1fff]/g) || []).length;
  const latin = (src.match(/[A-Za-z]/g) || []).length;
  const share = greek + latin === 0 ? 0 : greek / (greek + latin);
  const substituted = lang !== 'grc' && share > 0.5;
  const flattened = lang === 'grc' && greek === 0 && latin > 0;
  return {
    greekLetters: greek,
    latinLetters: latin,
    greekShare: share,
    substituted,
    flattened,
    readable: !substituted,
  };
}

/**
 * Partition a text into pages when it is too big to be one.
 *
 * Boundaries are the text's OWN top-level divisions (the level-2 headings —
 * books, treatises, chapters, propositions) so a page break is a break the
 * edition itself makes; a division too large for one page is filled to the size
 * cap at paragraph boundaries, because a page that cannot be one page must
 * still be readable. A text with fewer than two top-level divisions has no
 * division structure to follow and is filled to the cap.
 *
 * Returns `[{ title, blocks }]` — one entry when the text fits.
 */
export function partition(doc, maxBytes) {
  const size = (blocks) => renderBlocks(blocks).length;
  if (size(doc.blocks) <= maxBytes) return [{ title: '', blocks: doc.blocks }];

  const dividers = doc.blocks
    .map((b, i) => (b.type === 'heading' && b.level === 2 ? i : -1))
    .filter((i) => i >= 0);
  if (dividers.length < 2) return fill(doc.blocks, maxBytes);

  const sections = [];
  for (let d = 0; d < dividers.length; d++) {
    const from = dividers[d];
    const to = d + 1 < dividers.length ? dividers[d + 1] : doc.blocks.length;
    sections.push({ title: doc.blocks[from].text, blocks: doc.blocks.slice(from, to) });
  }
  if (dividers[0] > 0) sections.unshift({ title: '', blocks: doc.blocks.slice(0, dividers[0]) });

  const parts = [];
  let current = null;
  let len = 0;
  for (const s of sections) {
    // each section is rendered once: a 4 MB volume has thousands of them, and
    // measuring a growing accumulator per section would render each of them
    // thousands of times
    const sLen = size(s.blocks);
    if (sLen > maxBytes) {
      if (current) parts.push(current);
      current = null;
      len = 0;
      for (const piece of fill(s.blocks, maxBytes, s.title)) parts.push(piece);
      continue;
    }
    if (current && len + sLen > maxBytes) {
      parts.push(current);
      current = null;
      len = 0;
    }
    if (!current) current = { title: s.title, blocks: [] };
    if (!current.title) current.title = s.title;
    current.blocks.push(...s.blocks);
    len += sLen;
  }
  if (current) parts.push(current);
  return parts;
}

/* ---------- the document's text primitives ----------
 *
 * `tools/library/extract.mjs` builds the SERVED document (the plan's §4) out of
 * the same transcription this reader renders. The document needs the same
 * answers to two questions — what is a line, and what is a printed number — so
 * they are answered here, once, where the reader can see them: a second answer
 * would let the page and the document disagree about the text they share.
 */

/** One source line as the document holds it: trimmed, and the transcription's
 * runs of spaces (it writes TWO between words) collapsed to one. */
export function collapseLine(line) {
  return line.replace(/\s+/g, ' ').trim();
}

/** The source split into blocks on blank lines, each block an array of
 * `collapseLine`d lines — the same boundary `preprocess` uses, kept as lines
 * because page furniture (a running head, a bare folio) is a LINE and has to be
 * taken out of a block before the block's prose is joined. */
export function rawBlocks(src) {
  const text = src.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  return text
    .split(BLOCK_SEP)
    .map((b) => b.split('\n').map(collapseLine).filter((l) => l !== ''))
    .filter((ls) => ls.length > 0);
}

/** The transcription's digit confusions, MEASURED on these volumes and named by
 * the plan: `io`→10, `II`→11, `i`/`l`→1, `o`→0, `S`→5. A character table that
 * yields exactly that set — "io" reads "10", "II" reads "11" — rather than five
 * special cases, so a sixth confusion is one line, not one branch. */
const CONFUSION = new Map([
  ['i', '1'], ['I', '1'], ['l', '1'], ['L', '1'],
  ['o', '0'], ['O', '0'],
  ['s', '5'], ['S', '5'],
]);

/** Read a token as a printed number, or null when it is not one.
 *
 * `plain` says the token was ALREADY all digits: a plain token is a reading of
 * the print, a confused one ("io", "II") is an INTERPRETATION of it, and only
 * the second needs the arithmetic around it to be checked before it is
 * believed (see `extract.mjs`, the ±1 stride rule). */
export function normaliseNumber(token) {
  if (!token) return null;
  if (/^\d+$/.test(token)) return { value: Number(token), plain: true };
  let out = '';
  for (const c of token) {
    if (c >= '0' && c <= '9') out += c;
    else if (CONFUSION.has(c)) out += CONFUSION.get(c);
    else return null;
  }
  return out === '' ? null : { value: Number(out), plain: false };
}

/** The correction rules as a text transform (§4.1: `{find, repl, cls, note}`).
 * Literal, left to right, every occurrence — the rules are a list the reader can
 * read, not a regex language, so what the diff view shows is what runs. */
export function applyCorrections(text, corrections) {
  let out = text;
  for (const c of corrections) {
    if (!c || !c.find || c.find === c.repl) continue;
    if (out.includes(c.find)) out = out.split(c.find).join(c.repl);
  }
  return out;
}

/** Page furniture that is not a word: the printer's ornament, the scan's debris
 * ("- • 7 *^", "T**5", "--", "__", a lone "q"). Short, and carrying no word of
 * two or more letters. It is kept in the document as an `rh` block and claims no
 * page: a mark with no readable number is not a page number. */
export function isFurnitureJunk(line) {
  if (line.length > 12 || /[A-Za-z]{2}/.test(line)) return false;
  // a line of nothing but digits is not debris: it is either a folio (taken by
  // `bareFolio` before this) or the edition's own text — the imprint's year on a
  // title page, a catalogue's year on a library card. Suppressing those would
  // suppress the print.
  return /[^0-9\s]/.test(line);
}

/** A running head, and the number it carries.
 *
 * The shape is the one the 1917 Porphyry is MEASURED to have: the head's own
 * words with the printed page number inline — verso "6 ON THE CAVE OF THE
 * NYMPHS", recto "ON THE CAVE OF THE NYMPHS 7". `OH` is accepted for `ON`
 * because page 48 of that volume transcribed it so. Returns `{num, side}` —
 * `num` is the raw token, which the caller reads with `normaliseNumber`. */
export function runningHead(line, words = 'ON THE CAVE OF THE NYMPHS') {
  const phrase = words.split(' ');
  const toks = line.split(' ');
  if (toks.length !== phrase.length + 1) return null;
  const phraseAt = (i) =>
    phrase.every((w, k) => {
      const t = toks[i + k];
      // the one measured OCR variant inside the head's words
      return t === w || (k === 0 && w === 'ON' && t === 'OH');
    });
  if (phraseAt(0)) return { num: toks[toks.length - 1], side: 'right' };
  if (phraseAt(1)) return { num: toks[0], side: 'left' };
  return null;
}

/** A bare folio: a line that is nothing but a printed page number, the head's
 * own words lost. At most three characters — `ARABIC` above draws the same
 * bound on a numeral, and a four-digit line at a page head is the imprint's
 * year ("1917" on the title page) rather than a page. */
export function bareFolio(line) {
  if (line.length > 3) return null;
  return normaliseNumber(line);
}

/** Fill blocks into pages of at most `maxBytes` at PARAGRAPH boundaries — never
 * mid-paragraph, and never by dropping a block. */
function fill(blocks, maxBytes, title = '') {
  const parts = [];
  let current = [];
  let len = 0;
  for (const b of blocks) {
    const add = renderBlocks([b]).length + 1;
    if (len + add > maxBytes && current.length) {
      parts.push({ title, blocks: current });
      current = [];
      len = 0;
    }
    current.push(b);
    len += add;
  }
  if (current.length) parts.push({ title, blocks: current });
  return parts;
}
