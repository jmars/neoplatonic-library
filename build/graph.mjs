/**
 * build/graph.mjs — the /graph/ route: the transmission/citation graph, rendered
 * over data/graph/graph.json (DATA-MODEL §5, extraction plan §3 the /graph row).
 *
 * WHAT IT RENDERS: the authoring graph AS AUTHORED. It draws the nodes and the
 * edges the data file holds and nothing else — an edge is drawn because it is in
 * the file, never inferred from a shared author or a similar title. The seed is
 * SPARSE (two texts, their authors, their two editions, four structural edges)
 * and the page says so rather than dressing the seed up as a finished
 * transmission graph: the editorial edges the model names (`cites`,
 * `derives_from`, `commentary_on`) are being authored and are absent until they
 * are.
 *
 * The figure is a plain SVG laid out by node type — authors, texts, passages,
 * editions, left to right — with a small script for the filters and a click that
 * highlights a node's edges. No widget engine: a typed node/edge graph is not
 * what any of the blog's figures draws, and the plan says so (§3).
 *
 * + a TABLE of every edge, because the figure is a picture and the table is the
 * record: a reader can read the same edges as text, which is what makes the
 * figure checkable.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc, SITE, ROOT } from './shell.mjs';

/** The model's node and edge vocabularies (DATA-MODEL §5). The page states the
 * whole vocabulary and marks what the seed does not yet carry, so the gap is
 * visible rather than implied by an absence. */
export const NODE_TYPES = ['author', 'text', 'passage', 'edition'];
export const EDGE_TYPES = ['wrote', 'translated_by', 'translates', 'cites', 'derives_from', 'commentary_on'];

const TYPE_LABEL = {
  author: 'author',
  text: 'text',
  passage: 'passage',
  edition: 'edition',
};
const EDGE_LABEL = {
  wrote: 'wrote',
  translated_by: 'translated by',
  translates: 'translates',
  cites: 'cites',
  derives_from: 'derives from',
  commentary_on: 'commentary on',
};
/** What each edge means, said once, on the page. */
const EDGE_MEANING = {
  wrote: 'an author wrote a text',
  translated_by: 'a translator made an edition (from the edition to the person)',
  translates: 'an edition is a translation of a text',
  cites: 'a text names another in its own argument',
  derives_from: 'a text takes its doctrine from another',
  commentary_on: 'a text is a commentary on another',
};

const COL_X = { author: 90, text: 360, passage: 360, edition: 640 };
const NODE_W = 210;
const NODE_H = 46;
const ROW_GAP = 74;
const TOP = 56;

export function readGraph() {
  const raw = readFileSync(join(ROOT, 'data', 'graph', 'graph.json'), 'utf8');
  const g = JSON.parse(raw);
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error('data/graph/graph.json carries no nodes[]/edges[]');
  return g;
}

/** The figure's layout + markup. Nodes are placed by type column in the file's
 * own order, so the same data draws the same figure twice. */
