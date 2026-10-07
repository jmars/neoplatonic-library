#!/usr/bin/env node
/**
 * tools/witness-import-pg.mjs — import a PROJECT GUTENBERG volume of the same
 * print as a WITNESS of an edition, and record what it is and what it is NOT.
 *
 *     node tools/witness-import-pg.mjs <slug> --from DIR [--dry-run]
 *
 * WHY NOT `--import` IN tools/extract.mjs. That importer takes a file from the
 * SHELF (`$LIBRARY_SHELF`, the directory of downloaded texts the repo already
 * holds) and copies it VERBATIM, recording the sha256 of the bytes it copied, so
 * the witness file and the shelf file are the same bytes and a rule's evidence
 * can be re-checked against either. A PG volume is not that shape: it arrives
 * over the network wrapped in a licence header and a footer, and the bytes that
 * belong in the library are the work BETWEEN the two PG markers — so the stored
 * file is NOT the fetched file, its sha256 is not PG's, and the fetch itself
 * (url, byte count, PG's own sha256) has to be recorded beside it or the
 * provenance is lost. That is a different import, and it is this one.
 *
 * WHAT IS RECORDED, AND WHAT IS DELIBERATELY ABSENT. A witness record's `model`
 * block describes a LEAF MODEL — the `covers`/`leaves`/`pages`/`images` an
 * item's own `_djvu.xml` gives, which is how `tools/witness-unsure.mjs` puts a
 * copy's printed page beside ours. A RE-FLOWED text has no leaf, no page and no
 * line: it is a WORD-LEVEL witness, and it carries no `model` block at all. The
 * field is OMITTED rather than set to an empty one, because a `model` key — even
 * `null` — reads as "this witness has a page model, of unknown extent" to every
 * reader of the record, and the honest statement is a different one. It is made
 * in `form` below, in words, and the tools that would SKIP such a witness say so
 * at the place they skip it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('-')) || 'proclus-theology-of-plato-taylor-1816';
const LIBRARY = join(ROOT, 'data', 'editions', slug);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const dry = args.includes('--dry-run');
const fromDir = opt('from', '/var/tmp/pgsrc');

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/* THE VOLUMES, PINNED. `raw_sha256`/`raw_bytes` are the file PG serves TODAY and
 * the numbers the fetch was verified against; `start`/`end` are the two marker
 * lines that bound the work. A volume whose bytes have changed upstream is
 * REFUSED rather than imported: the record's evidence is a sha256, and silently
 * importing other bytes under it would make the record a lie. */
const VOLUMES = [
  {
    ebook: 77393,
    volume: 'vol. 1 of 2',
    name: 'gutenberg-77393-vol1',
    file: 'pg77393.txt',
    url: 'https://www.gutenberg.org/cache/epub/77393/pg77393.txt',
    released: '2025-12-03',
    raw_bytes: 1177047,
    raw_sha256: '243e2cd63e2b162bacaba357d04ed1c340f0947273c1b53728b59dceb34789ce',
    covers: 'vol. I of the 1816 print — its printed pp. 1-425, the edition’s own vol. I half (Books I-V)',
  },
  {
    ebook: 78800,
    volume: 'vol. 2 of 2',
    name: 'gutenberg-78800-vol2',
    file: 'pg78800.txt',
    url: 'https://www.gutenberg.org/cache/epub/78800/pg78800.txt',
    released: '2026-06-02',
    raw_bytes: 1352533,
    raw_sha256: '36d17e60316c4e5632d7bf5612faaab083ac2c30152d7f1b67e1452a602dd904',
    covers:
      'vol. II of the 1816 print — its printed pp. 1-299+ to the work’s close, and the ONLY witness this library holds of it: Books VI-VII stand in no other copy but the source transcription, and the two further archive.org copies are vol. I only',
  },
];

const CREDIT =
  'Karin Spence and the Online Distributed Proofreading Team at https://www.pgdp.net (This book was produced ' +
  'from images made available by the HathiTrust Digital Library.)';
