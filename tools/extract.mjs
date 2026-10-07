/**
 * tools/extract.mjs — the library's document extractor (plan §4, phase 1;
 * the leaf-accurate page model, phase 4).
 *
 * A scanned printed edition is a STRUCTURED object: it has printed pages with
 * numbers, divisions with numbers, notes attached to passages, and page
 * furniture. The `_djvu.txt` derivative throws that structure away and the
 * reader that renders it inherits the loss. This module RE-DERIVES the
 * structure from the transcription and emits it as a document the reader can
 * navigate, cite and search — from the transcription ALONE when there is nothing
 * else, and with the volume's own leaves behind the page model when the repo
 * stores a derivation of them (decision 6).
 *
 * SIX DECISIONS, and why they are these decisions:
 *
 * 1. PAGINATION COMES FIRST, BEFORE ANYTHING IS READ AS A HEADING (§4.2). A
 *    running head carries the printed page number inline; so does a bare folio
 *    whose head's words were lost. Both are consumed from the LINE stream
 *    before any block is classified, which is what structurally kills the
 *    folio-as-heading defect (`reader.mjs` `detectHeading`/`isHeading` reads a
 *    bare numeral as a heading — 348 of 522 of one volume's headings were a
 *    folio). A number at a page head is a folio BY CONSTRUCTION, never a
 *    heading; nothing below ever asks `isHeading`.
 *
 * 2. A CANDIDATE PAGE NUMBER IS BELIEVED ONLY ON ARITHMETIC. A token that reads
 *    as digits is a reading of the print and is taken as long as the sequence
 *    moves forward. A token that needed an OCR confusion (`io`→10, `II`→11) is
 *    an INTERPRETATION, and so is a bare folio, whose head's words are gone: it
 *    is accepted only if it preserves the ±1 stride with its neighbours
 *    (`value === prev + 1`, or `next − 1` when nothing precedes it). That is
 *    what the plan's reconciliation rule says, and it is checkable: the volume's
 *    measured `5` (body start, next head 6) is accepted; its `3` (between 33 and
 *    34) and its `43` (between 41 and 44) are refused and emitted with
 *    `page: null` — never a fabricated number.
 *
 * 3. NOTES AND SECTIONS ARE CLOSED BY THEIR OWN ARITHMETIC (§4.3, §4.4). The
 *    sections must come out 18 consecutive with no gap and no duplicate; the
 *    note markers 1…N consecutive. Anything else throws and names the offender,
 *    so a bad guess is caught by the count rather than by taste. The measured
 *    `(n)` note marker and the mangled `n.^Tb,eologists` section opener are
 *    resolved by SEQUENCE FITTING — the expected value, because the sequence
 *    requires it — which is a rule, not a special case for those two strings.
 *
 * 4. THE SERVED BLOCKS ARE THE VERBATIM TRANSCRIPTION (§4.1). Nothing is
 *    dropped in the document: page furniture is kept as `rh` blocks, a refused
 *    marker keeps its own text, and a note reference keeps the words the print
 *    has ("(note i)") beside the number it resolves to. Corrections travel as
 *    RULES, never as a second text, so the transcription is always inspectable
 *    and the diff view is the rule list itself. The rules are the REVIEWED list
 *    in `data/editions/<slug>/versions/<semver>/repairs.json` (§7) — the artifact a human reads —
 *    and every one of them must fire at least once in the served text or the
 *    build fails (`checkEdits`, called by the build): a rule that matches
 *    nothing is unreviewed machinery.
 *
 * 5. THE EDITION LIVES IN THE REPO. `data/editions/<slug>/versions/<semver>/source.txt` is the
 *    transcription as imported, once, from the shelf; the build reads that and
 *    never the shelf (the shelf is touched only by `--import`, below, which
 *    refuses to overwrite a changed edition). The library is still held back
 *    from the site by `LIBRARY=1`; storing an edition does not publish it.
 *
 * 6. THE PAGE MODEL RESTS ON THE VOLUME'S OWN LEAVES WHEN THEY CAN BE HAD (§4.6,
 *    phase 4). A running head says what a page number IS; it does not say where
 *    one page ends and the next begins, and it cannot speak for a page whose head
 *    the transcription lost. The leaves do. `tools/derive.mjs` reads the
 *    item's own page files ONCE and stores, beside the edition,
 *    `data/editions/<slug>/derivs.json`: the leaf table, the line index at which
 *    each leaf begins, and the inventory of the bytes it was derived from. This
 *    module then places every page marker ON a leaf, and reconciles the three
 *    signals about a page — the item's own page-number pass, the leaf a marker
 *    stands on, and the transcription's own heads and folios — REPORTING every
 *    disagreement rather than merging it (the table and the diff print at build).
 *    Two things follow that the text alone cannot do: a number the ±1 stride rule
 *    refused is re-read where the leaf it stands on is that page (`by: "leaf"` on
 *    the marker), and a leaf boundary the transcription carries no marker for at
 *    all is marked with its leaf and NO number (`how: "leaf"`) instead of being
 *    invisible. What is SERVED is still only what a source read: a number nothing
 *    on the leaf reads is never invented for it. The artifact is derived, not
 *    fetched, so the build needs neither the item's files nor the network — and an
 *    extraction that has no model says so instead of quietly reading in txt mode.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  rawBlocks,
  normaliseNumber,
  applyCorrections,
  isFurnitureJunk,
  runningHead,
  bareFolio,
  joinLines,
  collapseLine,
} from './reader.mjs';
import { TEXTS, SHELF, shelfFiles, shelfFile, textSource } from './shelf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the repo keeps an EDITION of a text, and where the anchors it serves
 * are pinned — the DATA-MODEL §1 layout (extraction plan §1.5, PLAN DEFAULT):
 *
 *   data/editions/<slug>/edition.json                      the bibliographic record
 *   data/editions/<slug>/versions/<semver>/source.txt      the frozen transcription
 *   data/editions/<slug>/versions/<semver>/repairs.json    THE RULE FILE (model §4.3)
 *   data/editions/<slug>/{import,derivs,witnesses}.json    the pipeline's own evidence
 *   tools/anchors/<slug>.json                              the pinned anchor manifest
 *
 * The served rules live in the version directory and nowhere else (model §4.3):
 * there is no second copy under tools/edits, which holds only the repair
 * pipeline's own working files. */
export const LIBRARY_DIR = join(ROOT, 'data', 'editions');
export const ANCHOR_DIR = join(ROOT, 'tools', 'anchors');

export const editionJsonPath = (slug) => join(LIBRARY_DIR, slug, 'edition.json');

/** The edition record (model §3), or null when the repo stores no edition for
 * this slug — the 37 held-back shelf entries have no `data/editions/<slug>/`. */
export function editionRecord(slug) {
  const file = editionJsonPath(slug);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`library: ${slug}: edition.json is not valid JSON — ${e.message}`);
  }
}

/** Which `versions/<semver>/` a bare `/texts/<slug>/` serves (model §3.1). An
 * explicit version wins; otherwise `current_version` from the edition record. */
export function versionOf(slug, version = null) {
  if (version) return version;
  const e = editionRecord(slug);
  return e && e.current_version ? e.current_version : null;
}

export const versionDir = (slug, version) => join(LIBRARY_DIR, slug, 'versions', version);
/** THE canonical rule file for one version (model §4.3) — the single source of
 * truth the build derives the reader's internal shape from. */
export const repairsPath = (slug, version) => join(versionDir(slug, version), 'repairs.json');
export const metaPath = (slug, version) => join(versionDir(slug, version), 'meta.json');
export function readMeta(slug, version) {
  const file = metaPath(slug, version);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export const editionPath = (slug, version = null) => {
  const v = versionOf(slug, version);
  return v ? join(versionDir(slug, v), 'source.txt') : join(LIBRARY_DIR, slug, 'source.txt');
};
export const importPath = (slug) => join(LIBRARY_DIR, slug, 'import.json');
export const derivsPath = (slug) => join(LIBRARY_DIR, slug, 'derivs.json');

/** Where a text's RECORDED DIVISIONS live, if it has any (§3.2, `opener:
 * "recorded"`): `data/editions/<slug>/divisions.json`, or — for a version that
 * holds its own model — `data/editions/<slug>/versions/<v>/divisions.json`.
 * Like `derivs.json` it is derived, not hand-written, and it is refused when it
 * was derived against other bytes than the edition being extracted. */
export const editionDivisionsPath = (slug) => join(LIBRARY_DIR, slug, 'divisions.json');
export const versionDivisionsPath = (slug, version) => join(versionDir(slug, version), 'divisions.json');
/** How many versions an edition has on the shelf (its `versions/` directories). */
export function versionCount(slug) {
  const dir = join(LIBRARY_DIR, slug, 'versions');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
}
/**
 * THE DIVISION MODEL FILE A VERSION SERVES, resolved version-aware (§3.2).
 *
 * A version that holds its own `versions/<v>/divisions.json` is served THAT
 * model — the one its DOI names — and the edition-level file is never read for
 * it. The edition-level file is the fallback for an edition (or a version) that
 * has none of its own, which is how a single-version edition with a recorded
 * model keeps working.
 *
 * THE TRAP, and it is LOUD: for a MULTI-VERSION edition, a version with no
 * model of its own would silently inherit the edition-level file AFTER that
 * file has moved on — the pinned page would serve a structure its DOI does not
 * name, the exact drift the versioning of `repairs.json` closed. So there the
 * resolution REFUSES, naming the version and the file, instead of falling back.
 */
export function divisionsPath(slug, version = null) {
  const v = versionOf(slug, version);
  const own = v ? versionDivisionsPath(slug, v) : null;
  if (own && existsSync(own)) return own;
  const fallback = editionDivisionsPath(slug);
  if (v && existsSync(fallback) && versionCount(slug) > 1) {
    throw new Error(
      `library: ${slug}: version ${v} of a ${versionCount(slug)}-version edition has no division model of ` +
        `its own (${versionDivisionsPath(slug, v)} does not exist), and the edition-level ` +
        `${fallback} is NOT a fallback for it — that file has moved on, and a pinned version ` +
        `inheriting it would serve a structure its DOI does not name.\n` +
        `  Freeze this version's own model: copy the model it was deposited under to ` +
        `${versionDivisionsPath(slug, v)}.`,
    );
  }
  return fallback;
}

/** The archive.org items this edition's PAGE IMAGES come from, as the edition's
 * own `scan.json` records them. An edition cut from ONE volume names it with
 * `item`; an edition cut from two (Taylor's 1816 Theology of Plato is vol. I and
 * vol. II of one edition, and the two scans' leaf numbers run over each other)
 * keeps no single `item` and names its items HERE — the reader's `source.item`
 * has to be a string, so those names are joined rather than dropped, which would
 * have made the document undecodable (`D.field "item" D.string`). */
export function scanItemNames(slug) {
  const file = join(LIBRARY_DIR, slug, 'scan.json');
  if (!existsSync(file)) return [];
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(s.items) && s.items.length) {
      return s.items.map((it) => it.archive_id || it.item).filter((x) => typeof x === 'string' && x !== '');
    }
    return typeof s.item === 'string' ? [s.item] : [];
  } catch {
    return [];
  }
}

/**
 * THE RECORDED DIVISIONS, if this edition has them (§3.2).
 *
 * An edition whose division numerals the scan destroyed cannot have its
 * divisions read out of the transcription at all (see the `recorded` opener
 * spec). Its divisions were read off the SCANS and are stored as data beside the
 * edition: every division's line in the transcription, its book and chapter, its
 * label, its anchor, its confidence and the leaf/head it was read from
 * (`tools/divisions.mjs` writes it). Loaded here and verified against the
 * edition's own bytes, so a model of another transcription is refused rather than
 * applied to line positions that have moved. The file is resolved VERSION-AWARE
 * (`divisionsPath`): a version holding its own `versions/<v>/divisions.json` is
 * served that model, and a multi-version edition's version with none is refused
 * rather than left to inherit the moved edition-level file.
 */
export function loadDivisions(slug, edition = null, version = null) {
  const file = divisionsPath(slug, version);
  if (!existsSync(file)) return null;
  let model;
  try {
    model = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`library: ${slug}: the recorded divisions are not valid JSON — ${e.message}`);
  }
  if (!Array.isArray(model.divisions) || model.divisions.length === 0) {
    throw new Error(`library: ${slug}: the recorded divisions carry no divisions[] — it is not a division model`);
  }
  if (edition != null && model.source && model.source.sha256 && model.source.sha256 !== edition) {
    throw new Error(
      `library: ${slug}: the recorded divisions were read against other bytes than the edition this repo stores ` +
        `(model: ${model.source.sha256.slice(0, 12)}…, edition: ${edition.slice(0, 12)}…) — every division in it is a ` +
        `line position of the transcription it was derived against, so its anchors would land in the wrong places.\n` +
        `  Make a new model deliberately: node tools/divisions.mjs ${slug}`,
    );
  }
  for (const d of model.divisions) {
    if (!Number.isInteger(d.n) || !Number.isInteger(d.line) || typeof d.text !== 'string') {
      throw new Error(`library: ${slug}: a recorded division is not {n, line, text} — it is not one`);
    }
  }
  // THE ANCHOR IS NOT OPTIONAL. The served id is read from the division's
  // recorded `anchor` (so an inserted division cannot move the anchors after
  // it); a model missing one would fall back to the ordinal — the very
  // coupling the field exists to break — so the load refuses it, and two
  // divisions may not claim one name.
  const seenAnchors = new Set();
  for (const d of model.divisions) {
    if (typeof d.anchor !== 'string' || d.anchor === '') {
      throw new Error(
        `library: ${slug}: division ${d.n} records no anchor — the served id would fall back to the ` +
          `ordinal, which is the coupling the anchor field exists to break`,
      );
    }
    if (seenAnchors.has(d.anchor)) {
      throw new Error(`library: ${slug}: two recorded divisions claim the anchor "${d.anchor}" — an anchor two divisions share is not an anchor`);
    }
    seenAnchors.add(d.anchor);
  }
  return model;
}
export const anchorPath = (slug) => join(ANCHOR_DIR, `${slug}.json`);
export const hasEdition = (slug) => versionOf(slug) != null && existsSync(editionPath(slug));
export const readEdition = (slug, version = null) => readFileSync(editionPath(slug, version), 'utf8');

/**
 * THE DERIVED PAGE MODEL, if this repo stores one (phase 4, plan §4.6).
 *
 * `data/editions/<slug>/derivs.json` is what `tools/derive.mjs` writes
 * from the archive item's own `_djvu.xml` and `_page_numbers.json`: the leaf
 * table, the alignment to this edition's line stream, and the inventory of the
 * bytes it was derived from. Those derivatives are 942 KB on a host path; this
 * artifact is the few kilobytes of it a document can be built from, and it is
 * the only one of the two the build is allowed to need (`LIBRARY_DERIVS` is read
 * by the deriving tool, never by the build).
 *
 * A model derived against OTHER BYTES than the edition being extracted is
 * refused rather than used: the leaf boundaries are line positions, and a changed
 * edition moves every one of them. The refusal names the command that makes a new
 * one, because the artifact is derived, not hand-written.
 */
export function loadDerivs(slug, edition = null) {
  const file = derivsPath(slug);
  if (!existsSync(file)) return null;
  let model;
  try {
    model = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`library: ${slug}: the derived page model is not valid JSON — ${e.message}`);
  }
  if (edition != null && model.edition && model.edition.sha256 !== edition) {
    throw new Error(
      `library: ${slug}: the derived page model was built from other bytes than the edition this repo ` +
        `stores (model: ${model.edition.sha256.slice(0, 12)}…, edition: ${edition.slice(0, 12)}…) — every leaf ` +
        `boundary in it is a line position of the edition it was derived against, so it cannot be used here.\n` +
        `  Make a new one deliberately: node tools/derive.mjs ${slug}`,
    );
  }
  return model;
}

/**
 * Everything the page pass reads, and the index space a leaf boundary lives in.
 *
 * The LEAF model's coordinates are line indices of the whole file, so the line
 * stream here INCLUDES the library stamp the extractor drops (a leaf boundary is
 * a line of the file whether or not it is text). `markerKeyAt` maps such an index
 * to the key the emission pass uses, so a leaf boundary and a running head name
 * the same line.
 */
export function pageSignals(src, entry) {
  const cfg = TEXT_RULES[entry.slug] || {};
  const all = rawBlocks(src);
  const flat = [];
  for (const block of all) for (const line of block) flat.push(line);

  /* 1. THE LIBRARY'S STAMP, recorded and taken out of the page-furniture pass's
   * way. It is NOT text of the book, but it is not dropped from the DOCUMENT: it
   * is served as the leading `library` region (see `extract`), so the
   * transcription is whole and the copy's marks are treated the same at both
   * ends. It is recorded here, and kept out of `lines`, because the page pass
   * must not read its "08" as a folio. */
  let drop = 0;
  const dropped = [];
  for (const want of cfg.stamp || []) {
    const got = all[drop] ? all[drop].join(' ') : null;
    if (got !== want) {
      throw new Error(
        `library: ${entry.slug}: the library stamp is not where it was measured ` +
          `(wanted block ${JSON.stringify(want)}, found ${JSON.stringify(got)}) — ` +
          `the transcription has changed shape and the extraction must be re-read, not patched`,
      );
    }
    dropped.push(all[drop][0]);
    drop++;
  }
  const lines = all.slice(drop);
  const keys = [];
  const base = [];
  let run = 0;
  for (let bi = 0; bi < lines.length; bi++) {
    base.push(drop + run);
    for (let li = 0; li < lines[bi].length; li++) keys.push(`${bi}:${li}`);
    run += lines[bi].length;
  }
  const at = (bi, li) => base[bi] + li;
  const markerKeyAt = (index) => (index >= drop && index - drop < keys.length ? keys[index - drop] : null);

  /* 2. Page furniture, consumed before anything is read as a heading (§4.2).
   * `reconcile` has already given every marker the page the TRANSCRIPTION's own
   * readings support; step 2b then reads the leaves. */
  const { markers, junk } = scan(lines, cfg, at);
  reconcile(markers, cfg);
  return { cfg, all, lines, drop, dropped, flat, flatLines: flat.length, markers, junk, markerKeyAt, at };
}

/** The sha256 of a text, as the document records it: the served edition is
 * identified by its bytes, so a reader can say which text this document is of. */
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The per-text facts that are not rules. Everything here is a MEASURED property
 * of one edition, not a policy and not a repair: which words the running head
 * carries, which blocks the library's own stamp occupies (the stamp is the copy's
 * mark, not the book's, so it is recorded here and served as its own `library`
 * region rather than read as text), and where
 * the volume's divisions begin.
 *
 * The REPAIRS are not here. They are in `data/editions/<slug>/versions/<semver>/repairs.json` — the
 * reviewed rule list (plan §7), one file per text, loaded by `loadEdits` and
 * shipped inside the document exactly as the plans says: corrections travel as
 * rules, never as a second text, so the transcription stays inspectable and the
 * diff view is the rule list itself.
 */
/** How one text's divisions are NUMBERED. `arabic` is the Cave's own shape — a
 * bare arabic numeral at the start of a line that carries the section's own
 * first words ("7. Why, therefore") — and `roman` is the label shape the 1816
 * volume prints ("PROPOSITION XXVI."), where the division's number stands on a
 * line of its own and the section's words begin on the next block. The spec is
 * DATA, not code: each shape is one entry here, and a third numbering would be
 * a third entry rather than a fork in the extraction. */