function figure(g, served = null) {
  const at = new Map();
  const rows = {};
  for (const n of g.nodes) {
    const t = COL_X[n.type] !== undefined ? n.type : 'text';
    rows[t] = (rows[t] || 0) + 1;
    const x = COL_X[t];
    const y = TOP + (rows[t] - 1) * ROW_GAP;
    at.set(n.id, { n, x, y });
  }
  const maxRows = Math.max(1, ...Object.values(rows));
  const width = 900;
  const height = TOP + maxRows * ROW_GAP + 40;

  const edges = g.edges.map((e) => {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) return null;
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const cls = `g-edge edge-${esc(e.type)}`;
    const title = `${esc(e.from)} ${EDGE_LABEL[e.type] || esc(e.type)} ${esc(e.to)}`;
    return (
      `<g class="${cls}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" data-type="${esc(e.type)}">` +
      `<title>${title}</title>` +
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#arrow)"></line>` +
      `<text class="e-label" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 5}">${esc(EDGE_LABEL[e.type] || e.type)}</text>` +
      `</g>`
    );
  }).filter(Boolean).join('');

  const nodes = g.nodes.map((n) => {
    const p = at.get(n.id);
    const label = `${esc(n.label)}`;
    const sub = `<tspan class="n-sub" x="${p.x + 12}" dy="15">${esc(TYPE_LABEL[n.type] || n.type)}</tspan>`;
    const inner = `<rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}"></rect>` +
      `<text class="n-label" x="${p.x + 12}" y="${p.y + 20}">${label}${sub}</text>`;
    /* A NODE LINKS TO ITS TEXT PAGE ONLY WHEN THAT PAGE EXISTS. The graph is
     * authored data and grows before an edition does: an edition node can be
     * recorded while its text is held back (shelf `published: false`), and a link
     * to the page it would have is a dead link on a live page. So the caller
     * passes the served slugs and only those nodes are anchor-wrapped; the node
     * is still drawn, labelled and filterable — the data is not hidden, only the
     * link that would 404 is. */
    const body = n.slug && (!served || served.has(n.slug))
      ? `<a href="/texts/${esc(n.slug)}/">${inner}</a>`
      : inner;
    return `<g class="g-node node-${esc(n.type)}" data-id="${esc(n.id)}" data-type="${esc(n.type)}">${body}</g>`;
  }).join('');

  const svg =
    `<svg class="graph-fig" viewBox="0 0 ${width} ${height}" role="img" ` +
    `aria-label="the transmission graph: ${g.nodes.length} nodes and ${g.edges.length} edges">` +
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z"></path></marker></defs>` +
    edges +
    nodes +
    `</svg>`;
  return { svg, width, height };
}

/** The filters: one checkbox per node type and per edge type PRESENT in the
 * data. A type the seed does not carry is not offered as a filter — a control
 * that filters nothing is a lie about the data. */
function filters(g) {
  const nodeTypes = [...new Set(g.nodes.map((n) => n.type))].sort();
  const edgeTypes = [...new Set(g.edges.map((e) => e.type))].sort();
  const box = (kind, t, label) =>
    `<label class="gf"><input type="checkbox" data-filter="${kind}" data-ftype="${esc(t)}" checked> ${esc(label)}</label>`;
  return (
    `<div class="graph-filters">` +
    `<span class="gf-g">nodes</span>${nodeTypes.map((t) => box('node', t, TYPE_LABEL[t] || t)).join('')}` +
    `<span class="gf-g">edges</span>${edgeTypes.map((t) => box('edge', t, EDGE_LABEL[t] || t)).join('')}` +
    `</div>`
  );
}

