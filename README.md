# nightshift

**Tickets in. One model builds, another reviews. You only decide what a human must.**

[English](README.md) | [한국어](README.ko.md)

nightshift is an unattended dev queue that runs on your own machine. Put tickets on a board (GitHub Issues
or a folder of markdown files) and walk away. For each ticket a developer run (Claude Code, `sonnet` by default) builds it
on its own branch, then a separate reviewer run (`opus` by default) checks it like a CTO would: it fixes small things,
sends bigger ones back for one more round, and stops anything that needs a human (money, legal text, destructive data
changes, public actions) instead of merging it.

It was pulled out of the runner that builds our own products. In its first 12 days there it took
**225 tickets** through build and review; **84%** passed review on the first round
(the pass is the AI reviewer's verdict, not a human's).

> Status: early (0.1). Claude Code is the only built-in agent so far; any CLI can be plugged in as a command agent.

## How it works

```
ticket ready ──► worker for that project (one per project, a few projects at once)
                 │
                 ├─ build   (developer model) in its own git worktree ─► writes: PR <url> | BRANCH <name> | BLOCKED <why>
                 ├─ review  (reviewer model) runs the tests, fixes small things ─► writes: PASS | REWORK | NEEDS_HUMAN | BLOCKED
                 │     REWORK ─► build again with the review notes, then review once more
                 └─ settle  PASS ─► "review" for you to merge (or merged, with autoMerge on)
                            NEEDS_HUMAN / BLOCKED ─► "blocked", with the reason on the ticket
```

What makes it hold up when nobody is watching:

- **Runs are not trusted, files are.** A stage counts as done only when it writes its one-line result file in the
  expected format. A result it cannot read is set aside and the stage runs again.
- **Cut-off runs resume.** Each stage gets a fixed session id; after a reboot, a usage limit or a killed process the
  next dispatch resumes that same session. After 3 cut-offs the ticket is blocked with the last log line as the reason.
- **No subagents, no waiting.** Every stage is its own CLI run, so nothing sits waiting on a child until it times out.
- **Your checkout is never touched.** Every ticket works in its own worktree on its own branch.
- **Two models, two roles.** The one that wrote the code is not the one that approves it.
- **Humans decide human things.** Merging stops at the gates you configure, and `autoMerge` is off by default.
- **Untrusted issues never run.** On GitHub only issues opened by `trustedAuthors` are picked up: an issue is a prompt.

## Quick start

Needs Node 20+, git, and the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI signed in.

```sh
npm install -g nightshift          # not published yet: clone this repo, npm install && npm run build && npm link
cd ~/work                          # a folder for the queue; your repos can live anywhere
nightshift init --repo-path ./my-app
nightshift add "Add a slugify helper" --project my-app --body "lowercase, dashes, tests next to the existing ones"
nightshift doctor
nightshift run                     # or: nightshift daemon
nightshift status
```

With the local board, tickets are files in `.tickets/`; the runner moves them through
`ready → working → review | blocked → done` and appends notes to each file.

### GitHub Issues

```sh
nightshift init --board github --repo you/my-app --repo-path ./my-app
```

This writes the config and creates the `nightshift:*` labels. Add your login to `board.trustedAuthors`, then label an
issue `nightshift:ready`. The worker opens a pull request, the reviewer reviews it, and the issue moves to
`nightshift:review` (or gets merged and closed with `autoMerge`). Add `nightshift:release` to make a ticket run alone.

## Config (`nightshift.json`)

| key | default | what it does |
|---|---|---|
| `board.type` | `local-md` | `local-md` (folder of tickets) or `github` |
| `board.repos`, `board.trustedAuthors` | `[]` | GitHub repos to read, and whose issues may run |
| `projects.<name>.repoPath` | (required) | the repo a ticket of this project works in |
| `projects.<name>.publish` | `pr` | `pr` pushes and opens a pull request; `branch` leaves a local branch |
| `projects.<name>.rulesFile` | none | house rules added to every prompt for this project |
| `projects.<name>.postMergeCommand` | none | runs after a merge; its result is noted on the ticket |
| `builder`, `reviewer` | Claude Code `sonnet` / `opus` | `type` (`claude-code` or `command`), `model`, `permissionMode` |
| `maxSlots` | 3 | projects worked at the same time |
| `maxRework` | 1 | extra build-and-review rounds after a REWORK |
| `maxStageTries` | 3 | cut-offs before a ticket is blocked |
| `autoMerge` | `false` | merge pull requests that pass review |
| `humanGates` | all five | `money`, `legal`, `destructive-data`, `outward-facing`, `product-direction` |
| `notifyCommand` | none | gets one message as its last argument when a ticket is blocked |

A `command` agent is any executable: it gets the prompt on stdin and `NIGHTSHIFT_MODEL`, `NIGHTSHIFT_SESSION_ID`,
`NIGHTSHIFT_SESSION_MODE` (`new` or `resume`) in its environment.

## Safety

nightshift runs coding agents unattended with permission to edit files and run commands in a worktree. Run it on a
machine and repositories you are fine with that on, keep `autoMerge` off until you trust it, and keep
`trustedAuthors` short. Check that unattended use fits the terms of the agent service you use.

## License

MIT
