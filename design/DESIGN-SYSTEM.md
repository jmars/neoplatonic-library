# The library's design system — "Reading Room"

**Status: IMPLEMENTED (design/library.css), and updated after an independent
visual review of the deployed pages.** The library's own design system: a warm
paper palette, a masthead wordmark with a rubric rule, a catalogue of editions,
a first-class apparatus, and a colophon. It replaced the blog's terminal identity
(a `$ neoplatonic-library.org` prompt hero, a blinking cursor, an `ls`/`cat`
command-line palette) with one that suits what the library is: **a citable corpus
of restored editions, with a scholarly apparatus.**

The library is not a blog post. It is a *reading room*: the text first, the
apparatus second, the provenance and citation always at hand. The design reads as
a scholarly edition — typography-led, quiet, precise — not as a terminal.

**The review's findings, and where each is settled** (all are in the CSS or in
the page builders; the sections below are the contract that was changed):

1. the home states the collection's **scope** (a derived count) and links
   **All texts → /texts** (§5);
2. the search **button is secondary** — an outline control, not a filled accent
   block (§6);
3. the catalogue is **one list on the library's own terms** — ordered by author
   (surname), with a factual sort control (Author · Title · Year) and a
   repair-state filter, and with **no collection label and no interpretive
   line** (§5, §6);
4. small-caps labels are set in `--label` at 12–12.5px: legible, still quiet
   (§3, §4);
5. **nav and footer are differentiated** — nav 13px `--label` with a rule on the
   current entry; footer headings 11px `--dim` (§4, §6);
6. catalogue **titles are underlined links** with a hover state (§6);
7. the citation's **prose is the serif**; only its identifier and URL are
   `--mono` (§5.2, §6);
8. **no doubled headings and no version printed three times** on the edition page
   (§5.3);
9. metadata labels/values polished: `Year`, the language NAME from a small map
   (the code stays in data), the archive item NAMED as the link text, the source
   edition a **bibliographic line** (§5.1);
10. the nav has a **current-page state**, and the edition page carries a
    **breadcrumb** and an **in-page contents list** (§5.1a);
11. the vermilion **accent recurs** — masthead rule, the nav's current entry,
    the wordmark on the home page, the catalogue's active sort and the state
    dot, the apparatus filter's active state, focus rings, the citation block's
    left rule (§6).

---

## 1. The one rule

**The page is a leaf of an edition, not a screen of a shell.** No prompt, no
cursor, no command metaphor, no `ls`/`cat`. Where chrome is needed it is a
library's chrome: a masthead, a catalogue, an apparatus, a colophon.

## 2. Identity

- **Name:** The Neoplatonic Library.
- **Mark:** a wordmark — the name set in the display serif, with a thin rubric
  rule beneath it (classical edition style). No icon required.
- **Statement (masthead, one line):** *Restored public-domain editions of the
  Neoplatonic tradition, with their repair logs and citation graph.*
- **Relation to the blog:** *The texts stand on their own; the essays are one
  reader's reading.* This one line survives as `/about`'s standfirst; the
  paragraph that named the blog and linked out to its about page is **removed
  from `/about`**. The essays are reached only from the edition pages that carry
  a reading, and from nowhere else.

## 3. Tokens

Keep the reader app's token **names** (they are the CSS contract the compiled
`tools/app.js` and `READER_CSS` bind to) and give them the library's values. Add
the new tokens beside them.

