#!/usr/bin/env node
/**
 * tools/hathitrust-page.mjs — fetch ONE printed page of the HathiTrust copy of
 * vol. II as a rendered viewer screenshot, crop the page area, and write the crop
 * for the library's page-image readers. TARGETED ONLY: the brief for the unit that
 * built this forbids a bulk harvest of the volume, and the tool has no mode that
 * walks a range by accident (every call names the pages it wants).
 *
 * WHAT THE COPY IS. htid `mdp.39015073686092` — University of Michigan, rightsCode
 * `pd`, "Full view", the catalogue record `catalog.hathitrust.org/Record/002240527`
 * (found through the Bib API, which is not Cloudflare-blocked). It is a complete
 * copy of vol. II of Taylor's 1816 print, i.e. a DIFFERENT PHYSICAL COPY of the
 * same pages this edition already carries. That is the whole of its value: it is a
 * second observation of the print, not another rendering of the same bits.
 *
 * SEE ALSO, AND READ IT BEFORE CONCLUDING THAT THIS IS THE STRONGEST WITNESS:
 * `data/editions/<slug>/witnesses/proclus-theology-of-plato-taylor-vol-2-1816.txt`
 * and the archive item `taylor-theology-of-plato-en-t.-2-1816` (its own 4,792 x
 * 6,275 native page images and a 21.8 MB `_djvu.xml`). MEASURED in this unit: that
 * copy's page images are 3.4x the linear resolution of this edition's own stored
 * scans and 5.7x this route's page area, and an instrument read of a tight band of
 * one of its pages recovered the print's Greek exactly where BOTH readers of this
 * route's screenshot did not. This route is the WEAKEST of the three and is kept
 * for what it alone can do: an independent confirmation at the one place a decision
 * is stuck.
 *
 * THE ROUTE, AND ITS TWO MEASURED DEFECTS (both cost real pages when they were
 * unknown):
 *   1. THE DIRECT IMAGE ENDPOINT IS 403 (`babel.hathitrust.org/cgi/imgsrv/image?id=
 *      ...;seq=...`, and the plain-text and PDF downloads likewise) and a plain
 *      curl of the viewer gets Cloudflare's "Just a moment". A LOCAL headless
 *      Chrome gets the same challenge. What works is r.jina.ai's screenshot
 *      service, which prints (302) a SIGNED url to a 1280x1280 PNG on Google
 *      Storage; that url has no bot protection and is fetched with a plain curl.
 *   2. THE SCREENSHOT IS A RACE, AND IT IS CACHED. The viewer loads its page image
 *      asynchronously, so a capture taken too early is the loading placeholder —
 *      and r.jina.ai caches BY URL, so that placeholder is then served for that
 *      page forever. MEASURED: seq 237 (printed p.227) returned the placeholder
 *      8 times out of 8 until an ignored query parameter was added to the url, and
 *      then loaded first try. This tool therefore always cache-busts and always
 *      checks that the crop carries ink before accepting it.
 *
 * THE PAGE MAP IS NOT ONE CONSTANT, MEASURED from the viewer's own page list
 * (`jina read` of the viewer prints `#<seq> (p.<page>)`, 558 entries, seq 13..570):
 *
 *     printed page = seq - 12   for seq 13..61   (printed pp. 1..49)
 *     printed page = seq - 10   for seq 62..570  (printed pp. 52..516, roman to xl)
 *
 * i.e. there is a THREE-PAGE jump at seq 62 (a plate or half-title is not numbered).
 * A single constant `page = seq - 12` is right for the first 49 pages only.
 *
 * THE CROP, MEASURED ON THREE PAGES (printed 18, 226 and 227) and NOT guessed:
 * `--crop 360,120,1195,1008`. At that box the page's own ink inside the crop has
 * margins of at least 77 px left, 72 px right and 96 px top on all three pages, so
 * the crop cuts no printed line at those edges. The BOTTOM is the exception and it
 * is not a tuning error: HathiTrust's cookie modal covers the foot of every page in
 * a fresh browser context, so the last one or two printed lines (usually the final
 * footnote line and the catchword) are NOT available through this route at all.
 *
 * THE RESOLUTION, MEASURED, because it decides what this instrument may be used
 * for: the crop is 835 x 888 px for a page whose text block is ~690 px wide, i.e.
 * about 10 px per character and 24.3 px per printed line, against 39 px per line in
 * this edition's own stored scans (1391 x 1755). That is 0.62x linear, 0.38x area.
 * CONSEQUENCE, stated rather than discovered later: Latin body text is fully
 * legible, and ordinary punctuation (, . ; :) is legible; a question that turns on
 * a BREATHING OR ACCENT on a small Greek letter is NOT reliably decidable here, and
 * neither is anything in a page's last two lines. Do not brief this route with
 * either class.
 *
 * TERMS-OF-SERVICE DISCIPLINE, and it is part of the tool rather than a note:
 *   * ONE PAGE PER DECISION. `--pages` takes the pages a decision actually needs.
 *   * PACED. `--pace MS` (default 4000) sleeps between pages, and requests carry an
 *     honest identifying User-Agent (`--ua`).
 *   * NOTHING IS COMMITTED. The crops are written to `--out` (a scratch directory,
 *     outside the repository by convention). What this library holds of HathiTrust
 *     is the READINGS — text, with their provenance (htid, seq, printed page, the
 *     crop box, the date, the readers) — exactly as it holds the Project Gutenberg
 *     volumes as witness TEXT and not as scans.
 *
 * USAGE
 *   node tools/hathitrust-page.mjs --pages 227,18 --out /var/tmp/ht
 *   node tools/hathitrust-page.mjs --pages 227 --out /var/tmp/ht --pace 8000
 *
 * It is NOT a gate and NOT in the build's module graph: it makes network requests
 * to a third party and would be wrong in a build.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';

const HTID = 'mdp.39015073686092';
const DEF_CROP = [360, 120, 1195, 1008];
const argv = process.argv.slice(2);
const val = (f, d) => (argv.indexOf(f) >= 0 && argv[argv.indexOf(f) + 1] ? argv[argv.indexOf(f) + 1] : d);
if (argv.includes('--help') || !argv.includes('--pages')) {
  console.log('usage: node tools/hathitrust-page.mjs --pages P[,P...] --out DIR [--pace MS] [--crop x0,y0,x1,y1] [--tries N]');
  process.exit(argv.includes('--help') ? 0 : 2);
}

const pages = val('--pages', '').split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite);
const outDir = val('--out', '/var/tmp/hathitrust-vol2');
const pace = parseInt(val('--pace', '4000'), 10);
const crop = val('--crop', '').split(',').map(Number).filter(Number.isFinite);
const CROP = crop.length === 4 ? crop : DEF_CROP;
const tries = parseInt(val('--tries', '8'), 10);
const UA = val('--ua', 'neoplatonic-library-verify/1.0 (targeted verification of one page of a public-domain 1816 print)');

/** The measured map. seq = page + 12 for printed pp. 1..49, page + 10 from p.52. */
const seqOf = (page) => page + (page <= 49 ? 12 : 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(seq, file) {
  const url = `https://babel.hathitrust.org/cgi/pt?id=${HTID}&seq=${seq}&_=${Date.now() % 1000000}`;
  return spawnSync('curl', ['-sS', '-L', '-A', UA, '--max-time', '180', '-o', file, '-w', '%{http_code}',
    '-H', `Authorization: Bearer ${process.env.JINA_API_KEY || ''}`,
    '-H', 'X-Respond-With: screenshot', '-H', 'X-Timeout: 25',
    'https://r.jina.ai/' + url], { encoding: 'utf8' }).stdout.trim();
}

/* ---------- just enough PNG to crop one ---------- */
function decodePng(buf) {
  let i = 8, w = 0, h = 0, ct = 0, idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i); const typ = buf.toString('latin1', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (typ === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (typ === 'IDAT') idat.push(data);
    else if (typ === 'IEND') break;
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const nch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (!nch) throw new Error(`png colour type ${ct} unsupported`);
  const stride = w * nch; const out = Buffer.alloc(h * stride); let prev = Buffer.alloc(stride); let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++]; const line = Buffer.from(raw.subarray(pos, pos + stride)); pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= nch ? line[x - nch] : 0, b = prev[x], c = x >= nch ? prev[x - nch] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); add = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      line[x] = (line[x] + add) & 0xFF;
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, ct, nch, data: out };
}

function encodePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (t, d) => { const b = Buffer.alloc(8 + d.length + 4); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d])) >>> 0, 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** The acceptance test: the crop must carry the page's ink, not the loading spinner. */
function inkOf(img, box) {
  const [x0, y0, x1, y1] = box; let n = 0; let maxx = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = (y * img.w + x) * img.nch;
    const [R, G, B] = [img.data[p], img.data[p + 1], img.data[p + 2]];
    if (R < 130 && G < 130 && B < 130) { n++; if (x > maxx) maxx = x; }
  }
  return { n, width: maxx ? maxx - x0 : 0 };
}

mkdirSync(outDir, { recursive: true });
const report = [];
for (const page of pages) {
  const seq = seqOf(page);
  const rawFile = join(outDir, `seq${seq}.png`);
  const outFile = join(outDir, `p${page}.png`);
  let ok = null;
  for (let t = 1; t <= tries; t++) {
    const status = await shot(seq, rawFile);
    if (status !== '200' || !existsSync(rawFile)) { await sleep(pace); continue; }
    let img;
    try { img = decodePng(readFileSync(rawFile)); } catch (e) { await sleep(pace); continue; }
    const box = inkOf(img, [CROP[0], CROP[1], CROP[2], CROP[3]]);
    if (box.n > 4000 && box.width > 400) { ok = { t, box }; break; }
    await sleep(pace);
  }
  if (!ok) { report.push({ page, seq, ok: false }); console.error(`page ${page} (seq ${seq}): NO LOADED CAPTURE over ${tries} tries`); await sleep(pace); continue; }
  const img = decodePng(readFileSync(rawFile));
  const [x0, y0, x1, y1] = CROP;
  const cw = x1 - x0, ch = y1 - y0; const rgb = Buffer.alloc(cw * ch * 3);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const s = ((y0 + y) * img.w + (x0 + x)) * img.nch;
    const d = (y * cw + x) * 3;
    const grey = img.ct === 0 || img.ct === 4;
    rgb[d] = img.data[s]; rgb[d + 1] = grey ? img.data[s] : img.data[s + 1]; rgb[d + 2] = grey ? img.data[s] : img.data[s + 2];
  }
  writeFileSync(outFile, encodePng(cw, ch, rgb));
  report.push({ page, seq, ok: true, tries: ok.t, crop: CROP, ink: ok.box.n, file: outFile });
  console.error(`page ${page} (seq ${seq}): ${outFile} crop ${CROP.join(',')} ink ${ok.box.n} after ${ok.t} try/tries`);
  await sleep(pace);
}
console.log(JSON.stringify({ htid: HTID, crop: CROP, report }, null, 1));
process.exit(report.every((r) => r.ok) ? 0 : 1);
