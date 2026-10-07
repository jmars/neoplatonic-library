#!/usr/bin/env node
/**
 * build/migrate.mjs — one-shot migration of the blog's library artifacts into
 * the neoplatonic-library data shape (docs/DATA-MODEL.md, the contract).
 *
 * READ-ONLY on the blog repo (~/enlighten): every source file is opened read
 * and nothing there is written. Writes land in data/ and docs/ of THIS repo.
 *
 * Run:  node build/migrate.mjs          (migrate, then verify and print)
 *       node build/migrate.mjs --verify (verify only, no writes)
 *
 * The scholarly `type` assignment follows DATA-MODEL §4.1's ordered rules 1–6.
 * Two documented honest extensions, both reviewed-listed:
 *  - The OCR-noise DAMAGE set (measured in the blog's _base.json, filtered per
 *    edition by extract.mjs TEXT_RULES `damageExclude`) is NOT treated as
 *    punctuation by rule 3: a rule whose only difference is a damage character
 *    recovered the print's word, which is §4.1's definition of OCR, not of
 *    punctuation. Every such rule carries review: true.
 *  - A rule equal after a character TRANSPOSITION (multiset-equal after
 *    whitespace removal, e.g. "accoridng"→"according") is OCR by rule 6,
 *    review: true.
 */

import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const BLOG = '/home/jaye/enlighten'; // read-only source
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const DOCS = join(ROOT, 'docs');
const TODAY = new Date().toISOString().slice(0, 10);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const GREEK = /[\u0370-\u03FF\u1F00-\u1FFF]/;
const isPunctChar = (c) => /\p{P}|\p{S}/u.test(c);

/* The base OCR-noise damage set (tools/library/edits/_base.json `damage`), per
 * edition minus that edition's own print sets (extract.mjs TEXT_RULES
 * `damageExclude`: proclus prints `*` as a footnote marker and `&` as an
 * ampersand — the print's own characters, not damage). Read from the blog,
 * never copied here as a constant. */
const DAMAGE_EXCLUDE = {
  'proclus-elements-of-theology-taylor-1816': ['*', '&'],
  'porphyry-on-the-cave-of-the-nymphs-taylor-1917': [],
};

const load = async (p) => JSON.parse(await readFile(p, 'utf8'));

/* ---------------------------------------------------------------- types -- */

/* Char-multiset difference after whitespace removal: the characters the two
 * sides disagree on. Equal on both sides + no diff chars = identical. */
function diffChars(find, replace) {
  const a = find.replace(/\s+/g, '');
  const b = replace.replace(/\s+/g, '');
  const m = new Map();
  for (const c of a) m.set(c, (m.get(c) || 0) - 1);
  for (const c of b) m.set(c, (m.get(c) || 0) + 1);
  const out = [];
  for (const [c, v] of m) if (v !== 0) out.push(c);
  return out;
}

/* Witness phrases the note names, kept as phrases (not normalized). The set is
 * the extraction plan's §2.1 witness regex, extended with the location clause
 * the notes actually carry ("page image, printed page N = archive nN"). */
