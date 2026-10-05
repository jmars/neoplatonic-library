/**
 * tools/search/shelf.js — the search pipeline for the library's /search/ page.
 *
 * THIS IS THE BLOG'S SEARCH CLIENT, REDUCED TO ITS SHELF HALF. It was lifted out
 * of ~/enlighten/tools/search/search.js and the pieces' providers were cut away
 * with it: the blog-pieces lexical index, the tf-idf VECTOR space and the datalog
 * GRAPH over the posts' citations are not here, and neither is the fetched
 * positions half of the pieces' text. What remains is the machinery that half
 * stands on and the shelf provider the blog rendered BELOW the pieces:
 *
 *   words   a sorted vocabulary held as a MINIMAL ACYCLIC AUTOMATON, walked back
 *           out at load; a query word is looked up exactly and as a PREFIX, and a
 *           hit in an edition's or a section's title weighs more than a hit in a
 *           passage's body.
 *   pattern a `/pattern/` is answered by walking the same automaton with a small
 *           NFA, which is what lets it match the MIDDLE of a word.
 *   fuzzy   a `~word` carries an edit-distance row down the automaton.
 *   phrase  a quoted run is ADJACENCY over a passage's own words.
 *
 * A passage is `[doc, anchor, page, opens-the-section, section number, text]` —
 * one paragraph or note of the reading view, carrying the document it belongs to,
 * the anchor it links to and the printed page where the volume has one. A result
 * is a CITATION: the link goes INTO the book at that passage's anchor, and it
 * points at `/texts/<slug>/` (the blog's `/library/` constant, changed).
 *
 * The build inlines this file into the page comment-free. The surface is the same
 * one the blog exposed, minus the pieces:
 *
 *   Search.providers = { shelf(q, opts) }
 *   Search.queryShelf(text, opts) -> { results, counts, marks }
 *   Search.matchPattern / matchFuzzy / matchPrefix
 *   Search.shelf() -> the decoded index
 */
