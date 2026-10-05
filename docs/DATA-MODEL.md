# Data model — neoplatonic-library.org

**Status: PROPOSED, awaiting sign-off. Everything else (build, search, graph
rendering, URLs) derives from this file. Do not start migration before this is
agreed.**

This is the contract for the standalone library. The blog's library is the source
of truth for *content*; this model is the target *shape*. The two published
editions and their repair logs are the first migration; the schema must hold the
other 37 shelf entries unchanged.

---

## 0. Principles

1. **Slugs are frozen.** A slug published once never changes. URLs are derived
   from slugs and versions, nothing else.
2. **Versions are immutable and retained.** Shipping v1.1 does not remove v1.0.
   A citation to v1.0 resolves forever.
3. **The graph is first-class data, not derived from prose.** Node and edge IDs
   are authored, stable, and referenced by editions and repairs.
4. **Every structured field is explicit.** A field that does not exist yet is
   *empty* (`""`, `null`, `[]`), never guessed and never omitted.
5. **Corpus-first, commentary secondary.** Readings attach to editions; they do
   not live in the corpus directory.

---

## 1. Repository layout

```
neoplatonic-library/
  docs/                     DATA-MODEL.md (this file), EXTRACTION-PLAN.md
  data/
    site.json               site-wide identity, licence, citation policy
    editions/
      <slug>/
        edition.json        bibliographic + version + licence + citation record
        import.json         the import record: the source file, its line range,
                            whole-file and slice sha256, byte count, import date
        scan.json           WHERE THE PAGE IMAGES ARE (Proclus): the archive
                            item, the leaf↔printed-page offset (measured), the
                            leaves that verify it
        witnesses.json      the other prints/editions a reading was decided from
        witnesses/          those witnesses, held verbatim beside the text
        derivs.json         the leaf/page model derived from the archive item
        vocab-allow.txt     the words the vocabulary check allows for this text
        scans/              THE EDITION'S WHOLE SCAN, one image per leaf:
                            `nNNN.jpg` = archive leaf NNN, every leaf of the
                            run of the volume the work occupies (not only the
                            leaves a repair used). These are COMMITTED (≈59M
                            for the two editions, MEASURED 2026-10-05: proclus
                            141 leaves 36.1M, porphyry 72 leaves 22.5M): a
                            leaf is part of the citable record, not a
                            re-fetchable by-product
        versions/
          <semver>/
            source.txt      the served transcription, frozen at this version
            repairs.json    the repair log as served at this version
            base.json       the base policy the rules were written under
            meta.json       date, note, sha256 of source.txt
    graph/
      graph.json            { nodes[], edges[] } — the transmission/citation graph
  site/                     build output is written here (dist/)
  build/                    the site build (reuses tools/library machinery)
  tools/                    library machinery (reader, extract, repair, app.js)
```

**The edition directory carries its SOURCES, not only the edition.** Every
provenance artifact the pipeline produced for the edition is stored beside it —
the import record, where its page images are, the witnesses it was read against,
the leaf/page model, the vocabulary the text was allowed — so the edition is
self-describing: what it was made from travels with it, and the build never
consults the blog. `scans/` is the one part that is large rather than textual,
and it is committed for the same reason: the leaf a rule cites must resolve for
as long as the citation does.

Not every edition carries every file: the set is what the pipeline actually
produced for that edition. The Proclus edition carries `import.json` and
`scan.json`; the Porphyry edition carries `import.json`, `witnesses.json`,
`witnesses/`, `derivs.json` and `vocab-allow.txt` (its leaf/page model lives in
`derivs.json`, so it has no separate `scan.json`).

`current_version` in `edition.json` selects which `versions/<semver>/` a bare
`/texts/<slug>/` serves.

---

## 2. `data/site.json`

```jsonc
{
  "name": "The Neoplatonic Library",
  "host": "neoplatonic-library.org",
  "tagline": "...",
  "licence": {
    "texts": "public-domain",
    "editorial": "CC-BY-4.0",
    "statement": "The transcriptions are public-domain works. The editorial work — repairs, page models, apparatus, notes — is released under CC BY 4.0."
  },
  "citation_policy": "Cite the edition, the version, and the URL. Each edition page carries a formatted citation.",
  "blog": { "url": "https://blog.jaye.ch", "relation": "The texts stand on their own; the essays are one reader's reading." }
}
```

---

## 3. `data/editions/<slug>/edition.json`

