/**
 * tools/shelf.mjs — the shelf: which texts the library holds, and where.
 *
 * The axis is the BLOG's, not a book list's. The four groups below are the
 * site's own structural argument, arranged as a shelf so a reader can walk it:
 * the ascent FROM INSIDE (the route that ends in the practitioner's own state),
 * the ascent PERFORMED (the route moved out into a rite), the ascent ARGUED
 * (the route moved out into system and proof), and the COUNTER-TEXTS (what the
 * traditions outside that line say instead). Two further groups hold the works
 * that are not on that line at all: the dialogues and commentaries the line
 * READS, and the other ascents — the Christian contemplatives, the Renaissance
 * operators and the Buddhist path — which walk the same route in other
 * languages.
 *
 * Every entry names the EDITION (author, title, translator/editor, year), never
 * a shelf path: the pages are public, the shelf is not. The edition lines were
 * read off each volume's own title page or imprint, or (for the 28 texts
 * sourced for this blog) off the sourcing report's verbatim evidence; a line
 * that could not be confirmed from the volume says so.
 *
 * `cat` maps a text to the works in the site's own source catalogue
 * (tools/catalogue.json) that it IS — an edition of. The readings-cited-by line
 * on a page is then computed with the blog's EXISTING citation derivation
 * (`citations()` in build.mjs, the one the map uses), so a library page and the
 * map cannot disagree about which reading cites what. An empty list means the
 * citation record names no such work, and the page says exactly that.
 *
 * `unreadable` is not set here: whether a scan can be served as prose is
 * MEASURED from the text itself (see reader.mjs `assess`) and the page states
 * the measurement. An entry needs no flag to be honest about its own OCR.
 *
 * `published` IS set here, and it is the library's publication switch (plan §11
 * phase 5). What it used to be was an environment variable — LIBRARY=1 built the
 * whole shelf or none of it — and that was the wrong shape for the decision:
 * whether a text is worth reading is a fact about THAT text, and the shelf is
 * exactly where the facts about a text live. So the flag sits on the entry, a
 * default build serves the entries that carry it and nothing else, and LIBRARY=1
 * is demoted to what it always was underneath: a PREVIEW switch that builds every
 * entry regardless, so the tests and a reader can see the held-back shelf.
 * Held back by default is the honest state for a text whose transcription is not
 * yet worth reading; an entry flips on when its edition, its anchors and its
 * repairs are green, and the shelf's other entries are unaffected either way.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Where the scans live. Internal, and read-only: the shelf is not this repo.
 * Overridable so a build can be pointed at another copy. */
export const SHELF = process.env.LIBRARY_SHELF || join(homedir(), 'thework', 'work-text');

/** The text files actually present, so a filename is never guessed. */
export function shelfFiles() {
  if (!existsSync(SHELF)) {
    throw new Error(
      `library: the shelf is not at ${SHELF} — set LIBRARY_SHELF to the directory holding the scans`,
    );
  }
  return new Set(readdirSync(SHELF).filter((f) => f.endsWith('.txt')));
}

/** Resolve a text's `file` against the directory listing. Matching by prefix
 * means a shelf that renames a scan's tail still resolves, and a name that is
 * not there fails the build instead of silently serving nothing. */
export function shelfFile(name, files) {
  if (files.has(name)) return name;
  const prefixed = [...files].filter((f) => f.startsWith(name));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new Error(`library: '${name}' matches ${prefixed.length} files on the shelf — name one exactly`);
  }
  throw new Error(`library: no shelf file starting with '${name}'`);
}

export const GROUPS = [
  {
    key: 'ascent-inside',
    label: 'the ascent from inside',
    line: 'the route that terminates in the practitioner’s own state',
  },
  {
    key: 'ascent-performed',
    label: 'the ascent performed',
    line: 'the route moved out into a rite',
  },
  {
    key: 'ascent-argued',
    label: 'the ascent argued',
    line: 'the route moved out into system and proof',
  },
  {
    key: 'counter-texts',
    label: 'the counter-texts',
    line: 'what the traditions outside that line say instead',
  },
  {
    key: 'philosophy-sources',
    label: 'the sources of the philosophy',
    line: 'the dialogues the line reads, and the commentaries written directly on them',
  },
  {
    key: 'other-ascents',
    label: 'the other ascents',
    line: 'the same route walked in other languages — the Christian contemplatives, the Renaissance operators, and the Buddhist path',
  },
];

/** The translations of these works that are NOT free, named on the index as the
 * boundary the library stops at. */
export const MODERN_EDITIONS = [
  { what: 'the Chaldean Oracles', who: 'Majercik' },
  { what: 'the Orphic Hymns', who: 'Athanassakis & Wolkow' },
  { what: 'the Elements of Theology', who: 'Dodds' },
  { what: 'Iamblichus, On the Mysteries', who: 'Clarke, Dillon & Hersh' },
];