const PRINT = 'London: Law and Co., 1816 — the same print this edition is edited from';
const LICENCE =
  'The 1816 print is public domain. The FILE is a Project Gutenberg eBook (PG), which is its own edition: PG ' +
  'releases it under the Project Gutenberg License (United States) with the header and footer carrying the ' +
  'terms, and this library holds it under those terms — the boilerplate is not stored, the work itself is, ' +
  'the PG identity of the volume (ebook number, release date, credit, url) is recorded here and PG’s own ' +
  'sha256 of the fetched file is recorded beside it, so the text stays traceable to the PG edition it is. ' +
  'The witness files are evidence, never served: the build does not read them (tools/extract.mjs reads ' +
  'witnesses.json for a rule’s evidence path only), and no witness text is published by this repo.';

const EDITION_FILE = join(LIBRARY, 'witnesses.json');
const doc = JSON.parse(readFileSync(EDITION_FILE, 'utf8'));
doc.witnesses = doc.witnesses || [];

const today = new Date().toISOString().slice(0, 10);
const added = [];

for (const v of VOLUMES) {
  const src = join(fromDir, v.file);
  if (!existsSync(src)) {
    console.error(`pg-import: ${src} is not on disk — fetch it first:\n  curl -o ${src} ${v.url}`);
    process.exit(2);
  }
  const raw = readFileSync(src);
  const rawSha = sha256(raw);
  if (rawSha !== v.raw_sha256 || raw.length !== v.raw_bytes) {
    console.error(
      `pg-import: the ${v.volume} file at ${src} is not the bytes this import was verified against.\n` +
        `  recorded: ${v.raw_sha256} (${v.raw_bytes} bytes)\n  on disk:  ${rawSha} (${raw.length} bytes)\n` +
        `  Nothing was written — a witness record names bytes, and these are other bytes.`,
    );
    process.exit(2);
  }

  /* THE TRIM. Text before the START marker and after the END marker is the PG
   * licence, the header, the donation addresses and the small print: PG's
   * furniture, not the 1816 work. The marker LINES THEMSELVES ARE KEPT — they
   * are one line each, they name the ebook they bound, and keeping them means
   * the stored file states its own provenance and its own boundary instead of
   * leaving the trim to this script's word. Everything between the two markers
   * is otherwise byte-identical to what PG serves. */
  const startRe = /^\*\*\* START OF THE PROJECT GUTENBERG EBOOK .* \*\*\*\r?$/m;
  const endRe = /^\*\*\* END OF THE PROJECT GUTENBERG EBOOK .* \*\*\*\r?$/m;
  const sm = startRe.exec(raw.toString('utf8'));
  const em = endRe.exec(raw.toString('utf8'));
  if (!sm || !em || em.index < sm.index) {
    console.error(`pg-import: the ${v.volume} file carries no START/END marker pair — refusing to guess a trim`);
    process.exit(2);
  }
  const startAt = sm.index;
  const endAt = em.index + em[0].length;
  const kept = raw.subarray(startAt, endAt);
  const head = raw.subarray(0, startAt);
  const tail = raw.subarray(endAt);
  const keptSha = sha256(kept);

  const rec = {
    name: v.name,
    /* `shelf` is KEPT ABSENT on purpose (see the header): there is no shelf file
     * these bytes came from — they came over the network and were trimmed — and
     * a `shelf` naming a file that is not on the shelf would break the one
     * invariant the field carries (witness bytes ARE the shelf file's bytes). */
    sha256: keptSha,
    bytes: kept.length,
    why:
      `the ${v.volume} of the SAME 1816 print, HUMAN-PROOFREAD (Distributed Proofreaders, via Project ` +
      `Gutenberg eBook #${v.ebook}): it covers ${v.covers}. An independent reading of the same pages ` +
      `this edition transcribes — not another OCR pass — so where this edition's transcription is ` +
      `damaged and PG reads the place cleanly, PG settles the READING (never the typography: it is ` +
      `re-flowed and editorially normalised, and it carries no page, line or leaf model).`,
    imported: today,
    source: {
      ebook: v.ebook,
      volume: v.volume,
      url: v.url,
      released: v.released,
      credit: CREDIT,
      print: PRINT,
      fetched: {
        bytes: raw.length,
        sha256: rawSha,
        note: 'PG’s own bytes, as fetched. The STORED file is the trim of these bytes below, so its sha256 is not PG’s.',
      },
      trim: {
        rule: 'from the *** START OF THE PROJECT GUTENBERG EBOOK … *** line through the *** END OF … *** line, both kept',
        trimmed_before_marker_bytes: head.length,
        trimmed_after_marker_bytes: tail.length,
        head_first_line: head.toString('utf8').split('\n')[0].trim(),
        stored_bytes: kept.length,
        stored_sha256: keptSha,
      },
      licence: LICENCE,
    },
    /* What this witness can and cannot witness, in words, because the record
     * shape has no field for it and `model` would be the wrong one. */
    form: {
      reflowed: true,
      witness_level: 'word',
      no_model_block:
        'THIS RECORD HAS NO `model` BLOCK, AND THAT IS THE MEASUREMENT. Every other witness here carries one: ' +
        'the leaf model of an archive.org item’s own _djvu.xml (covers/leaves/pages/images), which is what ' +
        'places a copy’s printed page beside ours. Project Gutenberg gives a RE-FLOWED READING TEXT — the ' +
        'line breaks are PG’s, the pages are not marked, and there is no leaf to point at — so it has no page ' +
        'model to record and none is invented. This witness is WORD-LEVEL ONLY: it can say whether a ' +
        'passage’s WORDS are in this volume and what they are there, and it can settle a reading by ' +
        'fingerprinting a token run that occurs exactly once (tools/pg-locate.mjs). It canNOT witness a ' +
        'printed page number, a running head, a leaf, a line, or a hyphenation at line end, and it cannot ' +
        'settle a page/leaf question (e.g. “chap. nr.” vs “CHAP. IV.”).',
      tools_that_skip_it_deliberately: [
        'tools/witness-unsure.mjs filters `witnesses` by `w.model` (the page-image route) — a witness with no leaf model has no page to fetch, so it is EXCLUDED there by name, not by accident.',
        'tools/vision-unsure.mjs takes the FIRST witness in this file that has a file on disk as “the witness” for its corroboration test — so ORDER MATTERS, and these two are appended LAST: the witness that tool reads is unchanged by this import.',
        'tools/vocab.mjs and tools/witness-unsure.mjs read EVERY witness’s text for the print’s own vocabulary, so these two volumes WIDEN that vocabulary (see the PROGRESS observation of 2026-10-07 in the handoff record for the measured size of the change).',
        'tools/extract.mjs witnessPath() matches a witness by the SHELF filename a rule names — PG witnesses have none, so no existing rule’s evidence path changes.',
        'tools/divisions.mjs reads a witness only where --witness FILE names one explicitly; it never reads this file.',
        'tools/shelf.mjs and build/migrate.mjs read this record for its prose (name/why), not for a model.',
      ],
    },
  };

  const prev = doc.witnesses.find((w) => w.name === v.name);
  if (prev) {
    if (prev.sha256 !== keptSha) {
      console.error(
        `pg-import: the witness "${v.name}" is already recorded with OTHER bytes (${prev.sha256.slice(0, 12)}… vs ` +
          `${keptSha.slice(0, 12)}…) — nothing was overwritten; a reading may have been decided from the old bytes.`,
      );
      process.exit(3);
    }
    console.log(`pg-import: ${v.name} already imported, unchanged (${keptSha.slice(0, 12)}…)`);
    continue;
  }

  const dest = join(LIBRARY, 'witnesses', `${v.name}.txt`);
  if (!dry) {
    mkdirSync(join(LIBRARY, 'witnesses'), { recursive: true });
    writeFileSync(dest, kept);
    doc.witnesses.push(rec);
  }
  added.push(rec);
  console.log(
    `pg-import: PG #${v.ebook} (${v.volume}) ${raw.length} B ${rawSha.slice(0, 12)}… -> ${v.name}.txt ` +
      `${kept.length} B ${keptSha.slice(0, 12)}… (trimmed ${head.length} B head, ${tail.length} B tail)`,
  );
}

if (!dry && added.length) {
  writeFileSync(EDITION_FILE, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`pg-import: ${added.length} witness record(s) appended to ${EDITION_FILE} (${doc.witnesses.length} total)`);
}
