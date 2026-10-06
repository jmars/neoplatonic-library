#!/usr/bin/env node
/**
 * scan.mjs — the 1917 SCAN, made a first-class witness.
 *
 * WHY THIS EXISTS. The library's transcription (`source.txt`) and the `_djvu.xml`
 * it came from are the SAME scan read twice: MEASURED, the djvu text layer and
 * source.txt agree word for word at 11450 of 11563 positions — so the djvu layer
 * can settle nothing the transcription already says. The 1823 parallel is a
 * DIFFERENT PRINTING and legitimately differs. The only witness that can decide
 * a question about THIS print is the PAGE IMAGE, and archive.org serves it:
 *
 *     https://archive.org/download/<item>/page/n<N>_w1200.jpg
 *
 * This tool fetches those images INTO THE LIBRARY (`data/editions/<slug>/scans/`)
 * so a decision made by reading a page can be re-checked later without a network
 * round trip, and reads one through the local vision model.
 *
 *   node tools/scan.mjs fetch <slug> --pages 12,25,54     # printed page numbers
 *   node tools/scan.mjs fetch <slug> --leaves 16,31,60    # leaf numbers
 *   node tools/scan.mjs list  <slug>
 *   node tools/scan.mjs read  <slug> --page 41 "What does the print read where the transcription has 'Qypnf'?"
 *
 * The archive index is `n = leaf - 1` (MEASURED against the page model: leaf 13
 * is printed page 7 and is served at n12). `read` sends the PERSISTED image, so a
 * question is answered from the same bytes that are on disk.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/* THE REPO ROOT: copied from the blog, where this tool lived at
 * `<repo>/tools/library/scan.mjs` and two levels up was the root. */
const ROOT = join(HERE, '..');
const VISION = process.env.SCAN_VISION_ENDPOINT || 'http://10.0.0.1:8321/v1/chat/completions';
const VISION_MODEL = process.env.SCAN_VISION_MODEL || 'deepseek-v4-flash-vision-exp';
const DEFAULT_SLUG = 'porphyry-on-the-cave-of-the-nymphs-taylor-1917';

const DEREV = (slug) => join(ROOT, 'data', 'editions', slug, 'derivs.json');
const SCANS = (slug) => join(ROOT, 'data', 'editions', slug, 'scans');

