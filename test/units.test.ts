import assert from "node:assert/strict";
import { test } from "node:test";
import { Ticket } from "../src/board/board.js";
import { parseTicketFile, renderTicketFile } from "../src/board/localMarkdown.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { planDispatch } from "../src/dispatch.js";
import { AgentType, BoardType, BuildResult, HumanGate, PublishMode, TicketKind, TicketStatus, Verdict, WorkerMode } from "../src/enums.js";
import { clip, mask } from "../src/log.js";
import { parseBuildLine, parseVerdict } from "../src/pipeline.js";
import { SlotInfo, projectSlotKey } from "../src/state.js";

test("mask hides tokens, keys and passwords", () => {
  const text = "gh ghp_abcdefghijklmnop sk-ant-1234567890abc Bearer abc.def password=hunter22 api_key: \"zzzzzzzz\"";
  const out = mask(text);
  for (const secret of ["ghp_abcdefghijklmnop", "sk-ant-1234567890abc", "abc.def", "hunter22", "zzzzzzzz"]) {
    assert.ok(!out.includes(secret), `${secret} should be masked in: ${out}`);
  }
});

test("clip counts characters, so Korean is never cut in half", () => {
  assert.equal(clip("가나다라마", 3), "가나다");
  assert.equal(clip("abc", 10), "abc");
});

test("build result lines are parsed strictly", () => {
  assert.deepEqual(parseBuildLine("PR https://github.com/a/b/pull/1"), [{ kind: BuildResult.PullRequest, value: "https://github.com/a/b/pull/1" }]);
  assert.deepEqual(parseBuildLine("BRANCH nightshift/t-1"), [{ kind: BuildResult.Branch, value: "nightshift/t-1" }]);
  assert.deepEqual(parseBuildLine("BLOCKED"), [{ kind: BuildResult.Blocked, value: "" }]);
  assert.deepEqual(parseBuildLine("PR not-a-url"), []);
  assert.deepEqual(parseBuildLine("DONE trust me"), []);
  assert.deepEqual(parseBuildLine(""), []);
  assert.deepEqual(parseVerdict(" PASS "), [Verdict.Pass]);
  assert.deepEqual(parseVerdict("pass"), []);
});

test("ticket files round-trip through front matter", () => {
  const parsed = parseTicketFile("---\ntitle: Add a footer: now\nstatus: ready\n---\n\nBody line\n");
  assert.equal(parsed.fields.get("title"), "Add a footer: now");
  assert.equal(parsed.body, "Body line");
  assert.equal(parseTicketFile(renderTicketFile(parsed.fields, parsed.body)).fields.get("status"), "ready");
});

function ticket(id: string, project: string, kind: TicketKind = TicketKind.Build): Ticket {
  return { id, title: id, body: "", project, kind, status: TicketStatus.Ready, createdAt: id, dependsOn: [] };
}

function slot(project: string, release = false): SlotInfo {
  return { key: release ? `release-${project}` : projectSlotKey(project), target: project, pid: 1, stage: "", release };
}

test("dispatch starts one worker per project, up to maxSlots", () => {
  const starts = planDispatch([ticket("1", "a"), ticket("2", "a"), ticket("3", "b"), ticket("4", "c")], [], 2);
  assert.deepEqual(starts.map((s) => s.target), ["a", "b"]);
  assert.ok(starts.every((s) => s.mode === WorkerMode.Project));
});

test("dispatch skips projects that already have a worker", () => {
  const starts = planDispatch([ticket("1", "a"), ticket("2", "b")], [slot("a")], 3);
  assert.deepEqual(starts.map((s) => s.target), ["b"]);
});

test("a release ticket runs only when nothing else runs, and then alone", () => {
  assert.deepEqual(planDispatch([ticket("r", "a", TicketKind.Release), ticket("2", "b")], [slot("x")], 3).map((s) => s.target), ["b"]);
  const alone = planDispatch([ticket("r", "a", TicketKind.Release), ticket("2", "b")], [], 3);
  assert.deepEqual(alone.map((s) => [s.mode, s.target]), [[WorkerMode.Release, "r"]]);
  assert.deepEqual(planDispatch([ticket("2", "b")], [slot("r", true)], 3), []);
});

test("config fills defaults and rejects bad values", () => {
  const config = parseConfig({ projects: { app: { repoPath: "repo" } } }, "/work");
  assert.equal(config.board.type, BoardType.LocalMarkdown);
  assert.equal(config.board.dir, "/work/.tickets");
  assert.equal(config.projects[0]?.repoPath, "/work/repo");
  assert.equal(config.projects[0]?.publish, PublishMode.PullRequest);
  assert.equal(config.builder.type, AgentType.ClaudeCode);
  assert.equal(config.builder.model, "sonnet");
  assert.equal(config.reviewer.model, "opus");
  assert.equal(config.autoMerge, false);
  assert.deepEqual(config.humanGates, Object.values(HumanGate));
  assert.throws(() => parseConfig({ board: { type: "jira" } }, "/w"), ConfigError);
  assert.throws(() => parseConfig({ projects: { app: {} } }, "/w"), ConfigError);
  assert.throws(() => parseConfig({ maxSlots: -1 }, "/w"), ConfigError);
  assert.throws(() => parseConfig({ humanGates: ["vibes"] }, "/w"), ConfigError);
});