| token | role | Reading-Room value |
|---|---|---|
| `--bg` | paper | `#faf7f0` warm ivory |
| `--bg2` | recessed paper / rules fill | `#f1ece0` |
| `--fg` | ink | `#1c1a17` iron-gall near-black |
| `--dim` | secondary ink | `#6b6459` |
| `--label` | small-caps labels (eyebrows, field names, footer headings) | `#45403a` — 9.6:1 on the paper (`--bg`), so the smallest tracked type on the site is legible; still much lighter than `--fg` (16.2:1), so it stays quieter than the text it labels |
| `--line` | hairline rule | `#ddd5c4` |
| `--rule` | heavier rule (masthead) | `#c3b89f` |
| `--accent` | rubrication (marks, active) | `#8a2b23` deep vermilion |
| `--accent2` | links | `#26456e` indigo |
| `--serif` | display + reading | `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Charter, Georgia, serif` |
| `--sans` | chrome/labels | `-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` |
| `--mono` | data: citations, IDs, DOIs, versions | `"SFMono-Regular", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace` |
| `--measure` | reading measure (prose that is NOT the reader or the apparatus) | `34rem` (≈66ch) |
| `--reader` | **the reading width**: the reader section on the edition page AND the apparatus page (the viewer's own route, §5.4) | `1240px` |
| `--wide` | catalogue/graph width | `72rem` |
| `--space-1..6` | spacing scale | 4 / 8 / 12 / 20 / 32 / 56 px |

**Palette rationale:** parchment and iron-gall ink, rubricated in deep vermilion
— the vocabulary of a printed edition. Distinct from the blog's bright
`#a4262c`/`#2158b0` and its cooler `#fbfaf7` paper by being warmer, duller and
more austere.

**Theme:** light only. The reading room is paper. Drop the dark theme toggle.

## 4. Typography

- **Display / titles / body:** `--serif`. Titles use a slightly tighter leading;
  body 1.7.
- **Chrome, labels, nav:** `--sans`.
- **Two label sizes, and they are different roles.** NAV and section eyebrows are
  13px / 12.5px, `--label`, letter-spaced `0.08em`, UPPERCASE (small-caps feel).
  FOOTER headings are 11.5px in `--label` and carry no rule — a footer, not a
  second nav (findings 4, 5).
- **A CAPTION is not a label.** A section's or the catalogue's one-line
  description (`.hint`, `.cat-legend`) is the reference **serif** at 0.9375rem in
  `--dim`. MEASURED on the deployed pages: those descriptions were set in the
  same uppercase sans as the labels, so "The edition" + "the bibliographic
  record" read as TWO HEADINGS, and the apparatus's three-sentence summary was
  rendered in uppercase (findings 3, 4, 8).
- **Data:** `--mono` — citation identifiers, DOIs, versions, repair IDs, slugs.
  NOT a whole prose citation (finding 7, §5.2).
- **Scale:** display 2.1rem · h2 1.4rem · catalogue title 1.1rem · h3 1.1rem ·
  body 1.0625rem · caption .9375rem.
- First-line indentation of body paragraphs off; space between paragraphs.

## 5. Page structure

Every page: **masthead** (wordmark + rule + one-line statement) → **nav**
(Texts · Graph · Search · Editions · About · Errata) → content → **colophon**
footer. The nav lights the page's own section: a vermilion label with a vermilion
rule under it (finding 10).

**The masthead is COMPACT on interior pages.** MEASURED: on a deep page the site
masthead was set at the same 2.1rem as the page's own `<h1>`, over 56px of top
padding, and dominated the top of the viewport before the page said what it was.
The HOME keeps the full masthead — there the wordmark's `<h1>` IS the reading
room's own heading, and the statement is its lede. Everywhere else the wordmark
is a `<p>` at 1.15rem with tighter padding, the rubric rule is set closer, and
the statement is a single quiet line at 0.875rem, so the page's own title leads.
The wordmark is the link home on both, and it keeps its current-page state (the
home page's `.wordmark a.home`, the rubric). The distinction rides on the
element the markup already carries (`h1` vs `p`), so the header needs no class of
its own.

### `/` — the reading room
The corpus IS the home page. Masthead; the **collection's scope** — the derived
count of editions, the **search field**, the doors, and an **All texts → /texts**
affordance, all ABOVE the catalogue (finding 1); then the **catalogue** (the
published editions as entries, each: author · title · translator · year ·
version · repair state). No blog-style hero.

### `/texts` — the catalogue
All published editions, as catalogue entries — the same component as home.

**The catalogue is on the library's own terms.** ONE list, ordered by **author
(surname), then title**, with a **factual sort control** (Author · Title · Year)
and a **factual filter** (the repair state), and a legend that says what the
state pill means. There are **no collection labels and no interpretive line**:
the blog's argumentative grouping is not the library's, and the library does not
advertise it. The control is a progressive enhancement — without scripts the
reader keeps the served order (by author) and the whole catalogue; the `data-`
keys the script sorts on are the SAME keys the served order is computed from, so
the two cannot disagree. Author names may act as lightweight headings; they are
not required, and no reading of the corpus is printed.

### `/texts/<slug>` — the edition

**5.1a Where the page sits, and what is on it.** A **breadcrumb** back into the
hierarchy (Library / Texts / Author / Work — findings 10), and an in-page
**contents list** (`#the-edition`, `#how-to-cite`, `#the-text`, `#the-apparatus`,
`#provenance`). The restored TEXT and the APPARATUS are below the fold
(finding: the review screenshot only caught the top), so the page SAYS they are
there and jumps to them. Neither moves the text or the apparatus.
**The list is STICKY under the site nav** (the nav's own pattern: `body > nav` is
sticky at `top: 0`), so the three regions stay reachable while a reader is deep
in eighty screens of text, and it carries a **back-to-top** control at its end.
Its top is the nav's MEASURED height (`--nav-h`) and the reader's own sticky
toolbar stacks below both it and the list (`--nav-h` + `--jump-h`), because the
nav WRAPS and neither offset can be a constant.

A fixed scholarly order:
1. **Bibliographic record** — a definition list: author, title, translator,
   `Year`, source edition (as a **bibliographic line** composed from the record's
   structured fields, not its prose statement), scan source (the archive item
   NAMED as the link text), language (the NAME, from a small map — the code stays
   in data). (finding 9)
2. **Citation block** — the citation string with its **prose in `--serif`** and
   its **URL in `--mono`, hyperlinked: ONE address, not two.** The URL's scheme
   and host are ONE `.cite-host` run set `white-space: nowrap` and the builder
   puts a `<wbr>` after each path separator, so the only break opportunity is a
   path boundary and the host is never split mid-domain (a browser breaks at the
   literal hyphen in `neoplatonic-library.org` however the `<wbr>`s are placed —
   the span is what closes it). The duplicate address line is gone, and the
   page's own address is the head's canonical link. DOI when present. The string
   itself is the version's own: `Author, Title[, trans. Translator] (Place,
   Year). The Neoplatonic Library, version <v>. <url>` — no `ed.` before the
   version, which is not what `ed.` means in a citation. (finding 7)
3. **The text** — the reader (`.rd*`, unchanged mechanism), its toolbar.
4. **The apparatus** — a SHORT statement of the version's repair log and **the
   door to its own page** (`/texts/<slug>/apparatus/`, §5.4). The viewer used to
   be rendered HERE, below the whole reading view, so a reader had to scroll
   through the entire text to reach the leaf panel (and the leaf index was a
   nested scroll region they got stuck in). The line is DERIVED from the record
   — "The apparatus — 141 leaves, 105 readings read from a page image →" — so it
   cannot advertise leaves or readings the version does not hold, and the section
   keeps the published `#the-apparatus` anchor.
5. **Provenance** — where the transcription came from; **that the source scans
   are stored with the edition and served** at `/texts/<slug>/scans/`, with the
   archive item linked to its page; the licence split (text public-domain /
   editorial CC-BY-4.0); attached readings as links out.

**5.3 No doubled headings.** A section is its `<h2>` and a caption, never two
headings, and the version is stated where it belongs — inside the citation string
and in the version notice — not a third time in a section description
(finding 8).

### `/texts/<slug>/apparatus` — the apparatus page (§5.4)

**Why it is its own route.** The viewer was rendered below the whole reading
view, so the apparatus was buried behind eighty screens of text; the edition page
now carries the short statement and the door (§5.1a item 4), and the interface
lives here. The page carries: a **breadcrumb** (Library / Texts / Author / Work /
The apparatus) whose Work step links BACK to the edition (the deep link both
ways); a **sticky in-page jump bar** (`#app-leaves` "The leaf index", `#app-panel`
"The panel") and the **back-to-top** control, the same bar the edition page has;
the server-rendered statement of what the apparatus is; and the viewer. The
pinned `/texts/<slug>/v/<semver>/apparatus/` is the same page for a pinned
edition, with its own canonical and its breadcrumb pointing at the pinned edition
page. **The data address does not move**: both fetch `/texts/<slug>/apparatus.json`
and `/texts/<slug>/v/<semver>/apparatus.json` (model §7.1).

**The viewer, on TWO AXES**, because most readings have no page image (MEASURED:
porphyry has 384 readings and 72 stored leaves, and only 4 of the readings were
read off one — its first stored leaf carries none). The log is a fetched data
file (`/texts/<slug>/apparatus.json`, model §7.1) rendered as
- a **readings axis**: an **All readings** entry (the whole log, in record
  order) and a **Without a page image** entry (the readings that rest on no
  leaf), both listed compactly and **paged 25 at a time** with the range, the
  total and the page stated, so no view is a wall;
- a **leaf axis**: one entry per stored leaf (a small thumbnail, its number,
  and how many readings were decided from it); a leaf **no reading was decided
  from says so** ("no readings", set apart with a broken rule), so an empty
  leaf can be told from a leaf the filter has merely emptied — never a trap —
  then an entry per leaf that is cited but **not held**;
- a **panel** for the selection: for a leaf, the page **filling the panel's own
  column** (it is bounded by the column, not by a viewport height — MEASURED:
  `width: auto` beside a `max-height: 82vh` held a ~1400×2500px leaf to ≈430–560px
  wide, a strip beside the ~916px column the panel has), its caption `archive leaf
  nNNN · printed page M`, and beneath it the readings decided from that leaf — id,
  type, pipeline class, before → after, rationale, witness — each anchored
  `#repair-<id>`. The panel carries its own way BACK to the index (`app-to-index`,
  `↑ The leaf index`), which scrolls without touching the fragment;
- **controls**: the four-type filter and a word search over the located text,
  the reading and the reason, applied to BOTH axes.

**THE LEAF INDEX IS NOT A SCROLL TRAP.** It used to be a nested scroll region
(`.app-leaves { max-height: 36rem; overflow: auto }`, and 18rem below 56em) inside
the page's own scroll: a reader who scrolled into it was held in a 36rem window
and had to leave it (or use the jump list) to get anywhere. It FLOWS in the page
now — the page's own scroll is the only scroll, the whole scan runs down the left
column, and the panel, the jump bar and the back-to-top control are always
reachable by that one scroll. `scroll-margin-top` keeps a jump to the index or the
panel clear of the two sticky bars.

**The landing is never empty**: the viewer opens the first leaf that HAS
readings (on porphyry that is `n33`, not the first stored leaf `n0`), and the
no-image group when no leaf carries one — a reader who arrives on an empty
panel concludes the apparatus shows nothing, which is the one thing it must
never say. The viewer's code is inlined; the log is NOT. A `#repair-<id>`
fragment opens the entry that rule belongs to, **turns to the page** of a paged
list it falls on and highlights the reading, which is how `/errata`'s rows (and
the cited-but-not-held leaves) link into it — and an OLD `#repair-<id>` on the
edition page is REDIRECTED here, so a link published before this route existed
still resolves. A fragment that names no entry (`#app-leaves`, `#app-panel`,
`#top` — the jump bar and the back-to-top control) is an in-page jump and never
resets the selection. A `<noscript>` and a failed fetch both leave a
server-rendered statement standing that says what the apparatus is, **how many
readings have a page image and how many do not**, and names the data file — the
viewer never silently shows nothing. Scholarly and quiet: no crop is made (the
stored leaf IS the region), and the rubric marks POSITION (the selected entry,
the linked reading).

