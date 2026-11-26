import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JournalKind, PublishMode, SettleReason, TicketStatus } from "../src/enums.js";
import { TicketOutcome, TicketPipeline } from "../src/pipeline.js";
import { Journal } from "../src/report.js";
import { FIXTURES, Sandbox, readyTicket, sandbox, ticketFile, ticketStatus } from "./helpers.js";

interface Merge {
  box: Sandbox;
  ghLog: () => string;
}

// A sandbox with autoMerge on, the fake gh and a plan for what each "pr merge" answers.
function merging(mergePlan: string, overrides: Record<string, unknown> = {}): Merge {
  const dir = mkdtempSync(join(tmpdir(), "nightshift-gh-"));
  const log = join(dir, "gh.log");
  writeFileSync(log, "");
  process.env.FAKE_GH_LOG = log;
  process.env.FAKE_MERGE_PLAN = mergePlan;
  const gh = join(FIXTURES, "fake-gh-pr.sh");
  chmodSync(gh, 0o755);
  const box = sandbox({ autoMerge: true, maxRework: 0, tools: { gh }, ...overrides }, PublishMode.PullRequest);
  process.env.FAKE_REPO = box.repo;
  return { box, ghLog: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

async function runPipeline(box: Sandbox, id: string): Promise<TicketOutcome> {
  const ticket = (await box.board.list(TicketStatus.Working)).find((t) => t.id === id);
  assert.ok(ticket, `ticket ${id} should be working`);
  return new TicketPipeline(box.runner, ticket, "slot-test").run();
}

function merges(m: Merge): number {
  return m.ghLog().split("\n").filter((l) => l.startsWith("pr merge")).length;
}

test("a merge conflict sends the developer back, the review and merge run again, and the ticket is merged", async () => {
  const m = merging("CONFLICT OK");
  const id = await readyTicket(m.box, "Touch work");
  m.box.plan(["BUILD_PR", "REVIEW PASS", "CONFLICT_FIX", "REVIEW PASS"]);
  assert.equal(await runPipeline(m.box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(m.box, id), TicketStatus.Done);
  assert.equal(merges(m), 2);
  assert.equal(m.box.calls().length, 4);
  assert.match(m.box.calls()[2] ?? "", /^new .* You are the developer/);
  assert.match(m.box.calls()[3] ?? "", /^new .* You are the reviewer/);
  // The prompt names the conflicting file and tells the developer how to bring the base branch in.
  assert.match(m.box.prompt(3), /conflicts with `main`/);
  assert.match(m.box.prompt(3), /- work\.txt/);
  assert.match(m.box.prompt(3), /git merge main/);
  assert.match(m.box.prompt(3), /never force/);
  const file = ticketFile(m.box, id);
  assert.match(file, /re-fitted after merge conflict 1x \(limit 1\): the developer is sent back .* Conflicting files: work\.txt/);
  const settled = new Journal(m.box.runner.paths.journal).read().filter((r) => r.kind === JournalKind.Settled);
  assert.equal(settled[0]?.kind === JournalKind.Settled ? settled[0].conflictRetries : -1, 1);
});

test("a conflict that is still there after the retry leaves the ticket in review (merge-failed) naming the files", async () => {
  const m = merging("CONFLICT CONFLICT");
  const id = await readyTicket(m.box, "Touch work");
  m.box.plan(["BUILD_PR", "REVIEW PASS", "CONFLICT_FIX", "REVIEW PASS"]);
  assert.equal(await runPipeline(m.box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(m.box, id), TicketStatus.Review);
  assert.equal(merges(m), 2);
  assert.equal(m.box.calls().length, 4);
  const file = ticketFile(m.box, id);
  assert.match(file, /merge failed on a conflict/);
  assert.match(file, /re-fitted after merge conflict 1x/);
  assert.match(file, /Conflicting files: work\.txt/);
  const last = new Journal(m.box.runner.paths.journal).read().at(-1);
  assert.ok(last !== undefined && last.kind === JournalKind.Settled);
  assert.equal(last.reason, SettleReason.MergeFailed);
  assert.equal(last.conflictRetries, 1);
});

test("maxConflictRetries 0 keeps the old behavior: review (merge-failed) at once, no mergeable lookup", async () => {
  const m = merging("CONFLICT OK", { maxConflictRetries: 0 });
  const id = await readyTicket(m.box, "Touch work");
  m.box.plan(["BUILD_PR", "REVIEW PASS"]);
  assert.equal(await runPipeline(m.box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(m.box, id), TicketStatus.Review);
  assert.equal(m.box.calls().length, 2);
  assert.equal(merges(m), 1);
  assert.doesNotMatch(m.ghLog(), /mergeable/);
  assert.match(ticketFile(m.box, id), /review passed but the merge failed \(/);
  assert.doesNotMatch(ticketFile(m.box, id), /re-fitted/);
});

test("a merge failure that is not a conflict (permissions) is not retried", async () => {
  const m = merging("DENIED OK");
  const id = await readyTicket(m.box, "Touch work");
  m.box.plan(["BUILD_PR", "REVIEW PASS"]);
  assert.equal(await runPipeline(m.box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(m.box, id), TicketStatus.Review);
  assert.equal(m.box.calls().length, 2);
  assert.equal(merges(m), 1);
  assert.match(m.ghLog(), /--json mergeable/);
  assert.match(ticketFile(m.box, id), /Resource not accessible/);
});

test("a testCommand that fails after the conflict was resolved stops the merge", async () => {
  const m = merging("CONFLICT OK");
  // The check passes until the developer's conflict run adds resolved.txt.
  const project = m.box.config.projects[0];
  assert.ok(project);
  project.testCommand = "test ! -f resolved.txt";
  const id = await readyTicket(m.box, "Touch work");
  m.box.plan(["BUILD_PR", "REVIEW PASS", "CONFLICT_FIX", "REVIEW PASS"]);
  assert.equal(await runPipeline(m.box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(m.box, id), TicketStatus.Blocked);
  assert.equal(merges(m), 1);
  assert.match(ticketFile(m.box, id), /runner check failed: test ! -f resolved\.txt/);
});

test("a conflict the developer reports as unresolvable ends in review (merge-failed) with its reason", async () => {
  const m = merging("CONFLICT OK");
  const id = await readyTicket(m.box, "Touch work");
  m.box.plan(["BUILD_PR", "REVIEW PASS", "CONFLICT_BLOCKED"]);
  assert.equal(await runPipeline(m.box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(m.box, id), TicketStatus.Review);
  assert.equal(merges(m), 1);
  assert.match(ticketFile(m.box, id), /could not resolve the merge conflict: both sides rewrote work\.txt/);
});

test("gatePaths judges the files after the conflict resolution: a gated file sends the ticket to a human", async () => {
  const m = merging("CONFLICT OK", { gatePaths: ["resolved.txt"] });
  const id = await readyTicket(m.box, "Touch work");
  m.box.plan(["BUILD_PR", "REVIEW PASS", "CONFLICT_FIX", "REVIEW PASS"]);
  assert.equal(await runPipeline(m.box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(m.box, id), TicketStatus.Blocked);
  assert.equal(merges(m), 1);
  assert.match(ticketFile(m.box, id), /gated paths/);
});
