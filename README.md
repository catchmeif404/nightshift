# nightshift

**Tickets in. One model builds, another reviews. You only decide what a human must.**

[English](README.md) | [한국어](README.ko.md)

nightshift is an unattended dev queue that runs on your own machine. Put tickets on a board (a folder of markdown
files, GitHub Issues or Notion) and walk away. For each ticket nightshift starts a developer run of a coding agent
(Claude Code `sonnet` by default, or Codex) that builds it on its own branch, then a separate reviewer run (`opus` by
default) that checks it like a CTO would: it fixes small things, sends bigger ones back for one more round, and stops
anything that needs a human (money, legal text, destructive data changes, public actions) instead of merging it.

**nightshift writes no code itself.** The coding agents do the building and reviewing; nightshift is the part around
them that is easy to get wrong when nobody is watching: it picks the next ticket, gives each one its own worktree,
starts and resumes the agent runs, accepts a result only from the file the run must write, sends work back for rework,
merges what passed (if you let it), and keeps the ticket up to date.

It grew out of the runner that builds our own products, and it now runs them. Its bash predecessor took
**225 tickets** through build and review in its first 12 days; **84%** passed review on the first round
(the pass is the AI reviewer's verdict, not a human's).

> Status: early (0.1). Agents: **Claude Code** (default) and **Codex**, in either role, mixed as you like.
> Boards: **local markdown** (default), **GitHub Issues**, **Notion**, and any other tracker through a small script.

**Docs:** [Install](docs/INSTALL.md) · [Getting started (10 minutes)](docs/GETTING-STARTED.md) · [Usage and troubleshooting](docs/USAGE.md)

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
The full walk-through is [Getting started](docs/GETTING-STARTED.md).

```sh
npm install -g nightshift          # before 0.1 is on npm: see docs/INSTALL.md to install from source
mkdir ~/nightshift-queue && cd ~/nightshift-queue
nightshift init --repo-path ~/code/my-app
nightshift doctor
nightshift add "Add a slugify helper" --project my-app --body "lowercase, dashes, tests next to the existing ones"
nightshift run                     # starts workers in the background and returns
nightshift logs -f                 # watch them
nightshift status                  # tickets by status
```

With the local board, tickets are files in `.tickets/`; the runner moves them through
`ready → working → review | blocked → done` and appends notes to each file. Finished work waits on a local branch
(`nightshift/t-1`) for you to merge. To keep it running on its own, see [running continuously](docs/USAGE.md#running-continuously).

### GitHub Issues

```sh
nightshift init --board github --repo you/my-app --repo-path ./my-app
```

This writes the config, creates the `nightshift:*` labels and trusts the signed-in `gh` user (more with
`--trusted a,b`). Then label an issue `nightshift:ready`. The worker opens a pull request, the reviewer reviews it, and the issue moves to
`nightshift:review` (or gets merged and closed with `autoMerge`). Add `nightshift:release` to make a ticket run alone.

## Config (`nightshift.json`)

| key | default | what it does |
|---|---|---|
| `board.type` | `local-md` | `local-md` (folder of tickets), `github`, `notion` ([setup](docs/USAGE.md#notion-as-the-board)), or `command` (any tracker, see below) |
| `board.notion` | | database id, token, property and status names: see [Notion as the board](docs/USAGE.md#notion-as-the-board) |
| `board.command` | none | for `command`: the executable that speaks the board protocol |
| `board.repos`, `board.trustedAuthors` | `[]` | GitHub repos to read, and whose issues may run |
| `projects.<name>.repoPath` | (required) | the repo a ticket of this project works in |
| `projects.<name>.publish` | `pr` | `pr` pushes and opens a pull request; `branch` leaves a local branch |
| `projects.<name>.rulesFile` | none | house rules added to every prompt for this project |
| `projects.<name>.postMergeCommand` | none | runs after a merge; its result is noted on the ticket |
| `builder`, `reviewer` | Claude Code `sonnet` / `opus` | `type` (`claude-code`, `codex` or `command`), `model`, `permissionMode` (Claude Code), `sandbox` (Codex: `auto`, `workspace-write`, `read-only`, `danger-full-access`) |
| `maxSlots` | 3 | projects worked at the same time |
| `maxRework` | 1 | extra build-and-review rounds after a REWORK |
| `maxStageTries` | 3 | cut-offs before a ticket is blocked |
| `autoMerge` | `false` | merge pull requests that pass review |
| `humanGates` | all five | `money`, `legal`, `destructive-data`, `outward-facing`, `product-direction` |
| `notifyCommand` | none | gets one message as its last argument when a ticket is blocked |
| `workerDoneCommand` | none | shell command run each time a worker finishes |
| `language` | `en` | language of the notes on tickets: `en` or `ko` |

A `command` agent is any executable: it gets the prompt on stdin and `NIGHTSHIFT_MODEL`, `NIGHTSHIFT_SESSION_ID`,
`NIGHTSHIFT_SESSION_MODE` (`new` or `resume`) in its environment.

## Any tracker: the command board

Linear, Jira, a spreadsheet, or a Notion setup the built-in board does not fit: point `board.command` at a small
script and nightshift uses it as the board.

```
<command> list <status>                      print a JSON array: [{"id","title","body","project","kind","createdAt"}]
<command> set-status <id> <status> <reason>  the note comes on stdin
<command> note <id>                          the note comes on stdin
```

Statuses are `ready`, `working`, `review`, `blocked`, `done`; `kind` is `build` or `release`. The reason tells the
tracker why a ticket moved (`needs-human`, `merged`, `cut-off`, ...), so it can, say, open a decision page for
`needs-human`. Exit non-zero on failure. Tickets the script does not want run, it simply does not list.

## Release tickets

A ticket of kind `release` runs alone, as one run of the reviewer model that follows the project's rules file
(tag, deploy, verify). It writes `DONE <what and how it was verified>` or `BLOCKED <why>`.

## Safety

nightshift runs coding agents unattended with permission to edit files and run commands in a worktree. Run it on a
machine and repositories you are fine with that on, keep `autoMerge` off until you trust it, and keep
`trustedAuthors` short. Check that unattended use fits the terms of the agent service you use.

## License

MIT
