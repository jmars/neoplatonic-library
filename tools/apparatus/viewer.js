/**
 * tools/apparatus/viewer.js — the apparatus: the readings, and the leaves.
 *
 * WHAT IT REPLACES. The edition page used to inline the version's whole repair
 * log as one flat list — 415 rules on proclus, 324,245 bytes of a 982,701-byte
 * page — in which the PAGE IMAGE a reading was decided from was a small
 * thumbnail buried among the 310 rules that carry no image at all. The unit of
 * provenance here is the page image, so the apparatus is fetched
 * (`/texts/<slug>/apparatus.json`, DATA-MODEL §7) and browsed the way a page is
 * turned: pick a leaf, see the readings decided from it. THE VIEWER IS INLINED
 * ON THE APPARATUS'S OWN PAGE — `/texts/<slug>/apparatus/`, and the pinned
 * `/texts/<slug>/v/<semver>/apparatus/` — not on the edition page, so it is not
 * buried under the whole reading view: the edition page carries the short
 * statement and the door to here.
 *
 * MEASURED, and why it is not leaf-only: MOST readings have no page image —
 * porphyry has 384 rules and 72 stored leaves, and only 4 of the readings were
 * read off one; its first stored leaf (n0) carries none. A viewer that opened on
 * the first leaf opened on an empty panel, and the 380 readings with no image
 * were reachable only through a small entry at the end of the leaf strip.
 *
 * WHAT IT RENDERS, from the data and nothing else — TWO AXES over one record:
 *   - THE READINGS. An `All readings` entry (the whole log) and a `Without a
 *     page image` entry (the readings that rest on no leaf), each listed
 *     compactly and PAGED 25 at a time with the range and the total stated, so
 *     no view is ever a wall;
 *   - THE LEAVES. THE WHOLE SCAN: one entry per stored leaf — a small thumbnail,
 *     its number, and how many readings were decided from it; a leaf a reading
 *     WAS decided from carries a small rubric mark (it is "evidence"), and a
 *     leaf no reading was taken from says so plainly — but they sit in ONE index
 *     in leaf order, never separated, because the scan is the edition's and a
 *     reading is only one thing that can be said about a leaf. Then an entry for
 *     each leaf a reading CITES BUT THE EDITION DOES NOT HOLD (stated, never
 *     dropped);
 *   - a PANEL for the selected entry: for a leaf, the page at a readable size,
 *     its caption (`archive leaf nNNN · printed page M`), and beneath it every
 *     reading decided from that leaf — id, type, pipeline class, before → after,
 *     rationale, witness — each anchored at `#repair-<id>`. A leaf NO reading
 *     was decided from still shows its page — the point of the whole scan being
 *     stored is that the leaf is readable whether or not a repair used it — and
 *     says so in words rather than showing an empty panel;
 *   - PAGING THROUGH THE SCAN: the leaf before and the leaf after, in leaf
 *     order, under the leaf itself (`Previous leaf · nNNN` / `Next leaf · nNNN`),
 *     so the scan is read as a sequence and not only leaf by leaf;
 *   - CONTROLS over BOTH axes: a filter by the four scholarly types (DATA-MODEL
 *     §4.1) and a word search over the located text (`find`), the reading
 *     (`after`) and the reason (`rationale`), and a DIRECT JUMP to a leaf by its
 *     number (the rail is 141 thumbnails on proclus, so scrolling it to a leaf a
 *     reader has in mind is work — and a number the edition does not hold is
 *     SAID, never swallowed);
 *   - DEEP LINKS: a `#repair-<id>` fragment on load selects the entry that rule
 *     belongs to — its leaf, or the cited-but-not-held leaf, or the no-image
 *     group — turns to the page of a paged list it falls on, and highlights it.
 *     A leaf entry is linkable too (`#leaf-nNNN`).
 *
 * THE LANDING: the viewer opens the first leaf that HAS readings; if no leaf
 * carries one it opens the no-image group instead. A reader who arrives on a
 * leaf with no reading now sees the page image and a plain statement, but the
 * first leaf that carries provenance is still the better door in — it is the
 * leaf the apparatus is ABOUT.
 *
 * NO-JS AND FAILURE. The page server-renders a plain statement of what the
 * apparatus is, the address of the data file, and a `<noscript>`; this script
 * only takes that statement away once it has rendered the viewer. If the fetch
 * fails the statement STAYS and the status line says what failed — the viewer
 * never silently shows nothing.
 *
 * The build inlines this file into the page comment-free (build/library.mjs), so
 * a comment here does not reach the reader, but a workshop token inside a STRING
 * would.
 */
