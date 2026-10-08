#!/usr/bin/env node
/**
 * tools/version-probe.mjs — the version layout and the immutability promise
 * (extraction plan §6.2, model §3.1).
 *
 * WHAT IT ASSERTS, and what would break each:
 *
 *  1. every version's `/texts/<slug>/v/<semver>/` exists and is a page; its
 *     `/t` and `/plain` exist too;
 *  2. the version's `source.txt` is the bytes `meta.json.source_sha256` records,
 *     and that sha256 is also the sha256 the build reports in corpus.json — a
 *     version edited in place fails here;
 *  3. `/plain` IS the plain text of that version: recomputed here from
 *     source.txt + repairs.json with the extractor, and compared byte for byte
 *     (the same check the extract smoke makes, from the other side);
 *  4. while a version IS the current one, the bare `/texts/<slug>/t` is
 *     byte-identical to the pinned `/v/<semver>/t` — one extraction, two URLs;
 *  5. the pinned page carries the version's OWN citation string from meta.json
 *     (a citation to v1.0.0 must keep naming v1.0.0), and a pinned page that is
 *     not current says so and points at the current one;
 *  5a. THE DOI A VERSION'S CITATION CARRIES IS THAT VERSION'S OWN, and every
 *     version this repo has MINTED a DOI for still carries it — a DOI fixes a
 *     state, not a text (docs/DOI.md), so a generator that derives every
 *     version's citation from the edition's current `doi` would silently rewrite
 *     v1.0.0's citation to name the DOI of a state that is not its own. The
 *     minted table below is the record those identifiers are held to, and the
 *     check FAILS if a frozen version's citation stops carrying its own DOI;
 *  5b. a FROZEN version of a multi-version edition carries its OWN `meta.json.doi`
 *     (a frozen state is a minted one), it DIFFERS from the current version's, and
 *     it is the MINTED table's row for that state — a DOI-less frozen citation and
 *     a forgotten table row both fail here instead of passing silently;
 *  6. THE MUTATION TEST (§6.2, the immutability asymmetry): a fake v1.1.0 with a
 *     CHANGED SOURCE BYTE is added in a scratch copy of the repo, the build runs
 *     there, and v1.0.0's emitted bytes must be UNCHANGED. The mutation is
 *     asserted to have taken effect (the scratch tree's bare page serves v1.1.0)
 *     — a mutation that changed nothing would make the comparison vacuous.
 *
 * Run against a built tree:
 *
 *     node build/build.mjs && node tools/version-probe.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extract,
  plainText,
  serialiseDoc,
  sha256,
  readEdition,
  readMeta,
  versionDir,
  LIBRARY_DIR,
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
  console.error('version-probe: site/dist is not built — run node build/build.mjs first');
  process.exit(1);
}

const served = TEXTS.filter(isPublished);
const versionsOf = (slug) =>
  readdirSync(join(LIBRARY_DIR, slug, 'versions'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    /* SEMVER, not lexicographic — see tools/repair-id-probe.mjs. */
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const currentOf = (slug) => JSON.parse(readFileSync(join(LIBRARY_DIR, slug, 'edition.json'), 'utf8')).current_version;

/* THE DOIs THIS REPO HAS MINTED, one per VERSION — the identifier of the STATE,
 * not of the text (docs/DOI.md: a DOI fixes a state, not a text). Named here
 * rather than derived so the gate states the record instead of accepting whatever
 * the data happens to hold: an identifier that silently stops being cited by the
 * state it names is a citation that resolves to the wrong thing. MEASURED
 * 2026-10-06: 23175744 was minted at tip 7674ce8 over 3051 rules, and that version
 * was then edited IN PLACE four times under the same number — 3271 rules under the
 * DOI of a 3051-rule deposit — which is why 1.0.1 exists and why 1.0.0 now holds
 * the deposited state again. Keyed `<slug>@<semver>`. */
