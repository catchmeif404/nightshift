# TK-461 third comparison: pre-registration (FROZEN 2026-11-17, before the first measured run)

**Status: frozen.** This file is committed in its own commit before any measured run. Anything that changes after the first measured run goes under "Deviations" at the bottom, with the reason.

## Question and non-claims

In TK-458 the nightshift arm (A2) split into a development stage that cost about the same as, or less than, an interactive session, and an Opus review (45 to 57 % of the total; a separate session that
reads the repository from the start; up to 26 turns and 1.6 million re-read tokens). The owner chose two ways to shrink the review and asked to try only these two (a review turn cap is **out of scope**):

1. **Handoff**: the reviewer gets the developer's change summary, the changed files and the test results, so it does not survey the repository again.
2. **Sonnet review**: the reviewer model is Sonnet instead of Opus.

This is **exploratory**. It cannot show that either way is better, cheaper, faster or equally good, and no number from it may be used to claim so. Cost and time come with their spread; the review-quality part has
two repeats per cell and says only what happened. Whether to switch either option on in operation is the owner's decision after the report; this work changes no operating setting.

## Arms (3, all nightshift, same ticket text as TK-458 A2)

| arm | builder | reviewer | handoff (`reviewHandoff`) |
|---|---|---|---|
| **A2** | sonnet | opus | off |
| **A3** | sonnet | opus | **on** |
| **A4** | sonnet | **sonnet** | off |

All: `maxRework 1`, `maxSlots 1`, `maxStageTries 1`, default rules plus the Building and Reviewing parts of the operating `rules.md` (the same private file as TK-458), a scratch root `/tmp/ns-bench3/<id>/q` with its own
state and a local-md board. The operating runner, the Notion board, the launchd service and the main checkouts are never touched.

**What the handoff is** (the nightshift option `reviewHandoff`, default off): the developer's prompt asks for a short handoff file (summary, changed files, the test commands run and their results) before the result file; the
reviewer's prompt then carries that file's text and git's own list of files changed against the base branch, and says to start from these instead of surveying the repository, while still running the tests and judging against the ticket.
With the option off, both prompts are byte-for-byte the ones of the version before the option (a unit test compares them with prompts generated from the code before the change).

**The build under test** is this repository's build of nightshift (the branch of this ticket), not the installed 0.2.0, because only it has the option. With the option off its prompts equal 0.2.0's, so the TK-458 A2 runs are a valid baseline for A2 here.

## Tasks

The same two tasks, **A** and **B**, as TK-458 (same start commits, same ticket text, same hidden tests; private, see PREREGISTRATION-v2.md), because the owner asked for them. Task data, hidden tests and raw results stay private.

## Part 1: full runs (cost, time, pass rates)

- 20 runs: per task **A3 x4, A4 x4, A2 x2**. The 8 TK-458 A2 runs (4 per task, all finished, 0 rework) are the **baseline** (`A2-0458` in the tables); the 4 new A2 runs are the **same-day rerun** that shows how much a different day alone moves the numbers.
- Measures per run: core and detail hidden-test pass counts; price-weighted cost = input x1 + output x5 + cache write x1.25 + cache read x0.1 (`config/prices.json`; Opus and Sonnet tokens are weighted the same, so this is token weight, **not money**;
  a Sonnet review is therefore not priced lower by this measure, which is stated in the report next to the numbers); the same split **per stage** (builder sessions, reviewer sessions; the stage of a session is read from its first prompt);
  stage time = first to last log line of the stage's sessions (summed), wall-clock total; reviewer turns (assistant messages, de-duplicated by message id); rework rounds; which model each stage really used (from the logs).
  A missing log gives `null`, never 0. For the baseline, stage numbers are recomputed from the TK-458 Claude logs.
- Tables: per task x arm, with the CV of the weighted cost. No significance tests: with 2 to 4 runs a cell, differences are shown, not tested.

## Part 2: review quality on planted defects ("noise rate")

A review of an easy change has nothing to do, so each task gets **three changes with a known defect**, made from the real merged change of that task (which passes all hidden tests) with exactly one defect planted:

| defect | what it is (public description) | what the repository's own tests do |
|---|---|---|
| **build** | a reference to a name that does not exist, in the main code | the build / the tests fail |
| **missing** | one requirement of the ticket's 완료 조건 is not implemented (and its own test removed) | all pass |
| **hidden** | a subtle behaviour error that the repository's own tests do not catch | all pass |

