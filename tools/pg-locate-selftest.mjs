#!/usr/bin/env node
/**
 * tools/pg-locate-selftest.mjs — the locator's own regression probes, kept so
 * that a fix to it can be PROVEN by asymmetry instead of asserted.
 *
 *     node tools/pg-locate-selftest.mjs [--tool tools/pg-locate.mjs] [--batch FILE]
 *
 * Each probe is a case the instrument must answer a particular way. The point of
 * the file is that SOME OF THESE FAIL ON THE INSTRUMENT AS IT WAS: run it against
 * the previous revision (`git show <rev>:tools/pg-locate.mjs > /var/tmp/old.mjs;
 * node tools/pg-locate-selftest.mjs --tool /var/tmp/old.mjs`) and the failures
 * are the defects, each one a placement or a verdict the corrected tool refuses.
 *
 * --batch adds the invariants that are properties of a whole run rather than of
 * one probe: no located point with an empty witness stretch, no located point
 * whose two candidate volumes disagree, no bare `silent` verdict left in the
 * record, and every verdict read AGAINST a rule carrying the changed-word
 * measurements the subclassification needs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const TOOL = opt('tool', join(ROOT, 'tools', 'pg-locate.mjs'));
const SLUG = 'proclus-theology-of-plato-taylor-1816';
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
};

/* ---------- probes ---------------------------------------------------------- */

