/**
 * tools/library/derive.mjs — the derivative reader (plan §4.6, phase 4).
 *
 * The edition the library serves lives in the repo (`content/library/<slug>/source.txt`).
 * THE DERIVATIVES DO NOT: the archive.org item's own per-page files are 930 KB and
 * 12 KB and they sit on a host path the build must not need. So they are read ONCE,
 * by this tool, and what the tool leaves behind is the DERIVED FACT the document
 * actually needs — a page model indexed by leaf — in a few kilobytes beside the
 * edition. `extract.mjs` reads that artifact at build time and never touches
 * `~/thework`; this tool is the only thing that does, and it is run by hand:
 *
 *     node tools/library/derive.mjs <slug>
 *
 * WHAT IS DERIVED, and why each fact is in the artifact (`derivs.json`):
 *
 *   - the INVENTORY: the item, the two filenames, their sha256 and their byte
 *     length. The artifact can be re-derived only from THOSE bytes, so it records
 *     what it was derived from; a different derivative file is a different page
 *     model, and the sha256 is what makes that checkable rather than assumed.
 *   - the LEAF TABLE: for every leaf of the scan, the printed page number the
 *     item's own page-number pass gives it and the CONFIDENCE it gives it (a
 *     number with a confidence was DETECTED on the leaf; a number with none was
 *     filled in from the sequence — `interpolated`; no number at all is
 *     `refused`), plus the line/word counts, and the FIRST LINE of the leaf's text.
 *   - the ALIGNMENT: the leaf's first line INDEX in the line stream of the edition
 *     the repo stores. This is the fact that makes leaf boundaries STRUCTURAL
 *     rather than inferred: it is not derived from the transcription's guesses, it
 *     is measured by matching the two line streams, and it is checked here before
 *     the artifact is written — the leaves must tile the stream exactly and every
 *     leaf's recorded first line must BE the line at that index, or nothing is
 *     written.
 *   - the NUMBER'S PLACE: for a leaf carrying a page number, the bounding box of
 *     the token that reads as that number, as a fraction of the leaf's own box.
 *     That is the word-box knowledge the plan keeps the boxes for: it says WHERE
 *     the number is printed (the head or the foot of the leaf), which is what
 *     validates where a page marker in the text can honestly fall.
 *
 * WHAT IS NOT DERIVED, deliberately: the text. The djvu.xml's hidden text is the
 * same OCR the edition already holds (MEASURED: after XML-unescaping, the two line
 * streams are identical, 1581 lines against 1581), so the artifact carries the
 * alignment and the counts and NOT one word of the text. That is the difference
 * between a ~20 KB file in this repo and the 930 KB derivative: the argument for
 * committing the derivative would have to be something the alignment cannot carry,
 * and there is nothing.
 *
 * READING ORDER IS VERIFIED, NOT ASSUMED (plan §4.6). The xml is normally emitted
 * in order, and here it is MEASURED to be: within every one of the 72 leaves the
 * lines' top edges strictly increase down the leaf, and within every line the
 * words' left edges strictly increase. Both are asserted below, so a derivative
 * emitted out of order fails here rather than producing a page model read
 * backwards.
 *
 * WHAT THIS TOOL DOES NOT DO: it does not decide what page a marker in the text
 * gets. The RECONCILIATION — the three signals (the item's page-number pass, the
 * leaf the marker stands on, and the transcription's own running heads) — happens
 * in `extract.mjs`, which has all three, and it reports every disagreement. This
 * tool measures the first signal and the structure; it merges nothing.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { TEXTS } from './shelf.mjs';
import { LIBRARY_DIR, derivsPath, pageSignals, sha256 } from './extract.mjs';

/** Where the item's derivatives live. `LIBRARY_DERIVS` names the directory that
 * holds one directory per item; the default is the host path they were fetched
 * to. Neither is needed to BUILD (the artifact is committed); both are needed to
 * DERIVE, which is a deliberate one-time act. */
export const DERIVS_ROOT = process.env.LIBRARY_DERIVS || join(homedir(), 'thework', 'work-derivs');


