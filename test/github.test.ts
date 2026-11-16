import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitHubBoard } from "../src/board/github.js";
import { SettleReason, TicketKind, TicketStatus } from "../src/enums.js";
import { FIXTURES } from "./helpers.js";

function board(): { board: GitHubBoard; log: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "nightshift-gh-"));
  const logFile = join(dir, "gh.log");
  process.env.FAKE_GH_LOG = logFile;
  const gh = join(FIXTURES, "fake-gh.sh");
  chmodSync(gh, 0o755);
  return {
    board: new GitHubBoard(gh, ["acme/app"], ["owner"], dir),
    log: () => readFileSync(logFile, "utf8").trim().split("\n"),
  };
}

test("only issues from trusted authors become tickets, oldest first", async () => {
  const { board: b } = board();
  const tickets = await b.list(TicketStatus.Ready);
  assert.deepEqual(tickets.map((t) => t.id), ["acme/app#7", "acme/app#8"]);
  assert.equal(tickets[0]?.project, "acme/app");
  assert.equal(tickets[1]?.kind, TicketKind.Release);
});

test("moving a ticket swaps its status label and leaves other labels alone", async () => {
  const { board: b, log } = board();
  await b.setStatus("acme/app#7", TicketStatus.Review, SettleReason.ReadyToMerge, "ready for you");
  const calls = log();
  assert.ok(calls.some((c) => c === "issue edit 7 --repo acme/app --add-label nightshift:review --remove-label nightshift:working"), calls.join("\n"));
  assert.ok(calls.some((c) => c.startsWith("issue comment 7 --repo acme/app --body **nightshift**: ready for you")));
  assert.ok(!calls.some((c) => c.includes("issue close")));
  await b.setStatus("acme/app#7", TicketStatus.Done, SettleReason.Merged, "");
  assert.ok(log().some((c) => c === "issue close 7 --repo acme/app"));
});