const OPENER_SPECS = {
  arabic: { re: /^['\u2018]?(\d{1,2})\.\s/, read: (token) => Number(token) },
  roman: {
    // the label, an optional stray quote before it (the transcription opens one
    // proposition with `' PROPOSmON`), the numeral, and its stop
    re: /^['\u2018]?\s*PROPOSITION\s+([IVXLCDM]+)\b[.,]?/,
    read: readRoman,
  },
  /* `recorded` — THE DIVISIONS ARE NOT IN THE TRANSCRIPTION TO BE READ. Some
   * editions have had their division numerals destroyed by the scan: Taylor's
   * 1816 Theology of Plato prints `CHAP. VII. OF PLATO.` in the running head and
   * `CHAPTER VII.` under it, and the transcription writes those as `CHAP. au.`,
   * `CHAPTER VE`, `CHAP REX`. No regex reads a number that is not there, and
   * fitting one from the sequence is how a division gets attributed to the wrong
   * BOOK (the earlier attempt's silent-wrong). So for such an edition the numbers
   * are read off the SCANS (the vision pass — `head`/`heading` per leaf, cached in
   * `heads.json`) and the divisions are shipped as DATA beside the edition
   * (`divisions.json`); the extraction OPENS a section at each recorded line and
   * verifies the line's text against the model. This entry exists so
   * `cfg.opener` can name the mode without a fork in the loop; its matcher never
   * fires (the recorded path tests line positions, not a regex). */
  recorded: { re: /$^/, read: () => null },
};

/** A roman numeral as the print writes it, read subtractively. The transcription
 * spells the number through OCR confusions (`Cl.` for CI, `CXXVl.` for CXXVI,
 * `ccvm.` for CCVIII), and those are repaired by the opener RULES before this is
 * asked — the spec only ever reads the CLEAN shape, which is what makes the rule
 * list the reviewable thing and the reader a one-liner. */
function readRoman(token) {
  const R = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  for (let i = 0; i < token.length; i++) {
    const v = R[token[i]];
    if (v == null) return NaN;
    n += i + 1 < token.length && R[token[i + 1]] > v ? -v : v;
  }
  return n;
}

/** Whether a token is a spelling of a head word: the word itself, or the word
 * with one letter substituted, inserted or deleted — the damage the 1816
 * scans leave on a head token is a letter or two ('OK' for 'ON', 'THB' for
 * 'THE', 'PLATa' for 'PLATO', 'plata' for 'plato'), and the shapes the head
 * classifiers test are built on it. */
function near(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (edits++) return false;
    if (a.length === b.length) {
      i++;
      j++;
    } else if (a.length < b.length) {
      j++;
    } else {
      i++;
    }
  }
  return true;
}

/** The edit distance between two words, or Infinity when it exceeds `k` —
 * the general form of `near`: the 1816 scans damage a head word by a letter
 * or two, and some of this volume's words are damaged harder than others, so
 * the shapes below say how far a token may sit from the word it spells. */
function spelling(a, b, k) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > k) return Infinity;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Is `a` a spelling of `word` within `k` letters? (The default is one
 * letter — the same bound as `near`.) */
const nearK = (a, word, k = 1) => a === word || spelling(a, word, k) <= k;

/** A token's letters, lowercased — the word a damaged spelling is read as. */
const lettersOf = (t) => t.replace(/[^A-Za-z]/g, '').toLowerCase();

/** A token read as a roman numeral (allowing the scan's damage: half the
 * letters roman), or as the folio's digits. */
const numeralToken = (t) => {
  const a = lettersOf(t);
  if (a === '') return false;
  const rom = (a.match(/[ivxlcdm]/g) || []).length;
  return rom === a.length || (a.length >= 3 && rom * 2 >= a.length) || /^\d+$/.test(a);
};

/** The per-text head-furniture CLASSIFIERS. A named key, not a function in the
 * config: the config is DATA a reviewer reads, and the classifier is measured
 * against one transcription. Each returns true for a line that is page
 * furniture (suppressed in the reading view, shown in the transcription view)
 * and false for a line of the book's own text. */
const FURNITURE_HEADS = {
  /* The 1816 Proclus volume's heads and feet. The signatures, measured over
   * every line of the slice: a line is one of these iff its tokens are drawn
   * only from the head vocabulary and the roman numerals, with at most the
   * folio's digits and the OCR debris the scan leaves on a token — and the
   * line's first word-like token is a spelling of 'PROP.' (any case, with up to
   * five damage letters before the 'op': pkop., fcROP., PIJOP., PBOP., PEOP.,
   * PflOP., I'KOP.) or the line begins one of the fixed shapes (the watermark,
   * 'ELEMENTS', 'OF THEOLOGY.', 'Vol. II.', 'Proc.'). MEASURED on the slice:
   * 135 range-head lines so recognised, zero text lines among them. */
  'proclus-1816': (line) => {
    if (/^digitiz/i.test(line)) return true;                    // 'Digitized by …' (140)
    if (/^(?:google|gc>9gle)/i.test(line)) return true;         // the line under it (33)
    if (/proposition/i.test(line)) return false;                // a division label, never furniture
    if (/^proc[.,]/i.test(line)) return true;                   // the running foot's 'Proc.'
    if (/^(?:vol|vo\s?l)[.,]\s*(?:ii|11)\b/i.test(line)) return true; // 'Vol. II.' / 'Vo l. II.'
    if (/^(?:elements?|element s|elements,)\b/i.test(line)) return true; // the verso title word (64)
    if (/^(?:of|ok|oe)\s+theology\b/i.test(line)) return true;  // the recto words (58)
    if (/^prop[.,]?\s+vol\b/i.test(line)) return true;          // 'Prop. Vol. II. 2 U' — a Proc misread
    /* the range head 'PROP. <romans>': the first word-like token ends in 'op'
     * (every measured spelling does), and every token after it is a roman
     * numeral (allowing the scan's damage: half the letters roman), a head
     * word, or the folio's digits. */
    const toks = line.split(/\s+/);
    const alpha = (t) => t.replace(/[^A-Za-z1]/g, '');
    const HEAD = /^(?:elements?|of|theology|oe|ok|el)$/i;
    const romanish = (t) => {
      const a = alpha(t);
      if (a === '') return false;
      const rom = (a.match(/[ivxlcdmjnu]/gi) || []).length;
      return rom === a.length || (a.length >= 3 && rom * 2 >= a.length);
    };
    const PROPWORD = /^[^A-Za-z]*[A-Za-z'1]{0,5}op[.,]?$/i;
    const pi = toks.findIndex((t) => PROPWORD.test(t));
    if (pi < 0) return false;
    if (line.length > 48) return false;
    for (let k = pi + 1; k < toks.length; k++) {
      const t = toks[k].replace(/[^A-Za-z1-9.,]/g, '');
      if (t === '') continue;
      if (HEAD.test(alpha(t)) || romanish(t) || /^\d{1,3}[a-z]?[.,]?$/.test(t)) continue;
      return false;
    }
    for (let k = 0; k < pi; k++) {
      const t = alpha(toks[k]);
      if (t === '') continue;
      if (HEAD.test(t) || /^\d{1,3}[a-z]?$/.test(t)) continue;
      return false;
    }
    return true;
  },

  /* The 1816 Theology of Plato's heads and feet — the SAME press as the
   * Elements, but this volume's heads are its own, and the scan splits every
   * side onto two lines and damages the words, so no equality list can carry
   * the spellings. Each half is therefore recognised by SHAPE: a line whose
   * every token is a spelling of that half's own words, and nothing else.
   * The signatures, measured over every line of the slice (a token is a
   * spelling of a word when it is within `k` letters of it — the scan's
   * damage is a letter or two, and the running heads' numerals are damaged
   * beyond reading, so their shape bounds the number and never reads it):
   *   the Google watermark — 'Digitized by …' (800 lines) and the 'Google'
   *     line under it (147) in every spelling the scan gives them, the damage
   *     running to a lost or glued first letter ('igitized by', '. Digitized
   *     by v^ooQle', 'D itized by'), a split word ('G oogle', 'Digit ized
   *     by') or a junk token glued on ('J3i( boogie', 'D . zed by boogie',
   *     'y Google');
   *   the verso head's left half — 'ON THE THEOLOGY' (357 lines) in every
   *     spelling, the damage running to a wrong letter ('ON THB THEOLOGY',
   *     'ON TUP THEOLOGY', 'ON THE THEDLOG?'), a lost letter, a doubled one,
   *     the whole right half glued on ('ON THE THEOLOGY BOOK II.') or the
   *     folio glued before it ('368 ON THE THEOLOGY BOOK IV.');
   *   the recto head's right half — 'OF PLATO.' (344 lines) in every
   *     spelling, the damage running to a wrong first letter ('OP PLATO.',
   *     'QF PCATQ.'), a lost space ('0FPLATO.'), a damaged 'PLATO' ('OF
   *     PLA1XX', 'OF PJyATO.'), stray punctuation ("' OP PLATO.", "01-'
   *     PLATO.") or the folio glued on ('OF PLATO, .25');
   *   the recto head's left half — 'CHAP. n.' / 'CHAPTER n.' (794 lines):
   *     the running head, the chapter opening's display heading, the
   *     contents list's entry and the whole head glued on one line ('CHAP.
   *     XXVI. OF PLATO. 81'), the damage running to the word itself ('NHAP.
   *     NH.', 'eiiAP. r..', 'CH AP. VII.', 'CHAR VII.', 'CRAP. VII.') and to
   *     the numeral, which is OCR garbage the edition's own config names
   *     ('CHAP. au.', 'CHAP REX', 'CHAPTER VE', 'CHAP: KXVI', 'CHAPTER
   *     Piglets');
   *   the Introduction's and the contents pages' running heads —
   *     'INTRODUCTION.' (41 lines) and 'CONTENTS.' (26 lines) in every
   *     spelling, the damage running to a wrong letter ('INTBODUCTIO N.'),
   *     a lost ending ('CONTENT.'), a split word ('I N TRODUCT10N#'), a
   *     stray mark ('INTRODUCTION*', 'CONTENTS#') or the folio glued on
   *     ('XVlii INTRODUCTION.');
   *   the running foot — the bare 'Proc.' (9 lines, one with a stray letter
   *     glued on) and the printer's signature 'Proc. Vol. n. <letter>'
   *     (83 lines, one of them the bare foot with its period split off), the
   *     damage running to
   *     the word ('Proe.', 'Procl', 'Troc.'), the volume word ('Vox', 'Von',
   *     'Voi.1.') or the signature itself ('2 A', '3 G');
   *   the running foot's volume half — 'VOL. I.' / 'VOL. II.' (16 lines);
   *   the verso head's right half — 'BOOK n.' (342 lines) in ninety
   *     spellings, the numeral roman in the print and damaged like any other
   *     word: the damage runs to three characters of junk ('BOOK V„', 'BOOK
   *     V1L', 'BOOK TIL', 'BOOK Y.') and even to the space itself ('BOOK!.'
   *     and 'BOOK'll.' for 'BOOK I.'), so the shape is the word plus a short
   *     run of non-space junk, capped at twelve characters;
   *   what the shapes deliberately do NOT take: the title page's own lines
   *   ('ON THE THEOLOGY OF PLATO,', 'THE', 'ON', 'OF', 'Plato.', 'of Plato.',
   *   'theology of Plato.') — the head halves carry no 'PLATO' where the title
   *   has it, the contents' mixed-case 'of Plato.' is not the head's capitals,
   *   and the title's one-word lines are too short to be a head; the page-90
   *   head the print sets in full ('ON THE THEOLOGY OF PLATO.', MEASURED on the
   *   leaf — one line, identical to the title page's and so not separable by
   *   shape); the contents section's display heading ('CONTENTS OF THE
   *   CHAPTERS OF BOOK n.' and its split first line 'CONTENTS'); the glossary's
   *   own entries ('Horos.', 'Mid. ^', 'Heaven. 3'); the footnotes that begin
   *   with a chap-like or proc-like word ('chapter forty is wanting.',
   *   'chapter thirty-six. And instead of …', 'cap. 7.', 'Procl. in Tim. p.
   *   296.', 'Proclus, in his usual …'); the title pages' volume statements
   *   ('VOL. I.' under 'TWO VOLUMES.'); and the book opening's display heading
   *   'BOOK n.' above 'CHAPTER I.', which the carve-out in `extract` spares
   *   (MEASURED: seven of those, one per book). MEASURED: 2,960 furniture
   *   lines so recognised (947 + 357 + 344 + 794 + 67 + 93 + 16 + 342), every
   *   one a standalone block standing in a page head, a page foot, a chapter
   *   opening or the contents list; the carve-out in `extract` spares the 454
   *   of them that are the book's own text or a repair rule's target (225
   *   contents entries, 215 chapter display headings, 7 book display
   *   headings, 2 title-page volume statements, 1 contents display heading,
   *   4 furniture lines a repair rule is defined over — three signatures and
   *   one whole-head line; the 1.0.0 rule list predates the whole-head rule
   *   and spares 453 there) and suppresses the 2,506 that are furniture,
   *   every suppression a standalone block or a block's last line, so no
   *   paragraph splits. */
  'theology-1816': (line) => {
    if (isGoogleStampLine(line)) return true;   // the watermark and the line under it (947)
    if (isChapHeadLine(line)) return true;      // the chapter running head, display heading, contents entry (794)
    if (isIntroContentsLine(line)) return true; // 'INTRODUCTION.' / 'CONTENTS.' (67)
    if (isProcFootLine(line)) return true;      // 'Proc.' and the printer's signatures (93)
    if (isVolFootLine(line)) return true;       // the foot's 'VOL. I.' (16)
    /* the verso head's left half: 'ON THE THEOLOGY' — every token a spelling
     * of one of its three words (within two letters), with at most the right
     * half 'BOOK n.' glued after it and the folio glued before it. No fourth
     * word: the title page's 'ON THE THEOLOGY OF PLATO,' carries 'PLATO' and
     * is the book's own title, not furniture. */
    {
      const toks = line.trim().split(/\s+/).filter((t) => t !== '');
      if (toks.length >= 2 && toks.length <= 6 && toks.some((t) => nearK(lettersOf(t), 'theology', 2))) {
        let headWords = 0;
        let isHead = true;
        for (const t of toks) {
          if (['on', 'the', 'theology'].some((w) => nearK(lettersOf(t), w, 2))) {
            headWords++;
            continue;
          }
          if (nearK(lettersOf(t), 'book')) continue;
          const a = t.replace(/[^A-Za-z0-9]/g, '');
          if (a !== '' && a.length <= 4 && numeralToken(a)) continue;
          if (a === '') continue;
          isHead = false;
          break;
        }
        if (isHead && headWords >= 2) return true;
      }
    }
    /* the recto head's right half: 'OF PLATO.' — the first token a spelling
     * of 'OF' (with stray marks before it), the second of 'PLATO' in the
     * head's own capitals (within two letters), with at most the folio's
     * digits glued after it; or the whole half glued into one token
     * ('0FPLATO.'). The one text line the shape would otherwise reach, the
     * contents' 'of Plato.', is mixed case. */
    {
      const toks = line.trim().split(/\s+/).filter((t) => t !== '');
      if (toks.length >= 1 && toks.length <= 4) {
        if (nearK(lettersOf(line), 'ofplato', 2) && (line.match(/[A-Z]/g) || []).length >= 3) return true;
        if (toks.length >= 2) {
          const a = lettersOf(toks[0].replace(/^[^A-Za-z]+/, ''));
          const b = lettersOf(toks[1]);
          if (
            nearK(a, 'of') &&
            nearK(b, 'plato', 2) &&
            (toks[1].match(/[A-Z]/g) || []).length >= 3 &&
            toks.slice(2).every((t) => /^[^A-Za-z\s]{1,5}$/.test(t))
          ) {
            return true;
          }
        }
      }
    }
    /* the verso head's right half: 'BOOK n.' — the book running-head line. */
    if (line.length <= 12 && BOOK_HEAD_LINE.test(line)) return true;
    return false;
  },
};

/** A book running-head line of the 1816 Theology: 'BOOK n.', the numeral roman
 * in the print and damaged like any other word the scan touches — MEASURED,
 * the damage runs to three characters of junk ('BOOK V„', 'BOOK V1L', 'BOOK
 * TIL', 'BOOK Y.') and even to the space itself ('BOOK!.', 'BOOK'll.'), so the
 * shape is the word followed by a short run of non-space junk, capped at
 * twelve characters by the classifier. MEASURED over every line of the slice:
 * the only lines that match are the 342 running-head lines, every one a
 * standalone block standing in a page head; no line of the book's text does
 * (the two text lines that begin with the word are sentences, and the
 * anchored shape cannot reach them). The shape is shared with the carve-out
 * in `extract`, which spares the book opening's display heading. */
const BOOK_HEAD_LINE = /^book(?![A-Za-z])[^A-Za-z\s]{0,2}(\s*\S{1,4})?(\s\S{1,2})?[^A-Za-z0-9\s]{0,2}$/i;

/** The chapter-I display heading that opens a book of the 1816 Theology: the
 * transcription spells the numeral 'I', or '1' or 'l' where the scan damaged
 * it. The carve-out in `extract` finds it above a chapter-1 division. */
const CHAPTER_ONE_LINE = /^chapter\s+[il1][.,;:]?$/i;

/** The Google watermark of the 1816 Theology — 'Digitized by …' and the
 * 'Google' line under it — in every spelling the scan gives them. MEASURED
 * over every line of the slice: 947 lines so recognised (800 watermark, 147
 * Google), every one standing at a page top; no line of the book's text
 * does (no prose word sits within two letters of 'digitized' or 'google').
 * The base shapes are the word at the line's start; the stragglers are the
 * word with its first letter lost or glued to a stray mark ('igitized by',
 * '. Digitized by v^ooQle', 'D itized by'), the word split in two ('G
 * oogle', 'Digit ized by'), or a junk token glued on ('J3i( boogie', 'D .
 * zed by boogie', 'y Google'). */
function isGoogleStampLine(line) {
  const t = line.trim();
  if (/^\s*[a-z]?\s*digitiz/i.test(t)) return true;
  if (/^\/?\s*(?:google|gc>9gle)\b/i.test(t)) return true;
  if (t.length === 0 || t.length > 32) return false;
  const toks = t.split(/\s+/).filter((x) => x !== '');
  const isStampWord = (w) => nearK(w, 'digitized', 2) || nearK(w, 'google', 2);
  if (toks.some((x) => isStampWord(lettersOf(x)))) return true;
  return toks.length >= 2 && isStampWord(lettersOf(toks[0]) + lettersOf(toks[1]));
}

/** A CHAPTER line of the 1816 Theology, by shape: 'CHAP. n.' (the recto
 * running head's left half), 'CHAPTER n.' (the chapter opening's display
 * heading and the contents list's entry), and the whole recto head glued on
 * one line ('CHAP. XXVI. OF PLATO. 81'). MEASURED over every line of the
 * slice: 794 lines so recognised (225 in the front matter, 569 in the body),
 * every one a standalone block standing at a page head, a page foot's
 * neighbour, a chapter opening or the contents list. The shape is the
 * chap-word plus a bounded numeral and NEVER reads or fits the number: the
 * numerals are OCR garbage the edition's own config names ('CHAP. au.', 'CHAP
 * REX', 'CHAPTER VE', 'CHAP: KXVI', 'CHAPTER Piglets'), and the word itself
 * is damaged too ('NHAP. NH.', 'eiiAP. r..', 'CH AP. VII.', 'CHAR VII.',
 * 'CRAP. VII.', '6HAP. XXVIir.'). The lines the shape deliberately does NOT
 * take are the book's own prose that begins with a chap-like word ('chapter
 * forty is wanting.', 'chapter thirty-six. And instead of …') and the
 * footnote 'cap. 7.' — both are spared by the carve-out in `extract`. */
function isChapHeadLine(line) {
  const t = line.trim();
  if (t.length === 0 || t.length > 28) return false;
  const toks = t.split(/\s+/).filter((x) => x !== '');
  if (toks.length < 2) return false;
  /* the chap-word, possibly split over two tokens ('CH AP. VII.') */
  const isChapWord = (w) =>
    w.length >= 3 && w.length <= 7 && (nearK(w, 'chap') || nearK(w, 'chapter') || /ap$/.test(w));
  let idx = 1;
  if (!isChapWord(lettersOf(toks[0]))) {
    if (toks.length >= 2 && lettersOf(toks[0]).length <= 2 && isChapWord(lettersOf(toks[0]) + lettersOf(toks[1]))) {
      idx = 2;
    } else {
      return false;
    }
  }
  /* the numeral: a short token, capitalised or romanish or junk — never a
   * lowercase prose word ('chapter forty is wanting.' is Taylor's footnote) */
  if (idx >= toks.length) return false;
  const num = toks[idx].replace(/[^A-Za-z0-9]/g, '');
  if (num.length < 1 || num.length > 7) return false;
  if (!(/[A-Z]/.test(toks[idx]) || num.length <= 3 || numeralToken(num))) return false;
  /* nothing after the numeral but head words, digits and punctuation (the
   * whole-head line 'CHAP. XXVI. OF PLATO. 81' carries the recto head's right
   * half glued on; a display heading never does) */
  for (let k = idx + 1; k < toks.length; k++) {
    if (/^[a-z]{4,}/.test(toks[k]) && !numeralToken(toks[k])) return false;
  }
  return true;
}

/** The recto head's right half as a line of its own — 'OF PLATO.' and its
 * damaged spellings ('OP PLATO.', '0FPLATO.', 'QF PCATQ.', 'OF PLA1XX'). Used
 * by the carve-out in `extract` to read a page's head: a page that carries no
 * such line carries no 'CHAP. n.' running head either. */
function isPlatoHeadLine(line) {
  const t = line.trim();
  if (t.length > 12) return false;
  if (nearK(lettersOf(t), 'ofplato', 2) && (t.match(/[A-Z]/g) || []).length >= 3) return true;
  return t
    .split(/\s+/)
    .filter((x) => x !== '')
    .some((tok) => (tok.match(/[A-Z]/g) || []).length >= 3 && nearK(lettersOf(tok), 'plato', 2));
}

/** The Introduction's running head 'INTRODUCTION.' and the contents pages'
 * running head 'CONTENTS.', in every spelling the scan gives them. MEASURED
 * over every line of the slice: 67 lines so recognised (41 Introduction, 26
 * contents), every one in the front matter standing at a page top. The damage
 * runs to a wrong letter ('INTBODUCTIO N.', 'CONTENT.'), a lost ending
 * ('CONTENTS' with the period gone), a split word ('I N TRODUCT10N#'), a
 * stray mark ('INTRODUCTION*', 'CONTENTS#', 'w CONTENT!.') or the folio
 * glued on ('XVlii INTRODUCTION.'). The shape deliberately does NOT take
 * the contents section's own display heading — 'CONTENTS OF THE CHAPTERS OF
 * BOOK n.' and, split over lines, its bare first line 'CONTENTS' — which the
 * carve-out in `extract` spares. */
function isIntroContentsLine(line) {
  const t = line.trim();
  if (t.length === 0 || t.length > 20) return false;
  const toks = t.split(/\s+/).filter((x) => x !== '');
  const isWord = (w) => nearK(w, 'introduction', 2) || nearK(w, 'contents', 2);
  if (isWord(lettersOf(t))) return true;
  /* the word split over two tokens ('INTBODUCTIO N.', 'iNTBODy CTION.') */
  if (toks.length >= 2) {
    const ab = lettersOf(toks[0]) + lettersOf(toks[1]);
    if (isWord(ab) && toks.slice(2).every((x) => x.length <= 4)) return true;
  }
  /* the folio glued before or after ('XVlii INTRODUCTION.', '…CTION. zix') */
  const strip = toks.slice();
  while (strip.length && strip[0].length <= 5 && (numeralToken(strip[0]) || /^[^A-Za-z]/.test(strip[0]))) strip.shift();
  while (strip.length && strip[strip.length - 1].length <= 5 && (numeralToken(strip[strip.length - 1]) || /^[^A-Za-z]/.test(strip[strip.length - 1])))
    strip.pop();
  return strip.length > 0 && isWord(lettersOf(strip.join(' ')));
}

/** The running foot of the 1816 Theology: the bare 'Proc.' (9 lines) and the
 * printer's signature 'Proc. Vol. n. <letter>' (84 lines) at the foot of the
 * first page of each gathering. MEASURED over every line of the slice: 93
 * lines so recognised, every one standing at a page foot. The damage runs to
 * the word ('Proe.', 'Procl', 'Troc.', 'Prop.'), the volume word ('Vox',
 * 'Von', 'Voi.1.'), the volume numeral ('1L' for 'II'), the numeral's period
 * split off ('Proc. Vol . I. k') or the signature itself ('2 A', '3 G'). The
 * lines the shape deliberately does NOT take are the book's own text that
 * begins with a proc-like word ('Procl. in Tim. p. 296.', 'Proclus, in his
 * usual …', 'PROCLUS' on the title page'). */
function isProcFootLine(line) {
  const t = line.trim();
  /* the bound only keeps prose out ('Procl. in Tim. p. 296.' is 22 letters
   * and fails the volume-word gate below anyway); the signatures run to 20
   * characters with the scan's stray spaces in them */
  if (t.length > 22) return false;
  const toks = t.split(/\s+/).filter((x) => x !== '');
  if (toks.length === 0) return false;
  if (!nearK(lettersOf(toks[0]), 'proc')) return false;
  if (toks.length === 1) {
    /* the bare foot: the line's letters are the word 'Proc' and nothing
     * else ('Proc.'), or the word with one stray letter glued on ('JProc,',
     * 'Procl.') — a damaged word alone ('Proe.', 'froc.' in a footnote) is
     * not taken, and neither is 'PROCLUS' on the title page */
    const w = lettersOf(t);
    return w === 'proc' || (w.length === 5 && w.includes('proc'));
  }
  let k = 1;
  while (k < toks.length && toks[k].length <= 2 && !/[A-Za-z]{2}/.test(toks[k])) k++;
  if (k >= toks.length) return true; // the bare foot with its period split off ('Proc .')
  if (!nearK(lettersOf(toks[k]), 'vol', 2) || lettersOf(toks[k]).length > 4) return false;
  k++;
  /* the numeral's period split off onto a token of its own ('Proc. Vol . I. k') */
  while (k < toks.length && toks[k].replace(/[^A-Za-z0-9]/g, '') === '') k++;
  if (k >= toks.length) return true; // 'Proc. Vol. I.' with the numeral lost
  const volnum = toks[k].replace(/[^A-Za-z0-9]/g, '');
  if (volnum.length > 2 || !/^[ivxlcdmj123]+$/i.test(volnum)) return false;
  k++;
  const rest = toks.slice(k);
  if (rest.length === 0) return true;
  return rest.length <= 3 && rest.every((x) => x.replace(/[^A-Za-z0-9]/g, '').length <= 2);
}

/** The running foot's volume half: 'VOL. I.' / 'VOL. II.' (the line the foot
 * 'Proc. Vol. I.' splits into when the scan reads 'Proc.' on its own line).
 * MEASURED: the lines so recognised stand at page feet, except the title
 * pages' own volume statements ('VOL. I.' under 'TWO VOLUMES.'), which the
 * carve-out in `extract` spares. */
function isVolFootLine(line) {
  const t = line.trim();
  if (t.length > 10) return false;
  const toks = t.split(/\s+/).filter((x) => x !== '');
  if (toks.length === 1) {
    const whole = lettersOf(t);
    return nearK(whole.slice(0, 3), 'vol') && /^[ivxlcdmj123]+$/i.test(whole.slice(3));
  }
  if (toks.length < 2 || toks.length > 3) return false;
  if (!nearK(lettersOf(toks[0]), 'vol') || lettersOf(toks[0]).length > 4) return false;
  const volnum = toks[1].replace(/[^A-Za-z0-9]/g, '');
  if (volnum.length > 2 || !/^[ivxlcdmj123]+$/i.test(volnum)) return false;
  if (toks.length === 3 && toks[2].replace(/[^A-Za-z0-9]/g, '').length > 2) return false;
  return true;
}

/** A line of prose, as the carve-out in `extract` reads it: long, or short
 * with a lowercase word in it. Page furniture is never prose, and a display
 * heading is always followed by the chapter's first line of prose. */
function isProseLine(line) {
  const t = line.trim();
  return t.length > 55 || (/[a-z]{3,}/.test(t) && /\s/.test(t) && t.length > 25);
}

/** Is this line head-FOOTER furniture, per the text's own classifier? */
function furnitureHead(cfg, line) {
  const fn = cfg.furnitureHead ? FURNITURE_HEADS[cfg.furnitureHead] : null;
  return fn ? fn(line) : false;
}

const TEXT_RULES = {
  'porphyry-on-the-cave-of-the-nymphs-taylor-1917': {
    head: 'ON THE CAVE OF THE NYMPHS',
    // the University of Toronto ownership stamp: five blocks before the book,
    // recorded here and SERVED as the leading `library` region (it used to be
    // dropped, which left the copy's marks served at the back and not at the front)
    stamp: ['PA', '4397', 'E5', '08', '1917'],
    // The back of the volume, in its three real parts: the printer's COLOPHON,
    // then the publisher's book-list, then the LIBRARY's own marks. The old single
    // boundary was the colophon (the first block after note (25)'s own paragraph)
    // — not the plan's `FROM THE GREEK OF PORPHYRY`, which is vacuous: that phrase
    // occurs exactly once, on the title page, and OCRs as "From the Greeh of
    // Porphyry", so the rule never fired and the note-continuation swallowed the
    // colophon and the list's opening seven blocks as note (25)'s own text.
    // A MEASURED FURNITURE LINE. The destroyed run between section 6's close and
    // section 7's opener: the 1917 page it stands on (printed page 20, leaf 26)
    // carries NOTHING between "the vestment of the celestial Gods." and
    // "7. Why, therefore" — so the line is furniture the scanner destroyed, not
    // text, and it is suppressed in the reading view like a running head.
    furniture: ['- -1i"^lHi.n*-iL -t-i-ir * ->-• «, , ^X'],
    divisions: {
      notes: 'Notes',
      colophon: 'PRINTED IN GREAT BRITAIN',
      // the mark's own FIRST LINE: the boundary test is per line, and this
      // block runs on ('PLEASE DO NOT REMOVE' / 'CARDS OR SLIPS FROM THIS POCKET')
      library: 'PLEASE DO NOT REMOVE',
    },
  },

  /* The Elements of Theology, as its own work out of the volume that carries
   * it: 211 propositions, each numbered in roman on a line of its own, the
   * statement and proof following as separate blocks. Everything here is
   * MEASURED on the stored slice (data/editions/<slug>/versions/<semver>/source.txt, whose
   * import.json traces it to the volume's own file over the lines the work
   * occupies). */
  'proclus-elements-of-theology-taylor-1816': {
    // THE DIVISIONS: `PROPOSITION <roman>.` — OPENER_SPECS.roman reads it. The
    // transcription mangles 14 of the 211 numerals (`Cl.` for CI, `CXXVl.` for
    // CXXVI, `T>ROPOSITION` …); the opener RULES repair them, and the spec is
    // asked only for the clean shape that is left.
    opener: 'roman',
    /* WHAT THIS EDITION'S PRINT SETS THAT THE BASE SET COUNTS AS DAMAGE. The base
     * damage set is MEASURED — on the Cave's 1917 transcription — and the policy
     * says measured, not guessed. This edition measures its own:
     *   '*'  the print's FOOTNOTE MARKER (a superscript asterisk), which the
     *        scanner glues to the word it follows — `four*`, `light*`,
     *        `that which is intellectual*` — and sometimes leaves standing alone.
     *        It is the print's own character, not damage.
     *   '&'  an ordinary ampersand, as in the print's `&c.`
     * Removing them from the set stops the census counting footnote markers as
     * damage and stops the reader marking them red. The rest of the base set
     * (`^ _ ~ £ > \ | #`) IS this edition's damage. */
    damageExclude: ['*', '&'],
    // The count the extraction asserts: the propositions run I…CCXI, no gap and
    // none doubled, and a count that is not 211 names a missed or a spurious
    // opener rather than a different book.
    expectedDivisions: 211,
    // THE CONTENTS-LIST WORD CAP. Eight words (the Cave's own cap) leave three
    // of this text's opening statements identical to their neighbours' — props
    // XXXI/XXXIII both open "Every thing which proceeds from a certain
    // thing…", and CLXIII–CLXV all open "Every multitude of unities which is
    // participated by…" — so the cap is ten, the smallest that distinguishes
    // all 211 (MEASURED: 208 distinct at eight, 211 at ten).
    titleWords: 10,
    // THE PAGE ARITHMETIC of a folio-only volume (see `reconcile`): the heads
    // are words and carry no number, so the folio chain is the only number the
    // text reads, and a scan that loses a folio line must not refuse every
    // reading after it. The bound is MEASURED on this slice: the largest true
    // gap between consecutive readable folios is 4 pages (333→336, 347→350,
    // 352→356 through its confused reading), so a skip wider than 4 is a
    // disagreement, not a missing line — 990 where 330 is due is refused.
    folioSkip: 4,
    // THE PAGE FURNITURE, by shape. This volume's heads carry NO number inline
    // (measured: 3 of 494 head lines carry a digit token, each a folio the scan
    // glued onto a verso range head — 'PROP. L. OF THEOLOGY. 535', which is the
    // folio 350 reversed); the folio stands on its OWN line, which `bareFolio`
    // reads, so this text needs the watermark and the head WORDS recognised as
    // furniture and nothing else. The shapes, measured over every line of the
    // slice (see `furnitureHead`, which applies them):
    //   the Google watermark — 'Digitized by …' in all its OCR spellings (140
    //     lines: t^OOQLe, boogie, v^ooQie, {jOoq le, the split 'Digitiz ed by')
    //     and the 'Google' line under it (33, one scanned 'Gc>9gle');
    //   the verso range head 'PROP. <propositions this page carries>' — 124
    //     lines, OCR'd in a dozen spellings of the word itself (pkop., fcROP.,
    //     PROF., PBOP., PIJOP., PEOP., I'KOP., PflOP.), sometimes run together
    //     with the folio and the recto words ('374 ELEMENTS PROP. CX1I.');
    //   the recto head's words — 'OF THEOLOGY.' (56) with its OCR forms
    //     ('OF THEOLOGY*', 'OK THEOLOGY.', 'OE THEOLOGY.') and 'ELEMENTS'
    //     (64: the verso head alone, where the folio was picked up by the line
    //     before it; the full 'ELEMENTS OF THEOLOGY.' twice is the title page
    //     and its repeat, which are FRONT MATTER and excluded by position);
    //   the signature marks at the foot — 'Proc.' with what follows ('Proc.
    //     Vol. II. 2 S', 'Proc. Vox,. II. 2 R', the split 'Vo l. II.'), the
    //     bare 'Vol. II.', and the mis-scanned 'Prop. Vol. II. 2 U' (a Proc
    //     the scan read as Prop);
    //   the bare gathers ('3 K', '2 Q') and the scan's debris, which the shape
    //     test `isFurnitureJunk` already catches.
    // The range head is recognised by its own classifier below (`isRangeHead`),
    // because no list of spellings can carry the dozen forms the scan gives the
    // one word 'PROP.'; the rest are the shapes named above.
    furnitureHead: 'proclus-1816',
  },

  /* The Theology of Plato, 1816, as the same edition prints it: SEVEN BOOKS of
   * CHAPTERS, the chapters numbered in roman and RESTARTING at I in every book
   * (Book I has xxix, Book II xii, Book III xxviii, Book IV xxxix, Book V xl,
   * Book VI xxiv, Book VII li — 223 in all, MEASURED from the print's own
   * contents lists by `tools/divisions.mjs` and cross-read off the scans).
   *
   * THE DIVISIONS ARE NOT READ FROM THE TRANSCRIPTION. They cannot be: the scan
   * wrote the chapter numerals of the running heads and of the chapter headings
   * as `CHAP. au.`, `CHAP REX`, `CHAPTER VE`, `CHAPTER Piglets` — the number is
   * gone, not misspelt — and fitting one from the sequence is exactly how the
   * earlier attempt assigned chapters to the wrong BOOK. So the numbers were read
   * off the SCANS (the vision pass, one reading per leaf, cached in `heads.json`)
   * and their positions in the transcription located by leaf (the item's own
   * `_djvu.xml` fingerprinted against `source.txt`). The result is the data file
   * `data/editions/<slug>/divisions.json`, and the extraction opens a section at
   * each recorded line. */
  'proclus-theology-of-plato-taylor-1816': {
    opener: 'recorded',
    // the recorded model, loaded and verified against this edition's bytes
    divisionModel: true,
    /* THE TITLE: the cap cuts it, the punctuation does not. This print's chapters
     * open with a discourse connective — 'In the next place, let us …' opens
     * THIRTEEN of the 215 divisions — so the punctuation stop collapses those
     * thirteen into one title at every cap (MEASURED on the recorded model's own
     * opening lines: 202 distinct titles at each of 8, 10, 12, 15, 20, 30 and 50
     * with the stop on, 215 at 11 with it off). The cap is therefore raised to the
     * smallest that distinguishes all 215 (MEASURED with the stop off: 195 at 4,
     * 207 at 5, 210 at 6, 214 at 7-10, 215 at 11) and the stop is turned off for
     * this text alone. */
    titleWords: 11,
    titleStop: 'cap',
    /* NO `damageExclude` HERE, deliberately. The same press's asterisk footnote
     * marker and ampersand are the Elements' own measurement, and an `exclude`
     * has to agree with THIS edition's `repairs.json` damage set — which is the
     * unrepaired base set, because no repair pass has been run for this edition.
     * Declaring the exclusion without measuring the edition's own set is refused
     * by `loadEdits` ("A version whose damage set is another set is a version of
     * another edition"), and measuring it is the repair pipeline's job, not the
     * division model's.
     */
    // No head is read from the transcription: the heads are the very lines whose
    // numbers the scan destroyed, and the page model of this edition rests on the
    // recorded divisions and on whatever folios survive, not on a head phrase.
    /* THE PAGE FURNITURE, by shape (see `furnitureHead`, which applies the
     * classifier this names). This volume's heads are its own: the verso head
     * is 'ON THE THEOLOGY' with 'BOOK n.' beside it, the recto head is
     * 'CHAP. n.' with 'OF PLATO.' beside it, and the scan splits every side
     * onto two lines and damages the words — so the halves are recognised by
     * their tokens, not by an equality list. The shapes, measured over every
     * line of the slice:
     *   the Google watermark — 'Digitized by …' in every spelling (800 lines)
     *     and the 'Google' line under it (147);
     *   the verso head's left half 'ON THE THEOLOGY' (357 lines) and its right
     *     half 'BOOK n.' (342), the book running-head line;
     *   the recto head's right half 'OF PLATO.' (344 lines) and its left half
     *     'CHAP. n.' / 'CHAPTER n.' (794) — the running head, the chapter
     *     opening's display heading, the contents list's entry and the whole
     *     head on one line, the numerals never read, only bounded;
     *   the Introduction's and the contents pages' running heads
     *     'INTRODUCTION.' (41) and 'CONTENTS.' (26);
     *   the running foot 'Proc.' and the printer's signatures 'Proc. Vol. n.
     *     <letter>' (93), and its volume half 'VOL. I.' (16);
     *   the chapter opening's display heading 'CHAPTER n.' and the contents
     *     list's entries are the book's own text, not furniture: the carve-out
     *     in `extract` spares them (MEASURED: 215 display headings, one per
     *     recorded division, and 225 contents entries; the 354 chapter
     *     running heads are suppressed). The book opening's display heading
     *     'BOOK n.' above 'CHAPTER I.' is the book's own text too: the carve-out
     *     spares it (MEASURED: seven, one per book; the divisions open on the
     *     chapter's first line of text, below the heading, so no BOOK line
     *     stands AT a division's own line). */
    furnitureHead: 'theology-1816',
  },
};

/* ---------- the edits: the reviewed rules, and what they do ---------- */

/** Where a text's rules live, and where a review pass leaves its proposals. Both
 * are in the repo: the rules that produce the reading view must be reconstructible
 * from the repository, and a proposal a human has not merged must never be. */
export const EDITS_DIR = join(ROOT, 'tools', 'edits');
export const editsPath = (slug) => join(EDITS_DIR, `${slug}.json`);
export const proposedPath = (slug) => join(EDITS_DIR, `${slug}.proposed.json`);

/** The classes a rule may carry, IN THE ORDER THE PIPELINE NEEDS THEM. The order
 * is load-bearing, not decorative: `opener` rules repair the division numbers,
 * and the extraction cannot find a section until they are applied; `digit` rules
 * repair printed numbers and note markers, each pinned to the line it was read
 * from; `reading` rules supply the print's word for a damaged run and come last,
 * so they can never consume a number or a division before the pass that needs it
 * has run; `review` rules record a passage whose reading is NOT determinable
 * (action "leave") and change nothing. A file whose classes are not grouped in
 * this order is rejected at load rather than silently applied out of order.
 *
 * THE CLASS THAT IS GONE, AND WHY. The family used to be called `ocr` and its
 * rules DELETED the transcription's damage marker with no reading offered — 104
 * of them, every one a pure deletion, 87 of which glued two printed words
 * together or left a non-word (MEASURED by the review). `reading` replaces it:
 * a rule of this class must record the print's word, and a damaged word whose
 * reading is not known gets no rule at all and stays visible under the base
 * policy (`_base.json`). */
export const EDIT_CLASSES = ['opener', 'digit', 'reading', 'review'];

/** Where the shared POLICY lives — the file every text inherits. It is not a rule
 * list: it states the damage-character set (MEASURED, not guessed), what each
 * class means, the application order, and the rule the pipeline enforces —
 * substitute the reading when it is recorded, otherwise leave the marker in
 * place. A text's own file is DATA under it. */
export const BASE_POLICY = join(EDITS_DIR, '_base.json');

/** The shared policy, read once per process. A missing or malformed base is an
 * error whenever a text carries rules: a per-text file without the policy it
 * claims to be written under is a rule list whose meaning is not stated. */
let baseCache = null;
export function loadBasePolicy() {
  if (baseCache) return baseCache;
  if (!existsSync(BASE_POLICY)) {
    throw new Error(`library: the base policy is missing (${BASE_POLICY}) — every text's rules are written under it`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(BASE_POLICY, 'utf8'));
  } catch (e) {
    throw new Error(`library: the base policy is not valid JSON — ${e.message}`);
  }
  if (raw.rule !== 'substitute-if-known-else-leave') {
    throw new Error(
      `library: the base policy states the rule "${raw.rule}" — this pipeline implements ` +
        `"substitute-if-known-else-leave" and will not apply another`,
    );
  }
  if (!Array.isArray(raw.damage) || raw.damage.length === 0 || raw.damage.some((c) => typeof c !== 'string' || c.length !== 1)) {
    throw new Error(`library: the base policy's damage set is not a non-empty list of single characters`);
  }
  for (const c of EDIT_CLASSES) {
    if (!raw.classes || typeof raw.classes[c] !== 'string') {
      throw new Error(`library: the base policy does not define the class "${c}"`);
    }
  }
  baseCache = {
    rule: raw.rule,
    damage: raw.damage.join(''),
    damageList: raw.damage.slice(),
    classes: raw.classes,
    order: Array.isArray(raw.order) ? raw.order : EDIT_CLASSES.slice(),
    measured: raw.damageMeasured || null,
    states: raw.states || '',
  };
  return baseCache;
}
const classRank = (cls) => {
  const i = EDIT_CLASSES.indexOf(cls);
  if (i < 0) throw new Error(`library: the correction class "${cls}" is not one of ${EDIT_CLASSES.join(', ')}`);
  return i;
};

/**
 * THE RULES THE READING VIEW APPLIES, read from the CANONICAL record.
 *
 * DATA-MODEL §4.3 and extraction plan RISK 1/2: for an edition this repo
 * stores, `data/editions/<slug>/versions/<semver>/repairs.json` is the SINGLE
 * SOURCE OF TRUTH for the rules. Model §4.0 gives the one mapping from the
 * model's shape to the reader's internal shape, and this function IS that
 * mapping:
 *
 *   find ← location.find      repl ← after       cls ← apply
 *   note ← rationale          join ← r.join
 *   action ← "leave" when apply is "review", else "replace"
 *
 * `action: "replace"` on a reading/opener/digit rule is deliberate, not an
 * omission: it is what the pipeline's own normalisation has always emitted into
 * the served document (`{find, repl, cls, note, action}`), and the served
 * `corrections` array is the artifact a citation resolves against, so the two
 * spellings must agree to the byte (the parity gate of plan §6 / RISK 1). The
 * model's shorthand "else unset" describes the MODEL record; the pipeline's
 * default is the explicit "replace", and the derivation follows the pipeline.
 *
 * The `tools/edits/<slug>.json` files are kept beside the repair pipeline as
 * PROVENANCE only — nothing in this build reads them, so a shape change in the
 * model cannot silently leave the reading view with no rules.
 *
 * Validation is deliberately strict, and it is the SAME validation the blog's
 * loader applied: a rule with no rationale is a rule nobody can review, an
 * `apply` outside the pipeline's four is a class nothing applies, two rules that
 * share a `find` are one of them unreachable, and classes out of pipeline order
 * would run a repair before the pass that needs it.
 *
 * A text with no stored edition gets no rules, which is what the other 37 texts
 * on the shelf have: their pages are the transcription, and no reading view is
 * claimed for them.
 */
export function loadEdits(slug, version = null) {
  const v = versionOf(slug, version);
  if (!v) return { edits: [], meta: null };
  const file = repairsPath(slug, v);
  if (!existsSync(file)) return { edits: [], meta: null };
  const base = loadBasePolicy();
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`library: ${slug}: the repairs file is not valid JSON — ${e.message}`);
  }
  if (raw.slug !== slug) {
    throw new Error(`library: ${slug}: the repairs file names "${raw.slug}" — a rule list that names another text is a rule list for another text`);
  }
  if (raw.version !== v) {
    throw new Error(`library: ${slug}: the repairs file is version "${raw.version}" — ${v} was asked for`);
  }
  if (raw.policy !== base.rule) {
    throw new Error(
      `library: ${slug}: the repairs file states the policy "${raw.policy}" — this pipeline implements ` +
        `"${base.rule}" and will not apply another`,
    );
  }
  /* AN EMPTY RULE LIST IS A STATEMENT; an absent one is a loss. A version that has
   * not been through the repair pass yet serves the transcription as the scanner
   * left it and says so with `rules: []` — that is the honest record of an
   * unrepaired edition, and the shelf holds it back from the site until the rules
   * exist. A file whose `rules` is not a list at all is a truncated record and is
   * refused: those two shapes must not be the same shape. */
  if (!Array.isArray(raw.rules)) {
    throw new Error(`library: ${slug}: the repairs file carries no rules list`);
  }
  /* THE DAMAGE SET travels with the version (model §4.3): the reader marks a
   * character of this set, so it must be the edition's own. Where the canonical
   * file carries one, it must agree with the base policy minus what the text
   * declares its own print sets (TEXT_RULES `damageExclude`) — a disagreement is
   * a rule file written under a policy other than the one this pipeline applies. */
  const excl = (TEXT_RULES[slug] || {}).damageExclude || [];
  const expected = base.damageList.filter((c) => !excl.includes(c));
  let damageList = expected;
  if (raw.damage != null) {
    if (!Array.isArray(raw.damage) || raw.damage.length === 0 || raw.damage.some((c) => typeof c !== 'string' || c.length !== 1)) {
      throw new Error(`library: ${slug}: the repairs file's damage set is not a non-empty list of single characters`);
    }
    if (raw.damage.slice().sort().join('') !== expected.slice().sort().join('')) {
      throw new Error(
        `library: ${slug}: the repairs file's damage set does not match the policy this pipeline applies ` +
          `(base policy minus the text's own print set):\n` +
          `  repairs.json:   ${raw.damage.join(' ')}\n` +
          `  the pipeline's: ${expected.join(' ')}\n` +
          `  A version whose damage set is another set is a version of another edition.`,
      );
    }
    damageList = raw.damage.slice();
  }
  let rank = -1;
  const seen = new Map();
  const idRe = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:r\\d{4,}$`);
  const edits = raw.rules.map((r, i) => {
    const where = `repairs.json rule ${i + 1}`;
    if (typeof r.id !== 'string' || !idRe.test(r.id)) {
      throw new Error(
        `library: ${slug}: ${where} has id ${JSON.stringify(r.id)} — a repair id is "<slug>:r<NNNN>" ` +
          `(model §4.2), stable and never reused`,
      );
    }
    const id = r.id;
    const find = r.location && r.location.find;
    const after = r.after;
    const cls = r.apply;
    const note = r.rationale;
    if (typeof cls !== 'string' || !base.classes[cls]) {
      throw new Error(`library: ${slug}: ${id}: apply "${cls}" is not a class the base policy defines`);
    }
    const leave = cls === 'review';
    if (typeof find !== 'string' || find === '') {
      throw new Error(`library: ${slug}: ${id}: no location.find — a rule without one matches nothing`);
    }
    if (typeof note !== 'string' || note === '') {
      throw new Error(`library: ${slug}: ${id}: no rationale — a rule nobody can review is not a rule`);
    }
    if (!leave) {
      if (typeof after !== 'string' || after === '') {
        throw new Error(`library: ${slug}: ${id} ("${find}") has no after — a rule that supplies no reading is not a reading`);
      }
      if (find === after) {
        throw new Error(`library: ${slug}: ${id} ("${find}") replaces the text with itself — it is not a correction`);
      }
    }
    const r0 = classRank(cls);
    if (r0 < rank) {
      throw new Error(
        `library: ${slug}: ${id} ("${find}") is apply "${cls}", which is out of pipeline order — ` +
          `the classes must be grouped ${EDIT_CLASSES.join(' → ')}, because an opener is what lets the ` +
          `extraction find a section and a reading rule may consume the characters a later class needs`,
      );
    }
    rank = r0;
    if (seen.has(find)) {
      throw new Error(
        `library: ${slug}: ${id} and ${seen.get(find)} both match "${find}" — the later one ` +
          `can never fire (the earlier already replaced every occurrence), so one of them is unreviewed machinery`,
      );
    }
    seen.set(find, id);
    // A leave spends no bytes: it counts its occurrences and replaces nothing.
    // `join` (if present) names the block a rule's find starts in — the extractor
    // merges that block with the next before the rules run, so a find that spans
    // the transcription's paragraph split can fire. The engines ignore it once
    // the merge is done, but it must survive loading for the merge to see it.
    return {
      find,
      repl: leave ? find : after,
      cls,
      note,
      action: leave ? 'leave' : 'replace',
      ...(r.join ? { join: r.join } : {}),
    };
  });
  checkReadingPolicy(edits, slug, base, damageList);
  /* THE CANONICAL TYPES, BESIDE THE READER VIEW. `checkFrontMatter` admits ONE type
   * in the preserved front-matter region (§7 / model §4.1), and the reader view does
   * NOT carry `type` — it is `{find, repl, cls, note, action}`, and the served
   * document's bytes are pinned by the parity gate. So the map is keyed by the rule's
   * own `find` (unique by the validation above: two rules sharing a find are one
   * unreachable rule) and travels in the meta, which is pipeline state and is never
   * serialised into a document. */
  const types = new Map(raw.rules.map((r, i) => [edits[i].find, r.type]));
  return {
    edits,
    meta: {
      version: v,
      file,
      classes: Object.fromEntries(EDIT_CLASSES.map((k) => [k, edits.filter((e) => e.cls === k).length])),
      damage: damageList,
      types,
      base,
    },
  };
}

/** THE POLICY, AS AN ASSERTION THAT CAN FAIL — and the reason it is a POLICY.
 *
 * A rule that carries a character of the damage set INSIDE a word (between two
 * letters of its find) may not resolve that word by deleting the character: it
 * must record the print's word. Mechanised as: such a rule's `replace` must not
 * be obtainable from its `find` by deletion alone. "the_jMowers" -> "thejMowers"
 * IS obtainable (drop the marker) and fails; "the_jMowers" -> "the powers" is
 * not, and passes. A marker standing at a word's EDGE is not covered here — the
 * review measured 17 such rules whose plain removal is the printed word — so the
 * scope is stated rather than overstated: this catches the glue and the non-word
 * (87 of the 104 the review counted), not every silent deletion. The three the
 * review called BLOCKERs (`_put`->"but", `\he`->"the", `cavern*`->"caverns") are
 * edge cases of this test and are asserted by the extractor's smoke against the
 * parallel's own words.
 */
export function checkReadingPolicy(edits, slug, base, damageList) {
  const bad = [];
  // THE EDITION'S OWN DAMAGE SET, not the base's: a character the text declares
  // its print sets (the 1816 Proclus's `*` footnote marker, its `&`) is not damage
  // there, and a rule that removes it is not a silent deletion. The default is the
  // base set, so every existing text is unchanged.
  const dmg = damageList ? [...damageList] : [...base.damage];
  for (const e of edits) {
    if (e.action === 'leave') continue;
    for (let i = 1; i < e.find.length - 1; i++) {
      if (!dmg.includes(e.find[i])) continue;
      if (/[A-Za-z]/.test(e.find[i - 1]) && /[A-Za-z]/.test(e.find[i + 1])) {
        if (isPureDeletion(e.find, e.repl)) bad.push(e);
        break;
      }
    }
  }
  if (bad.length) {
    throw new Error(
      `library: ${slug}: ${bad.length} rule(s) remove a damage character from INSIDE a word without recording a ` +
        `reading — the reading view would assert a word the edition does not have:\n` +
        bad
          .map((e) => `  ${e.cls}  ${JSON.stringify(e.find)} → ${JSON.stringify(e.repl)}  ${e.note}`)
          .join('\n') +
        `\n  Fix the rules file: record the print's word in \`replace\` (class "reading"), or record a ` +
        `\`{find, action: "leave"}\` (class "review") and let the damage show.`,
    );
  }
}