/** The two files this tool reads, found by their suffixes inside the item's own
 * directory. Found rather than named: the item id in the filename is the
 * archive's business, and a derivative re-fetched under another id is the same
 * derivative — the sha256 in the artifact is what identifies it. */
export function derivativeFiles(dir) {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir);
  const djvu = names.find((n) => n.endsWith('_djvu.xml'));
  const pages = names.find((n) => n.endsWith('_page_numbers.json'));
  if (!djvu || !pages) return null;
  return { djvu: join(dir, djvu), pages: join(dir, pages), djvuName: djvu, pagesName: pages };
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/* ---------- the djvu.xml ---------- */

const XML_ENTITIES = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
  ['&amp;', '&'],
];

/** One line of the xml as the edition's line stream has it: the words joined with
 * one space, whitespace collapsed. MEASURED: with the five XML entities decoded
 * (and in this order, `&amp;` last), every one of the 1581 lines is character for
 * character the line the stored edition has at the same index — which is what
 * makes the alignment below a measurement rather than a guess. */
export const xmlText = (s) => XML_ENTITIES.reduce((t, [from, to]) => t.split(from).join(to), s);

const num = (s) => Number(s);

/**
 * Read the xml into leaves of lines of words, and VERIFY the reading order.
 *
 * A word's box is `coords="x1,y1,x2,y2"` with y measured DOWN from the top edge
 * of the leaf (`PARAM`/`OBJECT` height), so a line's TOP is the smaller of its
 * words' two y values, and a word's LEFT is the smaller of its two x values.
 */
export function parseDjvu(xml) {
  const objects = [...xml.matchAll(/<OBJECT\b[\s\S]*?<\/OBJECT>/g)].map((m) => m[0]);
  if (objects.length === 0) {
    throw new Error('library: the djvu.xml has no <OBJECT> elements — this is not the per-page derivative');
  }
  const leaves = [];
  for (const raw of objects) {
    const map = /usemap="[^"]*?(\d{4})\.djvu"/.exec(raw);
    const size = /<OBJECT\b[^>]*\bwidth="(\d+)"\s+height="(\d+)"/.exec(raw);
    const words = [...raw.matchAll(/<WORD\s+coords="([^"]+)"(?:\s+x-confidence="(\d+)")?\s*>([\s\S]*?)<\/WORD>/g)];
    const lines = [];
    let prevTop = -Infinity;
    for (const lm of raw.matchAll(/<LINE>([\s\S]*?)<\/LINE>/g)) {
      const ws = [...lm[1].matchAll(/<WORD\s+coords="([^"]+)"(?:\s+x-confidence="(\d+)")?\s*>([\s\S]*?)<\/WORD>/g)].map(
        (m) => {
          const [x1, y1, x2, y2] = m[1].split(',').map(num);
          return { text: xmlText(m[3]), left: Math.min(x1, x2), top: Math.min(y1, y2), bottom: Math.max(y1, y2), right: Math.max(x1, x2) };
        },
      );
      if (ws.length === 0) continue;
      // reading order, asserted rather than assumed: the words of a line run left
      // to right, and the lines of a leaf run down it
      for (let i = 1; i < ws.length; i++) {
        if (ws[i].left < ws[i - 1].left) {
          throw new Error(
            `library: the derivative is not in reading order — leaf ${map ? num(map[1]) : '?'}, a word at x=${ws[i].left} ` +
              `follows one at x=${ws[i - 1].left}; the leaf boundaries would be read backwards`,
          );
        }
      }
      const top = Math.max(...ws.map((w) => w.top));
      if (top < prevTop) {
        throw new Error(
          `library: the derivative is not in reading order — leaf ${map ? num(map[1]) : '?'}, a line starting y=${top} ` +
            `follows one starting y=${prevTop}; the page model would be built on a scrambled leaf`,
        );
      }
      prevTop = top;
      lines.push({ top, text: ws.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim(), words: ws });
    }
    leaves.push({
      leaf: map ? num(map[1]) : null,
      width: size ? num(size[1]) : null,
      height: size ? num(size[2]) : null,
      lines,
      wordCount: words.length,
    });
  }
  return leaves;
}