const MINTED = new Map([
  ['proclus-elements-of-theology-taylor-1816@1.0.0', '10.5281/zenodo.23148818'],
  ['porphyry-on-the-cave-of-the-nymphs-taylor-1917@1.0.0', '10.5281/zenodo.23148820'],
  ['proclus-theology-of-plato-taylor-1816@1.0.0', '10.5281/zenodo.23175744'],
  /* MINTED 2026-10-07: a NEW VERSION of the same record (23199740 under the
   * concept record 23175743, versions.index 2), so the concept DOI keeps
   * resolving and the new state gets its own — 1.0.0 is untouched and still
   * resolves at its own DOI. */
  ['proclus-theology-of-plato-taylor-1816@1.0.1', '10.5281/zenodo.23199740'],
  /* MINTED 2026-10-07: a NEW VERSION of the same record (23208338 under the
   * concept record 23175743, versions.index 3). 1.0.2 serves the SAME TEXT as
   * 1.0.1 — not one rule changes — what changes is the section model, now
   * version-aware, with three recorded divisions corrected from blind
   * two-reader scan evidence. 1.0.0 and 1.0.1 are untouched and still resolve
   * at their own DOIs. */
  ['proclus-theology-of-plato-taylor-1816@1.0.2', '10.5281/zenodo.23208338'],
  /* MINTED 2026-10-07: a NEW VERSION of the same record (23216282 under the
   * concept record 23175743, versions.index 4). 1.0.3 serves the SAME TEXT as
   * 1.0.2 — not one rule changes — what changes is the section model, which
   * recovers two printed chapters the earlier models had merged away (Book IV
   * ch VI, anchor s69a; Book VII ch XXXII, anchor s196a) from blind
   * two-reader scan evidence, and records the six the print gives no boundary
   * for. 1.0.0, 1.0.1 and 1.0.2 are untouched and still resolve at their own
   * DOIs. */
  ['proclus-theology-of-plato-taylor-1816@1.0.3', '10.5281/zenodo.23216282'],
  /* MINTED 2026-10-07 as a NEW VERSION of the same record (23220511 under the
   * concept record 23175743, versions.index 5): the first state whose RULES were
   * changed by an OUTSIDE WITNESS — Project Gutenberg's human-proofread
   * transcription of the same 1816 print, over the 2,238 review-flagged rules.
   * 1.0.4's row was MISSING from this table until 1.0.5 froze it: while 1.0.4 was
   * the current version the row was never consulted (a current version is not a
   * frozen one), so the omission was invisible until the bump made 1.0.4 frozen
   * and this gate asked the table for its own record. It is the latent defect the
   * bump surfaced, not a defect the bump introduced. */
  ['proclus-theology-of-plato-taylor-1816@1.0.4', '10.5281/zenodo.23220511'],
  /* MINTED 2026-10-07 as a NEW VERSION of the same record (23221444 under the
   * concept record 23175743, versions.index 6). 1.0.5 serves the SAME TRANSCRIPTION
   * and the SAME SECTION MODEL as 1.0.4 and CORRECTS ITS RULES: the fourteen whose
   * target the human-proofread witness does not read (twelve withdrawn, three
   * corrected under new ids) and the clearing basis, which is now one test for
   * every placement. 1.0.0-1.0.4 are untouched and still resolve at their own
   * DOIs. */
  ['proclus-theology-of-plato-taylor-1816@1.0.5', '10.5281/zenodo.23221444'],
  /* MINTED 2026-10-07 as a NEW VERSION of the same record (23223680 under the
   * concept record 23175743, versions.index 7). 1.0.6 serves the SAME TRANSCRIPTION
   * and the SAME SECTION MODEL as 1.0.5 and closes the at-fault path: the class
   * that says the print's own text is at fault now requires a POSITIVE test of the
   * print (its own form is not a word, it uses it nowhere else, and the rule's
   * target is what the print reads elsewhere, MORE often), so the two readings
   * 1.0.5 served that the print does not carry are gone — r9734's target is
   * CORRECTED to the print's `consubsists` (a new id, the old one retired) and
   * r10277 is WITHDRAWN so the edition serves the print's own `rythm` — while a
   * 1x-vs-1x TIE keeps its flag. THE ROW IS ADDED HERE AS THE VERSION FREEZES, and
   * that is deliberate: 1.0.4's row was missing and stayed invisible only while
   * 1.0.4 was current, because a CURRENT version is not checked against this
   * table. Adding the row at the moment of the freeze is what keeps that latent
   * gap from recurring. */
  ['proclus-theology-of-plato-taylor-1816@1.0.6', '10.5281/zenodo.23223680'],
  /* MINTED 2026-10-08 as a NEW VERSION of the same record (23228446 under the
   * concept record 23175743, versions.index 8). 1.0.7 serves the SAME TRANSCRIPTION
   * and the SAME SECTION MODEL as 1.0.6 and fixes WHAT THE READING VIEW SERVES: the
   * reader applies every rule to every inline run it renders, and nothing had
   * asserted a rule's SCOPE, so 135 rules rewrote text that was not theirs — the
   * served reading view read `supermundaneessential`, `supermundanemundane` and
   * `about unsure God`. Each of the 135 is now licensed (`scope: "all"`, 117), flagged
   * as a finding (`scope: "flagged"`, 8), scoped to the one site it was written for by
   * extending the find (5), or withdrawn (5); and the 31 rules that recorded "no
   * reading is recorded" by serving the English word `unsure` now carry this
   * edition's own damage character, which the reading view already marks. THE ROW IS
   * ADDED HERE AS THE VERSION FREEZES, deliberately: a missing row stays invisible
   * only while the version is current, because a CURRENT version is not checked
   * against this table, and that has bitten this chain once (1.0.4). */
  ['proclus-theology-of-plato-taylor-1816@1.0.7', '10.5281/zenodo.23228446'],
  /* MINTED 2026-10-08 as a NEW VERSION of the same record (23237798 under the concept
   * record 23175743, versions.index 9). 1.0.8 serves the SAME TRANSCRIPTION, the SAME
   * SECTION MODEL and the SAME ANCHORS as 1.0.7, and it corrects SIX `transliteration`
   * rules whose review flag the 1.0.4 witness pass had cleared: the class the edition
   * measures calls each of them ONE INSTRUMENT'S READING, which is exactly what
   * `review` exists to mark, and `tools/echo-probe.mjs` had been RED at 1.0.4-1.0.7
   * (68 OK, 1 FAIL, naming r11693) over them. Four readings are CORRECTED — their ids
   * withdrawn and the corrected rules appended as r11895-r11898, because a corrected
   * reading is a new id, never an edit beneath a spent one — and two are UPHELD on a
   * blind read of their own page and re-flagged with the read recorded. THE ROW IS
   * ADDED HERE AS THE VERSION FREEZES, deliberately: a missing row stays invisible
   * only while the version is current, and that has bitten this chain once (1.0.4). */
  ['proclus-theology-of-plato-taylor-1816@1.0.8', '10.5281/zenodo.23237798'],
  /* MINTED 2026-10-08 as a NEW VERSION of the same record (23239393 under the concept
   * record 23175743, versions.index 10). 1.0.9 serves the SAME TRANSCRIPTION, the SAME
   * SECTION MODEL and the SAME ANCHORS as 1.0.8 (this version's pinned anchor manifest
   * is byte-identical to 1.0.8's), and it carries TWO changes. (1) ONE READING IS
   * CORRECTED: r11842 served the fabricated Greek "πραξις" where the print sets
   * "αρχαι" — the print's OWN GLOSS on the same line reads "Principalities, or rulers",
   * and a blind read of the plate returns "αρχαι" — so the reading is corrected under
   * the fresh id r11899 and r11842 is withdrawn. (2) TWENTY RULES have their EVIDENCE
   * LEAF corrected (plus r11899, whose 1.0.8 ancestor cited n22 for a passage printed
   * on n21): the leaf table began each front-matter page at a line inside the PREVIOUS
   * page's tail, so every rule standing in that tail was cited one leaf too high.
   * NOT ONE OF THOSE TWENTY RULES' READINGS CHANGES. THE ROW IS ADDED HERE AS THE
   * VERSION FREEZES, deliberately: a missing row stays invisible only while the
   * version is current, and that has bitten this chain once (1.0.4). */
  ['proclus-theology-of-plato-taylor-1816@1.0.9', '10.5281/zenodo.23239393'],
  /* MINTED 2026-10-08 as a NEW VERSION of the same record (23242773 under the concept
   * record 23175743, versions.index 11). 1.0.10 serves the SAME TRANSCRIPTION, the SAME
   * SECTION MODEL and the SAME ANCHORS as 1.0.9 (the pinned anchor manifest is
   * byte-identical, so NOT ONE CITATION ANCHOR MOVES), and it carries THREE changes.
   * (1) TWO READINGS ARE CORRECTED, both of them the class the 955 review opened on:
   * r8653 served "that which is delicious food," where the plate sets a GREEK WORD and
   * then the bracketed gloss [delicious food] — the rule deleted the print's Greek word
   * and put English filler in its place — and r11652 served a dangling apostrophe where
   * the plate sets "not only" and a SUPERSCRIPT FOOTNOTE MARKER. Both are withdrawn and
   * their corrected readings appended as r11900 and r11901. (2) 83 REVIEW FLAGS ARE
   * CLEARED, each on a witness that carries the rule's WHOLE `after` reading at the
   * point: 73 on the two other scans of the same 1816 print (whose own _djvu.xml keeps
   * PUNCTUATION AND CASE — the instrument the re-flowed witness lacks) and 10 on a scan
   * together with the human-proofread transcription. (3) NINE RULES carry the two scans'
   * own reading in their `witness` with the flag KEPT: the print carries the form the
   * rule changes, so the rule is an emendation of the print's own form. THE ROW IS ADDED
   * HERE AS THE VERSION FREEZES, deliberately: a missing row stays invisible only while
   * the version is current, and that has bitten this chain once (1.0.4). */
  ['proclus-theology-of-plato-taylor-1816@1.0.10', '10.5281/zenodo.23242773'],
  /* MINTED 2026-10-08: the OTHER TWO EDITIONS' FIRST VERSION BUMP, each as a NEW
   * VERSION of its own record — the fold gate's unscoped multi-fire rules
   * adjudicated on measurement and licensed `scope: "all"` at 1.0.1. NOT ONE BYTE
   * OF THE SERVED TEXT CHANGES in either edition: what changes is the SCOPE RECORD
   * (the eight rules gain the licence and the measurement that decides it) and the
   * served `/t`'s own `note` strings, which ARE the rationale. 1.0.0 of each is
   * untouched and still resolves at its own DOI. */
  ['proclus-elements-of-theology-taylor-1816@1.0.1', '10.5281/zenodo.23236056'],
  ['porphyry-on-the-cave-of-the-nymphs-taylor-1917@1.0.1', '10.5281/zenodo.23236119'],
]);