Every field is required unless marked *optional*; absent values are `null`/`""`/`[]`.

```jsonc
{
  "slug": "proclus-elements-of-theology-taylor-1816",   // FROZEN once published
  "title": "The Elements of Theology",
  "author": "Proclus",
  "translator": "Thomas Taylor",                         // null if none
  "lang": "en",

  "source_edition": {
    "statement": "Proclus: The Elements of Theology, translated by Thomas Taylor; printed as the second work of The Six Books of Proclus on the Theology of Plato, vol. II (London, 1816).",
    "place": "London",
    "year": 1816,
    "imprint": null
  },

  "scan_source": {
    "archive_id": "thomastaylor",
    "url": "https://archive.org/download/thomastaylor/elementsoftheology_proclus_djvu.txt",
    "whole_sha256": "416d1e5b…",
    "note": "…"
  },

  "current_version": "1.0.0",

  "licence": {
    "text": "public-domain",
    "editorial": "CC-BY-4.0",
    "statement": "…"
  },

  "citation": "Proclus, The Elements of Theology, trans. Thomas Taylor (London, 1816). The Neoplatonic Library, version 1.0.0. https://neoplatonic-library.org/texts/proclus-elements-of-theology-taylor-1816/",

  "doi": "",                       // Zenodo DOI when minted; EMPTY until then

  "cat": ["proclus-elements-of-theology"],  // catalogue work ids this edition IS

  "readings": [],                  // reading slugs attached to this edition

  "repair_state": "repaired"       // in-repair | repaired | damaged | null
}
```

The `citation` string's form — the one rendered on every edition page (model §3,
DATA-MODEL here) — is:

    Author, Title[, trans. Translator] (Place, Year). The Neoplatonic Library,
    version <v>. <url>

`ed.` is **not** used before the version: in a citation `ed.` abbreviates
"edited by"/"edition", and what it would introduce here is a *version*. The
container is named and then its version, and the URL ends the string.

### 3.0 The edition directory: the record, and its sources

`edition.json` is the record; the directory around it is the SOURCES (see §1):
`import.json`, `scan.json`/`witnesses.json`/`derivs.json`/`vocab-allow.txt`, the
`witnesses/` they name, and `scans/`. `edition.json.scan_source.archive_id` names
the archive item the scans came from; the item's page is linked from the edition
page's Provenance section and from `/editions`.

**The scans are served at a stable address.** The build copies
`data/editions/<slug>/scans/` to `site/dist/texts/<slug>/scans/`, so each leaf is
served at

    /texts/<slug>/scans/<nNNN.jpg>

— the exact URL a repair's `evidence[].url` carries (§4). The address does not
carry the version: the leaf set belongs to the EDITION, not to one version of its
text, so a pinned version's page cites the same stable leaf. The deploy carries
the images (tools/deploy.sh has no `--delete`, so a leaf a later build drops is
retained server-side); the size cost — ≈59M for the two editions (MEASURED
2026-10-05) — is stated there.

### 3.1 Versioning

- `current_version` is semver (`1.0.0`). Any change to `source.txt` or
  `repairs.json` **must** bump the version and write a new `versions/<semver>/`.
  The old directory is never edited or deleted.
- `versions/<semver>/meta.json`:

```jsonc
{
  "version": "1.0.0",
  "date": "2026-10-04",
  "note": "first published",
  "source_sha256": "94979092…",
  "supersedes": null,
  "citation": "…the exact citation string for THIS version…"
}
```

- URLs: `/texts/<slug>/` → current; `/texts/<slug>/v/<semver>/` → pinned;
  `/texts/<slug>/v/<semver>/plain` → plain-text export of that version.

---

## 4. `data/editions/<slug>/versions/<semver>/repairs.json`

```jsonc
{
  "slug": "proclus-elements-of-theology-taylor-1816",
  "version": "1.0.0",
  "policy": "substitute-if-known-else-leave",
  "rules": [ /* the applied rules, in order — see below */ ]
}
```

A **repair is one RULE, never one firing.** A rule may match several places in the
text; it is still one repair with one ID. IDs are forever, so the unit is the
rule. The count of matches is recorded as `fires` (MEASURED), not split into
synthetic rows.

Required fields:

```jsonc
{
  "id": "proclus-elements-of-theology-taylor-1816:r0001",  // stable, unique, never reused
  "type": "OCR",                    // OCR | punctuation | transliteration | conjectural (scholarly)
  "apply": "opener",                // opener | digit | reading | review — the PIPELINE class (5)
  "location": {
    "find": "T>ROPOSITION XXVI.",   // the text/pattern as the transcription has it
    "page": 301,                     // printed page, null if unknown
    "leaf": 806                      // scan leaf, null if unknown
  },
  "before": "T>ROPOSITION XXVI.",
  "after": "PROPOSITION XXVI.",
  "rationale": "Proposition XXVI is due at this place…",
  "date": null,                      // null where the source records no date — DO NOT GUESS
  "witness": "Dodds prop. 26",       // what settled it; null if none
  "fires": 1,                        // MEASURED: how many times `location.find` matches the served text
  "join": false,                     // true when the rule also joins two paragraph blocks
  "type_evidence": "note says \"the print reads\"",  // the rationale substring that decided `type`
  "review": false,                   // true when `type` rested on judgment and awaits human review
  "evidence": [ /* the scan leaves the reading was decided from — see §4.4 */ ]
}
```

### 4.0 The two taxonomies, and why both are stored

- `type` is the **scholarly** taxonomy a reader filters by (the required four).
- `apply` is the **pipeline** class (`opener`/`digit`/`reading`/`review`). Its
  ORDER is load-bearing: the extraction cannot find a section until the `opener`
  rules have run, and `review` rules change nothing. A repaired text cannot be
  re-rendered from `type` alone, so `apply` travels with every rule.
- The build derives the reader's internal `{find, repl, cls, note, action, join}`
  from the canonical record: `repl←after`, `cls←apply`, `note←rationale`,
  `join←join`, `action←"leave"` for `apply:"review"` else unset. The canonical
  file is the model shape; there is no second source of truth (see §4.3).

### 4.1 Type taxonomy (the required four)

| type | meaning |
|---|---|
| `OCR` | a character or word misread by the scanner; the print is recovered |
| `punctuation` | a mark of punctuation added, removed or changed |
| `transliteration` | Greek/other script restored from the page image (Latin lookalikes corrected) |
| `conjectural` | no witness; an editor's reading, stated as such |

**`type` does not map 1:1 from the blog's `class`, which is why BOTH are
stored (`apply` keeps the class).** Migration assigns `type` per rule on this
ordered decision (rules 1–4 are decidable byte-wise; 5–6 need the note):

1. `transliteration` — `after` contains Greek (U+0370–03FF / U+1F00–1FFF) and `before` does not.
2. `OCR` — `before` and `after` are equal after removing all whitespace (a line-break split: `cold ness`→`coldness`).
3. `punctuation` — `before` and `after` differ only in punctuation characters
   **belonging to the print**. This exclusion is MEASURED, not judged: the base
   policy measures an OCR-noise DAMAGE SET — `^ _ ~ / £ > \ | # ™ ± » « } {`
   (the blog's `_base.json` `damage`, mirrored per edition into `repairs.json`'s
   `damage`) — minus each edition's own print sets (`extract.mjs` TEXT_RULES
   `damageExclude`: proclus prints `*` as a footnote marker and `&` as an
   ampersand). A damage character is one the print **cannot set**; a scan leaves
   it inside or beside a word where the print has a space or its own mark. So a
   change that only **removes or substitutes** such a character RECOVERS the
   print's own mark or word-space — it is scanner damage removed, i.e. `OCR`
   (rule 6), and **not** a change to the print's punctuation. Typing a scanner
   artefact `punctuation` would mislead a reader filtering by `type`.
4. `OCR` — `apply` is `opener` or `digit` (a mangled division/printed number).
5. `conjectural` — the rationale names no witness and supplies a reading ("it is necessary to read", "supplied") with no print evidence.
6. `OCR` — default for damage-derived restorations.

Every rule whose `type` is NOT fixed by rules 1–4 must set `review: true` and be
listed in the edition's review worklist. A rule in rule 6 without page-image/print
evidence is also `review: true`. `type_evidence` records the rationale substring
(or "rule N") that decided it. **Human review over the worklist is the only thing
that flips `review` to `false`; migration never asserts certainty it lacks.**

### 4.2 Repair IDs

- Namespaced: `<slug>:r<NNNN>`, zero-padded, assigned in rule order at first
  migration and **never renumbered**. A new version appends `r0416`, `r0417`, …
  It never reuses or reorders old IDs.
- IDs are per RULE, not per firing (§4.0). A rule that fires four times keeps one
  ID and `fires: 4`.
