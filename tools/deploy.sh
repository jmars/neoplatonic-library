#!/usr/bin/env bash
# tools/deploy.sh — publish site/dist/ to the live host (extraction plan §7 step 7).
#
# WHY THIS SCRIPT EXISTS. The deploy used to be a hand-typed rsync of `dist/` with
# --delete. That is unsafe on this host: the build starts by removing site/dist/
# (build/build.mjs `rmSync(DIST, ...)`), and more than one agent can be building at
# once. On 2026-10-02 that race took the blog down — a concurrent build wiped dist/
# in the middle of a transfer, and --delete then removed the remote index.html that
# had not been re-copied yet. The home page served a 404 until a fresh build was
# pushed. The blog's tools/deploy.sh is what closed it, and this is the same shape.
#
# So the tree is FROZEN before it is shipped: rsync reads a directory nothing can
# mutate, and a concurrent builder cannot reach the copy.
#
#   ./tools/deploy.sh              deploy site/dist/ as it stands
#
# Exit status is rsync's (or the verify's), and the site is checked afterwards.
#
# WHAT IS SHIPPED BESIDE THE PAGES, AND AT WHAT COST. The deploy also carries the
# source scan images: `site/dist/texts/<slug>/scans/` holds each edition's
# WHOLE SCAN (141 leaves for the Proclus, 72 for the Porphyry — MEASURED
# 2026-10-05), served at the stable address `/texts/<slug>/scans/nNNN.jpg` that
# a repair's evidence cites. That is ≈59M — by far the largest part of the
# transfer — and, because
# there is no --delete, a leaf a later build drops is retained server-side rather
# than removed. A real cost, stated.
#
# TWO THINGS THIS DEPLOY DELIBERATELY DOES NOT DO.
#
# 1. NO --delete. The blog's script re-enabled --delete on the frozen copy, which
#    is safe only because the blog has no retained server-side state. This site
#    does: model §0.2 makes every VERSION immutable and retained, so
#    `texts/<slug>/v/<semver>/` is served after it stops being current, and the
#    build only ever writes the versions present in data/ RIGHT NOW. A --delete
#    here would remove a pinned version from the server the moment the repo's
#    checkout did not carry it — and a citation to v1.0.0 would 404. So nothing
#    server-side is ever removed by a deploy. The honest cost, stated: a file a
#    later build drops is also not removed; that residue is a separate, explicit
#    action (a hand-run rsync), never a side effect of publishing.
#
# 2. NO extension rewriting. THE BUILT TREE CARRIES EXTENSIONLESS FILES, AND THEY
#    ARE SERVED AS STATIC EXTENSIONLESS FILES. `/texts/<slug>/t` (the document the
#    reader app fetches), `/texts/<slug>/plain` (the plain-text export, cited by
#    that name) and `/search/index` (the search index the page fetches) are literal
#    paths with no extension — that is their address, not a file whose name is
#    missing a suffix. The Caddy vhost must serve the static tree as it stands
#    (`file_server`), with no `try_files`/`.html` fallback and no rewrite that
#    would turn `/texts/<slug>/t` into a directory (or a 404): a rewritten path is
#    a DIFFERENT address, and a citation to it stops resolving. The verify step
#    below curls one such address for exactly that reason.

set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:-node-infra}"
DEST="${DEPLOY_DEST:-/srv/www/neoplatonic-library}"
BASE="${DEPLOY_URL:-https://neoplatonic-library.org}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# A build must exist, and it must be complete: a dist/ without index.html is a
# half-written tree, and deploying it is exactly the outage above.
[ -d site/dist ] || { echo "deploy: no site/dist/ — run node build/build.mjs first" >&2; exit 1; }
[ -f site/dist/index.html ] || { echo "deploy: site/dist/index.html is missing — the build is incomplete, refusing" >&2; exit 1; }
[ -f site/dist/404.html ] || { echo "deploy: site/dist/404.html is missing — the build is incomplete, refusing" >&2; exit 1; }

# FREEZE. A copy of site/dist/, taken in one pass, that nothing else writes to.
echo "$(date +%T) freezing site/dist/ -> $STAGE"
cp -a site/dist/. "$STAGE/"
for f in index.html 404.html; do
  [ -f "$STAGE/$f" ] || { echo "deploy: the frozen copy has no $f — refusing" >&2; exit 1; }
done
echo "$(date +%T) frozen: $(find "$STAGE" -type f | wc -l) file(s), $(du -sh "$STAGE" | cut -f1)"

# SHIP. No --delete (see the header): the frozen copy is only ADDED to the server,
# so a pinned version directory the current build does not carry survives the push.
echo "$(date +%T) rsync -> $HOST:$DEST (no --delete: server-side version dirs are retained)"
rsync -a --chown=caddy:caddy --rsync-path="sudo rsync" "$STAGE/" "$HOST:$DEST"

# VERIFY. A deploy that is not checked is a deploy that might have 404'd the home
# page — which is how this script came to be written. The document endpoint is
# checked too: it is the extensionless address the note above is about.
SLUG="$(node -e '
const { readdirSync, readFileSync } = require("node:fs");
for (const d of readdirSync("data/editions")) {
  try {
    const e = JSON.parse(readFileSync(`data/editions/${d}/edition.json`, "utf8"));
    if (e.current_version) { console.log(d); break; }
  } catch {}
}
')"
# ONE SOURCE LEAF is checked too. The edition's page images ship beside the text
# at /texts/<slug>/scans/nNNN.jpg (the address a repair's evidence cites), so a
# deploy that dropped them would leave every cited leaf a 404. The leaf is read
# from the data, not typed.
LEAF="$(node -e '
const { readdirSync } = require("node:fs");
const slug = process.argv[1];
try {
  const f = readdirSync(`data/editions/${slug}/scans`).filter((x) => /^n\d+\.jpg$/.test(x)).sort()[0];
  if (f) console.log(`/texts/${slug}/scans/${f}`);
} catch {}
' "$SLUG" 2>/dev/null || true)"
echo "$(date +%T) verifying"
fail=0
for path in / /texts/ /sitemap.xml ${SLUG:+/texts/$SLUG/t} ${LEAF:-}; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path" || echo 000)"
  printf '  %-16s %s\n' "$path" "$code"
  [ "$code" = "200" ] || fail=1
done
[ "$fail" = "0" ] || { echo "deploy: VERIFY FAILED — the site is not serving; check the host" >&2; exit 1; }
echo "$(date +%T) deploy ok"
