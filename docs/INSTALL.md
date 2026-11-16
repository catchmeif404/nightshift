# Install

[English](INSTALL.md) | [한국어](ko/INSTALL.md)

## What you need

| | why | check |
|---|---|---|
| Node.js 20 or newer | nightshift is a Node CLI | `node --version` |
| git | every ticket gets its own worktree and branch | `git --version` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code), signed in | the built-in agent for building and reviewing | `claude --version`, then run `claude` once and sign in |
| [GitHub CLI](https://cli.github.com/), signed in | only for the GitHub Issues board or pull requests | `gh auth status` |
| [Codex CLI](https://github.com/openai/codex), signed in | only if Codex builds or reviews | `codex --version`, `codex login` |
| a Notion integration secret | only for the Notion board | see [Notion as the board](USAGE.md#notion-as-the-board) |

nightshift runs Claude Code unattended with `--permission-mode auto`. Open `claude` once in a terminal first and make
sure it works on its own: the runs use your normal Claude Code sign-in and settings (including your global
`~/.claude/CLAUDE.md`).

## Install the CLI

From npm (once 0.1 is published):

```sh
npm install -g nightshift
nightshift --help
```

From source (works today):

```sh
git clone <this repository> nightshift
cd nightshift
npm install
npm run build
npm link            # puts "nightshift" on your PATH
nightshift --help
```

To update a source install: `git pull && npm install && npm run build`.

## Make a queue folder

nightshift keeps its config, tickets and state in one folder, separate from your code. Your repositories can live
anywhere; the config points at them.

```sh
mkdir ~/nightshift-queue && cd ~/nightshift-queue
nightshift init --repo-path ~/code/my-app
nightshift doctor
```

`init` writes:

| file | what it is |
|---|---|
| `nightshift.json` | the config: board, projects, models, limits |
| `nightshift.rules.md` | house rules added to every prompt; edit it |
| `.tickets/` | the local ticket board (for `--board local-md`) |

and nightshift creates `.nightshift/` on first run for its log, worktrees and run state. Put `.nightshift/` in your
backups if you like, never in git.

`doctor` checks Node, git, the agent CLIs, `gh` (when needed) and that each project path is a git repository. Fix
anything marked `FAIL` before the first run.

Next: [Getting started](GETTING-STARTED.md).

## Uninstall

```sh
npm uninstall -g nightshift      # or, for a source install: npm unlink -g nightshift
rm -rf ~/nightshift-queue        # the queue folder: config, tickets, logs, worktrees
```

Worktrees nightshift made are registered in your repositories; after deleting the queue folder run
`git worktree prune` in each repository. Branches it made start with `nightshift/` and stay until you delete them.
