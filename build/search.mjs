/**
 * build/search.mjs — the /search/ route: the SHELF's half of the blog's search,
 * lifted and reduced to the library's own corpus (extraction plan §3, the /search
 * row).
 *
 * WHAT CAME OVER from the blog's tools/build.mjs: `SEARCH_WORD`, `searchTerms`,
 * `dafsaOf` (+ `DAFSA_ENC`/`dafsaVarint`) — the automaton the word list is held
 * in — and `shelfIndex`'s passage grouping (`shelfPassages`), which reads the
 * READING VIEW of a served document (the recorded repairs applied) and cuts it
 * into the passages a reader sees: a paragraph, or a note, each carrying the
 * document's own anchor.
 *
 * WHAT DID NOT: the blog-pieces half — the post index, the tf-idf vector space,
 * the datalog graph over the posts' citations, the fetched deep/position half,
 * the series/kind facets. The library searches its OWN corpus (the passages of
 * the served editions) and nothing else; there is no second group.
 *
 * The client (tools/search/shelf.js) is the blog search client's SHELF PROVIDER
 * and the machinery it stands on — the same word lookup, `~fuzzy` walk,
 * `/pattern/` NFA and quoted-phrase adjacency — with the pieces' providers cut
 * away and its result hrefs pointing at `/texts/<slug>/` (the blog's `/library/`
 * constant, changed).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyCorrections } from '../tools/reader.mjs';
import { SITE, ROOT } from './shell.mjs';
import { stripJsComments } from './leak.mjs';

/** Words a search ignores. ONE list, shipped in the page's own data, so a query
 * is tokenised by the rule the index was built with (the blog's own list, kept). */
const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have he her him his how ' +
    'if in into is it its just like may might more most no not of on one only or other our out over own ' +
    'said same she should so some such than that the their them then there these they this those to too ' +
    'two under up very was we were what when where which while who why will with without would you your'
  ).split(' '),
);

const SEARCH_WORD = /[a-z][a-z'-]+/g;

/** The index's token rule: lowercased, three or more characters, stopwords
 * dropped, duplicates kept (the blog's own rule). */
function searchTerms(text) {
  const out = [];
  for (const w of String(text).toLowerCase().match(SEARCH_WORD) || []) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.push(w);
  }
  return out;
}

/* ---------- the automaton the words are held in (the blog's, verbatim) ---------- */

const DAFSA_ENC = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_~';

function dafsaVarint(v) {
  let s = '';
  while (v >= 32) {
    s += DAFSA_ENC[(v & 31) | 32];
    v = Math.floor(v / 32);
  }
  return s + DAFSA_ENC[v];
}

/** The vocabulary as a minimal acyclic finite-state automaton (Daciuk et al.),
 * serialised as the three streams the client decodes. Kept byte-for-byte in
 * agreement with the blog's builder: the client's decoder is the same code. */
function dafsaOf(vocab) {
  const root = { kids: new Map(), fin: false };
  for (const term of vocab) {
    let node = root;
    for (const ch of term) {
      let kid = node.kids.get(ch);
      if (!kid) {
        kid = { kids: new Map(), fin: false };
        node.kids.set(ch, kid);
      }
      node = kid;
    }
    node.fin = true;
  }
  const register = new Map();
  const states = [];
  const canon = (node) => {
    const next = [];
    for (const ch of [...node.kids.keys()].sort()) next.push([ch, canon(node.kids.get(ch))]);
    const key = (node.fin ? '1' : '0') + '|' + next.map(([ch, id]) => ch + id).join(',');
    let id = register.get(key);
    if (id === undefined) {
      id = states.length;
      states.push({ fin: node.fin, next });
      register.set(key, id);
    }
    return id;
  };
  const rootId = canon(root);
  let s = '';
  let l = '';
  let t = '';
  for (let i = 0; i < states.length; i++) {
    const st = states[i];
    if (st.next.length > 30) throw new Error(`dafsa: a state has ${st.next.length} transitions`);
    s += DAFSA_ENC[st.next.length + (st.fin ? 32 : 0)];
    for (const [ch, to] of st.next) {
      l += ch;
      t += dafsaVarint(i - to);
    }
  }
  return {
    dafsa: { s, l, t },
    stats: { states: states.length, edges: l.length, root: rootId, bytes: s.length + l.length + t.length },
  };
}

/* ---------- the passages ---------- */

/** One stored edition's reading view, as passages, in document order (the
 * blog's `shelfPassages`, lifted). The text is the reading view's: the grouped
 * run with the recorded corrections applied, which is what the reader reads. */
