# Getting started: your first ticket in 10 minutes

[English](GETTING-STARTED.md) | [한국어](ko/GETTING-STARTED.md)

This walks one ticket through the whole loop on your machine, with no GitHub needed. You need nightshift
[installed](INSTALL.md) and Claude Code signed in. The ticket costs two Claude Code runs (about a minute each on a
small change).

## 1. A small repository to try it on

Use a real repository with a test command, or make a toy one:

```sh
mkdir -p ~/code/demo-app && cd ~/code/demo-app && git init -b main
cat > package.json <<'EOF'
{ "name": "demo-app", "type": "module", "scripts": { "test": "node --test" } }
EOF
cat > text.js <<'EOF'
export function capitalize(word) {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}
EOF
cat > text.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { capitalize } from "./text.js";
test("capitalize", () => assert.equal(capitalize("night"), "Night"));
EOF
git add . && git commit -m "init"
```

## 2. A queue that points at it

```sh
mkdir -p ~/nightshift-queue && cd ~/nightshift-queue
nightshift init --repo-path ~/code/demo-app
nightshift doctor
```

The project is named after the folder (`demo-app`). With the local board, finished work is left on a local branch
for you to merge (`"publish": "branch"`), so nothing is pushed anywhere.

## 3. Write a ticket

```sh
nightshift add "Add a slugify helper" --project demo-app \
  --body "Add slugify(text) to text.js: lowercase, trim, runs of spaces and punctuation become one dash, no leading or trailing dashes. Add tests next to the existing ones."
```

This makes `.tickets/T-1.md`. Open it: front matter on top (`status: ready`), your ask below. The clearer the ask and
what "done" means, the better both runs do. See [writing good tickets](USAGE.md#writing-good-tickets).

## 4. Run it and watch

```sh
nightshift run          # starts a worker in the background and returns
nightshift logs -f      # follow it; Ctrl+C stops following, not the worker
```

You will see, in order:

```
T-1 build r1: starting claude-code session ...        the developer (sonnet) builds on branch nightshift/t-1
T-1 build r1: exit 0: ...                             its own summary, last lines
T-1 review r1: starting claude-code session ...       the reviewer (opus) checks it, runs the tests, may fix things
T-1 verdict r1: PASS (BRANCH nightshift/t-1)
T-1 -> review (ready-to-merge): review passed, ready for you to merge: branch nightshift/t-1. Review: ...
work demo-app: done
```

## 5. Look at the result

```sh
nightshift status                 # T-1 is under "review"
cat .tickets/T-1.md               # the notes at the bottom: what happened and the reviewer's summary
cd ~/code/demo-app
git log --oneline main..nightshift/t-1
git diff main...nightshift/t-1
npm test
```

The reviewer's full notes are in `~/nightshift-queue/.nightshift/results/T-1.review`.

## 6. Merge it (you decide)

```sh
cd ~/code/demo-app
git merge nightshift/t-1
```

Then mark the ticket done: change `status: review` to `status: done` in `.tickets/T-1.md`.

## What next

- Try a ticket the reviewer should send back, or one it should stop: "Change the price to $5" is a `money` item, so
  the verdict is `NEEDS_HUMAN` and the ticket goes to `blocked` with the decision written out.
- Put house rules in `nightshift.rules.md` (test command, commit style, things never to touch).
- Move to GitHub Issues and pull requests: [Usage → GitHub](USAGE.md#github-issues-and-pull-requests).
- Keep it running on its own: `nightshift service install` ([Usage → running continuously](USAGE.md#running-continuously)).