(function () {
  'use strict';

  var TYPES = ['OCR', 'punctuation', 'transliteration', 'conjectural'];

  /** How many readings a paged list shows at a time. Every list longer than
   * this is paged with its range and total stated; a leaf's readings are short
   * and are simply not paged. */
  var PAGE = 25;

  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /** THE NAME A LEAF IS STORED UNDER, and the KEY built from it.
   *
   * A LEAF'S NUMBER IS NOT UNIQUE IN EVERY EDITION. MEASURED: Taylor's 1816
   * Theology of Plato is printed over two volumes and cut from two archive items
   * whose leaf numbers run over each other — BOTH serve an n74 — so the edition
   * stores them as v1-n74.jpg and v2-n74.jpg, and a key built from the number
   * ('n74') collides: two index cards with one id, and clicking the second showed
   * the first one's page image. The stored name (which the served url carries) is
   * the identity the edition itself uses, so the KEY is the name without its
   * extension, and it is the number only for an edition whose leaves have no
   * volume prefix (where the number IS the name). */
  function leafName(url, n) {
    if (!url) return 'n' + n;
    var base = String(url).split('/').pop().replace(/\.jpg$/i, '');
    return /^(?:v\d+-)?n\d+$/.test(base) ? base : 'n' + n;
  }

  /** The filmstrip/panel key of the entry a rule belongs to. The first HELD leaf
   * it was decided from wins; failing that the first leaf it cites (which is not
   * held); failing that it is a reading with no page image. */
  function keyOfRule(r) {
    var evs = r.evidence || [];
    for (var i = 0; i < evs.length; i += 1) if (evs[i].exists) return leafName(evs[i].url, evs[i].leaf);
    if (evs.length) return 'u' + evs[0].leaf;
    return 'none';
  }

  /** How a rule was decided, in plain words (model §0.4: an empty state is
   * stated, never omitted). The leaf is named by its STORED name, so a leaf of a
   * two-volume edition is not confused with the other volume's leaf of the same
   * number. */
  function evidenceNote(r) {
    var evs = r.evidence || [];
    if (!evs.length) return 'no page image is held for this reading';
    return (
      'read from ' +
      evs
        .map(function (e) {
          return (
            'archive leaf ' +
            leafName(e.url, e.leaf) +
            (e.page !== null && e.page !== undefined ? ' · printed page ' + e.page : '') +
            (e.exists ? '' : ' (not held with this edition)')
          );
        })
        .join('; ')
    );
  }

  function caption(entry) {
    if (entry.kind === 'none') return 'decided without a page image';
    if (entry.kind === 'all') return 'every reading in this version';
    return (
      'archive leaf ' +
      entry.label +
      (entry.page !== null && entry.page !== undefined ? ' · printed page ' + entry.page : '')
    );
  }

  /** The entry's class, from its kind alone, so the button a reader sees is the
   * button the counts describe. */
  function classOf(e) {
    return 'app-leaf' + (e.kind === 'leaf' ? '' : ' app-leaf-' + e.kind);
  }

  function Viewer(root, data) {
    this.root = root;
    this.data = data;
    this.leaves = document.getElementById('app-leaves');
    this.panel = document.getElementById('app-panel');
    this.controls = document.getElementById('app-controls');
    this.status = document.getElementById('app-status');
    this.fallback = document.getElementById('app-fallback');
    this.q = '';
    this.page = 0;
    this.on = {};
    for (var i = 0; i < TYPES.length; i += 1) this.on[TYPES[i]] = true;

    /* THE ENTRIES, in the order they are browsed. THE READINGS FIRST — the whole
     * log, and the readings that carry no page image (on porphyry 381 of 384) —
     * because they are the axis a reader can actually browse on a short edition;
     * then the leaves as the tree holds them, then the leaves a reading cites but
     * the edition does not hold. */
    this.entries = [
      { key: 'all', kind: 'all', n: null, page: null, url: null, readings: 0, label: '' },
      { key: 'none', kind: 'none', n: null, page: null, url: null, readings: 0, label: '' },
    ];
    data.leaves.forEach(function (l) {
      this.entries.push({
        key: leafName(l.url, l.n),
        kind: 'leaf',
        n: l.n,
        url: l.url,
        page: l.page,
        readings: l.readings,
        label: leafName(l.url, l.n),
      });
    }, this);
    var unheld = [];
    data.rules.forEach(function (r) {
      (r.evidence || []).forEach(function (e) {
        if (e.exists) return;
        if (
          !unheld.some(function (u) {
            return u.n === e.leaf;
          })
        )
          unheld.push({
            key: 'u' + e.leaf,
            kind: 'unheld',
            n: e.leaf,
            page: e.page,
            url: null,
            readings: 0,
            label: leafName(null, e.leaf),
          });
      });
    });
    unheld.forEach(function (u) {
      u.readings = data.rules.filter(function (r) {
        return (r.evidence || []).some(function (e) {
          return e.leaf === u.n && !e.exists;
        });
      }).length;
      this.entries.push(u);
    }, this);
    this.byKey = {};
    this.entries.forEach(function (e) {
      this.byKey[e.key] = e;
    }, this);

    /* The readings of each entry, once: the panel and the counts read the same
     * map, so a count can never disagree with the list beneath it. A rule that
     * cites TWO leaves is listed under each of them — it was decided from both,
     * and a leaf's entry may not silently drop the reading it was taken from. */
    this.readings = {};
    this.entries.forEach(function (e) {
      this.readings[e.key] = [];
    }, this);
    data.rules.forEach(function (r) {
      this.readings.all.push(r);
      var keys = [];
      (r.evidence || []).forEach(function (e) {
        var k = e.exists ? leafName(e.url, e.leaf) : 'u' + e.leaf;
        if (keys.indexOf(k) < 0) keys.push(k);
      });
      if (!keys.length) keys.push('none');
      keys.forEach(function (k) {
        if (this.readings[k]) this.readings[k].push(r);
      }, this);
    }, this);
  }

  Viewer.prototype.passes = function (r) {
    if (this.on[r.type] === false) return false;
    if (!this.q) return true;
    var hay = (r.find + '\n' + r.after + '\n' + r.rationale).toLowerCase();
    return hay.indexOf(this.q) >= 0;
  };

  /** The readings of one entry the CURRENT FILTER shows, in record order. The
   * panel, the counts and a deep link all read this one list. */
  Viewer.prototype.matched = function (key) {
    var self = this;
    return (this.readings[key] || []).filter(function (r) {
      return self.passes(r);
    });
  };

  /* ---------- the controls ---------- */

  Viewer.prototype.renderControls = function () {
    var self = this;
    var box = node('div', 'app-filters');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Filter the readings by type');
    box.appendChild(node('span', 'af-g', 'Filter by type'));
    TYPES.forEach(function (k) {
      var n = self.data.counts[k] || 0;
      if (!n) return;
      var label = node('label');
      var input = node('input');
      input.type = 'checkbox';
      input.checked = true;
      input.setAttribute('data-ap-type', k);
      input.addEventListener('change', function () {
        self.on[k] = input.checked;
        self.page = 0;
        self.renderPanel();
        self.markCounts();
      });
      label.appendChild(input);
      label.appendChild(node('span', null, ' ' + k + ' '));
      label.appendChild(node('span', 'af-n', n));
      box.appendChild(label);
    });
    /* A VERSION WITH NO RECORDED RULES HAS NOTHING TO FILTER OR SEARCH. The two
     * controls would be an empty type filter and a search box over an empty list
     * — controls for a list that does not exist. They are omitted, and the leaf
     * jump below (the whole scan) is what the version does have. */
    if (this.data.ruleCount) this.controls.appendChild(box);

    var search = node('div', 'app-search');
    var lab = node('label', null, 'Search the readings');
    lab.setAttribute('for', 'app-q');
    var input = node('input');
    input.type = 'search';
    input.id = 'app-q';
    input.setAttribute('placeholder', 'a word of the text changed, or of the reason given');
    input.setAttribute('autocomplete', 'off');
    input.addEventListener('input', function () {
      self.q = input.value.trim().toLowerCase();
      self.page = 0;
      self.renderPanel();
      self.markCounts();
    });
    search.appendChild(lab);
    search.appendChild(input);
    if (this.data.ruleCount) this.controls.appendChild(search);

    /* THE DIRECT JUMP. The number a reader has in mind is the one ON the rail's
     * cards and in the panel's caption — the ARCHIVE leaf number (proclus holds
     * n806–n946, not n0–n140), so that is what this takes, and the range is stated
     * beside it. A number the edition does not hold moves nothing and says so. */
    if (!this.data.leaves.length) return;
    var ns = this.data.leaves.map(function (l) {
      return l.n;
    });
    var lo = Math.min.apply(null, ns);
    var hi = Math.max.apply(null, ns);
    var jump = node('div', 'app-jump');
    jump.setAttribute('role', 'group');
    jump.setAttribute('aria-label', 'Go to a leaf by its number');
    var jlab = node('label', null, 'Go to leaf');
    jlab.setAttribute('for', 'app-leaf-jump');
    jump.appendChild(jlab);
    /* A TWO-VOLUME EDITION TAKES A NAME, not only a number: the same number names
     * a leaf of each volume, so the stored name (v1-n74) is the only unambiguous
     * address, and a number input cannot hold one. An edition whose leaves carry
     * no volume prefix keeps the number input it has always had, and its range. */
    var groups = [];
    this.data.leaves.forEach(function (l) {
      var name = leafName(l.url, l.n);
      var pre = /^v\d+-/.test(name) ? name.replace(/-n\d+$/, '') : '';
      var g = groups.filter(function (x) {
        return x.pre === pre;
      })[0];
      if (!g) {
        g = { pre: pre, lo: l.n, hi: l.n };
        groups.push(g);
      }
      g.lo = Math.min(g.lo, l.n);
      g.hi = Math.max(g.hi, l.n);
    });
    var prefixed = groups.some(function (g) {
      return g.pre !== '';
    });
    var jinput = node('input', 'app-jump-n');
    jinput.type = prefixed ? 'text' : 'number';
    jinput.id = 'app-leaf-jump';
    jinput.setAttribute('inputmode', 'numeric');
    jinput.setAttribute('autocomplete', 'off');
    if (!prefixed) {
      jinput.min = String(lo);
      jinput.max = String(hi);
    }
    jump.appendChild(jinput);
    var jgo = node('button', 'app-jump-go', 'Go');
    jgo.type = 'button';
    jump.appendChild(jgo);
    jump.appendChild(
      node(
        'span',
        'app-jump-hint',
        prefixed
          ? groups
              .map(function (g) {
                return (g.pre ? g.pre + ' n' : 'n') + g.lo + '–' + (g.pre ? '' : 'n') + g.hi;
              })
              .join(' · ')
          : 'n' + lo + '–n' + hi,
      ),
    );
    var submit = function () {
      self.jumpTo(jinput.value);
    };
    jgo.addEventListener('click', submit);
    jinput.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.keyCode !== 13) return;
      if (ev.preventDefault) ev.preventDefault();
      submit();
    });
    this.controls.appendChild(jump);
  };

  /** GO STRAIGHT TO A LEAF, by its archive number. The rail is a scroll away from
   * any given leaf — and on proclus it is 141 cards — so the number a reader has
   * is an action, not a journey. A number this edition does not hold is STATED
   * (model §0.4: an empty state is said, never omitted) and nothing moves. */
  Viewer.prototype.jumpTo = function (value) {
    var raw = String(value === undefined || value === null ? '' : value).trim();
    var n = parseInt(raw, 10);
    var ns = this.data.leaves.map(function (l) {
      return l.n;
    });
    var lo = Math.min.apply(null, ns);
    var hi = Math.max.apply(null, ns);
    /* THE STORED NAME IS AN ADDRESS TOO, and for a two-volume edition it is the
     * only unambiguous one: a number that both volumes serve names two leaves. */
    if (this.byKey[raw]) {
      location.hash = '#leaf-' + raw;
      this.revealLeaf(raw);
      return;
    }
    var matches = this.data.leaves.filter(function (l) {
      return l.n === n;
    });
    if (matches.length === 1) {
      var key = leafName(matches[0].url, matches[0].n);
      location.hash = '#leaf-' + key;
      this.revealLeaf(key);
      return;
    }
    if (!this.status) return;
    this.status.textContent = matches.length
      ? 'Leaf n' +
        n +
        ' is stored ' +
        matches.length +
        ' times in this edition, once for each volume that serves it — the index holds ' +
        matches
          .map(function (l) {
            return leafName(l.url, l.n);
          })
          .join(' and ') +
        '. Type one of those names to open it.'
      : 'No leaf n' +
        (raw === '' ? '' : n) +
        ' is stored with this edition: it holds ' +
        plural(this.data.leaves.length, 'leaf', 'leaves') +
        ', n' +
        lo +
        '–n' +
        hi +
        '.';
  };

  /** Bring a leaf's card into the rail's own view. `block: 'nearest'` is the
   * whole point of the call: a card already on screen moves nothing (and the page
   * never moves at all — only the rail scrolls). */
  Viewer.prototype.revealLeaf = function (key) {
    var b = document.getElementById('leaf-' + key);
    if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
  };

  /* ---------- the two axes, in one index ---------- */

  /** One entry of the index. The two READING entries span the strip and carry
   * the label a reader looks for; the leaves carry a thumbnail. */
  Viewer.prototype.renderLeaves = function () {
    var self = this;
    this.entries.forEach(function (e) {
      var scope = e.kind === 'all' || e.kind === 'none';
      var b = node('button', classOf(e));
      b.type = 'button';
      b.id = 'leaf-' + e.key;
      b.setAttribute('data-key', e.key);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', 'false');
      if (scope) {
        b.appendChild(node('span', 'app-leaf-cap', e.kind === 'all' ? 'All readings' : 'Without a page image'));
        b.appendChild(
          node(
            'span',
            'app-scope-note',
            e.kind === 'all'
              ? 'every reading in this version, in record order'
              : 'the readings that rest on no leaf stored with the edition',
          ),
        );
        b.appendChild(node('span', 'app-leaf-n', ''));
      } else {
        if (e.url) {
          var img = node('img', 'app-leaf-img');
          img.src = e.url;
          img.alt = 'archive leaf ' + e.label + ' — the page image, as a thumbnail';
          img.loading = 'lazy';
          img.decoding = 'async';
          b.appendChild(img);
        } else {
          b.appendChild(node('span', 'app-leaf-img app-leaf-noimg', e.kind === 'none' ? 'no page image' : 'not held'));
        }
        b.appendChild(node('span', 'app-leaf-cap', e.label));
        /* A LEAF A READING WAS DECIDED FROM carries a small rubric mark. It is
         * NOT moved out of the run: the index is the whole scan, in leaf order,
         * and the mark says which leaves the apparatus rests on. */
        if (e.readings > 0) {
          var mark = node('span', 'app-leaf-badge');
          mark.setAttribute('title', 'a reading was decided from this leaf');
          b.appendChild(mark);
        }
        b.appendChild(node('span', 'app-leaf-n', ''));
      }
      b.addEventListener('click', function () {
        location.hash = '#' + b.id;
      });
      self.leaves.appendChild(b);
    });
    this.markCounts();
  };

  /** The count each entry carries: the readings it holds THAT THE CURRENT FILTER
   * SHOWS (the total is in the entry's title, so a filtered-away leaf is not
   * mistaken for an empty one). A leaf no reading was TAKEN from says so and is
   * set apart — the reader must be able to tell "no reading was decided from
   * this leaf" from "this leaf's readings are filtered out". */
  Viewer.prototype.markCounts = function () {
    var self = this;
    this.entries.forEach(function (e) {
      var b = document.getElementById('leaf-' + e.key);
      if (!b) return;
      var total = self.readings[e.key].length;
      var shown = self.matched(e.key).length;
      var cap = b.querySelector('.app-leaf-n');
      if (cap) {
        cap.textContent =
          total === 0
            ? 'no readings'
            : shown === total
              ? plural(total, 'reading', 'readings')
              : 'showing ' + shown + ' of ' + total;
        b.setAttribute(
          'title',
          total === 0
            ? e.kind === 'leaf' || e.kind === 'unheld'
              ? 'no reading was decided from this leaf'
              : self.data.ruleCount
                ? 'no reading is recorded for this entry'
                : 'no repair is recorded in this version yet'
            : total + ' reading(s) recorded for this entry; ' + shown + ' shown by the current filter',
        );
      }
      b.className =
        classOf(e) +
        (e.kind === 'leaf' && total > 0 ? ' app-leaf-evidence' : '') +
        (total === 0 ? ' app-leaf-quiet' : shown ? '' : ' app-leaf-empty');
      if (self.selected === e.key) {
        b.className += ' selected';
        b.setAttribute('aria-selected', 'true');
      } else {
        b.setAttribute('aria-selected', 'false');
      }
    });
  };

  /* ---------- the panel ---------- */

  Viewer.prototype.headTitle = function (entry) {
    if (entry.kind === 'all') return 'Every reading in this version';
    if (entry.kind === 'none') return 'Readings decided without a page image';
    if (entry.kind === 'unheld') return 'Readings decided from a leaf that is not held here';
    return entry.readings > 0 ? 'Readings decided from this leaf' : 'This leaf';
  };

  Viewer.prototype.noteFor = function (entry) {
    /* A VERSION WITH NO RULES SAYS IT ONCE, in the panel's empty state, and not
     * three times over: the per-entry notes below describe readings that would be
     * beneath them, and there are none. */
    if (!this.data.ruleCount) return null;
    if (entry.kind === 'all')
      return (
        'The version’s readings in record order, each with the leaf it was decided from where the record ' +
        'names one. The leaves are indexed beneath: a page image opens the readings taken from it.'
      );
    if (entry.kind === 'none')
      return (
        'These readings rest on the transcription’s own context or on a parallel edition, not on a page image, ' +
        'so no leaf is recorded for them. Each states the witness it rested on.'
      );
    if (entry.kind === 'unheld')
      return (
        'The page image is cited here but the leaf is not stored with this edition, so it cannot be shown: ' +
        'the citation stands and is named, and the leaf number is the record of where the reading was taken.'
      );
    return null;
  };

  /** THE PAGER: the range, the total and the page, with the two controls — the
   * list never grows into a wall, and the count is always stated. */
  Viewer.prototype.pager = function (start, count, total) {
    var self = this;
    var pages = Math.ceil(total / PAGE);
    var nav = node('nav', 'app-pager');
    nav.id = 'app-pager';
    nav.setAttribute('aria-label', 'Pages of this list');
    var prev = node('button', 'app-page-prev', 'Previous');
    prev.type = 'button';
    prev.disabled = this.page === 0;
    prev.addEventListener('click', function () {
      if (self.page > 0) {
        self.page -= 1;
        self.renderPanel();
        self.markCounts();
      }
    });
    var next = node('button', 'app-page-next', 'Next');
    next.type = 'button';
    next.disabled = this.page >= pages - 1;
    next.addEventListener('click', function () {
      if (self.page < pages - 1) {
        self.page += 1;
        self.renderPanel();
        self.markCounts();
        if (self.panel.scrollIntoView) self.panel.scrollIntoView({ block: 'start' });
      }
    });
    var range = node(
      'span',
      'app-range',
      'readings ' + (start + 1) + '–' + (start + count) + ' of ' + total + ' · page ' + (this.page + 1) + ' of ' + pages,
    );
    nav.appendChild(prev);
    nav.appendChild(range);
    nav.appendChild(next);
    return nav;
  };

  /** PAGING THROUGH THE SCAN: the leaf before and the leaf after, in leaf order.
   * The index is the whole scan, so the sequence is the STORED leaves — a cited
   * but unheld leaf is not a page of it and is not stepped through. The ends are
   * stated by a disabled button, not by silence. */
  Viewer.prototype.leafNav = function (entry) {
    var seq = [];
    this.entries.forEach(function (e) {
      if (e.kind === 'leaf') seq.push(e);
    });
    var at = -1;
    for (var i = 0; i < seq.length; i += 1) if (seq[i].key === entry.key) at = i;
    var prev = at > 0 ? seq[at - 1] : null;
    var next = at >= 0 && at < seq.length - 1 ? seq[at + 1] : null;
    var go = function (e) {
      return function () {
        location.hash = '#leaf-' + e.key;
      };
    };
    var nav = node('nav', 'app-leafnav');
    nav.id = 'app-leafnav';
    nav.setAttribute('aria-label', 'Leaf by leaf through the page images');
    var back = node('button', 'app-leaf-prev', prev ? 'Previous leaf · ' + prev.label : 'Previous leaf');
    back.type = 'button';
    back.disabled = !prev;
    if (prev) back.addEventListener('click', go(prev));
    var fwd = node('button', 'app-leaf-next', next ? 'Next leaf · ' + next.label : 'Next leaf');
    fwd.type = 'button';
    fwd.disabled = !next;
    if (next) fwd.addEventListener('click', go(next));
    nav.appendChild(back);
    nav.appendChild(node('span', 'app-leafnav-at', 'leaf ' + (at + 1) + ' of ' + seq.length));
    nav.appendChild(fwd);
    return nav;
  };

  Viewer.prototype.renderPanel = function () {
    var self = this;
    var entry = this.byKey[this.selected];
    if (!entry) return;
    this.panel.textContent = '';
    /* THE PANEL'S WAY BACK TO THE INDEX. The rail is beside the panel (above it on
     * a narrow screen) and scrolls itself, so this is not an escape — but a reader
     * who has paged down a long list should not have to hunt for the rail again,
     * and on a narrow screen it may be a pane away. It scrolls without touching
     * the fragment: a `#app-leaves` anchor would fire `hashchange`, which is the
     * viewer's own entry point. */
    var toIndex = node('a', 'app-to-index', '↑ The leaf index');
    toIndex.href = '#app-leaves';
    toIndex.addEventListener('click', function (ev) {
      if (ev.preventDefault) ev.preventDefault();
      if (self.leaves && self.leaves.scrollIntoView) self.leaves.scrollIntoView({ block: 'start' });
    });
    this.panel.appendChild(toIndex);
    if (entry.url) {
      var fromLeaf = entry.readings > 0;
      var fig = node('figure', 'app-figure');
      var a = node('a', 'app-leaf-link');
      a.href = entry.url;
      a.setAttribute('rel', 'noreferrer');
      var img = node('img', 'app-panel-img');
      img.src = entry.url;
      img.alt = caption(entry) + (fromLeaf ? ' — the page image this reading was decided from' : ' — the page image of this leaf');
      fig.appendChild(a);
      a.appendChild(img);
      fig.appendChild(node('figcaption', 'app-caption', caption(entry)));
      fig.appendChild(
        node(
          'p',
          'app-note',
          'The whole leaf is shown — the page image stored with this edition. Open the link for it at full ' +
            'size; no crop is made, because the leaf the edition stores IS the region the reading came from.' +
            (fromLeaf
              ? ''
              : ' No reading in this version was decided from it: the page images are stored whole, so the ' +
                'leaf is readable whether or not a rule used it.'),
        ),
      );
      this.panel.appendChild(fig);
      if (entry.kind === 'leaf') this.panel.appendChild(this.leafNav(entry));
    } else {
      this.panel.appendChild(node('p', 'app-caption', caption(entry)));
    }

    var held = this.readings[entry.key];
    var matched = this.matched(entry.key);
    var pages = Math.max(1, Math.ceil(matched.length / PAGE));
    if (this.page > pages - 1) this.page = pages - 1;
    if (this.page < 0) this.page = 0;
    var start = this.page * PAGE;
    var rows = matched.slice(start, start + PAGE);

    var head = node('h3', 'app-panel-head');
    head.appendChild(node('span', null, this.headTitle(entry)));
    head.appendChild(
      node(
        'span',
        'app-count',
        held.length === 0
          ? 'no reading recorded here'
          : matched.length === held.length
            ? matched.length + ' of ' + this.data.ruleCount + ' in the version'
            : 'showing ' + matched.length + ' of ' + held.length + ' recorded here',
      ),
    );
    this.panel.appendChild(head);

    var note = this.noteFor(entry);
    if (note) this.panel.appendChild(node('p', 'app-note', note));

    if (!matched.length) {
      /* AN EMPTY LIST IS A STATE AND IS SAID, NEVER LEFT BLANK (model §0.4).
       * Three different emptinesses, told apart: a filter that hides everything,
       * a version whose log is empty because no repair has been made yet, and a
       * leaf no reading was decided from. The old code said "this leaf carries no
       * recorded reading" of ALL of them — including the whole-log entry, which
       * is not a leaf. */
      var msg;
      if (held.length) {
        msg = 'No reading recorded for this entry matches the current filter.';
      } else if (!this.data.ruleCount) {
        msg =
          'This version carries NO recorded repairs yet: the reading view and the transcription view are the ' +
          'same text, every damaged character standing as the scanner left it and marked as damage. No reading ' +
          'is recorded here — and none is lost, because nothing has been changed: each emendation will appear ' +
          'in this list as it is made. The page images beside this panel are the other axis, and they are all ' +
          'here: every leaf of the edition’s scan is stored and readable, whether or not a reading comes from it.';
      } else if (entry.kind === 'all') {
        msg = 'No reading in this version matches the current filter.';
      } else if (entry.kind === 'none') {
        msg = 'Every reading in this version rests on a page image, so none is listed without one.';
      } else {
        msg =
          'This leaf carries no recorded reading: no rule of this version was decided from it. ' +
          'The page image is above — the whole scan is stored, so every leaf of it is readable here.';
      }
      this.panel.appendChild(node('p', 'app-note', msg));
      return;
    }
    if (matched.length > PAGE) this.panel.appendChild(this.pager(start, rows.length, matched.length));
    if (entry.kind === 'all' || entry.kind === 'none') {
      this.panel.appendChild(this.compactList(rows));
      return;
    }
    this.panel.appendChild(this.readingList(rows));
  };

  /** The readings of a leaf, in full: every field a reader needs to check the
   * reading against the leaf above it. */
  Viewer.prototype.readingList = function (rows) {
    var ol = node('ol', 'apparatus-list');
    rows.forEach(function (r) {
      var li = node('li', 'apparatus-entry');
      li.id = 'repair-' + r.id;
      li.setAttribute('data-type', r.type);
      li.appendChild(node('span', 'rp-id', r.id));
      li.appendChild(node('span', 'rp-type', r.type));
      li.appendChild(node('span', 'rp-apply', r.apply));
      var change = node('p', 'rp-change');
      change.appendChild(node('span', 'before', r.before));
      change.appendChild(node('span', null, ' → '));
      change.appendChild(node('span', 'after', r.after));
      li.appendChild(change);
      if (r.rationale) li.appendChild(node('p', 'rp-rationale', r.rationale));
      li.appendChild(
        node(
          'p',
          'rp-witness',
          (r.witness ? 'witness: ' + r.witness : 'no witness') + ' · ' + evidenceNote(r) + (r.date ? ' · ' + r.date : ''),
        ),
      );
      ol.appendChild(li);
    });
    return ol;
  };

  /** The readings listed compactly — an id, the type, the change and the leaf it
   * rests on — the words being one click away at the anchor. This is the form
   * the long lists take: the whole log, and the readings with no page image. */
  Viewer.prototype.compactList = function (rows) {
    var ul = node('ul', 'app-compact');
    rows.forEach(function (r) {
      var li = node('li', 'app-compact-row');
      li.id = 'repair-' + r.id;
      li.setAttribute('data-type', r.type);
      var a = node('a', 'rp-id');
      a.href = '#repair-' + r.id;
      a.textContent = r.id;
      li.appendChild(a);
      li.appendChild(node('span', 'rp-type', r.type));
      li.appendChild(node('span', 'rp-apply', r.apply));
      li.appendChild(node('span', 'app-compact-change', r.before + ' → ' + r.after));
      li.appendChild(node('span', 'app-compact-witness', evidenceNote(r)));
      ul.appendChild(li);
    });
    return ul;
  };

  /* ---------- selection, and the fragment ---------- */

  /** Turn to the page of a paged list that holds one reading, or 0 if the list
   * is short enough not to be paged. */
  Viewer.prototype.pageOf = function (key, ruleId) {
    var m = this.matched(key);
    for (var i = 0; i < m.length; i += 1) if (m[i].id === ruleId) return Math.floor(i / PAGE);
    return 0;
  };

  Viewer.prototype.select = function (key, ruleId) {
    if (!this.byKey[key]) key = 'none';
    this.selected = key;
    this.page = ruleId ? this.pageOf(key, ruleId) : 0;
    this.renderPanel();
    if (this.leaves) this.markCounts();
    var panel = this.panel;
    if (ruleId) {
      var el = document.getElementById('repair-' + ruleId);
      if (el) {
        el.className += ' target';
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      }
    } else if (panel && panel.scrollIntoView) {
      panel.scrollIntoView({ block: 'start' });
    }
  };

  /** WHERE THE VIEWER OPENS: the first leaf that HAS readings — never an empty
   * leaf, which would tell a reader the apparatus is empty. If no leaf carries
   * one, the readings with no page image; failing that the whole log. */
  Viewer.prototype.landing = function () {
    for (var i = 0; i < this.entries.length; i += 1) {
      var e = this.entries[i];
      if (e.kind === 'leaf' && this.readings[e.key].length) return e.key;
    }
    if (this.readings.none.length) return 'none';
    return 'all';
  };

  /** The fragment decides what is open: a reading (`#repair-<id>`) or an entry
   * (`#leaf-nNNN`). Anything else opens the landing entry — a viewer that opened
   * on nothing would look broken. */
  Viewer.prototype.applyHash = function () {
    var h = String(location.hash || '').replace(/^#/, '');
    if (/^repair-/.test(h)) {
      var id = h.slice('repair-'.length);
      var rule = null;
      for (var i = 0; i < this.data.rules.length; i += 1) {
        if (this.data.rules[i].id === id) {
          rule = this.data.rules[i];
          break;
        }
      }
      if (rule) {
        var key = keyOfRule(rule);
        this.select(this.byKey[key] ? key : 'none', id);
        return;
      }
    }
    if (/^leaf-/.test(h)) {
      var leafKey = h.slice('leaf-'.length);
      if (this.byKey[leafKey]) {
        this.select(leafKey, null);
        /* THE CARD COMES INTO THE RAIL'S OWN VIEW TOO: a jump (from the number
         * input, the pager or a `#leaf-` link) may name a leaf the rail is not
         * currently showing, and a panel that changes while the rail shows some
         * other part of the scan is a reader's second guess. */
        this.revealLeaf(leafKey);
        return;
      }
    }
    /* AN UNKNOWN FRAGMENT IS AN IN-PAGE JUMP, NOT A RESET. The apparatus page's
     * own jump bar targets `#app-leaves` and `#app-panel`, and the back-to-top
     * control targets `#top`; none of those names an entry, and the browser has
     * already scrolled to it. On the FIRST call the viewer must still open
     * something — the landing entry — but a later `hashchange` from a jump link
     * must leave the reader where they were rather than throwing the selection
     * back to the landing leaf. */
    if (this.selected) return;
    this.select(this.landing(), null);
  };

  Viewer.prototype.render = function () {
    var self = this;
    this.renderControls();
    this.renderLeaves();
    /* THE DATA STAYS REACHABLE WITH THE VIEWER UP: the no-script statement that
     * carried the address is taken away, so the address is restated here — built
     * from the page's own attribute, never from a string in this file. */
    var src = this.root.getAttribute('data-src');
    var data = node('p', 'app-data');
    data.appendChild(node('span', null, 'The apparatus of this version is one plain file: '));
    var link = node('a');
    link.href = src;
    link.textContent = src;
    data.appendChild(link);
    data.appendChild(
      node('span', null, ' — every rule, its reason, its witness and the leaf it was decided from.'),
    );
    this.root.appendChild(data);
    if (this.fallback) this.fallback.parentNode.removeChild(this.fallback);
    if (this.status) this.status.textContent = '';
    this.applyHash();
    window.addEventListener('hashchange', function () {
      self.applyHash();
    });
  };

  /** WHAT THE READER SEES WHEN THE DATA DOES NOT ARRIVE. The server-rendered
   * statement of the apparatus stays where it is — it names the data file and
   * the page images — and the status line says what failed. Nothing is shown
   * silently: the reader is told the viewer did not run, and where the apparatus
   * is anyway. */
  function boot() {
    var root = document.getElementById('apparatus-viewer');
    if (!root || root.getAttribute('data-booted') === '1') return;
    root.setAttribute('data-booted', '1');
    var src = root.getAttribute('data-src');
    var status = document.getElementById('app-status');
    fetch(src)
      .then(function (res) {
        if (!res || res.ok === false) throw new Error('the apparatus data returned ' + (res ? res.status : 'no response'));
        return res.text();
      })
      .then(function (text) {
        new Viewer(root, JSON.parse(text)).render();
      })
      .catch(function (err) {
        if (!status) return;
        status.textContent = '';
        status.appendChild(
          node('span', 'app-fail', 'The leaf viewer could not load the apparatus here (' + (err && err.message ? err.message : err) + '). '),
        );
        status.appendChild(
          node(
            'span',
            null,
            'The apparatus is not lost: it is a plain file, served with this edition, and every page image it ' +
              'cites is served beside the text. The statement above names where they are.',
          ),
        );
      });
  }

  var API = { boot: boot, keyOfRule: keyOfRule, evidenceNote: evidenceNote, caption: caption, PAGE: PAGE };
  if (typeof window !== 'undefined') window.Apparatus = API;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    boot();
  }
})();
