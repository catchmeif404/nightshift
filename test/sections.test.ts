import assert from "node:assert/strict";
import { test } from "node:test";
import { add } from "../src/commands.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { dispatch, missingSections, requireSections } from "../src/dispatch.js";
import { SettleReason, TicketKind, TicketStatus } from "../src/enums.js";
import { TicketOutcome, TicketPipeline } from "../src/pipeline.js";
import { Sandbox, sandbox, ticketFile, ticketStatus } from "./helpers.js";

const LABELS = ["Deliverable", "Check", "Out of scope"];
const FULL = "Deliverable: a thing\nCheck： run npm test\n- **Out of scope:** publishing";

function addTicket(box: Sandbox, body: string): string {
  return box.board.create("Do it", "demo", TicketKind.Build, body);
}

test("missingSections accepts a full-width colon and ignores empty labels", () => {
  assert.deepEqual(missingSections(FULL, LABELS), []);
  assert.deepEqual(missingSections("Deliverable:\nCheck: ok", LABELS), ["Deliverable", "Out of scope"]);
  assert.deepEqual(missingSections("anything", []), []);
});

test("a ticket missing sections is blocked with a note naming them", async () => {
  const box = sandbox({ ticketSections: LABELS });
  const id = addTicket(box, "Deliverable: x\nCheck:");
  assert.deepEqual(await requireSections(box.runner, await box.board.list(TicketStatus.Ready)), []);
  assert.equal(await ticketStatus(box, id), TicketStatus.Blocked);
  assert.match(ticketFile(box, id), /lacks these sections.*Check, Out of scope/);
});

test("dispatch starts nothing for a ticket that lacks sections, and starts a complete one", async () => {
  const box = sandbox({ ticketSections: LABELS });
  const bad = addTicket(box, "no form");
  assert.deepEqual(await dispatch(box.runner, () => 1), []);
  assert.equal(await ticketStatus(box, bad), TicketStatus.Blocked);
  const good = addTicket(box, FULL);
  const starts = await dispatch(box.runner, () => 1);
  assert.equal(starts.length, 1);
  assert.equal(await ticketStatus(box, good), TicketStatus.Ready);
});

test("a complete ticket runs normally and both prompts list the items", async () => {
  const box = sandbox({ ticketSections: LABELS });
  const id = addTicket(box, FULL);
  await box.board.setStatus(id, TicketStatus.Working, SettleReason.Claimed, "");
  box.plan(["BUILD", "REVIEW PASS"]);
  const ticket = (await box.board.list(TicketStatus.Working))[0];
  assert.ok(ticket);
  assert.equal(await new TicketPipeline(box.runner, ticket, "slot-test").run(), TicketOutcome.Settled);
  for (const n of [1, 2]) {
    assert.match(box.prompt(n), /## Ticket form[\s\S]*- Deliverable:\n {2}- Check:\n {2}- Out of scope:/);
  }
  assert.match(box.prompt(2), /runs the items that say how to check it itself/);
});

test("the default [] keeps today's behaviour: no check, no form in prompts", async () => {
  const box = sandbox();
  const id = addTicket(box, "plain");
  assert.equal((await requireSections(box.runner, await box.board.list(TicketStatus.Ready))).length, 1);
  assert.equal(await ticketStatus(box, id), TicketStatus.Ready);
  assert.match(ticketFile(box, id), /plain/);
  assert.deepEqual(box.config.ticketSections, []);
});

test("add fills an empty form when sections are configured", () => {
  const box = sandbox({ ticketSections: LABELS });
  const id = add(box.config, "Do", "demo", TicketKind.Build, "");
  assert.match(ticketFile(box, id), /Deliverable:\n\nCheck:\n\nOut of scope:/);
  const filled = add(box.config, "Do", "demo", TicketKind.Build, "Deliverable: x\nCheck: y");
  assert.match(ticketFile(box, filled), /Check: y\n\nOut of scope:/);
  assert.doesNotMatch(ticketFile(box, filled), /Deliverable:\n/);
  const plain = sandbox();
  assert.doesNotMatch(ticketFile(plain, add(plain.config, "Do", "demo", TicketKind.Build, "")), /:\n/);
});

test("a bad ticketSections value is a config error (doctor reports it)", () => {
  for (const bad of ["x", [1], ["a:"], [""], ["A", "a"]]) {
    assert.throws(() => parseConfig({ projects: {}, ticketSections: bad }, "/tmp"), ConfigError);
  }
});