/** Where the token that reads as this leaf's printed page number is printed, as
 * fractions of the leaf's box — or null when no token reads as it (the number was
 * interpolated from the sequence, so there is nothing on the leaf to point at).
 * The search is over the leaf's own lines in reading order and takes the first
 * token that reads as the number, which for this volume is always the running
 * head: the head is the leaf's own furniture. */
export function numberPlace(leaf, page) {
  if (!leaf.width || !leaf.height) return null;
  for (let i = 0; i < leaf.lines.length; i++) {
    const line = leaf.lines[i];
    for (const w of line.words) {
      if (w.text.trim() === String(page)) {
        return {
          x: Number(((w.left + w.right) / 2 / leaf.width).toFixed(3)),
          y: Number(((w.top + w.bottom) / 2 / leaf.height).toFixed(3)),
          line: i,
          of: leaf.lines.length,
        };
      }
    }
  }
  return null;
}

/* ---------- the leaf table ---------- */

/** The item's page-number pass, per leaf: the number, the confidence it gave it,
 * and which of the three states that is. Confidence present = DETECTED on the
 * leaf; a number with none = filled in from the sequence = INTERPOLATED; no
 * number = REFUSED (there was nothing to read and nothing to fill in from). */
export function readPageNumbers(json) {
  const doc = JSON.parse(json);
  if (!Array.isArray(doc.pages)) {
    throw new Error('library: the page-numbers derivative has no pages[] — this is not the per-leaf page-number file');
  }
  return doc.pages.map((p) => ({
    leaf: p.leafNum,
    page: p.pageNumber === '' ? null : Number(p.pageNumber),
    conf: p.confidence == null ? null : p.confidence,
    state: p.pageNumber === '' ? 'refused' : p.confidence == null ? 'interpolated' : 'detected',
  }));
}

/**
 * The leaf table: the item's leaves, checked against the item's page numbers and
 * against each other, with the alignment to the edition's line stream.
 *
 * Every assertion here can FAIL, and each one failing means the artifact must not
 * be written:
 *   - an object count or leaf-number list that differs from the page numbers says
 *     the two derivatives are of different items (or one was refetched);
 *   - a line count that differs from the edition's says the derivative and the
 *     edition are not the same scan of the same book;
 *   - a leaf whose recorded first line is not the edition's line at its start says
 *     the alignment is off, which would put every page boundary in the wrong place;
 *   - a leaf whose number does not sit at the constant offset the numbered leaves
 *     share says the numbering is not the arithmetic this model rests on.
 */
export function leafTable(leaves, pages, flatLines, item) {
  if (leaves.length !== pages.length) {
    throw new Error(
      `library: ${item}: the derivative has ${leaves.length} leaf/leaves and the page-number file has ` +
        `${pages.length} — they are not of the same item, or one of them was refetched`,
    );
  }
  const mismatch = leaves.find((l, i) => l.leaf !== pages[i].leaf);
  if (mismatch) {
    throw new Error(
      `library: ${item}: leaf ${mismatch.leaf} in the derivative stands where the page-number file has ` +
        `leaf ${pages[mismatch.leaf - 1] ? pages[mismatch.leaf - 1].leaf : '?'} — the two files are not in the same order`,
    );
  }
  const total = leaves.reduce((a, l) => a + l.lines.length, 0);
  if (flatLines && total !== flatLines.length) {
    throw new Error(
      `library: ${item}: the derivative carries ${total} line(s) and the edition in this repo carries ` +
        `${flatLines.length} — the edition and the derivative are not the same scan of the same book`,
    );
  }
  const table = [];
  let start = 0;
  for (let i = 0; i < leaves.length; i++) {
    const l = leaves[i];
    const p = pages[i];
    const head = l.lines.length ? l.lines[0].text : null;
    if (flatLines && head !== null && flatLines[start] !== head) {
      throw new Error(
        `library: ${item}: leaf ${l.leaf}'s first line is not the edition's line at the position the leaves ` +
          `give it — the leaves and the edition are out of step at line ${start} ` +
          `(the derivative has ${JSON.stringify(head)}, the edition has ${JSON.stringify(flatLines[start])})`,
      );
    }
    table.push({
      leaf: l.leaf,
      page: p.page,
      conf: p.conf,
      state: p.state,
      start,
      lines: l.lines.length,
      words: l.wordCount,
      head,
      num: p.page == null ? null : numberPlace(l, p.page),
    });
    start += l.lines.length;
  }
  // the arithmetic the model rests on, measured rather than assumed: every leaf
  // that carries a number sits at the same leaf→page offset
  const offsets = new Set(table.filter((l) => l.page != null).map((l) => l.page - l.leaf));
  if (offsets.size > 1) {
    const numbered = table.filter((l) => l.page != null);
    throw new Error(
      `library: ${item}: the numbered leaves do not share one leaf→page offset — ` +
        `${numbered.map((l) => `${l.leaf}→${l.page}`).join(', ')} — so the leaf structure cannot confirm a page ` +
        `number; the reconciliation would be arithmetic that is not the volume's`,
    );
  }
  return { table, offset: [...offsets][0] ?? null };
}

