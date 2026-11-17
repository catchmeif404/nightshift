# TK-458 second comparison, phase 1: pre-registration (FROZEN 2026-11-17, before the first measured run)

**Status: frozen.** The owner settled the two open inputs on 2026-11-17 (the two tasks and the exact request and ticket wording;
see "Tasks"). This file is committed in its own commit before any measured run. Anything that changes after the first
measured run goes under "Deviations" at the bottom, with the reason.

## Question and non-claims

Phase 1 of 2. It measures (a) how much the same arm varies when the same real task is repeated (noise), (b) an
interactive baseline that looks like how the owner actually works, and (c) what that implies for the sample size of phase 2.
It is **exploratory**: it cannot show that nightshift is better, cheaper or faster, and no number from it may be used to claim so.
Phase 2 (the real experiment) and any product change are out of scope here.

## Arms (3)

| arm | what runs | what is typed |
|---|---|---|
| **B0** | interactive `claude --model sonnet --permission-mode auto` in a tmux window | the owner's usual-style request, once, verbatim from the session log |
| **B2** | the same interactive setup | the real ticket text, once |
| **A2** | nightshift, builder `sonnet`, reviewer `opus`, `maxRework 1`, default rules plus the operating `rules.md` Building and Reviewing parts | the real ticket text via `nightshift add` |

Not used: `claude -p`, ticket-style text for B0. A2 runs from a scratch root `/tmp/ns-bench2/<id>/q` with its own state and a
local-md board. The operating runner, the Notion board, the launchd service and the main checkouts are never touched.

## Interactive protocol (B0, B2) — `bench/scripts/interactive.mjs`

- The folder-trust dialog is answered before the request is typed and is **not** an intervention.
- "Finished" = a Stop hook, registered only for the experiment through `--settings`, appended a line to a marker file.
- On the first Stop, if Claude's last text ends in a question or the repo has no change, the fixed text
  `알아서 판단해서 끝까지 진행해` is sent **once** and recorded as **1 human intervention**. Claude's multiple-choice question window fires no Stop:
  it is closed with Esc and the same fixed text is sent (same single use). A second question is left unanswered and flagged.
- A permission dialog is recorded as one intervention each time and approved with Enter.
- No progress (screen and session log both unchanged) for 3 minutes = `stalled`. 20 minutes per run = `timeout`.
  A usage-limit banner = `usage_limit`. All of them stay in the data.
- Everything the person did not have to do (committing) is done by the harness as a snapshot commit before grading.
- The user's normal Claude settings apply in all three arms (they contain extra allow rules); they are not changed.

## Tasks (2) and the hidden tests

