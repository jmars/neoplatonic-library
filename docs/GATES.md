# The gate runner — every gate, from one command

    node tools/gates.mjs             # run every gate, print each one's exit code, compare the recorded surface
    node tools/gates.mjs --record    # re-record the surface (after a deliberate change), then run
    node tools/gates.mjs --no-build  # the gates only (the two build steps skipped)
    node tools/gates.mjs --only NAME # one gate while iterating — a run that CANNOT report "all gates green"

## Why it exists

Twelve gates stayed green while the served reading view read `supermundaneessential`,
and `tools/echo-probe.mjs` sat **red at 1.0.4, 1.0.5, 1.0.6 and 1.0.7** (68 OK, 1 FAIL,
naming `r11693`) while four units reported "14/14" and "15/15 gates green by exit code" —
because each unit ran the gates it happened to remember. **A gate nobody runs is a gate
that does not exist.** "All gates green" must mean *the gates that are there*, so the
runner takes its list from the directory and **prints it**: the printed list is the
evidence, and it is what a report should paste.

## What counts as a gate

Discovered from the directory, never from a list in the runner (a list goes stale the
moment someone adds a gate):

1. **The build** — `build/build.mjs`, then `tools/build-reader.mjs`. Fixed and ordered,
   because every page-reading gate below reads what they write.
2. **The named gates** — every `tools/*-probe.mjs`, `tools/*-selftest.mjs` and
   `tools/*-smoke.mjs`.
3. **The self-test gates** — every other `tools/*.mjs` whose **source** mentions
   `--self-test` (the convention for a tool that carries its own regression battery:
   `fullread`, `repair`, `merge`, `vocab`). This is what catches a gate whose name does
   not announce it.

MEASURED 2026-10-08, on the tree that shipped the Theology of Plato's 1.0.8: **23 gates**
(2 build, 21 gates). `tools/gates.surface.txt` is the recorded surface.

## What it prints, and what it refuses

Per gate: `PASS|FAIL  rc=<n>  <seconds>  <command>`, then that gate's own last output line;
the whole tail of any failure is printed after the run. The exit status of the runner is
non-zero if any gate failed **or** if the surface is not what `tools/gates.surface.txt`
records.

**A gate that stops existing is a failure.** The surface file is the record, and a gate
that has *vanished* from the directory (renamed, deleted) is reported by name — a gate may
not quietly stop existing. A gate that *appears* is reported too, so the record is updated
deliberately (`--record`) rather than by accident.

## How it is known to be able to fail

- **A probe nobody listed.** On a `/var/tmp` copy holding only the runner and one probe
  that exists nowhere in the repository, the runner found it, named it, marked it `FAIL`
  and exited 1.
- **A vanished gate.** Deleting a recorded gate makes the runner print
  `1 gone (node tools/aaa-fine-probe.mjs)` and exit 1.
- **A partial run is never green.** `--only` always exits 1, by design.

## The lesson, kept

The fix that made `echo-probe` green at 1.0.8 was **not** a relaxation: no expectation in
it was touched, and on a fixture whose review flag is removed again it names the rule and
fails. A probe relaxed to pass is worse than a red one; a probe nobody runs is the same
thing with better manners.