export const TEXTS = [
  /* ---------- 1. the ascent from inside ---------- */
  {
    slug: 'plotinus-select-works-taylor-1895',
    group: 'ascent-inside',
    file: 'Plotinus-Taylor-Select-Works-1895',
    title: 'Select Works of Plotinus',
    author: 'Plotinus',
    translator: 'Thomas Taylor',
    year: 1895,
    lang: 'en',
    edition:
      'Select Works of Plotinus, translated by Thomas Taylor; a new edition with a preface and bibliography by G. R. S. Mead (London, 1895).',
    cat: [],
  },
  {
    slug: 'plotinus-five-books-taylor-1794',
    group: 'ascent-inside',
    file: 'Plotinus-Taylor-Five-Books-1794',
    title: 'Five Books of Plotinus',
    author: 'Plotinus',
    translator: 'Thomas Taylor',
    year: 1794,
    lang: 'en',
    edition:
      'Five Books of Plotinus — On Felicity; On the Nature and Origin of Evil; On Providence; On Nature, Contemplation and the One; and On the Descent of the Soul — translated by Thomas Taylor (London, 1794).',
    cat: [],
  },
  {
    slug: 'thrice-greatest-hermes-mead-vol-1-prolegomena-1906',
    group: 'ascent-inside',
    file: 'Thrice-Greatest-Hermes-Mead-Vol-1-1906',
    title: 'Thrice-Greatest Hermes, vol. I — Prolegomena',
    author: 'Hermes Trismegistus (attrib.)',
    translator: 'G. R. S. Mead',
    year: 1906,
    lang: 'en',
    edition:
      'Thrice-Greatest Hermes: Studies in Hellenistic Theosophy and Gnosis, being a translation of the extant sermons and fragments of the Trismegistic literature, with prolegomena, commentaries and notes, by G. R. S. Mead, vol. I — Prolegomena (London and Benares: The Theosophical Publishing Society, 1906).',
    cat: [],
  },
  {
    slug: 'thrice-greatest-hermes-mead-vol-2-sermons-1906',
    group: 'ascent-inside',
    file: 'Thrice-Greatest-Hermes-Mead-Vol-2-1906',
    title: 'Thrice-Greatest Hermes, vol. II — Sermons',
    author: 'Hermes Trismegistus (attrib.)',
    translator: 'G. R. S. Mead',
    year: 1906,
    lang: 'en',
    edition:
      'Thrice-Greatest Hermes, by G. R. S. Mead, vol. II — Sermons, i.e. the Hermetic sermons known as Corpus Hermeticum (London and Benares: The Theosophical Publishing Society, 1906).',
    cat: [],
  },
  {
    slug: 'thrice-greatest-hermes-mead-vol-3-excerpts-and-fragments-1906',
    group: 'ascent-inside',
    file: 'Thrice-Greatest-Hermes-Mead-Vol-3-1906',
    title: 'Thrice-Greatest Hermes, vol. III — Excerpts and Fragments',
    author: 'Hermes Trismegistus (attrib.)',
    translator: 'G. R. S. Mead',
    year: 1906,
    lang: 'en',
    edition:
      'Thrice-Greatest Hermes, by G. R. S. Mead, vol. III — Excerpts and Fragments (London and Benares: The Theosophical Publishing Society, 1906).',
    cat: [],
  },

  /* ---------- 2. the ascent performed ---------- */
  {
    slug: 'iamblichus-on-the-mysteries-taylor-1895',
    group: 'ascent-performed',
    file: 'Iamblichus-On-the-Mysteries-Taylor-1895',
    title: 'On the Mysteries of the Egyptians, Chaldeans and Assyrians',
    author: 'Iamblichus',
    translator: 'Thomas Taylor',
    year: 1895,
    lang: 'en',
    edition:
      'Iamblichus on the Mysteries of the Egyptians, Chaldeans, and Assyrians, translated by Thomas Taylor; second edition (London: Bertram Dobell, 1895).',
    cat: ['de-mysteriis'],
  },
  {
    slug: 'orphic-hymns-1827',
    group: 'ascent-performed',
    file: 'Orphic-Hymns-Hibbert-1827',
    title: 'The Orphic Hymns',
    author: 'Orpheus (attrib.)',
    translator: '',
    year: 1827,
    lang: 'en',
    edition:
      'An English edition of the Orphic Hymns of 1827. The volume’s own title page cannot supply the translator, printer or place: it is destroyed by the same corruption the text suffers (see below), so no attribution is claimed here.',
    cat: ['the-orphic-hymns'],
  },
  {
    slug: 'chaldean-oracles-mead-vol-1-1906',
    group: 'ascent-performed',
    file: 'The-Chaldean-Oracles-Mead-Vol-I-1906',
    title: 'The Chaldean Oracles, vol. I',
    author: 'The Chaldean Oracles',
    translator: 'G. R. S. Mead',
    year: 1906,
    lang: 'en',
    edition:
      'The Chaldean Oracles, vol. I, by G. R. S. Mead (London and Benares: The Theosophical Publishing Society, 1906).',
    cat: ['the-chaldean-oracles'],
  },
  {
    slug: 'chaldean-oracles-mead-vol-2-1908',
    group: 'ascent-performed',
    file: 'The-Chaldean-Oracles-Mead-Vol-II-1908',
    title: 'The Chaldean Oracles, vol. II',
    author: 'The Chaldean Oracles',
    translator: 'G. R. S. Mead',
    year: 1908,
    lang: 'en',
    edition:
      'The Chaldean Oracles, vol. II, by G. R. S. Mead (London and Benares: The Theosophical Publishing Society, 1908).',
    cat: ['the-chaldean-oracles'],
  },

  /* ---------- 3. the ascent argued ---------- */
  {
    slug: 'proclus-six-books-on-the-theology-of-plato-and-elements-1816',
    group: 'ascent-argued',
    file: 'Proclus-Taylor-Elements-Theology-and-Theology-of-Plato-1816',
    title: 'The Six Books on the Theology of Plato, with the Elements of Theology',
    author: 'Proclus',
    translator: 'Thomas Taylor',
    year: 1816,
    lang: 'en',
    edition:
      'The Six Books of Proclus on the Theology of Plato, translated from the Greek, to which a seventh book is added … also a translation from the Greek of Proclus’ Elements of Theology, by Thomas Taylor (London, 1816).',
    note:
      'This transcription runs the whole edition: the Theology of Plato and the Elements of Theology, with the treatises on Providence and Fate, the Ten Doubts concerning Providence, and the Subsistence of Evil. It is a second transcription of the same edition as the two volume transcriptions beside it on this shelf — measured, not assumed: sampled runs of forty letters from every part of both volumes are found in it at a uniform rate, which is what one edition transcribed twice looks like and what two different works do not.',
    cat: ['proclus-theology-of-plato', 'proclus-elements-of-theology'],
  },
  {
    slug: 'proclus-theology-of-plato-taylor-vol-1-1816',
    group: 'ascent-argued',
    file: 'Proclus-Theology-of-Plato-Taylor-Vol-1-1816',
    title: 'On the Theology of Plato, vol. I',
    author: 'Proclus',
    translator: 'Thomas Taylor',
    year: 1816,
    lang: 'en',
    edition:
      'The Six Books of Proclus on the Theology of Plato, translated by Thomas Taylor, vol. I (London, 1816). The volume’s title page is very badly OCR’d; the edition and date are recorded from the work and from the second volume’s legible title page.',
    cat: ['proclus-theology-of-plato'],
  },
  {
    slug: 'proclus-theology-of-plato-taylor-vol-2-1816',
    group: 'ascent-argued',
    file: 'Proclus-Theology-of-Plato-Taylor-Vol-2-1816',
    title: 'On the Theology of Plato, vol. II',
    author: 'Proclus',
    translator: 'Thomas Taylor',
    year: 1816,
    lang: 'en',
    edition:
      'The Six Books of Proclus on the Theology of Plato, to which a seventh book is added, with a translation of the Elements of Theology, by Thomas Taylor, vol. II (London, 1816).',
    cat: ['proclus-theology-of-plato'],
  },
  {
    slug: 'proclus-elements-of-theology-taylor-1816',
    group: 'ascent-argued',
    // THE WORK AS ITS OWN TEXT, out of the volume that carries it. The Elements
    // of Theology is one work inside the 1816 volume (shelved whole beside this
    // entry, and transcribed twice more as the two volume transcriptions); this
    // entry serves THAT work alone, as the edition prints it — the transcription
    // is the volume's own bytes over the lines the work occupies, recorded in
    // the edition's import.json (`extract`), not a fresh transcription.
    file: 'Proclus-Taylor-Elements-Theology-and-Theology-of-Plato-1816',
    title: 'The Elements of Theology',
    author: 'Proclus',
    translator: 'Thomas Taylor',
    year: 1816,
    lang: 'en',
    edition:
      'Proclus: The Elements of Theology, translated by Thomas Taylor; printed as the second work of The Six Books of Proclus on the Theology of Plato, vol. II (London, 1816). This edition serves the Elements alone, over the pages the volume gives it (301–441).',
    // the archive.org identifier the slice was carved from (import.json records
    // the whole file's sha256 and the line range; the build serves the stored
    // slice and never reads the item)
    item: 'thomastaylor',
    cat: ['proclus-elements-of-theology'],
    // PUBLISHED, and served IN REPAIR. This entry has everything the Cave has —
    // a stored edition, pinned anchors, a page model resting on the volume's own
    // running heads, a repair rule set in which every one of the 374 rules fires,
    // a damage set MEASURED for this print — and one thing it does not: a closed
    // worklist. Its residue is known and counted, so it is served with the state
    // that says so rather than held back, which would hide a readable edition.
    published: true,
    repair: {
      state: 'repaired',
      note:
        'finished: every damaged word and every standalone marker the scanner left has been cleared against ' +
        'the printed page. The reading view shows no damage character at all — every repair the print called ' +
        'for is applied against the 1816 print, its Greek restored from the page images where the letters had ' +
        'been read as Latin lookalikes. One note stands as the transcription has it, the footnote to ' +
        'Proposition XXVII on printed page 321, because the page itself will not read: repeated reads of that ' +
        'one line disagree, so it is left VISIBLE rather than guessed. A second whole-text read has been run ' +
        'over the whole volume.',
    },
  },
  {
    slug: 'proclus-theology-of-plato-taylor-1816',
    group: 'ascent-argued',
    // THE WORK THE TWO VOLUME TRANSCRIPTIONS BESIDE IT ARE OF, served whole. The
    // 1816 edition divides the Theology of Plato over its two volumes: vol. I
    // carries it entire to Book V ch. XXXIX (printed pp. 1-425, ending 'END OF
    // VOL. I.'), vol. II opens on the continuation of that chapter and runs the
    // work to its close at printed p. 299. Vol. II then carries ANOTHER work —
    // the Elements of Theology, pp. 301-441, which is served here as its own
    // edition — and the treatises after it. This entry is the FIRST work alone.
    //
    // RE-SOURCED 2026-10-05, and this entry used to say otherwise: the stored
    // source.txt is NO LONGER these two shelf transcriptions concatenated. It is
    // the text layer of ONE archive item, `thomastaylor` — the same item the
    // Elements edition is cut from, the two volumes bound in one scan — over its
    // `elementsoftheology_proclus_djvu.txt` lines 1-40344, the work entire to its
    // close. The superseded two-volume text read 85.2% of its tokens as
    // dictionary words against 97.4% for this one over the same work span
    // (MEASURED; every candidate copy's own score is in the edition's
    // witnesses.json note), and repair cannot recover a bad base. The range, the
    // whole-file checksum and the slice checksum are in the edition's
    // import.json (`extract.sources`) and its version meta.json.
    //
    // `file` names the vol. I shelf transcription. It is no longer the served
    // source — that is the item's slice above — but the pipeline reads it as the
    // FALLBACK source for an edition with no stored one (`imported || shelfFile`),
    // and both volume transcriptions are held as WITNESSES of the print, recorded
    // with their checksums in the edition's witnesses.json.
    file: 'Proclus-Theology-of-Plato-Taylor-Vol-1-1816',
    title: 'On the Theology of Plato',
    author: 'Proclus',
    translator: 'Thomas Taylor',
    year: 1816,
    lang: 'en',
    edition:
      'The Six Books of Proclus on the Theology of Plato, translated by Thomas Taylor, 2 vols (London: printed for the author, 1816). This edition serves the Theology of Plato alone, over the two volumes the print gives it: vol. I entire, and vol. II only as far as the Theology runs in it (its printed pages 1-299).',
    // ONE archive.org identifier NOW, where this entry used to carry none: the
    // work is cut from a single item, `thomastaylor` — the two volumes bound in
    // one scan — so this is the same shape the Elements edition beside it has.
    // The item, its two page runs, their measured offsets and the superseded
    // two-item range are recorded in data/editions/<slug>/scan.json, which is
    // where the fetch reads them; the shelf's `item` is the archive.org
    // identifier the slice was carved from. The stored leaf file names still
    // carry their volume prefix (v1-nNNN.jpg / v2-nNNN.jpg) because a leaf's
    // volume is part of its identity in the item: one item, two runs of pages.
    item: 'thomastaylor',
    cat: ['proclus-theology-of-plato'],
    // PUBLISHED, and served IN REPAIR, and this is a CORRECTION: this entry stood
    // at `repaired` (commit 8426b4e) and that was an overclaim. `repaired` is the
    // model's word for FINISHED in the sense this library means (the state table
    // below): every damaged place a witness could settle is settled, and what is
    // left is deliberately left and RECORDED. MEASURED against the reader, not
    // against a count: the text read with the witnesses beside it still renders
    // visibly garbled passages — the whole text has been read and the emendations
    // the read found are recorded as rules and applied, but the residue the read
    // and the further copies of the print together could NOT settle is large enough
    // that a reader meets it as garble, not as a marked exception. So the honest
    // state is `in-repair`, and the note says so in the reader's terms.
    //
    // THE NOTE TYPES NO COUNT. The reader learns every figure from the pages
    // themselves: build/library.mjs `counted` ("Measured on the text this page
    // serves: …") and build/pages.mjs "What it carries" DERIVE the counts from the
    // version's own corrections, and both render beside this note. This is the
    // codebase's standing rule for counts, and it is written here because a typed
    // number in a shelf note once shipped stale beside the derived one, speaking
    // the wrong figure on two pages. The note states what happened in words and
    // leaves every number to the derivation.
    published: true,
    repair: {
      state: 'in-repair',
      note:
        'this text is READABLE BUT STILL GARBLED. The transcription it is built from is a good reading of ' +
        'the 1816 print, not a faithful one, and where nothing could decide what the print actually says, ' +
        'the reading view shows the transcription’s own wrong characters, marked as damage — so a reader ' +
        'will meet passages that read as garble, and this page does not pretend otherwise. The whole text ' +
        'has been read, and the witnesses were the second transcription of the same 1816 print that stands ' +
        'beside this one on the shelf, together with the other copies of that same print held here — their ' +
        'own scans, their own page images, their own reading of the page. Every reading those could settle ' +
        'is recorded as a rule and applied by the reading view: each rule gives the words it changes, why, ' +
        'and the witness it was decided from, and where two copies of the print read the same words at the ' +
        'same line, the rule says that, because two independent readings of the same print agreeing is what ' +
        'makes the reading worth trusting; where the witness was a copy’s own page rather than this ' +
        'edition’s, the rule names that copy and the leaf of it the words stand on. What could not be ' +
        'settled is left standing and named, not hidden: the questions still open keep their reasons — a ' +
        'reading nothing places on the line it was asked about, a page line two answers came back for, a ' +
        'word the page itself will not read — and the reading view shows the transcription’s characters ' +
        'there rather than a guess. The edition is therefore not finished and not clean: what was settled ' +
        'is settled and recorded, what was not is visible, and the work of settling the rest stands open.',
    },
  },
  {
    slug: 'dionysius-divine-names-mystical-theology-parker-1897',
    group: 'ascent-argued',
    file: 'Pseudo-Dionysius-Mystical-Theology-Divine-Names-Parker-1897',
    title: 'The Divine Names, the Mystical Theology, and the Letters',
    author: 'Dionysius the Areopagite (Pseudo-Dionysius)',
    translator: 'John Parker',
    year: 1897,
    lang: 'en',
    edition:
      'The Works of Dionysius the Areopagite, Part I: The Divine Names, the Mystical Theology, and the Letters, translated by John Parker (London: James Parker and Co., 1897).',
    cat: [],
  },
  {
    slug: 'dionysius-celestial-ecclesiastical-hierarchy-parker-1899',
    group: 'ascent-argued',
    file: 'Pseudo-Dionysius-Celestial-Ecclesiastical-Hierarchy-Parker-1899',
    title: 'The Heavenly and the Ecclesiastical Hierarchy',
    author: 'Dionysius the Areopagite (Pseudo-Dionysius)',
    translator: 'John Parker',
    year: 1899,
    lang: 'en',
    edition:
      'The Works of Dionysius the Areopagite, Part II: The Heavenly and the Ecclesiastical Hierarchy, translated by John Parker (London: James Parker and Co., 1899).',
    cat: [],
  },

  /* ---------- 4. the counter-texts ---------- */
  {
    slug: 'theologia-germanica-winkworth-1854',
    group: 'counter-texts',
    file: 'Theologia-Germanica-Winkworth-1854',
    title: 'Theologia Germanica',
    author: 'anon. (the Friends of God)',
    translator: 'Susanna Winkworth',
    year: 1854,
    lang: 'en',
    edition:
      'Theologia Germanica, translated by Susanna Winkworth from the edition of Franz Pfeiffer (London: Longman, Brown, Green and Longmans, 1854).',
    cat: ['theologia-germanica'],
  },
  {
    slug: 'lucretius-of-the-nature-of-things-leonard-1916',
    group: 'counter-texts',
    file: 'Lucretius-Of-the-Nature-of-Things-Leonard-1916',
    title: 'Of the Nature of Things',
    author: 'Lucretius',
    translator: 'William Ellery Leonard',
    year: 1916,
    lang: 'en',
    edition:
      'T. Lucretius Carus: Of the Nature of Things, a metrical translation by William Ellery Leonard (London, Paris and Toronto: J. M. Dent & Sons, 1916).',
    cat: [],
  },
  {
    slug: 'marcus-aurelius-meditations-long-1890',
    group: 'counter-texts',
    file: 'Marcus-Aurelius-Meditations-Long-1890',
    title: 'The Meditations',
    author: 'Marcus Aurelius Antoninus',
    translator: 'George Long',
    year: 1890,
    lang: 'en',
    edition:
      'The Meditations of the Emperor Marcus Aurelius Antoninus, translated by George Long (The Chesterfield Society, London and New York, 1890).',
    cat: [],
  },
  {
    slug: 'plutarch-morals-goodwin-vol-2-1874',
    group: 'counter-texts',
    file: 'Plutarch-Moralia-Goodwin-Vol-2-1874',
    title: 'Morals, vol. II',
    author: 'Plutarch',
    translator: 'Several hands, revised by William W. Goodwin',
    year: 1874,
    lang: 'en',
    edition:
      'Plutarch’s Morals, translated from the Greek by several hands, corrected and revised by William W. Goodwin, vol. II (Boston: Little, Brown, and Company, 1874). Includes How to Know a Flatterer from a Friend.',
    cat: ['moralia'],
  },
  {
    slug: 'tacitus-agricola-and-germany-church-brodribb-1885',
    group: 'counter-texts',
    file: 'Tacitus-Agricola-Germany-Church-Brodribb-1885',
    title: 'The Agricola and Germany',
    author: 'Tacitus',
    translator: 'Alfred John Church and William Jackson Brodribb',
    year: 1885,
    lang: 'en',
    edition:
      'The Agricola and Germany of Tacitus, translated by Alfred John Church and William Jackson Brodribb (London: Macmillan, 1885).',
    cat: ['agricola'],
  },

  /* ---------- 5. the sources of the philosophy ---------- */
  {
    slug: 'plato-cratylus-phaedo-parmenides-timaeus-taylor-1793',
    group: 'philosophy-sources',
    file: 'Plato-Cratylus-Phaedo-Parmenides-Timaeus-Taylor-1793',
    title: 'The Cratylus, Phaedo, Parmenides and Timaeus',
    author: 'Plato',
    translator: 'Thomas Taylor',
    year: 1793,
    lang: 'en',
    edition:
      'The Cratylus, Phaedo, Parmenides and Timaeus of Plato, translated from the Greek by Thomas Taylor (London: Benjamin and John White, 1793).',
    cat: ['cratylus', 'phaedo', 'timaeus'],
  },
  {
    slug: 'plato-works-taylor-vol-1-1804',
    group: 'philosophy-sources',
    file: 'Plato-Works-Taylor-Vol-1-1804',
    title: 'The Works of Plato, vol. I',
    author: 'Plato',
    translator: 'Thomas Taylor (with Floyer Sydenham)',
    year: 1804,
    lang: 'en',
    edition:
      'The Works of Plato, viz. his fifty-five dialogues and twelve epistles, translated by Thomas Taylor, vol. I (London: printed for Thomas Taylor, 1804). The volume’s own contents page gives the Republic, the First Alcibiades and the general introduction.',
    cat: [],
  },
  {
    slug: 'plato-works-taylor-vol-2-1804',
    group: 'philosophy-sources',
    file: 'Plato-Works-Taylor-Vol-2-1804',
    title: 'The Works of Plato, vol. II',
    author: 'Plato',
    translator: 'Thomas Taylor (with Floyer Sydenham)',
    year: 1804,
    lang: 'en',
    edition:
      'The Works of Plato, translated by Thomas Taylor, vol. II (London: printed for Thomas Taylor, 1804). The volume’s own contents page gives the Laws, the Epinomis, the Timaeus and the Critias.',
    cat: ['timaeus'],
  },
  {
    slug: 'porphyry-on-the-cave-of-the-nymphs-taylor-1917',
    group: 'philosophy-sources',
    // PUBLISHED (plan §11 phase 5): the first text to run the whole way — a stored
    // edition, a leaf-accurate page model reconciled against the archive's own
    // leaves, pinned anchors, and a repair rule set in which every rule fires and
    // every reading was verified against a witness (the transcription's own
    // context, or the 1823 parallel of the same translation). Two damaged runs
    // remain and are left visible rather than guessed: they are the page furniture
    // of a page break, not words.
    //
    // Every other entry stays held back: an unreadable transcription published is
    // worse than an absent page, and they have none of the above. Their state is
    // unchanged by this flag.
    published: true,
    // THE REPAIR STATE. A text can be READABLE and not FINISHED: this edition runs
    // end to end, its repairs all fire, and damage remains that neither the
    // transcription's own context nor the 1823 parallel could settle — it is being
    // cleared against the printed PAGE, site by site. `in-repair` says so on the
    // index and in the reader, so a reader is not told an edition is finished when
    // it is not. States: `in-repair` (readable, unfinished) and `repaired`
    // (finished, every residue settled or deliberately left). Absent means no
    // repair has been attempted — the text is not served as an edition of its own.
    repair: {
      state: 'repaired',
      // a sentence, not a label: WHICH witnesses settled it, and what is left, said
      // in the reader's terms. "Repaired" rests on the worklist being closed — every
      // damaged place a witness could settle is settled — not on a second whole-text
      // read having confirmed there is nothing left to find, which is why the note
      // names the witnesses and the residue rather than saying "finished".
      note:
        'every damaged place a witness could settle has been settled — against the transcription\u2019s own ' +
        'context, the 1823 parallel of the same translation, or the printed page itself, read one page at a ' +
        'time. What remains is not the book\u2019s text: the page furniture at one page break (a recorded ' +
        'decision to leave it visible) and this copy\u2019s own marks. A second whole-text read has not been run, ' +
        'so the claim is that the found damage is settled, not that nothing further is findable.',
    },
    file: 'Porphyry-On-the-Cave-of-the-Nymphs-Taylor-1917',
    // the archive.org identifier this transcription came from. The build serves
    // the EDITION in the repo (data/editions/<slug>/), never the archive; this
    // names where the edition's transcription came from, for provenance.
    item: 'onthecaveoftheny00porpuoft',
    title: 'On the Cave of the Nymphs',
    author: 'Porphyry',
    translator: 'Thomas Taylor',
    year: 1917,
    lang: 'en',
    edition:
      'Porphyry: On the Cave of the Nymphs in the Odyssey, translated by Thomas Taylor (London: John M. Watkins, 1917).',
    cat: [],
  },
  {
    slug: 'porphyry-select-works-taylor-1823',
    group: 'philosophy-sources',
    file: 'Porphyry-Taylor-Select-Works-1823',
    title: 'Select Works',
    author: 'Porphyry',
    translator: 'Thomas Taylor',
    year: 1823,
    lang: 'en',
    edition:
      'Select Works of Porphyry: his Four Books on Abstinence from Animal Food, his Treatise on the Homeric Cave of the Nymphs, and his Auxiliaries to the Perception of Intelligible Natures, translated by Thomas Taylor (London: Thomas Rodd, 1823).',
    cat: [],
  },
  {
    slug: 'proclus-in-parmenidem-cousin-vol-4-1821',
    group: 'philosophy-sources',
    file: 'Proclus-In-Parmenidem-Cousin-Vol-4-1821',
    title: 'Commentary on the Parmenides, vol. IV',
    author: 'Proclus',
    translator: '',
    year: 1821,
    lang: 'grc',
    edition:
      'Procli philosophi Platonici opera, edited by Victor Cousin, tome IV (Paris, 1821). The text is Proclus’ commentary on the Parmenides in Greek, with Cousin’s Latin; there is no public-domain English translation (Morrow’s is 1987).',
    cat: ['in-parmenidem'],
  },
  {
    slug: 'proclus-in-parmenidem-cousin-vol-5-1823',
    group: 'philosophy-sources',
    file: 'Proclus-In-Parmenidem-Cousin-Vol-5-1823',
    title: 'Commentary on the Parmenides, vol. V',
    author: 'Proclus',
    translator: '',
    year: 1823,
    lang: 'grc',
    edition:
      'Procli philosophi Platonici opera, edited by Victor Cousin, tome V (Paris, 1823). Greek, with Latin; no public-domain English translation exists.',
    cat: ['in-parmenidem'],
  },
  {
    slug: 'proclus-in-parmenidem-cousin-vol-6-1827',
    group: 'philosophy-sources',
    file: 'Proclus-In-Parmenidem-Cousin-Vol-6-1827',
    title: 'Commentary on the Parmenides, vol. VI',
    author: 'Proclus',
    translator: '',
    year: 1827,
    lang: 'grc',
    edition:
      'Procli philosophi Platonici opera, edited by Victor Cousin, tome VI (Paris, 1827). Greek, with Latin; no public-domain English translation exists.',
    cat: ['in-parmenidem'],
  },

  /* ---------- 6. the other ascents ---------- */
  {
    slug: 'evagrius-ponticus-migne-pg-40-1858',
    group: 'other-ascents',
    file: 'Evagrius-Ponticus-Patres-Aegyptii-Patrologia-Graeca-40-Migne-1858',
    title: 'The works (in the Patrologia Graeca, vol. 40)',
    author: 'Evagrius Ponticus and the Egyptian Fathers',
    translator: '',
    year: 1858,
    lang: 'grc',
    edition:
      'Patrologiae Graecae tomus XL: Patres Aegyptii saeculi IV, edited by J.-P. Migne (Paris, 1858). Greek, with Migne’s Latin. There is no public-domain English translation (the Praktikos is Cistercian, 1970).',
    cat: [],
  },
  {
    slug: 'symeon-the-new-theologian-migne-pg-120-1864',
    group: 'other-ascents',
    file: 'Symeon-the-New-Theologian-and-Xiphilinus-Patrologia-Graeca-120-Migne',
    title: 'The works (in the Patrologia Graeca, vol. 120)',
    author: 'Symeon the New Theologian and John Xiphilinus',
    translator: '',
    year: 1864,
    lang: 'grc',
    edition:
      'Patrologiae Graecae tomus CXX: Joannes Xiphilinus, Symeon Junior, edited by J.-P. Migne (Paris, 1864). Greek, with Latin. There is no public-domain English translation.',
    cat: [],
  },
  {
    slug: 'hildegard-of-bingen-analecta-1882',
    group: 'other-ascents',
    file: 'Hildegard-Analecta-Sanctae-Hildegardis-Latin-1882',
    title: 'Analecta Sanctae Hildegardis',
    author: 'Hildegard of Bingen',
    translator: '',
    year: 1882,
    lang: 'la',
    edition:
      'Analecta Sanctae Hildegardis opera spicilegio Solesmensi parata, edited by J. B. Pitra (Typis Sacri Montis Casinensis, 1882). Latin; there is no public-domain English translation (Scivias, Hart, 1954, is in copyright).',
    cat: [],
  },
  {
    slug: 'granum-sinapis-bech-1883',
    group: 'other-ascents',
    file: 'Granum-Sinapis-Bech-1883',
    title: 'Granum Sinapis',
    author: 'anon. (the Friends of God)',
    translator: '',
    year: 1883,
    lang: 'de',
    edition:
      'Granum Sinapis: Deutsches Gedicht und lateinischer Commentar, edited by Fedor Bech (1883). The poem is Middle High German with a Latin prose commentary — the poem is not Latin, whatever the title suggests.',
    cat: [],
  },
  {
    slug: 'ficino-de-vita-libri-tres-1560',
    group: 'other-ascents',
    file: 'Ficino-De-vita-libri-tres-Latin-1560',
    title: 'De vita libri tres',
    author: 'Marsilio Ficino',
    translator: '',
    year: 1560,
    lang: 'la',
    edition:
      'Marsilio Ficino, De vita libri tres (Venice: apud Gulielmum Rouillium, 1560). Latin; the standard English is Kaske and Clark, 1989, and there is no public-domain English translation.',
    cat: ['de-vita-libri-tres'],
  },
  {
    slug: 'paracelsus-sieben-defensiones-sudhoff-1915',
    group: 'other-ascents',
    file: 'Paracelsus-Sieben-Defensiones-German-Sudhoff-1915',
    title: 'Sieben Defensiones',
    author: 'Paracelsus',
    translator: '',
    year: 1915,
    lang: 'de',
    edition:
      'Sieben Defensiones und Labyrinthus medicorum errantium (1538), edited by Karl Sudhoff (Leipzig: J. A. Barth, 1915). German — Paracelsus wrote in German — and there is no public-domain English translation (Waite’s 1894 collection does not include it).',
    cat: ['septem-defensiones'],
  },
  {
    slug: 'trithemius-steganographia-1608',
    group: 'other-ascents',
    file: 'Trithemius-Steganographia-Latin-1608',
    title: 'Steganographia',
    author: 'Johannes Trithemius',
    translator: '',
    year: 1608,
    lang: 'la',
    edition:
      'Johannes Trithemius, Steganographia (1608). Latin, in the printed gathering of the three books. Books I and II are ciphers; the third is the angelic one.',
    cat: ['steganographia'],
  },
  {
    slug: 'mahaparinibbana-sutta-dn-16-rhys-davids-1910',
    group: 'other-ascents',
    file: 'DN-16-Dialogues-of-the-Buddha-Vol-2-RhysDavids-1910',
    title: 'The Mahāparinibbāna Sutta (Dīgha Nikāya 16)',
    author: 'The Pali canon',
    translator: 'T. W. Rhys Davids and C. A. F. Rhys Davids',
    year: 1910,
    lang: 'en',
    edition:
      'Dialogues of the Buddha, translated from the Pali by T. W. and C. A. F. Rhys Davids, Part II (London: Oxford University Press, 1910). Contains the Mahāparinibbāna Suttanta.',
    cat: ['mahaparinibbana-sutta'],
  },
  {
    slug: 'ganakamoggallana-sutta-mn-107-chalmers-1927',
    group: 'other-ascents',
    file: 'MN-107-Further-Dialogues-of-the-Buddha-Vol-2-Chalmers-1927',
    title: 'The Gaṇakamoggallāna Sutta (Majjhima Nikāya 107)',
    author: 'The Pali canon',
    translator: 'Lord Chalmers',
    year: 1927,
    lang: 'en',
    edition:
      'Further Dialogues of the Buddha, translated from the Pali by Lord Chalmers, vol. II (Oxford University Press, 1927).',
    cat: ['ganakamoggallana-sutta'],
  },
  {
    slug: 'kalama-sutta-an-3-65-pali-morris-1885',
    group: 'other-ascents',
    file: 'AN-Anguttara-Nikaya-Part-1-Pali-Morris-1885',
    title: 'The Aṅguttara-Nikāya, part I (the Kālāma Sutta, AN 3.65)',
    author: 'The Pali canon',
    translator: '',
    year: 1885,
    lang: 'pi',
    edition:
      'The Aṅguttara-Nikāya, part I, edited by Richard Morris for the Pali Text Society (London: Henry Frowde, 1885). Pali text only: the only English rendering of this sutta is Woodward’s, 1932, still in copyright, so the free layer is the original.',
    cat: ['kalamma-sutta'],
  },
  {
    slug: 'upaddha-sutta-sn-45-2-pali-feer-1898',
    group: 'other-ascents',
    file: 'SN-Samyutta-Nikaya-Part-5-Pali-Feer-1898',
    title: 'The Saṃyutta-Nikāya, part V (the Upaḍḍha Sutta, SN 45.2)',
    author: 'The Pali canon',
    translator: '',
    year: 1898,
    lang: 'pi',
    edition:
      'The Saṃyutta-Nikāya, part V (Mahā-vagga), edited by M. Léon Feer for the Pali Text Society (London: Henry Frowde, 1898). Pali text only.',
    cat: ['upaddha-sutta'],
  },
];