section('every version is a frozen directory, served at its own URL');
for (const t of served) {
  const slug = t.slug;
  const current = currentOf(slug);
  const versions = versionsOf(slug);
  check(versions.length >= 1 && versions.includes(current), `${slug}: versions/ holds ${versions.join(', ')}; current_version is ${current}`);
  for (const v of versions) {
    const base = join(DIST, 'texts', slug, 'v', v);
    for (const rel of ['index.html', 't', 'plain']) {
      check(existsSync(join(base, rel)), `${slug} v${v}: /texts/${slug}/v/${v}/${rel} exists`);
    }
    const meta = readMeta(slug, v);
    const srcPath = join(versionDir(slug, v), 'source.txt');
    const src = readFileSync(srcPath, 'utf8');
    check(
      meta && meta.source_sha256 === sha256(src),
      `${slug} v${v}: meta.json.source_sha256 is the sha256 of versions/${v}/source.txt (${sha256(src).slice(0, 12)}…)`,
    );
    /* /plain IS the plain text of THIS version — recomputed here, not read from
     * the build's report. */
    /* THE BUILD'S OWN VIEW OF THE ENTRY. The record is the source of every
     * bibliographic field the page prints (build/build.mjs `editionView`), so the
     * edition STATEMENT comes from edition.json and not from the shelf's own
     * prose — MEASURED on Taylor's Theology of Plato, whose shelf entry and whose
     * record carry different statements: taking the shelf's here recomputed a
     * /plain the build never wrote. */
    const rec = JSON.parse(readFileSync(join(LIBRARY_DIR, slug, 'edition.json'), 'utf8'));
    const entry = { ...t, ...rec, edition: rec.source_edition.statement };
    const doc = extract(src, { entry, sha256: sha256(src), version: v });
    const got = readFileSync(join(base, 'plain'), 'utf8');
    check(got === plainText(doc, entry), `${slug} v${v}: /plain is the plain text of THIS version (recomputed here, byte for byte)`);
    /* The citation on the pinned page is the version's own (model §3.1). The
     * citation block sets the prose in the serif and the trailing URL in a <span>
     * of its own, so the guarantee is over the RENDERED TEXT (the string a reader
     * copies), not over an unbroken run of bytes in the HTML. */
    const page = readFileSync(join(base, 'index.html'), 'utf8');
    const citeText = (html) => {
      const m = /<p class="cite">([\s\S]*?)<\/p>/.exec(html);
      if (!m) return null;
      return m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    };
    check(
      citeText(page) === meta.citation,
      `${slug} v${v}: the page's citation block IS the version's own citation string from meta.json`,
    );
    /* AND the DOI in that string is a LINK — its text the identifier itself, so
     * the rendered text above is unchanged, and it resolves. FAILS ON THE
     * PRE-FIX MARKUP, where the identifier rendered as plain text: the anchor is
     * then absent. A version that mints NO DOI must render no link (an empty one
     * would be a citation the page cannot honour). WHICH DOI IS THE VERSION'S OWN
     * is the generator's own rule (build/migrate.mjs `--citations`): `meta.json.doi`
     * where the version records one, and the edition's `doi` ONLY for the version
     * the edition calls current — a frozen version must never cite the DOI of a
     * state that is not its own. */
    const doi = meta.doi != null ? meta.doi : v === current ? entry.doi || '' : '';
    const anchor = /<a class="cite-doi" href="([^"]+)">([\s\S]*?)<\/a>/.exec(page);
    check(
      doi
        ? !!anchor && anchor[1] === `https://doi.org/${doi}` && anchor[2].replace(/<[^>]+>/g, '') === doi
        : !anchor,
      `${slug} v${v}: the citation's DOI ${
        doi ? `is a link to https://doi.org/${doi}, its text the DOI itself` : 'is absent (this version mints none) and no empty link is rendered'
      }` +
        (doi && anchor ? ` (got href ${JSON.stringify(anchor[1])}, text ${JSON.stringify(anchor[2].replace(/<[^>]+>/g, ''))})` : ''),
    );
    /* THE MINTED DOI OF THIS STATE IS STILL THE ONE ITS CITATION CARRIES. The
     * table is the record (docs/DOI.md); the citation is what a reader copies. A
     * generator that re-derives a frozen version's citation from the edition's
     * current `doi` — MEASURED: build/migrate.mjs:179 did exactly that before
     * 2026-10-06 — rewrites v1.0.0's citation to name the NEW DOI, which is a
     * citation of a state v1.0.0 is not. FAILS on that tree. */
    const minted = MINTED.get(`${slug}@${v}`);
    check(
      minted === undefined || (meta.citation.includes(`DOI: ${minted}.`) && doi === minted),
      minted === undefined
        ? `${slug} v${v}: no DOI minted for this state yet (nothing to hold its citation to)`
        : `${slug} v${v}: the citation still carries the DOI THIS STATE was minted under, ${minted}` +
            (meta.citation.includes(`DOI: ${minted}.`) && doi === minted
              ? ''
              : ` — the version's doi is ${JSON.stringify(meta.doi)} and its citation reads ${JSON.stringify(meta.citation)}`),
    );
    /* 5b. A FROZEN VERSION OF A MULTI-VERSION EDITION CARRIES ITS OWN DOI — a
     * frozen state is by definition a minted one (docs/DOI.md), so a meta.json
     * without a `doi` of its own is a citation that has silently LOST its
     * identifier; and the row may be missing from MINTED too, in which case the
     * check above passes vacuously ("nothing to hold its citation to"). So the
     * frozen version must carry a non-empty `meta.json.doi`, it must DIFFER from
     * the current version's (two states sharing one DOI is the falsification
     * again, wearing a different hat), and it must be the MINTED table's row for
     * this state. MEASURED 2026-10-07: the Theology's frozen 1.0.0 carries
     * 10.5281/zenodo.23175744 against the current 1.0.1's …23199740. */
    if (v !== current && versions.length > 1) {
      const currentDoi = readMeta(slug, current).doi;
      check(
        typeof meta.doi === 'string' && meta.doi !== '',
        `${slug} v${v}: a FROZEN version of a multi-version edition carries its own meta.json.doi (a frozen state is a minted one; a DOI-less frozen citation is silent)` +
          (meta.doi ? '' : ` — got ${JSON.stringify(meta.doi)}`),
      );
      check(
        meta.doi !== currentDoi,
        `${slug} v${v}: its DOI differs from the current version's (v${v} ${JSON.stringify(meta.doi)} vs v${current} ${JSON.stringify(currentDoi)}) — one DOI names one state`,
      );
      check(
        MINTED.has(`${slug}@${v}`) && MINTED.get(`${slug}@${v}`) === meta.doi,
        `${slug} v${v}: and the DOI is the MINTED table's row for this state (the record those citations are held to)`,
      );
    }
    if (v === current) {
      /* THE EDITION'S `doi` IS THE CURRENT VERSION'S DOI. The field names the state
       * a bare `/texts/<slug>/` serves, so an edition whose `doi` and whose current
       * version's `doi` disagree is an edition advertising one state and serving
       * another. Holds for the seed editions too, where the DOI is stored at the
       * edition level only (the current version is the only version they have). */
      check(
        (rec.doi || '') === doi,
        `${slug}: edition.json.doi is the CURRENT version's DOI (edition ${JSON.stringify(rec.doi || '')}, v${v} ${JSON.stringify(doi)})`,
      );
    }
    if (v !== current) {
      check(
        page.includes(`Version ${v} — pinned`) && page.includes(current),
        `${slug} v${v}: and says it is pinned and names the current version (${current})`,
      );
    }
  }
  /* WHILE a version is current, the bare document is the same bytes as the
   * pinned one: one extraction, two URLs — the address an old bookmarked reader
   * page fetches. */
  const bare = join(DIST, 'texts', slug, 't');
  const pinned = join(DIST, 'texts', slug, 'v', current, 't');
  check(
    existsSync(bare) && existsSync(pinned) && readFileSync(bare, 'utf8') === readFileSync(pinned, 'utf8'),
    `${slug}: the bare /t is byte-identical to the current version's /v/${current}/t`,
  );
}