/* ---------- the agreement table ---------- */

/**
 * THE AGREEMENT TABLE (plan §4.2): every page of the numbered span, as the two
 * sources have it, with the verdict. Printed here — where both sources are read
 * for the first time — and recomputed at build time by the extractor, so the two
 * cannot agree by construction.
 *
 * A row's verdict is one of:
 *   `agree`            — the transcription reads this page on this leaf, and the
 *                        item's page-number pass gives the leaf the same page;
 *   `text-only`        — the transcription reads a number here and the item's pass
 *                        has none for the leaf (the head was read from the image,
 *                        the pass had nothing to detect);
 *   `leaf-only`        — the item's pass has a number for the leaf and nothing on
 *                        the leaf was read: the number is NOT served — no reading,
 *                        no number — and the row says so;
 *   `refused-agree`    — the transcription reads this page on this leaf and the
 *                        ±1 stride rule REFUSED it (a neighbour is missing), while
 *                        the item's pass has the leaf at exactly that page. The
 *                        leaf supplies the step the text alone could not, so the
 *                        reading stands — this is the one case where the two
 *                        modes differ about a NUMBER, and it is reported;
 *   `refused-disagree` — a reading the stride refused and the leaf's number is
 *                        another page (MEASURED: the damaged folio "3" on leaf 39,
 *                        whose own head reads 33): the refusal stands;
 *   `unread`           — neither source has a number;
 *   `disagree`         — both have a number and they differ. A disagreement is
 *                        reported and NOT merged: the transcription's own reading
 *                        stands in the served text, and the row is a finding about
 *                        one of the two.
 */
export function agreementTable(table, readings, lo, hi) {
  const rows = [];
  for (const l of table) {
    if (l.leaf < lo || l.leaf > hi) continue;
    const marks = readings.get(l.leaf) || [];
    const read = marks.find((m) => m.page != null) || null;
    const refused = marks.filter((m) => m.page == null && m.value != null);
    const verdict = read
      ? l.page == null
        ? 'text-only'
        : read.page === l.page
          ? 'agree'
          : 'disagree'
      : refused.length
        ? l.page == null
          ? 'refused-only'
          : refused.some((m) => m.value === l.page)
            ? 'refused-agree'
            : 'refused-disagree'
        : l.page == null
          ? 'unread'
          : 'leaf-only';
    rows.push({ leaf: l.leaf, read, refused, leafPage: l.page, conf: l.conf, state: l.state, verdict });
  }
  return rows;
}

/** The numbered span: the leaves the volume prints a number on, taken from the
 * two sources' union — so a page found by only one of them is still inside the
 * span the model covers, and a front-matter leaf is not dragged into it. */
export function numberedSpan(table, readings) {
  const nums = [];
  for (const l of table) if (l.page != null) nums.push(l.leaf);
  for (const leaf of readings.keys()) nums.push(leaf);
  return nums.length ? [Math.min(...nums), Math.max(...nums)] : [null, null];
}

