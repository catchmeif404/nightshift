# Changelog

All notable changes to `@catchmeif404/nightshift` are listed here, newest first.

## 0.3.0 - 2026-11-26

### Breaking

- **For anyone who wrote their own agent in TypeScript** (an object implementing `Agent` from `src/agent/agent.ts`):
  `AgentRequest` has a new field `timeoutMinutes` (minutes the run may take before its process group is killed, 0 =
  no limit) and `AgentResult` has a new **required** field `timedOut` (true when the run was killed for passing that
  limit). An agent that returns an `AgentResult` without `timedOut` no longer compiles; return `timedOut: false` if
  you do not enforce the limit. (`command` agents, which are any executable, are not affected.) (TK-486)

### Added

- **Checks before a project starts, and service environment variables (TK-483).** For a project with
  `publish: "pr"`, `nightshift doctor` and every dispatch now check that `origin` exists and that the signed-in `gh`
  account can push to it. If not, no work starts, the tickets stay `ready`, and you are told once (log, `notifyCommand`
  and the chat `blocked` event) until the problem is fixed. The console shows it under "Waiting because". New config key
  `env` (default `{}`): environment variables written into the installed service (LaunchAgent / systemd unit) and
  passed to the agent, `git` and `gh` the runner starts, for example `GH_CONFIG_DIR` to use another `gh` login. Do not
  put secrets in it.
- **Tickets that wait for other tickets (TK-484).** A ticket can name predecessors that must be `done` first:
  `nightshift add "..." --depends T-1,T-2` (or a `depends:` line in the file) on the local board, a
  `Depends on #12` / `Blocked by #12` line in a GitHub issue, `dependsOn` in the JSON of a `command` board. Until then
  the ticket stays `ready`; `nightshift status` and the console say what it waits for, and `nightshift doctor` warns
  about unknown ids, self-references and loops. A blocked predecessor keeps the ticket waiting.
- **The runner runs your tests, and shows the reviewer's own edits (TK-485).** New project keys `testCommand` (default
  empty = off) and `testTimeoutMinutes` (default `15`). After a review says `PASS`, nightshift runs `testCommand` in the
  ticket's worktree. If it fails or times out, the `PASS` is not accepted: the ticket goes back to rework with the end
  of the output, or is `blocked` when no rework is left, and `autoMerge` does not merge. When the reviewer changed the
  code itself, the size of those commits (files, +/- lines) is written on the ticket and in `nightshift report`.
  `doctor` counts the projects with a `testCommand`, and the console can edit it.
- **Stuck-ticket alerts and a stage time limit (TK-486).** New key `staleHours` (default `24`, `0` = off): a ticket
  left in `review` or `blocked` for longer is listed as stuck in `nightshift report`, `nightshift status` and the
  console, and told once per ticket on the new `stale` chat event. New key `stageTimeoutMinutes` (default `0` = no
  limit): one agent run of a stage may take this long; past it the run is killed and counts as a cut-off (after
  `maxStageTries` of them the ticket is `blocked`). Waiting for a usage limit is never counted.

### Changed

- `notify.events` now knows two more events, `daily-report` and `stale`. A config that does not list `events` gets all
  five by default, so it will now also receive stuck-ticket messages; list `events` explicitly to opt out. (TK-486)

### Also in this release

Merged after 0.2.0 and not covered by the tickets above: tokens and time recorded per ticket stage (TK-481),
`nightshift report` and `dailyReportAt` (TK-482), and the `reviewHandoff` option, off by default.

## 0.2.0 - 2026-11-17

- `nightshift ui`: a local web console for status, settings and doctor.
- `ticketSections` (require labelled lines in a ticket body), `gatePaths` (hand a change to a human by changed path).
- Built-in `notify` for Telegram, Slack and Discord.
- Usage limits are waited out instead of counted as tries.

## 0.1.0 - 2026-11-16

- First release, published as `@catchmeif404/nightshift`: a ticket queue where one model builds in its own worktree and
  another reviews; local markdown, GitHub Issues, Notion and `command` boards; Claude Code and Codex agents;
  `service install` for continuous running.
