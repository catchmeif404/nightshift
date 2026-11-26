import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Brand } from "../brand.js";
import { SessionMode } from "../enums.js";
import { execTimed } from "../exec.js";
import { safeId } from "../state.js";
import { Agent, AgentRequest, AgentResult, agentEnv } from "./agent.js";

// Any executable as an agent. It reads the prompt on stdin and gets the model and session on env:
// NIGHTSHIFT_MODEL, NIGHTSHIFT_SESSION_ID, NIGHTSHIFT_SESSION_MODE (new | resume).
// The runner marks a session as started before the first run, so a cut-off run resumes.
export class CommandAgent implements Agent {
  readonly name = "command";

  constructor(
    private readonly command: string,
    private readonly sessionsDir: string,
  ) {}

  private marker(sessionId: string): string {
    return join(this.sessionsDir, safeId(sessionId));
  }

  // Its sessions have no token usage nightshift can read.
  usageFile(): string {
    return "";
  }

  hasSession(sessionId: string): boolean {
    return existsSync(this.marker(sessionId));
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.mode === SessionMode.New) writeFileSync(this.marker(request.sessionId), "");
    const env = agentEnv({
      [`${Brand.envPrefix}MODEL`]: request.model,
      [`${Brand.envPrefix}SESSION_ID`]: request.sessionId,
      [`${Brand.envPrefix}SESSION_MODE`]: request.mode,
    });
    const result = await execTimed(this.command, [], { cwd: request.cwd, env, input: request.prompt }, request.timeoutMinutes);
    return { exitCode: result.code, output: `${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}`, timedOut: result.timedOut, cleaned: result.cleaned };
  }
}
