import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PublishMode, SettleReason, StateFile, TicketKind, TicketStatus } from "../src/enums.js";
import { TicketState } from "../src/state.js";
import { parseNumstat, worktreeFor } from "../src/git.js";
import { TicketOutcome, TicketPipeline, outputTail } from "../src/pipeline.js";
import { UsageLog, reviewerEdits } from "../src/usage.js";
import { FIXTURES, Sandbox, readyTicket, sandbox, ticketFile, ticketStatus } from "./helpers.js";

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
  const id = box.board.create("Orphan", "nope", TicketKind.Build, "");
  await box.board.setStatus(id, TicketStatus.Working, SettleReason.Claimed, "");
  await runPipeline(box, id);
  assert.equal(await ticketStatus(box, id), TicketStatus.Blocked);
  assert.equal(box.calls().length, 0);
  assert.equal(existsSync(worktreeFor(box.runner.paths.worktrees, id).path), false);
});

function withCheck(box: Sandbox, command: string, minutes = 15): void {
  const project = box.config.projects[0];
  assert.ok(project);
  project.testCommand = command;
  project.testTimeoutMinutes = minutes;
}

test("a passing testCommand lets the review stand; it ran in the ticket's worktree", async () => {
  const box = sandbox();
  withCheck(box, `pwd >> "${box.root}/check-ran.txt"; test -f work.txt`);
  const id = await readyTicket(box, "Add a footer");
  box.plan(["BUILD", "REVIEW PASS"]);
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Review);
  assert.equal(box.calls().length, 2);
  const ran = readFileSync(join(box.root, "check-ran.txt"), "utf8").trim();
  assert.equal(realpathSync(ran), realpathSync(worktreeFor(box.runner.paths.worktrees, id).path));
});

test("without a testCommand nothing extra runs and the flow is the same as before", async () => {
  const box = sandbox();
  assert.equal(box.config.projects[0]?.testCommand, "");
  assert.equal(box.config.projects[0]?.testTimeoutMinutes, 15);
  const id = await readyTicket(box, "Add a footer");
  box.plan(["BUILD", "REVIEW PASS"]);
  await runPipeline(box, id);
  assert.equal(await ticketStatus(box, id), TicketStatus.Review);
  assert.doesNotMatch(ticketFile(box, id), /runner check|reviewer changed/i);
});

