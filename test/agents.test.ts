import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexAgent, parseCodexEvents } from "../src/agent/codex.js";
import { CodexSandbox, SessionMode } from "../src/enums.js";
import { FIXTURES } from "./helpers.js";

test("codex events give the thread id and the agent's messages", () => {
  const parsed = parseCodexEvents(
    ['{"type":"thread.started","thread_id":"t-1"}', "not json", '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}'].join("\n"),
  );
  assert.deepEqual(parsed, { threadId: "t-1", messages: ["hi"] });
});

test("the codex agent maps the runner's session to codex's thread and resumes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nightshift-codex-"));
  process.env.FAKE_CODEX_LOG = join(dir, "args.log");
  const agent = new CodexAgent(join(FIXTURES, "fake-codex.sh"), CodexSandbox.Auto, dir);
  const request = { prompt: "build it", model: "", cwd: dir, sessionId: "s-1", mode: SessionMode.New, writableDirs: ["/state/results"] };

  assert.equal(agent.hasSession("s-1"), false);
  const first = await agent.run(request);
  assert.equal(first.exitCode, 0);
  assert.match(first.output, /built it/);
  assert.equal(agent.hasSession("s-1"), true);

  await agent.run({ ...request, prompt: "you were cut off", model: "gpt-5", mode: SessionMode.Resume });
  const [newArgs, resumeArgs] = readFileSync(join(dir, "args.log"), "utf8").trim().split("\n");
  assert.match(newArgs ?? "", /^exec --json --skip-git-repo-check -c sandbox_mode="workspace-write" -c approval_policy="on-request" -c approvals_reviewer="auto_review" -c sandbox_workspace_write.writable_roots=\["\/state\/results"\] -c sandbox_workspace_write.network_access=true build it$/);
  assert.match(resumeArgs ?? "", /^exec resume --json .* -m gpt-5 thread-123 you were cut off$/);
});

test("a full-access codex sandbox passes no workspace settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nightshift-codex-"));
  process.env.FAKE_CODEX_LOG = join(dir, "args.log");
  const agent = new CodexAgent(join(FIXTURES, "fake-codex.sh"), CodexSandbox.FullAccess, dir);
  await agent.run({ prompt: "p", model: "", cwd: dir, sessionId: "s", mode: SessionMode.New, writableDirs: ["/x"] });
  const args = readFileSync(join(dir, "args.log"), "utf8");
  assert.match(args, /sandbox_mode="danger-full-access" -c approval_policy="never"/);
  assert.doesNotMatch(args, /writable_roots/);
});
