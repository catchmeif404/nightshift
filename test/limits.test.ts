import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatch, work } from "../src/dispatch.js";
import { SettleReason, StateFile, TicketKind, TicketStatus } from "../src/enums.js";
import { detectLimit } from "../src/limits.js";
import { TicketOutcome, TicketPipeline } from "../src/pipeline.js";
import { TicketState, projectSlotKey } from "../src/state.js";
import { Sandbox, readyTicket, sandbox, ticketFile, ticketStatus } from "./helpers.js";

const at = (iso: string): number => Date.parse(iso);
const MARGIN = 2 * 60_000;

test("usage-limit messages give the reset time in their own time zone", () => {
  // 14:01:59 in Seoul is 05:01:59 UTC; 3:30pm Seoul is 06:30 UTC.
  const now = at("2026-11-05T05:01:59Z");
  const hit = detectLimit("You've hit your 5-hour limit · resets 3:30pm (Asia/Seoul)", now, 60)[0];
  assert.equal(hit?.until, at("2026-11-05T06:30:00Z") + MARGIN);
  // 23:00 Seoul, resets 4:10am: tomorrow.
  const late = detectLimit("You've hit your session limit · resets 4:10am (Asia/Seoul)", at("2026-11-05T14:00:00Z"), 60)[0];
  assert.equal(late?.until, at("2026-11-05T19:10:00Z") + MARGIN);
  const weekly = detectLimit("You've hit your weekly limit · resets Nov 18, 9am (Asia/Seoul)", now, 60)[0];
  assert.equal(weekly?.until, at("2026-11-18T00:00:00Z") + MARGIN);
  const tryIn = detectLimit("Error: usage limit reached, try again in 2 hours 13 minutes", now, 60)[0];
  assert.equal(tryIn?.until, now + (2 * 60 + 13) * 60_000 + MARGIN);
  assert.equal(detectLimit("usage limit reached", now, 45)[0]?.until, now + 45 * 60_000);
  assert.deepEqual(detectLimit("Error: tests failed", now, 60), []);
});

async function runIt(box: Sandbox, id: string): Promise<TicketOutcome> {
  const ticket = (await box.board.list(TicketStatus.Working)).find((t) => t.id === id);
  assert.ok(ticket);
  return new TicketPipeline(box.runner, ticket, "slot").run();
}

const reset = (box: Sandbox): void => box.runner.limits.set("command", Date.now() - 1, "over");

test("a usage limit is not a try: it waits, resumes the same session and never blocks the ticket", async () => {
  const box = sandbox({ maxStageTries: 3 });
  const id = await readyTicket(box, "Keep going");
  box.plan(["LIMIT", "LIMIT", "LIMIT", "LIMIT", "BUILD", "REVIEW PASS"]);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(await runIt(box, id), TicketOutcome.Limited);
    assert.equal(new TicketState(box.runner.paths.results, id).read(StateFile.Tries), "0");
    assert.equal(box.runner.limits.active(Date.now()).length, 1);
    reset(box);
  }
  assert.equal(await runIt(box, id), TicketOutcome.Settled);
  assert.equal(await ticketStatus(box, id), TicketStatus.Review);
  const sessions = box.calls().map((c) => c.split(" ").slice(0, 2));
  assert.deepEqual(sessions.slice(1, 5).map((s) => s[0]), ["resume", "resume", "resume", "resume"]);
  assert.ok(sessions.slice(1, 5).every((s) => s[1] === sessions[0]?.[1]), "always the same session");
  assert.match(ticketFile(box, id), /hit its usage limit; waiting until/);
});

test("while a limit is in force nothing is dispatched, and a worker stops instead of taking the next ticket", async () => {
  const box = sandbox();
  const first = box.board.create("First", "demo", TicketKind.Build, "");
  const second = box.board.create("Second", "demo", TicketKind.Build, "");
  box.plan(["LIMIT"]);
  const key = projectSlotKey("demo");
  box.runner.slots.tryCreate(key, "demo", false);
  await work(box.runner, key);
  assert.equal(await ticketStatus(box, first), TicketStatus.Working);
  assert.equal(await ticketStatus(box, second), TicketStatus.Ready, "the next ticket was not claimed");
  assert.equal(box.calls().length, 1);

  assert.deepEqual(await dispatch(box.runner, () => process.pid), []);
  reset(box);
  const starts = await dispatch(box.runner, () => process.pid);
  assert.deepEqual(starts.map((s) => s.target), ["demo"]);
  box.runner.slots.remove(key);
  await box.board.setStatus(first, TicketStatus.Blocked, SettleReason.Blocked, "");
});