/** Is `to` obtainable from `from` by deletion alone? A greedy subsequence walk —
 * order preserved, nothing inserted, nothing substituted. */
export function isPureDeletion(from, to) {
  if (to.length >= from.length) return false;
  let j = 0;
  for (let i = 0; i < from.length && j < to.length; i++) if (from[i] === to[j]) j++;
  return j === to.length;
}

/**
 * Apply a rule list to one text, in order, every occurrence — the reader app's
 * own `applyCorrections` (`elm/src/Reader/Document.elm:114`), with the hits
 * counted as they happen.
 *
 * The count is the number of occurrences AT THE MOMENT the rule is applied, and
 * that is the only count that means anything when order decides: a rule whose
 * `find` an earlier rule has already replaced fires zero times, and this is how
 * that is SEEN rather than assumed away — the phase-1 draft carried three such
 * rules (`qreneratioi^and` and `that_jg_the`, subsumed by `^and` and `_the` with
 * an identical result, and `n.^Tb,eologists`, which the opener rule that runs
 * first has already repaired).
 */
export function applyEditsCounted(text, rules, onHit) {
  let out = text;
  for (let i = 0; i < rules.length; i++) {
    const f = rules[i].find;
    if (!f) continue;
    const leave = rules[i].action === 'leave';
    if (!leave && f === rules[i].repl) continue;
    const parts = out.split(f);
    if (parts.length === 1) continue;
    if (onHit) onHit(i, parts.length - 1);
    if (leave) continue; // a leave records its occurrences and spends no bytes
    out = parts.join(rules[i].repl);
  }
  return out;
}

