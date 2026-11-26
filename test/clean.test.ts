import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommandAgent } from "../src/agent/command.js";
import { CleanKind, applyClean, planClean } from "../src/clean.js";
import { SessionMode, SettleReason, StateFile, TicketKind, TicketStatus } from "../src/enums.js";
import { ensureWorktree, worktreeFor } from "../src/git.js";
import { Sandbox, sandbox } from "./helpers.js";

async function worktreeOf(box: Sandbox, status: TicketStatus): Promise<{ id: string; path: string }> {
  const id = box.board.create(`ticket ${status}`, "demo", TicketKind.Build, "body");
  const project = box.config.projects[0];
  assert.ok(project);
  const tree = await ensureWorktree(box.config, project, worktreeFor(box.runner.paths.worktrees, id));
  await box.board.setStatus(id, status, SettleReason.Claimed, "");
  return { id, path: tree.path };
}

function age(path: string, days: number): void {
  const when = new Date(Date.now() - days * 86_400_000);
  utimesSync(path, when, when);
}

test("a folder at the worktree path that git does not know is moved aside and a new worktree is made", async () => {
  const box = sandbox();
  const project = box.config.projects[0];
  assert.ok(project);
  const tree = worktreeFor(box.runner.paths.worktrees, "TK-446");
  mkdirSync(join(tree.path, ".next"), { recursive: true });
  writeFileSync(join(tree.path, ".next", "build.txt"), "leftover");
  const lines: string[] = [];

  await ensureWorktree(box.config, project, tree, (l) => lines.push(l));

  assert.ok(existsSync(join(tree.path, "README.md")), "the new worktree has the repository's files");
  assert.ok(existsSync(join(tree.path, ".git")));
  const aside = readdirSync(box.runner.paths.worktrees).filter((n) => n.startsWith("tk-446.old-"));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(box.runner.paths.worktrees, aside[0] ?? "", ".next", "build.txt"), "utf8"), "leftover");
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /moved it to/);
  // A real worktree is returned as it is the second time.
  await ensureWorktree(box.config, project, tree, (l) => lines.push(l));
  assert.equal(lines.length, 1);
});

test("a registered worktree whose folder lost its .git file is moved aside and made again", async () => {
  const box = sandbox();
  const project = box.config.projects[0];
  assert.ok(project);
  const tree = await ensureWorktree(box.config, project, worktreeFor(box.runner.paths.worktrees, "TK-464"));
  rmSync(join(tree.path, ".git"));
  mkdirSync(join(tree.path, ".vite"));
  const lines: string[] = [];

  await ensureWorktree(box.config, project, tree, (l) => lines.push(l));

  assert.equal(lines.length, 1);
  assert.ok(existsSync(join(tree.path, ".git")));
  assert.equal(existsSync(join(tree.path, ".vite")), false);
  assert.equal(readdirSync(box.runner.paths.worktrees).filter((n) => n.startsWith("tk-464.old-")).length, 1);
});

test("a run that ended by itself leaves no background process of its own behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nightshift-cleanup-"));
  const script = join(dir, "agent.sh");
  const pidFile = join(dir, "pid");
  writeFileSync(script, `#!/bin/sh\nsleep 300 &\necho $! > "${pidFile}"\necho done\n`);
  chmodSync(script, 0o755);
  const agent = new CommandAgent(script, dir);

  const result = await agent.run({ prompt: "p", model: "", cwd: dir, sessionId: "s", mode: SessionMode.New, writableDirs: [], timeoutMinutes: 0 });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /done/);
  assert.equal(result.cleaned, 1);
  const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
  let alive = true;
  for (let i = 0; i < 20 && alive; i += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the background sleep is gone");
});

test("clean lists in a dry run, and --apply removes only what belongs to done tickets", async () => {
  const box = sandbox({ keepDays: 14 });
  const done = await worktreeOf(box, TicketStatus.Done);
  const dirty = await worktreeOf(box, TicketStatus.Done);
  writeFileSync(join(dirty.path, "wip.txt"), "uncommitted");
  const blocked = await worktreeOf(box, TicketStatus.Blocked);
  const review = await worktreeOf(box, TicketStatus.Review);
  const stray = join(box.runner.paths.worktrees, "leftover");
  mkdirSync(join(stray, ".vite"), { recursive: true });
  writeFileSync(join(stray, ".vite", "x"), "x");

  const results = box.runner.paths.results;
  const files = new Map<string, string>();
  for (const [name, ticket] of [["done", done.id], ["blocked", blocked.id], ["review", review.id]] as const) {
    const shot = join(results, `${ticket}-evidence`);
    mkdirSync(shot);
    writeFileSync(join(shot, "a.png"), "png");
    const build = join(results, `${ticket}.${StateFile.Build}`);
    writeFileSync(build, "PR x\n");
    for (const p of [join(shot, "a.png"), shot, build]) age(p, 30);
    files.set(name, shot);
    files.set(`${name}-build`, build);
  }
  const young = join(results, `${dirty.id}-evidence`);
  mkdirSync(young);
  writeFileSync(join(young, "a.png"), "png");
  const workDir = join(box.config.stateDir, "work", done.id.toLowerCase());
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, "tmp"), "t");
  age(join(workDir, "tmp"), 30);
  age(workDir, 30);

  const plan = await planClean(box.config, box.board, Date.now(), box.runner.paths);
  const kinds = plan.items.map((i) => `${i.kind}:${i.path}`).sort();
  assert.deepEqual(
    kinds,
    [
      `${CleanKind.Worktree}:${done.path}`,
      `${CleanKind.Stray}:${stray}`,
      `${CleanKind.Results}:${files.get("done")}`,
      `${CleanKind.Work}:${workDir}`,
    ].sort(),
  );
  assert.ok(plan.kept.some((k) => k.path === dirty.path && /uncommitted/.test(k.why)));
  assert.ok(plan.kept.some((k) => k.path === blocked.path));
  assert.ok(plan.kept.some((k) => k.path === review.path));

  // The plan alone deletes nothing.
  for (const p of [done.path, dirty.path, blocked.path, review.path, stray, workDir, files.get("done") ?? ""]) assert.ok(existsSync(p), p);

  const outcome = await applyClean(box.config, plan);
  assert.equal(outcome.failed.length, 0);
  for (const p of [done.path, stray, workDir, files.get("done") ?? ""]) assert.equal(existsSync(p), false, p);
  for (const p of [dirty.path, blocked.path, review.path, files.get("blocked") ?? "", files.get("review") ?? "", files.get("done-build") ?? "", young]) {
    assert.ok(existsSync(p), p);
  }
  // A branch stays after its worktree is gone.
  assert.match(execFileSync("git", ["branch", "--list", `nightshift/${done.id.toLowerCase()}`], { cwd: box.repo, encoding: "utf8" }), /nightshift\//);
});