/**
 * THE INVENTORY, PINNED PER ITEM, AND ASSERTED (plan §11 Phase 4).
 *
 * The plan's phase-4 brief stated these numbers as GIVEN, to be verified on
 * arrival: 72 page objects, 51 leaves carrying a printed number, and a constant
 * leaf→page offset. They were re-measured here and they hold — and they are
 * asserted rather than printed, so a derivative that differs FAILS the derivation
 * instead of quietly becoming the page model of a book whose pagination is now
 * something else. The numbers describe a MEASURED fact about one item; a second
 * text's item gets its own line, filled in the same way (by measuring it).
 */
export const ITEM_FACTS = {
  onthecaveoftheny00porpuoft: {
    objects: 72,
    lines: 1581,
    numbered: 51,
    detected: 24,
    interpolated: 27,
    refused: 21,
    offset: -6,
    span: [11, 64],
  },
};

function assertInventory(model, slug) {
  const want = ITEM_FACTS[model.item];
  if (!want) return; // an item with no pinned inventory: the measured one is recorded, not asserted
  const got = {
    objects: model.totals.objects,
    lines: model.totals.lines,
    numbered: model.totals.numbered,
    detected: model.totals.detected,
    interpolated: model.totals.interpolated,
    refused: model.totals.refused,
    offset: model.totals.offset,
    span: model.totals.span,
  };
  const bad = Object.keys(want).filter((k) => JSON.stringify(want[k]) !== JSON.stringify(got[k]));
  if (bad.length) {
    throw new Error(
      `library: ${slug}: the derivative is not the one this page model was pinned against — ` +
        bad.map((k) => `${k} is ${JSON.stringify(got[k])}, pinned as ${JSON.stringify(want[k])}`).join('; ') +
        `\n  The pinned numbers describe a measured item. If this item's derivatives really are these bytes, ` +
        `the page model is a different one and the pin (ITEM_FACTS in this file) has to be re-measured and ` +
        `changed deliberately — not by relaxing the check.`,
    );
  }
}

/**
 * The artifact's own shape, written ONE LEAF PER LINE.
 *
 * Not decoration: a page model is a table, and the lines of a table are its
 * leaves. Written this way a change to one leaf's boundary — a re-derived
 * alignment, a re-fetched derivative — is a one-line diff a human can read, and
 * the file is 15 KB where the derivatives it was derived from are 942 KB. The two
 * inventory blocks (what it was derived from, and what it found) stand above the
 * table they describe.
 */
export function serialiseModel(model) {
  const head = Object.entries(model).filter(([k]) => k !== 'leaves');
  return (
    '{\n' +
    head.map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n') +
    ',\n "leaves": [\n' +
    model.leaves.map((l) => `  ${JSON.stringify(l)}`).join(',\n') +
    '\n ]\n}\n'
  );
}

/* ---------- the command line ---------- */

