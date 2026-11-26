import { SessionMode } from "../enums.js";

export interface AgentRequest {
  prompt: string;
  model: string;
  cwd: string;
  sessionId: string;
  mode: SessionMode;
  // Folders outside cwd the run must write to (the runner's result files).
  writableDirs: string[];
  // Minutes the run may take before its process group is killed. 0: no limit.
  timeoutMinutes: number;
}

export interface AgentResult {
  exitCode: number;
  output: string;
  // The run was killed for passing the request's time limit.
  timedOut: boolean;
  // Processes the run left running that the runner killed after it ended (0: none).
  cleaned: number;
}

// One coding agent CLI. Each stage is one run; a cut-off run is resumed in the same session.
export interface Agent {
  readonly name: string;
  run(request: AgentRequest): Promise<AgentResult>;
  // Whether a run with this session id left a session that can be resumed.
  hasSession(sessionId: string): boolean;
  // The session file whose usage can be summed; "" when this agent keeps none that can be read.
  usageFile(sessionId: string): string;
}

// Variables a nested agent must not inherit from a parent agent session.
const PARENT_SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_|CODEX_)/;

export function agentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!PARENT_SESSION_VARS.test(key)) env[key] = value;
  }
  return { ...env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", ...extra };
}