(function () {
  'use strict';

  var PREFIX_CAP = 120;   // vocabulary terms one prefix may expand to
  var FUZZY_CAP = 200;    // vocabulary terms one fuzzy word may expand to
  var RESULT_CAP = 24;    // passages returned for one query
  var COMPLETE_CAP = 8;   // vocabulary terms the box offers for one typed prefix
  var COMPLETE_MIN = 3;   // characters a word needs before any are offered
  var SUGGEST_CAP = 24;   // near words one typo may be weighed against
  var THIN = 2;           // results at or below which a misspelling is offered

  /* The shelf's three weights. The first two are the pieces' own calibration
   * carried over: an exact body hit is 1, and a hit in a text's or a section's
   * title is 2.6x it. `open` (1.35) is a chosen tie-break: the passage that OPENS
   * a section is where that section's title claim is made, so it goes above a
   * passage deep inside the section. Only ever reorders passages of comparable
   * weight; the heading factor above it decides. */
  var SHELF_W = { body: 1, head: 2.6, open: 1.35 };

  var WORD = /[a-z][a-z'-]+/g;
  var FUZZY_MARK = /~{1,2}[a-z][a-z'-]*/g;
  var FUZZY_TILDES = /^~+/;
  var PHRASE_MARK = /"([^"]*)"/g;

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /* ---------- tokenising: the same rule the index was built with ---------- */

  /** The query's words: lowercased, `[a-z][a-z'-]+`, three or more characters,
   * stopwords dropped, each word once — the index's own rule. A word behind a
   * `~` is a fuzzy term, not an ordinary one; a word inside a quoted phrase is
   * part of the phrase and is lifted out first. */
  function tokenize(text, stop) {
    var ws = stripPhrases(String(text), stop).toLowerCase().replace(FUZZY_MARK, ' ').match(WORD) || [];
    var out = [], i, w;
    for (i = 0; i < ws.length; i++) {
      w = ws[i];
      if (w.length >= 3 && !stop[w] && out.indexOf(w) < 0) out.push(w);
    }
    return out;
  }

  /* ---------- the query's fuzzy terms ------------------------------------- */

  function fuzzyTerms(text, stop) {
    var s = String(text).toLowerCase(), out = [], m, w;
    FUZZY_MARK.lastIndex = 0;
    while ((m = FUZZY_MARK.exec(s))) {
      w = m[0].replace(FUZZY_TILDES, '');
      if (w.length >= 3 && !stop[w]) out.push({ q: w, k: m[0].length - w.length });
    }
    return out;
  }

  /* ---------- the query's phrases ------------------------------------------ */

  /** The quoted runs, read off the RAW text, in the order they appear. A run
   * becomes a SEQUENCE: every word of the run with its offset in the run's own
   * token list. A stopword inside a phrase is PART OF THE PHRASE (the reader
   * wrote it inside a demand matched as written); a run with no recordable word
   * is not a phrase and is dropped and reported. */
  function phraseTerms(text, stop) {
    var out = [], dropped = [], m;
    PHRASE_MARK.lastIndex = 0;
    while ((m = PHRASE_MARK.exec(String(text)))) {
      var toks = m[1].toLowerCase().match(WORD) || [];
      var seq = [];
      for (var i = 0; i < toks.length; i++) {
        if (toks[i].length >= 3 && !stop[toks[i]]) seq.push({ w: toks[i], off: i });
      }
      if (!seq.length) { dropped.push(m[1]); continue; }
      var uniq = [];
      for (var j = 0; j < seq.length; j++) if (uniq.indexOf(seq[j].w) < 0) uniq.push(seq[j].w);
      out.push({ text: m[1], words: uniq, seq: seq });
    }
    return { phrases: out, dropped: dropped };
  }

  /** The query with its phrases lifted out, so a phrase's words cannot come back
   * as prefix hits through the back door. */
  function stripPhrases(text, stop) {
    if (String(text).indexOf('"') < 0) return String(text);
    var ph = phraseTerms(text, stop);
    var out = String(text);
    for (var i = 0; i < ph.phrases.length; i++) {
      var re = new RegExp('[a-z\'-]*' + escReWord(ph.phrases[i].text) + '[a-z\'-]*', 'gi');
      out = out.replace(re, ' ');
    }
    out = out.replace(/"/g, ' ');
    return out;
  }

  function escReWord(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** The words of every quoted run, for the MARKS. */
  function phraseWords(text, stop) {
    var ph = phraseTerms(text, stop), out = [], i, j;
    for (i = 0; i < ph.phrases.length; i++) {
      for (j = 0; j < ph.phrases[i].words.length; j++) {
        if (out.indexOf(ph.phrases[i].words[j]) < 0) out.push(ph.phrases[i].words[j]);
      }
    }
    return out;
  }

  /* ---------- the automaton the words are held in -------------------------- */

  var ENC = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_~';
  var ENC_AT = (function () {
    var m = {}, i;
    for (i = 0; i < ENC.length; i++) m[ENC.charAt(i)] = i;
    return m;
  })();

  function decodeDafsa(d) {
    var s = d.s, l = d.l, t = d.t;
    var n = s.length;
    var off = new Int32Array(n + 1), fin = new Uint8Array(n), to = new Int32Array(l.length);
    var e = 0, at = 0, i, k;
    for (i = 0; i < n; i++) {
      var c = ENC_AT[s.charAt(i)];
      fin[i] = c >>> 5;
      var deg = c & 31;
      off[i] = e;
      for (k = 0; k < deg; k++) {
        var v = 0, mul = 1, cv;
        do {
          cv = ENC_AT[t.charAt(at++)];
          v += (cv & 31) * mul;
          mul *= 32;
        } while (cv >= 32);
        to[e++] = i - v;
      }
    }
    off[n] = e;
    return { n: n, off: off, fin: fin, to: to, lbl: l, root: n - 1 };
  }

  /** The words, walked back out of the automaton in the sorted order the
   * postings are indexed by. */
  function dafsaTerms(g) {
    var out = [], chars = [];
    (function visit(st) {
      if (g.fin[st]) out.push(chars.join(''));
      for (var e = g.off[st]; e < g.off[st + 1]; e++) {
        chars.push(g.lbl.charAt(e));
        visit(g.to[e]);
        chars.pop();
      }
    })(g.root);
    return out;
  }

  /** The words within `k` edits of a query word, walked over the automaton with a
   * DP row (OSA: an adjacent swap counts as one edit). A branch is dropped once
   * the row's minimum passes k, and the cap is REPORTED. */
  function fuzzyWalk(g, q, k, cap) {
    var m = q.length, words = [], chars = [], capped = false;
    var qi = new Int32Array(m + 1), j;
    for (j = 1; j <= m; j++) qi[j] = q.charCodeAt(j - 1);

    function visit(st, row, prev, last) {
      var e, c, cc, next, min, v, jj;
      if (g.fin[st] && row[m] <= k) {
        words.push({ w: chars.join(''), d: row[m] });
        if (words.length >= cap) { capped = true; return true; }
      }
      for (e = g.off[st]; e < g.off[st + 1]; e++) {
        c = g.lbl.charAt(e);
        cc = g.lbl.charCodeAt(e);
        next = new Int32Array(m + 1);
        next[0] = row[0] + 1;
        min = next[0];
        for (jj = 1; jj <= m; jj++) {
          v = Math.min(row[jj] + 1, next[jj - 1] + 1, row[jj - 1] + (qi[jj] === cc ? 0 : 1));
          if (prev && jj > 1 && last === q.charAt(jj - 1) && c === q.charAt(jj - 2)) {
            v = Math.min(v, prev[jj - 2] + 1);
          }
          next[jj] = v;
          if (v < min) min = v;
        }
        if (min > k) continue;
        chars.push(c);
        if (visit(g.to[e], next, row, c)) { chars.pop(); return true; }
        chars.pop();
      }
      return false;
    }

    var root0 = new Int32Array(m + 1);
    for (j = 0; j <= m; j++) root0[j] = j;
    visit(g.root, root0, null, null);
    return { words: words, capped: capped };
  }

  /** The words that BEGIN with a prefix, off the automaton, in the list's own
   * order, with the bound reported when it stops the walk. */
  function prefixWalk(g, prefix, cap) {
    var st = g.root, i, e, next, out = [], chars = [], capped = false;
    for (i = 0; i < prefix.length; i++) {
      next = -1;
      for (e = g.off[st]; e < g.off[st + 1]; e++) {
        if (g.lbl.charAt(e) === prefix.charAt(i)) { next = g.to[e]; break; }
      }
      if (next < 0) return { terms: out, capped: false };
      st = next;
    }
    (function visit(s) {
      if (g.fin[s]) {
        out.push(prefix + chars.join(''));
        if (out.length > cap) return true;
      }
      for (var e2 = g.off[s]; e2 < g.off[s + 1]; e2++) {
        chars.push(g.lbl.charAt(e2));
        if (visit(g.to[e2])) { chars.pop(); return true; }
        chars.pop();
      }
      return false;
    })(st);
    if (out.length > cap) { out.length = cap; capped = true; }
    return { terms: out, capped: capped };
  }

  /** The one word of a thin query that is not in the list and has a word within
   * one edit of it — the "did you mean". The same walk `~` uses. */
  function suggestWords(shelf, text, toks) {
    if (!shelf.dafsa || !toks.length) return null;
    var best = null, i, wi, hit, cand, re, corrected;
    for (i = 0; i < toks.length; i++) {
      if (shelf.at[toks[i]] !== undefined) continue;
      hit = fuzzyWalk(shelf.dafsa, toks[i], 1, SUGGEST_CAP);
      for (wi = 0; wi < hit.words.length; wi++) {
        cand = hit.words[wi];
        if (!best || cand.d < best.d || (cand.d === best.d && cand.w < best.to)) {
          best = { from: toks[i], to: cand.w, d: cand.d, capped: hit.capped };
        }
      }
    }
    if (!best) return null;
    re = new RegExp('\\b' + escRe(best.from) + '\\b', 'i');
    corrected = String(text).replace(re, best.to);
    if (corrected === String(text)) return null;
    best.corrected = corrected;
    return best;
  }

  /** The first array position holding `x` or more — the prefix lookup's floor. */
  function lowBound(arr, x) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /* ---------- a pattern, walked over the automaton ------------------------- */

  /** The pattern syntax, and only it: literal characters, `.` for any character,
   * `*` `+` `?` for repetition, `[abc]` / `[a-z]` / `[^abc]` for a set, `|` to
   * alternate, `()` to group, `^` and `$` for the start and the end of a word.
   * Compiled to a small NFA and run by this file, never handed to the browser's
   * regular-expression engine. A pattern with nothing anchoring it matches at ANY
   * position in a word. */
  function parsePattern(body) {
    var i = 0, anchoredStart = false, anchoredEnd = false;

    function fail(msg) { throw new Error(msg); }

    function charClass() {
      i++;
      var neg = false, set = {}, n = 0, k;
      if (body.charAt(i) === '^') { neg = true; i++; }
      while (i < body.length && body.charAt(i) !== ']') {
        var c = body.charAt(i);
        if (c === '\\') fail('a backslash escape is not supported');
        if (body.charAt(i + 1) === '-' && i + 2 < body.length && body.charAt(i + 2) !== ']') {
          var lo = c.charCodeAt(0), hi = body.charCodeAt(i + 2);
          if (hi < lo) fail('the range in a character class runs backwards');
          for (k = lo; k <= hi; k++) set[k] = 1;
          i += 3;
        } else {
          set[c.charCodeAt(0)] = 1;
          i++;
        }
        n++;
      }
      if (body.charAt(i) !== ']') fail('a character class is not closed');
      if (!n) fail('an empty character class is not supported');
      i++;
      return { t: 'set', set: set, neg: neg };
    }

    function atom() {
      var c = body.charAt(i);
      if (!c) fail('the pattern ends where a character was expected');
      if (c === '(') {
        i++;
        var inner = alt();
        if (body.charAt(i) !== ')') fail('a group is not closed');
        i++;
        return inner;
      }
      if (c === '[') return charClass();
      if (c === '.') { i++; return { t: 'any' }; }
      if (c === '^') fail('^ is only supported at the beginning of the pattern');
      if (c === '$') fail('$ is only supported at the end of the pattern');
      if (c === '*' || c === '+' || c === '?') fail('there is nothing for "' + c + '" to repeat');
      if (c === '{' || c === '}') fail('counted repetition is not supported');
      if (c === '\\') fail('a backslash escape is not supported');
      if (c < ' ' || c > '~') fail('the pattern holds a character that is not a printable one');
      i++;
      return { t: 'one', c: c };
    }

    function repeat() {
      var a = atom(), c;
      for (;;) {
        c = body.charAt(i);
        if (c === '*') { i++; a = { t: 'star', a: a }; }
        else if (c === '+') { i++; a = { t: 'plus', a: a }; }
        else if (c === '?') { i++; a = { t: 'opt', a: a }; }
        else return a;
      }
    }

    function concat() {
      var parts = [], c;
      while (i < body.length) {
        c = body.charAt(i);
        if (c === '|' || c === ')') break;
        if (c === '$') {
          if (i !== body.length - 1) fail('$ is only supported at the end of the pattern');
          anchoredEnd = true;
          i++;
          break;
        }
        parts.push(repeat());
      }
      return parts.length === 1 ? parts[0] : { t: 'cat', parts: parts };
    }

    function alt() {
      var branches = [concat()];
      while (body.charAt(i) === '|') { i++; branches.push(concat()); }
      return branches.length === 1 ? branches[0] : { t: 'alt', branches: branches };
    }

    if (body.charAt(0) === '^') { anchoredStart = true; i = 1; }
    var ast = alt();
    if (i < body.length) fail('there is more in the pattern than one expression');
    return { ast: ast, anchoredStart: anchoredStart, anchoredEnd: anchoredEnd };
  }

  /** A pattern as a small NFA (Thompson's construction). Holes are patched as
   * fragments are joined. */
  function compileRe(p) {
    var nfa = [];
    function alloc(op) {
      nfa.push({ op: op, set: null, neg: null, out: -1, out1: -1 });
      return nfa.length - 1;
    }
    function patch(holes, target) {
      for (var i = 0; i < holes.length; i++) {
        if (holes[i][1]) nfa[holes[i][0]].out1 = target;
        else nfa[holes[i][0]].out = target;
      }
    }
    function compile(n) {
      var s, k, f, g;
      if (n.t === 'one' || n.t === 'any') {
        s = alloc('char');
        if (n.t === 'one') nfa[s].set = n.c.charCodeAt(0);
        return { start: s, holes: [[s, 0]] };
      }
      if (n.t === 'set') {
        s = alloc('char');
        if (n.neg) nfa[s].neg = n.set;
        else nfa[s].set = n.set;
        return { start: s, holes: [[s, 0]] };
      }
      if (n.t === 'cat') {
        if (!n.parts.length) {
          s = alloc('eps');
          return { start: s, holes: [[s, 0]] };
        }
        f = compile(n.parts[0]);
        for (k = 1; k < n.parts.length; k++) {
          g = compile(n.parts[k]);
          patch(f.holes, g.start);
          f = { start: f.start, holes: g.holes };
        }
        return f;
      }
      if (n.t === 'alt') {
        f = compile(n.branches[0]);
        for (k = 1; k < n.branches.length; k++) {
          g = compile(n.branches[k]);
          s = alloc('split');
          nfa[s].out = f.start;
          nfa[s].out1 = g.start;
          f = { start: s, holes: f.holes.concat(g.holes) };
        }
        return f;
      }
      if (n.t === 'star') {
        f = compile(n.a);
        s = alloc('split');
        nfa[s].out = f.start;
        patch(f.holes, s);
        return { start: s, holes: [[s, 1]] };
      }
      if (n.t === 'plus') {
        f = compile(n.a);
        s = alloc('split');
        patch(f.holes, s);
        nfa[s].out = f.start;
        return { start: f.start, holes: [[s, 1]] };
      }
      f = compile(n.a); // '?'
      s = alloc('split');
      nfa[s].out = f.start;
      return { start: s, holes: f.holes.concat([[s, 1]]) };
    }
    var frag = compile(p.ast);
    var acc = alloc('accept');
    patch(frag.holes, acc);
    var pre = -1;
    if (!p.anchoredStart) {
      pre = alloc('eps');
      nfa[pre].out = frag.start;
    }
    return { nfa: nfa, start: frag.start, acc: acc, pre: pre, sticky: !p.anchoredEnd };
  }

  /** A compiled pattern. `walk` carries a SET OF NFA STATES down the automaton's
   * states and memoises it; the cap bounds the walk and is reported. */
  function Pattern(text, body) {
    var p = parsePattern(body);
    var c = compileRe(p);
    this.text = text;
    this.body = body;
    this.nfa = c.nfa;
    this.start = c.start;
    this.acc = c.acc;
    this.pre = c.pre;
    this.sticky = c.sticky;
    this.anchoredStart = p.anchoredStart;
    this.clo = {};
  }

  Pattern.prototype.closure = function (list) {
    var start = list.slice().sort(function (a, b) { return a - b; });
    var k = start.join('.');
    var had = this.clo[k];
    if (had) return had;
    var nfa = this.nfa, seen = {}, stack = start.slice(), i, j;
    for (i = 0; i < start.length; i++) seen[start[i]] = 1;
    while (stack.length) {
      var nd = nfa[stack.pop()];
      if (nd.op === 'char' || nd.op === 'accept') continue;
      for (j = 0; j < 2; j++) {
        var o = j ? nd.out1 : nd.out;
        if (o < 0 || seen[o]) continue;
        seen[o] = 1;
        stack.push(o);
      }
    }
    var out = [];
    for (var id in seen) out.push(+id);
    out.sort(function (a, b) { return a - b; });
    this.clo[k] = out;
    return out;
  };

  Pattern.prototype.step = function (list, code) {
    var nfa = this.nfa, out = [], i, nd;
    for (i = 0; i < list.length; i++) {
      nd = nfa[list[i]];
      if (nd.op !== 'char') continue;
      if (nd.neg ? !nd.neg[code] : (nd.set === null || (typeof nd.set === 'number' ? nd.set === code : !!nd.set[code]))) {
        out.push(nd.out);
      }
    }
    return out;
  };

  Pattern.prototype.walk = function (g) {
    var self = this, matches = [], chars = [], dead = {}, capped = false;
    var ACC = this.acc, sticky = this.sticky, NONE = [];
    if (!g) return { terms: matches, capped: capped };
    var base = this.anchoredStart ? null : [this.pre];
    var init = this.closure(base || [this.start]);

    function visit(st, cur, hit) {
      var matched, memo = null;
      if (sticky && hit) {
        matched = true;
      } else {
        memo = st + '|' + cur.join('.');
        if (dead[memo]) return false;
        matched = cur.indexOf(ACC) >= 0;
      }
      var found = false;
      if (g.fin[st] && matched) {
        matches.push(chars.join(''));
        if (matches.length >= PREFIX_CAP) { capped = true; return true; }
        found = true;
      }
      for (var e = g.off[st]; e < g.off[st + 1]; e++) {
        var next;
        if (matched && sticky) {
          next = NONE;
        } else {
          var nxt = self.step(cur, g.lbl.charCodeAt(e));
          if (!nxt.length) {
            if (!base) continue;
            next = init;
          } else {
            next = self.closure(base ? base.concat(nxt) : nxt);
          }
        }
        chars.push(g.lbl.charAt(e));
        if (visit(g.to[e], next, matched)) found = true;
        chars.pop();
        if (capped) return true;
      }
      if (memo && !found) dead[memo] = 1;
      return found;
    }

    visit(g.root, init, false);
    return { terms: matches, capped: capped };
  };

  /** A query between slashes is a pattern, not a list of words. */
  function patternOf(text) {
    var raw = String(text).trim();
    if (raw.length < 2 || raw.charAt(0) !== '/' || raw.charAt(raw.length - 1) !== '/') return null;
    var body = raw.slice(1, raw.length - 1);
    if (!body) return { text: raw, body: body, error: 'nothing is between the slashes' };
    try {
      return { text: raw, body: body, pattern: new Pattern(raw, body) };
    } catch (e) {
      return { text: raw, body: body, error: e.message };
    }
  }

  /* ---------- the shelf: its index, its own list -------------------------- */

  /** Decode the emitted index: the documents, the passages, and the word list
   * held as the automaton plus its posting lists (passage numbers). */
  function makeShelf(raw, stop) {
    if (!raw || !raw.pass) return null;
    var dafsa = raw.words && raw.words.dafsa ? decodeDafsa(raw.words.dafsa) : null;
    var terms = dafsa ? dafsaTerms(dafsa) : [];
    var at = {}, i, p;
    for (i = 0; i < terms.length; i++) at[terms[i]] = i;
    var docs = raw.docs || [], pass = raw.pass || [];
    var postings = (raw.words && raw.words.postings) || [];
    var headOf = new Array(pass.length);
    var strong = [];
    var headTerms = function (s) {
      var out = {}, w = String(s || '').toLowerCase().match(/[a-z][a-z'-]+/g) || [];
      for (var k = 0; k < w.length; k++) if (w[k].length >= 3 && !stop[w[k]]) out[w[k]] = 1;
      return out;
    };
    var docHead = [];
    for (i = 0; i < docs.length; i++) {
      docHead.push(headTerms((docs[i].title || '') + ' ' + (docs[i].author || '') + ' ' + (docs[i].translator || '')));
    }
    var secHead = [];
    for (i = 0; i < docs.length; i++) {
      var byN = {}, h = docs[i].sec || [], k;
      for (k = 0; k < h.length; k++) byN[h[k][0]] = headTerms(h[k][1]);
      secHead.push(byN);
    }
    for (p = 0; p < pass.length; p++) {
      var row = pass[p];
      var d = row[0], sec = row[4];
      var set = {};
      var add = function (o) { if (o) for (var k2 in o) set[k2] = 1; };
      add(docHead[d]);
      if (sec != null && secHead[d]) add(secHead[d][sec]);
      headOf[p] = set;
      for (var t2 in set) {
        var ti = at[t2];
        if (ti === undefined) continue;
        if (!strong[ti]) strong[ti] = [];
        strong[ti].push(p);
      }
    }
    return {
      docs: docs, pass: pass, terms: terms, at: at, dafsa: dafsa, postings: postings,
      n: pass.length, headOf: headOf, strong: strong, stop: stop,
    };
  }

  /** Is this word a HEADING for this passage — in its edition's title, its
   * section's title? The shelf's own title/heading hit. */
  function shelfHead(shelf, p, term) {
    return !!(shelf.headOf[p] && shelf.headOf[p][term]);
  }

  /** The shelf's lexical pass: exact and prefix lookup over its word list, with a
   * section-title hit weighted above a body hit and a passage that OPENS its
   * section weighted above one deep inside it. */
  function shelfLexical(shelf, text, opts, stats, stop) {
    var toks = tokenize(text, stop);
    var score = {}, why = {}, named = {}, hitAt = {}, i, j;
    var T = shelf.terms.length;
    for (i = 0; i < toks.length; i++) {
      var t = toks[i];
      var lo = lowBound(shelf.terms, t), hi = lo;
      while (hi < T && hi - lo < PREFIX_CAP && shelf.terms[hi].indexOf(t) === 0) {
        var term = shelf.terms[hi], post = shelf.postings[hi];
        var exact = term === t;
        var w = shelfIdf(shelf, hi) * (exact ? 1 : 0.55);
        for (j = 0; j < post.length; j++) {
          var p = post[j], row = shelf.pass[p];
          var s = w * (shelfHead(shelf, p, term) ? SHELF_W.head : (row[3] ? SHELF_W.open : SHELF_W.body));
          score[p] = (score[p] || 0) + s;
          if (exact) named[p] = 1;
          if (hitAt[p] === undefined) hitAt[p] = p;
          var r = why[p] || (why[p] = []);
          var label = (exact ? 'term: "' : 'prefix: "') + t + '"';
          if (r.indexOf(label) < 0 && r.length < 6) r.push(label);
        }
        hi++;
      }
    }
    var fz = fuzzyTerms(text, stop);
    if (stats) { stats.words = 0; stats.k = 0; stats.capped = false; stats.ms = 0; stats.off = false; }
    if (fz.length && !shelf.dafsa) {
      if (stats) stats.off = true;
    } else if (fz.length) {
      var t0 = now();
      for (var fi = 0; fi < fz.length; fi++) {
        var fq = fz[fi].q;
        var hit = fuzzyWalk(shelf.dafsa, fq, fz[fi].k, FUZZY_CAP);
        if (hit.capped && stats) stats.capped = true;
        if (stats && fz[fi].k > stats.k) stats.k = fz[fi].k;
        for (var wi = 0; wi < hit.words.length; wi++) {
          var ti = shelf.at[hit.words[wi].w];
          if (ti === undefined) continue;
          if (stats) stats.words++;
          var fd = hit.words[wi].d;
          var fw = shelfIdf(shelf, ti) * (1 - fd / (fq.length + 1));
          var flabel = 'fuzzy: "' + fq + '" → ' + hit.words[wi].w +
            ' (' + fd + (fd === 1 ? ' edit)' : ' edits)');
          var fpost = shelf.postings[ti];
          for (j = 0; j < fpost.length; j++) {
            var fp = fpost[j];
            score[fp] = (score[fp] || 0) + fw * (shelfHead(shelf, fp, hit.words[wi].w) ? SHELF_W.head : SHELF_W.body);
            var fr = why[fp] || (why[fp] = []);
            if (fr.indexOf(flabel) < 0 && fr.length < 6) fr.push(flabel);
          }
        }
      }
      if (stats) stats.ms = Math.round((now() - t0) * 10) / 10;
    }
    var out = [];
    for (var key in score) out.push({ p: +key, score: score[key], why: why[key], named: !!named[key], hitAt: hitAt[key] });
    return out;
  }

  function shelfIdf(shelf, ti) {
    return Math.log(1 + Math.max(1, shelf.n) / Math.max(1, shelf.postings[ti].length));
  }

  /** The phrase, over ONE passage's own words: the recorded words of the run at
   * their offsets, with every word of the passage advancing the count (stopwords
   * included). Returns the character offset of the match, or -1. */
  function phraseInPassage(text, seq) {
    var m = String(text).toLowerCase().match(WORD) || [];
    var at = new Array(m.length), pos = 0, k, i, j;
    var re = /[a-z][a-z'-]+/g, mm;
    while ((mm = re.exec(String(text).toLowerCase()))) at[pos++] = mm.index;
    var anchors = [];
    for (i = 0; i < m.length; i++) if (m[i] === seq[0].w) anchors.push(i);
    for (k = 0; k < anchors.length; k++) {
      var a = anchors[k], ok = true;
      for (j = 1; j < seq.length; j++) {
        if (m[a + seq[j].off - seq[0].off] !== seq[j].w) { ok = false; break; }
      }
      if (ok) return at[a] === undefined ? 0 : at[a];
    }
    return -1;
  }

  /** A pattern's words, scored as the words a plain query names: each an exact
   * term hit, weighted by the idf of the word that matched and boosted where that
   * word stands in a title or a section heading. */
  function patternLexical(shelf, pat, terms) {
    var score = {}, why = {}, label = 're: "' + pat.text + '"';
    var i, j, ti, post, w, st, p;
    for (i = 0; i < terms.length; i++) {
      ti = shelf.at[terms[i]];
      if (ti === undefined) continue;
      post = shelf.postings[ti];
      w = shelfIdf(shelf, ti);
      st = shelf.strong[ti];
      for (j = 0; j < post.length; j++) {
        p = post[j];
        score[p] = (score[p] || 0) + w * (st && st.indexOf(p) > 0 ? 2.6 : 1);
        var r = why[p] || (why[p] = []);
        if (r.indexOf(label) < 0 && r.length < 6) r.push(label);
      }
    }
    var out = [];
    for (var key in score) out.push({ p: +key, score: score[key], why: why[key], named: true });
    return out;
  }

  /** The answer: a list of PASSAGES, capped and counted. */
  function shelfQuery(text, opts) {
    var shelf = S._idx;
    opts = opts || {};
    var counts = {
      results: 0, shown: 0, passages: shelf ? shelf.n : 0, texts: shelf ? shelf.docs.length : 0,
      dropped: 0, terms: 0, pattern: '', matched: 0, reCapped: false, reError: '',
      fuzzy: 0, fuzzyWords: 0, fuzzyK: 0, fuzzyCapped: false, fuzzyOff: false,
      phrases: 0, phraseDocs: 0, phraseMiss: '', ms: 0, off: !shelf, fallbackFrom: '', suggest: null,
    };
    if (shelf && !shelf.docs.length) counts.off = true;
    if (!shelf) return { results: [], counts: counts };
    var t0 = now();
    var pat = patternOf(text);
    var lex, marks = null, i;
    var toks = [], fzs = [], phr = { phrases: [], dropped: [] }, fstats = {};
    var keep = null;
    if (pat) {
      counts.pattern = pat.text;
      if (pat.error) { counts.reError = pat.error; counts.ms = Math.round((now() - t0) * 10) / 10; return { results: [], counts: counts }; }
      var hit = pat.pattern.walk(shelf.dafsa);
      counts.matched = hit.terms.length;
      counts.reCapped = hit.capped;
      lex = patternLexical(shelf, pat, hit.terms);
      marks = {};
      for (i = 0; i < hit.terms.length; i++) marks[hit.terms[i]] = 1;
    } else {
      toks = tokenize(text, shelf.stop);
      fzs = fuzzyTerms(text, shelf.stop);
      phr = phraseTerms(text, shelf.stop);
      counts.terms = toks.length;
      counts.fuzzy = fzs.length;
      counts.phrases = phr.phrases.length;
      if (!toks.length && !fzs.length && !phr.phrases.length) { counts.ms = Math.round((now() - t0) * 10) / 10; return { results: [], counts: counts }; }
      lex = shelfLexical(shelf, text, opts, fstats, shelf.stop);
      counts.fuzzyWords = fstats.words;
      counts.fuzzyK = fstats.k;
      counts.fuzzyCapped = fstats.capped;
      counts.fuzzyOff = fstats.off;
      if (phr.phrases.length) {
        var miss = null, phDocs = [];
        for (var pi = 0; pi < phr.phrases.length; pi++) {
          var seq = phr.phrases[pi].seq, found = {};
          for (var vi = 0; vi < seq.length; vi++) if (shelf.at[seq[vi].w] === undefined) miss = miss || seq[vi].w;
          var first = shelf.at[seq[0].w];
          var cand = first === undefined ? [] : shelf.postings[first];
          for (var ci = 0; ci < cand.length; ci++) {
            var off = phraseInPassage(shelf.pass[cand[ci]][5], seq);
            if (off >= 0) found[cand[ci]] = off;
          }
          phDocs.push(found);
        }
        counts.phraseMiss = miss || '';
        var both = [];
        for (var key in phDocs[0]) {
          var all = true;
          for (var ki = 1; ki < phDocs.length; ki++) if (phDocs[ki][key] === undefined) { all = false; break; }
          if (all) { keep = keep || {}; keep[+key] = phDocs[0][key]; both.push(+key); }
        }
        counts.phraseDocs = both.length;
      }
    }
    var named = {}, m = {}, why = {}, maxL = 0;
    for (i = 0; i < lex.length; i++) {
      if (lex[i].score > maxL) maxL = lex[i].score;
      if (lex[i].named) named[lex[i].p] = 1;
    }
    for (i = 0; i < lex.length; i++) {
      m[lex[i].p] = (m[lex[i].p] || 0) + (maxL ? lex[i].score / maxL : 0);
      why[lex[i].p] = (why[lex[i].p] || []).concat(lex[i].why).slice(0, 6);
    }
    if (keep) {
      var filtered = {};
      for (var kp in m) if (keep[kp] !== undefined) filtered[kp] = m[kp];
      for (var ka in keep) {
        if (m[ka] === undefined) { filtered[ka] = 1; why[ka] = []; }
        var r0 = why[ka] || (why[ka] = []);
        for (var pj = 0; pj < phr.phrases.length; pj++) {
          var lbl = 'phrase: "' + phr.phrases[pj].text + '"';
          if (r0.indexOf(lbl) < 0 && r0.length < 6) r0.push(lbl);
        }
        named[ka] = 1;
      }
      m = filtered;
    }
    var all = [];
    for (var key2 in m) {
      var row = shelf.pass[key2];
      all.push({ p: +key2, doc: row[0], anchor: row[1], page: row[2], sec: row[4], text: row[5],
        score: m[key2], why: why[key2] || [], named: !!named[key2] });
    }
    all.sort(function (a, b) {
      return (b.named ? 1 : 0) - (a.named ? 1 : 0) || b.score - a.score || a.p - b.p;
    });
    counts.results = all.length;
    counts.dropped = Math.max(0, all.length - (opts.limit || RESULT_CAP));
    counts.ms = Math.round((now() - t0) * 10) / 10;
    // the offer of a correction, when the answer is thin and a query word is not
    // in the list — the same walk the `~` syntax uses, never a rewrite
    if (!pat && all.length <= THIN) {
      var toks2 = tokenize(text, shelf.stop);
      if (!counts.fuzzy) {
        var sug = suggestWords(shelf, text, toks2);
        if (sug) counts.suggest = sug;
      }
    }
    var out = all.slice(0, opts.limit || RESULT_CAP);
    counts.shown = out.length;
    return { results: out, counts: counts, marks: marks };
  }

  /* ---------- the page: snippets, rendering, URL state, keyboard ---------- */

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ESC[c]; }); }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'); }

  /** Mark, in already-escaped HTML, every word the query reaches. */
  function markText(html, toks, marks) {
    if (marks) {
      return html.replace(/[a-z][a-z'-]*/g, function (w) {
        return marks[w.toLowerCase()] ? '<mark>' + w + '</mark>' : w;
      });
    }
    if (!toks.length) return html;
    var parts = toks.slice(0).sort(function (a, b) { return b.length - a.length; });
    var re = new RegExp('\\b(?:' + parts.map(escRe).join('|') + ")[a-z'-]*", 'gi');
    return html.replace(re, function (w) { return '<mark>' + w + '</mark>'; });
  }

  var SNIPPET_MAX = 300;

  /** A SHELF result: a CITATION. The link goes INTO the book at the anchor the
   * passage carries (`#s4`, `#p14`, a note), and the line reads as a citation of
   * it: the edition's author and title, the division, and the passage's own words
   * with the query's words marked. */
  function shelfLabel(shelf, r) {
    var a = r.anchor, m;
    if (!a) return 'the opening';
    if ((m = /^s(\d+)(?:-\d+)?$/.exec(a))) return '§' + m[1];
    if ((m = /^n(\d+)$/.exec(a))) return 'note ' + m[1];
    if ((m = /^p(\d+)$/.exec(a))) return 'p. ' + m[1];
    if (a === 'snotes') return 'the notes';
    if (a === 'sfront') return 'the front matter';
    var hm = (shelf.docs[r.doc] || {}).heads || [];
    for (var i = 0; i < hm.length; i++) if (hm[i][0] === a) return hm[i][1];
    return 'the text';
  }

  function shelfSnippet(r, toks, marks) {
    var text = String(r.text || '');
    var find = -1, i, at;
    if (marks) {
      var re = /[a-z][a-z'-]+/g, mm, lo = text.toLowerCase();
      while ((mm = re.exec(lo))) { if (marks[mm[0]]) { find = mm.index; break; } }
    }
    for (i = 0; i < toks.length; i++) {
      at = text.toLowerCase().indexOf(toks[i]);
      if (at >= 0 && (find < 0 || at < find)) find = at;
    }
    if (find < 0) find = 0;
    if (text.length <= SNIPPET_MAX) return markText(esc(text), toks, marks);
    var start = find > 110 ? find - 110 : 0;
    var cut = text.slice(start, start + SNIPPET_MAX - 20);
    if (start) cut = cut.replace(/^\S*\s/, '');
    cut = cut.replace(/\s\S*$/, '');
    return (start ? '…' : '') + markText(esc(cut), toks, marks) + '…';
  }

  function shelfResultHtml(shelf, r, toks, marks) {
    var d = shelf.docs[r.doc] || {};
    var href = '/texts/' + esc(d.slug) + '/' + (r.anchor ? '#' + esc(r.anchor) : '');
    var meta = 'the text';
    if (d.translator) meta += ' · tr. ' + esc(d.translator);
    if (r.page != null) meta += ' · the printed page ' + r.page;
    return '<li class="sr sr-shelf">' +
      '<a class="sr-t" href="' + href + '">' + markText(esc(d.author + ', ' + d.title), toks, marks) +
      ' — ' + esc(shelfLabel(shelf, r)) + '</a>' +
      '<div class="sr-m">' + meta + '<span class="sr-sc">' + r.score.toFixed(2) + '</span></div>' +
      '<p class="sr-s">“' + shelfSnippet(r, toks, marks) + '”</p>' +
      '<ul class="sr-w">' + r.why.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' +
      '</li>';
  }

  function render(shelf, box, status, text, opts) {
    opts = opts || {};
    var res = shelfQuery(text, opts);
    var c = res.counts;
    var toks = c.pattern ? [] : tokenize(text, shelf.stop).concat(phraseWords(text, shelf.stop));
    if (!res.results.length) {
      var msg;
      if (c.reError) msg = 'That pattern is not one this page can read: ' + c.reError + '.';
      else if (c.pattern) msg = c.matched
        ? 'No passage answers to the words that pattern reached.'
        : 'No word in the list answers to that pattern.';
      else if (c.terms || c.phrases) msg = 'Nothing in the published texts answers to that.';
      else if (c.fuzzy) msg = c.fuzzyOff
        ? 'There is no word list in this page to match that against.'
        : 'No word in the list is within ' + c.fuzzyK + (c.fuzzyK === 1 ? ' edit' : ' edits') +
          ' of a word you marked. Two tildes widen it to two.';
      else msg = 'Type a word — the texts are searched by their words, their passages and their printed pages.';
      if (c.phrases && !c.pattern) {
        if (c.phraseMiss) msg = 'No passage says that phrase — the word "' + c.phraseMiss + '" is not one the texts use at all.';
        else if (!c.phraseDocs) msg = 'No passage has those words next to each other, in that order.';
      }
      box.innerHTML = '<li class="sr-none">' + esc(msg) + '</li>';
    } else {
      box.innerHTML = res.results.map(function (r) { return shelfResultHtml(shelf, r, toks, res.marks); }).join('');
    }
    var sug = c.suggest;
    var note = sug
      ? 'did you mean <button type="button" class="sr-go" data-q="' + esc(sug.corrected) + '">' +
        esc(sug.to) + '</button>?' + (sug.capped ? ' (the near words stopped at ' + SUGGEST_CAP + ')' : '')
      : '';
    var head = '';
    if (c.reError) {
      head = '# nothing searched · the pattern ' + esc(c.pattern) + ' is not one this page can read: ' + esc(c.reError);
    } else if (res.results.length) {
      // the query as the line states it: the words that NAME a passage — never a
      // `~word`, because the walk found a word the reader did not type
      var labelText = toks.length
        ? toks.slice(0, 6).join(' ')
        : String(text).replace(/~/g, ' ').replace(/\s+/g, ' ').trim();
      var label = c.pattern ? c.pattern : '"' + esc(labelText) + '"';
      head = '# ' + (c.results > c.shown ? c.shown + ' of ' + c.results : c.results) + ' passage' +
        (c.results === 1 ? '' : 's') + ' · ' + c.ms + ' ms · ' +
        (c.pattern
          ? 'the pattern ' + esc(c.pattern) + ' reached ' + c.matched + ' word' + (c.matched === 1 ? '' : 's') +
            (c.reCapped ? ' (the list stops at ' + PREFIX_CAP + ')' : '') + ' · '
          : '') +
        (c.fuzzy
          ? 'fuzzy: ' + (c.fuzzyOff
              ? 'no word list to match against'
              : c.fuzzyWords + ' word' + (c.fuzzyWords === 1 ? '' : 's') + ' within ' + c.fuzzyK +
                (c.fuzzyK === 1 ? ' edit' : ' edits') +
                (c.fuzzyCapped ? ' (the list stops at ' + FUZZY_CAP + ')' : '')) + ' · '
          : '') +
        (c.phrases
          ? (c.phraseDocs + ' passage' + (c.phraseDocs === 1 ? '' : 's') + ' say the phrase' +
            (c.phrases > 1 ? 's' : '') + (c.phraseMiss ? ' (the word "' + esc(c.phraseMiss) + '" is in no passage)' : '') + ' · ')
          : '') +
        (c.dropped ? c.dropped + ' beyond the cap · ' : '') + label;
    }
    if (head && note) status.innerHTML = head + ' · ' + note;
    else if (head) status.textContent = head;
    else if (note) status.innerHTML = '# nothing was found for that · ' + note;
    else status.textContent = '';
    return res;
  }

  /** `?q=`, so a search is a link someone can send. */
  function readUrl() {
    var q = '', raw = String((window.location && window.location.search) || '').replace(/^\?/, '');
    var parts = raw ? raw.split('&') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('='), val = decodeURIComponent(kv[1] || '');
      if (kv[0] === 'q') q = val;
    }
    return { q: q };
  }
  function writeUrl(st) {
    var q = [];
    if (st.q) q.push('q=' + encodeURIComponent(st.q));
    try {
      window.history.replaceState(null, '', '/search/' + (q.length ? '?' + q.join('&') : ''));
    } catch (e) { /* a browser that refuses history still searches */ }
  }

  function wire() {
    var shelf = S._idx;
    var box = document.getElementById('sres');
    var status = document.getElementById('sstatus');
    var input = document.getElementById('sq');
    if (!shelf || !box || !input) return false;
    var comp = document.getElementById('scomp');
    var compList = document.getElementById('scomp-list');
    var compCap = document.getElementById('scomp-cap');
    var url = readUrl();
    if (url.q) input.value = url.q;
    var sel = -1;
    var compTerms = [];
    var compAt = -1;
    function run(push) {
      render(shelf, box, status, input.value, {});
      sel = -1;
      if (push) writeUrl({ q: input.value });
    }

    function rows() { return box.querySelectorAll('li.sr'); }
    function paintSel() {
      var r = rows(), i;
      for (i = 0; i < r.length; i++) {
        if (i === sel) r[i].classList.add('sr-on');
        else r[i].classList.remove('sr-on');
      }
      if (sel >= 0 && r[sel] && typeof r[sel].scrollIntoView === 'function') {
        try { r[sel].scrollIntoView({ block: 'nearest' }); } catch (e) { }
      }
    }
    function moveSel(d) {
      var r = rows();
      if (!r.length) return false;
      sel = sel < 0 ? (d > 0 ? 0 : r.length - 1) : sel + d;
      if (sel < 0) sel = 0;
      if (sel >= r.length) sel = r.length - 1;
      paintSel();
      return true;
    }
    function openSelected() {
      var r = rows();
      if (sel < 0 || !r[sel]) return false;
      var a = r[sel].querySelector('a.sr-t');
      if (!a) return false;
      window.location.href = a.getAttribute('href');
      return true;
    }

    function wordAt() {
      var v = input.value, pos = input.selectionStart, pre, m;
      if (typeof pos !== 'number' || pos < 0 || pos > v.length) pos = v.length;
      pre = v.slice(0, pos);
      m = pre.match(/[a-z][a-z'-]*$/i);
      if (m) return { word: m[0].toLowerCase(), start: pre.length - m[0].length, end: pos };
      return null;
    }
    function closeComp() {
      compTerms = [];
      compAt = -1;
      if (comp) comp.hidden = true;
      if (compList) compList.innerHTML = '';
      if (compCap) { compCap.hidden = true; compCap.textContent = ''; }
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function paintComp() {
      var lis = compList.children, i, on;
      for (i = 0; i < lis.length; i++) {
        on = i === compAt;
        lis[i].className = on ? 'sc sc-on' : 'sc';
        lis[i].setAttribute('aria-selected', on ? 'true' : 'false');
      }
      if (compAt >= 0) input.setAttribute('aria-activedescendant', 'scomp-' + compAt);
      else input.removeAttribute('aria-activedescendant');
    }
    function openComp(prefix) {
      if (!shelf.dafsa || !comp || !compList || prefix.length < COMPLETE_MIN) { closeComp(); return false; }
      var hit = prefixWalk(shelf.dafsa, prefix, COMPLETE_CAP);
      if (!hit.terms.length) { closeComp(); return false; }
      compTerms = hit.terms;
      compAt = -1;
      compList.innerHTML = hit.terms.map(function (t, k) {
        return '<li class="sc" id="scomp-' + k + '" role="option" aria-selected="false">' + esc(t) + '</li>';
      }).join('');
      if (compCap) {
        compCap.hidden = !hit.capped;
        compCap.textContent = hit.capped ? 'the list stops at ' + COMPLETE_CAP + ' words' : '';
      }
      comp.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      return true;
    }
    function updateComp() {
      var w = wordAt();
      if (!w || w.word.length < COMPLETE_MIN) { closeComp(); return; }
      openComp(w.word);
    }
    function moveComp(d) {
      if (!compTerms.length) return false;
      compAt = compAt < 0 ? (d > 0 ? 0 : compTerms.length - 1) : compAt + d;
      if (compAt < 0) compAt = 0;
      if (compAt >= compTerms.length) compAt = compTerms.length - 1;
      paintComp();
      return true;
    }
    function acceptComp(k) {
      if (k < 0 || compTerms[k] === undefined) return false;
      var w = wordAt();
      if (!w) return false;
      var v = input.value;
      input.value = v.slice(0, w.start) + compTerms[k] + v.slice(w.end);
      closeComp();
      return true;
    }

    run(false);
    var form = document.getElementById('sf');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); closeComp(); run(true); });
    input.addEventListener('input', function () { run(true); updateComp(); });
    input.addEventListener('blur', function () { if (compTerms.length) closeComp(); });
    input.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'Escape') {
        if (compTerms.length) { e.preventDefault(); closeComp(); return; }
        if (sel >= 0) { e.preventDefault(); sel = -1; paintSel(); }
        return;
      }
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        if (compTerms.length) { e.preventDefault(); moveComp(k === 'ArrowDown' ? 1 : -1); return; }
        if (rows().length) { e.preventDefault(); moveSel(k === 'ArrowDown' ? 1 : -1); }
        return;
      }
      if (k === 'Enter') {
        if (compTerms.length && compAt >= 0) { e.preventDefault(); acceptComp(compAt); run(true); return; }
        if (!compTerms.length && sel >= 0 && openSelected()) e.preventDefault();
      }
    });
    box.addEventListener('click', function (e) {
      var el = e.target;
      if (el && el.className === 'sr-go') { input.value = el.getAttribute('data-q'); run(true); }
    });
    status.addEventListener('click', function (e) {
      var el = e.target;
      if (el && el.className === 'sr-go') { input.value = el.getAttribute('data-q'); run(true); }
    });
    if (compList) compList.addEventListener('mousedown', function (e) {
      var li = e.target, lis = compList.children, i;
      for (i = 0; i < lis.length; i++) if (lis[i] === li) { acceptComp(i); run(true); break; }
    });
    if (!url.q) { try { input.focus({ preventScroll: true }); } catch (e) { } }
    return true;
  }

  function boot() {
    var el = document.getElementById('search-data');
    if (!el) return null;
    var meta;
    try { meta = JSON.parse(el.textContent); } catch (e) { return null; }
    var box = document.getElementById('sres');
    // THE INDEX IS FETCHED, not inlined: it is the books' own prose, and a page
    // must not carry a book's text where the site's own vocabulary rules apply
    // (the leak gate reads a page and a data file differently — see build/leak.mjs).
    // One request, same origin, and nothing else: no index server, no API.
    var src = meta && meta.index;
    if (!src) { fail(box, 'the index is missing from this page.'); return null; }
    fetch(src).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (txt) {
      var data = JSON.parse(txt);
      S._idx = makeShelf(data, stopSet(data.stop));
      wire();
    }).catch(function () {
      fail(box, 'the index could not be loaded — reload the page to try again.');
    });
    return true;
  }

  /** The honest floor: the index is one file and this page says so rather than
   * pretending a search that cannot run is an empty one. */
  function fail(box, msg) {
    if (box) box.innerHTML = '<li class="sr-none">' + esc(msg) + '</li>';
    var input = document.getElementById('sq');
    if (input) input.disabled = true;
  }

  /** The stopword set the index was built with, rebuilt from the page's own
   * data (one list; the query is tokenised by the rule the index was built by). */
  function stopSet(s) {
    var m = {}, ws = String(s || '').split(' '), i;
    for (i = 0; i < ws.length; i++) if (ws[i]) m[ws[i]] = 1;
    return m;
  }

  var S = {
    tokenize: tokenize,
    _idx: null,
    init: function (data) { S._idx = makeShelf(data, stopSet(data.stop)); return S._idx; },
    providers: {
      shelf: function (q, opts) { return shelfQuery(q, opts || {}); },
    },
    matchPattern: function (body) {
      if (!S._idx) return { terms: [], capped: false };
      try {
        return new Pattern('/' + body + '/', body).walk(S._idx.dafsa);
      } catch (e) {
        return { terms: [], capped: false, error: e.message };
      }
    },
    matchFuzzy: function (word, k) {
      if (!S._idx || !S._idx.dafsa) return { words: [], capped: false };
      return fuzzyWalk(S._idx.dafsa, String(word).toLowerCase(), k === undefined ? 1 : k, FUZZY_CAP);
    },
    matchPrefix: function (prefix, cap) {
      if (!S._idx || !S._idx.dafsa) return { terms: [], capped: false };
      return prefixWalk(S._idx.dafsa, String(prefix).toLowerCase(), cap === undefined ? COMPLETE_CAP : cap);
    },
    queryShelf: function (text, opts) { return shelfQuery(text, opts); },
    shelf: function () { return S._idx; },
    render: function (box, status, text, opts) { return render(S._idx, box, status, text, opts || {}); },
    readUrl: readUrl,
    writeUrl: writeUrl,
    wire: wire,
    boot: boot,
  };
  if (typeof window !== 'undefined') window.Search = S;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