/* ---------- the mutation: v1.0.0 does not move when v1.1.0 ships ---------- */

/* A SCRATCH DIRECTORY OFF THE QUOTA'D TMPFS. MEASURED 2026-10-07: /tmp on this
 * host is a 63 GB tmpfs mounted under a per-user quota (EDQUOT), holding tens of
 * GB of accumulated agent scratch. The scratch tree here is a full copy of data/
 * — including the 443 MB of page images Taylor's Theology of Plato stores — so
 * `cp -r` into /tmp fails outright, and a write into it can be SILENTLY TRUNCATED
 * rather than refused (a 13.7 KB comparison file came back as 2.4 KB with no
 * error), which would leave the mutant build reading half a tree. The scratch
 * therefore goes to a real filesystem: $NPL_SCRATCH if set, else /var/tmp, else a
 * directory beside the repo. */
function scratchBase() {
  const candidates = [process.env.NPL_SCRATCH, '/var/tmp', join(dirname(ROOT), '.npl-scratch')].filter(Boolean);
  for (const base of candidates) {
    try {
      mkdirSync(base, { recursive: true });
      const probe = join(base, '.npl-write-probe');
      writeFileSync(probe, 'ok');
      rmSync(probe);
      return base;
    } catch {
      /* not writable — try the next */
    }
  }
  throw new Error(`version-probe: no writable scratch base among ${candidates.join(', ')}`);
}

