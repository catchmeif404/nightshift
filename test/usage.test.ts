import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NoteLanguage, Stage, TicketStatus } from "../src/enums.js";
import { UsageLog, formatDuration, parseSessionUsage, readSessionUsage, totalUsage, usageNote, weighted } from "../src/usage.js";
import { readyTicket, sandbox, ticketFile } from "./helpers.js";
import { TicketPipeline } from "../src/pipeline.js";
import { snapshot } from "../src/ui/snapshot.js";

function assistant(id: string, model: string, usage: Record<string, number>, ts: string): string {
  return JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, usage } });
}

const SAMPLE = [
  JSON.stringify({ type: "user", timestamp: "2026-11-24T10:00:00.000Z", message: { content: "hi" } }),
  assistant("m1", "claude-sonnet-5-5", { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 }, "2026-11-24T10:00:30.000Z"),
  // The same message logged again while streaming: counted once, the last copy wins.
  assistant("m1", "claude-sonnet-5-5", { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 }, "2026-11-24T10:00:31.000Z"),
  assistant("m2", "claude-sonnet-5-5", { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }, "2026-11-24T10:02:10.000Z"),
  assistant("m3", "<synthetic>", { input_tokens: 999, output_tokens: 999 }, "2026-11-24T10:02:11.000Z"),
  "not json",
].join("\n");

test("session usage sums assistant messages once per id and spans first to last stamp", () => {
  const u = parseSessionUsage(SAMPLE);
  assert.equal(u.known, true);
  assert.deepEqual(u.tokens, { input: 15, output: 30, cacheRead: 300, cacheWrite: 40 });
  assert.deepEqual(u.models, ["claude-sonnet-5-5"]);
  assert.equal(u.seconds, 131);
  // 15 + 30*5 + 40*1.25 + 300*0.1
  assert.equal(weighted(u.tokens), 245);
});

test("a missing session file or one without usage is unknown, not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  assert.equal(readSessionUsage(join(dir, "none.jsonl")).known, false);
  assert.equal(readSessionUsage("").known, false);
  const empty = join(dir, "empty.jsonl");
  writeFileSync(empty, JSON.stringify({ type: "user", timestamp: "2026-11-24T10:00:00.000Z" }));
  assert.equal(readSessionUsage(empty).known, false);
});

test("the board note is one line in both languages, with unknown tokens kept out of the total", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  const log = new UsageLog(dir, "T-1");
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  log.append({ stage: Stage.Build, round: 1, model: "sonnet", known: true, tokens, weighted: 124_000, seconds: 130 });
  log.append({ stage: Stage.Review, round: 1, model: "opus", known: false, tokens, weighted: 0, seconds: 77 });
  const entries = log.read();
  assert.equal(usageNote(entries, NoteLanguage.English), "build r1 sonnet 2m10s 124k · review r1 opus 1m17s tokens unknown · total 124k");
  assert.equal(usageNote(entries, NoteLanguage.Korean), "개발 r1 sonnet 2m10s 124k · 검토 r1 opus 1m17s 토큰 알 수 없음 · 합계 124k");
  assert.deepEqual(totalUsage(entries), { known: true, weighted: 124_000, seconds: 207 });
  assert.equal(usageNote([], NoteLanguage.English), "");
  assert.equal(formatDuration(3700), "1h01m");
});

test("a finished ticket records time per stage with unknown tokens and gets a usage note", async () => {
  const box = sandbox({ language: NoteLanguage.Korean });
  const id = await readyTicket(box, "Add a footer");
  box.plan(["BUILD", "REVIEW PASS"]);
  const ticket = (await box.board.list(TicketStatus.Working)).find((t) => t.id === id);
  assert.ok(ticket);
  await new TicketPipeline(box.runner, ticket, "slot-test").run();

  const entries = new UsageLog(box.runner.paths.usage, id).read();
  assert.deepEqual(entries.map((e) => [e.stage, e.round, e.model, e.known]), [
    [Stage.Build, 1, "fake-builder", false],
    [Stage.Review, 1, "fake-reviewer", false],
  ]);
  assert.match(ticketFile(box, id), /개발 r1 fake-builder \d+s 토큰 알 수 없음 · 검토 r1 fake-reviewer \d+s 토큰 알 수 없음 · 합계 토큰 알 수 없음/);

  const snap = await snapshot(box.config);
  const row = snap.tickets[TicketStatus.Review].items.find((t) => t.id === id);
  assert.match(row?.usage ?? "", /^\d+s$/);
});
