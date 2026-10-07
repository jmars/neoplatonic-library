# The Neoplatonic Library

A citable library of restored public-domain editions of the Neoplatonic
tradition — the texts, the whole scan each reading was decided from, and the
repair log that records every editorial emendation.

Live at **https://neoplatonic-library.org**.

## What is here

```
data/editions/<slug>/
    edition.json              bibliographic record, version, licence, citation, DOI
    versions/<semver>/
        source.txt            the served transcription, frozen at this version
        repairs.json          the repair log — every rule, with type, location,
                              before/after, rationale, witness and the leaf it
                              was read from
        meta.json             date, note, source hash, citation
        base.json             the edition's shared damage policy
    scans/                    the WHOLE scanned book, leaf by leaf
    import.json, scan.json, witnesses.json, derivs.json …
                              the source provenance records
data/graph/graph.json         the transmission / citation graph (nodes + edges)
data/site.json                site identity, licence, citation policy
build/                        the static site build (no server, no framework)
tools/                        the reader/extract/migration/verification tooling
design/library.css            the design system ("Reading Room")
design/DESIGN-SYSTEM.md       the design contract
docs/DATA-MODEL.md            the data model
elm/                          the reader client (Elm), compiled to tools/app.js
```

Each edition is a versioned, frozen object. `source.txt` never changes under a
version; a correction ships as a new version and the old one keeps resolving.

## Routes

`/` · `/texts` · `/texts/<slug>` · `/texts/<slug>/apparatus` ·
`/texts/<slug>/scans` · `/texts/<slug>/v/<semver>` ·
`/texts/<slug>/v/<semver>/apparatus` · `/graph` ·
`/search` · `/editions` · `/about` · `/errata`.

The repair log is browsed as a **leaf viewer** on its own page,
`/texts/<slug>/apparatus/`: the page images are the unit of
provenance, so a reader pages through the scan and sees the readings decided from
each leaf.

Everything the site serves is also plain data: `/data/corpus.json`,
`/data/graph.json`, and `/texts/<slug>/apparatus.json`.

## Build and deploy

```
node build/build.mjs        # → site/dist/
./tools/deploy.sh           # rsync site/dist/ to the host
```

The build needs only Node — no pandoc, no framework. Verify with the probes in
`tools/` (`apparatus-probe`, `route-probe`, `search-probe`, `scan-probe`,
`leak-probe`, `exports-probe`, `version-probe`, `repair-id-probe`,
`standalone-probe`, `heads-probe`, `library-smoke`, `library-extract-smoke`,
`library-app-smoke`).

## Adding a text

**Find as many copies as exist — scans, transcriptions, other printings of the
same edition — measure their OCR, and build on the cleanest one.** Hold the
others as witnesses.

This is not optional polish. A book added from the first copy to hand was later
found to be built on the weakest of four scans of the same 1816 print — 85%
plausible tokens against 97% for the best. The reading view came out
unreadable — `"…{ ireames against the bertien 9 dat nee 0 Valet…"` where a
better copy reads *"Indeed, that after the great incomprehensible cause of all,
a divine multitude subsists…"* — and a day of repair could not fix it, because
**repair cannot recover a bad base.** The copy chosen also becomes the edition's
scans, so it is a data decision as much as a textual one.

**Check coverage, not just quality.** In that case the two cleanest copies
turned out to carry only the first volume; the cleanest copy of the *whole* work
was a third scan. Score every candidate, then keep the ones that carry what the
edition needs — the others are witnesses, and any part no clean copy carries has
to be sourced from the best copy that does.

The test is cheap: sample a few hundred thousand characters from the middle of
each candidate and score the share of word-shaped tokens. It separates the copies
in seconds, and it should be run **before** anything is imported.

## Licence

The transcriptions are **public-domain** works. The editorial work — repairs,
page models, the apparatus, the notes — is released under **CC BY 4.0**. See
`LICENSE` and `LICENSE-editorial`.

## How to cite

Cite the edition, the version, and the URL. Every edition page carries a
formatted citation string. For example:

> Proclus, *The Elements of Theology*, trans. Thomas Taylor (London, 1816). The
> Neoplatonic Library, version 1.0.0.
> https://neoplatonic-library.org/texts/proclus-elements-of-theology-taylor-1816/

The texts stand on their own; the essays at the blog are one reader's reading.