- Repair links in the graph, and stable anchors on the apparatus page
  (`#repair-r0001`), reference these IDs. The edition page redirects an old
  top-level `#repair-<id>` to the apparatus page (§7.1).

### 4.3 Canonical layout for the pipeline

`data/editions/<slug>/versions/<semver>/repairs.json` is the **single source of
truth**. There is no second copy in a `tools/library/edits/` directory: the build
reads the canonical file and derives the reader's internal shape (§4.0). The
`_base.json` policy (damage set, `substitute-if-known-else-leave`, states) travels
with the version — copy it to `versions/<semver>/base.json` and mirror its damage
set into `repairs.json`'s `damage` array so the reader can mark damage. The
edition's `source.txt` stays a byte copy of the blog's transcription, so the
extractor's anchors (`s1…`) are byte-identical and old `#s1` links resolve.

### 4.4 `evidence` — the scan a reading was decided from

A rule that was read off a page image carries the leaf (or leaves) it was decided
from, so the edition page can show the page the reading came from. `[]` when the
reading rests on something else (the transcription's own context, a parallel
edition, judgment). Each entry:

```jsonc
{
  "kind": "scan",                 // the kind of evidence; only "scan" today
  "leaf": 873,                    // the archive.org leaf the reading was read from
  "page": 368,                    // the printed page that leaf carries; null when none stands beside the leaf
  "file": "n873.jpg",             // the leaf's file in data/editions/<slug>/scans/
  "url": "/texts/<slug>/scans/n873.jpg",  // where the leaf is served; null when not held
  "exists": true,                 // whether the leaf is stored with the edition
  "source": "archive.org"         // the scan's source
}
```

The fields are the model's (§0.4): empty, never guessed and never omitted. A
cited leaf that is NOT stored with the edition keeps its entry with
`exists:false` and `url:null` — the citation is recorded and the page says the
image is not held, rather than dropping the evidence.

**Where the numbers come from** (`tools/migrate-evidence.mjs`, re-runnable and
idempotent). The Proclus rules cite their leaf and page in the rationale
(`printed page 368 = archive n873`, `printed page 422, scan n927`); every `nNNN`
token in a rationale is a cited leaf, and the printed page is the page number
standing immediately before it (`null` where none does). The Porphyry rules are
matched by `find` to the proposals in the blog's own scan pass
(`tools/library/edits/<slug>.scan.json`), whose `evidence: "scan page (archive.org
page/nNN)"` carries the leaf. The migration NEVER renumbers an id or changes
`location.find`, `after` or `type`; it asserts that on every rule before writing.

MEASURED (2026-10-04, the state at migration): the Proclus edition — 415 rules,
105 citing a leaf, 60 distinct leaves, 58 held (n811 and n864 were cited but not
held); the Porphyry edition — 384 rules, 4 citing a leaf, 4 distinct, 3 held
(n33 was cited but not held).

MEASURED (2026-10-05, after the WHOLE SCAN was fetched — `tools/fetch-scans.mjs`,
proclus n806–n946, porphyry n0–n71): Proclus 60 of 60 cited leaves held,
Porphyry 4 of 4 — NO cited leaf is unheld any more, and the migration was
re-run to stamp `exists:true`/the served url on the three entries (n811, n864,
n33) that had been stamped `false` against the old, partial leaf set. The
`exists:false`/`url:null` form remains the rule's honest shape (§ above) but is
no longer exercised by the served data; the viewer's unheld branch is exercised
by a doctored data file in tools/apparatus-probe.mjs. The apparatus page's
viewer shows every stored leaf (§5.4) and states plainly when a leaf carries
no reading.

---

## 5. `data/graph/graph.json`

```jsonc
{
  "nodes": [
    { "id": "text:proclus-elements-of-theology", "type": "text",
      "label": "The Elements of Theology", "slug": null },
    { "id": "author:proclus", "type": "author", "label": "Proclus" },
    { "id": "edition:proclus-elements-of-theology-taylor-1816", "type": "edition",
      "label": "Taylor 1816", "slug": "proclus-elements-of-theology-taylor-1816" },
    { "id": "passage:proclus-elements-of-theology:prop-1", "type": "passage",
      "label": "Prop. I", "slug": "proclus-elements-of-theology-taylor-1816" }
  ],
  "edges": [
    { "id": "e0001", "from": "author:proclus", "to": "text:proclus-elements-of-theology",
      "type": "wrote" },
    { "id": "e0002", "from": "edition:proclus-elements-of-theology-taylor-1816",
      "to": "text:proclus-elements-of-theology", "type": "translates" },
    { "id": "e0003", "from": "text:proclus-elements-of-theology",
      "to": "text:plotinus-enn…", "type": "derives_from" },
    { "id": "e0004", "from": "text:…", "to": "text:…", "type": "commentary_on" },
    { "id": "e0005", "from": "text:…", "to": "text:…", "type": "cites" }
  ]
}
```

