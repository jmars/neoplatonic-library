#!/usr/bin/env node
/**
 * tools/exports-probe.mjs — the exports (extraction plan §6.3, model §8).
 *
 * WHAT IT ASSERTS:
 *
 *  1. `/data/corpus.json` parses, carries both published editions, and each
 *     edition's version list is the versions/ directory the repo holds (with the
 *     version each `meta.json` describes);
 *  2. `/data/graph.json` is a BYTE COPY of `data/graph/graph.json` (the export is
 *     the data, not a rendering of it);
 *  3. the graph's node ids and edge ids are unique, every edge's endpoints
 *     RESOLVE to declared nodes (referential integrity), and every `edition:`
 *     node names a slug the corpus carries (published or representable);
 *  4. no node or edge carries a TODO marker (plan §7 risk 6): a seeded graph that
 *     still says TODO must fail rather than ship looking finished.
 *
 *     node build/build.mjs && node tools/exports-probe.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIBRARY_DIR } from '../tools/extract.mjs';
import { TEXTS, isPublished } from '../tools/shelf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'site', 'dist');

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};
const section = (name) => console.log(`\n${name}`);

if (!existsSync(join(DIST, 'data'))) {
  console.error('exports-probe: site/dist/data is not built — run node build/build.mjs first');
  process.exit(1);
}

section('the corpus export');
const corpus = JSON.parse(readFileSync(join(DIST, 'data', 'corpus.json'), 'utf8'));
const served = TEXTS.filter(isPublished);
check(Array.isArray(corpus.editions), `corpus.json parses and carries an editions list (${corpus.editions.length})`);
check(!!corpus.site && corpus.site.host, `and the site identity it belongs to (${corpus.site && corpus.site.host})`);
const corpusSlugs = new Set(corpus.editions.map((e) => e.slug));
for (const t of served) {
  check(corpusSlugs.has(t.slug), `corpus.json carries ${t.slug}`);
  const e = corpus.editions.find((x) => x.slug === t.slug);
  const onDisk = readdirSync(join(LIBRARY_DIR, t.slug, 'versions'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const inCorpus = (e.versions || []).map((v) => v.version).sort();
  check(
    JSON.stringify(inCorpus) === JSON.stringify(onDisk),
    `${t.slug}: the corpus version list is the versions/ tree (${inCorpus.join(', ')})`,
  );
  check(
    e.current_version === JSON.parse(readFileSync(join(LIBRARY_DIR, t.slug, 'edition.json'), 'utf8')).current_version,
    `${t.slug}: and names the same current_version as edition.json (${e.current_version})`,
  );
  check(
    (e.versions || []).every((v) => !!v.source_sha256),
    `${t.slug}: every version in the corpus carries its source sha256`,
  );
}
const heldBackInCorpus = TEXTS.filter((t) => !isPublished(t)).filter((t) => corpusSlugs.has(t.slug));
check(heldBackInCorpus.length === 0, `and no held-back edition is exported as published${heldBackInCorpus.length ? `: ${heldBackInCorpus.map((t) => t.slug).join(', ')}` : ''}`);

section('the graph export');
const graphRaw = readFileSync(join(ROOT, 'data', 'graph', 'graph.json'), 'utf8');
const graphOut = readFileSync(join(DIST, 'data', 'graph.json'), 'utf8');
check(graphOut === graphRaw, 'data/graph.json is a byte copy of data/graph/graph.json');
const graph = JSON.parse(graphOut);
check(Array.isArray(graph.nodes) && Array.isArray(graph.edges), `it parses with ${graph.nodes.length} node(s) and ${graph.edges.length} edge(s)`);
const nodeIds = graph.nodes.map((n) => n.id);
const edgeIds = graph.edges.map((e) => e.id);
check(new Set(nodeIds).size === nodeIds.length, 'every node id is unique');
check(new Set(edgeIds).size === edgeIds.length, 'every edge id is unique');
const declared = new Set(nodeIds);
const dangling = graph.edges.filter((e) => !declared.has(e.from) || !declared.has(e.to));
check(dangling.length === 0, `every edge endpoint resolves to a declared node${dangling.length ? `: ${dangling.map((e) => e.id).join(', ')}` : ''}`);
/* Every edition node must name a slug the corpus holds OR an edition the shelf
 * holds back ON PURPOSE. The graph is authored data and records an edition as
 * soon as the library has one; the corpus carries only what is served. So the
 * two still cannot disagree about a SERVED edition -- that is the check -- and a
 * node for a held-back edition must be a real shelf entry, named, not a stray. */
const heldBackSlugs = new Set(TEXTS.filter((t) => !isPublished(t)).map((t) => t.slug));
const editionSlugs = graph.nodes.filter((n) => n.type === 'edition').map((n) => n.slug);
const unknown = editionSlugs.filter((s) => !corpusSlugs.has(s) && !heldBackSlugs.has(s));
check(
  unknown.length === 0,
  `every edition node's slug is in the corpus or is an edition the shelf holds back${unknown.length ? `: ${unknown.join(', ')}` : ` (${editionSlugs.join(', ')})`}`,
);
/* Plan §7 risk 6: a seed that still says TODO ships looking finished. */
const withTodo = [
  ...graph.nodes.filter((n) => JSON.stringify(n).includes('TODO')).map((n) => `node ${n.id}`),
  ...graph.edges.filter((e) => JSON.stringify(e).includes('TODO')).map((e) => `edge ${e.id}`),
];
check(withTodo.length === 0, `no node or edge carries a TODO marker${withTodo.length ? `: ${withTodo.join(', ')}` : ''}`);
const types = new Set(graph.nodes.map((n) => n.type));
const allowedTypes = new Set(['text', 'author', 'edition', 'passage']);
check([...types].every((t) => allowedTypes.has(t)), `every node type is one of ${[...allowedTypes].join(', ')} (${[...types].join(', ')})`);
const edgeTypes = new Set(graph.edges.map((e) => e.type));
const allowedEdges = new Set(['cites', 'translates', 'derives_from', 'commentary_on', 'wrote', 'translated_by']);
check([...edgeTypes].every((t) => allowedEdges.has(t)), `every edge type is one of ${[...allowedEdges].join(', ')} (${[...edgeTypes].join(', ')})`);

console.log(failures === 0 ? '\nexports-probe: all checks passed' : `\nexports-probe: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
