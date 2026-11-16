import { AgentConfig, Config } from "../config.js";
import { AgentType } from "../enums.js";
import { Agent } from "./agent.js";
import { ClaudeCodeAgent } from "./claudeCode.js";
import { CodexAgent } from "./codex.js";
import { CommandAgent } from "./command.js";

export function openAgent(config: Config, agent: AgentConfig, sessionsDir: string): Agent {
  switch (agent.type) {
    case AgentType.ClaudeCode:
      return new ClaudeCodeAgent(config.tools.claude, agent.permissionMode);
    case AgentType.Codex:
      return new CodexAgent(config.tools.codex, agent.sandbox, sessionsDir);
    case AgentType.Command:
      return new CommandAgent(agent.command, sessionsDir);
  }
}
