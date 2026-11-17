# TK-458 phase 1: noise and interactive baseline (exploratory)

**This is exploratory.** Two tasks, three arms, four repeats per cell, one machine, one day. It supports **no claim** that nightshift (A2) or any arm is better, cheaper or faster.
It exists to measure how much the *same* arm varies on the same real task, and to size phase 2. Task code, the owner's messages and raw results are private (not in this repository);
tasks are called A and B. Plan and rules: [PREREGISTRATION-v2.md](PREREGISTRATION-v2.md) (frozen before the first run; deviations at its end). Data: `results-v2/` (`runs.csv`, `summary.json`, `summary.md`).

Arms: **B0** interactive `claude` (sonnet, auto mode) with the owner's usual-style request once; **B2** the same with the real ticket text once; **A2** nightshift (builder sonnet, reviewer opus,
maxRework 1, default rules plus the operating Building/Reviewing rules) with the ticket text. Claude Code 2.1.326, nightshift 0.2.0.

## What happened (read this first)

34 runs were executed, not 24. 10 of them were ended by **harness defects**, not by the model or nightshift: 4 `stalled` (a question window the harness did not recognise) and 6 `error`
(Claude was closed by the trust-dialog handling before the request was typed). Each was re-run in the same cell (see Deviations 1-2 in the pre-registration). Nothing was deleted;
both views are below. Permission dialogs, the usage limit and the 20-minute timeout never occurred. Ticket-writing cost: **not measured** (no record). A2 needed 0 rework rounds in all 8 runs.

## Table 1: the 24 planned cells' valid runs (defective runs replaced), 4 per cell

Weighted cost = input x1 + output x5 + cache write x1.25 + cache read x0.1 (token-type ratios only; **Opus and Sonnet tokens are weighted the same**, so A2 is not a price in money).
core = pass / total over the 4 runs (task A: 2 core and 5 detail tests per run; task B: 4 and 9).

| task | arm | core | detail | weighted cost mean | CV | wall s median | interventions mean | rework mean |
|---|---|---|---|---|---|---|---|---|
| A | A2 | 8/8 | 20/20 | 213,733 | 0.07 | 192 | 0 | 0 |
| A | B0 | 8/8 | 16/20 | 171,214 | 0.22 | 92 | 1.00 | n/a |
| A | B2 | 8/8 | 20/20 | 149,471 | 0.16 | 126 | 0.75 | n/a |
| B | A2 | 16/16 | 32/36 | 445,815 | 0.09 | 668 | 0 | 0 |
| B | B0 | 16/16 | 20/36 | 178,856 | 0.10 | 262 | 0 | n/a |
| B | B2 | 16/16 | 34/36 | 468,535 | 0.21 | 544 | 0.25 | n/a |

What can be seen without a claim: the core tests (the behaviour the usual-style request implies) passed in every valid run of every arm, so the core rate is at its ceiling and cannot separate arms.
The detail tests (only in the ticket's 완료 조건) were lower for B0 on both tasks (16/20 and 20/36); B2 and A2 got them nearly all. Cost and time per run differ by 2-3x between tasks, much more than the CV within a cell.

## Table 2: as recorded (all 34 runs, defective runs included)

| task | arm | n | outcomes | core | detail | cost mean (n used) | CV |
|---|---|---|---|---|---|---|---|
| A | A2 | 4 | finished 4 | 8/8 | 20/20 | 213,733 (4) | 0.07 |
| A | B0 | 8 | finished 4, stalled 1, error 3 | 8/16 | 16/40 | 156,124 (5) | 0.30 |
| A | B2 | 6 | finished 4, stalled 2 | 8/12 | 20/30 | 123,141 (6) | 0.36 |
| B | A2 | 4 | finished 4 | 16/16 | 32/36 | 445,815 (4) | 0.09 |
| B | B0 | 5 | finished 4, error 1 | 17/20 | 21/45 | 178,856 (4) | 0.10 |
| B | B2 | 7 | finished 4, stalled 1, error 2 | 19/28 | 37/63 | 389,247 (5) | 0.50 |

`error` runs have no session, so their cost is empty (not 0) and they are left out of the cost mean; their pass counts are those of the unchanged start code.

## Spread and phase-2 sample size

Coefficient of variation of the weighted cost, 4 runs per cell: median **0.13**, largest **0.22** (Table 1). With 4 runs a CV is itself very uncertain. Runs per arm for
two-sided alpha 0.05, power 0.80, normal approximation `n = 2 (z_a + z_b)^2 CV^2 / d^2` (per task; a pooled design with a task effect needs its own calculation):

| difference in cost to detect | by median CV 0.13 | by largest CV 0.22 |
|---|---|---|
| 10 % | 26 | 76 |
| 20 % | 7 | 19 |

Pass rates: the core rate is 100 % here, so a difference around it cannot be sized. Around the pooled detail rate (0.86): a 20-point difference needs about **42** runs per arm, a 30-point difference about **21** (the two rates are kept exactly 30 points apart inside 0.02-0.98; an earlier version clipped the upper rate at 0.98, which sized a 26.5-point difference and gave 25).
(Table 2 gives larger numbers because the defective runs inflate the spread; they are not the right input.)

## Limits

Two tasks chosen by the owner, 4 repeats, one operator. Replacement runs came later in time than the originals and used the fixed harness. The price weighting ignores model prices. Task B's start is two merged
pull requests older than the parent of the real change. The graders are hidden black-box tests written by us and validated only on the real merged change (full marks) and on the start code (near zero), not independently reviewed.
The harness drives a terminal by screen text; new dialog texts can break it (it did, three times). No result here supports a superiority or saving claim.

## TK-454 recomputed with the same weights

`node scripts/cost.mjs` (`results/weighted-tk454.md`): ON/OFF price-weighted ratio 1.06-1.10 per task, median **1.07**, against 1.17-1.34 (median 1.23) on raw total tokens.
`node scripts/analyze.mjs` still reproduces the TK-454 tables unchanged.

## Reproduce the tables

```sh
cd bench
node scripts/analyze2.mjs <private results dir> results-v2   # needs the private run records; the aggregates are in results-v2/
node --test scripts/stats.test.mjs
node scripts/cost.mjs
```
Run the plan: `node scripts/schedule-v2.mjs 458 <taskA>,<taskB>` shows the order; `node scripts/run-plan-v2.mjs 458 <taskA>,<taskB>` runs it (resumable, sequential).
