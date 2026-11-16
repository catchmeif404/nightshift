# Using nightshift

[English](USAGE.md) | [한국어](ko/USAGE.md)

- [The daily loop](#the-daily-loop)
- [Writing good tickets](#writing-good-tickets)
- [What each status means](#what-each-status-means)
- [GitHub Issues and pull requests](#github-issues-and-pull-requests)
- [Running continuously](#running-continuously)
- [House rules, human gates and release tickets](#house-rules-human-gates-and-release-tickets)
- [Models, cost and your Claude Code settings](#models-cost-and-your-claude-code-settings)
- [Other agents and trackers](#other-agents-and-trackers)
- [Troubleshooting](#troubleshooting)

## The daily loop

1. Write tickets: `nightshift add` (local board) or issues labelled `nightshift:ready` (GitHub).
2. Let it run: `nightshift run` once, or keep it running (below).
3. Come back to three piles: **review** (passed, ready for you to merge), **blocked** (a reason or a decision for you),
   **done** (merged, with `autoMerge`).

```sh
nightshift status      # workers, and tickets by status
nightshift logs -n 100 # what happened
```

## Writing good tickets

Each ticket becomes the prompt for two runs that cannot ask you anything. Write it like a ticket for a new teammate:

- **One change.** "Add CSV export to the report page", not "improve reports".
- **What done looks like.** "Done when the export button downloads a CSV with the same columns as the table, with a
  test." The reviewer judges against this.
- **Where.** Files, screens or endpoints you already know about.
- **Decisions already made.** Library to use, naming, what not to touch.

A ticket that is too big tends to come back `REWORK` or `BLOCKED`; split it.

## What each status means

| status | meaning | your move |
|---|---|---|
| `ready` | waiting for a worker | nothing |
| `working` | a worker has it; notes show the stage. A cut-off run resumes on the next `run` | nothing |
| `review` | the reviewer passed it; the note says where it is (branch or pull request) | read the review, merge |
| `blocked` | the reason is in the last note: the developer could not finish, the reviewer stopped it, it needs a human decision (`needs-human`), or a stage was cut off 3 times | decide or fix, then set it `ready` again |
| `done` | merged (pull request with `autoMerge`) or accepted | nothing |

Setting a blocked ticket back to `ready` starts it over from the build stage; the branch and any open pull request
are reused, so the developer picks up where it was.

## GitHub Issues and pull requests

```sh
gh auth login                       # once
nightshift init --board github --repo you/my-app --repo-path ~/code/my-app
```

This creates the labels (`nightshift:ready`, `:working`, `:review`, `:blocked`, `:done`, `:release`) and trusts the
signed-in `gh` user. Only issues opened by `board.trustedAuthors` ever run: on a public repository anyone can open an
issue, and an issue is a prompt. Add more people with `--trusted alice,bob` or by editing `nightshift.json`.

To queue work, label an issue `nightshift:ready`. The developer pushes a branch and opens a pull request; the reviewer
checks it and fixes small things on the branch, and the issue moves to `nightshift:review` with a comment that links
the pull request and carries the review. The repository needs an `origin` remote you can push to. (Want the review as
a pull request comment too? Say so in `nightshift.rules.md`.)

With `"autoMerge": true` nightshift merges a passed pull request itself (`gh pr merge --merge --delete-branch`), closes
the issue and runs `postMergeCommand`. A pull request that cannot be merged (conflict, failing required checks) stays
in `review` with the reason. Leave `autoMerge` off until you have watched it for a while.

## Running continuously

`nightshift run` starts what is ready and exits; workers keep going in the background. Something has to call it again
for new tickets and for resuming cut-off runs:

**In a terminal:** `nightshift daemon` (every `daemonIntervalMinutes`, default 15).

**cron** (macOS and Linux). Cron has a short PATH, so give it the folders where `node`, `claude`, `git` and `gh` live
(`which node claude` shows them):

```cron
*/15 * * * * cd $HOME/nightshift-queue && PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin nightshift run >> .nightshift/cron.log 2>&1
```

**launchd** (macOS), as `~/Library/LaunchAgents/dev.nightshift.queue.plist`, then
`launchctl load ~/Library/LaunchAgents/dev.nightshift.queue.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.nightshift.queue</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd ~/nightshift-queue &amp;&amp; nightshift run</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/tmp/nightshift-queue.log</string>
  <key>StandardErrorPath</key><string>/tmp/nightshift-queue.log</string>
</dict></plist>
```

Only one dispatch runs at a time (a lock in `.nightshift/`), so overlapping calls are safe.

## House rules, human gates and release tickets

**`nightshift.rules.md`** is added to every prompt of a project (`projects.<name>.rulesFile`). Put what the
repository's own `CLAUDE.md` / `AGENTS.md` does not already say: the test command, commit style, folders never to touch,
how to write the pull request.

**Human gates** (`humanGates`, all on by default): `money`, `legal`, `destructive-data`, `outward-facing`,
`product-direction`. When a change touches one, the reviewer answers `NEEDS_HUMAN` and writes what you must decide,
the options and its recommendation; the ticket goes to `blocked` with that text. Nothing behind a gate is merged.

**Release tickets** (`--release` on `add`, or the `nightshift:release` label) run alone, as one reviewer run that
follows your rules file. Write the release steps there (tag, deploy, how to check it is live). The run answers `DONE`
or `BLOCKED`.

## Models, cost and your Claude Code settings

- Defaults: `sonnet` builds, `opus` reviews. Change `builder.model` / `reviewer.model` in `nightshift.json`.
- Every ticket is at least two Claude Code runs, four with a rework round. On a subscription this counts against your
  usage limits; when a run hits a limit it is cut off and resumed later (after `resumeCooldownMinutes`).
- Runs use your own Claude Code: your sign-in, your `~/.claude/settings.json` permissions and your global
  `~/.claude/CLAUDE.md` (if it says "answer in Korean", the run summaries will be in Korean).
- Check that unattended use fits the terms of the service you use.

## Other agents and trackers

Built in today: the **Claude Code** agent; the **local markdown**, **GitHub Issues** and **command** boards.

- **Another agent CLI** (Codex, Gemini CLI, ...): not built in yet. Set `builder` / `reviewer` to
  `{"type": "command", "command": "/path/to/script"}`. The script gets the prompt on stdin and `NIGHTSHIFT_MODEL`,
  `NIGHTSHIFT_SESSION_ID`, `NIGHTSHIFT_SESSION_MODE` (`new` or `resume`) in its environment, runs in the ticket's
  worktree, and must exit 0 when the run finished. Resuming a cut-off session is up to the script.
- **Another tracker** (Linear, Jira, Notion, a spreadsheet): not built in yet. Write a small script for the
  [command board protocol](../README.md#any-tracker-the-command-board) and set `"board": {"type": "command", "command": "..."}`.

## Troubleshooting

| what you see | why, and what to do |
|---|---|
| `run` says "nothing to start: no ready tickets" | no ticket is `ready`. On GitHub: is the issue labelled `nightshift:ready`, open, and opened by a trusted author? |
| `run` says ready tickets "wait for a project that is already being worked on" | one worker per project; the next batch is picked up by that worker when it finishes |
| a ticket stays `working` and nothing runs | the run was cut off; the next `run` resumes it after `resumeCooldownMinutes` (15). `nightshift logs` shows the last exit |
| `blocked`: "stage was cut off 3 times" | read the last log line in the note. Common causes: usage limit, `claude` not signed in, a permission prompt in an unattended run |
| run summaries mention a permission rule or ask for approval | your Claude Code settings deny something the run needed. Allow it in `~/.claude/settings.json`, or change `permissionMode` |
| `blocked`: "could not make a worktree" | the project path is not a git repository, or `baseBranch` does not exist (`main` by default) |
| `review`: "the merge failed" | the pull request has a conflict or failing required checks; fix it on GitHub or set the ticket `ready` again |
| you deleted a branch nightshift made and it is in use | `git worktree prune` in that repository, then try again |

**Stop everything:** stop your cron / launchd / daemon, then find workers with `nightshift status` and stop them
(`kill <pid>`). Cut-off tickets stay `working` and resume when you start again.
