#!/usr/bin/env node
/**
 * tools/gates.mjs — THE ONE RUNNER. Every gate in the repository, discovered from
 * the DIRECTORY, each one's name and exit code printed, non-zero if any fails.
 *
 * WHY IT EXISTS. Twelve gates stayed green while the served reading view read
 * `supermundaneessential` (the fold gate did not exist yet), and tools/echo-probe.mjs
 * sat RED at 1.0.4, 1.0.5, 1.0.6 and 1.0.7 while four units reported "14/14" and
 * "15/15 gates green by exit code" — because each unit ran the gates it happened to
 * remember, and a gate nobody runs is a gate that does not exist. "All gates green"
 * must mean the gates THAT ARE THERE, so this runner takes its list from the
 * directory and prints it: the list IS the evidence.
 *
 * WHAT COUNTS AS A GATE, and why the discovery is written this way rather than as a
 * list in this file (a list goes stale the moment someone adds a gate):
 *   1. THE BUILD — `build/build.mjs` and `tools/build-reader.mjs`. Fixed, because
 *      every page-reading gate below reads what they write, and their order matters.
 *   2. THE NAMED GATES — every `tools/*-probe.mjs`, `tools/*-selftest.mjs` and
 *      `tools/*-smoke.mjs`, read from the directory. That is the naming convention
 *      the repository already uses for a gate.
 *   3. THE SELF-TEST GATES — every other `tools/*.mjs` whose SOURCE mentions
 *      `--self-test` (the convention for a tool that carries its own regression
 *      battery: fullread, repair, merge, vocab). Also read from the directory, and
 *      it catches a gate that does not carry `-probe`/`-smoke` in its name.
 *
 * THE SURFACE IS RECORDED. `tools/gates.surface.txt` is the gate set as last
 * acknowledged. A gate that DISAPPEARS from the directory (renamed, deleted) is a
 * FAILURE here — a gate cannot quietly stop existing — and a gate that APPEARS is
 * reported too, so the record is updated deliberately rather than by accident:
 *
 *     node tools/gates.mjs             # run every gate, compare the surface, exit
 *     node tools/gates.mjs --record    # re-record the surface, then run
 *     node tools/gates.mjs --no-build  # the gates only (the two build steps skipped)
 *     node tools/gates.mjs --only NAME # one gate, for iterating on a fix — reported
 *                                      # as a PARTIAL run, and it does not exit 0
 *                                      # unless it is the only thing you asked for
 *
 * MEASURED 2026-10-08 on the tree that shipped 1.0.8: 23 gates (2 build, 20 probes /
 * smokes / self-tests). tools/echo-probe.mjs is among them; running this file is how
 * its red at 1.0.4-1.0.7 stops being invisible.
 *
 * A gate is the exit code, not the tail of stdout — the summary line below is quoted
 * for the reader, the PASS/FAIL word and the final exit status come from `status`.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'tools');
const SURFACE = join(TOOLS, 'gates.surface.txt');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const value = (f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : null);

/* ---------- the build, first and in this order ---------- */
const BUILD = [
  { cmd: ['node', 'build/build.mjs'], why: 'the site, the corpus export and the frozen version directories every page-reading gate reads' },
  { cmd: ['node', 'tools/build-reader.mjs'], why: 'the reader, compiled and stripped to tools/app.js, which the app gate boots in a DOM' },
];

/* ---------- discovery, from the directory ---------- */
const NAMED_GATE = /(^|-)(probe|selftest|smoke)\.mjs$/;
const SELF = basename(fileURLToPath(import.meta.url)); // this runner is not a gate of itself
const mjsIn = (dir) => readdirSync(dir)
  .filter((f) => f.endsWith('.mjs'))
  .filter((f) => f !== SELF)
  .filter((f) => statSync(join(dir, f)).isFile())
  .sort();