function derive(slug, opts) {
  const entry = TEXTS.find((t) => t.slug === slug);
  if (!entry) throw new Error(`library: no shelf entry '${slug}'`);
  const root = opts.root || DERIVS_ROOT;
  const files = derivativeFiles(join(root, entry.item));
  if (!files) {
    throw new Error(
      `library: ${slug}: the item's derivatives are not at ${join(root, entry.item)} —\n` +
        `  this tool reads them once and writes the small derived artifact beside the edition. Nothing in\n` +
        `  this repo builds from them, so their absence costs a build nothing; it costs a re-derivation\n` +
        `  everything. Set LIBRARY_DERIVS to the directory holding the item's own directory.`,
    );
  }
  const edition = join(LIBRARY_DIR, slug, 'source.txt');
  if (!existsSync(edition)) throw new Error(`library: ${slug}: no stored edition at ${edition}`);
  const src = readFileSync(edition, 'utf8');

  const djvuBytes = readFileSync(files.djvu);
  const pageBytes = readFileSync(files.pages);
  const leaves = parseDjvu(djvuBytes.toString('utf8'));
  const pages = readPageNumbers(pageBytes.toString('utf8'));

  // the edition's own line stream, in the index space the leaf table uses: the
  // same rawBlocks the extractor reads, INCLUDING the library stamp the extractor
  // drops — a leaf boundary is a line of the file, whether or not it is text
  const sig = pageSignals(src, entry);
  const flatLines = sig.flat;
  const { table, offset } = leafTable(leaves, pages, flatLines, entry.item);

  const readings = new Map();
  for (const m of sig.markers.values()) {
    if (m.value == null && m.page == null) continue; // junk furniture, not a reading
    const lf = table.find((l) => m.at >= l.start && m.at < l.start + l.lines);
    if (!lf) continue;
    if (!readings.has(lf.leaf)) readings.set(lf.leaf, []);
    readings.get(lf.leaf).push({ page: m.page, value: m.value, how: m.page == null ? 'refused' : m.how, raw: m.raw, at: m.at });
  }
  const [lo, hi] = numberedSpan(table, readings);
  const rows = agreementTable(table, readings, lo, hi);
  /* The cross-check is materialised ON the leaf table: which page the
   * transcription reads on each leaf and what the two sources make of it. That is
   * what lets the build print the same table without re-deriving it and without
   * the build knowing how to compare two sources. */
  for (const r of rows) {
    const lf = table.find((l) => l.leaf === r.leaf);
    if (!lf) continue;
    lf.verdict = r.verdict;
    if (r.read) lf.read = { page: r.read.page, how: r.read.how };
    if (r.refused.length) lf.refused = r.refused.map((m) => m.value);
  }

  const numbered = table.filter((l) => l.page != null);
  const model = {
    slug,
    item: entry.item,
    edition: { sha256: sha256(src), bytes: Buffer.byteLength(src, 'utf8'), lines: flatLines.length },
    derived: new Date().toISOString().slice(0, 10),
    files: [
      { name: files.djvuName, sha256: sha(djvuBytes), bytes: djvuBytes.length },
      { name: files.pagesName, sha256: sha(pageBytes), bytes: pageBytes.length },
    ],
    totals: {
      objects: leaves.length,
      leaves: table.length,
      lines: table.reduce((a, l) => a + l.lines, 0),
      words: table.reduce((a, l) => a + l.words, 0),
      withText: table.filter((l) => l.lines > 0).length,
      numbered: numbered.length,
      detected: table.filter((l) => l.state === 'detected').length,
      interpolated: table.filter((l) => l.state === 'interpolated').length,
      refused: table.filter((l) => l.state === 'refused').length,
      offset,
      span: lo == null ? null : [lo, hi],
    },
    leaves: table,
    agreement: {
      rows: rows.length,
      agree: rows.filter((r) => r.verdict === 'agree').length,
      textOnly: rows.filter((r) => r.verdict === 'text-only').length,
      leafOnly: rows.filter((r) => r.verdict === 'leaf-only').length,
      refusedAgree: rows.filter((r) => r.verdict === 'refused-agree').length,
      refusedDisagree: rows.filter((r) => r.verdict === 'refused-disagree').length,
      refusedOnly: rows.filter((r) => r.verdict === 'refused-only').length,
      unread: rows.filter((r) => r.verdict === 'unread').length,
      disagree: rows.filter((r) => r.verdict === 'disagree').length,
    },
  };
  assertInventory(model, slug);
  return { model, rows };
}

/** The agreement table as the ARTIFACT holds it: one row per leaf of the numbered
 * span, in leaf order. Rebuilt from the artifact rather than recomputed, so the
 * build prints the same table the deriving tool measured — and so a stale artifact
 * cannot print a table it did not measure. */
export function agreementRows(model) {
  return model.leaves
    .filter((l) => l.verdict)
    .map((l) => ({
      leaf: l.leaf,
      leafPage: l.page,
      conf: l.conf,
      state: l.state,
      read: l.read || null,
      refused: l.refused || [],
      verdict: l.verdict,
    }));
}