- **Node types:** `text`, `author`, `edition`, `passage`.
- **Edge types:** `cites`, `translates`, `derives_from`, `commentary_on`
  (plus `wrote`/`translated_by` for author linkage, allowed as structural edges).
- **IDs:** `<type>:<stable-key>`, globally unique, never reused. Slugs are
  URL-safe and lowercase; the node id is derived from the key, not the URL.
- Edges may carry `evidence` (a citation location) and `note`.

---

## 6. Readings attached to editions

- A reading is a blog post (or its own page) whose subject is a library text.
- `edition.readings[]` lists the reading slugs; the library renders the link
  **out to the blog** (blog → library default is the reverse: the blog links in).
- Readings that do not attach to a corpus text stay on the blog, full stop.

---

## 7. Routes

| route | content |
|---|---|
| `/` | corpus list, search box, graph entry point |
| `/texts` | browsable corpus (all published editions, ordered by author) |
| `/texts/<slug>` | edition page: text + citation + the short apparatus statement and the door to its own page + attached readings |
| `/texts/<slug>/apparatus` | **the apparatus page**: the leaf viewer on its own route (the version's whole repair log, browsed by reading and by leaf) |
| `/texts/<slug>/t` | the version's document — the reader's own data (fetched, not page prose) |
| `/texts/<slug>/plain` | plain-text export of that version |
| `/texts/<slug>/apparatus.json` | **the version's whole repair log as DATA** (fetched): the counts by type, the stored leaves, and every rule with its evidence — the leaf a reading was decided from (kept at this address; the apparatus page fetches it) |
| `/texts/<slug>/v/<semver>` | pinned version |
| `/texts/<slug>/v/<semver>/apparatus` | that version's apparatus page (fetches the version's OWN `apparatus.json`) |
| `/texts/<slug>/v/<semver>/t` | that version's document |
| `/texts/<slug>/v/<semver>/plain` | plain-text export of that version |
| `/texts/<slug>/v/<semver>/apparatus.json` | that version's apparatus (the same file, at the pinned address — a pinned page fetches its OWN version's log) |
| `/texts/<slug>/scans/<nNNN.jpg>` | the stored source leaf `nNNN` — the page image a repair may cite (see §3.0) |
| `/graph` | interactive transmission/citation graph |
| `/search` | full-text + citation search |
| `/editions` | edition policy, standards, provenance |
| `/about` | what this is, licence, how to cite |
| `/errata` | corrections log + report-an-error form/link |

### 7.1 The apparatus as data (`/texts/<slug>/apparatus.json`)

MEASURED, and why the route exists: the edition page used to INLINE the version's
repair log — 415 rules of markup, 324,245 bytes on proclus, in which the page image
a reading was decided from was a small thumbnail buried among the 310 rules carrying
no image at all. MEASURED, and why the viewer that reads this file is not leaf-only:
most readings carry no page image (porphyry: 384 rules, 4 readings read off a leaf,
and its first stored leaf carries none), so a leaf-first landing opened on an empty
panel and the readings with no image were reachable only through a small entry at the
end of the leaf strip. The file is the version's whole record, and the page's viewer
browses it on TWO AXES — the readings (the whole log, and the readings with no page
image, each paged 25 at a time) and the leaves — landing on the first leaf that HAS
readings.

MEASURED (2026-10-05), and why the VIEWER has a route of its own: the viewer was still
rendered BELOW the edition page's whole reading view, so a reader had to scroll through
the entire text to reach the leaf panel — the apparatus was buried, and the leaf index
was a nested scroll region (`.app-leaves { max-height: 36rem; overflow: auto }`) a
reader got stuck in. So the viewer moved to `/texts/<slug>/apparatus/` (and the pinned
`/texts/<slug>/v/<semver>/apparatus/`) with a bounded, self-scrolling leaf rail beside a
sticky panel — MEASURED both ways round: with the rail's cap alone it was a nested
scroll a reader was held in, and with the cap removed the whole scan flowed down the
page so a late leaf was a page-scroll away from the panel above it. The edition page
keeps its bibliographic record, citation, text and provenance,
and carries the short statement plus the door. The DATA ADDRESS DID NOT MOVE — the two
apparatus pages fetch `/texts/<slug>/apparatus.json` and
`/texts/<slug>/v/<semver>/apparatus.json` exactly as the edition page did. A
`#repair-<id>` fragment still selects the reading: on the apparatus page the viewer
reads it as before, and the edition page REDIRECTS an old `#repair-<id>` to
`/texts/<slug>/apparatus/#repair-<id>`, so the address /errata printed before this
route existed still resolves.

