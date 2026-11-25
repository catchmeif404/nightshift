import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DependencyWaitCause, Ticket, dependencyWaits, loadDependencyGraph, orderByDependencies } from "../src/board/board.js";
import { CommandBoard } from "../src/board/command.js";
import { GitHubBoard, dependsFromBody } from "../src/board/github.js";
import { add, status } from "../src/commands.js";
import { dependencyChecks } from "../src/commands.js";
import { awaitDependencies, dispatch, work } from "../src/dispatch.js";
import { CheckLevel, SettleReason, TicketKind, TicketStatus } from "../src/enums.js";
import { projectSlotKey } from "../src/state.js";
import { FIXTURES, Sandbox, sandbox, ticketFile, ticketStatus } from "./helpers.js";

function make(box: Sandbox, title: string, dependsOn: string[] = []): string {
  return box.board.create(title, "demo", TicketKind.Build, `Please ${title}.`, dependsOn);
}

async function setStatus(box: Sandbox, id: string, status: TicketStatus): Promise<void> {
  await box.board.setStatus(id, status, SettleReason.Claimed, "");
}

async function waitsOf(box: Sandbox, id: string): Promise<string[]> {
  const ready = await box.board.list(TicketStatus.Ready);
  const ticket = ready.find((t) => t.id === id);
  assert.ok(ticket, `${id} is ready`);
  return dependencyWaits(ticket, await loadDependencyGraph(box.board, ready)).map((w) => `${w.cause}:${w.id}`);
}

test("local markdown board reads depends from the front matter, empty when absent", async () => {
  const box = sandbox();
  const a = make(box, "first");
  const b = make(box, "second", [a, "T-9"]);
  assert.match(ticketFile(box, b), /^depends: T-1, T-9$/m);
  const tickets = await box.board.list(TicketStatus.Ready);
  assert.deepEqual(tickets.find((t) => t.id === a)?.dependsOn, []);
  assert.deepEqual(tickets.find((t) => t.id === b)?.dependsOn, ["T-1", "T-9"]);
});

test("nightshift add --depends writes the depends line", () => {
  const box = sandbox();
  const id = add(box.config, "later", "demo", TicketKind.Build, "do it", ["T-1", "T-2"]);
  assert.match(ticketFile(box, id), /^depends: T-1, T-2$/m);
});

test("the command board reads dependsOn, and tolerates scripts that do not send it", async () => {
  const box = sandbox();
  const file = join(box.root, "board.json");
  const script = join(box.root, "board.mjs");
  const tickets = [
    { id: "A", title: "a", body: "", project: "demo", kind: "build", createdAt: "1", status: "ready", dependsOn: ["B", 7, " C "] },
    { id: "B", title: "b", body: "", project: "demo", kind: "build", createdAt: "2", status: "done" },
  ];
  writeFileSync(file, JSON.stringify(tickets));
  writeFileSync(script, `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nconst t = JSON.parse(readFileSync(${JSON.stringify(file)}, "utf8"));\nprocess.stdout.write(JSON.stringify(t.filter((x) => x.status === process.argv[3])));\n`);
  chmodSync(script, 0o755);
  const board = new CommandBoard(script, box.root);
  assert.deepEqual((await board.list(TicketStatus.Ready))[0]?.dependsOn, ["B", "C"]);
  assert.deepEqual((await board.list(TicketStatus.Done))[0]?.dependsOn, []);
  assert.deepEqual((await board.find(["B", "Z"])).map((t) => t.id), ["B"]);
});

test("the GitHub board reads Depends on / Blocked by lines and finds closed issues as done", async () => {
  assert.deepEqual(dependsFromBody("text\n- Depends on #12, #13\nblocked by: o/r#4 and #5\nsee #99", "a/b"), ["a/b#12", "a/b#13", "o/r#4", "a/b#5"]);
  assert.deepEqual(dependsFromBody("nothing here", "a/b"), []);
  chmodSync(join(FIXTURES, "fake-gh.sh"), 0o755);
  const box = sandbox();
  process.env.FAKE_GH_LOG = join(box.root, "gh.log");
  const board = new GitHubBoard(join(FIXTURES, "fake-gh.sh"), ["acme/app"], ["owner"], box.root);
  const ready = await board.list(TicketStatus.Ready);
  assert.deepEqual(ready.find((t) => t.id === "acme/app#7")?.dependsOn, ["acme/app#12", "acme/app#13", "acme/other#3"]);
  assert.deepEqual(ready.find((t) => t.id === "acme/app#8")?.dependsOn, []);
  const found = await board.find(["acme/app#12", "acme/app#13", "acme/other#3"]);
  assert.deepEqual(found.map((t) => [t.id, t.status]), [["acme/app#12", TicketStatus.Done], ["acme/app#13", TicketStatus.Blocked]]);
});

test("a ticket waits while its predecessor is not done, and starts once it is", async () => {
  const box = sandbox();
  const first = make(box, "first");
  const second = make(box, "second", [first]);
  assert.deepEqual(await waitsOf(box, second), [`${DependencyWaitCause.Pending}:${first}`]);
  await setStatus(box, first, TicketStatus.Working);
  const ready = await box.board.list(TicketStatus.Ready);
  assert.deepEqual(dependencyWaits(ready[0] as Ticket, await loadDependencyGraph(box.board, ready)).map((w) => w.cause), [DependencyWaitCause.Pending]);
  await setStatus(box, first, TicketStatus.Review);
  assert.deepEqual(await waitsOf(box, second), [`${DependencyWaitCause.Pending}:${first}`]);
  await setStatus(box, first, TicketStatus.Done);
  assert.deepEqual(await waitsOf(box, second), []);
});