Selection rule, fixed before looking at any result: a real past commit of our own repositories whose pre-fix code is the start
point, whose request by the owner exists as a real message in `~/.claude/projects`, and which has a Notion ticket text;
5 to 20 minutes of work; fast tests; first two eligible items in the order the owner asked for them (no choosing by outcome).
Task content, the owner's message text, the ticket text, the hidden tests and all raw results stay **private**
(`~/.local/share/catchmeif404/nightshift-bench/`); this repository holds only the harness and aggregate numbers. Hidden tests
are never copied into a run; they are split into **core** (behaviour knowable from the owner's usual-style request alone) and
**detail** (only in the ticket's 완료 조건). A grader receives only a repository path (blind to the arm).

| id | what it is (public description only) | hidden tests |
|---|---|---|
| A | a small authenticated REST endpoint in a Java/Spring Boot service (rename a resource the caller owns); real HTTP against the booted app on an in-memory H2 database | core 2, detail 5 |
| B | a Python report and dashboard change (add a per-candidate outbound search link, cleaned search words, KO/EN text, notification line); the grader reads the generated report, the dashboard HTML and the notification preview | core 4, detail 9 |

Fixed by the owner on 2026-11-17 (no change during the experiment): the two tasks, the B0 request text and the B2/A2 ticket text
per task. Which two tasks was **not** chosen by looking at results: they are the owner's decision after the earlier search found
no other task with a stand-alone first message. The hidden-test split: *core* = behaviour that the usual-style request alone
implies (the change works for the caller, shows up where asked, is URL-encoded, sends nothing to the external site);
*detail* = things only the ticket's 완료 조건 states (trimming, length limits, rejecting other users' resources, cleaning rules,
EN text, notification line).

Grader validation (done before the first measured run, not counted): each grader gives 0 core / 0 detail (task A) and 1 of 4 /
1 of 9 (task B; the "no request to the external site" check passes at the start by construction) on the start code, and full
marks on the real merged change of that task. Known quirk: for task B the owner-fixed start commit is two merged pull requests
older than the parent of the real change (one of them added a first manual search link); the ticket text matches either state and
the start was kept as the owner fixed it. The result: task B asks all arms for slightly more than the original change did.

## Plan: 2 tasks x 3 arms x 4 repeats = 24 runs

Order is a seeded shuffle (`node scripts/schedule-v2.mjs 458 <taskA>,<taskB>`, seed 458), sequential, never concurrent, anon ids hide the arm.
A failed, stalled, timed-out or usage-limited run stays in the data and is not re-run. If a usage limit is reached, the run is
recorded `usage_limit` and the schedule waits for the stated reset; no usage increase or new payment.

## Measures

- core and detail hidden-test pass rates (per run and pooled).
- price-weighted cost = input x1 + output x5 + cache write x1.25 + cache read x0.1 (ratios in `config/prices.json`), plus the four
  raw token sums (de-duplicated by message id, from the raw session logs) shown separately. A missing log gives `null`, never 0.
- wall-clock seconds, human interventions (count and kind), rework rounds (A2 only; B0/B2 have none: `null`),
  ticket-writing cost = **not measured** unless a record exists.
- the TK-454 six runs are recomputed with the same weights: `node scripts/cost.mjs` (`results/weighted-tk454.md`).

## Analysis and the phase-2 sample size

`node scripts/analyze2.mjs` writes per task x arm n, outcomes, pass rates, mean/sd/coefficient of variation (CV) of the weighted cost,
and `plan`: runs per arm for a 10 % and a 20 % difference in cost, `n = 2 (z_a + z_b)^2 CV^2 / d^2` (two-sided alpha 0.05, power 0.80,
normal approximation), and for a pass-rate difference of 20 or 30 points around the observed core rate. With 4 repeats a CV is
itself very uncertain; the report shows both the median and the largest observed CV.

## Fixed conditions

Claude Code 2.1.326, model alias `sonnet` for B0/B2 and the A2 builder, `opus` for the A2 reviewer, nightshift 0.2.0 (the installed
operating build), A2 `maxRework 1`, `maxSlots 1`, `maxStageTries 1`; rules = default rules plus the Building and Reviewing parts of the
operating `rules.md`. One run at a time, never concurrent; scratch work under `/tmp/ns-bench2`; each run starts from a fresh
clone of the start commit with `origin` removed. No new payment or limit increase.

## Stop rules

20 minutes per run (`timeout`); 3 minutes without progress (`stalled`); a usage-limit banner ends the run as `usage_limit` and the
schedule waits for the stated reset (still no new payment); a run that errors is recorded as `error`. None of these is re-run or
dropped. If the whole plan cannot finish (a limit that does not reset within a day, the machine unavailable), the rest is reported
as **not run**, not estimated.

## Verification of the harness (done, not part of the measured data)

On a tiny toy task (smoke runs, not counted): Stop hook decision (`stops: 1`, finished), question handling (Claude asked, the fixed
text was sent once, `interventions: 1`, `stops: 2`), session-log token collection for interactive sessions, the 3-minute stall rule
(Claude's question window), `run-v2.mjs` end to end for B0 and A2 with a grader. Not yet exercised on a real task: permission
dialog detection, the usage-limit banner, the 20-minute timeout, B2.

## Deviations

All of these were found while running; none depends on a result of the model or of nightshift. Details and numbers: `REPORT-v2.md`.

1. **Harness defects fixed during the runs** (each fix is in the same PR, `interactive.mjs`, `run-v2.mjs`, `run-plan-v2.mjs`):
   - Claude's multiple-choice question window (here: "what should the new DTO file be called", asked because the owner's global guide says to ask before naming files)
     was not recognised (its footer reads `↑/↓ to navigate`, the regex knew `Tab/Arrow keys`), and the tail check looked at the last 16 screen lines, which are empty on a 50-row
     pane. The planned handling (Esc + the fixed text once, 1 intervention) did not happen and the run ended `stalled`: r2-002, r2-005, r2-006, r2-012.
   - The folder-trust dialog was answered with a blind Down+Enter; a lost key or a half-drawn dialog made Enter take the default "No, exit", so Claude ended before the request was
     typed (`error`, "did not become ready", no session tokens): r2-016, r2-019, r2-020, r2-030, r2-031, r2-033. Now the cursor is checked on "Yes" before Enter.
   - The plan runner waited for the child's stdout pipe, which a detached nightshift process kept open (r2-011 finished at 02:08 but the plan sat until 02:33). It now waits for the exit.
   - `run.json` keeps the last screen and the interactive record only from r2-005 on.
2. **Replacement runs.** For the 10 runs in item 1 the same task x arm cell was run again (r2-025 to r2-034; r2-030, r2-031 and r2-033 were themselves replacements that hit the trust-dialog defect and were
   replaced again). 34 runs exist instead of 24. The originals are not deleted and not hidden: `REPORT-v2.md` shows the table **as recorded** (all 34) and the table with the defective runs replaced (24; 4 per cell).
   The replacements ran after the main pass in a fixed order, not shuffled, with the fixed harness, so they are later in time than most of the originals.
3. **Not exercised in any measured run:** the permission-dialog detection, the usage-limit banner and the 20-minute timeout never occurred (0 each).
4. Interventions: every question window counts as 1 intervention (the fixed text), nothing else occurred.
5. Ticket-writing cost: no record exists, **not measured**.
