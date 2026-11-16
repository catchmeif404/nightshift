# Using nightshift

[English](USAGE.md) | [한국어](ko/USAGE.md)

- [The daily loop](#the-daily-loop)
- [Writing good tickets](#writing-good-tickets)
- [What each status means](#what-each-status-means)
- [GitHub Issues and pull requests](#github-issues-and-pull-requests)
- [Running continuously](#running-continuously)
- [House rules, human gates and release tickets](#house-rules-human-gates-and-release-tickets)
- [Models, cost and your Claude Code settings](#models-cost-and-your-claude-code-settings)
- [Codex instead of (or with) Claude Code](#codex-instead-of-or-with-claude-code)
- [Notion as the board](#notion-as-the-board)
- [Any other agent or tracker](#any-other-agent-or-tracker)
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

`nightshift run` starts what is ready and exits; workers keep going in the background. To have new tickets picked up
and cut-off runs resumed without you, install it as a service:

```sh
cd ~/nightshift-queue
nightshift service install     # macOS: a LaunchAgent; Linux: a systemd user timer
nightshift service status      # installed? last run, last exit, the last lines of its log
nightshift service uninstall
```

The service runs `nightshift run` for this queue every `pollSeconds` (default 120, at least 30) and at login. It finds
`node`, `git`, `gh`, `claude` and `codex` through the PATH of the shell you installed it from, so run
`service install` again after installing a new CLI. Its own output goes to `.nightshift/service.log`. On Linux, add
`loginctl enable-linger $USER` to keep it running while you are logged out. Each queue folder gets its own service.

Only one dispatch runs at a time (a lock in `.nightshift/`), so a manual `run` while the service is installed is safe.

Prefer to keep it in a terminal? `nightshift daemon` does the same until you stop it. Prefer cron? Call
`nightshift run --root <queue>` from it, with a PATH that includes your tools.

## The local console (`nightshift ui`)

```bash
nightshift ui --root ~/my-queue          # prints http://127.0.0.1:4404/ ; --port 0 picks a free port
```

A small web page for the things you otherwise do with `status`, `logs`, `doctor` and by editing `nightshift.json`.
It ships inside the package (no extra install) and is for **this computer only**.

- **Status**: running workers with their stage, tickets by status, why a ready ticket has not started (usage limit, the
  project already has a worker, all slots busy, a release waiting for idle, unknown project), the recent log.
  It refreshes every 5 seconds and only reads.
- **Settings**: project repository paths, the board (local-md or github: folder, repositories, trusted logins), the
  developer and reviewer executor (claude-code or codex) and model, and the number of concurrent workers.
  **Check before saving** runs the same validation as the CLI plus the `doctor` checks against the edited values, and
  writes nothing. **Save** copies the old file to `nightshift.json.bak-<time>` and swaps the new one in atomically.
- **Doctor**: the same checks as `nightshift doctor` for the saved file.

What it does not do, on purpose: start, stop or merge tickets; install or remove the service; turn `autoMerge` on;
accept a command line or a token. Saving only writes `nightshift.json`. Workers that are running keep the settings they
started with; new settings apply the next time work is dispatched (at most one poll interval later, if the service or
`daemon` runs).

Everything else in the file (fields it does not edit, even misspelled or wrong ones, and every secret) is kept exactly as
it was on each save. Secret-looking values are shown as `•••••• (kept)`: that means "unchanged", it is not a value you
can edit. A `command` board or agent is shown as locked; change those in the file.

Safety: it binds `127.0.0.1` only; a request must carry the right `Host`, a same-origin `Origin` and the page's one-time
CSRF token; the page has a strict Content-Security-Policy; the server has no file or shell access beyond the config
root's own files, and a board folder must stay inside the config root.

## House rules, human gates and release tickets

**`nightshift.rules.md`** is added to every prompt of a project (`projects.<name>.rulesFile`). Put what the
repository's own `CLAUDE.md` / `AGENTS.md` does not already say: the test command, commit style, folders never to touch,
how to write the pull request.

**Human gates** (`humanGates`, all on by default): `money`, `legal`, `destructive-data`, `outward-facing`,
`product-direction`. When a change touches one, the reviewer answers `NEEDS_HUMAN` and writes what you must decide,
the options and its recommendation; the ticket goes to `blocked` with that text. Nothing behind a gate is merged.

**Ticket form** (`ticketSections`, default `[]` = off): a list of labels, for example
`["Deliverable", "Check", "Out of scope"]`. Before a ticket runs, its body must have a `Label: text` line for each
label (text after the colon; a full-width `：` works too). A ticket that lacks one moves to `blocked` with a note
naming what is missing (all boards; release tickets are not checked). Build and review prompts list the items, and the
review grades by them and runs the check items itself. `add` pre-fills an empty form in the body. `doctor` reports an
invalid list (empty or duplicate label, a colon in a label).

**Release tickets** (`--release` on `add`, or the `nightshift:release` label) run alone, as one reviewer run that
follows your rules file. Write the release steps there (tag, deploy, how to check it is live). The run answers `DONE`
or `BLOCKED`.

## Models, cost and your Claude Code settings

- Defaults: `sonnet` builds, `opus` reviews. Change `builder.model` / `reviewer.model` in `nightshift.json`.
- Every ticket is at least two Claude Code runs, four with a rework round. On a subscription this counts against your
  usage limits; when a run hits a limit, nightshift reads the reset time from the message, starts nothing until then
  and resumes the same session (a limit is never counted as a try).
- Runs use your own Claude Code: your sign-in, your `~/.claude/settings.json` permissions and your global
  `~/.claude/CLAUDE.md` (if it says "answer in Korean", the run summaries will be in Korean).
- Check that unattended use fits the terms of the service you use.

## Codex instead of (or with) Claude Code

The defaults are Claude Code `sonnet` for building and `opus` for reviewing. Either role can be the
[Codex CLI](https://github.com/openai/codex) instead (signed in with `codex login`):

```json
"builder":  { "type": "codex" },
"reviewer": { "type": "claude-code", "model": "opus" }
```

Mixing is the point: the model that wrote the code is not the one that approves it. `model` is optional for Codex
(it uses the model in your `~/.codex/config.toml`); set it to pick another.

`sandbox` sets how much a Codex run may do unattended:

| `sandbox` | what it does |
|---|---|
| `auto` (default) | Codex's "approve for me": a workspace-write sandbox, and anything that needs more (committing into the repository's `.git`, pushing) goes to Codex's automatic reviewer. The counterpart of Claude Code's auto mode |
| `workspace-write` | writes only in the worktree, never escalates. Codex cannot commit from a worktree in this mode, so builds end `BLOCKED` |
| `danger-full-access` | no sandbox, no approvals. Only on a machine set aside for this |
| `read-only` | for a reviewer that should never change the branch |

A cut-off Codex run resumes like a Claude Code one (`codex exec resume` on the same thread).

## Notion as the board

1. Create an integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and copy its
   secret. Give it "Read content", "Update content" and "Read/Insert comments".
2. Open your tasks database, **⋯ → Connections → add the integration**.
3. Copy the database id from its URL (`notion.so/<workspace>/<database id>?v=...`).
4. Put the secret in an environment variable (`NOTION_TOKEN`) or a file only you can read (`tokenFile`).

```json
"board": {
  "type": "notion",
  "notion": {
    "databaseId": "0123456789abcdef0123456789abcdef",
    "tokenEnv": "NOTION_TOKEN",
    "properties": { "title": "Name", "status": "Status", "project": "Project", "kind": "Type", "id": "ID", "notes": "" },
    "statuses": { "ready": "Ready", "working": "In progress", "review": "In review", "blocked": "Blocked", "done": "Done" },
    "releaseKind": "Release",
    "filter": { "property": "Assignee", "equals": "nightshift" }
  }
},
"projects": { "my-app": { "repoPath": "~/code/my-app" } }
```

| key | meaning |
|---|---|
| `properties.title`, `status`, `project` | required. `status` may be a Status or a Select property; `project` a Select, Multi-select, Text or Relation (the related page's title) |
| `properties.kind` | optional. Pages whose kind equals `releaseKind` are release tickets |
| `properties.id` | optional. A Unique ID property (`TK-12`) gives short ticket ids and branch names; otherwise the page id is used |
| `properties.body` | optional. A text property with the ask; by default the page's own text is used |
| `properties.notes` | optional. A text property the runner appends to; by default notes become page comments |
| `statuses` | the option names in your status property for each runner status. They must exist in the database |
| `filter` | optional. Only pages where this property equals this value are tickets (Select, Status, Text or Checkbox) |

The value of the project property is the key in `projects` (`"my-app"` above). `nightshift doctor` reads the database
once to check the token, the sharing and the property names.

## Any other agent or tracker

- **Another agent CLI** (Gemini CLI, opencode, ...): set `builder` / `reviewer` to
  `{"type": "command", "command": "/path/to/script"}`. The script gets the prompt on stdin and `NIGHTSHIFT_MODEL`,
  `NIGHTSHIFT_SESSION_ID`, `NIGHTSHIFT_SESSION_MODE` (`new` or `resume`) in its environment, runs in the ticket's
  worktree, and must exit 0 when the run finished. Resuming a cut-off session is up to the script.
- **Another tracker** (Linear, Jira, a spreadsheet): write a small script for the
  [command board protocol](../README.md#any-tracker-the-command-board) and set `"board": {"type": "command", "command": "..."}`.

## Troubleshooting

| what you see | why, and what to do |
|---|---|
| `run` says "nothing to start: no ready tickets" | no ticket is `ready`. On GitHub: is the issue labelled `nightshift:ready`, open, and opened by a trusted author? |
| `run` says ready tickets "wait for a project that is already being worked on" | one worker per project; the next batch is picked up by that worker when it finishes |
| a Codex build ends `BLOCKED` because git could not write its index or lock file | the Codex `sandbox` is `workspace-write`; use `auto` (the default) |
| `doctor`: "Notion: ... 404" or "no property" | the database is not shared with the integration, or a property name in `properties` / `statuses` does not match |
| a ticket stays `working` and nothing runs | the run was cut off; the next `run` resumes it after `resumeCooldownMinutes` (15). `nightshift logs` shows the last exit. Is the service installed (`nightshift service status`)? |
| `blocked`: "stage was cut off 3 times" | read the last log line in the note. Common causes: `claude` not signed in, a permission prompt in an unattended run (usage limits are waited out, not counted) |
| nothing starts and `status` shows "usage limit: … until …" | the agent's account hit its usage limit; nightshift resumes on its own after that time. Nothing to do |
| run summaries mention a permission rule or ask for approval | your Claude Code settings deny something the run needed. Allow it in `~/.claude/settings.json`, or change `permissionMode` |
| `blocked`: "could not make a worktree" | the project path is not a git repository, or `baseBranch` does not exist (`main` by default) |
| `review`: "the merge failed" | the pull request has a conflict or failing required checks; fix it on GitHub or set the ticket `ready` again |
| you deleted a branch nightshift made and it is in use | `git worktree prune` in that repository, then try again |

**Stop everything:** `nightshift service uninstall` (or stop your daemon), then find workers with `nightshift status` and stop them
(`kill <pid>`). Cut-off tickets stay `working` and resume when you start again.