/**
 * The hit table: every rule, and how many times it fires in the document's own
 * text fields, corrected in order, one field at a time.
 *
 * The DOMAIN is the document's own fields — every block's text, in document
 * order — because that is the text the reading view passes to its rule engine
 * (`Doc.applyCorrections` is applied per block and per inline run). Counting over
 * the source file instead would count a rule on a line the document never serves
 * as one string (the extractor joins hard-wrapped lines first), and the whole
 * point of the count is that it is the count the READER's application produces.
 */
export function editReport(blocks, corrections) {
  const rules = corrections.map((c) => ({ find: c.find, repl: c.repl, action: c.action }));
  const hits = rules.map(() => 0);
  const kinds = rules.map(() => new Set());
  for (const b of blocks) {
    if (typeof b.x !== 'string') continue;
    applyEditsCounted(b.x, rules, (i, n) => {
      hits[i] += n;
      kinds[i].add(b.t);
    });
  }
  return corrections.map((c, i) => ({ ...c, hits: hits[i], kinds: [...kinds[i]] }));
}

/**
 * THE ACCEPTANCE RULE (plan §7): every rule must fire at least once, or the build
 * fails and names it. "A rule that matches nothing is unreviewed machinery" — it
 * is either dead (an earlier rule already did its work, or its `find` was never
 * in the text) or wrong (a rule written for something the transcription does not
 * have), and either way it claims a repair that does not happen.
 *
 * The build calls this (tools/build.mjs); it is not asserted inside `extract`,
 * because `extract` is also run over MUTATED fixtures by the extractor's smoke —
 * a fixture that removes the text a rule matches must be free to test something
 * else without the rule gate firing first.
 */
export function checkEdits(doc) {
  const report = editReport(doc.blocks, doc.corrections);
  const dead = report.filter((r) => r.hits === 0);
  if (dead.length) {
    throw new Error(
      `library: ${doc.slug}: ${dead.length} correction rule(s) match nothing in the served text — ` +
        `a rule that matches nothing is unreviewed machinery:\n` +
        dead.map((r) => `  ${r.cls}  ${JSON.stringify(r.find)} → ${JSON.stringify(r.repl)}  ${r.note}`).join('\n') +
        `\n  Fix the rules file (data/editions/${doc.slug}/versions/<semver>/repairs.json): delete a rule an ` +
        `earlier rule has already done the work of, or correct a rule whose find is not in this transcription.`,
    );
  }
  return report;
}

/** A note definition's marker, at the start of a line in the notes region. */
const NOTE_MARK = /^\(([^)\s]{1,3})\)\s*/;
/** A note reference in the running text: every reference in this edition is
 * explicit (MEASURED: 25 of 25), so none has to be reconstructed. */
const NOTE_REF = /\(note\s+([^)\s]{1,4})\)/g;

/** Read a marker's token against the value the sequence requires, and say HOW
 * it was read — the only three outcomes there are:
 *
 *   `read`      — the token is the expected number, as digits.
 *   `confusion` — the token is the expected number read through an OCR digit
 *                 confusion ("io", "II", "i", "l", "o", "S").
 *   `fitted`    — the token cannot be read as a number at all (`n` for 11): the
 *                 SEQUENCE supplies the value, which is a rule, not a special
 *                 case for that one string.
 *
 * A token that reads as a DIFFERENT number is not fitted — that is a real
 * disagreement between the marker and the sequence, and the caller fails on it.
 * Without that, "the markers run 1…N" would be true by construction and could
 * never fail. */
function fitMarker(token, expected) {
  const n = normaliseNumber(token);
  if (n && n.value === expected) return { value: n.value, how: n.plain ? 'read' : 'confusion' };
  if (n) return { value: n.value, how: 'disagreed' };
  return { value: expected, how: 'fitted' };
}

/** Every line of the transcription, in reading order, with the furniture the
 * pagination pass takes out of it. `at` gives each marker the index of its line
 * in the WHOLE line stream of the edition, which is the index space a leaf
 * boundary is measured in (§4.6, phase 4). */
function scan(lines, cfg, at) {
  const markers = new Map();
  const junk = new Set();
  for (let bi = 0; bi < lines.length; bi++) {
    for (let li = 0; li < lines[bi].length; li++) {
      const line = lines[bi][li];
      const key = `${bi}:${li}`;
      const index = at(bi, li);
      const head = runningHead(line, cfg.head);
      if (head) {
        const n = normaliseNumber(head.num);
        markers.set(key, {
          kind: 'head',
          raw: line,
          value: n ? n.value : null,
          plain: n ? n.plain : false,
          at: index,
        });
        continue;
      }
      /* THE HEAD-WORD FURNITURE ANOTHER VOLUME PRINTS. The 1816 Proclus prints
       * its heads as WORDS with no number in them — the verso 'PROP. <range>'
       * and 'ELEMENTS', the recto 'OF THEOLOGY.' — with the folio on its own
       * line, which `bareFolio` below reads. Those lines are furniture exactly
       * as a running head is (suppressed in the reading view, shown in the
       * transcription view), and they are recognised by the text's own measured
       * classifier, because no equality list can carry the OCR spellings the
       * scan gives them. A head line that DOES carry a number ('PROP. L. OF
       * THEOLOGY. 535') is still furniture: MEASURED, all three such lines
       * carry a folio the scan glued to the head, and one of them (535 where
       * 350 is due) is the folio reversed — a number a head never printed. */
      if (furnitureHead(cfg, line)) {
        junk.add(key);
        continue;
      }
      const folio = bareFolio(line);
      if (folio) {
        markers.set(key, { kind: 'folio', raw: line, value: folio.value, plain: folio.plain, at: index });
        continue;
      }
      /* MEASURED FURNITURE, named by the text's own rules. `isFurnitureJunk` reads
       * a line's SHAPE (short, and little that is alphabetic), which is enough for
       * the debris the shapes catch — but a destroyed page of furniture can carry
       * two-letter runs and run long, and no shape test can tell it from a word.
       * When the printed page has been READ and it carries nothing where the line
       * stands, the line is furniture by MEASUREMENT, and the per-text config names
       * it, exactly as it names the library's stamp. */
      if ((cfg.furniture || []).some((f) => line === f)) {
        junk.add(key);
        continue;
      }
      if (isFurnitureJunk(line)) junk.add(key);
    }
  }
  return { markers, junk };
}

/** The next marker that carries a readable head number, from `from` on. When the
 * text's heads carry no numbers at all (the 1816 Proclus), the FOLIO is the only
 * marker that reads one — so the same walk looks for the next plain folio, which
 * is what a first folio with nothing before it is tested against. */
function nextHeadValue(markers, keys, from) {
  for (let i = from; i < keys.length; i++) {
    const m = markers.get(keys[i]);
    if (m.kind === 'head' && m.value != null) return m.value;
    if (m.kind === 'folio' && m.plain) return m.value;
  }
  return null;
}

/** Reconcile the page candidates — the plan's rule, in one place (§4.2).
 *
 * For a volume whose only number-bearing marker is the BARE FOLIO (the 1816
 * Proclus: its heads are words, and no leaf model is stored), the Cave's exact
 * ±1 test cannot start — nothing before the first folio supplies the `next`
 * value, and a scan that loses one folio line refuses every reading after it.
 * The per-text `folioSkip` widens the step for THAT case alone, and the
 * widening is still arithmetic, not taste: a plain reading v > last is accepted
 * when it skips only pages no earlier plain candidate reads (the folio lines
 * the scan lost) and no more than the bound the volume's own scan measured
 * (its largest true gap is 4). A confused reading, a backward reading and a
 * reading that jumps past a refused plain one are all still refused. */
function reconcile(markers, cfg = {}) {
  const keys = [...markers.keys()];
  const skip = cfg.folioSkip || 0;
  let last = null;
  for (let i = 0; i < keys.length; i++) {
    const m = markers.get(keys[i]);
    if (m.value == null) {
      m.page = null;
      m.how = 'refused';
      continue;
    }
    const next = nextHeadValue(markers, keys, i + 1);
    let ok;
    if (m.kind === 'head' && m.plain) {
      // a plain reading of the print: it is believed as long as the page
      // sequence moves forward (the volume's own gaps are real pages we cannot
      // read a number for, not an error to refuse)
      ok = last === null || m.value > last;
    } else if (m.kind === 'head') {
      // an ambiguous reading: it must fill the gap it sits in
      ok = m.value === (last !== null ? last + 1 : next !== null ? next - 1 : m.value);
      ok = ok && (last === null || m.value > last);
    } else if (skip > 0 && m.plain) {
      // a folio-only volume: accept the first plain reading, a +1 step, or a
      // forward skip over pages nothing read — never past a reading this rule
      // refused, and never further than the measured bound
      ok =
        last === null ||
        m.value === last + 1 ||
        (m.value > last &&
          m.value - last <= skip &&
          keys.slice(0, i).every((k) => {
            const c = markers.get(k);
            return !(c.kind === 'folio' && c.plain && c.value > last && c.value < m.value);
          }));
    } else {
      // a bare folio: the Cave's own test, and the neighbours must agree
      ok =
        (last !== null && m.value === last + 1) ||
        (last === null && next !== null && m.value === next - 1);
    }
    if (ok) {
      m.page = m.value;
      m.how = m.kind === 'head' ? 'head' : 'folio';
      last = m.value;
    } else {
      m.page = null;
      m.how = 'refused';
    }
  }
  return markers;
}

/** A section's title: the section's OWN opening words, capped (eight words by
 * default — the cap is per-text where the openings need more to differ, see
 * `extract`) and cut at the earliest punctuation boundary inside the cap,
 * ellipsised. Neither the 1917 print nor the 1816 volume prints a contents
 * page (MEASURED: nothing between the title page and the first division), so
 * the table of contents is generated apparatus and the title is honestly
 * derived from the text, not taken from the edition. */
export function sectionTitle(text, cap = 8, stopAtPunctuation = true) {
  const words = text.split(' ').filter((w) => w !== '');
  const max = Math.min(words.length, cap);
  let cut = max;
  /* THE PUNCTUATION STOP IS PER-TEXT (`titleStop`), not universal. It makes a
   * title the shortest natural phrase where the print's openers ARE sentences
   * (the Cave's `1. What does Homer…`) — but a text whose chapters open with a
   * discourse connective is collapsed by it: Taylor's 1816 Theology opens
   * THIRTEEN of its 215 divisions with 'In the next place, let us …', and the
   * stop gives all thirteen the one title 'In the next place' at EVERY cap
   * (MEASURED: 202 distinct titles at each of 8, 10, 12, 15, 20, 30 and 50).
   * Where the text declares `titleStop: 'cap'`, the cap alone cuts the title and
   * the contents list distinguishes its divisions again. */
  if (stopAtPunctuation) {
    for (let i = 2; i < max; i++) {
      if (/[,.;:?!]$/.test(words[i])) {
        cut = i + 1;
        break;
      }
    }
  }
  const title = words.slice(0, cut).join(' ').replace(/[,.;:?!]+$/, '');
  return words.length > cut ? `${title}…` : title;
}

/** The characters a transcription uses where the print has a letter or a mark the
 * scan could not carry. THE SET IS NOT DECLARED HERE: it is the base policy's
 * (`tools/edits/_base.json`) `damage` list, which was MEASURED on the
 * transcription rather than guessed — every character standing inside a
 * letter-bearing token that a 1917 print cannot set inside a word. The policy is
 * the one place the set is stated, so the census, the reading view's marking and
 * the rules' own validation cannot disagree about what damage is.
 *
 * MEASURED on this edition: `^ _ ~ * / £ > \ | # ™ ± » « } { &` — and the
 * characters a print DOES set inside a word (the full stop of an abbreviation,
 * the apostrophe of a contraction, a comma, a dash) are excluded, because marking
 * one of those as damage would be a false claim in the reading view. The base
 * file carries the counts and the excluded set. */
let damageRe = null;
/* THE DAMAGE SET, and WHICH EDITION'S. The base policy's set is MEASURED — on the
 * Cave's 1917 transcription — and the policy states that it is measured, not
 * guessed. A SECOND EDITION measures its own: the 1816 Proclus prints `*` as a
 * FOOTNOTE MARKER (the transcription glues it to the word: `four*`, `light*`) and
 * `&` as an ordinary ampersand (`&c.`), so neither is damage there, though both
 * belong to the base set. A text therefore declares what its print sets, and the
 * effective set is the base's minus that declaration. The default is the base set
 * exactly, so every existing caller is unchanged. */