test("a blocked predecessor keeps the ticket waiting; the ticket stays ready and untouched", async () => {
  const box = sandbox();
  const first = make(box, "first");
  const second = make(box, "second", [first]);
  await setStatus(box, first, TicketStatus.Blocked);
  assert.deepEqual(await waitsOf(box, second), [`${DependencyWaitCause.Blocked}:${first}`]);
  const before = ticketFile(box, second);
  assert.deepEqual(await dispatch(box.runner, () => 1), []);
  assert.equal(ticketFile(box, second), before);
  assert.equal(await ticketStatus(box, second), TicketStatus.Ready);
});

test("a missing id, itself and a loop never start", async () => {
  const box = sandbox();
  const lonely = make(box, "lonely", ["T-99"]);
  const selfish = make(box, "selfish", ["T-2"]);
  const a = make(box, "a", ["T-4"]);
  const b = make(box, "b", ["T-3"]);
  assert.deepEqual(await waitsOf(box, lonely), [`${DependencyWaitCause.Missing}:T-99`]);
  assert.deepEqual(await waitsOf(box, selfish), [`${DependencyWaitCause.Self}:T-2`]);
  assert.deepEqual(await waitsOf(box, a), [`${DependencyWaitCause.Cycle}:T-4`]);
  assert.deepEqual(await waitsOf(box, b), [`${DependencyWaitCause.Cycle}:T-3`]);
  assert.equal(a, "T-3");
  assert.deepEqual(await dispatch(box.runner, () => 1), []);
});

test("a loop that runs through a done ticket is no loop: the ticket just waits", () => {
  const t = (id: string, status: TicketStatus, dependsOn: string[]): Ticket => ({ id, title: id, body: "", project: "demo", kind: TicketKind.Build, status, createdAt: id, dependsOn });
  const graph = new Map([t("T-1", TicketStatus.Done, ["T-2"]), t("T-2", TicketStatus.Ready, ["T-1"]), t("T-3", TicketStatus.Ready, ["T-2"])].map((x) => [x.id, x]));
  assert.deepEqual(dependencyWaits(graph.get("T-2") as Ticket, graph), []);
  assert.deepEqual(dependencyWaits(graph.get("T-3") as Ticket, graph).map((w) => `${w.cause}:${w.id}`), [`${DependencyWaitCause.Pending}:T-2`]);
});

test("doctor warns about a missing id, itself and a loop, not about a waiting ticket", async () => {
  const box = sandbox();
  make(box, "lonely", ["T-99"]);
  make(box, "selfish", ["T-2"]);
  const base = make(box, "base");
  make(box, "later", [base]);
  const found = await dependencyChecks(box.config);
  assert.deepEqual(found.map((c) => c.level), [CheckLevel.Warn, CheckLevel.Warn]);
  assert.match(found[0]?.what ?? "", /T-1.*T-99/);
  assert.match(found[1]?.what ?? "", /T-2.*itself/);
});

test("a batch puts predecessors first, whatever the age order", () => {
  const t = (id: string, dependsOn: string[]): Ticket => ({ id, title: id, body: "", project: "demo", kind: TicketKind.Build, status: TicketStatus.Ready, createdAt: id, dependsOn });
  assert.deepEqual(orderByDependencies([t("c", ["b"]), t("b", ["a"]), t("a", []), t("d", [])]).map((x) => x.id), ["a", "b", "c", "d"]);
  assert.deepEqual(orderByDependencies([t("x", ["outside"]), t("y", [])]).map((x) => x.id), ["x", "y"]);
  assert.equal(orderByDependencies([t("p", ["q"]), t("q", ["p"])]).length, 2);
});

test("in a batch a ready predecessor does not hold the ticket back, a blocked or outside one does", async () => {
  const box = sandbox();
  const first = make(box, "first");
  const second = make(box, "second", [first]);
  const ready = await box.board.list(TicketStatus.Ready);
  assert.deepEqual((await awaitDependencies(box.runner, ready)).map((t) => t.id), [first]);
  assert.deepEqual((await awaitDependencies(box.runner, ready, true)).map((t) => t.id), [first, second]);
});

test("work runs the predecessor first, then skips the ticket while the predecessor is not done", async () => {
  const box = sandbox();
  // The later ticket is older, so age order alone would run it first.
  const second = make(box, "second", ["T-2"]);
  const first = make(box, "first");
  assert.equal(second, "T-1");
  box.plan(["BUILD_BLOCKED"]);
  const key = projectSlotKey("demo");
  box.runner.slots.tryCreate(key, "demo", false);
  await work(box.runner, key);
  assert.equal(await ticketStatus(box, first), TicketStatus.Blocked);
  assert.equal(await ticketStatus(box, second), TicketStatus.Ready);
  assert.equal(box.calls().length, 1);
});

test("status shows why a ticket waits", async () => {
  const box = sandbox();
  const first = make(box, "first");
  make(box, "second", [first]);
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => void lines.push(args.join(" "));
  try {
    await status(box.config);
  } finally {
    console.log = original;
  }
  assert.ok(lines.some((l) => l.includes(`waiting for predecessor ${first} to be done`)), lines.join("\n"));
});
