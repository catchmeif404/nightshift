# bench: nightshift ON/OFF paired pilot (TK-454)

Reproduction material for the pilot described in [REPORT.md](REPORT.md). Not a product feature: nothing here is imported by
`src/`, and it is not part of the published package (`files` in package.json excludes it).

- `PREREGISTRATION.md` tasks, scoring and stop rules, committed before the first run.
- `fixture/` the identical start code. `tasks/` the ticket text. `grader/` hidden acceptance tests (never copied into a run).
- `scripts/` `run-one.mjs` (one run), `finish-run.mjs` (usage collection + blind grading), `analyze.mjs` (tables), `run-all.sh` (fixed order).
- `results/` `runs.csv`, `summary.json`, `summary.md`, `raw/<id>.json` (+ `.patch`), `usage/<id>.jsonl` (de-duplicated usage rows, no message text), `runs/<id>.json` (arm key and timing).

## Reproduce

Needs: Node >= 20, git, a signed-in `claude` CLI (no API key; it uses your current plan, so it spends some of its usage:
about 6 short runs), and nightshift installed (`NIGHTSHIFT_CLI` = path to its `dist/src/cli.js`, default
`~/.local/share/nightshift/app/dist/src/cli.js`). Pilot versions: nightshift 0.1.0, Claude Code 2.1.318 (Claude Code).

```sh
cd bench
./scripts/run-all.sh                 # 6 runs, sequential, scratch repos under /tmp/ns-bench (BENCH_WORK to change)
node scripts/analyze.mjs             # recomputes runs.csv, summary.json, summary.md from results/raw/*.json
```

Run one by hand: `node scripts/run-one.mjs t1 ON r-xxxx && node scripts/finish-run.mjs r-xxxx`. Re-running overwrites the files of
the same id; use new ids for a new sample. Never point it at an operational queue or repository.

## Second comparison, phase 1 (TK-458): interactive harness

`PREREGISTRATION-v2.md` (frozen before the first measured run). Generic, task-independent tools:

- `scripts/interactive.mjs` drives one interactive `claude` in a tmux window like a person typing one request (Stop-hook finish, one fixed
  nudge, permission/question dialogs, stall and time limits) and writes `interactive.json`.
- `scripts/run-v2.mjs <task> <B0|B2|A2> <id>` runs one cell; task data and raw results are private (`$BENCH_PRIVATE`, default
  `~/.local/share/catchmeif404/nightshift-bench/v2`), see the header of the file for the `task.json` format.
- `scripts/schedule-v2.mjs` seeded run order; `scripts/cost.mjs` price-weighted cost (`config/prices.json`; also recomputes TK-454 into
  `results/weighted-tk454.md`); `scripts/analyze2.mjs` per-arm spread (CV) and phase-2 sample sizes; `scripts/stats.test.mjs` tests
  (`node --test scripts/stats.test.mjs`). Needs tmux and a signed-in `claude`.