function witnesses(note) {
  const w = [];
  const push = (s) => { if (s && !w.some((x) => x.startsWith(s) || s.startsWith(x))) w.push(s); };
  let m;
  if ((m = note.match(/1823 parallel(?::\d+)?/))) push(m[0]);
  if ((m = note.match(/page image, printed page \d+ = archive n\d+/))) push(m[0]);
  else if (note.includes('page image')) push('page image');
  if ((m = note.match(/1917 scan, printed page \d+/))) push(m[0]);
  else if (note.includes('1917 scan')) push('1917 scan');
  if ((m = note.match(/Dodds(?:['’]s?)? prop(?:osition)?\.? ?\d+/))) push(m[0]);
  else if (note.includes('Dodds')) push('Dodds');
  if ((m = note.match(/running head/))) push(m[0]);
  if ((m = note.match(/parallel (?:text|edition)/))) push(m[0]);
  if (!w.length && (m = note.match(/printed page[s]? \d+/))) push(m[0]);
  return w;
}

const CONTEXT_RE = /transcription[’']s own context/;

/* Rule 5's assertion pattern: a reading supplied where the note offers no
 * witness and no print evidence. */
const CONJECTURE_RE =
  /it is necessary to (?:read|suppl)|supplied|cannot be (?:read|determined)|invisib|not visible|no witness|editor['’]s (?:reading|emendation)/i;

/* Classify one rule per DATA-MODEL §4.1's ordered decision, with the two
 * documented extensions (damage set, transposition). Returns
 * { type, review, type_evidence, witness }. */
function classify(rule, damage) {
  const { find, replace, class: cls, note } = rule;
  const ws = witnesses(note);
  const witness = ws.length ? ws.join('; ') : null;
  const hasContext = CONTEXT_RE.test(note);

  let type; let review = false; let evidence;

  if (GREEK.test(replace) && !GREEK.test(find)) {
    type = 'transliteration';
    evidence = 'after contains Greek script, before does not (rule 1)';
    // §4.1/plan §2.1: transliteration whose note does not name the page image
    // or scan is judgment, not measurement.
    if (!/page image|scan|printed page/.test(note)) {
      review = true;
      evidence = 'after contains Greek script, before does not (rule 1); note names no page image/scan';
    }
  } else if (find.replace(/\s+/g, '') === replace.replace(/\s+/g, '')) {
    type = 'OCR';
    evidence = 'before and after equal after removing all whitespace (rule 2)';
  } else {
    const diff = diffChars(find, replace);
    if (diff.length === 0) {
      type = 'OCR';
      review = true;
      evidence = 'same character multiset — a transposition; OCR by rule 6 (extension, documented)';
    } else if (diff.every((c) => damage.has(c))) {
      type = 'OCR';
      review = true;
      evidence =
        'differs only in OCR-noise damage characters (' +
        [...new Set(diff)].join('') + ') — the print recovered, not punctuation (extension, documented)';
    } else if (diff.every((c) => isPunctChar(c) && !damage.has(c))) {
      type = 'punctuation';
      evidence = 'differs only in punctuation characters: ' + [...new Set(diff)].join('') + ' (rule 3)';
    } else if (cls === 'opener' || cls === 'digit') {
      type = 'OCR';
      evidence = 'apply class ' + cls + ' (rule 4)';
    } else if (!ws.length && !hasContext && CONJECTURE_RE.test(note)) {
      type = 'conjectural';
      review = true;
      evidence = 'note names no witness and supplies a reading with no print evidence (rule 5)';
    } else {
      type = 'OCR';
      review = true;
      evidence = ws.length
        ? 'default OCR (rule 6); witness ' + ws.join('; ')
        : hasContext
          ? 'default OCR (rule 6); decided by the transcription’s own context'
          : 'default OCR (rule 6)';
    }
  }
  return { type, review, type_evidence: evidence, witness };
}

/* --- --citations: regenerate ONLY the citation strings -----------------------
 * A DOI is minted AFTER the migration (the blog records none), so the seed run
 * cannot carry it; the citation a reader copies must, or the page prints a DOI
 * the string it is read from omits. This mode re-derives `edition.json.citation`
 * and every `versions/<v>/meta.json.citation` from the SAME `citationFor` here
 * below (hoisted) and the DOI already stored in `edition.json`, writing no other
 * field: no ids, no source bytes, no repairs, no readings. It reads ONLY this
 * repo's data/ — the blog is not consulted.
 * Run: node build/migrate.mjs --citations
 *
 * A FROZEN VERSION CITES THE DOI OF ITS OWN STATE. `meta.json.doi` is that
 * version's own DOI, and it WINS over the edition's: a DOI fixes a state, not a
 * text (docs/DOI.md), so once a second version is minted, deriving every
 * version's citation from the EDITION's `doi` would rewrite v1.0.0's citation to
 * name the DOI of a state that is not its own — falsifying the citation of the
 * state the old DOI names. The edition's `doi` is the CURRENT version's DOI, so it
 * is the fallback for exactly that version (the field the seed migration stores
 * it in, where no version carries one). And where the record would leave a
 * citation naming NO DOI or the WRONG one, the run is REFUSED before anything is
 * written: a DOI is a claim about a state, and the generator does not guess one. */
if (process.argv.includes('--citations')) {
  const edsDir = join(DATA, 'editions');
  /* VALIDATE EVERYTHING FIRST, WRITE NOTHING UNTIL IT PASSES. MEASURED
   * 2026-10-07: with current_version moved to a version whose meta.json has no
   * `doi` while edition.json.doi still held the PREVIOUS state's DOI, the loop
   * below wrote that stale DOI into the new current version's citation — the
   * exact falsification this mode exists to prevent, one forgotten manual step
   * away. Every refusal below is therefore decided BEFORE the first write: the
   * run exits non-zero naming the version and both values, and no file moves. */
  const refusals = [];
  const plan = [];
  let n = 0;
  for (const slug of await readdir(edsDir)) {
    const edPath = join(edsDir, slug, 'edition.json');
    if (!existsSync(edPath)) continue;
    const ed = await load(edPath);
    const doi = ed.doi || '';
    const t = { slug: ed.slug, author: ed.author, title: ed.title, translator: ed.translator };
    const se = ed.source_edition || {};
    const vroot = join(edsDir, slug, 'versions');
    const versions = existsSync(vroot) ? (await readdir(vroot)).sort() : [];
    const metas = new Map();
    for (const v of versions) {
      const mPath = join(vroot, v, 'meta.json');
      if (existsSync(mPath)) metas.set(v, await load(mPath));
    }
    /* current_version must RESOLVE: an edition naming a version that is not in
     * versions/ would otherwise have its citation written from the edition's
     * `doi` with no state under it at all. */
    if (!metas.has(ed.current_version)) {
      refusals.push(
        `${slug}: current_version ${JSON.stringify(ed.current_version)} has no versions/${ed.current_version}/meta.json` +
          ` (versions/ holds ${versions.join(', ') || 'nothing'}) — the edition's citation would be written from edition.json.doi ${JSON.stringify(doi)} with no version under it`,
      );
      continue;
    }
    const curMeta = metas.get(ed.current_version);
    const curVersion = curMeta.version || ed.current_version;
    const curDoi = typeof curMeta.doi === 'string' ? curMeta.doi.trim() : '';
    /* (a) THE STALE-EDITION-DOI TRAP: a multi-version edition whose CURRENT
     * version has no `doi` of its own while edition.json.doi is set — that value
     * is by construction some OLDER state's DOI, and the fallback below would
     * write it into the new current version's citation. The legit states pass:
     * a single-version edition (the seed pattern, where the DOI lives at edition
     * level), and the pre-mint window after a bump (the bump protocol clears
     * edition.json.doi, so doi is '' exactly while the new state has nothing
     * minted yet — docs/DOI.md). */
    if (versions.length > 1 && !curDoi && doi) {
      refusals.push(
        `${slug}: the current version ${curVersion} has no "doi" of its own while edition.json.doi is ${JSON.stringify(doi)}` +
          ` — with more than one version minted that value is an OLDER state's DOI, and citing it would name a state ${curVersion} is not.` +
          ` Mint ${curVersion}'s own DOI and write it back (docs/DOI.md), or clear edition.json.doi if nothing is minted for it yet`,
      );
    }
    /* (b) THE EDITION AND ITS CURRENT VERSION MUST AGREE: edition.json.doi IS
     * the current version's DOI (version-probe holds the same), so any pair of
     * differing values — one empty, or two different identifiers — is an
     * edition advertising one state and citing another. */
    if (curDoi && doi !== curDoi) {
      refusals.push(
        `${slug}: edition.json.doi ${JSON.stringify(doi)} and the current version ${curVersion}'s own meta.json.doi ${JSON.stringify(curDoi)} disagree` +
          ` — the edition must name the state it serves; set edition.json.doi to ${JSON.stringify(curDoi)}`,
      );
    }
    /* A FROZEN version of a multi-version edition is by definition a MINTED one
     * (a frozen state is deposited under its own DOI, docs/DOI.md): a frozen
     * version without its own `doi` would leave the loop below with a
     * DOI-less citation, silently. */
    if (versions.length > 1) {
      for (const [v, meta] of metas) {
        const version = meta.version || v;
        if (version === ed.current_version || v === ed.current_version) continue;
        if (!(typeof meta.doi === 'string' && meta.doi.trim())) {
          refusals.push(
            `${slug}: frozen version ${version} has no "doi" of its own — a frozen state of a multi-version edition is a minted one,` +
              ` and its citation would silently carry no DOI. Set versions/${v}/meta.json "doi" (docs/DOI.md) and re-run`,
          );
        }
      }
    }
    plan.push({ slug, edPath, ed, doi, t, se, vroot, versions, metas });
  }
  if (refusals.length) {
    for (const r of refusals) console.error(`[citations] REFUSING: ${r}`);
    console.error(`[citations] ${refusals.length} refusal(s): NOTHING written — a DOI is a claim about a state, and the generator does not guess one (docs/DOI.md)`);
    process.exit(1);
  }
  for (const { slug, edPath, ed, doi, t, se, vroot, versions, metas } of plan) {
    ed.citation = citationFor(t, se, ed.current_version, doi);
    await writeFile(edPath, JSON.stringify(ed, null, 2) + '\n');
    for (const v of versions) {
      const meta = metas.get(v);
      if (!meta) continue;
      const version = meta.version || v;
      const versionDoi = meta.doi != null ? meta.doi : version === ed.current_version ? doi : '';
      meta.citation = citationFor(t, se, version, versionDoi);
      await writeFile(join(vroot, v, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
      n++;
    }
    console.log(`citation: ${slug} -> ${ed.citation}`);
  }
  console.log(`[citations] rewrote ${n} version citation(s) from build/migrate.mjs citationFor`);
  process.exit(0);
}

/* ------------------------------------------------------------ migration -- */

const verifyOnly = process.argv.includes('--verify');
const built = { site: null, editions: {}, graph: null, notes: null };

const shelf = await import(pathToFileURL(join(BLOG, 'tools/library/shelf.mjs')));
const published = shelf.publishedTexts();
if (published.length !== 2) throw new Error(`expected exactly 2 published shelf entries, got ${published.length}`);
const catalogue = await load(join(BLOG, 'tools/catalogue.json'));
const catById = new Map(catalogue.sources.map((s) => [s.id, s]));

const base = await load(join(BLOG, 'tools/library/edits/_base.json'));

const LICENCE_STATEMENT =
  'The transcriptions are public-domain works. The editorial work — repairs, page models, apparatus, notes — is released under CC BY 4.0.';
const CITATION_POLICY =
  'Cite the edition, the version, and the URL. Each edition page carries a formatted citation.' +
  ' Version 1.0.0 of each edition is the migration of the blog library’s served text; the version date is the blog’s own import date, recorded in the version note.';

/* Parse place/imprint/year out of the edition prose, ONLY where it literally
 * appears (the two measured forms: "(Place, YYYY)" and "(Place: Imprint, YYYY)"). */
function parseEditionStatement(statement) {
  const m =
    statement.match(/\(([^():()]+):\s*([^,()]+),\s*(\d{4})\)/) ||
    statement.match(/\(([^():()]+),\s*(\d{4})\)/);
  if (!m) return { place: null, imprint: null, year: null };
  const year = Number(m[3] ?? m[2]);
  const place = m[1].trim();
  const imprint = m[2] && m[3] ? m[2].trim() : null;
  return { place, imprint, year };
}

/* The citation string, per model §3's format:
 *
 *   Author, Title[, trans. Translator] (Place, Year). The Neoplatonic Library,
 *   version <v>[. DOI: <doi>]. <url>
 *
 * NOTE the container is named and then its VERSION, with no `ed.`: in a
 * citation `ed.` abbreviates "edited by" / "edition", and what it introduced
 * here was a version — a bibliographic slip. The version name is spelled out
 * (`version`, not `v.`) so the sentence reads as the library's own, and the
 * URL ends it, which is the address a reader copies. The DOI is the record's
 * IDENTIFIER, so it belongs IN the string (the citable identity) and not added
 * at render time — a page that prints a DOI its own citation string omits is
 * advertising two different citations. Empty when no DOI is minted; the string
 * is byte-identical to the pre-DOI form then. */
function citationFor(t, se, version, doi = '') {
  const head = `${t.author}, ${t.title}` + (t.translator ? `, trans. ${t.translator}` : '');
  const loc = se.place && se.year ? `(${[se.place, se.imprint].filter(Boolean).join(': ')}, ${se.year})` : se.year ? `(${se.year})` : '';
  const id = doi ? ` DOI: ${doi}.` : '';
  return `${head}${loc ? ' ' + loc : ''}. The Neoplatonic Library, version ${version}.${id} https://neoplatonic-library.org/texts/${t.slug}/`;
}

/* Measure `fires` with the blog's own extraction: `extract()` builds the SERVED
 * document (preprocessed blocks — hard-wrapped lines joined, running heads read
 * into markers) and `checkEdits(doc)` counts, per rule, the hits the READER's
 * application produces (editReport: plain substring split/join per block, in
 * rule order). It also enforces the blog's own acceptance rule: a rule with
 * zero hits throws. Counting over the raw source.txt instead is wrong — the
 * extractor's preprocessing is what the find strings are written against. */
async function measureFires(slug, entry) {
  const x = await import(pathToFileURL(join(BLOG, 'tools/library/extract.mjs')));
  const src = x.readEdition(slug);
  const doc = x.extract(src, { entry, sha256: x.sha256(src) });
  const report = x.checkEdits(doc); // throws if any rule fires 0 times
  const byFind = new Map(report.map((r) => [r.find, r.hits]));
  const { edits } = x.loadEdits(slug);
  return edits.map((e) => {
    const n = byFind.get(e.find);
    if (n === undefined) throw new Error(`${slug}: editReport has no row for ${JSON.stringify(e.find)}`);
    return n;
  });
}

const reviewIndex = {}; // slug -> [{id, type, type_evidence}]
const typeCounts = {}; // slug -> {type: n}

for (const t of published) {
  const slug = t.slug;
  const dir = join(BLOG, 'content/library', slug);
  const imports = await load(join(dir, 'import.json'));
  const editsFile = await load(join(BLOG, 'tools/library/edits', slug + '.json'));
  if (editsFile.slug !== slug) throw new Error(`${slug}: edits file names ${editsFile.slug}`);
  if (editsFile.base !== '_base.json') throw new Error(`${slug}: unexpected base ${editsFile.base}`);

  const sourceBuf = await readFile(join(dir, 'source.txt'));
  const sourceText = sourceBuf.toString('utf8');

  // --- repairs -----------------------------------------------------------
  const damage = new Set(base.damage.filter((c) => !(DAMAGE_EXCLUDE[slug] || []).includes(c)));
  const fires = await measureFires(slug, t);
  if (fires.some((n) => n === 0)) throw new Error(`${slug}: a rule fires 0 times in the served document — impossible after checkEdits`);
  const rules = editsFile.edits.map((r, i) => {
    const c = classify(r, damage);
    (typeCounts[slug] ||= {})[c.type] = ((typeCounts[slug] ||= {})[c.type] || 0) + 1;
    if (c.review) (reviewIndex[slug] ||= []).push({ id: i + 1, type: c.type, type_evidence: c.type_evidence });
    return {
      id: `${slug}:r${String(i + 1).padStart(4, '0')}`,
      type: c.type,
      apply: r.class,
      location: {
        find: r.find,
        page: null, // no per-rule page/leaf is recorded in the blog data
        leaf: null,
      },
      before: r.find,
      after: r.replace,
      rationale: r.note,
      date: null, // the rule files carry no date; not guessed
      witness: c.witness,
      fires: fires[i],
      join: r.join === true,
      type_evidence: c.type_evidence,
      review: c.review,
    };
  });

  const repairs = {
    slug,
    version: '1.0.0',
    policy: base.policy,
    damage: base.damage.filter((c) => !(DAMAGE_EXCLUDE[slug] || []).includes(c)),
    rules,
  };

  // --- edition.json -------------------------------------------------------
  const se = parseEditionStatement(t.edition);
  const yearConflict = se.year !== null && se.year !== t.year ? ` (parsed year ${se.year} differs from shelf year ${t.year})` : '';
  const scan = existsSync(join(dir, 'scan.json')) ? await load(join(dir, 'scan.json')) : null;
  const wit = existsSync(join(dir, 'witnesses.json')) ? await load(join(dir, 'witnesses.json')) : null;

  const scanNote = [];
  if (imports.extract) {
    scanNote.push(imports.extract.why);
    scanNote.push(
      `The transcription is lines ${imports.extract.lines[0]}–${imports.extract.lines[1]} of that whole file (${imports.extract.whole_bytes.toLocaleString('en')} bytes, ${imports.extract.whole_lines.toLocaleString('en')} lines).`,
    );
  }
  if (scan) {
    scanNote.push(
      `Page images: archive.org item '${scan.item}', leaf n = printed page + ${scan.archiveOffset}, MEASURED at both ends of the work (${scan.verified.map((v) => `n${v.archive} = ${v.evidence}`).join('; ')}); the work occupies printed pages ${scan.firstPage}–${scan.lastPage}.`,
    );
  }
  if (!imports.extract) {
    scanNote.push(
      `No extract block is recorded in the blog's import.json: the served transcription was imported from the shelf file '${t.file}.txt' (${imports.bytes.toLocaleString('en')} bytes, imported ${imports.imported}). No whole-file sha256 for the archive item is recorded anywhere in the blog data.`,
    );
  }
  if (wit) {
    scanNote.push(
      `Witnesses held beside the transcription: ` +
        wit.witnesses.map((x) => `${x.name} (${x.why})`).join(' ') +
        ' The model has no dedicated field for this record; its evidence is quoted per rule in repairs.json (rationale/witness).',
    );
  }

  /* A DOI is minted after the migration (the blog records none); a re-run must
   * not drop it, and the citation must keep carrying it. Read what this edition
   * already records. */
  const priorEdPath = join(DATA, 'editions', slug, 'edition.json');
  const doi = (existsSync(priorEdPath) ? (await load(priorEdPath)).doi : '') || '';

  const edition = {
    slug: t.slug,
    title: t.title,
    author: t.author,
    translator: t.translator === '' ? null : t.translator,
    lang: t.lang,
    source_edition: {
      statement: t.edition,
      place: se.place,
      year: se.year ?? null,
      imprint: se.imprint,
    },
    scan_source: {
      archive_id: t.item ?? null,
      url: imports.extract ? imports.extract.url : t.item ? `https://archive.org/download/${t.item}/` : '',
      whole_sha256: imports.extract ? imports.extract.whole_sha256 : null,
      note: scanNote.join(' '),
    },
    current_version: '1.0.0',
    licence: { text: 'public-domain', editorial: 'CC-BY-4.0', statement: LICENCE_STATEMENT },
    citation: citationFor(t, se, '1.0.0', doi),
    doi,
    cat: t.cat,
    readings: [], // no derivation is run by the migration; see MIGRATION-NOTES
    repair_state: t.repair?.state ?? null,
  };
  if (se.year !== t.year && se.year !== null) {
    console.log(`WARN ${slug}: source_edition.year${yearConflict}`);
  }

  // --- version dir --------------------------------------------------------
  const vdir = join(DATA, 'editions', slug, 'versions', '1.0.0');
  if (!verifyOnly) {
    await mkdir(vdir, { recursive: true });
    await copyFile(join(dir, 'source.txt'), join(vdir, 'source.txt')); // EXACT bytes
    await copyFile(join(BLOG, 'tools/library/edits/_base.json'), join(vdir, 'base.json'));
    await writeFile(join(vdir, 'repairs.json'), JSON.stringify(repairs, null, 2) + '\n');
    await writeFile(join(DATA, 'editions', slug, 'edition.json'), JSON.stringify(edition, null, 2) + '\n');
  }

  const copiedSha = sha256(sourceBuf); // of the bytes we copied
  const meta = {
    version: '1.0.0',
    date: imports.imported, // the blog's own import date, stated as the convention in site.json citation_policy
    note: 'migrated from blog.jaye.ch’s library at v1.0.0; the version date is the transcription’s import date on the blog',
    source_sha256: copiedSha,
    supersedes: null,
    citation: citationFor(t, se, '1.0.0', doi),
  };
  if (!verifyOnly) await writeFile(join(vdir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

  built.editions[slug] = { edition, repairs, meta, sourceSha: copiedSha, imports };
}

// --- site.json -------------------------------------------------------------
if (!verifyOnly) {
  await mkdir(DATA, { recursive: true });
  await writeFile(
    join(DATA, 'site.json'),
    JSON.stringify(
      {
        name: 'The Neoplatonic Library',
        host: 'neoplatonic-library.org',
        tagline: '',
        licence: { texts: 'public-domain', editorial: 'CC-BY-4.0', statement: LICENCE_STATEMENT },
        citation_policy: CITATION_POLICY,
        blog: {
          url: 'https://blog.jaye.ch',
          relation: 'The texts stand on their own; the essays are one reader’s reading.',
        },
      },
      null,
      2,
    ) + '\n',
  );
}

// --- graph seed --------------------------------------------------------------
const textNodes = [];
const authorNodes = [];
const editionNodes = [];
const edges = [];
const authoredText = [];

const authorKey = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
let e = 0;
for (const t of published) {
  editionNodes.push({ id: `edition:${t.slug}`, type: 'edition', label: `${t.translator || t.author} ${t.year}`, slug: t.slug });
  for (const catId of t.cat) {
    const work = catById.get(catId);
    textNodes.push({ id: `text:${catId}`, type: 'text', label: work ? work.title : t.title, slug: null });
    if (t.author) {
      authorNodes.push({ id: `author:${authorKey(t.author)}`, type: 'author', label: t.author, slug: null });
      edges.push({ id: `e${String(++e).padStart(4, '0')}`, from: `author:${authorKey(t.author)}`, to: `text:${catId}`, type: 'wrote' });
    }
    edges.push({ id: `e${String(++e).padStart(4, '0')}`, from: `edition:${t.slug}`, to: `text:${catId}`, type: 'translates' });
  }
  // The Cave's catalogue work does not exist in the blog's catalogue.json
  // (MEASURED: no porphyry entry at all), so its text node id is AUTHORED at
  // this migration and awaits confirmation of the stable key.
  if (t.cat.length === 0) {
    const key = authorKey(t.title);
    authoredText.push(`text:${key}`);
    textNodes.push({ id: `text:${key}`, type: 'text', label: t.title, slug: null });
    if (t.author) {
      authorNodes.push({ id: `author:${authorKey(t.author)}`, type: 'author', label: t.author, slug: null });
      edges.push({ id: `e${String(++e).padStart(4, '0')}`, from: `author:${authorKey(t.author)}`, to: `text:${key}`, type: 'wrote' });
    }
    edges.push({ id: `e${String(++e).padStart(4, '0')}`, from: `edition:${t.slug}`, to: `text:${key}`, type: 'translates' });
  }
}
const seen = new Set();
const nodes = [];
for (const n of [...editionNodes, ...textNodes, ...authorNodes]) {
  if (seen.has(n.id)) continue;
  seen.add(n.id);
  nodes.push(n);
}
const graph = { nodes, edges };
if (!verifyOnly) {
  await mkdir(join(DATA, 'graph'), { recursive: true });
  await writeFile(join(DATA, 'graph/graph.json'), JSON.stringify(graph, null, 2) + '\n');
}

/* ---------------------------------------------------------- verification -- */

const lines = [];
const check = (ok, label) => lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}`);

for (const t of published) {
  const slug = t.slug;
  const src = await load(join(BLOG, 'tools/library/edits', slug + '.json'));
  const b = built.editions[slug];
  check(src.edits.length === b.repairs.rules.length, `${slug}: ${b.repairs.rules.length} rules migrated = jq '.edits|length' (${src.edits.length})`);
  const ids = new Set(b.repairs.rules.map((r) => r.id));
  check(ids.size === b.repairs.rules.length, `${slug}: all repair ids unique`);
  check(
    b.repairs.rules.every((r) => ['OCR', 'punctuation', 'transliteration', 'conjectural'].includes(r.type)),
    `${slug}: every type in {OCR, punctuation, transliteration, conjectural}`,
  );
  check(
    b.repairs.rules.every((r) => r.before != null && r.after != null),
    `${slug}: every before/after non-null`,
  );
  check(
    b.repairs.rules.every((r) => r.id === `${slug}:r${r.id.slice(-4)}`) &&
      b.repairs.rules.every((r, i) => r.id === `${slug}:r${String(i + 1).padStart(4, '0')}`),
    `${slug}: ids are <slug>:rNNNN in rule order, 1-based, no renumbering`,
  );
  const servedSha = sha256(await readFile(join(DATA, 'editions', slug, 'versions/1.0.0/source.txt')));
  check(servedSha === b.meta.source_sha256, `${slug}: meta.source_sha256 matches the copied source.txt bytes (${servedSha.slice(0, 12)}…)`);
  check(b.meta.source_sha256 === b.imports.sha256, `${slug}: copied source.txt sha256 also matches the blog import.json's own record`);
  const ed = b.edition;
  check(!!ed.current_version && ed.current_version.length > 0, `${slug}: current_version non-empty`);
  check(!!ed.licence && !!ed.licence.text && !!ed.licence.editorial && !!ed.licence.statement, `${slug}: licence complete`);
  check(!!ed.citation && ed.citation.length > 0, `${slug}: citation non-empty`);
  const canon = b.repairs.rules.every((r) =>
    Object.prototype.hasOwnProperty.call(r, 'id') && Object.prototype.hasOwnProperty.call(r, 'apply') &&
    Object.prototype.hasOwnProperty.call(r, 'type') && Object.prototype.hasOwnProperty.call(r, 'fires') &&
    Object.prototype.hasOwnProperty.call(r, 'join') && Object.prototype.hasOwnProperty.call(r, 'type_evidence') &&
    Object.prototype.hasOwnProperty.call(r, 'review'),
  );
  check(canon, `${slug}: every rule carries the model §4 fields (type, apply, join, fires, type_evidence, review, location{find,page,leaf}, before, after, rationale, date, witness)`);
}

check(
  graph.edges.every((e2) => graph.nodes.some((n) => n.id === e2.from) && graph.nodes.some((n) => n.id === e2.to)),
  `graph: every edge endpoint is a declared node id (${graph.nodes.length} nodes, ${graph.edges.length} edges)`,
);
const tcount = Object.fromEntries(published.map((t) => [t.slug, typeCounts[t.slug]]));
check(
  Object.values(tcount).flatMap((c) => Object.values(c)).reduce((a, b) => a + b, 0) ===
    published.reduce((a, t) => a + built.editions[t.slug].repairs.rules.length, 0),
  `type counts sum to the rule totals (${JSON.stringify(tcount)})`,
);

const verifyOut = lines.join('\n');

/* ------------------------------------------------------- MIGRATION-NOTES -- */

function reviewSection(slug) {
  const list = reviewIndex[slug] || [];
  const out = [];
  out.push(`### ${slug}`);
  out.push('');
  out.push(`Rules whose \`type\` was NOT fixed by DATA-MODEL §4.1 rules 1–4 — every one carries \`review: true\` in repairs.json: **${list.length} of ${built.editions[slug].repairs.rules.length}**. Type distribution: ${JSON.stringify(typeCounts[slug])}.`);
  out.push('');
  for (const item of list) {
    const r = built.editions[slug].repairs.rules[item.id - 1];
    const wit = r.witness ? ` · witness: ${r.witness}` : ' · witness: none';
    out.push(`- \`r${String(item.id).padStart(4, '0')}\` · **${r.type}** · \`${JSON.stringify(r.location.find)}\` → \`${JSON.stringify(r.after)}\`${wit} · ${item.type_evidence}`);
  }
  out.push('');
  return out.join('\n');
}

const notes = [];
notes.push(`# Migration notes — the blog library → neoplatonic-library data

Migration run: ${TODAY}. Script: \`build/migrate.mjs\`. Sources read (READ-ONLY)
from \`~/enlighten\`: \`tools/library/shelf.mjs\`,
\`tools/library/edits/<slug>.json\` + \`_base.json\`,
\`content/library/<slug>/{source.txt,import.json,scan.json,witnesses.json}\`,
\`tools/catalogue.json\`. Nothing in the blog repo was modified.

Scope: the 2 published shelf entries only
(\`proclus-elements-of-theology-taylor-1816\`,
\`porphyry-on-the-cave-of-the-nymphs-taylor-1917\`). The 37 held-back entries are
NOT migrated by this run.

## Fields with no honest source (left empty per model §0.4)

| field | state | why |
|---|---|---|
| \`site.json .tagline\` | \`""\` | no sourced site tagline exists in the blog; not invented |
| \`edition.json .doi\` | \`""\` | no Zenodo DOI minted yet (model §3: EMPTY until then) |
| \`edition.json .readings[]\` | seeded — see "Readings" below | not produced by \`build/migrate.mjs\`; re-derived from the blog's own citation derivation and frozen by \`tools/migrate-readings.mjs\` |
| \`repairs.json .rules[].date\` | \`null\` | the rule files record NO per-rule date; not guessed. (The version date in meta.json is the blog's own import date, stated as a convention in \`site.json.citation_policy\`) |
| \`repairs.json .rules[].location.page/leaf\` | \`null\` | no per-rule page/leaf exists in the blog data. The edition-level page arithmetic (proclus: leaf n = printed page + 505, measured at both ends) is recorded in \`edition.json.scan_source.note\` |
| proclus \`scan_source.url/whole_sha256\` | sourced from \`import.json.extract\` | direct (the work is lines 40345–47601 of a 2.49 MB volume file) |
| porphyry \`scan_source.url\` | \`https://archive.org/download/onthecaveoftheny00porpuoft/\` — RECONSTRUCTED, flagged | \`import.json\` has no extract block; the URL is built from the shelf's measured \`item\` id by archive.org's canonical download scheme |
| porphyry \`scan_source.whole_sha256\` | \`null\` | no honest source: the blog never recorded the archive item's whole-file hash for this edition |
| proclus \`source_edition.imprint\` | \`null\` | the statement's imprint form is "(London, 1816)" — no imprint is printed there |
| porphyry \`source_edition.place/year/imprint\` | London / 1917 / John M. Watkins | parsed from the statement's "(London: John M. Watkins, 1917)", which literally appears |
| graph: porphyry text node | \`text:on-the-cave-of-the-nymphs\` — AUTHORED, flagged | the Cave has NO entry in the blog's \`catalogue.json\` (grep: 0 hits for porphyry/cave), so no catalogue id exists; the node id is authored from the work's title and awaits confirmation of the stable key |
| graph: no \`cites\`/\`derives_from\`/\`commentary_on\`/\`translated_by\` edges | — | the blog derives those from reading posts' footnotes via \`citations()\`; the migration does not run that derivation. The graph seed is SPARSE: 2 edition nodes, 2 author nodes, 2 text nodes, 4 edges (\`wrote\` ×2, \`translates\` ×2) |
| graph: no passage nodes | — | the extraction plan's default (emit the 211 proclus proposition nodes) is an authoring decision, explicitly out of this seed's scope |
| witnesses.json (porphyry) | no model field | the 1823-parallel witness record has no slot in model §3; its per-rule evidence is quoted in repairs.json \`rationale\`/\`witness\`, and the record itself is described in \`edition.json.scan_source.note\` |

## Readings (model §6, extraction plan §2.4)

\`edition.readings[]\` is HAND-SEEDED: the attachment is derived on the blog and
frozen here, so the build never reads a post. Script:
\`tools/migrate-readings.mjs\` — the one migration script that reads the blog's
posts. It re-implements the blog's own derivation (\`citations()\` in the blog's
\`tools/build.mjs\`): a reading is a post whose FOOTNOTE DEFINITIONS match a
\`tools/catalogue.json\` work the edition's \`cat\` names, **plus** any post whose
markdown links \`/library/<slug>/\` (a direct statement about the edition that
needs no catalogue entry). The result is written sorted by slug.

RUN ORDER, stated because the two scripts are separate: this migration writes
\`readings: []\` (it runs no derivation), so the re-seed
\`node tools/migrate-readings.mjs --write\` must follow it, and only then is the
frozen list back.

MEASURED (re-derived ${TODAY}, reproducing the plan §2.4 measurement —
\`node tools/migrate-readings.mjs --from /home/jaye/enlighten\`):

| edition | \`cat\` | readings | how each was reached |
|---|---|---|---|
| \`proclus-elements-of-theology-taylor-1816\` | \`["proclus-elements-of-theology"]\` | \`["proclus-elements-of-theology", "proclus-theology-of-plato"]\` | both cite catalogue work \`proclus-elements-of-theology\` in their footnotes |
| \`porphyry-on-the-cave-of-the-nymphs-taylor-1917\` | \`[]\` | \`["porphyry-cave-of-the-nymphs"]\` | \`cat\` is empty (the Cave has no \`catalogue.json\` entry), so the reading comes from the 21 \`/library/porphyry-on-the-cave-of-the-nymphs-taylor-1917/#sN\` links in that post |

The plan §2.4 measurement is reproduced exactly (proclus ← 2, porphyry ← 1, the
same post identities). ONE ORDERING NOTE, not a disagreement: the plan lists the
proclus pair alphabetically (\`elements-of-theology\` first), and that is the order
written here; the blog's own edition page renders the same two in post-index
order (\`theology-of-plato\` first — index 59 against 60). The SET is identical;
the blog's order is its posting order, the library's is its own, and nothing
depends on which.

Where a reading's subject is this text, the library renders the slug as a link
OUT to \`https://blog.jaye.ch/<slug>/\` (model §6) — the essay's title is the
blog's to state, so no title is invented here.

## Classification decisions (DATA-MODEL §4.1 rules 1–6)

Two documented honest extensions, both carried \`review: true\`:

1. **Damage characters are not punctuation.** Rule 3 says "differ only in
   punctuation characters". The blog MEASURES an OCR-noise damage set
   (\`_base.json.damage\`, per edition minus \`extract.mjs\` TEXT_RULES
   \`damageExclude\`: proclus prints \`*\` as a footnote marker and \`&\` as an
   ampersand — the print's own characters). A rule whose only difference is a
   damage character recovered the print's word — §4.1's definition of OCR —
   and is typed \`OCR\`, not \`punctuation\`. The base policy's own words: marking a
   printed apostrophe or full stop as damage "would be a false claim". All such
   rules are in the review worklist below.
2. **Transpositions.** One rule ("former indeed accoridng" → "former indeed
   according") has the same character multiset on both sides — a letter swap,
   OCR by rule 6, \`review: true\`.

\`fires\` is MEASURED with the blog's own machinery: the migration runs the
blog's \`extract()\` over the transcription to build the SERVED document (the
preprocessing the find strings are written against) and counts, per rule, the
hits the reader's application produces (\`editReport\`/\`checkEdits\`: plain
substring split/join per served block, in rule order). The blog's own
acceptance gate (\`checkEdits\`) guarantees every rule fires ≥ 1 time, and the
migration re-runs it: a rule firing 0 times FAILS the migration.

## Review worklist`);

notes.push(reviewSection('proclus-elements-of-theology-taylor-1816'));
notes.push(reviewSection('porphyry-on-the-cave-of-the-nymphs-taylor-1917'));

notes.push(`## Verification

Command:

\`\`\`sh
node build/migrate.mjs && node build/migrate.mjs --verify
\`\`\`

Result (${TODAY}):

\`\`\`
${verifyOut}
\`\`\`
`);
if (!verifyOnly) await writeFile(join(DOCS, 'MIGRATION-NOTES.md'), notes.join('\n') + '\n');

console.log(verifyOut);
console.log(`\nmigrated: ${published.length} editions, review-listed rules: ${published.map((t) => (reviewIndex[t.slug] || []).length).join(' + ')} = ${published.reduce((a, t) => a + (reviewIndex[t.slug] || []).length, 0)}`);