/** The shelf directory for one text, resolved against the actual listing. */
export function textSource(t, files) {
  return join(SHELF, shelfFile(t.file, files));
}

/** Is this text published? Absent means NO: an entry that does not say so is not
 * served, which is the safe direction for a flag whose whole job is to keep a
 * text off the site until someone has decided otherwise. */
export const isPublished = (t) => t.published === true;

/** THE REPAIR STATES, and the label each one reads as. A repair state is a fact
 * about an EDITION, not about the shelf: whether the text on the page is damaged
 * and unrepaired, being cleared, or finished.
 *
 *   damaged    readable, damaged, and NO repair attempted yet — the starting state
 *   in-repair  readable, and being cleared against the printed page
 *   repaired   finished: every residue settled, or deliberately left and recorded
 *
 * THE DEFAULT IS `damaged`, and it is a statement about the shelf, not a shrug:
 * every transcription here carries the scanner's damage — that is what a
 * transcription of a printed book is — so an edition that has not been worked on
 * IS damaged. `in-repair` and `repaired` are states a text EARNS by being worked
 * on, which is why they are declared explicitly and `damaged` need not be. */
export const REPAIR_LABELS = { damaged: 'damaged', 'in-repair': 'in repair', repaired: 'repaired' };
export const DEFAULT_REPAIR = {
  state: 'damaged',
  note:
    'not yet repaired: the transcription carries the scanner’s damage and no repair has been attempted, so the ' +
    'reading view shows the transcription’s own characters throughout.',
};
export const repairOf = (t) => (t.repair && t.repair.state ? t.repair : DEFAULT_REPAIR);
export const repairState = (t) => repairOf(t).state;
export const isInRepair = (t) => repairState(t) === 'in-repair';

/** The texts a default build serves — the shelf's own answer to "what is
 * published", so the build and every test read one list instead of two. */
export const publishedTexts = () => TEXTS.filter(isPublished);

export const byGroup = (key) => TEXTS.filter((t) => t.group === key);
