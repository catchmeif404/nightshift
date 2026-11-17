import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Ticket } from "../src/board/board.js";
import { parseConfig } from "../src/config.js";
import { HumanGate, PublishMode, TicketKind, TicketStatus } from "../src/enums.js";
import { StageContext, buildPrompt, reviewPrompt } from "../src/prompts.js";
import { FIXTURES, Sandbox, readyTicket, sandbox } from "./helpers.js";
import { TicketPipeline } from "../src/pipeline.js";

const ticket: Ticket = {
  id: "T-1",
  title: "Add a footer",
  body: "Please add a footer.",
  project: "demo",
  kind: TicketKind.Build,
  status: TicketStatus.Working,
  createdAt: "2026-01-01T00:00:00Z",
};

function context(overrides: Partial<StageContext> = {}): StageContext {
  return {
    ticket,
    project: { name: "demo", repoPath: "/r", baseBranch: "main", publish: PublishMode.Branch, rulesFile: "", postMergeCommand: "" },
    worktree: { path: "/w/t-1", branch: "nightshift/t-1" },
    round: 1,
    lastRound: false,
    rules: "Be careful.",
    resultFile: "/s/t-1.verdict",
    reviewFile: "/s/t-1.review",
    humanGates: Object.values(HumanGate),
    ticketSections: ["Deliverable"],
    gatePaths: ["db/**"],
    reviewHandoff: false,
    handoffFile: "/s/t-1.handoff",
    handoffText: "",
    changedFiles: [],
    ...overrides,
  };
}

function golden(name: string): string {
  return readFileSync(`${FIXTURES}${name}`, "utf8");
}

async function runPipeline(box: Sandbox, id: string): Promise<void> {
  const t = (await box.board.list(TicketStatus.Working)).find((x) => x.id === id);
  assert.ok(t);
  await new TicketPipeline(box.runner, t, "slot-test").run();
}

test("reviewHandoff defaults to off and must be a boolean", () => {
  assert.equal(parseConfig({ projects: {} }, "/w").reviewHandoff, false);
  assert.equal(parseConfig({ projects: {}, reviewHandoff: true }, "/w").reviewHandoff, true);
  assert.throws(() => parseConfig({ projects: {}, reviewHandoff: "yes" }, "/w"));
});

test("with the handoff off, the build and review prompts are byte-for-byte what they were before the option existed", () => {
  const build = { resultFile: "/s/t-1.build" };
  assert.equal(buildPrompt(context(build), ""), golden("prompt-build-off.txt"));
  assert.equal(buildPrompt(context({ ...build, round: 2 }), "fix the footer"), golden("prompt-build-notes-off.txt"));
  assert.equal(reviewPrompt(context(), "BRANCH nightshift/t-1"), golden("prompt-review-off.txt"));
  const pr = context({ lastRound: true, project: { ...context().project, publish: PublishMode.PullRequest } });
  assert.equal(reviewPrompt(pr, "PR https://example.com/pr/1"), golden("prompt-review-last-off.txt"));
});

test("with the handoff on, the developer is asked for it and the reviewer gets it with the changed files", () => {
  const build = buildPrompt(context({ reviewHandoff: true, resultFile: "/s/t-1.build" }), "");
  assert.match(build, /short handoff to `\/s\/t-1\.handoff`/);
  const review = reviewPrompt(context({ reviewHandoff: true, handoffText: "Summary: added footer", changedFiles: ["src/a.ts", "test/a.test.ts"] }), "BRANCH nightshift/t-1");
  assert.match(review, /## Handoff from the developer/);
  assert.match(review, /- src\/a\.ts\n- test\/a\.test\.ts/);
  assert.match(review, /Summary: added footer/);
  assert.match(reviewPrompt(context({ reviewHandoff: true }), "BRANCH x"), /the developer wrote no handoff/);
});

test("pipeline: handoff on passes the developer's handoff and git's file list to the reviewer; off leaves them out", async () => {
  const on = sandbox({ reviewHandoff: true });
  const onId = await readyTicket(on, "Add a footer");
  on.plan(["BUILD", "REVIEW PASS"]);
  await runPipeline(on, onId);
  assert.match(on.prompt(1), /short handoff to/);
  assert.match(on.prompt(2), /HANDOFF-NOTE from build 1/);
  assert.match(on.prompt(2), /- work\.txt/);

  const off = sandbox();
  const offId = await readyTicket(off, "Add a footer");
  off.plan(["BUILD", "REVIEW PASS"]);
  await runPipeline(off, offId);
  assert.doesNotMatch(off.prompt(1), /handoff/i);
  assert.doesNotMatch(off.prompt(2), /handoff/i);
});

test("pipeline: a stale handoff from a sent-back round is not shown to the next review", async () => {
  const box = sandbox({ reviewHandoff: true });
  const id = await readyTicket(box, "Add dark mode");
  box.plan(["BUILD", "REVIEW REWORK", "BUILD", "REVIEW PASS"]);
  await runPipeline(box, id);
  assert.match(box.prompt(2), /HANDOFF-NOTE from build 1/);
  assert.match(box.prompt(4), /HANDOFF-NOTE from build 3/);
  assert.doesNotMatch(box.prompt(4), /HANDOFF-NOTE from build 1/);
});