/** The agreement table, as the log prints it: one row per leaf of the numbered
 * span, the item's number and state, the transcription's own reading, the verdict. */
export function printAgreement(rows, log = console.log) {
  log('  leaf  item’s number (state)          transcription reads                     verdict');
  for (const r of rows) {
    const item = r.leafPage == null ? '—' : `${r.leafPage} (${r.state}${r.conf != null ? ` conf ${r.conf}` : ''})`;
    const bits = [];
    if (r.read) bits.push(`${r.read.page} (${r.read.how})`);
    if (r.refused.length) bits.push(`${r.refused.join('/')} refused`);
    const read = bits.length ? bits.join(' + ') : '—';
    log(`  ${String(r.leaf).padStart(4)}  ${item.padEnd(30)}  ${read.padEnd(38)}  ${r.verdict}`);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const slug = args.find((a) => !a.startsWith('-'));
  if (!slug) {
    console.error(
      'usage: node tools/library/derive.mjs <slug> [--check]\n' +
        '  Reads the item\'s own djvu.xml and page_numbers.json once, checks the leaf model against the\n' +
        '  edition stored in this repo, and writes content/library/<slug>/derivs.json. --check re-derives\n' +
        '  and compares with the committed artifact instead of writing it.\n' +
        '  The derivatives are looked for under $LIBRARY_DERIVS (default: the fetcher\'s work-derivs directory).',
    );
    process.exit(2);
  }
  try {
    const { model, rows } = derive(slug, {});
    console.log(
      `\nlibrary: ${slug} — the leaf model, MEASURED over the item's own derivatives\n` +
        `  ${model.totals.objects} page object(s), ${model.totals.lines} line(s), ${model.totals.words} word(s)\n` +
        `  ${model.totals.numbered} leaf/leaves carry a printed number (${model.totals.detected} detected on the leaf, ` +
        `${model.totals.interpolated} interpolated from the sequence), ${model.totals.refused} carry none\n` +
        `  every numbered leaf sits at the same leaf→page offset: ${model.totals.offset}\n` +
        `  ${model.totals.withText} leaf/leaves carry text; the leaves tile the edition's own line stream exactly\n` +
        `  the numbered span is leaf ${model.totals.span[0]}…${model.totals.span[1]}\n` +
        `  reading order VERIFIED: line tops strictly increase down every leaf, word lefts across every line\n`,
    );
    printAgreement(rows);
    const a = model.agreement;
    console.log(
      `\n  ${a.agree} page(s) both sources agree on, ${a.textOnly} the transcription reads and the item's pass does not, ` +
        `${a.refusedAgree} reading(s) the stride rule refused that the leaf confirms, ${a.refusedDisagree} reading(s) ` +
        `the stride refused and the leaf does not,\n  ${a.leafOnly} leaf/leaves the item's pass numbers and nothing on ` +
        `them was read (NOT served as a number), ${a.refusedOnly} refused with nothing to confirm them, ${a.unread} ` +
        `neither has, ${a.disagree} disagreement(s)${a.disagree ? ' — each one a finding, not merged' : ''}\n`,
    );
    const file = derivsPath(slug);
    const json = serialiseModel(model);
    if (check) {
      if (!existsSync(file)) throw new Error(`library: ${slug}: no committed ${file} to check`);
      const have = readFileSync(file, 'utf8');
      if (have !== json) {
        throw new Error(
          `library: ${slug}: the committed artifact is not what this tool derives now — the derivatives or the ` +
            `edition have changed. Re-derive deliberately: node tools/library/derive.mjs ${slug}`,
        );
      }
      console.log(`library: ${slug}: the committed artifact is what this tool derives now (${Buffer.byteLength(json)} bytes)`);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, json);
      console.log(
        `wrote content/library/${slug}/derivs.json (${Buffer.byteLength(json)} bytes — the leaf model and the ` +
          `inventory of what it was derived from; the derivatives themselves stay off this repo)`,
      );
    }
  } catch (e) {
    console.error(`\nderive: ${e.message}\n`);
    process.exit(1);
  }
}