function shelfPassages(doc) {
  const out = [];
  let region = '';
  let sec = null;
  let secId = null;
  let page = null;
  let opening = false;
  let open = null;
  const close = () => {
    if (open) out.push(open);
    open = null;
  };
  for (const b of doc.blocks) {
    switch (b.t) {
      case 'region':
        close();
        region = b.kind;
        break;
      case 'sec':
        close();
        secId = b.id;
        sec = b.n;
        opening = true;
        break;
      case 'pb':
        if (b.page != null) page = b.page;
        break;
      case 'rh':
        break;
      case 'p':
      case 'verse': {
        const x = b.t === 'verse' ? b.x.replace(/\n/g, ' ') : b.x;
        if (open && open.k === 'p' && b.at != null && b.at === open.at) {
          open.parts.push(x);
        } else {
          close();
          open = { k: 'p', parts: [x], at: b.at || null, page, region, sec, secId, strong: opening };
          opening = false;
        }
        break;
      }
      case 'ref': {
        if (open && open.k === 'p') {
          open.parts.push(b.x);
          if (!open.at && b.at) open.at = b.at;
        } else {
          close();
          open = { k: 'p', parts: [b.x], at: b.at || null, page, region, sec, secId, strong: opening };
          opening = false;
        }
        break;
      }
      case 'notedef': {
        if (open && open.k === 'n' && open.n === b.n) open.parts.push(b.x);
        else {
          close();
          open = { k: 'n', n: b.n, id: b.id || null, parts: [b.x], page, region, sec: null, secId: null, strong: false };
        }
        break;
      }
      default:
        break;
    }
  }
  close();
  const passages = [];
  for (const o of out) {
    if (o.region !== 'body' && o.region !== 'notes') continue;
    const text = applyCorrections(o.parts.join(o.k === 'p' ? '' : ' '), doc.corrections);
    if (!text) continue;
    const anchor =
      o.k === 'n'
        ? o.id || 'n' + o.n
        : o.at || o.secId || (o.page != null ? `p${o.page}` : o.region === 'notes' ? 'snotes' : 'sfront');
    passages.push({ anchor, page: o.page, strong: !!o.strong, sec: o.sec, text });
  }
  return passages;
}

/** The shelf index over the editions this build serves: the passages and their
 * own word list. A passage is `[doc, anchor, page, opens-the-section, section
 * number, text]` — the shape the client's shelf provider decodes. */
export function buildShelfIndex(served, docs) {
  const out = { docs: [], pass: [] };
  let skipped = 0;
  for (const t of served) {
    const doc = docs.get(t.slug);
    if (!doc) {
      skipped++;
      continue;
    }
    const list = shelfPassages(doc);
    if (!list.length) {
      skipped++;
      continue;
    }
    const i = out.docs.length;
    out.docs.push({
      slug: t.slug,
      title: t.title,
      author: t.author,
      translator: t.translator || '',
      sec: doc.toc.map((s) => [s.n, s.title]),
    });
    for (const p of list) out.pass.push([i, p.anchor, p.page, p.strong ? 1 : 0, p.sec, p.text]);
  }
  const byTerm = new Map();
  const seen = new Set();
  for (let i = 0; i < out.pass.length; i++) {
    seen.clear();
    for (const w of searchTerms(out.pass[i][5])) {
      if (seen.has(w)) continue;
      seen.add(w);
      let row = byTerm.get(w);
      if (!row) byTerm.set(w, (row = []));
      row.push(i);
    }
  }
  const terms = [...byTerm.keys()].sort();
  const { dafsa, stats } = dafsaOf(terms);
  return {
    index: { stop: [...STOPWORDS].join(' '), docs: out.docs, pass: out.pass, words: { dafsa, postings: terms.map((t) => byTerm.get(t)) } },
    totals: {
      docs: out.docs.length,
      passages: out.pass.length,
      words: terms.length,
      dafsaStates: stats.states,
      dafsaBytes: stats.bytes,
      skipped,
    },
  };
}

/** `/search/` — a real page. The client is inlined comment-free; the INDEX is a
 * separate data file (site/dist/search/index) the client fetches once, because it
 * carries the books' own prose and a page must not hold a book's text where the
 * gate reads the site's own vocabulary. The search itself runs in the browser and
 * nothing is requested except that one same-origin index file. The prose is the
 * SHELF's paragraph, written for a site that has one corpus and no pieces. */