function model(slug) {
  const f = DEREV(slug);
  if (!existsSync(f)) throw new Error(`scan: no derived page model for ${slug} (${f}) — the scan is mapped through it`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

/** A text whose scan is named directly, without a leaf model. Some editions have
 * no derivable leaf model (the item carries no page-number file) but the page
 * images are there and the OFFSET is measurable: the leaf whose running head
 * reads a known printed page gives `archive n = printed page + offset`. The Cave
 * is served through its derived model; this is the other route, recorded beside
 * the edition so a read can find the page. */
function scanConfig(slug) {
  const f = join(ROOT, 'data', 'editions', slug, 'scan.json');
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8'));
}

/** printed page -> its leaf in the derived page model (the model is the map). */
function leafOfPage(m, page) {
  const hit = m.leaves.find((l) => l.page === page);
  if (!hit) throw new Error(`scan: printed page ${page} is not in the page model (leaves carry pages ${m.leaves.filter((l) => l.page).map((l) => l.page).join(',')})`);
  return hit.leaf;
}
/** leaf -> archive page index. MEASURED n = leaf - 1 (leaf 13 = printed p7 = n12). */
const archiveIndex = (leaf) => leaf - 1;
/* THE STORED NAME CARRIES THE VOLUME'S PREFIX where the edition's scan comes from
 * one item entered twice (`v1-n76.jpg`); an edition cut from one volume stores
 * `n<N>.jpg`. Both tools that touch a leaf build the name here, so a read and a
 * fetch can never look for different files. */
const scanPath = (slug, n, prefix = '') => join(SCANS(slug), `${prefix ? `${prefix}-` : ''}n${n}.jpg`);

function url(item, n) {
  return `https://archive.org/download/${item}/page/n${n}_w1200.jpg`;
}

async function fetchPages(slug, item, ns, prefix = '') {
  mkdirSync(SCANS(slug), { recursive: true });
  for (const n of ns) {
    const p = scanPath(slug, n, prefix);
    if (existsSync(p) && statSync(p).size > 1000) {
      console.log(`  n${n}: already saved (${statSync(p).size} bytes)`);
      continue;
    }
    const u = url(item, n);
    const res = await fetch(u);
    if (!res.ok) throw new Error(`scan: ${u} -> HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error(`scan: ${u} returned ${buf.length} bytes (not an image)`);
    writeFileSync(p, buf);
    console.log(`  n${n}: saved ${buf.length} bytes -> ${p.slice(ROOT.length + 1)}`);
  }
}

async function readImage(slug, n, question, prefix = '') {
  const p = scanPath(slug, n, prefix);
  if (!existsSync(p)) throw new Error(`scan: ${p} is not saved — fetch it first`);
  const b64 = readFileSync(p).toString('base64');
  const body = {
    model: VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
        ],
      },
    ],
    max_tokens: Number(process.env.SCAN_MAX_TOKENS || 3000),
  };
  const res = await fetch(VISION, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  const ch = j.choices?.[0];
  return { finish: ch?.finish_reason, text: ch?.message?.content || '' };
}

const argv = process.argv.slice(2);
const cmd = argv[0];
// the slug is a positional that names a text on the shelf (never a flag value or
// a question string); anything else falls back to the one published text.
const { TEXTS } = await import('./shelf.mjs');
const slug = argv.find((a) => TEXTS.some((t) => t.slug === a)) || DEFAULT_SLUG;
const nums = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  return argv[i + 1].split(',').map((s) => Number(s.trim()));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  /* EITHER ROUTE. The derived leaf model (the Cave) maps printed page <-> leaf and
   * knows the item; a `scan.json` beside an edition whose item has no derivable
   * leaf model names the item and the MEASURED offset (archive n = printed + offset).
   * Both expose the same two questions: which archive page is this printed page,
   * and what printed page is this archive page. */
  const cfg = scanConfig(slug);
  const m = !cfg && existsSync(DEREV(slug)) ? model(slug) : null;
  if (!cfg && !m) throw new Error(`scan: ${slug} has neither a derived page model nor a scan.json`);
  /* THE VOLUMES. `scan.json` names ONE item with one measured offset, or an
   * `items[]` list -- one entry per VOLUME of the print, each with its own run of
   * leaves and its own offset. Taylor's 1816 Theology of Plato is ONE scanned item
   * entered twice, because the work's pages restart at 1 in vol. II: a printed
   * page number alone does not name a leaf, so a page the volumes both print is
   * disambiguated with `--vol` and NEVER guessed. */
  const vols = cfg
    ? (Array.isArray(cfg.items) && cfg.items.length
        ? cfg.items.map((it) => ({
            prefix: it.prefix || '',
            item: it.archive_id || it.item,
            offset: it.archiveOffset,
            lo: it.leaves ? it.leaves[0] : (it.firstPage ?? cfg.firstPage) + it.archiveOffset,
            hi: it.leaves ? it.leaves[1] : (it.lastPage ?? cfg.lastPage) + it.archiveOffset,
          }))
        : [{ prefix: '', item: cfg.item, offset: cfg.archiveOffset, lo: cfg.firstPage + cfg.archiveOffset, hi: cfg.lastPage + cfg.archiveOffset }])
    : null;
  const volNamed = (name) => {
    if (!name) return null;
    const v = vols.find((x) => x.prefix === name || x.prefix === `${name}-` || x.item === name);
    if (!v) throw new Error(`scan: ${slug} has no volume "${name}" (${vols.map((x) => x.prefix || x.item).join(', ')})`);
    return v;
  };
  /** The volume a printed page or an archive leaf belongs to. A page printed in
   * more than one volume (or a leaf number held by more than one run) must be
   * named; nothing is fitted. */
  const volOf = (value, which) => {
    const named = volNamed(volArg());
    if (named) return named;
    const hits = vols.filter((v) => (which === 'page' ? value + v.offset >= v.lo && value + v.offset <= v.hi : value >= v.lo && value <= v.hi));
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) {
      throw new Error(`scan: ${which} ${value} is outside this work in every volume (${vols.map((v) => `${v.prefix || v.item}: ${which === 'page' ? `pages ${v.lo - v.offset}-${v.hi - v.offset}` : `leaves ${v.lo}-${v.hi}`}`).join('; ')})`);
    }
    throw new Error(`scan: ${which} ${value} stands in ${hits.length} volumes (${hits.map((v) => v.prefix || v.item).join(', ')}) — name one with --vol`);
  };
  const volArg = () => (argv.includes('--vol') ? argv[argv.indexOf('--vol') + 1] : null);
  const item = cfg ? (vols.length === 1 ? vols[0].item : cfg.item) : m.item;
  const pageToN = cfg ? (pg) => pg + volOf(pg, 'page').offset : (pg) => archiveIndex(leafOfPage(m, pg));
  const nToPage = cfg
    ? (n) => (vols ? n - volOf(n, 'leaf').offset : null)
    : (n) => m.leaves.find((l) => l.leaf === n + 1)?.page ?? null;
  if (cmd === 'list') {
    if (!existsSync(SCANS(slug))) { console.log('scan: nothing saved yet'); process.exit(0); }
    /* A STORED LEAF'S NAME IS `<volume prefix>-n<N>.jpg` where the edition's
     * volumes carry a prefix, and `n<N>.jpg` where it has one volume. The name
     * must be parsed, not sliced: `f.slice(1, -4)` reads `v1-n76.jpg` as the
     * number `1-n76` — MEASURED, which is NaN and made every leaf look as if it
     * stood outside the work. */
    const leafOf = (f) => {
      const m = /^(?:([a-z]\d+)-)?n(\d+)\.jpg$/i.exec(f);
      return m ? { prefix: m[1] || '', n: Number(m[2]) } : null;
    };
    const files = readdirSync(SCANS(slug))
      .filter((f) => leafOf(f))
      .sort((a, b) => {
        const A = leafOf(a);
        const B = leafOf(b);
        return A.prefix === B.prefix ? A.n - B.n : A.prefix < B.prefix ? -1 : 1;
      });
    console.log(`${files.length} scan page(s) saved for ${slug}:`);
    for (const f of files) {
      const { prefix, n } = leafOf(f);
      const pg = cfg ? n - volOf(n, 'leaf').offset : nToPage(n);
      const where = cfg ? `${prefix ? `${prefix} printed page` : 'printed page'} ${pg ?? '?'}` : `leaf ${n + 1} = printed page ${pg ?? '?'}`;
      console.log(`  ${f}  (archive n${n} = ${where}, ${statSync(join(SCANS(slug), f)).size} bytes)`);
    }
  } else if (cmd === 'fetch') {
    const pages = nums('--pages');
    const leaves = nums('--leaves');
    const ns = [];
    if (pages) {
      for (const p of pages) ns.push(cfg ? pageToN(p) : archiveIndex(leafOfPage(m, p)));
    }
    if (leaves) { if (cfg) throw new Error('scan: this text is addressed by printed page, not leaf'); for (const l of leaves) ns.push(archiveIndex(l)); }
    if (!ns.length) { console.error('scan: give --pages <printed,...> or --leaves <leaf,...>'); process.exit(2); }
    /* WHICH VOLUME EACH NAMED LEAF GOES TO: the ranges are the record's, and a
     * leaf no run holds is reported rather than guessed. */
    if (cfg && vols.length > 1) {
      const byPrefix = new Map();
      for (const n of ns) {
        const v = volOf(n, 'leaf');
        if (!byPrefix.has(v.prefix)) byPrefix.set(v.prefix, { item: v.item, ns: [] });
        byPrefix.get(v.prefix).ns.push(n);
      }
      for (const [prefix, group] of byPrefix) await fetchPages(slug, group.item, group.ns, prefix);
    } else {
      await fetchPages(slug, item, ns, cfg ? vols[0].prefix : '');
    }
  } else if (cmd === 'read') {
    const pi = argv.indexOf('--page');
    const li = argv.indexOf('--leaf');
    if (pi < 0 && li < 0) { console.error('scan: give --page <printed> or --leaf <leaf>'); process.exit(2); }
    if (li >= 0 && cfg) throw new Error('scan: this text is addressed by printed page, not leaf');
    const n = pi >= 0 ? pageToN(Number(argv[pi + 1])) : archiveIndex(Number(argv[li + 1]));
    const question = argv.filter((a, i) => !a.startsWith('--') && i > 0 && argv[i - 1] !== '--page' && argv[i - 1] !== '--leaf' && a !== slug).join(' ') ||
      'Transcribe the printed text of this page exactly.';
    const prefix = cfg ? volOf(pi >= 0 ? Number(argv[pi + 1]) : n, pi >= 0 ? 'page' : 'leaf').prefix : '';
    const r = await readImage(slug, n, question, prefix);
    console.log(`# ${slug} page n${n} (finish=${r.finish})\n${r.text}`);
  } else {
    console.log('usage: scan.mjs fetch <slug> --pages 12,25 | fetch <slug> --leaves 16,31 | list <slug> | read <slug> --page 41 "<question>"');
  }
}
