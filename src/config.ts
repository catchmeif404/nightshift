import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Brand } from "./brand.js";
import { AgentType, BoardType, HumanGate, PublishMode } from "./enums.js";

export interface AgentConfig {
  type: AgentType;
  model: string;
  // Executable for AgentType.Command; ignored by other agent types.
  command: string;
  // Passed to claude --permission-mode.
  permissionMode: string;
}

export interface ProjectConfig {
  name: string;
  repoPath: string;
  baseBranch: string;
  publish: PublishMode;
  // Extra rules for every run on this project, appended to the prompt. Empty: none.
  rulesFile: string;
  // Runs in repoPath after a PR of this project is merged. Empty: none.
  postMergeCommand: string;
}

export interface BoardConfig {
  type: BoardType;
  // LocalMarkdown: folder of ticket files, relative to the config root.
  dir: string;
  // GitHub: "owner/name" repositories to read issues from.
  repos: string[];
  // GitHub: only issues opened by these logins run. Empty list: nothing runs.
  trustedAuthors: string[];
}

export interface ToolPaths {
  git: string;
  gh: string;
  claude: string;
}

export interface Config {
  root: string;
  stateDir: string;
  board: BoardConfig;
  projects: ProjectConfig[];
  builder: AgentConfig;
  reviewer: AgentConfig;
  maxSlots: number;
  maxRework: number;
  maxStageTries: number;
  maxBatches: number;
  resumeCooldownMinutes: number;
  heartbeatMinutes: number;
  daemonIntervalMinutes: number;
  autoMerge: boolean;
  humanGates: HumanGate[];
  // Gets one message as its last argument when a ticket is blocked. Empty: log only.
  notifyCommand: string;
  tools: ToolPaths;
}

export class ConfigError extends Error {}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, where: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${where} must be an object`);
  }
  return value as JsonObject;
}

function optObject(o: JsonObject, key: string, where: string): JsonObject {
  return key in o ? asObject(o[key], `${where}.${key}`) : {};
}

function str(o: JsonObject, key: string, fallback: string, where: string): string {
  if (!(key in o)) return fallback;
  const v = o[key];
  if (typeof v !== "string") throw new ConfigError(`${where}.${key} must be a string`);
  return v;
}

function num(o: JsonObject, key: string, fallback: number, where: string): number {
  if (!(key in o)) return fallback;
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new ConfigError(`${where}.${key} must be a non-negative number`);
  }
  return v;
}

function bool(o: JsonObject, key: string, fallback: boolean, where: string): boolean {
  if (!(key in o)) return fallback;
  const v = o[key];
  if (typeof v !== "boolean") throw new ConfigError(`${where}.${key} must be true or false`);
  return v;
}

function strList(o: JsonObject, key: string, fallback: string[], where: string): string[] {
  if (!(key in o)) return fallback;
  const v = o[key];
  if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${where}.${key} must be a list of strings`);
  }
  return v as string[];
}

function oneOf<T extends string>(o: JsonObject, key: string, allowed: readonly T[], fallback: T, where: string): T {
  const v = str(o, key, fallback, where);
  const match = allowed.find((a) => a === v);
  if (match === undefined) throw new ConfigError(`${where}.${key} must be one of: ${allowed.join(", ")}`);
  return match;
}

function agent(o: JsonObject, where: string, model: string): AgentConfig {
  return {
    type: oneOf(o, "type", Object.values(AgentType), AgentType.ClaudeCode, where),
    model: str(o, "model", model, where),
    command: str(o, "command", "", where),
    permissionMode: str(o, "permissionMode", "auto", where),
  };
}

function inside(root: string, path: string): string {
  return path === "" || isAbsolute(path) ? path : resolve(root, path);
}

export const DEFAULT_GATES: HumanGate[] = Object.values(HumanGate);

export function parseConfig(raw: unknown, root: string): Config {
  const top = asObject(raw, "config");
  const boardRaw = optObject(top, "board", "config");
  const board: BoardConfig = {
    type: oneOf(boardRaw, "type", Object.values(BoardType), BoardType.LocalMarkdown, "board"),
    dir: inside(root, str(boardRaw, "dir", Brand.ticketsDir, "board")),
    repos: strList(boardRaw, "repos", [], "board"),
    trustedAuthors: strList(boardRaw, "trustedAuthors", [], "board"),
  };

  const projectsRaw = optObject(top, "projects", "config");
  const projects: ProjectConfig[] = Object.entries(projectsRaw).map(([name, value]) => {
    const where = `projects.${name}`;
    const p = asObject(value, where);
    const repoPath = str(p, "repoPath", "", where);
    if (repoPath === "") throw new ConfigError(`${where}.repoPath is required`);
    return {
      name,
      repoPath: inside(root, repoPath),
      baseBranch: str(p, "baseBranch", "main", where),
      publish: oneOf(p, "publish", Object.values(PublishMode), PublishMode.PullRequest, where),
      rulesFile: inside(root, str(p, "rulesFile", "", where)),
      postMergeCommand: str(p, "postMergeCommand", "", where),
    };
  });

  const toolsRaw = optObject(top, "tools", "config");
  const gates = strList(top, "humanGates", DEFAULT_GATES, "config");
  const humanGates = gates.map((g) => {
    const match = Object.values(HumanGate).find((h) => h === g);
    if (match === undefined) throw new ConfigError(`config.humanGates: unknown gate "${g}"`);
    return match;
  });

  return {
    root,
    stateDir: inside(root, str(top, "stateDir", Brand.stateDir, "config")),
    board,
    projects,
    builder: agent(optObject(top, "builder", "config"), "builder", "sonnet"),
    reviewer: agent(optObject(top, "reviewer", "config"), "reviewer", "opus"),
    maxSlots: num(top, "maxSlots", 3, "config"),
    maxRework: num(top, "maxRework", 1, "config"),
    maxStageTries: num(top, "maxStageTries", 3, "config"),
    maxBatches: num(top, "maxBatches", 5, "config"),
    resumeCooldownMinutes: num(top, "resumeCooldownMinutes", 15, "config"),
    heartbeatMinutes: num(top, "heartbeatMinutes", 30, "config"),
    daemonIntervalMinutes: num(top, "daemonIntervalMinutes", 15, "config"),
    autoMerge: bool(top, "autoMerge", false, "config"),
    humanGates,
    notifyCommand: str(top, "notifyCommand", "", "config"),
    tools: {
      git: str(toolsRaw, "git", "git", "tools"),
      gh: str(toolsRaw, "gh", "gh", "tools"),
      claude: str(toolsRaw, "claude", "claude", "tools"),
    },
  };
}

export function configPath(root: string): string {
  return join(root, Brand.configFile);
}

export function loadConfig(root: string): Config {
  const path = configPath(root);
  if (!existsSync(path)) {
    throw new ConfigError(`no ${Brand.configFile} in ${root} (run "${Brand.name} init" first)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(raw, root);
}

export function hasProject(config: Config, name: string): boolean {
  return config.projects.some((p) => p.name === name);
}

export function projectNamed(config: Config, name: string): ProjectConfig {
  const project = config.projects.find((p) => p.name === name);
  if (project === undefined) throw new ConfigError(`project "${name}" is not in ${Brand.configFile}`);
  return project;
}
