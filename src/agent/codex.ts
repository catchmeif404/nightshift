import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexSandbox, SessionMode } from "../enums.js";
import { exec } from "../exec.js";
import { safeId } from "../state.js";
import { Agent, AgentRequest, AgentResult, agentEnv } from "./agent.js";

enum CodexEvent {
  ThreadStarted = "thread.started",
  ItemCompleted = "item.completed",
}

const AGENT_MESSAGE = "agent_message";

// Codex config values (approval_policy, approvals_reviewer).
enum CodexApproval {
  OnRequest = "on-request",
  Never = "never",
}

enum CodexReviewer {
  AutoReview = "auto_review",
}

interface ParsedRun {
  threadId: string;
  messages: string[];
}

// Reads `codex exec --json` output: the thread id (for resuming) and the agent's messages.
export function parseCodexEvents(stdout: string): ParsedRun {
  const run: ParsedRun = { threadId: "", messages: [] };
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const e = event as Record<string, unknown>;
    if (e.type === CodexEvent.ThreadStarted && typeof e.thread_id === "string") run.threadId = e.thread_id;
    if (e.type === CodexEvent.ItemCompleted && typeof e.item === "object" && e.item !== null) {
      const item = e.item as Record<string, unknown>;
      if (item.type === AGENT_MESSAGE && typeof item.text === "string") run.messages.push(item.text);
    }
  }
  return run;
}

function toml(value: string): string {
  return JSON.stringify(value);
}

// OpenAI Codex CLI in exec mode. Codex picks its own session (thread) id, so the runner's session id is mapped to
// the thread id Codex reports on its first event; a cut-off run is continued with `codex exec resume <thread>`.
export class CodexAgent implements Agent {
  readonly name = "codex";

  constructor(
    private readonly bin: string,
    private readonly sandbox: CodexSandbox,
    private readonly sessionsDir: string,
  ) {}

  private mapping(sessionId: string): string {
    return join(this.sessionsDir, `codex-${safeId(sessionId)}`);
  }

  // Its sessions have no token usage nightshift can read.
  usageFile(): string {
    return "";
  }

  hasSession(sessionId: string): boolean {
    return existsSync(this.mapping(sessionId));
  }

  // Passed as config overrides rather than flags, because `codex exec resume` takes none of the sandbox flags.
  private overrides(request: AgentRequest): string[] {
    const workspace = this.sandbox === CodexSandbox.Auto || this.sandbox === CodexSandbox.WorkspaceWrite;
    const mode = workspace ? CodexSandbox.WorkspaceWrite : this.sandbox;
    const args = ["-c", `sandbox_mode=${toml(mode)}`];
    if (this.sandbox === CodexSandbox.Auto) {
      args.push("-c", `approval_policy=${toml(CodexApproval.OnRequest)}`, "-c", `approvals_reviewer=${toml(CodexReviewer.AutoReview)}`);
    } else {
      args.push("-c", `approval_policy=${toml(CodexApproval.Never)}`);
    }
    if (workspace) {
      args.push("-c", `sandbox_workspace_write.writable_roots=[${request.writableDirs.map(toml).join(",")}]`);
      args.push("-c", "sandbox_workspace_write.network_access=true");
    }
    if (request.model !== "") args.push("-m", request.model);
    return args;
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const common = ["--json", "--skip-git-repo-check", ...this.overrides(request)];
    const args =
      request.mode === SessionMode.New
        ? ["exec", ...common, request.prompt]
        : ["exec", "resume", ...common, readFileSync(this.mapping(request.sessionId), "utf8").trim(), request.prompt];
    const result = await exec(this.bin, args, { cwd: request.cwd, env: agentEnv({}), input: "" });
    const parsed = parseCodexEvents(result.stdout);
    if (request.mode === SessionMode.New && parsed.threadId !== "") {
      writeFileSync(this.mapping(request.sessionId), parsed.threadId);
    }
    const summary = parsed.messages.length > 0 ? parsed.messages.join("\n") : result.stdout.slice(-2000);
    return { exitCode: result.code, output: `${summary}${result.stderr === "" ? "" : `\n${result.stderr.slice(-1000)}`}` };
  }
}