test("a failing testCommand turns a PASS into rework with the output end, then passes after the fix", async () => {
  const box = sandbox();
  withCheck(box, 'echo "lines: $(wc -l < work.txt)"; echo extra-output-line >&2; test "$(wc -l < work.txt)" -ge 2');
  const id = await readyTicket(box, "Add dark mode");
  box.plan(["BUILD", "REVIEW PASS", "BUILD", "REVIEW PASS"]);
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Review);
  assert.equal(box.calls().length, 4);
  assert.match(box.prompt(3), /Review notes from the previous round/);
  assert.match(box.prompt(3), /review note round 2: PASS/);
  assert.match(box.prompt(3), /Runner check failed: `echo "lines/);
  assert.match(box.prompt(3), /lines: +1\nextra-output-line/);
  assert.match(ticketFile(box, id), /the runner's own check failed/);
});

test("a failing testCommand with no rework left blocks the ticket and never merges, even with autoMerge", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "nightshift-gh-")), "gh.log");
  process.env.FAKE_GH_LOG = log;
  const gh = join(FIXTURES, "fake-gh.sh");
  chmodSync(gh, 0o755);
  const box = sandbox({ autoMerge: true, maxRework: 0, tools: { gh } }, PublishMode.PullRequest);
  withCheck(box, "echo first; echo the-last-line; exit 3");
  const id = await readyTicket(box, "Touch work");
  box.plan(["BUILD_PR", "REVIEW PASS"]);
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Blocked);
  assert.match(ticketFile(box, id), /runner check failed: echo first; echo the-last-line; exit 3\. Last output line: the-last-line/);
  assert.equal(box.calls().length, 2);
  assert.doesNotMatch(existsSync(log) ? readFileSync(log, "utf8") : "", /pr merge/);
});

test("a testCommand that runs past testTimeoutMinutes is killed and counts as failed", async () => {
  const box = sandbox({ maxRework: 0 });
  withCheck(box, "echo started; sleep 30", 0.02);
  const id = await readyTicket(box, "Slow tests");
  box.plan(["BUILD", "REVIEW PASS"]);
  const started = Date.now();
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.ok(Date.now() - started < 20_000, "the check was killed, not waited for");
  assert.equal(await ticketStatus(box, id), TicketStatus.Blocked);
  assert.match(ticketFile(box, id), /runner check failed \(timed out after 0\.02 min\): echo started; sleep 30/);
});

test("the end of a long output is cut to 60 lines", () => {
  const output = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const lines = outputTail(output).split("\n");
  assert.equal(lines.length, 60);
  assert.equal(lines[0], "line 41");
  assert.equal(lines[59], "line 100");
});

test("git numstat is summed into files and +/- lines; a binary file counts as a file only", () => {
  assert.deepEqual(parseNumstat("10\t2\ta.ts\n2\t1\tb.ts\n-\t-\timg.png\n"), { files: 3, added: 12, removed: 3 });
  assert.deepEqual(parseNumstat(""), { files: 0, added: 0, removed: 0 });
});

test("a reviewer who changes the code is counted in the note, the usage file and the journal; one who does not is not", async () => {
  const box = sandbox();
  const id = await readyTicket(box, "Fix the thing");
  box.plan(["BUILD", "REVIEW_EDIT PASS"]);
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.match(ticketFile(box, id), /the reviewer changed code itself: 1 file, \+3\/-0/);
  const entries = new UsageLog(box.runner.paths.usage, id).read();
  assert.deepEqual(reviewerEdits(entries), { files: 1, added: 3, removed: 0 });
  const journal = readFileSync(box.runner.paths.journal, "utf8");
  assert.match(journal, /"reviewerFiles":1,"reviewerAdded":3,"reviewerRemoved":0/);

  const quiet = sandbox();
  const quietId = await readyTicket(quiet, "Nothing to fix");
  quiet.plan(["BUILD", "REVIEW PASS"]);
  await runPipeline(quiet, quietId);
  assert.deepEqual(reviewerEdits(new UsageLog(quiet.runner.paths.usage, quietId).read()), { files: 0, added: 0, removed: 0 });
  assert.doesNotMatch(ticketFile(quiet, quietId), /reviewer changed code/);
});

test("a run past stageTimeoutMinutes is killed, resumed in the same session, and blocks after maxStageTries with the time-limit reason", async () => {
  const box = sandbox({ maxStageTries: 2, stageTimeoutMinutes: 0.02 });
  const id = await readyTicket(box, "Sleeps forever");
  box.plan(["SLEEP", "SLEEP"]);

  const started = Date.now();
  assert.equal(await runPipeline(box, id), TicketOutcome.Paused);
  assert.ok(Date.now() - started < 20_000, "the 60 second sleep was cut at the limit");
  assert.equal(await ticketStatus(box, id), TicketStatus.Working);
  assert.equal(await runPipeline(box, id), TicketOutcome.Paused);
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Blocked);

  const calls = box.calls().map((line) => line.split(" ").slice(0, 2));
  assert.equal(calls.length, 2, "no third run once the tries are used up");
  assert.equal(calls[0]?.[0], "new");
  assert.deepEqual(calls[1], ["resume", calls[0]?.[1]]);
  assert.match(ticketFile(box, id), /time limit of 0\.02 min exceeded/);
  assert.match(readFileSync(box.runner.paths.log, "utf8"), /passed the time limit of 0\.02 min, process group killed/);
});

test("the time-limit note reads in Korean and a finished run forgets an earlier timeout", async () => {
  const box = sandbox({ maxStageTries: 3, stageTimeoutMinutes: 0.02, language: "ko" });
  const id = await readyTicket(box, "Slow once");
  box.plan(["SLEEP", "BUILD", "REVIEW PASS", "SLEEP", "SLEEP", "SLEEP"]);
  assert.equal(await runPipeline(box, id), TicketOutcome.Paused);
  assert.equal(new TicketState(box.runner.paths.results, id).has(StateFile.TimedOut), true);
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Review);

  const slow = await readyTicket(box, "Always slow");
  for (let i = 0; i < 3; i += 1) assert.equal(await runPipeline(box, slow), TicketOutcome.Paused);
  assert.equal(await runPipeline(box, slow), TicketOutcome.Settled);
  assert.match(ticketFile(box, slow), /시간 제한 0\.02분 초과/);
});

test("stageTimeoutMinutes 0 leaves a slow run alone, and a failing run is still just cut off", async () => {
  const box = sandbox({ maxStageTries: 3 });
  assert.equal(box.config.stageTimeoutMinutes, 0);
  const id = await readyTicket(box, "Normal");
  box.plan(["EXIT 1", "BUILD", "REVIEW PASS"]);
  assert.equal(await runPipeline(box, id), TicketOutcome.Paused);
  assert.equal(new TicketState(box.runner.paths.results, id).has(StateFile.TimedOut), false);
  assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Review);
});
