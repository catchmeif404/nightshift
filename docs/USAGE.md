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

## Tickets that wait for other tickets

A ticket can name tickets that must be `done` (merged, or finished by you) before it starts. Until then it stays
`ready` and untouched; `nightshift status` and the console say what it waits for (for example "predecessor T-1 is blocked").

- **Local board:** `nightshift add "..." --depends T-1,T-2`, or a `depends: T-1, T-2` line in the ticket file's header.
- **GitHub Issues:** a line `Depends on #12` or `Blocked by #12` in the issue body (`owner/repo#12` for another repo you list). A closed issue counts as done.
- **Command board:** a `dependsOn` array of ids in the JSON `list` prints. Without it, the ticket has no predecessors.
- A blocked predecessor keeps the ticket waiting; nightshift does not block the later ticket for you. An id that is not on the
  board, a ticket that names itself and tickets that wait for each other never start; `nightshift status` shows why and
  `nightshift doctor` warns.
- In one batch, predecessors run first, and the next ticket starts only if its predecessor is really done by then.

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

## The runner's own test run (`testCommand`)

A reviewer saying "tests pass" is only its word. Give a project a `testCommand` and nightshift runs it itself, in the
ticket's worktree, after the review says `PASS` and before anything is merged or handed to you:

```json
"projects": { "my-app": { "repoPath": "~/code/my-app", "testCommand": "npm test", "testTimeoutMinutes": 15 } }
```

- Exit code 0: the ticket goes on as before. Empty (the default): off, nothing changes.
- Failed or past `testTimeoutMinutes` (default 15, then killed): the `PASS` is not accepted, and `autoMerge` does not
  merge. If a rework round is left (`maxRework`), the end of the output (up to 60 lines) is added to the review notes and
  the developer gets the ticket back. If not, the ticket is `blocked` with "runner check failed: <command>" and the last
  output line.
- The command is a shell command line run by you, from your config; keep secrets out of it. It also runs on document
  tickets, so leave it empty for a project that only produces documents.
- You can edit it in the console's settings (`nightshift ui`); `nightshift doctor` shows on how many projects it is set.

When the reviewer changes the code itself, nightshift compares the commits before and after the review stage and writes
the file count and +/- lines to the ticket note and the ticket's usage file. `nightshift report` shows it on the row,
for example "reviewer edit +12/-3". Nobody else checks those edits, so treat that mark as "look at this one".

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

**Environment variables** (`env`, default `{}`): an object of string names and values, for example
`{"env": {"GH_CONFIG_DIR": "/Users/me/.config/gh-work"}}` to make the runner use a different `gh` login. `service install`
writes them into the LaunchAgent's `EnvironmentVariables` and the systemd unit's `Environment=`, so they survive a
reinstall (never edit the service file by hand). `run`, `work` and `daemon` also add them to the environment of the
agent, `git` and `gh` they start. Do not put secrets here: the file and the service file are plain text. Keep tokens in
the `gh` login, or in an environment variable named by `tokenEnv` / `botTokenEnv` / `webhookUrlEnv`.

**Checks before starting**: for a project with `publish: "pull-request"`, `doctor` checks that `origin` exists and
that the active `gh` account can push to that repository (`gh api repos/<owner>/<repo>`, `permissions.push`). A project
with `publish: "branch"` needs no remote. The dispatch runs the same check right before it starts a project's worker.
If it fails, no work starts and the project's ready tickets stay as they are. The reason goes to the log and, once, to
`notifyCommand` and the chat notifier (`blocked` event); it is sent again only after the problem was fixed and came
back. The console shows it under "Waiting because". Fix it (`gh auth switch`, `git remote add origin ...`) and the
next dispatch starts the work.

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

**Gated paths** (`gatePaths`, default `[]` = off): a list of globs, for example `["db/migration/**", "**/*.sql", ".github/workflows/**"]`.
Unlike `humanGates`, which only tell the review model what to look for, this is enforced in code: when the review says
`PASS` but any file changed against the base branch matches a glob, the ticket moves to `blocked` as `needs-human`
and is not merged (also with `autoMerge` on). The ticket note lists each matched glob and its files. The review prompt
lists the globs too. Globs match the whole repository-relative path: `*` and `?` stay inside one folder name, `**`
crosses folders (`dir/**` is everything below `dir`, `**/*.sql` any `.sql` file). If git cannot list the changed files,
the ticket is held for a human rather than passed. `doctor` reports an empty glob.

**Chat notifications** (`notify`, default off): nightshift can message Telegram, Slack or Discord by itself, with no script.

```json
{ "notify": { "service": "telegram", "chatId": "123456", "botTokenEnv": "NIGHTSHIFT_TELEGRAM_BOT_TOKEN", "events": ["review", "blocked", "merged"] } }
```