const discovered = [];
for (const f of mjsIn(TOOLS)) {
  if (NAMED_GATE.test(f)) discovered.push({ cmd: ['node', `tools/${f}`], why: 'a gate by name' });
  else if (readFileSync(join(TOOLS, f), 'utf8').includes('--self-test')) {
    discovered.push({ cmd: ['node', `tools/${f}`, '--self-test'], why: 'a tool carrying its own regression battery' });
  }
}
if (discovered.length === 0) {
  console.error('gates: NO GATE FOUND in tools/ — the discovery pattern is broken or the directory is empty. Refusing to report success.');
  process.exit(1);
}
const all = [...BUILD.map((b) => ({ ...b, section: 'build' })), ...discovered.map((d) => ({ ...d, section: 'gate' }))];
const key = (g) => g.cmd.join(' ');

/* ---------- the recorded surface ---------- */
const surfaceOf = (gates) => `${gates.map((g) => `${g.section}\t${key(g)}`).join('\n')}\n`;
if (has('--record')) {
  writeFileSync(SURFACE, surfaceOf(all));
  console.log(`gates: surface recorded — ${all.length} gate(s) -> tools/gates.surface.txt`);
}
const recorded = existsSync(SURFACE)
  ? readFileSync(SURFACE, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')[1])
  : null;

/* ---------- run ---------- */
const only = value('--only');
const toRun = all.filter((g) => (!only || key(g).includes(only)) && !(has('--no-build') && g.section === 'build'));

console.log(`gates: ${all.length} gate(s) enumerated from tools/ and build/`);
for (const g of all) console.log(`  ${g.section === 'build' ? 'build' : 'gate '}  ${key(g)}   — ${g.why}`);
console.log('');
console.log(`gates: running ${toRun.length}${only ? ` (--only ${only})` : ''}${has('--no-build') ? ' (--no-build)' : ''}`);

const fails = [];
const results = [];
for (const g of toRun) {
  const t0 = Date.now();
  const r = spawnSync(g.cmd[0], g.cmd.slice(1), { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 3600_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  const rc = r.status == null ? (timedOut ? 'TIMEOUT' : 'NO-EXIT') : r.status;
  const ok = rc === 0;
  const last = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '(no output)';
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push({ g, rc, ok, secs, last, out });
  if (!ok) fails.push({ g, rc, out });
  console.log(`${ok ? 'PASS' : 'FAIL'}  rc=${rc}  ${secs}s  ${key(g)}`);
  console.log(`        ${last.slice(0, 200)}`);
}

/* A FAILURE IS PRINTED IN FULL TAIL: the summary line names the gate, the tail says why. */
for (const f of fails) {
  const tail = f.out.split('\n').filter((l) => l.trim()).slice(-25).join('\n');
  console.log(`\n----- FAIL ${key(f.g)} (rc=${f.rc}) — last 25 line(s) -----\n${tail}`);
}

/* ---------- the surface comparison ---------- */
let surfaceFail = null;
if (recorded && !only) {
  const now = all.map(key);
  const gone = recorded.filter((k) => !now.includes(k));
  const added = now.filter((k) => !recorded.includes(k));
  if (gone.length || added.length) {
    surfaceFail = `the gate surface is not what tools/gates.surface.txt records — ${gone.length} gone (${gone.join(', ') || 'none'}), ${added.length} new (${added.join(', ') || 'none'})`;
    console.log(`\nFAIL  surface: ${surfaceFail}`);
    console.log('        a gate that stops existing must be acknowledged: `node tools/gates.mjs --record` after you are sure it is deliberate');
  } else {
    console.log(`\nPASS  surface: the ${all.length} enumerated gate(s) are what tools/gates.surface.txt records`);
  }
} else if (!recorded) {
  surfaceFail = 'no tools/gates.surface.txt — the gate set is not recorded, so a gate that vanished would not be visible';
  console.log(`\nFAIL  surface: ${surfaceFail} (run \`node tools/gates.mjs --record\`)`);
}

/* ---------- the verdict ---------- */
const bad = fails.length + (surfaceFail ? 1 : 0);
if (only) {
  console.log(`\ngates: PARTIAL RUN (--only ${only}) — ${results.length} gate(s) run, ${bad} failure(s). This is not a full green: run without --only.`);
  process.exit(1); // by design: a partial run can never report "all gates green"
}
console.log(`\ngates: ${results.length - fails.length}/${results.length} passed by exit code${surfaceFail ? ', surface NOT acknowledged' : ', surface acknowledged'}`);
process.exit(bad ? 1 : 0);