/** THE COPY MUST BE COMPLETE, or the immutability comparison is vacuous: a
 * truncated copy leaves the mutant build reading half a tree. Every copied
 * directory is checked against its source by file count AND total bytes — a short
 * write into a full filesystem is reported, never swallowed. */
function copyTree(from, to) {
  cpSync(from, to, { recursive: true });
  const tally = (dir) => {
    let files = 0;
    let bytes = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          files += 1;
          bytes += statSync(p).size;
        }
      }
    };
    walk(dir);
    return { files, bytes };
  };
  const src = tally(from);
  const dst = tally(to);
  if (src.files !== dst.files || src.bytes !== dst.bytes) {
    throw new Error(
      `version-probe: the scratch copy of ${from} is SHORT — ${dst.files} file(s)/${dst.bytes} byte(s) ` +
        `against ${src.files}/${src.bytes}; the scratch filesystem did not hold the tree ` +
        `(refusing to run the mutation on an incomplete copy)`,
    );
  }
}

section('the immutability asymmetry — a new version does not touch the old one');
{
  /* The mutation runs in a SCRATCH COPY of the repo so nothing here is edited:
   * the tree under test stays exactly as built, and the mutant tree is thrown
   * away. The copy is of the source + data + the built tree, which is what the
   * build needs. */
  const scratch = mkdtempSync(join(scratchBase(), 'npl-version-mutation-'));
  const slug = served[0].slug;
  const v0 = currentOf(slug);
  /* THE VERSION'S BYTES AND ITS DOCUMENT ARE IMMUTABLE; its PAGE is chrome around
   * them and may say which version is current — plan §4 asks for exactly that
   * banner on a pinned page, and it cannot be both stated and frozen. So the page
   * is compared with the notice paragraph REMOVED (the one part that names the
   * current version), and everything else must be byte-identical. */
  const stripVersionNotice = (html) => html.replace(/<p><b>Version [^<]*<\/b>[\s\S]*?<\/p>/, '<p>[version notice]</p>');
  const snapshot = (root) => {
    const dir = join(root, 'site', 'dist', 'texts', slug, 'v', v0);
    return {
      't': sha256(readFileSync(join(dir, 't'), 'utf8')),
      plain: sha256(readFileSync(join(dir, 'plain'), 'utf8')),
      'index.html (minus the version notice)': sha256(stripVersionNotice(readFileSync(join(dir, 'index.html'), 'utf8'))),
    };
  };
  const before = snapshot(ROOT);
  try {
    for (const d of ['build', 'tools', 'design', 'elm', 'data']) {
      copyTree(join(ROOT, d), join(scratch, d));
    }
    /* A NEW VERSION with a CHANGED SOURCE BYTE. The change is inside a paragraph
     * (not at a section boundary), so the anchors do not move — the point of the
     * test is the OUTPUT of v1.0.0, not a new version's legality. */
    const v1 = '1.1.0';
    const v1dir = join(scratch, 'data', 'editions', slug, 'versions', v1);
    mkdirSync(v1dir, { recursive: true });
    const src0 = readFileSync(join(scratch, 'data', 'editions', slug, 'versions', v0, 'source.txt'), 'utf8');
    /* A BYTE CHANGE THAT MOVES NO ANCHOR AND BREAKS NO RULE. The appended line
     * is back matter: no rule's `find` can name it (it did not exist), and no
     * section, page, note or reference anchor depends on it. MEASURED: a mutation
     * that DID remove text a rule matches would fail the scratch build's own
     * acceptance gate, which is a different failure than the one under test. */
    const mutated = `${src0}\nMUTATION PROBE LINE\n`;
    if (mutated === src0) throw new Error('the mutation changed nothing');
    writeFileSync(join(v1dir, 'source.txt'), mutated);
    /* The new version's rule file is v1.0.0's list under v1.1.0's own version
     * stamp — the canonical record names the version it belongs to, and the build
     * refuses a rule file that names another one (loadEdits). */
    const rules1 = JSON.parse(readFileSync(join(scratch, 'data', 'editions', slug, 'versions', v0, 'repairs.json'), 'utf8'));
    rules1.version = v1;
    writeFileSync(join(v1dir, 'repairs.json'), `${JSON.stringify(rules1, null, 2)}\n`);
    writeFileSync(
      join(v1dir, 'base.json'),
      readFileSync(join(scratch, 'data', 'editions', slug, 'versions', v0, 'base.json'), 'utf8'),
    );
    writeFileSync(
      join(v1dir, 'meta.json'),
      `${JSON.stringify(
        {
          version: v1,
          date: new Date().toISOString().slice(0, 10),
          note: 'MUTATION PROBE — a scratch version, never shipped',
          source_sha256: sha256(mutated),
          supersedes: v0,
          citation: `MUTATION PROBE v${v1}`,
        },
        null,
        2,
      )}\n`,
    );
    const editionPath = join(scratch, 'data', 'editions', slug, 'edition.json');
    const edition = JSON.parse(readFileSync(editionPath, 'utf8'));
    edition.current_version = v1;
    writeFileSync(editionPath, `${JSON.stringify(edition, null, 2)}\n`);

    execFileSync(process.execPath, [join(scratch, 'build', 'build.mjs')], { cwd: scratch, stdio: 'pipe' });

    /* THE MANIPULATION MUST HAVE TAKEN EFFECT: the mutant tree's bare page is
     * v1.1.0's, so the equality below is a test of immutability and not of a
     * build that ignored the change. */
    const mutantBareCitation = readFileSync(join(scratch, 'site', 'dist', 'texts', slug, 't'), 'utf8');
    const mutantDoc = JSON.parse(mutantBareCitation);
    check(
      mutantDoc.source.sha256 === sha256(mutated),
      `the mutant tree's bare document is v${v1}'s bytes (the mutation took effect)`,
    );
    check(
      existsSync(join(scratch, 'site', 'dist', 'texts', slug, 'v', v1, 't')),
      `and v${v1} is emitted as its own frozen directory`,
    );

    const after = snapshot(scratch);
    const moved = Object.keys(before).filter((f) => before[f] !== after[f]);
    check(
      moved.length === 0,
      `v${v0}'s document, plain text and page (minus the notice naming the current version) are UNCHANGED by the arrival of v${v1}` +
        (moved.length ? ` — moved: ${moved.join(', ')}` : ` (index.html, t, plain: ${before.t.slice(0, 12)}…)`),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nversion-probe: all checks passed' : `\nversion-probe: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
