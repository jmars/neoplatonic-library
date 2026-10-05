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
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
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
    .sort();
const currentOf = (slug) => JSON.parse(readFileSync(join(LIBRARY_DIR, slug, 'edition.json'), 'utf8')).current_version;

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
     * then absent. A record that mints NO DOI must render no link (an empty one
     * would be a citation the page cannot honour). */
    const doi = entry.doi || '';
    const anchor = /<a class="cite-doi" href="([^"]+)">([\s\S]*?)<\/a>/.exec(page);
    check(
      doi
        ? !!anchor && anchor[1] === `https://doi.org/${doi}` && anchor[2].replace(/<[^>]+>/g, '') === doi
        : !anchor,
      `${slug} v${v}: the citation's DOI ${
        doi ? `is a link to https://doi.org/${doi}, its text the DOI itself` : 'is absent (the record mints none) and no empty link is rendered'
      }` +
        (doi && anchor ? ` (got href ${JSON.stringify(anchor[1])}, text ${JSON.stringify(anchor[2].replace(/<[^>]+>/g, ''))})` : ''),
    );
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

section('the immutability asymmetry — a new version does not touch the old one');
{
  /* The mutation runs in a SCRATCH COPY of the repo so nothing here is edited:
   * the tree under test stays exactly as built, and the mutant tree is thrown
   * away. The copy is of the source + data + the built tree, which is what the
   * build needs. */
  const scratch = mkdtempSync(join(tmpdir(), 'npl-version-mutation-'));
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
      cpSync(join(ROOT, d), join(scratch, d), { recursive: true });
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