**Its width is the reader's width.** The section is `#the-apparatus .wrap`
(`--reader`, 1240px) — the same token as the reader on the edition page, on the
same 24px gutter — and NOTHING inside is capped short of that column. MEASURED:
the summary and the notes were capped at `--measure` (34rem = 544px) and the
readings at 46rem = 736px under a reader whose pane is 892px, so the apparatus
rendered as the NARROWER column, its margins empty on a wide screen (the author's
report). The summary is the section's own `.hint`, widened here ALONE
(`#the-apparatus .hint`): `.hint` still holds every other section's one-line
description at `--measure`. The leaf index is a finder, not a paragraph, and is
sized to that job (16rem = 256px); the panel takes the rest (916px); below 56em
the grid collapses to one column and the panel takes the viewport, the index
still flowing. `tools/apparatus-probe.mjs` §6 measures this off the EMITTED
stylesheet (reading the apparatus page's rules AND the edition page's, where the
reader contract still lives).

**And the viewer is NOT prose.** The reader's column is a `.prose` box
(`build/shell.mjs` `section()`), and `.prose` caps its child at `--measure` (544px)
ON SCREEN — the `max-width: none` beside it is inside `@media print` only. The
apparatus viewer is an interface (a grid, a finder, a page image), so its section
is emitted with `prose: false`: `#apparatus-viewer` sits directly in `#the-apparatus
.wrap` and inherits no cap, and the ONE genuinely prose piece inside it — the
no-script fallback — carries `.prose` itself and keeps the measure. Measured on the
ancestor chain: `tools/apparatus-probe.mjs` §7, which walks the EMITTED markup's
chain (and proves the asymmetry by re-wrapping the viewer in `.prose`: 544px then,
1192px now).

