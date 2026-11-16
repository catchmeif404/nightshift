# TK-454 paired pilot: pre-registration

Written and committed **before** any measured run. Anything that changes after the first run is listed under
"Deviations" at the bottom of this file, with the reason; nothing is edited silently.

## Question and non-claims

Does running a ticket through nightshift (ON: dispatch → builder → reviewer → rework loop) differ from running the same
ticket directly with Claude Code (OFF: same builder and reviewer models, same prompts' intent, driven by a plain script)
in tokens, elapsed time and result quality?

This is an **exploratory pilot with 3 pairs**. It cannot show statistical superiority or any saving, and no number from it
may be used as a claim of one. Observational logs of earlier real tickets are *not* reused: they have different tasks,
code states, models and rules, so they are not equivalent to this design (see `docs/bench/REPORT.md`, "Observational logs").

## Fixed conditions (both arms)

| item | value |
|---|---|
| start code | `bench/fixture/` committed once as `main` in a fresh scratch repo per run (identical bytes) |
| task text | `bench/tasks/tN.md`, identical bytes in both arms (title + body incl. Deliverable / Check / Out of scope) |
| builder and reviewer model | alias `sonnet` for both roles, both arms (the resolved model id is read back from the logs) |
| effort | not overridden: the signed-in CLI default, same user settings in both arms (nightshift has no effort option) |
| permission mode | `auto` (nightshift's default), both arms |
| subagents | disabled (`--disallowedTools Agent`), both arms |
| external tools / network | none asked for; same machine, same CLI login/plan; no API key, no usage increase |
| session | every stage-round is a brand-new session (`--session-id`), no resume; nothing from the other arm or any grader file is passed on |
| max rework | 2 (so at most 3 build rounds and 3 reviews; the 3rd review is the "last round": it may fix small things itself, otherwise it blocks) |
| max wall time | 20 minutes per run (builder + reviewer + reworks + dispatch); at 20:00 the run is killed and recorded as `timeout` |
| working place | `/tmp/ns-bench/<anon-id>/` scratch repo and worktree only; no operational runner, no main checkout, nothing pushed |

ON arm: `nightshift init` (default rules file), local-md board, `publish: branch`, `maxSlots 1`, `maxRework 2`,
reviewer model set to `sonnet`, ticket added with `nightshift add`, started with `nightshift run`.
OFF arm: `bench/scripts/run-one.mjs` calls `claude -p` for the builder, then for the reviewer, and loops on `REWORK` with the
same limits. Its prompts are deliberately short and carry the same instructions in substance (do the ticket, run tests,
stay in scope, review against the ticket and run the tests, fix small things, report `VERDICT: PASS|REWORK`), but not
nightshift's rules file, human-gate list or result-file protocol. That difference is part of what is measured.

## Tasks (3, fixed in advance, none dropped)

- **t1** CSV export: new function `toCsv` (RFC 4180 quoting, 2-decimal price, trailing newline). Feature, new file.
- **t2** Path traversal in `readItem`: security bug fix with a specified error contract.
- **t3** Low-stock report: library function + CLI command, input validation, stable sort.

## Order (crossed over, fixed in advance)

| pair | first | second |
|---|---|---|
| t1 | ON | OFF |
| t2 | OFF | ON |
| t3 | ON | OFF |

Runs are sequential (never concurrent) so they do not compete for the same rate limit. Each pair is run once. A failed,
timed-out or blocked run stays in the data; there is no re-run to "fix" a bad result.

## Measures

Tokens: from the raw Claude Code session logs (`~/.claude/projects/...jsonl`) of every session the run created
(builder + reviewer + reworks). One assistant message is written several times (one line per content block): rows are
de-duplicated by `message.id`. Reported separately and never summed into one "cost" number: `input_tokens` (uncached input),
`output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`. `total_tokens` = the sum of those four and is
labelled as such (cache reads are far cheaper than fresh input, so it is not a price). If a log is missing or has no usage,
the value is empty (`null`), never 0 or an estimate.

Time (seconds): `total` = wall clock from start command to settled; per session span = first to last timestamp in its log,
split into `build` (round 1 builder), `rework` (builder round ≥ 2), `review` (all reviewer rounds); `wait_overhead` =
`total` − spans (dispatch, worktree set-up, polling, process start). Human working time: **not measured** (no human took part).

Quality (`bench/scripts/grade.mjs`, a deterministic script that receives only a repo path and a task id; it is blind to the
arm and runs the same hidden acceptance tests `bench/grader/tN.test.js` for both arms; the hidden tests are never copied
into a scratch repo):
1. requirement tests passed / total (one test per ticket requirement);
2. the repo's own `npm test` on the final branch passes;
3. security check: t2 = the traversal tests (`R1a`) pass; all tasks = no `child_process`/`eval`/`new Function`/network use added, no dependency added;
4. scope: changed files ⊆ the task's allowed list (`grade.mjs`); anything else, `package.json`, or a lockfile = violation;
5. critical defect = a failed security test, a failing own `npm test`, or no committed change;
6. completed = the arm's own flow ended in a pass (ON: ticket `review`; OFF: reviewer `VERDICT: PASS`) inside 20 minutes, **and** a change was committed.
   `accepted_by_grader` is a separate flag: completed and all hidden tests pass, no critical defect, no scope violation.
7. rework rounds = build rounds − 1; remaining items = hidden tests failed.

Stop rules: wall-time 20 min per run (kill, record `timeout`); the rework cap above; usage-limit or CLI errors are recorded
as `error` with the message and the pair is reported as incomplete — not re-run silently and not filled in. If the plan's
rate limit blocks a run, that is reported as a blocked path.

Analysis (`bench/scripts/analyze.mjs`): per task the raw value of each arm, ON − OFF difference and ON / OFF ratio, then
n and median across the 3 tasks. Pairs with a missing value are excluded from that metric's median and counted.

## Deviations
(none yet)