export function buildSearchPage(totals) {
  // The client comment-free, the same way every other inlined script is emitted.
  // The page carries only the POINTER to the index — the index itself is a data
  // file (the books' own prose, gated as data), fetched by the client.
  const clientSrc = stripJsComments(readFileSync(join(ROOT, 'tools', 'search', 'shelf.js'), 'utf8'));
  const prose =
    `<p>This page searches the <b>passages</b> of the ${totals.docs} published ` +
    `${totals.docs === 1 ? 'edition' : 'editions'} — ${totals.passages} passages in all, each one a paragraph or ` +
    `a note of the reading view, cited by section and printed page and linked into the book it stands in. ` +
    `The words are the texts' own, three characters and longer, each with the passages it occurs in; a hit in ` +
    `an edition's title or a section's heading weighs more than a hit in a passage's body, and the commonest ` +
    `words are left out because they name none.</p>` +
    `<p>The box takes a <b>pattern</b> too: put one between slashes and it is matched against the words ` +
    `themselves rather than looked up — <code>/hyparxis/</code>, <code>/^procl/</code>, ` +
    `<code>/(the|gno)urg/</code>. With nothing anchoring it, a pattern matches <b>anywhere inside</b> a word. ` +
    `The syntax is <code>.</code> for any character, <code>*</code> <code>+</code> and <code>?</code> for ` +
    `repetition, <code>[abc]</code> and <code>[a-z]</code> for a set, <code>|</code> to alternate, ` +
    `<code>()</code> to group, and <code>^</code> and <code>$</code> for the start and the end of a word.</p>` +
    `<p>Put a <code>~</code> in front of a word and it is matched <b>approximately</b>: <code>~proculs</code> ` +
    `finds <code>proclus</code>, one edit away. Two tildes allow two edits. Words between <b>quotes</b> are a ` +
    `phrase: <code>"cave of the nymphs"</code> matches only passages where those words stand next to each ` +
    `other, in that order. A result is a <b>citation</b> — the edition, the division or the printed page, and ` +
    `the passage's own words — and it links to that passage in the book.</p>` +
    `<p>Nothing is sent anywhere: the index is in this page and the search runs in your browser. The passages ` +
    `searched are the library's own transcriptions of public-domain books; the essays that read them are on ` +
    `the blog, linked from each edition's page.</p>`;

  const body =
    `<section><div class="wrap">` +
    `<div class="hint">${totals.docs} text${totals.docs === 1 ? '' : 's'} · ${totals.passages} passages · ` +
    `${totals.words} words in the list · a word, a phrase, /a pattern/, ~a typo</div>` +
    `<form class="sform" id="sf" role="search">` +
    `<div class="sq-wrap">` +
    `<div class="srow">` +
    `<input type="search" id="sq" name="q" role="combobox" aria-expanded="false" ` +
    `aria-controls="scomp-list" aria-autocomplete="list" ` +
    `aria-label="search the texts" autocomplete="off" ` +
    `autocapitalize="off" spellcheck="false" placeholder="a word, a name, a phrase, /a pattern/, ~a typo">` +
    `</div>` +
    `<div class="scomp" id="scomp" hidden>` +
    `<ul class="scomp-list" id="scomp-list" role="listbox" aria-label="words that begin with it"></ul>` +
    `<div class="scomp-cap" id="scomp-cap" hidden></div>` +
    `</div>` +
    `</div>` +
    `</form>` +
    `<div class="sstatus" id="sstatus" role="status" aria-live="polite"></div>` +
    `<ol class="sres" id="sres"><li class="sr-none">Type a word — the texts are searched by their words, ` +
    `their passages and their printed pages.</li></ol>` +
    `<noscript><p class="s-noscript">JavaScript is off, so the search does not run: the whole index and the ` +
    `pipeline that reads it are in this page, and without a script they are only text. The texts are ` +
    `reachable from <a href="/texts/">the shelf</a>.</p></noscript>` +
    `<div class="prose">${prose}</div>` +
    `<script type="application/json" id="search-data">${JSON.stringify({ index: '/search/index' })}</script>` +
    `<script>\n${clientSrc}\n</script>` +
    `</div></section>`;

  return {
    title: `Search — ${SITE.host}`,
    shareTitle: 'Search',
    type: 'website',
    description:
      `Search the passages of the ${totals.docs} published editions of ${SITE.name} — a word index over the ` +
      `texts' own passages, with patterns, fuzzy words and phrases, and a citation for every result.`,
    eyebrow: 'The texts',
    heading: 'Search',
    standfirst: 'The published texts, passage by passage — a word, a phrase, /a pattern/, ~a typo.',
    body,
    navCurrent: '/search/',
  };
}