const damageReCache = new Map();
function damageRegex(set) {
  // a string or a list — the base policy carries both forms (`damage`, `damageList`)
  // and a caller may hold either
  const chars = (Array.isArray(set) ? set.join('') : set) || loadBasePolicy().damage;
  if (!damageReCache.has(chars)) {
    const inClass = chars.replace(/[\\\]^$.*+?()[{|]/g, '\\$&');
    damageReCache.set(chars, new RegExp(`[${inClass}]`));
  }
  return damageReCache.get(chars);
}

/** A word of the transcription that carries a character the census marks as
 * damage: a word whose letters were lost. A reader cannot tell such a word from
 * an English one, and the reading view either shows the recorded reading for it
 * or shows it as the transcription has it (marker and all). A word that mixes
 * letters with digits is the census's other damaged class: no character can be
 * removed from it without inventing a letter or leaving one. */
export function wordDamaged(word, damageSet) {
  const bare = word
    .replace(/^[.,;:?!()"'\u201c\u201d\[]+/, '')
    .replace(/[.,;:?!()"\u201c\u201d\]|\\]+$/, '');
  if (bare === '' || !/[A-Za-z]/.test(bare)) return false;
  return damageRegex(damageSet).test(bare) || /[A-Za-z]\d|\d[A-Za-z]/.test(bare);
}

/** Cut a section title down to the words the cap keeps, before ellipsising — so a
 * damage test can be asked about exactly the words the title SHOWS, not about the
 * opening words it did not use. */
function titleWords(text) {
  return sectionTitle(text).replace(/…$/, '').split(' ').filter((w) => w !== '');
}

/**
 * Is a derived title still damaged AFTER the rules have been applied?
 *
 * The answer has to distinguish two things a naive census does not: a word whose
 * damage a rule READS — the section-11 opener `n.^Tb,eologists` → `11.
 * Theologists` is a rule that states what the print says, and the title it
 * produces is readable — from a word whose damage a rule only STRIPS. So a word
 * counts as still damaged when the census marks it and NO reading rule (any class
 * other than `ocr`) touches it. Words that would remain damaged after every rule
 * has run are counted too, so the test cannot be defeated by a rule that strips a
 * marked character and leaves one behind.
 *
 * MEASURED on this edition: sections 2 and 9 are still damaged (`Thpanrt'p'rii'c:`
 * and `ajgyejbpjthe` for §2, `rpmntq` for §9); section 11 is repaired by its
 * opener rule and is not flagged. A title is never invented to hide either case.
 */
export function titleDamage(rawTitle, correctedTitle, rules) {
  const readings = rules.filter((r) => r.cls !== 'review');
  const stripped = titleWords(rawTitle).filter(
    (w) => wordDamaged(w) && !readings.some((r) => r.find === w || w.includes(r.find)),
  );
  // NOT `.filter(wordDamaged)` — Array.filter passes the INDEX as the callback's
  // second argument, which is now wordDamaged's `damageSet` (MEASURED: it threw
  // "chars.replace is not a function" the moment the set became a parameter).
  const left = titleWords(correctedTitle).filter((w) => wordDamaged(w));
  return { damaged: stripped.length > 0 || left.length > 0, words: [...new Set([...stripped, ...left])] };
}

/** The text of the FRONT-MATTER REGION: the block run between the front mark and
 * the body's first division, plus the library's leading stamp (served in its own
 * region, and front matter by any reading). */
export function frontMatterText(doc) {
  const body = doc.blocks.findIndex((b) => b.t === 'region' && b.kind === 'body');
  const from = doc.blocks.findIndex((b) => b.t === 'region' && b.kind === 'front');
  return [
    ...(doc.dropped || []).map((d) => d.x),
    ...doc.blocks.slice(from, body < 0 ? doc.blocks.length : body).map((b) => b.x || ''),
  ].join(' ');
}

/**
 * THE POLICY'S ONE EXCEPTION (plan §7), as an assertion that can fail.
 *
 * The title page's "From the Greeh of Porphyry" is CITED AS EVIDENCE by the
 * reading itself (content/porphyry-cave-of-the-nymphs.md): the reading's argument
 * rests on the print's spoiled reading, so a rule that repaired it in the served
 * text would destroy the evidence it points at. The transcription view preserves
 * it by construction — and NO rule may touch the front-matter region at all. A
 * rule added later that reaches into the title page fails here rather than
 * silently repairing the evidence.
 *
 * THE REGION ADMITS ONE TYPE, and one only (2026-10-06, the Greek pass): a rule
 * whose `type` is `transliteration` — Greek restored from the page image, the type
 * §4.1 rule 1 fixes — restores what the PRINT sets rather than emending the front
 * matter's English, which is the thing the refusal above exists to stop. Every
 * other type is refused there exactly as before.
 *
 * WHAT THAT ADMISSION ACTUALLY LETS IN, MEASURED (2026-10-06, before the commit):
 * 68 of this edition's rules stand in the region, and they change it by +1,455
 * Greek characters and by 1,317 ASCII letters — 1,299 REMOVED and 18 ADDED. The
 * removed 1,299 are the OCR-damage Latin the Greek replaced (the print sets Greek
 * there, which is why rule 1 types these rules at all). The added 18 stand in nine
 * rules and are English the same page image settled INSIDE the same span — a
 * spelling ("dianoelic" -> "dianoetic"), a small-caps head-word, a Roman numeral.
 * A rule's span is the whole damaged run the reader settled, not the Greek
 * fragment inside it, so this exception does not (and this comment may not claim
 * it does) forbid the page's own reading of a span that carries both. What it
 * refuses is a rule of ANOTHER TYPE standing there: an OCR, punctuation or
 * conjectural emendation, which is what the refusal above is for.
 *
 * THE TYPE IS NOT IN THE READER VIEW. The served `corrections` array is
 * `{find, repl, cls, note, action}` (model §4.0), and adding a key to it would
 * change every served document's bytes — the parity gate of plan §6 is the record
 * of that. So the canonical `type` travels BESIDE the view, in the map `loadEdits`
 * returns (`meta.types`) and the extractor passes here. A caller that passes NO map
 * gets no exception at all: the refusal is the default, so a document checked
 * without its rules' types is checked as strictly as it was before this exception
 * existed.
 */
export const FRONT_MATTER_TYPES = Object.freeze(['transliteration']);

export function checkFrontMatter(doc, ruleTypes = null) {
  const front = frontMatterText(doc);
  const typeOf = (c) => (ruleTypes instanceof Map ? ruleTypes.get(c.find) : ruleTypes ? ruleTypes[c.find] : null) || null;
  const into = (doc.corrections || []).filter(
    (c) => c.find && front.includes(c.find) && !FRONT_MATTER_TYPES.includes(typeOf(c)),
  );
  if (into.length) {
    throw new Error(
      `library: ${doc.slug}: ${into.length} correction rule(s) match inside the front-matter region without being a ` +
        `Greek restoration — the front matter is the print's title page, and one of its readings is cited as ` +
        `evidence by a reading that uses this text:\n` +
        into.map((c) => `  ${c.cls}  ${JSON.stringify(c.find)}`).join('\n') +
        `\n  The front matter is preserved by construction: no rule may touch it whose type is not ` +
        `${FRONT_MATTER_TYPES.join(', ')} (a Greek reading taken from the page image — plan §7, model §4.1).`,
    );
  }
  return front;
}

/**
 * THE LEAF MODEL, ALIGNED TO THIS EDITION (phase 4, plan §4.6).
 *
 * The derived artifact gives each leaf the index of its first line in the line
 * stream of the edition it was derived against. This checks that the alignment
 * still holds — the edition's byte length is checked by `loadDerivs`, and here its
 * line stream is checked leaf by leaf: the leaves must TILE the stream (no gap, no
 * overlap) and every leaf's recorded first line must BE the line at that index.
 * Any of those failing means the boundary positions are wrong, which is a failure
 * the build must not paper over: it throws, and it says which leaf is out of step.
 */
function alignLeaves(sig, model, meta) {
  if (!model.leaves || !model.totals) {
    throw new Error(`library: ${meta.entry.slug}: the derived page model has no leaf table — it is not one`);
  }
  if (model.edition && meta.sha256 && model.edition.sha256 !== meta.sha256) {
    throw new Error(
      `library: ${meta.entry.slug}: the derived page model was built from other bytes than this edition\n` +
        `  Make a new one deliberately: node tools/derive.mjs ${meta.entry.slug}`,
    );
  }
  const flat = sig.flat;
  if (model.totals.lines !== flat.length) {
    throw new Error(
      `library: ${meta.entry.slug}: the derived page model indexes ${model.totals.lines} line(s) and this edition has ` +
        `${flat.length} — the model was derived against another edition, and its leaf boundaries point at lines that ` +
        `are not these lines:\n  node tools/derive.mjs ${meta.entry.slug}`,
    );
  }
  let at = 0;
  const byLeaf = new Map();
  const lineLeaf = [];
  for (const lf of model.leaves) {
    if (lf.start !== at) {
      throw new Error(
        `library: ${meta.entry.slug}: the leaf model does not tile the edition — leaf ${lf.leaf} starts at line ` +
          `${lf.start} where the leaves before it end at ${at}:\n  node tools/derive.mjs ${meta.entry.slug}`,
      );
    }
    byLeaf.set(lf.leaf, lf);
    for (let i = 0; i < lf.lines; i++) lineLeaf[lf.start + i] = lf.leaf;
    if (lf.lines > 0 && flat[lf.start] !== lf.head) {
      throw new Error(
        `library: ${meta.entry.slug}: leaf ${lf.leaf}'s boundary does not land where the model says — the model's ` +
          `first line for it is ${JSON.stringify(lf.head)} and this edition's line ${lf.start} is ` +
          `${JSON.stringify(flat[lf.start])}:\n  node tools/derive.mjs ${meta.entry.slug}`,
      );
    }
    at += lf.lines;
  }
  if (at !== flat.length) {
    throw new Error(
      `library: ${meta.entry.slug}: the leaf model covers ${at} of the edition's ${flat.length} line(s):\n` +
        `  node tools/derive.mjs ${meta.entry.slug}`,
    );
  }
  return { model, byLeaf, lineLeaf, keyAt: sig.markerKeyAt, span: model.totals.span };
}

/**
 * THE THREE SIGNALS, RECONCILED (plan §4.2), and every disagreement reported.
 *
 *  1. the item's own page-number pass, per leaf (in the derived artifact);
 *  2. the LEAF a marker in the text stands on, measured by aligning the two line
 *     streams — this is what makes a page boundary structural rather than inferred;
 *  3. the transcription's own running heads and bare folios (read above).
 *
 * The third signal decides what is SERVED: a number no source read is never
 * invented. The second decides two things the text alone cannot:
 *
 *   - a marker the ±1 stride rule of `reconcile` REFUSED is re-read when its own
 *     reading is the page its leaf carries. The stride rule refuses a marker whose
 *     neighbours do not supply the step; a leaf supplies the step by construction,
 *     and where the two agree the refusal was arithmetic about a missing marker,
 *     not a disagreement about the print. (MEASURED on this volume: the folio "43"
 *     at the foot of leaf 49, refused because leaf 48 is blank in the
 *     transcription and carries no marker for page 42.)
 *   - a leaf boundary the transcription does not mark AT ALL gets a marker that
 *     carries its leaf and NO page number. It is emitted with `how: "leaf"`, which
 *     is exactly what it is: a page boundary established structurally, whose
 *     printed number could not be read.
 *
 * Nothing is merged silently: every case above and every marker that does not
 * stand at its leaf's own first line goes into the document's `findings`.
 */
function applyLeaves(markers, leaves, findings) {
  const ordered = [...markers.values()].sort((a, b) => a.at - b.at);
  for (const m of ordered) {
    m.leaf = m.at < leaves.lineLeaf.length ? leaves.lineLeaf[m.at] ?? null : null;
    const lf = m.leaf == null ? null : leaves.byLeaf.get(m.leaf);
    if (!lf) continue;
    m.leafAt = m.at - lf.start;
    if (m.value == null || m.page != null) continue;
    if (lf.page == null || lf.page !== m.value) continue;
    m.page = lf.page;
    m.how = m.kind === 'head' ? 'head' : 'folio';
    m.reRead = true;
    findings.push(
      `page ${m.page}: the transcription reads ${JSON.stringify(m.raw)} at line ${m.leafAt + 1} of ${lf.lines} of ` +
        `leaf ${lf.leaf} — the leaf's own page — and the ±1 stride rule had refused it because the marker before it ` +
        `is not the page before it. The leaf supplies the step the text alone could not, so the reading stands.`,
    );
  }
  for (const m of ordered) {
    if (m.leafAt === undefined || m.leafAt === 0) continue;
    const lf = leaves.byLeaf.get(m.leaf);
    const where =
      `stands at line ${m.leafAt + 1} of ${lf.lines} of leaf ${lf.leaf} — the foot of the leaf — ` +
      `and not at its first line`;
    findings.push(
      m.page == null
        ? `a page marker (${JSON.stringify(m.raw)}) ${where}. Its leaf's own head reads page ${lf.page}, ` +
          `so this is a second, damaged reading of a folio the leaf already has, and it is refused.`
        : `page ${m.page} (${JSON.stringify(m.raw)}) ${where}, which is where this volume prints the folio of a ` +
          `page whose division opens on it; the leaf is that page, so the reading stands where it is printed.`,
    );
  }
  /* 3. The leaf boundaries the transcription carries no marker for at all. Only
   * the numbered span: outside it the model has no page to place, and a boundary
   * marker with nothing on either side of it is furniture of our own making. */
  const accepted = ordered.filter((m) => m.page != null && m.leaf != null);
  if (!accepted.length) return;
  const lo = Math.min(...accepted.map((m) => m.leaf));
  const hi = Math.max(...accepted.map((m) => m.leaf));
  const marked = new Set(ordered.map((m) => m.leaf).filter((n) => n != null));
  for (const lf of leaves.model.leaves) {
    if (lf.leaf < lo || lf.leaf > hi || lf.lines === 0 || marked.has(lf.leaf)) continue;
    const key = leaves.keyAt(lf.start);
    if (!key) continue;
    markers.set(key, {
      kind: 'leaf',
      raw: null,
      value: null,
      page: null,
      how: 'leaf',
      at: lf.start,
      leaf: lf.leaf,
      leafAt: 0,
    });
    marked.add(lf.leaf);
    findings.push(
      `leaf ${lf.leaf}: the transcription carries no running head for this leaf at all, and nothing on it reads as ` +
        `a page number, so the boundary stands here UNNUMBERED` +
        (lf.page == null
          ? ' (the leaf index has no number for it either)'
          : ` (the leaf index fills in ${lf.page} from the leaves around it, which is a number nothing on the leaf ` +
            `reads, and it is NOT served as one)`) +
        `.`,
    );
  }
}

/* ---------- the transcription's punctuation spacing ---------- */

/** THE OCR SPLIT PUNCTUATION OFF AS ITS OWN WORD. The transcription puts a space
 * before a closing mark ("in native marble shine ;") and after an opening quote
 * ('" High at the head'), because the scanner's word segmentation treated the mark
 * as a token. The PRINT sets them tight — English never sets a space before `;`,
 * and never between a quote and the word it opens — and MEASURED, the artifacts
 * are systematic: ` ;` 110 times, an opening quote + space 41 times, a closing
 * quote with a space before it 11 times.
 *
 * This is a WHITESPACE normalization, not a reading: no character of the print is
 * in question, only the spaces the scan left around marks the print sets tight. It
 * belongs with the collapsing of the scan's column-padding runs (collapseLine),
 * which is why it is applied here and not as 150 rules — and it is applied to the
 * block text BOTH views read, so the reading view and the "as scanned" view agree
 * about the print's own spacing.
 *
 * The two quote cases need context, which is why this is a pass and not a
 * find/replace rule: an opening quote may legitimately have a space BEFORE it
 * ("says, \"The island") and a closing quote a space AFTER it ("end.\" This"),
 * so only the space on the wrong side of each is removed. */
export function tidyPunctuation(s) {
  return s
    // no space before a closing mark. NOT the full stop: a SPACED ellipsis
    // (`. . .`) is a print convention, and the one stray ' .' this edition has is
    // already a recorded reading. So the set is the marks that are never spaced.
    .replace(/ +([,;:!?])/g, '$1')
    // no space after an OPENING quote: the quote stands at a word boundary (start,
    // whitespace, an opening bracket or a dash) and the space is INSIDE it
    .replace(/(^|[\s([\u2014-])(["\u201c\u2018]) (?=\S)/g, '$1$2')
    // no space before a CLOSING quote: the quote follows a word or a closing mark
    // and does NOT open a word (so a quote before a letter is left alone)
    .replace(/([\w.,;:!?)\]]) +(["\u201d\u2019])(?![A-Za-z])/g, '$1$2');
}

/**
 * Extract one stored edition into the served document (plan §4.1).
 *
 * `meta` is the shelf entry (`{slug, lang, item}`) plus the sha256 of the
 * transcription this document was built from. The return value is exactly the
 * document that is emitted at `/library/<slug>/t`.
 *
 * A LEAF-ACCURATE PAGE MODEL IS USED WHEN THE REPO STORES ONE (phase 4, §4.6):
 * `meta.derivs` is the model (or `null` to read the text without it, which is
 * what the diff between the two modes is made of). When it is absent the stored
 * artifact is loaded if there is one, and when there is none the document is the
 * txt-mode one: the shelf's other texts have no derivatives, and a text whose page
 * model rests only on its own running heads is honest, just less accurate.
 */
export function extract(src, meta) {
  const entry = meta.entry;
  const cfg = TEXT_RULES[entry.slug] || {};
  /* THE OPENER SHAPE is a property of the text (OPENER_SPECS): the Cave's own
   * divisions are a bare arabic numeral on the line that carries the section's
   * first words; the 1816 Proclus prints `PROPOSITION <roman>.` on a line of
   * its own. The same regex/read pair serves both, so a third numbering is data
   * rather than a fork in the extraction. */
  const OPENER = OPENER_SPECS[cfg.opener || 'arabic'];
  if (!OPENER) {
    throw new Error(
      `library: ${entry.slug}: the opener spec "${cfg.opener}" is not one of ${Object.keys(OPENER_SPECS).join(', ')} — ` +
        `a text's division numbering must name a shape the extraction can read`,
    );
  }
  /* THE RECORDED DIVISIONS (§3.2), when the edition has them: the model beside
   * the edition, verified against this transcription's own bytes, indexed by the
   * line each division OPENS on. The index is the one the emission pass and the
   * page model already share (a line of the edition as `pageSignals` counts them),
   * so a division and a leaf boundary name the same coordinate. A recorded line
   * that falls on no line carrying text, or whose text is not what the model
   * recorded, is a stale model and is refused rather than opened at a guess. */
  const divisionModel = cfg.divisionModel ? loadDivisions(entry.slug, meta.sha256, meta.version) : null;
  if (cfg.divisionModel && !divisionModel) {
    throw new Error(
      `library: ${entry.slug}: this edition's divisions are recorded (a ${JSON.stringify(String(cfg.opener))} opener) ` +
        `and its model is missing (${divisionsPath(entry.slug, meta.version)}) — the divisions were read off the scans and are not ` +
        `recoverable from the transcription:\n  node tools/divisions.mjs ${entry.slug}`,
    );
  }
  let divisionAt = null;
  if (divisionModel) {
    // the edition's lines as `pageSignals` counts them: the lines that carry text,
    // in order (a blank line is not a line a division can stand on)
    const raw = src.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
    const flatOfRaw = [];
    let f = 0;
    for (let i = 0; i < raw.length; i++) flatOfRaw[i] = collapseLine(raw[i]) !== '' ? f++ : -1;
    divisionAt = new Map();
    for (const d of divisionModel.divisions) {
      const at = flatOfRaw[d.line - 1];
      if (at == null || at < 0) {
        throw new Error(
          `library: ${entry.slug}: division ${d.n} is recorded at line ${d.line} of the transcription, whose text ` +
            `does not exist (it is blank or past the end) — the recorded model was made against other bytes`,
        );
      }
      if (divisionAt.has(at)) {
        throw new Error(`library: ${entry.slug}: two recorded divisions open on the same line (${d.line})`);
      }
      divisionAt.set(at, d);
    }
  }
  /* The rules come from the CANONICAL repairs.json of the version being
   * extracted (model §4.3), not from a second copy in tools/edits/ and not from
   * this module, and the whole list is loaded before anything is read: the
   * extraction NEEDS the `opener` class to find a section at all, and the
   * document ships every rule to the reading view. The list's order is the
   * file's order (plan §7). `meta.version` selects the version; absent it, the
   * edition's `current_version` is the one a bare URL serves. */
  const { edits, meta: ruleMeta } = loadEdits(entry.slug, meta.version);
  const openers = edits.filter((c) => c.cls === 'opener');

  /* THE DAMAGE SET THIS EDITION MEASURES — the version's own, read from the
   * canonical record (model §4.3: the reader marks a character of this set), and
   * cross-checked in `loadEdits` against the base policy minus what the text
   * declares its own print sets (TEXT_RULES `damageExclude`). The base set was
   * measured on the Cave; the 1816 Proclus prints `*` as a footnote marker and `&`
   * as an ampersand, so neither is damage there. Threaded through every census and
   * shipped in the document, so the reader marks exactly what THIS edition's damage
   * is. */
  const damageExclude = cfg.damageExclude || [];
  const damage =
    ruleMeta && ruleMeta.damage
      ? ruleMeta.damage.join('')
      : loadBasePolicy().damageList.filter((c) => !damageExclude.includes(c)).join('');
  if (damageExclude.length && damage === loadBasePolicy().damage) {
    throw new Error(`library: ${entry.slug}: damageExclude names no character of the base damage set`);
  }

  /* 1. The library's stamp is not text (plan §4.5): recorded, then dropped. */
  const sig = pageSignals(src, entry);
  const { lines, markers, junk, dropped } = sig;

  /* 1b. THE BOOK-OPENING HEADINGS, CARVED OUT OF THE JUNK. The volume prints
   * each book's opening page with the display headings `BOOK n.` and
   * `CHAPTER I.` above the chapter's first line, and the verso running head
   * `ON THE THEOLOGY BOOK n.` on the same page — so a book opening can carry
   * the BOOK shape twice: once as the running head (furniture) and once as the
   * book's own heading (text). MEASURED on the scans (the vision pass reads
   * the book-opening leaves' headings as `BOOK n.` above `CHAPTER I.`), the
   * display heading is the BOOK line standing immediately above the
   * `CHAPTER I.` line that belongs to a chapter-1 division; it is spared. A
   * BOOK line standing AT a division's own line would be a heading too, and
   * MEASURED none does: the divisions open on the chapter's first line of
   * text, below the heading. Seven display headings are spared (one per
   * book); the other 256 BOOK lines are running heads the classifier takes. */
  if (divisionAt) {
    for (const [index, div] of divisionAt) {
      if (div.chapter !== 1) continue;
      let heading = -1;
      for (let k = index - 1; k >= Math.max(0, index - 40); k--) {
        if (CHAPTER_ONE_LINE.test(sig.flat[k])) {
          heading = k;
          break;
        }
      }
      if (heading < 0) continue;
      for (let k = heading - 1; k >= Math.max(0, heading - 4); k--) {
        if (sig.flat[k].length <= 12 && BOOK_HEAD_LINE.test(sig.flat[k])) {
          const key = sig.markerKeyAt(k);
          if (key) junk.delete(key);
          break;
        }
      }
    }
  }

  /* 1c. THE CARVE-OUT FOR THE REST OF THE CLASSIFIER — the lines the shapes
   * above take that are the BOOK'S OWN TEXT, spared from the junk set. The
   * chapter line's shape cannot tell a running head from a display heading
   * or a contents entry (they are the same words), so the decision is made
   * on EVIDENCE, the line's own position:
   *   - in the front matter, every chapter line is the contents list's own
   *     entry (or its footnote 'cap. 7.') — the print's contents, text. The
   *     front matter's running heads are 'INTRODUCTION.' / 'CONTENTS.' and
   *     the foot 'Proc.', never a chapter line (MEASURED: 0 of the 225);
   *   - in the body, a chapter line is a DISPLAY HEADING when it opens the
   *     chapter's text: the next line, past the scan's debris, is prose, and
   *     it stands at a chapter opening — after the page's head (the previous
   *     chapter's tail is prose above it), or with the running head above it
   *     in the same page head, or immediately above the division's own line,
   *     or on a page that carries no recto head at all (a verso page has no
   *     'CHAP. n.' running head). MEASURED: 215 display headings so spared —
   *     one per recorded division — each followed immediately by the
   *     chapter's first line, and each one's nearest division's recorded
   *     evidence reading a CHAPTER heading off the scan, or the opening
   *     verified on the leaf (the divisions the vision pass missed: 13, of
   *     which the model itself sits late — division 11 four pages, 22 and
   *     103 one page — and book IV chapter VI, which the print numbers but
   *     the model does not record). The 354 running heads the shape takes
   *     stand in page heads and are suppressed: 341 of them with a watermark
   *     above and the recto head's 'OF PLATO.' beside them, 13 with the whole
   *     recto head glued on the one line;
   *   - the foot's 'VOL. I.' stands at a page foot (a watermark below it);
   *     the title pages' own volume statements ('VOL. I.' under 'TWO
   *     VOLUMES.') are text and are spared (MEASURED: 2, one per volume's
   *     title page);
   *   - the contents section's display heading, split over lines as
   *     'CONTENTS' / 'OF' / 'THE CHAPTERS OF BOOK I.', is text and is spared
   *     (MEASURED: 1);
   *   - any furniture line a REPAIR RULE is defined over is spared, so the
   *     rule keeps firing (MEASURED: 4 under the current version's rules —
   *     three signature lines, two fused into a printer-broken word and one
   *     served tidied, plus one whole-head line served tidied; the 1.0.0
   *     rule list predates the whole-head rule, so 3 there; the served text
   *     at those spots stays byte-identical to the previous build's).
   * Guarded by the classifier key: these clauses are the 'theology-1816'
   * classifier's companion, and the other editions' furniture is not shaped
   * like this volume's. MEASURED over every line of the slice, under the
   * current version's rule list: 454 lines spared (225 contents entries,
   * 215 display headings, 7 book display headings, 2 title-page volume
   * statements, 1 contents display heading, 4 furniture lines a repair rule
   * is defined over; the 1.0.0 rule list predates the whole-head rule and
   * spares 453 there), 2,506 suppressed, and no line of the book's own
   * text among the suppressions (the title page's lines, the contents'
   * display headings, the glossary's entries, the footnotes that begin with
   * a chap-like or proc-like word, and 'END OF VOL. I.' are all spared or
   * never taken). */
  if (divisionAt && cfg.furnitureHead === 'theology-1816') {
    const flat = sig.flat;
    const divLines = [...divisionAt.keys()].sort((a, b) => a - b);
    const bodyStart = divLines[0];
    /* the next line past the scan's debris (the shape of `isFurnitureJunk`) */
    const nextText = (i) => {
      for (let k = i + 1; k <= Math.min(flat.length - 1, i + 2); k++) {
        if (isFurnitureJunk(flat[k])) continue;
        return k;
      }
      return -1;
    };
    /* a chapter line is a display heading when it opens the chapter's text */
    const isDisplayHeading = (i) => {
      const line = flat[i];
      /* the whole recto head glued on one line ('CHAP. XXVI. OF PLATO. 81')
       * is a running head: a display heading is never longer than the longest
       * chapter number the print sets (MEASURED: headings run to 16
       * characters, whole-head lines from 21) */
      if (line.trim().length > 18) return false;
      const nx = nextText(i);
      if (nx < 0 || !isProseLine(flat[nx])) return false;
      /* the page head above: from the page's watermark down to the first
       * prose line — the running head and the recto head's 'OF PLATO.' live
       * there, a display heading does not */
      let wm = -1;
      for (let k = i; k >= Math.max(0, i - 40); k--) {
        if (isGoogleStampLine(flat[k])) {
          wm = k;
          break;
        }
      }
      let proseAbove = false;
      let platoAbove = false;
      let chapAbove = 0;
      if (wm >= 0) {
        for (let k = wm + 1; k < i; k++) {
          if (isProseLine(flat[k])) {
            proseAbove = true;
            break;
          }
          if (isPlatoHeadLine(flat[k])) platoAbove = true;
          if (isChapHeadLine(flat[k])) chapAbove++;
        }
      }
      if (proseAbove) return true; // a mid-page opening: the previous chapter's tail is above
      if (chapAbove > 0) return true; // a page-top opening: the running head stands above
      let distBelow = Infinity;
      let distAbove = -1;
      for (const at of divLines) {
        if (at > i) {
          distBelow = at - i;
          break;
        }
      }
      for (let k = divLines.length - 1; k >= 0; k--) {
        if (divLines[k] <= i) {
          distAbove = i - divLines[k];
          break;
        }
      }
      if (distBelow <= 2) return true; // immediately above the division's own line
      if (wm >= 0 && !platoAbove) return true; // a verso page: no 'CHAP. n.' running head exists on it
      return distAbove <= 25; // the division recorded within the page (MEASURED: the model's own late records)
    };
    /* the title pages' volume statements are not at a page foot */
    const atPageFoot = (i) => {
      for (let k = i + 1; k <= Math.min(flat.length - 1, i + 4); k++) {
        if (isGoogleStampLine(flat[k])) return true;
      }
      return false;
    };
    /* the contents section's display heading, split over lines */
    const isContentsDisplay = (i) => {
      if (/[^A-Za-z]/.test(flat[i].trim())) return false;
      for (let k = i + 1; k <= Math.min(flat.length - 1, i + 2); k++) {
        if (/^the chapters of book/i.test(flat[k].trim())) return true;
      }
      return false;
    };
    /* A FURNITURE LINE A REPAIR RULE IS DEFINED OVER — spared, so the rule
     * keeps firing. The rules in repairs.json are written against the SERVED
     * text (a rule that matches nothing fails the build, checkEdits), and
     * MEASURED four of them are defined over a furniture line kept in its
     * block, so that the find can form at all:
     *   - three SIGNATURES at a page foot: two FUSIONS — the printer broke a
     *     word across the page and the signature stands inside the break
     *     ('sub-Proc. Vol. I. S' is the word 'subjects' broken as 'sub-' +
     *     'jects,' with the signature fused into the break, r8783;
     *     'attri-Proc. Vol. I, 2 E' likewise, r8654) — where joinLines glues
     *     the kept line to the fragment above; and one TIDIED signature
     *     (the raw 'Proc , Vol. JI. Z' served tidied as 'Proc, Vol. JI. Z',
     *     r8989) — the find is the line's tidied form, and the transcription
     *     view serves the raw line;
     *   - one WHOLE-HEAD line under the current version's rule list (r11642:
     *     the raw 'CHAP, xyi. :OF.PM,TO. 137' served tidied as 'CHAP,
     *     xyi.:OF.PM,TO. 137', the find a substring of the tidied form). The
     *     1.0.0 rule list predates that rule, so there the line stays
     *     suppressed and the version's document differs at this one spot.
     * The test is the rule's own find, read against the block's served text
     * both ways: the find must be present with the line kept, and absent
     * both from the block without the line and from the raw line alone (a
     * rule written over the RAW line — a bare 'Proc. Vol. II. O' — fires on
     * the `rh` block the suppression serves, so its line stays suppressed).
     * MEASURED: exactly these lines are spared — four under the current
     * version's rules, three under 1.0.0's — and with them spared the served
     * text at those spots is byte-identical to the previous build's: the
     * rules fire as they did, nothing is re-broken. */
    const furnitureARepairRuleNeeds = (key, i) => {
      const [bi, li] = String(key).split(':').map(Number);
      const block = sig.lines[bi];
      if (!block || !Number.isInteger(li) || li < 0 || li >= block.length) return false;
      const withLine = tidyPunctuation(joinLines(block));
      const without = tidyPunctuation(joinLines(block.filter((_, k) => k !== li)));
      const raw = flat[i];
      for (const c of edits) {
        if (withLine.includes(c.find) && !without.includes(c.find) && !raw.includes(c.find)) return true;
      }
      return false;
    };
    for (let i = 0; i < flat.length; i++) {
      const key = sig.markerKeyAt(i);
      if (!key || !junk.has(key)) continue;
      const line = flat[i];
      if (isChapHeadLine(line)) {
        if (i < bodyStart || isDisplayHeading(i)) {
          junk.delete(key);
          continue;
        }
      } else if (isVolFootLine(line)) {
        if (!atPageFoot(i)) {
          junk.delete(key);
          continue;
        }
      } else if (isIntroContentsLine(line)) {
        if (isContentsDisplay(i)) {
          junk.delete(key);
          continue;
        }
      }
      /* ANY furniture line a repair rule is defined over is spared, so the
       * rule keeps firing (see the helper's comment) — whichever class the
       * line belongs to, and whichever version's rule list is loaded. */
      if (furnitureARepairRuleNeeds(key, i)) junk.delete(key);
    }
  }

  /* 2. Page furniture, consumed before anything is read as a heading (§4.2).
   * `reconcile` has already given every marker the page the TRANSCRIPTION's own
   * readings support; step 2b then reads the leaves. */
  const leafModel = meta.derivs !== undefined ? meta.derivs : meta.leaf === false ? null : loadDerivs(entry.slug, meta.sha256);
  const leaves = leafModel ? alignLeaves(sig, leafModel, meta) : null;
  const pageFindings = [];
  if (leaves) applyLeaves(markers, leaves, pageFindings);

  /* 3. The document, in one pass over the lines. */
  const out = [];
  const findings = [];
  const refs = [];
  const defs = [];
  let region = 'front';
  let cur = null;
  let curNote = null;
  let par = 0;
  let secN = 0;
  // THE ANCHOR EACH OPENED SECTION IS SERVED UNDER, BY ITS ORDINAL. A recorded
  // division carries its own `anchor` — the name citations hold — and the
  // ordinal is only the walk's position, so the id a citation names is READ
  // from the model, not derived from the count: an inserted division shifts
  // the ordinals after it and must not move one anchor that already served.
  // Where no model stands behind a section (the opener walk), the ordinal IS
  // the anchor, exactly as served today.
  const secAnchor = new Map();
  let expectedSec = 1;
  let expectedNote = 1;
  let expectedRef = 1;

  const push = (b) => out.push(b);
  /* THE LIBRARY'S OWN STAMP, AT THE FRONT — a REGION now, like the library's
   * marks at the BACK. It used to be recorded and DROPPED (plan §4.5: "the
   * stamp is not text ... never served"), which made the two ends disagree: the
   * back's marks were served (they were swept into the back region and split out
   * as `library`), the front's were not. They are the same thing — this copy's
   * own call number, at both ends — so they are treated the same: SERVED, so the
   * transcription is whole; MARKED `library`, so they are not read as the book;
   * and excluded from search and the meter, like the rest of the apparatus.
   *
   * NOTHING IS DROPPED FROM THE TRANSCRIPTION ANY MORE, which is also why the
   * extractor's smoke asserts the document's text against the WHOLE file. */
  if (dropped.length) {
    push({ t: 'region', kind: 'library' });
    for (const line of dropped) push({ t: 'p', x: tidyPunctuation(line) });
  }
  // the front matter: the book's own front, served but marked (§4.5). Its
  // fragment anchor (#sfront) is part of the reserved grammar.
  push({ t: 'region', kind: 'front', id: 'sfront' });
  const flush = () => {
    if (!cur || cur.lines.length === 0) {
      cur = null;
      return;
    }
    emitText(cur);
    cur = null;
  };
  const start = (kind, line, { sameParagraph }) => {
    if (!sameParagraph) par++;
    // `sec` runs on past the body (secN is only bumped by an opener), so a block
    // must carry whether it is IN the body: the notes and back-matter regions were
    // claiming section-18 paragraph anchors, which would have made a #s18-77
    // citation land on a catalogue blurb.
    cur = { kind, lines: [line], par, sec: secN, inBody: region === 'body' };
  };

  /** Emit a joined text block, with its note references as `ref` blocks. */
  function emitText(block) {
    const note = block.note || null;
    // a note's own paragraphs are the note, quoted or not: a quotation inside a
    // note is part of the note (the edition sets it inside the note's paragraph)
    if (block.kind === 'verse' && !note && block.inBody) {
      // verse keeps its lines; a reference inside a verse line splits the verse
      let held = [];
      const emitVerse = () => {
        if (!held.length) return;
        push({ t: 'verse', x: tidyPunctuation(held.join('\n')), ...(block.sec && block.inBody ? { at: anchorOf(block) } : {}) });
        held = [];
      };
      for (const line of block.lines) {
        const runs = splitRefs(line, block);
        for (const run of runs) {
          if (run.t === 'ref') {
            emitVerse();
            push(run);
          } else if (run.x !== '') held.push(run.x);
        }
      }
      emitVerse();
      return;
    }
    // the reader's own join: hard-wrapped lines joined, a word broken across the
    // line break rejoined — the document's text must be the text the page shows
    const runs = splitRefs(joinLines(block.lines), block);
    for (const run of runs) {
      if (run.t === 'ref') push(run);
      else if (run.x !== '')
        push({
          t: note ? 'notedef' : 'p',
          x: tidyPunctuation(run.x),
          ...(note ? { n: note.n, ...(note.lang ? { lang: note.lang } : {}) } : {}),
          ...(block.sec && block.inBody && !note ? { at: anchorOf(block) } : {}),
        });
    }
  }

  const anchorOf = (block) => {
    if (!block.sec) return null;
    // the paragraph anchor names the section's RECORDED anchor, not its
    // ordinal. A block claiming a section no opener ever opened would derive
    // an anchor for a section that does not exist — refused, not guessed.
    const a = secAnchor.get(block.sec);
    if (a == null)
      throw new Error(
        `library: ${entry.slug}: a ${block.kind} block claims section ${block.sec}, which no section opener ` +
          `opened — the paragraph anchor would name a section that does not exist`,
      );
    return `${a}-${block.par}`;
  };

  /* A BLOCK THAT CONTINUES ITS PREDECESSOR. The transcription puts a blank line
   * between blocks, and that blank line is NOT a paragraph mark: MEASURED on this
   * edition, it falls mid-sentence far more often than not (the scan's own line
   * blocks, and every page break, are blank-line separated). The print's paragraph
   * ends with a sentence — so a block whose predecessor did NOT end a sentence is
   * not a new paragraph, and giving the two blocks the SAME `par` is what makes the
   * document say so. The reader then renders them as one paragraph, and a rule can
   * span them.
   *
   * The test is deliberately narrow, because a false JOIN is a wrong edition:
   *  - `: ` is an INTRODUCER, not a continuation — the verse or quotation that
   *    follows is its own display block, and the transcription's own reader marks
   *    it as verse (`isQuoted`), which is also excluded;
   *  - the continuation must start on a lower-case letter, a quote, a bracket or a
   *    parenthesis — a capital OPENS a sentence, which is where a paragraph does. */
  const endsSentence = (x) => {
    const v = (x || '').trimEnd();
    if (v === '') return true;
    const last = v.slice(-1);
    if ('.!?'.includes(last)) return true;
    if ('"\u201d\u2019)]'.includes(last)) return '.!?'.includes(v.slice(-2, -1));
    return false;
  };
  const lastTextEnding = () => {
    // THE BLOCK BEING ACCUMULATED IS THE IMMEDIATELY PRECEDING ONE. `flush` runs
    // AFTER this test (the order is: decide, flush, start), so the previous block
    // is still in `cur` and NOT yet in `out`. Reading only `out` therefore judged
    // every continuation against the block BEFORE the previous one — MEASURED: it
    // missed "16. In this cave, therefore, says Homer," | "all external
    // possessions must be deposited." and joined a block to text two blocks back.
    if (cur) {
      if (cur.note) return null; // a note's paragraph is the note's own
      if (cur.kind === 'p' || cur.kind === 'verse') return joinLines(cur.lines);
      return null;
    }
    // no open block: the previous thing was a marker, a section or a region, so
    // look back through `out` for the last TEXT block — but never past a section,
    // a region or a note, because a paragraph does not run through one of those
    for (let k = out.length - 1; k >= 0; k -= 1) {
      const b = out[k];
      if (b.t === 'p' || b.t === 'verse') return typeof b.x === 'string' ? b.x : '';
      if (b.t === 'sec' || b.t === 'region' || b.t === 'notedef') return null;
    }
    return null;
  };
  /** True when the block starting at `line` is a continuation of the one before,
   *  and the two must share their paragraph. */
  const continues = (line, bi) => {
    if (region !== 'body') return false;
    if (isQuoted(lines[bi])) return false;
    // a continuation starts on a lower-case letter, a quote, an opening or a
    // CLOSING bracket — `) superfluous` continues a parenthesis, and refusing it
    // broke the paragraph the print has whole (MEASURED: page 36)
    if (!/^[a-z\u2018\u201c"(\[)\]]/.test(line.trim())) return false;
    const prev = lastTextEnding();
    if (prev == null) return false;
    if (/:\s*$/.test(prev)) return false;
    return !endsSentence(prev);
  };


  /** Split one piece of text into text runs and reference blocks, IN ORDER. The
   * reference keeps the transcription's own words — "(note i)" — beside the
   * number it resolves to, so nothing the print has is lost to the link. */
  function splitRefs(text, block) {
    const runs = [];
    let at = 0;
    for (const m of text.matchAll(NOTE_REF)) {
      const before = text.slice(at, m.index).trim();
      if (before !== '') runs.push({ x: before });
      const fit = fitMarker(m[1], expectedRef);
      if (fit.how === 'disagreed') {
        throw new Error(
          `library: ${entry.slug}: the note references do not run in order — reference ${expectedRef} ` +
            `is due here but the transcription reads "(note ${m[1]})" (${fit.value}) — ` +
            `a marker that reads as another number is a disagreement, not something to fit`,
        );
      }
      if (fit.how === 'fitted') {
        findings.push(
          `reference ${expectedRef}: the transcription reads "(note ${m[1]})", which is not a number ` +
            `— the position in the sequence supplies the value`,
        );
      }
      // the reference and the punctuation the print sets against it travel
      // together: "(note 16)." is one run of the edition's text, and splitting
      // the full stop off would leave a block holding one character
      let end = m.index + m[0].length;
      while (end < text.length && /[.,;:!?]/.test(text[end])) end++;
      refs.push({ n: fit.value, token: m[1], how: fit.how, sec: block.sec, par: block.par });
      runs.push({
        t: 'ref',
        n: fit.value,
        x: text.slice(m.index, end),
        ...(block.sec && block.inBody ? { at: anchorOf(block) } : {}),
      });
      expectedRef = fit.value + 1;
      at = end;
    }
    const rest = text.slice(at).trim();
    if (rest !== '') runs.push({ x: rest });
    return runs;
  }

  for (let bi = 0; bi < lines.length; bi++) {
    for (let li = 0; li < lines[bi].length; li++) {
      const line = lines[bi][li];
      const key = `${bi}:${li}`;
      const mark = markers.get(key);

      if (mark) {
        // page furniture: it ends the paragraph run, and claims the page
        flush();
        if (mark.kind === 'head') push({ t: 'rh', x: line });
        push({
          t: 'pb',
          page: mark.page,
          how: mark.how,
          // the LEAF the marker stands on (phase 4): a page boundary is only
          // honest if the leaf it belongs to is named, and a HONEST model is
          // what the reading view turns into "leaf N" where no number was read
          ...(leafModel ? { leaf: mark.leaf } : {}),
          // a number the stride rule had refused, accepted because the leaf it
          // stands on is that page: the document says so on the marker itself,
          // so provenance can count them without reading the findings
          ...(mark.reRead ? { by: 'leaf' } : {}),
          // a bare folio IS its own text (no head words to carry it); the head's
          // words are in the `rh` block above, so the number is not repeated
          ...(mark.kind === 'folio' ? { x: line } : {}),
        });
        // A LEAF BOUNDARY the transcription marks nothing on is a marker and
        // NOT a line of furniture: the line it opens is the page's first line of
        // text and is emitted below like any other (dropping it would lose the
        // page's opening words — a silent loss this document does not allow).
        if (mark.kind !== 'leaf') continue;
      }
      if (junk.has(key)) {
        flush();
        push({ t: 'rh', x: line });
        continue;
      }

      /* A RECORDED DIVISION OPENS HERE (§3.2). The test is the line's own
       * position, not a regex: the number is in the model, read off the scan, and
       * the transcription's line only says WHERE the division stands. The line's
       * text must be the model's — a recorded model that no longer matches the
       * line it names has been made against other bytes, and opening a section at
       * it would anchor every citation after it to the wrong place. */
      if (divisionAt) {
        const div = divisionAt.get(sig.at(bi, li));
        if (div) {
          if (collapseLine(line) !== div.text) {
            throw new Error(
              `library: ${entry.slug}: division ${div.n} is recorded at line ${div.line} carrying ` +
                `${JSON.stringify(div.text)} and this transcription has ${JSON.stringify(collapseLine(line))} there — ` +
                `the recorded model is stale (the transcription has changed):\n  node tools/divisions.mjs ${entry.slug}`,
            );
          }
          flush();
          par = 0;
          if (region === 'front') {
            push({ t: 'region', kind: 'body' });
            region = 'body';
          }
          secN = div.n;
          expectedSec = div.n + 1;
          // the ordinal feeds the contiguous walk; the SERVED id is the
          // division's own recorded anchor — the name citations hold — so an
          // inserted division shifts the ordinals after it and moves no anchor
          secAnchor.set(div.n, div.anchor);
          push({
            t: 'sec',
            n: div.n,
            id: div.anchor,
            // the division's structure, carried on the section so the contents
            // list can state it. The reader renders the titles it already knew;
            // book/chapter/label are data the document keeps and the app MAY show
            // once its decoder learns the field (no anchor depends on them).
            book: div.book,
            chapter: div.chapter,
            label: div.label,
            // THE PRINTED PAGE the division opens on, read off the scan (the same
            // reading the model was recovered from) — served rather than the
            // marker-derived page, which for this edition is built on folios the
            // scan mangled far worse than it mangled the chapter numbers
            ...(div.page != null ? { page: div.page } : {}),
            ...(div.confidence ? { confidence: div.confidence } : {}),
          });
          start('p', line, { sameParagraph: false });
          continue;
        }
      }

      const fixed = applyCorrections(line, openers);

      if (line === (cfg.divisions || {}).notes) {
        flush();
        push({ t: 'region', kind: 'notes', id: 'snotes' });
        region = 'notes';
        par = 0;
        curNote = null;
        start('p', line, { sameParagraph: false });
        continue;
      }
      // THE BACK OF THE VOLUME, in the three parts it actually has. The old
      // single region was called "ads" and its label "the publisher's
      // advertisements" — and it opened with a printing statement, ran through the
      // publisher's book-list (which is what "advertisements" would mean), and
      // ended with the library's own marks. Three different things, one wrong name.
      //
      //   colophon — the printer's statement. ONE block: the region opens on it and
      //              the next block moves on.
      //   end      — the publisher's list of books, which is the book's end matter.
      //   library  — the SCAN's own marks at the back (the circulation pocket, the
      //              shelf label), which belong to the copy, not to the book.
      //
      // Each boundary is a PREFIX test: these lines carry runs of OCR spaces and
      // run on, so an equality test never fires.
      const colophonRule = (cfg.divisions || {}).colophon;
      if (colophonRule && (line === colophonRule || line.startsWith(colophonRule))) {
        flush();
        push({ t: 'region', kind: 'colophon' });
        region = 'colophon';
        par = 0;
        curNote = null;
        start('p', line, { sameParagraph: false });
        continue;
      }
      const libraryRule = (cfg.divisions || {}).library;
      if (libraryRule && (line === libraryRule || line.startsWith(libraryRule))) {
        flush();
        push({ t: 'region', kind: 'library' });
        region = 'library';
        par = 0;
        curNote = null;
        start('p', line, { sameParagraph: false });
        continue;
      }

      const open = OPENER.re.exec(fixed);
      const openN = open ? OPENER.read(open[1]) : null;
      if (open && region === 'front') {
        if (openN !== expectedSec) {
          throw new Error(
            `library: ${entry.slug}: section ${expectedSec} is expected here but the text opens ` +
              `section ${openN} (${JSON.stringify(line.slice(0, 60))}) — the divisions do not run 1…N`,
          );
        }
        flush();
        push({ t: 'region', kind: 'body' });
        region = 'body';
        par = 0;
        secN = expectedSec;
        secAnchor.set(secN, `s${secN}`);
        push({ t: 'sec', n: secN, id: `s${secN}` });
        expectedSec++;
        start('p', line, { sameParagraph: false });
        continue;
      }
      if (open && region === 'body' && openN === expectedSec) {
        // a division the transcription ran into the paragraph before it (§11 of
        // this volume opens mid-paragraph): the paragraph break the print has is
        // restored here, and the line begins the new section's first paragraph.
        // The number must be the one DUE — that is what makes a mid-paragraph
        // opener safe to look for at all.
        flush();
        par = 0;
        secN = expectedSec;
        secAnchor.set(secN, `s${secN}`);
        push({ t: 'sec', n: secN, id: `s${secN}` });
        expectedSec++;
        start('p', line, { sameParagraph: false });
        continue;
      }

      const defMark = region === 'notes' ? NOTE_MARK.exec(fixed) : null;
      if (defMark && li === 0) {
        flush();
        const fit = fitMarker(defMark[1], expectedNote);
        if (fit.how === 'disagreed') {
          throw new Error(
            `library: ${entry.slug}: the note definitions do not run in order — note ${expectedNote} ` +
              `is due here but the transcription reads "(${defMark[1]})" (${fit.value}) — ` +
              `a marker that reads as another number is a disagreement, not something to fit`,
          );
        }
        if (fit.how === 'fitted') {
          findings.push(
            `note ${expectedNote}: the transcription's marker "(${defMark[1]})" is not a number ` +
              `— the position in the sequence supplies the value`,
          );
        }
        defs.push({ n: fit.value, token: defMark[1], how: fit.how });
        expectedNote = fit.value + 1;
        par++;
        curNote = { n: fit.value };
        cur = { kind: 'p', lines: [line], par, sec: 0, note: curNote };
        continue;
      }

      if (li === 0) {
        // THE COLOPHON IS ONE BLOCK. Its region opens on the printer's statement
        // and the block after it is the publisher's list, which is a different
        // thing and gets its own region.
        if (region === 'colophon') {
          flush();
          push({ t: 'region', kind: 'end' });
          region = 'end';
          par = 0;
        }
        // a source block is a paragraph, so a block boundary ends the run —
        // unless the page furniture above already did (a paragraph that runs
        // over a page break keeps its text blocks, one per side of the break).
        // A block that CONTINUES its predecessor shares its paragraph (`par` does
        // not advance), so the two are one paragraph in the reading view.
        const joined = continues(line, bi);
        if (joined) {
          findings.push(
            `paragraph join: the block beginning ${JSON.stringify(line.trim().slice(0, 48))} continues the ` +
              `sentence before it (which does not end with a full stop, and this line starts lower-case), ` +
              `so the two are one paragraph, not two`,
          );
        }
        flush();
        start(isQuoted(lines[bi]) ? 'verse' : 'p', line, { sameParagraph: joined });
      } else if (cur) {
        cur.lines.push(line);
      } else {
        start('p', line, { sameParagraph: false });
      }
      // a note that runs past a page break continues: the accumulator keeps the
      // note it belongs to, so the definition is one note with a page marker in
      // the middle of it rather than a note that stops at the page
      if (region === 'notes' && curNote && !cur.note) cur.note = curNote;
    }
  }
  flush();

  /* 4. The properties the plan requires the extraction to have, asserted here so
   * a silent mis-read cannot be served: the divisions run 1…N with none missing
   * and none duplicated, and every note marker runs 1…M and is referenced.
   * N is the text's own (its `expectedDivisions`): the Cave's eighteen and the
   * Proclus's 211 are both MEASURED facts about one edition, and a count that
   * is not the edition's names a missed or a spurious opener rather than a
   * different book. */
  const wantDivisions = cfg.expectedDivisions || (divisionModel ? divisionModel.divisions.length : 18);
  if (expectedSec - 1 !== wantDivisions) {
    throw new Error(
      `library: ${entry.slug}: the text's divisions do not run 1…${wantDivisions} — ` +
        `${expectedSec - 1} were found, so a section is either not detected (its opener is still ` +
        `mangled) or detected twice (an opener that is not one); the offender is the division whose ` +
        `number is not the one due`,
    );
  }
  /* 4a. THE RECORDED DIVISIONS, COUNTED (§3.2). Here the count alone is not
   * enough: the divisions are opened by LINE POSITION, so a model that names a
   * line carrying text but the WRONG one would still produce N sections — and a
   * section that opens one line early silently moves a paragraph into the wrong
   * chapter. The sections must be exactly 1…N in document order, each once. This
   * is the assertion the recorded mode rests on, and it is the one the earlier
   * fuzzy-matching attempt could not make. */
  if (divisionModel) {
    const found = out.filter((b) => b.t === 'sec').map((b) => b.n);
    const want = divisionModel.divisions.map((d) => d.n);
    if (found.length !== want.length || found.some((n, i) => n !== want[i])) {
      const firstBad = found.find((n, i) => n !== want[i]);
      throw new Error(
        `library: ${entry.slug}: the recorded divisions did not open where the model says — ` +
          `${found.length} section(s) were opened against the model's ${want.length}, and the first that is not ` +
          `the one at its position is ${firstBad == null ? '(none; the counts differ)' : firstBad} — ` +
          `a recorded line that carries the wrong text is a model made against another transcription`,
      );
    }
  }
  /* THE NOTE MACHINERY IS THE EDITION'S OWN. The 1917 Cave carries a numbered
   * Notes division, every marker `(n)` defined and referenced; the 1816 Proclus
   * has NO such division (MEASURED: zero `(note n)` references in the slice —
   * its marginal notes are the page-foot kind, unnumbered in this
   * transcription) — so the three arithmetic gates below assert the Cave's
   * shape only where the text has it: a text with neither definitions nor
   * references has nothing to check, and a text with one but not the other
   * fails exactly as before. */
  const consecutive = defs.every((d, i) => d.n === i + 1);
  if (!consecutive) {
    const bad = defs.find((d, i) => d.n !== i + 1);
    throw new Error(
      `library: ${entry.slug}: the note definitions do not run 1…${defs.length} — ` +
        `note ${bad.n} stands where ${defs.indexOf(bad) + 1} is due (marker "${bad.token}")`,
    );
  }
  if (defs.length || refs.length) {
    const referenced = new Set(refs.map((r) => r.n));
    const unreferenced = defs.filter((d) => !referenced.has(d.n));
    if (unreferenced.length) {
      throw new Error(
        `library: ${entry.slug}: ${unreferenced.length} note definition(s) nothing refers to ` +
          `(${unreferenced.map((d) => d.n).join(', ')}) — every note of this edition is referenced in the text`,
      );
    }
    const undefinedRef = refs.find((r) => r.n < 1 || r.n > defs.length);
    if (undefinedRef || refs.length > defs.length) {
      throw new Error(
        `library: ${entry.slug}: a note reference resolves to no definition — ` +
          `${refs.length} references against ${defs.length} definitions, so at least one definition was ` +
          `missed (a marker the extraction does not see, or a note whose paragraph start is not a line start)`,
      );
    }
  }

  /* 4b. The language of the notes. The one Latin passage in this edition is a
   * quotation inside note (6), laid over two blocks by a page break; the answer
   * is computed once for the note and carried by all its blocks. */
  const noteText = new Map();
  const seenNote = new Set();
  for (const b of out) {
    if (b.t !== 'notedef') continue;
    noteText.set(b.n, `${noteText.get(b.n) || ''} ${b.x}`);
  }
  for (const b of out) {
    if (b.t === 'notedef' && latinLang(noteText.get(b.n))) b.lang = 'la';
  }

  /* 5. The page a position is printed on, and the sections' first page. A
   * position belongs to the last page marker at or before it; the text before
   * the first marker (the body's opening page, whose folio the transcription
   * put at the foot) takes the first recovered page. */
  const firstPage = (() => {
    for (const b of out) if (b.t === 'pb' && b.page != null) return b.page;
    return null;
  })();
  let here = null;
  for (const b of out) {
    if (b.t === 'pb' && b.page != null) here = b.page;
    // a RECORDED division already carries the page its own scan reads (the
    // vision pass read the printed number off the page the chapter opens on);
    // the marker-derived page is the fallback, not an overwrite — this edition's
    // folios survive too badly to be the better witness (§3.2)
    else if (b.t === 'sec') b.page = b.page != null ? b.page : here != null ? here : firstPage;
  }

  /* 5b. The fragment grammar, materialised: `#s<n>` a division, `#p<n>` a printed
   * page, `#n<n>` a note, `#r<n>` the reference a note returns to. The grammar is
   * the plan's (§3) and it is carried in the document rather than left to the
   * reader app to invent, so the anchors a citation names exist in the artefact
   * that serves them — and #s<sec>-<par> (the reference's own place) is reserved
   * on every `ref` as `at`, not closed off. */
  for (const b of out) {
    if (b.t === 'pb' && b.page != null) b.id = `p${b.page}`;
    else if (b.t === 'ref') b.id = `r${b.n}`;
    else if (b.t === 'notedef' && !seenNote.has(b.n)) {
      seenNote.add(b.n);
      b.id = `n${b.n}`; // the note's first block carries the anchor: a note laid
      // over two pages is one note, and two elements cannot hold one id
    }
  }
  const ids = out.filter((b) => b.id).map((b) => b.id);
  const dupe = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dupe) {
    throw new Error(
      `library: ${entry.slug}: two blocks claim the anchor "${dupe}" — an anchor two elements share is ` +
        `not an anchor (this happens when a note is referenced twice, and the fix is a per-reference anchor)`,
    );
  }

  /* 5c. THE BLOCKS A RULE CANNOT SEE ACROSS. The transcription splits a sentence
   * at every blank line, and sometimes the print's text simply continues across
   * one — a page break mid-word (`…patient perse-` | `verance.`, printed pages 38
   * and 39) or words lost at the break (`…but they also assu` | `'symbol of all
   * invisible powers`). The reading view joins consecutive text blocks, but a
   * RULE is applied per block, so a find that spans the join can never fire, and
   * no per-block reading can state it: `assu` -> `assumed` leaves its own find
   * standing, and `verance` -> `perseverance` does too.
   *
   * So a rule may be marked `"join": true`, meaning its find CROSSES the boundary
   * between two adjacent text blocks. The two are merged here, before the rules
   * run, so the find is inside the one block and every engine (this one, the
   * reader, the search) sees the same text — and the reader renders the joined
   * sentence as one paragraph, which is what the print has.
   *
   * The pair is located BY THE FIND, not by an anchor: `at` is a paragraph label
   * and a paragraph spans several blocks, so an anchor does not name one block
   * (MEASURED — `s3-1` labels two blocks, and joining by it merged the wrong
   * pair). The merge condition is exact: the find is in the two blocks' joined
   * text and in NEITHER alone. The merged block keeps the first block's place;
   * anchors are fixed strings assigned during assembly, so nothing renumbers. */
  const joins = edits.filter((r) => r.join && r.action !== 'leave');
  if (joins.length) {
    // A `join` rule whose find already sits inside ONE block would never trigger
    // the merge and would still fire like an ordinary rule — a flag that does
    // nothing, which is unreviewed machinery. So it is refused up front: the flag
    // is only meaningful when the find SPANS a seam.
    for (const r of joins) {
      const inside = out.some(
        (b) => (b.t === 'p' || b.t === 'verse' || b.t === 'ref') && typeof b.x === 'string' && b.x.includes(r.find),
      );
      if (inside) {
        throw new Error(
          `library: ${entry.slug}: the rule "${r.find}" is marked "join" but its find lies inside a single block — ` +
            `the join would do nothing`,
        );
      }
    }
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i + 1 < out.length && !merged; i += 1) {
        const a = out[i];
        const b = out[i + 1];
        if (!(a.t === 'p' || a.t === 'verse')) continue;
        if (!(b.t === 'p' || b.t === 'verse' || b.t === 'ref')) continue;
        // The separator is a SPACE at a word boundary, and NOTHING when the first
        // block ends in a hyphen and the word runs on (`perse-` | `verance` is one
        // word). MEASURED: a blank line is a word boundary, so `assu` | `'symbol`
        // is `assu 'symbol`, not `assu'symbol`.
        const glue = /-$/.test(a.x || '') ? '' : ' ';
        const joined = `${a.x || ''}${glue}${b.x || ''}`;
        const crosses = joins.some(
          (r) => joined.includes(r.find) && !(a.x || '').includes(r.find) && !(b.x || '').includes(r.find),
        );
        if (!crosses) continue;
        out[i] = { ...a, x: joined };
        out.splice(i + 1, 1);
        merged = true;
      }
    }
  }

  /* 6. The rules the reading view applies — the reviewed list, in the file's own
   * order. They are loaded above (the extraction needs the `opener` class), and
   * they are shipped with the document exactly as plan §7 says: corrections travel
   * as RULES, never as a second text, so the transcription above stays verbatim
   * and the diff view is this list. */
  const corrections = edits;

  /* 6a. THE POLICY'S ONE EXCEPTION, ASSERTED (§7) — the assertion itself is
   * `checkFrontMatter` below, so the smoke can call the same code over a fixture
   * instead of re-stating it. The rules' canonical `type`s travel in the load's
   * meta (the reader view does not carry them), and the assertion admits only a
   * `transliteration` into the preserved region. */
  checkFrontMatter({ slug: entry.slug, blocks: out, dropped: dropped.map((x) => ({ x })), corrections }, ruleMeta && ruleMeta.types);

  /* 7. The table of contents: generated, from the divisions the edition itself
   * makes, each entry carrying the section's own opening words.
   *
   * The TITLE is generated apparatus — neither the 1917 print nor the 1816
   * volume prints a contents page — and it is derived from the CORRECTED
   * opening words (option (a) of the phase-3 brief, not (b)): the title is built
   * from the same words, with the same rules, in the same order, as the reading
   * view applies to that same line, so the contents list and the reading cannot
   * disagree about the sentence a reader meets first.
   *
   * WHICH words depends on the division's shape, and the shape is the text's:
   * the Cave's opener carries the section's own first words on the same line
   * (`1. What does Homer…`), so the title is that line minus its numeral; the
   * 1816 Proclus prints the label on a line of its own (`PROPOSITION XXVI.`),
   * so the title is the NEXT text block's opening, and a label-shaped first
   * block is stepped over. The word CAP is per-text for the same reason: eight
   * words distinguish the Cave's eighteen sections but leave two of the
   * Proclus's opening statements identical to their neighbours' (props 31/33
   * and 163–165 all open "Every thing which proceeds…"), and a contents list
   * whose entries do not distinguish the divisions is not a contents list.
   *
   * Every entry also carries the RAW derivation (`raw`) — the title the
   * transcription's own damaged words give — because that is what the
   * transcription view must show and what the review diffs against. A title still
   * damaged after correction is marked `damaged` and the entry names the words: it
   * is NEVER repaired by inventing a reading. */
  const titleCap = cfg.titleWords || 8;
  const titleOf = (text) => sectionTitle(text, titleCap, cfg.titleStop !== 'cap');
  // the roman shape's own label line: stripped whole, so the title is the
  // statement's words rather than the label repeated 211 times. The test is on
  // the CORRECTED line — the opener rules have repaired the mangled label by
  // the time the block is read here, and the raw form (`T>ROPOSITION XXVI.`)
  // does not match the clean shape.
  const isLabel = (x) => {
    if (cfg.opener !== 'roman') return false;
    const fixed = applyCorrections(x, corrections);
    return OPENER.re.test(fixed) && fixed.replace(OPENER.re, '').trim() === '';
  };
  const toc = [];
  for (let i = 0; i < out.length; i++) {
    const b = out[i];
    if (b.t !== 'sec') continue;
    let body = out.slice(i + 1).find((x) => x.t === 'p' || x.t === 'verse');
    while (body && isLabel(body.x)) {
      body = out.slice(out.indexOf(body) + 1).find((x) => x.t === 'p' || x.t === 'verse');
    }
    const line = body ? body.x.split('\n')[0] : '';
    // `raw` is the title with NO rule applied — the transcription's own words,
    // which is what the transcription view must show; `title` is the same words
    // through the full rule list, which is what the reading view applies.
    const rawTitle = titleOf(line.replace(OPENER.re, ''));
    const title = titleOf(applyCorrections(line, corrections).replace(OPENER.re, ''));
    const harm = titleDamage(rawTitle, title, corrections);
    toc.push({
      id: b.id,
      n: b.n,
      title,
      raw: rawTitle,
      // a title the transcription damaged beyond what the rules can read: the
      // contents list says so instead of showing damaged words as a title, and the
      // words themselves stand in `raw` for the reader and the review
      ...(harm.damaged ? { damaged: true, damagedWords: harm.words } : {}),
      page: b.page,
      // the STRUCTURE the division carries, where the edition records it (the
      // recorded-division mode §3.2): book and chapter are the print's own numbers
      // read off the scans, and the label is what a citation calls the division.
      ...(b.book != null ? { book: b.book, chapter: b.chapter, label: b.label } : {}),
    });
  }
  const titles = toc.map((t) => t.title);
  if (new Set(titles).size !== titles.length) {
    throw new Error(
      `library: ${entry.slug}: ${titles.length - new Set(titles).size} section(s) derive a title another section ` +
        `already has — the titles must distinguish them (a longer per-text word cap, or a damaged opener the ` +
        `rules do not read)`,
    );
  }

  /* 7b. THE POLICY, COUNTED — on the text the reader is given. The base policy is
   * "substitute the reading when one is recorded, otherwise leave the marker in
   * place", so the numbers are (i) the readings applied and (ii) the damage the
   * reading view still shows: the damaged words and the STANDALONE MARKERS the
   * rules did not reach. All are measured on the served text AFTER the rules run:
   * a word the rules resolved no longer carries damage, and one they did not is
   * exactly the word whose marker a reader can still see.
   *
   * The DOMAIN is the text the reading view renders: every `p`, `verse` and
   * `notedef` block, in document order, one block at a time, with the hard-wrapped
   * lines joined as the reader joins them. That is the app's own rendering set
   * (`Reader.Document.flow` → `FPara`/`FNote`); running heads (`rh`) are furniture
   * the reading view suppresses and the transcription view shows, and the page
   * markers (`pb`) are chrome. MEASURED, and why the domain is stated here: the
   * earlier domain was the section-labelled body paragraphs only, which left the
   * note definitions and the unlabelled paragraphs of the front matter and the
   * back-matter blocks outside the census — so the count said 2 while the reading view
   * showed 33 damage characters. A count over less than the reading view is not a
   * count of the reading view. */
  const readingViewText = out
    .filter((b) => b.t === 'p' || b.t === 'verse' || b.t === 'notedef')
    .map((b) => b.x.replace(/\n/g, ' '))
    .join(' ');

  /* 7c. The hit table: every rule, and how many times it fires in the text the
   * reading view is given. It is measured here, shipped with each rule, and the
   * build FAILS on a rule that fires zero times (`checkEdits`, called by the
   * build — the acceptance rule of plan §7). */
  const report = editReport(out, corrections);
  report.forEach((r, i) => {
    corrections[i].hits = r.hits;
  });
  const policy = policyReport(readingViewText, corrections, damage);

  /* 7d. What the LEAF MODEL found is a finding like any other, and the document
   * keeps it: every page marker that does not stand at its leaf's own boundary,
   * every marker the leaf re-read, and every boundary the transcription carries
   * no marker for. The build prints them, so the difference between the txt-mode
   * page model and the leaf-accurate one is accounted for one case at a time. */
  findings.push(...pageFindings);

  const doc = {
    slug: entry.slug,
    lang: entry.lang || 'en',
    source: {
      item: entry.item || scanItemNames(entry.slug).join(' + ') || null,
      sha256: meta.sha256,
      // what the page model rests on, named in the document itself: the leaves
      // when there is a leaf model, and nothing but the transcription otherwise
      ...(leafModel
        ? {
            leaves: {
              item: leafModel.item,
              leaves: leafModel.totals.leaves,
              withText: leafModel.totals.withText,
              numbered: leafModel.totals.numbered,
              detected: leafModel.totals.detected,
              interpolated: leafModel.totals.interpolated,
              offset: leafModel.totals.offset,
              // the cross-check's own outcome, so a page that says what the
              // provenance claims can be checked against it (the disagreeing
              // pages, if any, are named — never merged into the text's reading)
              agreed: leafModel.agreement ? leafModel.agreement.agree : null,
              textOnly: leafModel.agreement ? leafModel.agreement.textOnly : null,
              leafOnly: leafModel.agreement ? leafModel.agreement.leafOnly : null,
              disagreed: leafModel.agreement ? leafModel.agreement.disagree : null,
            },
          }
        : {}),
    },
    // the page model, in the order the markers stand in the text. A LEAF-ACCURATE
    // model names the leaf each boundary belongs to and says HOW the page was
    // read; the txt-mode model has no leaves to name (which is what `leaf: null`
    // says — not an invented one).
    pages: [...markers.values()]
      .sort((a, b) => a.at - b.at)
      .map((m) => (leafModel ? { leaf: m.leaf ?? null, page: m.page, how: m.how } : { leaf: null, page: m.page })),
    toc,
    blocks: out,
    // THE DIVISION MODEL, when the edition's divisions are recorded rather than
    // read from the transcription (§3.2): what was recovered, from what, and the
    // count. The document carries it so a reader can check the section numbering
    // against the structure it came from — the sections are the model, one for one.
    ...(divisionModel
      ? {
          divisions: {
            count: divisionModel.divisions.length,
            // each book's count, and the witness's own against it: a book the
            // print does not print as many chapters of as its contents list names
            // is CARRIED as a disagreement, never silently reconciled
            books: (divisionModel.books || []).map((b) => ({
              n: b.n,
              label: b.label,
              chapters: b.chapters,
              witness: b.witness == null ? null : b.witness,
              agreement: b.witnessAgreement || null,
            })),
            readFrom: divisionModel.method || null,
            source: divisionModel.source || null,
          },
        }
      : {}),
    corrections,
    // THE DAMAGE SET, from the base policy to the reading view. The app marks a
    // character of this set where a damaged word has no recorded reading, so the
    // reader can SEE that the word is damaged instead of reading a silent edit.
    damage,
    correctionsMeta: {
      reviewed: true,
      order: 'the order this list gives them, first to last, applied to every occurrence one text block at a time',
      policy: {
        rule: loadBasePolicy().rule,
        damage,
        base: 'the shared base policy every text inherits',
        states: loadBasePolicy().states,
      },
      classes: Object.fromEntries(
        EDIT_CLASSES.map((k) => [k, corrections.filter((c) => c.cls === k).length]),
      ),
      hits: Object.fromEntries(
        EDIT_CLASSES.map((k) => [
          k,
          corrections.filter((c) => c.cls === k).reduce((a, c) => a + c.hits, 0),
        ]),
      ),
      repeated: report.filter((r) => r.hits > 1).map((r) => ({ cls: r.cls, find: r.find, hits: r.hits })),
      readings: policy.readings,
      leftWordCount: policy.left.damaged,
      leftWords: policy.left.words,
      leftMarkerCount: policy.left.markers.length,
      leftMarkers: policy.left.markers,
      leftDamageChars: policy.left.chars,
      readingView:
        'the text the reading view renders: every p, verse and notedef block in document order, rules ' +
        'applied, counted after they run. Running heads are furniture the view suppresses; page markers ' +
        'are chrome.',
      damagedWords: policy.raw.damaged,
      repairedWords: policy.raw.repaired,
      unrepairedWords: policy.raw.unrepaired,
      unrepairedList: policy.raw.words,
      damagedTitles: toc.filter((t) => t.damaged).map((t) => t.n),
      note:
        // A VERSION WITH NO RULES IS A STATE, NOT AN ABSENCE. The note below is
        // written for a version whose reading view is produced BY its rules; a
        // version that carries none — an edition published in repair, before its
        // first emendation — would render that sentence as machinery describing
        // nothing ("every rule fires" of no rules). It says the zero case plainly
        // instead, and the counts that follow (the damage census, which NEEDS no
        // rule) still stand.
        corrections.length === 0
          ? 'This version carries NO repair rules: the transcription is served exactly as the scanner left ' +
            'it, so the reading view and the transcription view are the same text. Nothing is corrected here and ' +
            'nothing is hidden either — every damaged character the scanner left stands visible in the reading ' +
            'view, MARKED as damage rather than read as the print\u2019s own text. Each emendation will be ' +
            'recorded here as a rule with the words it changes, why it was made, and the page image it was ' +
            'decided from, as it is made. Until then the damage set is the shared base policy\u2019s, and the ' +
            'counts below are the transcription\u2019s own.'
          // The policy is named, not its PATH: the blog's copy of this sentence
          // printed `tools/edits/_base.json`, which is (a) an internal path
          // in a SERVED document — the leak gate's own subject — and (b) a path
          // that does not exist in this repo (the policy is tools/edits/_base.json,
          // see EDITS_DIR). A path that is wrong in both directions is not worth
          // printing; the policy is named instead.
          : 'The reading view of this text is produced by these rules and nothing else, under the shared base ' +
        'policy: the transcription served here is verbatim and uncorrected, and each ' +
        'rule is applied to it in this order. Every rule fires at least once in the served text, and one that ' +
        'fires nowhere is caught before this document is served, because a rule that matches nothing is ' +
        'machinery nothing read. The "opener" rules are readings the print requires for its divisions to run ' +
        'in order. The "digit" rules are the printed numbers and note markers the transcription wrote through ' +
        'an OCR confusion, each pinned to the line or marker it was read from. The "reading" rules record the ' +
        "print's own word for a damaged run, so the reading view shows what the edition says instead of a " +
        'word the transcription left damaged. The "review" rules record that a reading is NOT determinable there (action ' +
        '"leave"), and a damaged word with no rule at all is left the same way: the policy substitutes a ' +
        'reading when one is recorded and otherwise LEAVES THE MARKER IN PLACE, visible in the reading view. ' +
        'The damage that survives is counted in TWO classes, kept apart because they are different things: ' +
        'the damaged WORDS no rule resolved, and the STANDALONE MARKERS — one or more damage characters ' +
        'standing as their own token between words, a lost space or the scanner\u2019s debris — which are NOT ' +
        'words and are not counted as any. Both counts, the damage characters they account for between ' +
        'them, and a section title the rules still leave damaged, are stated below.',
    },
    dropped: dropped.map((x) => ({ x, why: 'the library stamp, not text' })),
    findings,
  };
  return doc;
}

/** A block the print sets apart by quotation — the plan's `verse` type. Its lines
 * are kept, so a quoted passage appears as the edition sets it rather than as one
 * justified line.
 *
 * MEASURED, and why the rule is only "it opens with a quotation": line length
 * does NOT separate verse from prose in these transcriptions. The 1917 Porphyry's
 * prose blocks are as ragged as its verse blocks (a prose block 0.76 ragged, the
 * Odyssey quotation 0.93), because the line breaks are the OCR's, not the
 * printer's measure — so "short lines" would call the prose verse and "long
 * lines" would call the verse prose. What the class honestly carries here is a
 * QUOTATION the edition sets apart, and that is what the leading quotation mark
 * identifies (11 in this text's body). */
function isQuoted(lines) {
  // a real quotation mark, not the stray apostrophe the transcription drops in
  // ("'symbol oT aH invisible powers" opens no quotation)
  return lines.length > 0 && /^["\u201c\u201d]/.test(lines[0]);
}

/** Inflections that are the signature of Latin running text, and are not English
 * words: a scan of the whole edition finds them ONLY inside note (6)'s quotation
 * (MEASURED: four in "…flammarum congestione plenissimam… mercibus conspicatur
 * … praesidebant", one in the line before it, and none anywhere else in the
 * book). The test is therefore a count of inflections, not a judgement about
 * taste, and it is the whole text's count: no other block reaches one. */
const LATIN_INFLECTION = /(ibus|arum|orum|atur|ebant|entem|issim|ntur|isse)$/;

/** Is this a passage of Latin? Answered on a NOTE's whole text — the edition's
 * Latin is one quotation inside note (6), and a page break inside that note
 * splits it over two blocks, so the question is asked of the note and the answer
 * is carried by every block of it. */
export function latinLang(text) {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.filter((w) => LATIN_INFLECTION.test(w)).length >= 4;
}

/**
 * The census of the transcription's damaged words, counted on the text the
 * reading view is given and split by whether a rule reaches them. It is a
 * PARTITION, so the three counts add up and the provenance cannot tell a story
 * the numbers do not support:
 *
 *   `damaged`    distinct WORDS — a word being a token with a letter in it, not
 *                the scan's debris — that carry a character the census marks as
 *                damage;
 *   `repaired`   of those, the ones a rule NAMES — its `find` is the whole word,
 *                so the rule is a statement about that word;
 *   `unrepaired` the rest. A rule that only reaches part of the word may still
 *                remove the character that damaged it (`^and` repairs the opening
 *                of `qreneratioi^and`), so "unrepaired" means exactly this and no
 *                more: no rule names the word, and the letters it lost are left
 *                as the transcription has them.
 *
 * The unrepaired words are counted, named in the build log, and never turned into
 * a rule: a rule that guessed would be worse than the damage.
 *
 * A WORD here is exactly "a whitespace token with a letter in it". The other half
 * of the damage — a marker standing ALONE between words, with no letter to
 * qualify it as a word — is counted by `markerCensus`, deliberately apart from
 * this one. The two are not the same thing and merging them would hide which is
 * which; the split is total, because a token either has a letter or does not.
 */
export function damageCensus(text, finds, damageSet) {
  const rules = new Set(finds || []);
  const seen = new Set();
  const unrepaired = new Set();
  for (const rawTok of text.split(/\s+/)) {
    const tok = rawTok.replace(/^[.,;:?!()"'„“”\[]+/, '').replace(/[.,;:?!()"“”\]|\\]+$/, '');
    if (tok === '' || !/[A-Za-z]/.test(tok)) continue; // a word, not the scan's debris
    if (seen.has(tok) || !damageRegex(damageSet).test(tok)) continue;
    seen.add(tok);
    if (!rules.has(tok)) unrepaired.add(tok);
  }
  return {
    damaged: seen.size,
    repaired: seen.size - unrepaired.size,
    unrepaired: unrepaired.size,
    words: [...unrepaired],
  };
}

/**
 * THE STANDALONE MARKERS — the half of the damage a word census cannot see, and
 * the reason the model needed widening.
 *
 * MEASURED on this edition's reading view: the words census reported 2 damaged
 * words while the reading view still showed 33 damage characters. The rest were
 * not in words at all — they were markers standing as their OWN token between
 * words (`of ^ any other matter`, `petitioner. _ Thus`, a `\` alone between
 * `place` and `which`), which the word census skips by construction
 * (`if (tok === '' || !/[A-Za-z]/.test(tok)) continue`) because it is looking for
 * words.
 *
 * A STANDALONE MARKER is a whitespace token that has NO LETTER and carries at
 * least one character of the policy's damage set. It is DAMAGE on the same terms
 * as a damaged word: either the scan lost the SPACE the print has there, or the
 * token is the scan's debris (page furniture, a shattered run). It is NOT a word,
 * so it is counted here and never mixed into the word count: a reader told "2
 * damaged words" is told the truth about words, and the honest statement about
 * the damage as a whole is "2 damaged words, 13 standalone markers".
 *
 * The tokens are reported AS THEY STAND in the reading view (the raw token, not
 * an edge-stripped one), because a marker has no word around it to strip to: what
 * the list names is what the reader sees.
 */
export function markerCensus(text, damageSet) {
  const seen = new Set();
  for (const tok of text.split(/\s+/)) {
    if (tok === '' || !damageRegex(damageSet).test(tok)) continue;
    if (/[A-Za-z]/.test(tok)) continue; // a damaged word: damageCensus's half
    seen.add(tok);
  }
  return [...seen];
}

/** How many characters of the policy's damage set the text still shows. The
 * number the two censuses have to account for between them, counted on the same
 * text they are counted on. */
export function damageCharCount(text, damageSet) {
  let n = 0;
  for (const c of text) if (damageRegex(damageSet).test(c)) n++;
  return n;
}

/**
 * THE POLICY, COUNTED — the numbers the provenance reports and the smoke asserts.
 *
 * The base policy is "substitute the reading when one is recorded, otherwise leave
 * the marker in place", so there are exactly two outcomes to count, and they are
 * counted on the text the reader is given, not on the file:
 *
 *   `recorded`  the rules of class `reading`: every one records the print's word,
 *               and every one fires at least once (the build fails otherwise);
 *   `applied`   their OCCURRENCES in the served text — the readings the reading
 *               view actually shows;
 *   `left`      the damage the reading view still shows, after every reading has
 *               been applied, in its TWO classes, kept apart because they are
 *               different things and one number would hide that:
 *                 `left.words`   the distinct damaged WORDS no rule resolved;
 *                 `left.markers` the distinct STANDALONE MARKERS between words;
 *                 `left.chars`   the damage characters still standing in the view,
 *                                which those two lists account for item by item.
 *
 * The partition is honest without a `repaired` count: a word is either shown as
 * its recorded reading (it no longer carries damage) or left as the transcription
 * has it (it does). Every reading that matches nothing is caught before this, so
 * `recorded === appliedRules`.
 */
export function policyReport(rawText, corrections, damageSet) {
  const rules = corrections.map((c) => ({ find: c.find, repl: c.repl, action: c.action }));
  const view = applyEditsCounted(rawText, rules);
  const rawCensus = damageCensus(rawText, corrections.map((c) => c.find), damageSet);
  const leftWords = damageCensus(view, [], damageSet);
  const readings = corrections.filter((c) => c.cls === 'reading');
  const applied = readings.filter((c) => c.hits > 0).length;
  const occurrences = readings.reduce((a, c) => a + (c.hits || 0), 0);
  const leaves = corrections.filter((c) => c.action === 'leave');
  return {
    raw: rawCensus,
    left: { ...leftWords, markers: markerCensus(view, damageSet), chars: damageCharCount(view, damageSet) },
    readings: {
      recorded: readings.length,
      applied,
      occurrences,
      leavesRecorded: leaves.length,
      leavesFired: leaves.filter((c) => c.hits > 0).length,
    },
  };
}

/** What the document holds, for provenance and for the smoke test. */
export function counts(doc) {
  const byType = {};
  for (const b of doc.blocks) byType[b.t] = (byType[b.t] || 0) + 1;
  const pages = { detected: 0, folio: 0, interpolated: 0, refused: 0 };
  for (const b of doc.blocks) {
    if (b.t !== 'pb') continue;
    if (b.how === 'head') pages.detected++;
    else if (b.how === 'folio') {
      pages.folio++;
      pages.detected++;
    } else if (b.how === 'interpolated') pages.interpolated++;
    else pages.refused++;
  }
  const regions = doc.blocks.filter((b) => b.t === 'region').map((b) => b.kind);
  const classes = {};
  const hits = {};
  for (const c of doc.corrections) {
    classes[c.cls] = (classes[c.cls] || 0) + 1;
    hits[c.cls] = (hits[c.cls] || 0) + (c.hits || 0);
  }
  /* The LEAF-ACCURATE page model, counted from what the document itself carries:
   * how many boundaries name the leaf they stand on, how many of those stand AT
   * the leaf's first line, how many are boundaries the transcription marks nothing
   * on, and what the leaf index has for the pages the text could not read. */
  const pb = doc.blocks.filter((b) => b.t === 'pb');
  const leaf = {
    model: doc.source && doc.source.leaves ? doc.source.leaves : null,
    boundaries: pb.length,
    named: pb.filter((b) => b.leaf != null).length,
    structural: pb.filter((b) => b.how === 'leaf').length,
    numbered: pb.filter((b) => b.page != null).length,
    unnumbered: pb.filter((b) => b.page == null).length,
    reread: pb.filter((b) => b.by === 'leaf').length,
    leaves: new Set(pb.map((b) => b.leaf).filter((n) => n != null)).size,
    modelLeaves: doc.source && doc.source.leaves ? doc.source.leaves.leaves : null,
  };
  return {
    blocks: doc.blocks.length,
    byType,
    regions,
    sections: doc.toc.length,
    notes: doc.blocks.filter((b) => b.t === 'notedef').map((b) => b.n).filter((n, i, a) => a.indexOf(n) === i).length,
    refs: doc.blocks.filter((b) => b.t === 'ref').length,
    pages,
    leaf,
    corrections: classes,
    correctionHits: hits,
    damagedTitles: doc.toc.filter((t) => t.damaged).map((t) => t.n),
    correctionsMeta: doc.correctionsMeta || null,
  };
}

/**
 * THE DIFF BETWEEN THE TWO PAGE MODELS (plan §4.6, the acceptance test).
 *
 * Phase 4 does not rewrite the document: it re-derives the PAGE MODEL. So the
 * difference between the txt-mode document and the leaf-accurate one must be
 * exactly the page model and nothing else — and this function is what says so,
 * item by item, so the build can print every difference and the smoke can assert
 * that the list is the whole of it. The two documents are taken as a parameter
 * rather than the files, because the point is to compare the two READINGS of one
 * edition, not two builds of it.
 *
 * Each difference is `{kind, what}`: `kind` is the place in the document, `what`
 * the difference itself. Anything the diff cannot pair up is a difference too —
 * an unexplained one, which is the failure this test exists to catch.
 */
export function diffDocs(txt, leaf) {
  const out = [];
  const nonMarker = (doc) => doc.blocks.filter((b) => b.t !== 'pb').map((b) => JSON.stringify(b));
  const a = nonMarker(txt);
  const b = nonMarker(leaf);
  if (a.length !== b.length) {
    out.push({ kind: 'text', what: `the two documents carry ${a.length} and ${b.length} non-marker block(s)` });
  }
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      out.push({
        kind: 'text',
        what: `block ${i} of the text differs: ${a[i].slice(0, 60)}… against ${b[i].slice(0, 60)}…`,
      });
      break;
    }
  }
  const pbTxt = txt.blocks.filter((x) => x.t === 'pb');
  const pbLeaf = leaf.blocks.filter((x) => x.t === 'pb');
  let i = 0;
  let j = 0;
  while (i < pbTxt.length || j < pbLeaf.length) {
    const t = pbTxt[i];
    const l = pbLeaf[j];
    const same = t && l && t.page === l.page && t.how === l.how;
    if (same) {
      if (t.leaf !== l.leaf || (l.leaf != null && t.leaf == null)) {
        out.push({ kind: 'pb.leaf', what: `page ${t.page == null ? '—' : t.page}: the marker gains leaf ${l.leaf}` });
      }
      i++;
      j++;
      continue;
    }
    if (l && t && l.how === 'leaf' && l.page == null) {
      out.push({
        kind: 'pb.added',
        what: `leaf ${l.leaf}: a page boundary the transcription carries no marker for, added UNNUMBERED (how: leaf)`,
      });
      j++;
      continue;
    }
    if (t && l) {
      out.push({
        kind: 'pb.changed',
        what:
          `a marker of the transcription (${JSON.stringify(t.x ?? '')}) was ${t.how} at page ${t.page == null ? '—' : t.page} ` +
          `and is ${l.how} at page ${l.page == null ? '—' : l.page} on leaf ${l.leaf}`,
      });
      i++;
      j++;
      continue;
    }
    out.push({
      kind: l ? 'pb.added' : 'pb.dropped',
      what: l ? `a marker the transcription does not carry (leaf ${l.leaf})` : `a marker the leaf model lost (page ${t.page})`,
    });
    if (l) j++;
    else i++;
  }
  /* The page model (`pages[]`) is the marker list — the same boundaries, in the
   * same order, with the number and the how and nothing else — so it is checked
   * to MIRROR the markers in both documents rather than diffed entry by entry.
   * Diffing it by index would report the leaf-28 insertion as 36 shifted entries,
   * which is a fact about the comparison, not about the page model. What the model
   * changed is said in one place: it gains a leaf on every entry, and it gains the
   * entry for the boundary the markers gained. */
  const mirror = (doc) => {
    const pbs = doc.blocks.filter((x) => x.t === 'pb');
    const pages = doc.pages || [];
    if (pages.length !== pbs.length) return `carries ${pages.length} page model entr(y/ies) for ${pbs.length} marker(s)`;
    for (let k = 0; k < pages.length; k++) {
      if (pages[k].page !== pbs[k].page) return `names page ${pages[k].page == null ? '—' : pages[k].page} for the marker at ${pbs[k].page == null ? '—' : pbs[k].page}`;
      if (pages[k].how !== undefined && pages[k].how !== pbs[k].how) return `says "${pages[k].how}" for a marker its own block says is "${pbs[k].how}"`;
      if ((pages[k].leaf ?? null) !== (pbs[k].leaf ?? null)) return `names leaf ${pages[k].leaf ?? '—'} for a marker its own block puts on leaf ${pbs[k].leaf ?? '—'}`;
    }
    return null;
  };
  for (const [name, doc] of [['the txt-mode document', txt], ['the leaf-accurate document', leaf]]) {
    const bad = mirror(doc);
    if (bad) out.push({ kind: 'pages', what: `${name} ${bad} — the page model is not the marker list` });
  }
  const leafGains = (leaf.pages || []).filter((p, k) => p.leaf != null && (txt.pages[k] || {}).leaf !== p.leaf).length;
  if (leafGains) {
    out.push({
      kind: 'pages.leaf',
      what: `every entry of the page model names the leaf its marker stands on (${leafGains} of ${(leaf.pages || []).length})`,
    });
  }
  return out;
}

/**
 * THE SAME DIFF, AS THE BUILD LOG SAYS IT.
 *
 * The full list is 108 items for this volume, and 106 of them are one rule applied
 * 106 times ("the marker gains its leaf"). Printing all of them would bury the two
 * that are not that rule — which are the entire point of the exercise. So the log
 * gets the count per kind, a SHORT sample of the repeated kind, and every item of
 * a kind that is a change rather than an addition. The smoke asserts the FULL
 * list, item by item, against an independently derived expectation: the log is for
 * a human, the smoke is for the claim.
 */
export function summariseDiff(diff) {
  const byKind = new Map();
  for (const d of diff) byKind.set(d.kind, [...(byKind.get(d.kind) || []), d.what]);
  const lines = [];
  for (const [kind, items] of byKind) {
    const uniform = items.every((w) => /gains leaf \d+$/.test(w));
    if (uniform && items.length > 3) {
      lines.push(`${items.length} marker(s)/entr(ies): ${kind} — each gains the leaf it stands on, e.g. ${items[0]}`);
    } else {
      for (const w of items) lines.push(`${kind}: ${w}`);
    }
  }
  return lines;
}

/* ---------- the two emitted files ---------- */

/** The document as it is served: one block per line, so a reader can inspect it
 * and a diff of two builds is readable. */
export function serialiseDoc(doc) {
  return `${JSON.stringify(doc).replace(/\},\{/g, '},\n{')}\n`;
}

/** The whole text as one plain file: the JS-off fallback and the citation of
 * record. The running heads are furniture and are not repeated here — their page
 * numbers are — and nothing else is dropped: the text is the transcription. */
export function plainText(doc, entry) {
  const lines = [];
  lines.push(entry.edition);
  lines.push('');
  lines.push(
    'The whole text of the edition named above, as transcribed. Nothing here is corrected; ' +
      'the defects of the transcription stand in it. A number in square brackets is a page of ' +
      'the printed volume, and [s1]…[sN] mark the editions own numbered divisions.',
  );
  lines.push('');
  for (const b of doc.blocks) {
    switch (b.t) {
      case 'pb':
        lines.push(b.page == null ? `[p—] ${b.x || ''}`.trim() : `[p${b.page}]`);
        lines.push('');
        break;
      case 'sec':
        // the plain file's division marker is the SERVED anchor — the name a
        // citation holds — not the ordinal, which an insertion may shift
        lines.push('', `[${b.id}]`, '');
        break;
      case 'region':
        lines.push('', `[region ${b.kind}]`, '');
        break;
      case 'rh':
        break; // furniture: its page number is the [pN] above
      case 'ref':
        // its words stand in the sentence the reference separates, and the
        // reference is its OWN block — dropping it here lost all 25 markers
        // from the citation of record, so a reader of /plain could not see
        // that a note existed anywhere in the book.
        lines.push(b.x);
        break;
      case 'p':
      case 'verse':
      case 'notedef':
        lines.push(b.x);
        lines.push('');
        break;
      default:
        break;
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/* ---------- the anchor manifest ---------- */

/** Every anchor a reading may link to, in document order: the sections, the
 * printed pages, the notes, and the two region anchors the fragment grammar
 * reserves (`#sfront`, `#snotes`). */
export function anchorLists(doc) {
  const uniq = (xs) => [...new Set(xs)];
  return {
    regions: uniq(doc.blocks.filter((b) => b.t === 'region' && b.id).map((b) => b.id)),
    sections: uniq(doc.blocks.filter((b) => b.t === 'sec').map((b) => b.id)),
    pages: uniq(doc.blocks.filter((b) => b.t === 'pb' && b.page != null).map((b) => `p${b.page}`)),
    notes: uniq(doc.blocks.filter((b) => b.t === 'notedef').map((b) => `n${b.n}`)),
    // the RETURN anchors are served too (#r<n>, the plan's own grammar), so they
    // must be pinned: they were materialised in the document but left out of the
    // hash, so a moved reference fired nothing.
    refs: uniq(doc.blocks.filter((b) => b.t === 'ref').map((b) => `r${b.n}`)),
  };
}

export function anchorHash(lists) {
  const canonical = JSON.stringify({
    regions: lists.regions,
    sections: lists.sections,
    pages: lists.pages,
    notes: lists.notes,
    refs: lists.refs,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The anchor-stability gate (plan §3): the build hashes the anchor list into a
 * COMMITTED manifest, and a regeneration that changes any anchor fails with
 * migration instructions. It is in place before any reading links an anchor,
 * because an anchor that silently moves is a citation that silently rots.
 *
 * There is no bypass. The only deliberate way through is to delete the pinned
 * file and rebuild — which is a decision someone has to make on purpose.
 *
 * PHASE 4 ADDED ONE GUARD TO THAT. The manifest also records WHEN the page
 * anchors came from a leaf model, because the derivation can be absent while the
 * manifest stays: the text would then be read in txt mode, its page anchors would
 * be the 51 the transcription alone reads, and the gate would report p43 as
 * DROPPED and — this is the trap — instruct the reader to delete the manifest and
 * re-pin. Following that instruction would drop a page the volume prints and the
 * leaf model confirmed, silently, with the gate's own blessing. So a manifest
 * built from a leaf model fails, with the model named, when the extraction has
 * none: the artifact is stored in the repo, and the fix is to restore it.
 */
export function checkAnchors(doc, file = anchorPath(doc.slug)) {
  const lists = anchorLists(doc);
  const hash = anchorHash(lists);
  const leafModel = doc.source && doc.source.leaves ? doc.source.leaves : null;
  const want = { slug: doc.slug, ...lists, hash, ...(leafModel ? { model: { leaves: leafModel.leaves, numbered: leafModel.numbered } } : {}) };
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(want, null, 2)}\n`);
    return { pinned: true, ...want };
  }
  const have = JSON.parse(readFileSync(file, 'utf8'));
  if (have.model && !leafModel) {
    throw new Error(
      `library: ${doc.slug}: the pinned anchors were built from the leaf-accurate page model and this extraction ` +
        `has none — it is reading the text in txt mode, where the page anchors are only what the running heads ` +
        `alone read, so re-pinning from here would DROP the pages the leaves confirm.\n` +
        `  The model is not fetched at build time and is not on the shelf: it is derived once, from the item's own ` +
        `page files, and stored beside the edition.\n` +
        `  Restore it: node tools/derive.mjs ${doc.slug}`,
    );
  }
  if (have.hash === hash) return { pinned: false, ...have };
  const moved = [];
  for (const k of ['regions', 'sections', 'pages', 'notes']) {
    const a = new Set(have[k] || []);
    const b = new Set(lists[k]);
    for (const x of b) if (!a.has(x)) moved.push(`added   ${k}:${x}`);
    for (const x of a) if (!b.has(x)) moved.push(`dropped ${k}:${x}`);
  }
  throw new Error(
    `library: ${doc.slug}: the anchors moved since they were pinned — a link that exists would rot.\n` +
      (moved.length ? `  ${moved.join('\n  ')}\n` : '') +
      `  pinned: ${have.hash}\n  now:    ${hash}\n` +
      `  If nothing cites this text yet, pin the new set deliberately: delete\n` +
      `  tools/anchors/${doc.slug}.json and build again.\n` +
      `  If something cites it, the pinned list is the record of what was published: ` +
      `keep the old anchor for every moved one (an alias, or a redirect), and only then re-pin.`,
  );
}

/* ---------- the one-time import ---------- */

/** A WITNESS EDITION held in the library beside the transcription. The parallel
 * of a text (another printing of the same work) is not a library reading of its
 * own — it may be a multi-treatise volume the extractor cannot serve — so it is
 * kept verbatim under `<slug>/witnesses/<name>.txt` and recorded in
 * `<slug>/witnesses.json`. The tools read it THERE, not from the shelf: the shelf
 * may be absent, and the evidence a rule was decided from belongs in the library
 * beside the rule. Matched by the shelf filename the record names, so the caller
 * keeps naming the file and never guesses a slug. Returns the path, or null. */
export function witnessPath(slug, shelfFilename) {
  const rec = join(LIBRARY_DIR, slug, 'witnesses.json');
  if (!existsSync(rec)) return null;
  try {
    const j = JSON.parse(readFileSync(rec, 'utf8'));
    for (const w of j.witnesses || []) {
      if (w.shelf === shelfFilename) {
        const p = join(LIBRARY_DIR, slug, 'witnesses', `${w.name}.txt`);
        if (existsSync(p)) return p;
      }
    }
  } catch {
    /* an unreadable record is not a reason to guess a witness */
  }
  return null;
}

/** Copy a shelf file into the library as a WITNESS of `slug`, ONCE, recording
 * its sha256. A witness is evidence for a reading, never a served text, so it
 * carries no document, no anchors and no pages, and the build never reads it. */
export function importWitness(slug, shelfFilename, why) {
  const resolved = shelfFile(shelfFilename, shelfFiles());
  const bytes = readFileSync(join(SHELF, resolved));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const name = basename(resolved).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const dir = join(LIBRARY_DIR, slug, 'witnesses');
  mkdirSync(dir, { recursive: true });
  const rec = join(LIBRARY_DIR, slug, 'witnesses.json');
  const doc = existsSync(rec) ? JSON.parse(readFileSync(rec, 'utf8')) : { slug, witnesses: [] };
  const prev = (doc.witnesses || []).find((w) => w.shelf === resolved);
  if (prev && prev.sha256 !== sha256) {
    throw new Error(
      `library: ${slug}: the witness "${resolved}" has changed since it was imported.\n` +
        `  imported: ${prev.sha256}\n  now:      ${sha256}\n  Nothing was overwritten — a reading may have been decided from the old bytes.`,
    );
  }
  if (prev) return { ...prev, skipped: true };
  writeFileSync(join(dir, `${name}.txt`), bytes);
  const out = { name, shelf: resolved, sha256, bytes: bytes.length, why: why || '', imported: new Date().toISOString().slice(0, 10) };
  doc.witnesses = [...(doc.witnesses || []), out];
  writeFileSync(rec, `${JSON.stringify(doc, null, 2)}\n`);
  return out;
}

/** Copy the shelf's transcription into the repo, ONCE, and record where it came
 * from. The shelf is the source of an import, never a build dependency: after
 * this, the build reads `data/editions/<slug>/versions/<semver>/source.txt` and the shelf can be
 * absent. Re-running on a CHANGED shelf file fails rather than overwrite: the
 * stored edition may already be cited, and replacing it silently would move
 * every page number a citation names.
 *
 * A SLICE OF A VOLUME records its own provenance and is NOT re-carved here: the
 * import record an earlier pass wrote already names the item, the whole file's
 * sha256 and the line range, and the stored bytes are that file's bytes over
 * those lines (the reconnaissance carved this one deliberately). So an edition
 * whose record carries an `extract` block is verified against itself — the
 * stored slice must hash to the recorded sha256, and the whole file is
 * re-hashed against the recorded whole when the shelf still holds it — and a
 * shelf file that has changed is refused on the same terms as any other. */
export function importEdition(slug) {
  const entry = TEXTS.find((t) => t.slug === slug);
  if (!entry) throw new Error(`library: no shelf entry '${slug}'`);
  const record = join(LIBRARY_DIR, slug, 'import.json');
  const prev = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null;
  /* A SLICE EDITION is already imported when its record and its bytes agree. */
  if (prev && prev.extract) {
    const bytes = readFileSync(editionPath(slug));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== prev.sha256) {
      throw new Error(
        `library: ${slug}: the stored slice is not the bytes the import recorded.\n` +
          `  recorded: ${prev.sha256}\n  stored:   ${sha256}\n` +
          `  A slice edition is carved once, on purpose; nothing here re-carves it. If the volume's ` +
          `transcription has changed, read the difference, carve a NEW edition (a new slug), and leave ` +
          `this one — it may already be cited.`,
      );
    }
    /* The whole file the slice was carved from is cross-checked when the shelf
     * still holds it: the slice's provenance is exact only while the volume's
     * own bytes are the recorded ones. */
    if (existsSync(join(SHELF, entry.file + '.txt'))) {
      const wholeBytes = readFileSync(join(SHELF, entry.file + '.txt'));
      const wholeSha = createHash('sha256').update(wholeBytes).digest('hex');
      if (wholeSha !== prev.extract.whole_sha256) {
        throw new Error(
          `library: ${slug}: the volume this slice was carved from has changed on the shelf.\n` +
            `  carved from: ${prev.extract.whole_sha256}\n  now:          ${wholeSha}\n` +
            `  The stored edition is unchanged and still served; but its recorded provenance names ` +
            `bytes the shelf no longer holds, so the trace is stale. Re-carve deliberately or record ` +
            `the new whole — do not overwrite this edition.`,
        );
      }
    }
    return { ...prev, skipped: true };
  }
  const from = textSource(entry, shelfFiles());
  const bytes = readFileSync(from);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (prev) {
    if (prev.sha256 === sha256) return { ...prev, skipped: true };
    throw new Error(
      `library: ${slug}: the shelf file has changed since this edition was imported.\n` +
        `  imported: ${prev.sha256} (${prev.bytes} bytes, ${prev.imported})\n` +
        `  now:      ${sha256} (${bytes.length} bytes)\n` +
        `  Nothing was overwritten. This edition may already be cited, and page numbers move with it.\n` +
        `  Read the difference, decide, and only then import: compare the two files, and if the new ` +
        `transcription is the edition you want, import it as a NEW edition (a new slug) or delete ` +
        `data/editions/${slug}/import.json deliberately, knowing what the citations point at.`,
    );
  }
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(editionPath(slug), bytes);
  const out = {
    slug,
    shelf: basename(from),
    sha256,
    bytes: bytes.length,
    imported: new Date().toISOString().slice(0, 10),
  };
  writeFileSync(record, `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/* ---------- the command line ---------- */

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const [cmd, slug] = process.argv.slice(2);
  if (cmd === '--import') {
    if (!slug) {
      console.error('usage: node tools/extract.mjs --import <slug>');
      process.exit(2);
    }
    const r = importEdition(slug);
    console.log(
      r.skipped
        ? `library: ${slug}: already imported, unchanged (${r.sha256})`
        : `library: ${slug}: imported ${r.shelf} (${r.bytes} bytes, ${r.sha256})`,
    );
  } else if (cmd === '--witness') {
    // --witness <slug> <shelf-filename> [why] — copy a shelf file into the
    // library as a witness of <slug> (a parallel edition a reading was decided
    // from). Held verbatim; the build never serves or extracts it.
    const [, wslug, shelf, ...why] = process.argv.slice(2);
    if (!wslug || !shelf) {
      console.error('usage: node tools/extract.mjs --witness <slug> <shelf-filename> [why]');
      process.exit(2);
    }
    const r = importWitness(wslug, shelf, why.join(' '));
    console.log(
      r.skipped
        ? `library: ${wslug}: witness ${r.shelf} already imported, unchanged (${r.sha256})`
        : `library: ${wslug}: witness ${r.shelf} -> witnesses/${r.name}.txt (${r.bytes} bytes, ${r.sha256})`,
    );
  } else {
    console.error(
      'usage: node tools/extract.mjs --import <slug>\n' +
        '       node tools/extract.mjs --witness <slug> <shelf-filename> [why]\n' +
        '  The build extracts stored editions itself (tools/build.mjs); these commands only\n' +
        '  bring a text in from the shelf, once, and refuse to replace a changed one.',
    );
    process.exit(2);
  }
}
