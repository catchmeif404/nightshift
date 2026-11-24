import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionMode } from "../enums.js";
import { exec } from "../exec.js";
import { Agent, AgentRequest, AgentResult, agentEnv } from "./agent.js";

// Claude Code in print mode. A new stage gets a fixed --session-id, so a cut-off run can be --resume'd.
// Subagents are turned off: a run that waits on a subagent is the run that gets cut off.
export class ClaudeCodeAgent implements Agent {
  readonly name = "claude-code";

  constructor(
    private readonly bin: string,
    private readonly permissionMode: string,
  ) {}

  private configDir(): string {
    return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  }

  usageFile(sessionId: string): string {
    const projects = join(this.configDir(), "projects");
    if (!existsSync(projects)) return "";
    const dir = readdirSync(projects).find((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
    return dir === undefined ? "" : join(projects, dir, `${sessionId}.jsonl`);
  }

  hasSession(sessionId: string): boolean {
    return this.usageFile(sessionId) !== "";
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const session = request.mode === SessionMode.New ? ["--session-id", request.sessionId] : ["--resume", request.sessionId];
    const args = [
      "-p", request.prompt,
      "--model", request.model,
      "--permission-mode", this.permissionMode,
      "--disallowedTools", "Agent",
      "--output-format", "text",
      ...request.writableDirs.flatMap((dir) => ["--add-dir", dir]),
      ...session,
    ];
    const result = await exec(this.bin, args, { cwd: request.cwd, env: agentEnv({}), input: "" });
    return { exitCode: result.code, output: `${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}` };
  }
}