Task A (Java service): a missing enum constant; the 1-to-20 length check dropped; the length counted in UTF-16 units instead of characters. Task B (Python): an import of a name that does not exist; the link left out of the Telegram candidate lines
(an explicitly named place); the link shown only for one of the three "price unchecked" states. All six were checked before the first measured run: `build` fails the repository's tests, the other four pass them.
The patches stay private (they are task data).

- Each of the 3 changes goes to the reviewer of **A2, A3 and A4, 2 times each**: 2 tasks x 3 defects x 3 arms x 2 = **36 reviews**.
- The developer is a **stand-in script** (no model): it applies the planted change as one commit and, when the prompt asks for a handoff, writes a fixed-template handoff: a one-line summary taken from the ticket title, the changed files from git, and
  "ran the project's test suite; everything passed". That is what a developer who did not notice the defect would write; it is the same text for all three defect kinds, so for `build` the claim is false. Only A3 receives it.
- A review's decision, from the first review round's verdict and the branch:
  **returned** = verdict REWORK, BLOCKED or NEEDS_HUMAN (the change is not accepted as it is; the ticket's name for this share is "잡음률"; it is the rate at which a known-defective change is sent back, so **higher is better here**);
  **fixed_and_passed** = PASS, but the reviewer committed to the branch (it repaired the defect or something else itself, as its prompt allows for small problems);
  **passed** = PASS with no change. Round 2 of a sent-back change never runs: the stand-in only writes BLOCKED.
  Anything else (`timeout`, `error`, no verdict) is **other** and stays in the table.
- Also recorded per review: the reviewer's cost, time and turns (an A3 or A4 review of a clean change would be cheaper; this part gives cost on defective changes only).
- Not done: no control with a clean change (so a reviewer that returns everything would look perfect; the report says so), no check of **why** a change was returned (the reviewer's text is not graded), and no more than 2 repeats per cell.

## Plan and order

`node scripts/schedule-v3.mjs 461 <taskA>,<taskB>`: a seeded shuffle (seed 461) of all 56 cells (20 runs + 36 reviews), sequential, never concurrent, anon ids `r3-001`... hide the arm. Resumable (`scripts/run-plan-v3.mjs`).
Scratch folders under `/tmp/ns-bench3`; each run starts from a fresh clone of the start commit with `origin` removed. Raw results: `$BENCH_RESULTS_V3`, private. Aggregates: `results-v3/` (`runs.csv`, `reviews.csv`, `summary.json`, `summary.md`), reproduced with `node scripts/analyze3.mjs`.

## Harness defects (reported as in TK-458)

A run that ends because of the harness (a tmux or process failure, a scratch-folder error; not because of the model or nightshift) is a **harness-defect run**: it is listed with its reason in `harness-defects.json` of the private results, **kept in the data**, and the same cell is run again once the harness is fixed.
The report shows **two tables**: the valid runs (defect runs left out) and the runs as recorded (everything). A run that merely fails the task (blocked, tests failing, wrong answer) is **not** a harness defect and stays in both. A review that ends `timeout` stays a result.

## Fixed conditions

Claude Code 2.1.326, aliases `sonnet` and `opus` as in TK-458, `claude --permission-mode auto` (nightshift's default), the owner's normal Claude settings. One run at a time; no new payment or limit increase. If the usage limit is reached, the plan waits (30 minutes) and goes on with the next cell; a cell the limit stopped stays in the data.

## Stop rules

20 minutes per full run, 15 per review run (`timeout`, counted as the outcome, not re-run); `maxStageTries 1`: a cut-off stage ends the ticket `blocked`. If the whole plan cannot finish, the rest is reported as **not run**, not estimated.

## Verification of the harness (done before this freeze, not counted)

One planted-defect review (A3, hidden, task A) and two full runs (A4 and A3, task A) as smoke runs (`r3-smoke-*`, left out of every table): the stand-in developer, the handoff written by the real developer and reaching the reviewer, per-stage cost and time, the reviewer model read from the log,
the decision rule. `node --test scripts/analyze3.test.mjs` (schedule and aggregation). The six planted changes were checked against the repositories' own tests as described above.

## Deviations

(none yet)
