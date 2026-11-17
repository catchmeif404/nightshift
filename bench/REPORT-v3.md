# TK-461: does a reviewer handoff or a Sonnet reviewer make the nightshift review cheaper? (exploratory)

**This is exploratory.** Two tasks, 2 to 4 full runs per cell, 2 reviews per planted-defect cell, one machine, one day. It supports **no claim** that either option is cheaper, faster, better or as good, and no number below may be used to claim so.
The owner decides after this report whether to switch either option on; nothing operating was changed (the option `reviewHandoff` exists and is **off by default**). Plan, definitions and deviations: [PREREGISTRATION-v3.md](PREREGISTRATION-v3.md)
(frozen in its own commit before the first measured run). Data: `results-v3/` (`runs.csv`, `reviews.csv`, `summary.json`, `summary.md`), reproduced by `node scripts/analyze3.mjs <taskA>,<taskB>` from the private raw results. Tasks are called A and B as in TK-458.

Arms (builder sonnet, `maxRework 1`; Claude Code 2.1.326; nightshift = this repository's build): **A2** reviewer opus, no handoff; **A3** reviewer opus + handoff (`reviewHandoff`); **A4** reviewer sonnet, no handoff. `A2-0458` = the 8 TK-458 A2 runs (baseline, run earlier the same day, stage numbers recomputed from their logs);
`A2` = the new same-day rerun (2 per task).

## What happened (read this first)

- 56 planned cells (20 full runs, 36 reviews) ran in a seeded order, 4 replacement cells after them: **60 runs**. **4 of them are harness defects**: r3-032 to r3-035 hit the account's 5-hour **usage limit** (the plan runner did not recognise it, so the cells stalled until their time limit). They were kept, flagged, and the same four cells were run again after the reset
  (r3-057 to r3-060). The tables are therefore shown twice, as in TK-458: **valid runs** (defect runs left out) and **as recorded** (everything). Details: Deviations 1 in the pre-registration.
- **4 full runs of task B ended at the 20-minute limit** (`timeout`): r3-037 (A4), r3-052 (A2), r3-056 (A4) are valid results (the limit had been reset; the builder alone needed 800 to 970 s); r3-034 (A3) is one of the harness-defect runs. A timed-out run is graded as it stands and its cost and time are **lower bounds** (for the two A4 ones and for r3-052 (A2) the review itself was cut off; r3-052's review had run 18 s and 4 turns).
  The TK-458 baseline had no timeout in 4 runs of B; this time 3 of the 10 valid new B runs ended so, and the builder stage of B was far slower than in the baseline (see the A2 row).
- **Date check (the same-day A2 rerun against the TK-458 A2 runs)**: task A total cost 216,756 vs 213,733 (+1 %), builder 124,030 vs 118,348, reviewer 92,727 vs 95,385; wall 216 s vs 192 s. Task B total cost 434,879 vs 445,815 (-2 %), but the split moved a lot: builder 323,757 vs 190,269, reviewer 111,122 vs 255,546 (turns 6.5 vs 20.3; the rerun's reviewer number includes r3-052, whose review the 20-minute limit cut after 18 s; the other rerun alone: 146,649, 9 turns),
  wall 1,077 s vs 668 s (one of the 2 reruns timed out). With 2 reruns and 4 baseline runs that says only this: **the stage split and the time of the same arm differ a lot between the day-series on task B**, so differences between A3/A4 and `A2-0458` of that size cannot be told from a date or load effect.

## Table 1: full runs, valid (harness-defect runs left out)

Cost is price-weighted tokens (input x1, output x5, cache write x1.25, cache read x0.1); **Sonnet and Opus tokens weigh the same**, so a Sonnet review is not cheaper in money terms by this measure, only in tokens and time. "Reviewer share" is the mean of reviewer cost / total cost per run. Time is first to last log line of the stage's sessions.
core / detail = hidden tests passed / total over the runs of the cell. A run that timed out is included with the code it had.

| task | arm | n | outcomes | core | detail | cost mean (CV) | builder cost | reviewer cost | reviewer share | reviewer turns | wall s median | builder s median | reviewer s median | rework mean |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | A2 | 2 | finished 2 | 4/4 | 10/10 | 216,756 (0.06) | 124,030 | 92,727 | 43 % | 7.50 | 216 | 130 | 77 | 0.00 |
| A | A2-0458 | 4 | finished 4 | 8/8 | 20/20 | 213,733 (0.07) | 118,348 | 95,385 | 44 % | 7.00 | 192 | 79 | 106 | 0.00 |
| A | A3 | 4 | finished 4 | 8/8 | 20/20 | 245,328 (0.08) | 146,697 | 98,631 | 40 % | 7.50 | 501 | 231 | 241 | 0.00 |
| A | A4 | 4 | finished 4 | 8/8 | 20/20 | 185,717 (0.02) | 122,722 | 62,995 | 34 % | 5.00 | 271 | 117 | 105 | 0.00 |
| B | A2 | 2 | finished 1, timeout 1 | 8/8 | 17/18 | 434,879 (0.13) | 323,757 | 111,122 | 25 % | 6.50 | 1,077 | 835 | 212 | 0.00 |
| B | A2-0458 | 4 | finished 4 | 16/16 | 32/36 | 445,815 (0.09) | 190,269 | 255,546 | 57 % | 20.25 | 668 | 280 | 375 | 0.00 |
| B | A3 | 4 | finished 4 | 16/16 | 32/36 | 449,783 (0.17) | 268,549 | 181,235 | 40 % | 12.25 | 850 | 449 | 391 | 0.00 |
| B | A4 | 4 | finished 2, timeout 2 | 16/16 | 32/36 | 339,822 (0.07) | 255,545 | 84,277 | 25 % | 5.50 | 1,191 | 966 | 200 | 0.00 |

## Table 2: full runs, as recorded (the defect run r3-034 included)

| task | arm | n | outcomes | core | detail | cost mean (CV) | builder cost | reviewer cost | reviewer share | reviewer turns | wall s median | builder s median | reviewer s median | rework mean |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | A2 | 2 | finished 2 | 4/4 | 10/10 | 216,756 (0.06) | 124,030 | 92,727 | 43 % | 7.50 | 216 | 130 | 77 | 0.00 |
| A | A2-0458 | 4 | finished 4 | 8/8 | 20/20 | 213,733 (0.07) | 118,348 | 95,385 | 44 % | 7.00 | 192 | 79 | 106 | 0.00 |
| A | A3 | 4 | finished 4 | 8/8 | 20/20 | 245,328 (0.08) | 146,697 | 98,631 | 40 % | 7.50 | 501 | 231 | 241 | 0.00 |
| A | A4 | 4 | finished 4 | 8/8 | 20/20 | 185,717 (0.02) | 122,722 | 62,995 | 34 % | 5.00 | 271 | 117 | 105 | 0.00 |
| B | A2 | 2 | finished 1, timeout 1 | 8/8 | 17/18 | 434,879 (0.13) | 323,757 | 111,122 | 25 % | 6.50 | 1,077 | 835 | 212 | 0.00 |
| B | A2-0458 | 4 | finished 4 | 16/16 | 32/36 | 445,815 (0.09) | 190,269 | 255,546 | 57 % | 20.25 | 668 | 280 | 375 | 0.00 |
| B | A3 | 5 | finished 4, timeout 1 | 17/20 | 33/45 | 449,783 (0.17) | 268,549 | 181,235 | 40 % | 12.25 | 896 | 413 | 391 | 0.00 |
| B | A4 | 4 | finished 2, timeout 2 | 16/16 | 32/36 | 339,822 (0.07) | 255,545 | 84,277 | 25 % | 5.50 | 1,191 | 966 | 200 | 0.00 |

What can be seen without a claim: the core and detail pass counts of A3 and A4 equal those of `A2-0458` in both tasks (A 20/20, B 32/36; the 4 missed detail tests of task B are the same kind in every arm). Task A, A3: the reviewer cost is the same as the baseline (98,631 vs 95,385), the reviewer's time is longer (241 s vs 106 s), the total is higher (245,328 vs 213,733),
and builder cost is higher too (146,697 vs 118,348), which the handoff does not touch except by asking for the handoff file. Task B, A3: reviewer cost 181,235 vs 255,546 and 12.3 vs 20.3 turns, but that is also the range between the baseline and the same-day A2 rerun (111,122, 6.5 turns), so it is not separable from the date.
A4: the reviewer takes fewer tokens and turns in both tasks (A 62,995 vs 95,385, 5.0 vs 7.0 turns; B 84,277 vs 255,546, 5.5 vs 20.3), and its time is similar to or lower than the baseline's; two of its four B runs were cut at the 20-minute limit, which makes B's A4 total and time lower bounds.

## Planted-defect reviews (the "noise rate" part)

Each task got three changes with one known defect (a build failure, a missing requirement of the 완료 조건, a hidden error that the repository's tests do not catch), each given 2 times to the reviewer of every arm; the developer is a stand-in script with a fixed handoff text that claims the tests passed (also for the build failure).
**returned** = the first verdict was not PASS; **fixed and passed** = PASS, but the reviewer committed a change to the branch; **passed** = PASS, nothing touched. A reviewer that fixes the defect and passes has not let it through in the usual sense, but it did not send the change back either: the "noise rate" of the ticket (returned share) counts only the first.
The fix was **not** checked for correctness. No control with a clean change was run, so a reviewer that returned everything would look perfect here.

### Per arm (valid runs)

| arm | n | returned | fixed and passed | passed | other | returned share | reviewer cost mean | reviewer s mean | reviewer turns mean |
|---|---|---|---|---|---|---|---|---|---|
| A2 | 12 | 6 | 5 | 1 | 0 | 50 % | 131,912 | 184 | 8.83 |
| A3 | 12 | 6 | 6 | 0 | 0 | 50 % | 121,862 | 218 | 7.42 |
| A4 | 12 | 4 | 6 | 2 | 0 | 33 % | 102,319 | 173 | 7.50 |

Per defect and arm:

| defect | arm | n | returned | fixed and passed | passed | other | returned share | reviewer cost mean | reviewer s mean | reviewer turns mean |
|---|---|---|---|---|---|---|---|---|---|---|
| build | A2 | 4 | 2 | 2 | 0 | 0 | 50 % | 121,465 | 155 | 8.00 |
| build | A3 | 4 | 2 | 2 | 0 | 0 | 50 % | 120,900 | 219 | 7.50 |
| build | A4 | 4 | 1 | 3 | 0 | 0 | 25 % | 98,162 | 145 | 8.00 |
| hidden | A2 | 4 | 2 | 1 | 1 | 0 | 50 % | 136,907 | 191 | 9.50 |
| hidden | A3 | 4 | 2 | 2 | 0 | 0 | 50 % | 127,896 | 225 | 8.00 |
| hidden | A4 | 4 | 2 | 1 | 1 | 0 | 50 % | 108,084 | 188 | 7.75 |
| missing | A2 | 4 | 2 | 2 | 0 | 0 | 50 % | 137,366 | 207 | 9.00 |
| missing | A3 | 4 | 2 | 2 | 0 | 0 | 50 % | 116,789 | 209 | 6.75 |
| missing | A4 | 4 | 1 | 2 | 1 | 0 | 25 % | 100,712 | 185 | 6.75 |

Per task, defect and arm:

| task | defect | arm | n | returned | fixed and passed | passed | other | returned share | reviewer cost mean | reviewer s mean | reviewer turns mean |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | build | A2 | 2 | 0 | 2 | 0 | 0 | 0 % | 84,069 | 141 | 7.00 |
| A | build | A3 | 2 | 0 | 2 | 0 | 0 | 0 % | 88,240 | 211 | 6.50 |
| A | build | A4 | 2 | 0 | 2 | 0 | 0 | 0 % | 73,864 | 139 | 6.50 |
| A | hidden | A2 | 2 | 0 | 1 | 1 | 0 | 0 % | 103,955 | 139 | 9.00 |
| A | hidden | A3 | 2 | 0 | 2 | 0 | 0 | 0 % | 92,978 | 212 | 7.00 |
| A | hidden | A4 | 2 | 0 | 1 | 1 | 0 | 0 % | 69,768 | 148 | 6.00 |
| A | missing | A2 | 2 | 0 | 2 | 0 | 0 | 0 % | 99,926 | 161 | 8.00 |
| A | missing | A3 | 2 | 0 | 2 | 0 | 0 | 0 % | 88,538 | 149 | 6.00 |
| A | missing | A4 | 2 | 0 | 2 | 0 | 0 | 0 % | 67,072 | 120 | 5.00 |
| B | build | A2 | 2 | 2 | 0 | 0 | 0 | 100 % | 158,861 | 169 | 9.00 |
| B | build | A3 | 2 | 2 | 0 | 0 | 0 | 100 % | 153,560 | 227 | 8.50 |
| B | build | A4 | 2 | 1 | 1 | 0 | 0 | 50 % | 122,461 | 152 | 9.50 |
| B | hidden | A2 | 2 | 2 | 0 | 0 | 0 | 100 % | 169,858 | 244 | 10.00 |
| B | hidden | A3 | 2 | 2 | 0 | 0 | 0 | 100 % | 162,814 | 238 | 9.00 |
| B | hidden | A4 | 2 | 2 | 0 | 0 | 0 | 100 % | 146,399 | 228 | 9.50 |
| B | missing | A2 | 2 | 2 | 0 | 0 | 0 | 100 % | 174,806 | 252 | 10.00 |
| B | missing | A3 | 2 | 2 | 0 | 0 | 0 | 100 % | 145,040 | 270 | 7.50 |
| B | missing | A4 | 2 | 1 | 0 | 1 | 0 | 50 % | 134,352 | 250 | 8.50 |

Same per arm, as recorded (the 3 review runs r3-032, r3-033, r3-035 that hit the usage limit included; they appear as `other`):

| arm | n | returned | fixed and passed | passed | other | returned share | reviewer cost mean | reviewer s mean | reviewer turns mean |
|---|---|---|---|---|---|---|---|---|---|
| A2 | 13 | 6 | 5 | 1 | 1 | 46 % | 123,967 | 171 | 8.23 |
| A3 | 12 | 6 | 6 | 0 | 0 | 50 % | 121,862 | 218 | 7.42 |
| A4 | 14 | 4 | 6 | 2 | 2 | 29 % | 102,319 | 148 | 6.43 |

Observations, no claim: in task A **no** reviewer of any arm sent a change back (18 of 18 reviews were fixed by the reviewer or passed; untouched passes: A2 1, A4 1, both `hidden`); in task B the reviewers of A2 and A3 sent back 6 of 6 each, A4 sent back 4 of 6 (one `build` fixed by the reviewer, one `missing` passed untouched). Over both tasks the returned share is A2 6/12, A3 6/12, A4 4/12; counting "returned or fixed" it is 11/12, 12/12, 10/12.
The A3 handoff text states "tests passed"; the reviewers of A3 did run the tests themselves and still returned or fixed the `build` change in 4 of 4, so the false claim did not hide it here. Reviewer cost per review on these changes: A2 131,912, A3 121,862, A4 102,319; time 184 s, 218 s, 173 s; turns 8.8, 7.4, 7.5.
With 2 repeats per cell, one different review moves a cell by 50 points.

## Limits

Two tasks and their start commits chosen by the owner for TK-458; 2 to 4 full runs per cell, 2 reviews per cell, no tests of significance. The same-day rerun shows a date or load effect of unknown size on task B, larger than the differences between arms. The token weight treats Opus and Sonnet alike. Three of the valid task-B runs hit the 20-minute limit, so their totals are lower bounds.
The planted defects are six, all ours; the stand-in developer's handoff is a template (a real developer's handoff would differ; the full-run A3 arm used real handoffs, see below). Reviewers' reasons for returning were not graded; task A's reviewers may fix rather than return because their prompt allows small fixes. The handoff in the A3 full runs was written by the real Sonnet developer; its cost is inside the builder stage (A3 builder cost is higher than the baseline's in both tasks, A 146,697 vs 118,348, B 268,549 vs 190,269, again inside the date spread).
Whether either option helps in operation is not shown here.

## Reproduce

```sh
npm run build                                  # the build under test: dist/src/cli.js (NIGHTSHIFT_CLI overrides)
cd bench
node scripts/schedule-v3.mjs 461 <taskA>,<taskB>      # the 56-cell order
node scripts/run-plan-v3.mjs 461 <taskA>,<taskB>      # run it (resumable, sequential; needs the private task data and a signed-in claude)
node scripts/analyze3.mjs <taskA>,<taskB>             # rebuilds results-v3/ and the tables above from the private raw results
node --test scripts/analyze3.test.mjs
```