### `/graph`, `/search`, `/editions`, `/about`, `/errata`
Scholarly pages: `/graph` a figure + a typed edge table; `/search` a search
field and result list (the result is a citation, not a card); `/editions` the
policy and provenance; `/about` what it is + licence + how to cite; `/errata`
the corrections log + how to report.

## 6. Components (the system's vocabulary)

masthead · nav (with the current entry lit) · **breadcrumb** · **page-contents**
(the page's jump list — STICKY under the nav on the edition and apparatus pages,
with a `to-top` back-to-top control at its end) · eyebrow (small-caps label) ·
**catalogue** ·
**catalogue-controls** (the factual sort and repair-state filter) ·
catalogue-entry (with its `data-` sort keys) ·
**collection-scope** (the home's count, search field, doors and All-texts door) ·
bib-record (dl) · citation-block (serif prose, `--mono` URL) · **apparatus-viewer
(two axes: `app-leaf-all` / `app-leaf-none` scope entries, `app-leaf` thumbnails
with `app-leaf-quiet` for a leaf no reading was decided from, `app-panel`,
`app-pager` for a list longer than the page, `app-to-index` for the panel's way
back to the index, and `app-compact` for the long
reading lists)** · apparatus-entry · **leaf-evidence** (the page image a
reading was decided from: the panel's full-column leaf, captioned `archive leaf nNNN ·
printed page M`, and a stated "not held" for a leaf cited but not stored) ·
state-pill (repaired / in-repair / damaged, with a state dot and its meaning in
`title`) · rule / hairline · colophon · search-field (its button SECONDARY — an
outline control) · result · graph-figure · page (shell).

**The accent's meaning.** Vermilion (`--accent`) marks POSITION and the current
state, and it recurs where that meaning holds: the masthead's rubric rule, the
nav's current entry, the wordmark on the home page, the catalogue's active sort
and the state dot of an unfinished or unrepaired edition, the apparatus filter's
active state, the citation block's left rule, and every `:focus-visible` ring. It
is NOT spent on a submit button (finding 11, and finding 2 in §5).

## 7. What it must keep working

- The compiled reader (`tools/app.js`) and `READER_CSS` bind to the token names
  in §3 and to `.rd*` / `.prose` classes. **Do not rename those.** Re-skin their
  values; verify the reader still boots (app-smoke) and renders.
- Every gate stays green: build, library-smoke, library-extract-smoke,
  library-app-smoke, version-probe, exports-probe, repair-id-probe,
  standalone-probe, route-probe, search-probe, leak-probe, scan-probe,
  apparatus-probe.

## 8. Deliberately removed

Terminal prompt hero and `$`; blinking cursor; the `ls`/`cat`/`group` command-line
palette; the dose meter; any series/dropdown chrome; the dark theme.
