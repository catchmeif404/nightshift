import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { TicketStatus } from "../src/enums.js";
import { worktreeFor } from "../src/git.js";
import { TicketOutcome, TicketPipeline } from "../src/pipeline.js";
import { Sandbox, readyTicket, sandbox, ticketFile, ticketStatus } from "./helpers.js";

async function runPipeline(box: Sandbox, id: string): Promise<TicketOutcome> {
  const ticket = (await box.board.list(TicketStatus.Working)).find((t) => t.id === id);
  assert.ok(ticket, `ticket ${id} should be working`);
  return new TicketPipeline(box.runner, ticket, "slot-test").run();
}

test("a passing ticket goes to review on its own branch, never touching main", async () => {
  const box = sandbox();
  const id = await readyTicket(box, "Add a footer");
  box.plan(["BUILD", "REVIEW PASS"]);

  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Review);
  assert.match(ticketFile(box, id), /review passed, ready for you to merge: branch nightshift\/t-1/);

  const calls = box.calls();
  assert.equal(calls.length, 2);
  assert.match(calls[0] ?? "", /^new .* You are the developer/);
  assert.match(calls[1] ?? "", /^new .* You are the reviewer/);
  const log = execFileSync("git", ["log", "--oneline", "nightshift/t-1"], { cwd: box.repo, encoding: "utf8" });
  assert.match(log, /fake change 1/);
  const main = execFileSync("git", ["log", "--oneline", "main"], { cwd: box.repo, encoding: "utf8" });
  assert.doesNotMatch(main, /fake change/);
});

test("rework sends the review notes back to the developer, then passes", async () => {
  const box = sandbox();
  const id = await readyTicket(box, "Add dark mode");
  box.plan(["BUILD", "REVIEW REWORK", "BUILD", "REVIEW PASS"]);

  await runPipeline(box, id);
  assert.equal(await ticketStatus(box, id), TicketStatus.Review);
  assert.equal(box.calls().length, 4);
  assert.match(box.prompt(3), /Review notes from the previous round/);
  assert.match(box.prompt(3), /review note round 2: REWORK/);
  assert.match(box.prompt(3), /round 2/);
  assert.match(ticketFile(box, id), /sent back for rework/);
});

test("rework on the last round blocks the ticket", async () => {
  const box = sandbox({ maxRework: 0 });
  const id = await readyTicket(box, "Rewrite everything");
  box.plan(["BUILD", "REVIEW REWORK"]);
  await runPipeline(box, id);
  assert.equal(await ticketStatus(box, id), TicketStatus.Blocked);
  assert.match(box.prompt(2), /This is the last round/);
});

test("a blocked build and a needs-human review both block with the reason", async () => {
  const box = sandbox();
  const blocked = await readyTicket(box, "Migrate the database");
  box.plan(["BUILD_BLOCKED"]);
  await runPipeline(box, blocked);
  assert.equal(await ticketStatus(box, blocked), TicketStatus.Blocked);
  assert.match(ticketFile(box, blocked), /missing access to the staging database/);

  const human = await readyTicket(box, "Change the pricing page");
  box.plan(["BUILD_BLOCKED", "BUILD", "REVIEW NEEDS_HUMAN"]);
  await runPipeline(box, human);
  assert.equal(await ticketStatus(box, human), TicketStatus.Blocked);
  assert.match(ticketFile(box, human), /needs a human decision/);
});

test("a cut-off stage resumes the same session, and gives up after maxStageTries", async () => {
  const box = sandbox({ maxStageTries: 3 });
  const id = await readyTicket(box, "Fix the flaky test");
  box.plan(["EXIT 1", "EXIT 1", "BUILD", "REVIEW PASS"]);

  assert.equal(await runPipeline(box, id), TicketOutcome.Paused);
  assert.equal(await ticketStatus(box, id), TicketStatus.Working);
  assert.equal(await runPipeline(box, id), TicketOutcome.Paused);
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Review);

  const calls = box.calls().map((line) => line.split(" ").slice(0, 2));
  assert.equal(calls[0]?.[0], "new");
  assert.deepEqual(calls[1], ["resume", calls[0]?.[1]]);
  assert.deepEqual(calls[2], ["resume", calls[0]?.[1]]);
  assert.match(box.prompt(2), /was cut off/);
  assert.equal(calls[3]?.[0], "new", "the review stage starts its own session");

  const giveUp = await readyTicket(box, "Never finishes");
  box.plan(["EXIT 1", "EXIT 1", "EXIT 1", "EXIT 1", "EXIT 1", "EXIT 1", "EXIT 1"]);
  for (let i = 0; i < 3; i += 1) assert.equal(await runPipeline(box, giveUp), TicketOutcome.Paused);
  assert.equal(await runPipeline(box, giveUp), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, giveUp), TicketStatus.Blocked);
  assert.match(ticketFile(box, giveUp), /cut off 3 times/);
});

test("an unreadable result is set aside and the stage is retried, not trusted", async () => {
  const box = sandbox();
  const id = await readyTicket(box, "Trust issues");
  box.plan(["GARBAGE", "BUILD", "REVIEW PASS"]);
  assert.equal(await runPipeline(box, id), TicketOutcome.Paused);
  assert.equal(await ticketStatus(box, id), TicketStatus.Working);
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Review);
  assert.match(box.calls()[1] ?? "", /^resume /);
});

test("a ticket for an unknown project is blocked before any agent runs", async () => {
  const box = sandbox();
  const id = box.board.create("Orphan", "nope", (await import("../src/enums.js")).TicketKind.Build, "");
  await box.board.setStatus(id, TicketStatus.Working, "");
  await runPipeline(box, id);
  assert.equal(await ticketStatus(box, id), TicketStatus.Blocked);
  assert.equal(box.calls().length, 0);
  assert.equal(existsSync(worktreeFor(box.runner.paths.worktrees, id).path), false);
});