MEASURED (2026-10-05), and what changed when the whole scan was fetched: the leaf
axis is THE WHOLE STORED SCAN — 141 leaves for proclus, 72 for porphyry
(`tools/fetch-scans.mjs`) — one run in leaf order, with the leaves a reading was
decided from MARKED (a badge and a darker rule) and NOT separated from the rest; a
leaf no reading used still shows its page image and says plainly that it carries
none, which is the point of storing every leaf; and a pager steps to the next stored
leaf (`app-leafnav`), disabled at the ends of the run. The shape:

```jsonc
{
  "slug": "proclus-elements-of-theology-taylor-1816",
  "version": "1.0.0",
  "ruleCount": 415,                       // = rules.length
  "counts": { "OCR": 211, "punctuation": 105, "transliteration": 99 },
  "leafCount": 141,                       // leaves stored in the edition's scans/
  "leaves": [                             // one per STORED leaf, in leaf order —
    { "n": 806,                           //   including the leaves no rule cites
      "url": "/texts/<slug>/scans/n806.jpg",
      "page": null,                       // printed page the record stamps, or null
      "readings": 0 }                     // rules decided from it
  ],
  "rules": [                              // the version's log, in record order
    { "id": "r0001",                      // the anchor's own form: #repair-r0001
      "ref": "proclus-…-1816:r0001",      // the full id a citation uses (model §4.2)
      "find": "T>ROPOSITION XXVI.",       // location.find, as the record holds it
      "type": "OCR", "apply": "opener",
      "before": "…", "after": "…",
      "rationale": "…", "witness": "Dodds' prop. 26", "date": null,
      "evidence": [ { "leaf": 873, "page": 368,
                      "url": "/texts/<slug>/scans/n873.jpg", "exists": true } ] }
  ]
}
```

- `leaves[].page` is NULL when the record stamps none **or two different ones** for
  that leaf (MEASURED: proclus `n865` is stamped page 360 by `r0041` and none by
  `r0045`): a caption may not pick one of two recorded pages, so the leaf's own
  entry does not, and each reading's entry prints the page the record stamps for it.
- A rule with no evidence entry is a reading decided without a page image; a rule
  whose entry has `exists:false` cites a leaf the edition does not hold, and its
  `url` is **null** — the citation is kept and no image is claimed (MEASURED
  2026-10-05: with the whole scan stored, no served citation is unheld, so the form
  is exercised by a doctored data file in tools/apparatus-probe.mjs rather than by
  the served data).
- The file holds the books' own words, so it is gated as a DATA FILE (hard rules
  only), exactly like `/search/index`. The address is PUBLIC (it is linked from the
  apparatus page's no-script statement, and from the edition page's statement), so
  the leak gate's published-address exemption carries it as a whole address — the
  only form allowed.

---

## 8. Export (survival of the corpus)

The build emits, in addition to HTML:

- `/data/corpus.json` — every published edition's metadata + version list.
- `/data/graph.json` — the graph as published.
- `/texts/<slug>/apparatus.json` — the version's whole repair log, with its leaf
  evidence (the file the apparatus page's viewer reads; §7.1).
- `/texts/<slug>/v/<semver>/plain` — plain text per version.
- TEI export is desired but not required for v1; the model above is the source it
  will be generated from.

All exports are plain files in the static tree; nothing depends on a server.

---

## 9. Redirects (blog → library)

Every old blog URL that pointed at a library item 301s to its new URL.

| old (blog) | new (library) |
|---|---|
| `/library/` | `https://neoplatonic-library.org/` |
| `/library/<slug>/` | `https://neoplatonic-library.org/texts/<slug>/` |

Slugs are unchanged across the migration, so the map is direct. Redirects are
emitted by the changed blog build, and MUST be live before the blog removes any
library page.
