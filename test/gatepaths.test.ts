import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, parseConfig } from "../src/config.js";
import { PublishMode, TicketStatus } from "../src/enums.js";
import { changedFiles, ensureWorktree, gateHits, globToRegExp, worktreeFor } from "../src/git.js";
import { TicketOutcome, TicketPipeline } from "../src/pipeline.js";
import { FIXTURES, Sandbox, readyTicket, sandbox, ticketFile, ticketStatus } from "./helpers.js";

async function runPipeline(box: Sandbox, id: string): Promise<TicketOutcome> {
  const ticket = (await box.board.list(TicketStatus.Working)).find((t) => t.id === id);
  assert.ok(ticket, `ticket ${id} should be working`);
  return new TicketPipeline(box.runner, ticket, "slot-test").run();
}

test("globs: * stays in one folder, ** crosses folders, ? is one character", () => {
  const match = (glob: string, path: string): boolean => globToRegExp(glob).test(path);
  assert.ok(match("work.txt", "work.txt"));
  assert.ok(!match("work.txt", "src/work.txt"));
  assert.ok(match("src/*.ts", "src/a.ts"));
  assert.ok(!match("src/*.ts", "src/deep/a.ts"));
  assert.ok(match("src/**", "src/deep/a.ts"));
  assert.ok(match("**/*.sql", "db/migration/V1.sql"));
  assert.ok(match("**/*.sql", "V1.sql"));
  assert.ok(match("db/v?.sql", "db/v1.sql"));
  assert.ok(!match("a.b", "axb"));
  assert.deepEqual(gateHits(["docs/**", "*.txt"], ["docs/x.md", "work.txt", "src/y.ts"]), [
    { glob: "docs/**", files: ["docs/x.md"] },
    { glob: "*.txt", files: ["work.txt"] },
  ]);
});

test("gatePaths defaults to off and rejects an empty glob", () => {
  assert.deepEqual(parseConfig({ projects: {} }, "/w").gatePaths, []);
  assert.deepEqual(parseConfig({ projects: {}, gatePaths: [" db/** "] }, "/w").gatePaths, ["db/**"]);
  for (const bad of [[""], ["  "], "db/**", [1]]) {
    assert.throws(() => parseConfig({ projects: {}, gatePaths: bad }, "/w"), ConfigError);
  }
});

test("changedFiles lists what a real worktree changed against the base, committed or not", async () => {
  const box = sandbox();
  const id = await readyTicket(box, "Touch things");
  box.plan(["BUILD"]);
  const ticket = (await box.board.list(TicketStatus.Working)).find((t) => t.id === id);
  assert.ok(ticket);
  // Run only the build stage by letting the review fail to find a plan line: the worktree and its commit remain.
  await new TicketPipeline(box.runner, ticket, "slot-test").run();
  const project = box.config.projects[0];
  assert.ok(project);
  const tree = worktreeFor(box.runner.paths.worktrees, id);
  assert.ok(existsSync(tree.path));
  writeFileSync(join(tree.path, "untracked-then-tracked.md"), "x\n");
  execFileSync("git", ["add", "untracked-then-tracked.md"], { cwd: tree.path });
  assert.deepEqual((await changedFiles(box.config, project, tree)).sort(), ["untracked-then-tracked.md", "work.txt"]);
});

test("a gated path changed: PASS becomes needs-human, naming the glob and file", async () => {
  const box = sandbox({ gatePaths: ["docs/**", "work.txt"] });
  const id = await readyTicket(box, "Touch work");
  box.plan(["BUILD", "REVIEW PASS"]);
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Blocked);
  const note = ticketFile(box, id);
  assert.match(note, /gated paths/);
  assert.match(note, /work\.txt -> work\.txt/);
  assert.doesNotMatch(note, /docs\/\*\*/);
  assert.match(box.prompt(2), /## Gated paths[\s\S]*- docs\/\*\*[\s\S]*- work\.txt/);
});

test("no gated path changed: the pass goes ready-to-merge as before", async () => {
  const box = sandbox({ gatePaths: ["docs/**", "src/**"] });
  const id = await readyTicket(box, "Touch work");
  box.plan(["BUILD", "REVIEW PASS"]);
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Review);
  assert.match(ticketFile(box, id), /ready for you to merge/);
});

test("the default (no gatePaths) behaves as before and adds nothing to the review prompt", async () => {
  const box = sandbox();
  const id = await readyTicket(box, "Touch work");
  box.plan(["BUILD", "REVIEW PASS"]);
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Review);
  assert.doesNotMatch(box.prompt(2), /Gated paths/);
});

function fakeGh(): { gh: string; log: string } {
  const log = join(mkdtempSync(join(tmpdir(), "nightshift-gh-")), "gh.log");
  process.env.FAKE_GH_LOG = log;
  const gh = join(FIXTURES, "fake-gh.sh");
  chmodSync(gh, 0o755);
  return { gh, log };
}

function ghCalls(log: string): string {
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

test("with autoMerge on, a gated change is never merged; an ungated one is attempted", async () => {
  const { gh, log } = fakeGh();
  const gated = sandbox({ autoMerge: true, gatePaths: ["work.txt"], tools: { gh } }, PublishMode.PullRequest);
  const gatedId = await readyTicket(gated, "Touch work");
  gated.plan(["BUILD_PR", "REVIEW PASS"]);
  assert.equal(await runPipeline(gated, gatedId), TicketOutcome.Settled);
  assert.equal(await ticketStatus(gated, gatedId), TicketStatus.Blocked);
  assert.match(ticketFile(gated, gatedId), /gated paths/);
  assert.doesNotMatch(ghCalls(log), /pr merge/);

  const open = sandbox({ autoMerge: true, gatePaths: ["docs/**"], tools: { gh } }, PublishMode.PullRequest);
  const openId = await readyTicket(open, "Touch work");
  open.plan(["BUILD_PR", "REVIEW PASS"]);
  assert.equal(await runPipeline(open, openId), TicketOutcome.Settled);
  assert.match(ghCalls(log), /pr merge https:\/\/example.com\/pr\//);
});

test("when the changed files cannot be listed, the ticket is held for a human", async () => {
  const box = sandbox({ gatePaths: ["docs/**"] });
  const id = await readyTicket(box, "Touch work");
  box.plan(["BUILD", "REVIEW PASS"]);
  const project = box.config.projects[0];
  assert.ok(project);
  await ensureWorktree(box.config, project, worktreeFor(box.runner.paths.worktrees, id));
  project.baseBranch = "no-such-branch";
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Blocked);
  assert.match(ticketFile(box, id), /could not list the changed files/);
});
