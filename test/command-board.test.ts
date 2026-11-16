import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandBoard } from "../src/board/command.js";
import { BoardType, NoteLanguage, SettleReason, TicketKind, TicketStatus } from "../src/enums.js";
import { TicketOutcome, TicketPipeline } from "../src/pipeline.js";
import { FIXTURES, sandbox } from "./helpers.js";

interface FakeDb {
  tickets: Array<Record<string, string>>;
  calls: string[][];
}

function fakeBoard(root: string, tickets: Array<Record<string, string>>): { command: string; db: () => FakeDb } {
  const file = join(root, "board.json");
  writeFileSync(file, JSON.stringify({ tickets, calls: [] }));
  process.env.FAKE_BOARD_FILE = file;
  const command = join(FIXTURES, "fake-board.mjs");
  chmodSync(command, 0o755);
  return { command, db: () => JSON.parse(readFileSync(file, "utf8")) as FakeDb };
}

const T = (id: string, status: string, extra: Record<string, string> = {}): Record<string, string> => ({
  id, title: `Ticket ${id}`, body: "do it", project: "demo", kind: "build", createdAt: id, status, ...extra,
});

test("the command board lists, moves and notes tickets through the protocol", async () => {
  const box = sandbox();
  const { command, db } = fakeBoard(box.root, [T("TK-2", "ready"), T("TK-1", "ready", { kind: "release" }), T("TK-3", "blocked")]);
  const board = new CommandBoard(command, box.root);

  const ready = await board.list(TicketStatus.Ready);
  assert.deepEqual(ready.map((t) => t.id), ["TK-1", "TK-2"]);
  assert.equal(ready[0]?.kind, TicketKind.Release);

  await board.setStatus("TK-2", TicketStatus.Blocked, SettleReason.NeedsHuman, "pick a price");
  await board.addNote("TK-2", "still here");
  const calls = db().calls.filter((c) => c[0] !== "list");
  assert.deepEqual(calls, [["set-status", "TK-2", "blocked", "needs-human", "pick a price"], ["note", "TK-2", "still here"]]);
  assert.equal(db().tickets.find((t) => t.id === "TK-2")?.status, "blocked");
  await assert.rejects(board.setStatus("TK-404", TicketStatus.Done, SettleReason.Merged, ""), /exited 2/);
});

test("a needs-human verdict reaches the board with its reason, in Korean when asked", async () => {
  const box = sandbox({ language: NoteLanguage.Korean });
  const { command, db } = fakeBoard(box.root, [T("TK-9", "working")]);
  const runner = { ...box.runner, board: new CommandBoard(command, box.root), config: { ...box.config, board: { ...box.config.board, type: BoardType.Command, command } } };
  box.plan(["BUILD", "REVIEW NEEDS_HUMAN"]);
  const ticket = (await runner.board.list(TicketStatus.Working))[0];
  assert.ok(ticket);
  assert.equal(await new TicketPipeline(runner, ticket, "slot").run(), TicketOutcome.Settled);
  const settle = db().calls.find((c) => c[0] === "set-status");
  assert.equal(settle?.[3], SettleReason.NeedsHuman);
  assert.match(settle?.[4] ?? "", /머지 전에 사람 결정이 필요함/);
});

test("a release ticket is one release run, with no review", async () => {
  const box = sandbox();
  const done = box.board.create("Ship 1.2.3", "demo", TicketKind.Release, "");
  await box.board.setStatus(done, TicketStatus.Working, SettleReason.Claimed, "");
  box.plan(["RELEASE_DONE", "RELEASE_BLOCKED"]);
  const run = async (id: string): Promise<void> => {
    const ticket = (await box.board.list(TicketStatus.Working)).find((t) => t.id === id);
    assert.ok(ticket);
    await new TicketPipeline(box.runner, ticket, "slot").run();
  };
  await run(done);
  assert.deepEqual((await box.board.list(TicketStatus.Done)).map((t) => t.id), [done]);
  assert.match(box.prompt(1), /You are running a release ticket/);

  const blocked = box.board.create("Ship 1.2.4", "demo", TicketKind.Release, "");
  await box.board.setStatus(blocked, TicketStatus.Working, SettleReason.Claimed, "");
  await run(blocked);
  assert.deepEqual((await box.board.list(TicketStatus.Blocked)).map((t) => t.id), [blocked]);
  assert.equal(box.calls().length, 2);
});