function probe(text) {
  try {
    const out = execFileSync(process.execPath, [TOOL, SLUG, '--probe', text], { encoding: 'utf8', timeout: 240000 });
    return { exit: 0, json: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout ? String(e.stdout) : '';
    let json = null;
    try {
      json = JSON.parse(out);
    } catch {
      json = null;
    }
    return { exit: e.status, json, raw: out || String(e.message) };
  }
}

/* 1-2. THE REFUSAL PATH STILL REFUSES. Both of these refused before the fixes and
 * must still refuse: nothing below is allowed to have relaxed them. */
{
  const r = probe('zorbantic plenthorium quixotical ragnarok velluminous threnody zephyrous maleficarum obfuscata gromboolian snarkishly wibbling transplendent');
  check('invented words still refuse (exit 1, no anchor)', r.exit === 1 && r.json && r.json.status === 'refused-no-anchor', `exit ${r.exit}, status ${r.json && r.json.status}`);
}
{
  const r = probe('of the soul and of the good and of the one and of the many and of the same and of the other and of being and of life');
  check('common words still refuse (exit 1, no anchor)', r.exit === 1 && r.json && r.json.status === 'refused-no-anchor', `exit ${r.exit}, status ${r.json && r.json.status}`);
}

/* 3. NO COIN FLIP WHEN TWO VOLUMES QUALIFY. The 1816 imprint page is printed in
 * BOTH volumes word for word, so both of them bracket a probe of it. The tool
 * used to pick one by sort order and answer `located, vol1` with both bounds
 * occurred {vol1:1, vol2:1}; it must now REFUSE. */
{
  const r = probe('printed for the author by a j valpy tookes court chancery lane and sold by messrs law and co longman and co baldwin and co');
  const both = r.json && r.json.left && r.json.right && r.json.left.occurred && r.json.left.occurred.vol1 === 1 && r.json.left.occurred.vol2 === 1;
  check(
    'a point that BOTH volumes bracket is refused, not placed by sort order',
    r.json && r.json.status === 'refused-ambiguous-volume',
    `status ${r.json && r.json.status}, volume ${r.json && r.json.volume}, both bounds occur once in each volume: ${!!both}`,
  );
}

/* 4. A REAL POINT STILL LOCATES, and it locates where it should. The known truth
 * from the yield record: Book IV ch. VI is in PG vol. 1 and PG reads
 * `supercelestial ... imparticipable` against our garble `snpercelestial`,
 * `imparticipa-ble`. */
{
  const r = probe('Again therefore if indeed the snpercelestial place is the imparticipa-ble and occult genus of the intelligible Gods how can we establish so great a divine multitude there and this accompanied with separation');
  check(
    'a known point still locates in vol. 1 (fix must not refuse it)',
    r.json && r.json.status === 'located' && r.json.volume === 'vol1' && r.json.pg && r.json.pg.n > 0,
    `status ${r.json && r.json.status}, volume ${r.json && r.json.volume}, witness stretch ${r.json && r.json.pg && r.json.pg.n}`,
  );
}

/* 5. A TIGHT PLACEMENT IS STILL TIGHT: Book VII ch. XXXII, PG vol. 2, both bounds
 * hard against the point, the witness's words identical to ours. */
{
  const r = probe('Jupiter indeed, adorns sensibles totally, according to an imitation of\nHeaven. For the Jupiter in the intellectual order, proceeds analogous\nto the intellectual Heaven, in the royal series. But Juno moves wholes');
  check(
    'a known TIGHT point still locates in vol. 2 with words identical to ours',
    r.json && r.json.status === 'located' && r.json.volume === 'vol2' && r.json.tight === true && r.json.pg && r.json.pg.n > 0,
    `status ${r.json && r.json.status}, volume ${r.json && r.json.volume}, tight ${r.json && r.json.tight}, stretch ${r.json && r.json.pg && r.json.pg.n}`,
  );
}

/* 6-7. GREEK IS PART OF THE TOKEN STREAM — the defect the ASCII predicate hid,
 * and BOTH of its halves. The predicate was `a-z0-9`, so every Greek character was
 * dropped, and this print sets Greek in the transcription's own reading and, more
 * to the point, ITS WITNESS SETS GREEK TOO (the human-proofread PG transcription
 * of the same 1816 print carries 7,661 Greek codepoints in vol. 1 and 10,837 in
 * vol. 2). The two probes below are the two halves:
 *
 *   6. a passage that ITSELF carries Greek must yield Greek tokens (ours);
 *   7. a passage of our own Greek-FREE text whose witness stretch is Greek must
 *      come back with the witness's Greek tokens (pg).
 *
 * MEASURED asymmetry, which is the point of the pair: on the revision before the
 * fix (`git show <rev>:tools/pg-locate.mjs` into a mirror tree — ROOT is derived
 * from the tool's OWN path, so a copy outside the repository cannot find
 * `data/editions/`) BOTH probes read 0 Greek tokens; on the corrected tool they
 * read 2 and 9, and both passages still LOCATE in vol. 1, so what moved is the
 * token stream and not the placement. */
const GREEK_TOKEN = /[\u0370-\u03ff\u1f00-\u1fff]/;
const greekIn = (xs) => (xs || []).filter((t) => GREEK_TOKEN.test(t)).length;
{
  const r = probe('in the vestibule of the good ; (ἐπὶ μὲν τοῖς τοῦ ἀγαθοῦ νῦν ἤδη προθύροις ἐφεστάναι) and Dionysius says of his first order that it is as it were arranged in the vestibules of deity and beauty also are shown by Proclus');
  check(
    'a passage that CARRIES Greek yields Greek tokens of our own (the predicate was ASCII a-z0-9)',
    r.json && greekIn(r.json.ours && r.json.ours.tokens) >= 2,
    `status ${r.json && r.json.status}, ${r.json ? greekIn(r.json.ours && r.json.ours.tokens) : '?'} Greek token(s) in our own span (must be >= 2)`,
  );
}
{
  const r = probe('and beauty, which characterize this triad, are said by Plato in the Philebus to subsist in the vestibule of the good ; (exi /mv to*$ rou ayxiov vt/v ij&ij xgoivpois tpwraveui) and Dionysius says 1 of his first order that it is as it were arranged in the vestibules of deity');
  const pg = r.json && r.json.pg && r.json.pg.tokens;
  check(
    'the witness\'s OWN Greek reaches the comparison (PG sets Greek at this point; the old stream held none)',
    r.json && r.json.status === 'located' && greekIn(pg) >= 8,
    `status ${r.json && r.json.status}, volume ${r.json && r.json.volume}, ${greekIn(pg)} Greek token(s) in the witness stretch (must be >= 8)`,
  );
}

/* ---------- whole-run invariants -------------------------------------------- */

const BATCH = opt('batch', '');
if (BATCH) {
  if (!existsSync(BATCH)) {
    console.error(`pg-locate-selftest: no such batch file ${BATCH}`);
    process.exit(2);
  }
  const doc = JSON.parse(readFileSync(BATCH, 'utf8'));
  const pts = doc.points || [];
  const located = pts.filter((p) => p.status === 'located');
  const rules = located.filter((p) => p.decide);

  const empty = located.filter((p) => p.pg && p.pg.n === 0);
  check(`no LOCATED point has an empty witness stretch (${located.length} located)`, empty.length === 0, `${empty.length} have one: ${empty.slice(0, 5).map((p) => p.id).join(', ')}`);

  /* the pre-fix record has no `volumes_ok`; derive it from the recorded ok
   * combinations (`why: null` means it bracketed the point) so this check runs
   * on both revisions. */
  const twoVol = located.filter((p) => {
    if (Array.isArray(p.volumes_ok)) return p.volumes_ok.length > 1;
    return new Set((p.tried || []).filter((t) => t.why === null).map((t) => t.volume)).size > 1;
  });
  check(`no LOCATED point has two candidate volumes`, twoVol.length === 0, `${twoVol.length} have: ${twoVol.map((p) => p.id).join(', ')}`);

  const bare = rules.filter((p) => p.decide.verdict === 'silent');
  check(`no bare \`silent\` verdict is left in the record (the three facts are split)`, bare.length === 0, `${bare.length} still read silent: ${bare.slice(0, 5).map((p) => p.id).join(', ')}`);

  const against = rules.filter((p) => ['before', 'third'].includes(p.decide.verdict));
  const unmeasured = against.filter((p) => {
    const c = p.decide.changed || {};
    return ((c.before || []).length + (c.after || []).length) === 0;
  });
  check(
    `every verdict read AGAINST a rule carries its changed-word measurements (${against.length} of them)`,
    against.length > 0 && unmeasured.length === 0,
    `${unmeasured.length} carry none: ${unmeasured.slice(0, 5).map((p) => p.id).join(', ')}`,
  );

  /* the four rules the review measured as decided through the coin flip */
  for (const id of ['r8614', 'r10853', 'r10855', 'r11278']) {
    const p = pts.find((x) => String(x.id).endsWith(`:${id}`));
    if (!p) {
      console.log(`SKIP  ${id} is not in ${BATCH}`);
      continue;
    }
    check(`${id} (front-matter text both volumes carry) is not placed by a coin flip`, p.status !== 'located', `status ${p.status}, volume ${p.volume}`);
  }

  /* the brief's own third-form example, verified by hand at PG vol. 1 */
  const third = pts.find((x) => String(x.id).endsWith(':r8617'));
  if (third)
    check(
      'r8617 (our `after` is `For the hebdomad is a multitude`, PG reads `for hebdomadic multitude`) is a THIRD-FORM verdict, not silent',
      third.decide && third.decide.verdict === 'third',
      `verdict ${third.decide && third.decide.verdict}`,
    );
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} probes pass${BATCH ? ` (batch ${BATCH})` : ''}`);
process.exit(failed ? 1 : 0);