- `service`: `telegram`, `slack` or `discord` (default `none` = off).
- `events` (default all five): `review` (passed review, waiting for you to merge), `blocked` (stopped: blocked, needs a human, cut off, merge failed, misconfigured), `merged` (merged, document accepted, release done), `daily-report` (the [morning report](#the-morning-report-nightshift-report); only sent when `dailyReportAt` is set), `stale` (a ticket sits in review or blocked for more than `staleHours`; see [Stuck tickets](#stuck-tickets-and-the-stage-time-limit)).
- Secrets never go in the config, only the **name** of an environment variable: `botTokenEnv` for Telegram (default `NIGHTSHIFT_TELEGRAM_BOT_TOKEN`, plus `chatId`, and `apiUrl` if you need another API host), `webhookUrlEnv` for Slack and Discord (an incoming-webhook URL; defaults `NIGHTSHIFT_SLACK_WEBHOOK_URL` / `NIGHTSHIFT_DISCORD_WEBHOOK_URL`). Export the variable where the runner runs (for the installed service, in its environment).
- The message is one or two lines in the `language` setting: `<ticket> <title>: <what happened>`, then the pull request link when the ticket has one.
- A failed send (network, HTTP error, variable not set) is only written to the log; the ticket and the run carry on. `doctor` warns when the variable is missing.
- `notifyCommand` and `workerDoneCommand` work as before, alongside this.

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

### Tokens and time per ticket

Every time a developer, reviewer or release stage finishes, nightshift appends a line to `<stateDir>/usage/<ticket>.jsonl`:
stage, round, model, input / output / cache read / cache write tokens, a weighted total, and seconds. Nothing to turn on.

- Weighted total = input x1 + output x5 + cache write x1.25 + cache read x0.1 (the same formula as `bench/`).
  Tokens are summed from the Claude Code session file, each message counted once by its id; seconds run from the first
  to the last timestamp in that file.
- Codex and `command` agents have no session file nightshift can read, and a Claude Code session file may be missing:
  then only the time (wall clock of the run) is recorded and the tokens stay "unknown". The stage never fails for it.
- When a ticket settles, one line is added to its board note, e.g.
  `build r1 sonnet 2m10s 124k · review r1 opus 1m17s 93k · total 217k` (`language: "ko"` writes
  `개발 r1 sonnet 2m10s 124k · 검토 r1 opus 1m17s 93k · 합계 217k`). Stages with unknown tokens say so and are left out of the total.
- `nightshift status` and the console show the running total (`217k · 3m27s`) on each ticket line.

## The morning report (`nightshift report`)

```bash
nightshift report                       # the last 24 hours
nightshift report --since 3d            # the last 3 days (also 12h ...)
nightshift report --since 2026-11-24    # from that day's midnight (this computer's time zone)
nightshift report --json                # the same data for scripts
nightshift report --send                # also send it to notify and notifyCommand
```

It reads only what the runner keeps in `<stateDir>`: `journal.jsonl` (one line when a ticket settles, one when a usage
limit stops work), written by the runner. It never asks the board, so it works offline. Tickets that settled before
you updated to this version have no journal line and do not appear.

A ticket that settled in the period lands in one group, by its last result in it:

- **Passed**: merged, or review passed and the PR waits for you to merge.
- **Passed after rework**: the same, but the reviewer sent it back at least once.
- **Blocked**: the developer or the review stopped it, or a stage was cut off; one line says why.
- **Needs a human decision**: a gate (money, legal, gated paths ...) or the reviewer asked for you; one line says why.

Each line shows `[project] ticket title - PR or branch · tokens · time` (weighted tokens as in
[Tokens and time per ticket](#tokens-and-time-per-ticket); "tokens unknown" when they could not be read). At the bottom:
the totals (tickets, **first-pass rate** = tickets that passed with no rework out of all except those waiting for a
human, total tokens, and the time everything waited for a usage limit, overlapping limits counted once) and **To do
now**: merge the PRs that wait, unblock the blocked, decide the rest. With nothing moved the report says so in one line.
The to-do list is what the records say at the end of the period; a ticket you already merged or fixed by hand since
may still be listed until it settles again.

`--send` sends the same text to the `notify` chat (Telegram, Slack, Discord) and to `notifyCommand` (the text is its
last argument). It ignores `notify.events` (you asked for it), and the exit code is 1 if no channel is set or a send
failed. To get it every morning, set **`dailyReportAt`** (`"HH:MM"`, 24 hours, this computer's time; empty or absent is
off, the default):

```json
{ "dailyReportAt": "08:00", "notify": { "service": "telegram", "chatId": "123456", "events": ["review", "blocked", "merged", "daily-report"] } }
```

The first dispatch after that time sends the last 24 hours once; the date is written to `<stateDir>/report-sent` after
a send that worked, so a restart or a second worker never sends it twice, and a failed send is tried again at the next
dispatch. For the chat service the event `daily-report` must be in `notify.events` (it is by default). `nightshift ui`
shows the same summary of the last 24 hours as a card at the top of the status section.

## Stuck tickets and the stage time limit

**`staleHours`** (default `24`, `0` turns it off): a ticket that the runner left in `review` or `blocked` and that has not
moved for more than this many hours is **stuck**. The age comes from the runner's own record in `stateDir`
(`journal.jsonl`, the time of the ticket's last result); nothing is read from the board, so a ticket you merged, closed
or moved by hand stays listed until the runner settles it again (or you remove its line). A ticket that is worked on
again (a stage is in progress) is not stuck.

- `nightshift report` (and `--send`, the morning report, the console card) get an extra **Stuck tickets** section, apart
  from the period's groups and whatever the period: `[project] ticket title - status · stuck 30h00m` and the last reason.
- `nightshift status` prints the same section.
- The chat service gets one message per stuck ticket with the `stale` event (it is in `notify.events` by default). It is
  checked at every dispatch; the ticket's `<stateDir>/results/<ticket>.stale` file remembers that it was told, so it is
  never told twice for the same stuck period, and it is cleared when the ticket moves (the runner picks it up or settles
  it again). A failed send is tried again at the next dispatch. `notifyCommand` is not used for this.

**`stageTimeoutMinutes`** (default `0` = no limit): how long **one agent run** of a stage (build, review, release) may
take. A run that passes it has its whole process group killed and is handled like a cut-off run: the next dispatch
resumes the same session, and after `maxStageTries` cut-offs the ticket is `blocked` with the note "time limit of N min
exceeded". Time spent waiting for a usage limit is never counted: the wait happens between runs, and a run that failed
with a usage limit message is not counted as a try. The limit is per run, not per ticket. With `0` nothing changes: no
timer, and the agent runs as before.

Both can be changed in `nightshift ui` (Settings).

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
