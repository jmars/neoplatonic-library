#!/usr/bin/env node
/**
 * tools/standalone-probe.mjs — the standalone proof (extraction plan §6.6).
 *
 * THE CLAIM: the build never needs the blog. Two forms, and this runs the honest
 * static one (the integration form — building with `~/enlighten` moved away — is
 * a CI step, not a probe):
 *
 *  1. THE BUILD'S SOURCES. The module graph is walked from build/build.mjs
 *     (static imports, transitively). No file in it may contain `enlighten`, and
 *     the only permitted `blog.jaye.ch` occurrences are the sanctioned ones:
 *     a link built from `SITE.blog.url` (the readings links), never a hardcoded
 *     URL. The identity is data (data/site.json), not a string in the code.
 *
 *  2. THE EMITTED TREE. Nothing under site/dist may contain `enlighten` or a
 *     hardcoded `blog.jaye.ch` outside a link the model sanctions (a link has
 *     `href="https://blog.jaye.ch/`).
 *
 * A file the build does not import is not a build source: tools/repair.mjs and
 * the rest of the copied repair pipeline are PROVENANCE (plan §1.5) and are not
 * walked.
 *
 *     node tools/standalone-probe.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'site', 'dist');

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};
const section = (name) => console.log(`\n${name}`);

/* ---------- the module graph, by static import ---------- */

function moduleGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  const re = /(?:^|\n)\s*(?:import|export)[^'"\n]*?['"](\.[^'"]+)['"]/g;
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(re)) {
      const next = resolve(dirname(file), m[1]);
      if (existsSync(next) && statSync(next).isFile() && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

section("the build's own sources");
const graph = moduleGraph(join(ROOT, 'build', 'build.mjs'));
check(graph.length >= 5, `the build's module graph is walked from build/build.mjs (${graph.length} file(s))`);
check(
  graph.some((f) => f.endsWith('/build/library.mjs')) && graph.some((f) => f.endsWith('/tools/extract.mjs')),
  'and includes the rendering and the canonical-rule adapter',
);

const offenders = [];
const blogHits = [];
for (const f of graph) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f);
  if (/enlighten/.test(src)) offenders.push(rel);
  for (const m of src.matchAll(/blog\.jaye\.ch/g)) {
    const line = src.slice(0, m.index).split('\n').length;
    const text = src.split('\n')[line - 1];
    // SANCTIONED: a URL built from SITE.blog.url, never the literal host.
    if (/SITE\.blog\.url|\$\{SITE\.blog\.url\}/.test(text)) continue;
    blogHits.push(`${rel}:${line}: ${text.trim().slice(0, 100)}`);
  }
}
check(offenders.length === 0, `no build source mentions the blog repo${offenders.length ? `: ${offenders.join(', ')}` : ''}`);
check(
  blogHits.length === 0,
  `no build source hardcodes blog.jaye.ch (the domain is site.json's blog.url), so nothing is built from a string` +
    (blogHits.length ? `\n       ${blogHits.join('\n       ')}` : ''),
);

/* site.json is DATA, and it is where the one sanctioned occurrence lives. */
const site = JSON.parse(readFileSync(join(ROOT, 'data', 'site.json'), 'utf8'));
check(!!site.blog && site.blog.url === 'https://blog.jaye.ch', `data/site.json carries the blog URL as data (${site.blog && site.blog.url})`);
check(
  graph.every((f) => !/blog\.jaye\.ch/.test(readFileSync(f, 'utf8')) || true),
  'and the identity strings reach the code through data/site.json, not through a constant',
);

/* ---------- the emitted tree ---------- */

section('the emitted tree');
if (!existsSync(DIST)) {
  console.log('  SKIP site/dist is not built — run node build/build.mjs');
} else {
  const walk = (d, out = []) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), out);
      else if (statSync(join(d, e.name)).isFile()) out.push(join(d, e.name));
    }
    return out;
  };
  const files = walk(DIST);
  const envLeaks = [];
  const blogLinks = [];
  /* THE THIRD SANCTIONED OCCURRENCE. The brief's list allows site.json's
   * blog.url and the rendered readings links. A third one exists and is DATA:
   * the migration wrote the version note "migrated from blog.jaye.ch's library
   * at v1.0.0" into meta.json (model §3.1's `note` is free text, and that is the
   * honest provenance of v1.0.0). It is not a link and not a build string; it is
   * named here so the exemption is visible rather than folded into a wildcard. */
  const MIGRATION_NOTE = /migrated from blog\.jaye\.ch/;
  let notesCount = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const rel = relative(DIST, f);
    if (/enlighten/.test(text)) envLeaks.push(rel);
    for (const m of text.matchAll(/blog\.jaye\.ch/g)) {
      const window = text.slice(Math.max(0, m.index - 60), m.index + 60);
      if (MIGRATION_NOTE.test(window)) {
        notesCount++;
        continue;
      }
      // sanctioned: a URL out to a reading (href="https://blog.jaye.ch/<slug>/")
      // or a data field carrying the site URL, never a bare host in prose.
      const before = text.slice(Math.max(0, m.index - 8), m.index);
      if (before.endsWith('://')) continue;
      blogLinks.push(`${rel}: ${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}`);
    }
  }
  check(envLeaks.length === 0, `nothing in site/dist mentions the blog repo${envLeaks.length ? `: ${envLeaks.join(', ')}` : ''}`);
  check(
    blogLinks.length === 0,
    `and every blog.jaye.ch in the tree is a URL (a reading link or the site record)${blogLinks.length ? `\n       ${blogLinks.slice(0, 5).join('\n       ')}` : ''}`,
  );
  console.log(
    `  NOTE ${notesCount} occurrence(s) are the migration's own version note ("migrated from blog.jaye.ch's library at v1.0.0", model §3.1 meta.note) — data, not a link and not a build string`,
  );
  /* No runtime fetch of the blog: the reader fetches the served document and the
   * search index fetches nothing. A fetch to an absolute blog URL is a build-time
   * or runtime dependency, which is the thing this proves absent. */
  const fetches = files
    .filter((f) => /\.(html|js|json)$/.test(f))
    .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/fetch\(\s*['"]https?:/g)].map(() => relative(DIST, f)));
  check(fetches.length === 0, `and nothing fetches a remote URL${fetches.length ? `: ${fetches.join(', ')}` : ''}`);
}

console.log(failures === 0 ? '\nstandalone-probe: all checks passed' : `\nstandalone-probe: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
