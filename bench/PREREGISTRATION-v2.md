# TK-458 second comparison, phase 1: pre-registration (DRAFT, not frozen)

**Status: no measured run has been made.** This file is committed before any run. The runs are **not started** because two
inputs the owner must settle are missing (see "Open decisions"). When they are settled, freeze this file in its own commit
(fill the `TBD` cells), then run. Anything that changes after the first run goes under "Deviations" at the bottom.

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

| id | start point | candidate |
|---|---|---|
| t1 | TBD (private) | nightshift `ticketSections` (public PR #4, base `91a5f0b`) |
| t2 | TBD (private) | nightshift `gatePaths` (public PR #5, base `848a977`) |

## Plan: 2 tasks x 3 arms x 4 repeats = 24 runs

Order is a seeded shuffle (`node scripts/schedule-v2.mjs 458 t1,t2`), sequential, never concurrent, anon ids hide the arm.
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

## Open decisions (why nothing was run)

1. **The owner's request is not a standalone message.** The nightshift work of 2026-11-16 (tickets TK-449 to TK-452) came out
   of one chat: the PM bot wrote the tickets from two short follow-up messages
   that only make sense with the earlier turns of that chat. No other eligible task was found: most tickets originate from
   Telegram or the PM bot and leave no owner message in `~/.claude/projects`. Using the follow-up verbatim makes B0 a test
   of guessing the missing context, and the key names of the hidden tests cannot be derived from it. The owner has to give
   (a) the two tasks and (b) for each, the message to type, before the core/detail split can be written honestly.
2. The hidden tests for the nightshift candidates must be black-box (CLI and config), not the PR's unit tests (those use internal functions).

## Verification of the harness (done, not part of the measured data)

On a tiny toy task (smoke runs, not counted): Stop hook decision (`stops: 1`, finished), question handling (Claude asked, the fixed
text was sent once, `interventions: 1`, `stops: 2`), session-log token collection for interactive sessions, the 3-minute stall rule
(Claude's question window), `run-v2.mjs` end to end for B0 and A2 with a grader. Not yet exercised on a real task: permission
dialog detection, the usage-limit banner, the 20-minute timeout, B2.

## Deviations

(none yet)