function edgeTable(g) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const rows = g.edges.map((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    const label = (n) => (n ? esc(n.label) : `<code>${esc(e.from)}</code>`);
    const extra = [e.evidence ? `evidence: ${esc(e.evidence)}` : '', e.note ? esc(e.note) : ''].filter(Boolean).join(' — ');
    return (
      `<tr><td>${a ? `<span class="nt nt-${esc(a.type)}">${esc(a.type)}</span>` : ''} ${label(a)}</td>` +
      `<td><code>${esc(e.type)}</code></td>` +
      `<td>${b ? `<span class="nt nt-${esc(b.type)}">${esc(b.type)}</span>` : ''} ${label(b)}</td>` +
      `<td>${esc(e.id)}</td>` +
      `<td>${extra}</td></tr>`
    );
  }).join('');
  return (
    `<table class="edges"><thead><tr><th>from</th><th>edge</th><th>to</th><th>id</th><th>evidence</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

export function buildGraphPage(g, servedSlugs = null) {
  const presentEdges = new Set(g.edges.map((e) => e.type));
  const missing = EDGE_TYPES.filter((t) => !presentEdges.has(t));
  const fig = figure(g, servedSlugs ? new Set(servedSlugs) : null);
  const counts = NODE_TYPES.map((t) => ({ t, n: g.nodes.filter((x) => x.type === t).length })).filter((c) => c.n);
  const body =
    `<section><div class="wrap">` +
    `<h2>The figure</h2>` +
    `<div class="hint">${g.nodes.length} node${g.nodes.length === 1 ? '' : 's'} · ` +
    `${g.edges.length} edge${g.edges.length === 1 ? '' : 's'} — as authored, nothing inferred</div>` +
    filters(g) +
    `<div class="graph-wrap">${fig.svg}</div>` +
    `<div class="prose">` +
    `<p><b>What this is.</b> The transmission and citation graph of the library's texts, as ` +
    `structured data (not read out of anyone's prose): the authors, the works, the editions, and the ` +
    `relations between them. An edge stands here because it is recorded in the library's data, and every ` +
    `edge is listed in the table below. Nothing is added by resemblance — two texts that share an author or ` +
    `a title are not joined by an edge this page drew.</p>` +
    `<p><b>Where this stands.</b> The graph is being authored from the beginning, so it is SPARSE. What is ` +
    `here now is the structural skeleton: ` +
    `${counts.map((c) => `${c.n} ${TYPE_LABEL[c.t]}${c.n === 1 ? '' : 's'}`).join(', ')}; and the edges that ` +
    `join them (${[...presentEdges].map((t) => EDGE_LABEL[t] || t).join(', ') || 'none yet'}). ` +
    (missing.length
      ? `The editorial edges the model names — ${missing.map((t) => EDGE_LABEL[t] || t).join(', ')} — are ` +
        `NOT drawn, because none is recorded yet. They are knowledge about the tradition, not a ` +
        `derivation from any file, and they will be added as they are settled; until then this page shows ` +
        `the skeleton rather than a guess. The citation graph of the blog's essays is a different graph ` +
        `and lives with those essays.`
      : '') +
    `</p>` +
    `<p><b>How to read it.</b> The filters below the heading (well, above the figure) show and hide a node ` +
    `type or an edge type without changing the data; a click on a node highlights the edges that touch it. ` +
    `Every node and every edge is also in the table, which is the record the figure is drawn from.</p>` +
    `</div></div></section>` +
    `<section><div class="wrap">` +
    `<h2>The edges, as a table</h2>` +
    `<div class="hint">every edge in the data file, in the file's own order</div>` +
    `<div class="prose">${g.edges.length ? edgeTable(g) : '<p>No edges are recorded yet.</p>'}</div>` +
    `</div></section>`;

  return {
    title: `The graph — ${SITE.host}`,
    shareTitle: 'The graph',
    type: 'website',
    description:
      'The transmission and citation graph of the library’s texts, as authored: the authors, works and editions, and the relations recorded between them.',
    eyebrow: 'The texts',
    heading: 'The graph',
    standfirst: 'The transmission of the texts, as recorded — nothing inferred.',
    body,
    navCurrent: '/graph/',
    // the graph page carries its own small interaction script
    arrive: GRAPH_ARRIVE,
  };
}

/** The filters and the click-highlight. Deliberately tiny: show/hide by class,
 * and a node's incident edges on click. No layout engine is needed — the SVG is
 * laid out by type at build time. */
const GRAPH_ARRIVE = `(function () {
  var boxes = document.querySelectorAll('input[data-filter]');
  for (var i = 0; i < boxes.length; i++) {
    boxes[i].addEventListener('change', paint);
  }
  function paint() {
    var on = {};
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      on[b.getAttribute('data-filter') + ':' + b.getAttribute('data-ftype')] = b.checked;
    }
    var els = document.querySelectorAll('.g-node, .g-edge');
    for (var j = 0; j < els.length; j++) {
      var el = els[j];
      var kind = el.classList.contains('g-node') ? 'node' : 'edge';
      var t = el.getAttribute('data-type');
      el.classList.toggle('off', on[kind + ':' + t] === false);
    }
  }
  var fig = document.querySelector('.graph-fig');
  if (fig) fig.addEventListener('click', function (e) {
    var g = e.target;
    while (g && g !== fig && !(g.classList && g.classList.contains('g-node'))) g = g.parentNode;
    var id = g && g !== fig ? g.getAttribute('data-id') : null;
    var nodes = document.querySelectorAll('.g-node');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle('on', nodes[i].getAttribute('data-id') === id);
    var edges = document.querySelectorAll('.g-edge');
    for (var j = 0; j < edges.length; j++) {
      edges[j].classList.toggle('on', !!id && (edges[j].getAttribute('data-from') === id || edges[j].getAttribute('data-to') === id));
    }
  });
})();`;
