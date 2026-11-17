import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Brand } from "./brand.js";
import { NotionBoardConfig } from "./board/notion.js";
import { AgentType, BoardType, CodexSandbox, HumanGate, NoteLanguage, NotifyEvent, NotifyService, PublishMode, TicketStatus } from "./enums.js";

export interface AgentConfig {
  type: AgentType;
  model: string;
  // Executable for AgentType.Command; ignored by other agent types.
  command: string;
  // Passed to claude --permission-mode.
  permissionMode: string;
  // Codex sandbox: read-only, workspace-write (network on) or danger-full-access.
  sandbox: CodexSandbox;
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
  // Command: the executable that speaks the board protocol.
  command: string;
  // Notion: the database and how its properties map to tickets.
  notion: NotionBoardConfig;
}

export interface NotifyConfig {
  service: NotifyService;
  events: NotifyEvent[];
  // Telegram: name of the environment variable holding the bot token (the secret itself never goes in the config).
  botTokenEnv: string;
  // Telegram: the chat to write to. Not a secret.
  chatId: string;
  // Telegram: API base URL.
  apiUrl: string;
  // Slack / Discord: name of the environment variable holding the incoming-webhook URL.
  webhookUrlEnv: string;
}

export interface ToolPaths {
  git: string;
  gh: string;
  claude: string;
  codex: string;
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
  // How often "daemon" and the installed service look for work.
  pollSeconds: number;
  // How long to wait after a usage limit whose message names no reset time.
  usageLimitWaitMinutes: number;
  autoMerge: boolean;
  // The developer writes a handoff (what changed, which files, test results) and the reviewer gets it with the list of changed files. Off: prompts are unchanged.
  reviewHandoff: boolean;
  humanGates: HumanGate[];
  // Gets one message as its last argument when a ticket is blocked. Empty: log only.
  notifyCommand: string;
  // Runs (through /bin/sh, in the config root) each time a worker finishes. Empty: none.
  workerDoneCommand: string;
  // Built-in Telegram / Slack / Discord messages. service "none": off.
  notify: NotifyConfig;
  // Language of the notes the runner writes on tickets.
  language: NoteLanguage;
  // Labels ("Label:" lines) every ticket body must carry before it runs. Empty: no check.
  ticketSections: string[];
  // Globs of repository paths: a change touching one goes to a human whatever the review says. Empty: off.
  gatePaths: string[];
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

function agent(o: JsonObject, where: string, claudeModel: string, root: string): AgentConfig {
  const type = oneOf(o, "type", Object.values(AgentType), AgentType.ClaudeCode, where);
  // Claude Code gets sonnet / opus by default; other agents use their own configured default model.
  const model = type === AgentType.ClaudeCode ? claudeModel : "";
  return {
    type,
    model: str(o, "model", model, where),
    command: inside(root, str(o, "command", "", where)),
    permissionMode: str(o, "permissionMode", "auto", where),
    sandbox: oneOf(o, "sandbox", Object.values(CodexSandbox), CodexSandbox.Auto, where),
  };
}

export function inside(root: string, path: string): string {
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  return path === "" || isAbsolute(path) ? path : resolve(root, path);
}

const DEFAULT_NOTION_STATUSES: Record<TicketStatus, string> = {
  [TicketStatus.Ready]: "Ready",
  [TicketStatus.Working]: "In progress",
  [TicketStatus.Review]: "In review",
  [TicketStatus.Blocked]: "Blocked",
  [TicketStatus.Done]: "Done",
};

function notionConfig(o: JsonObject, root: string): NotionBoardConfig {
  const where = "board.notion";
  const props = optObject(o, "properties", where);
  const statuses = optObject(o, "statuses", where);
  const filter = optObject(o, "filter", where);
  const statusMap = { ...DEFAULT_NOTION_STATUSES };
  for (const s of Object.values(TicketStatus)) statusMap[s] = str(statuses, s, DEFAULT_NOTION_STATUSES[s], `${where}.statuses`);
  return {
    databaseId: str(o, "databaseId", "", where).replace(/-/g, ""),
    tokenEnv: str(o, "tokenEnv", "NOTION_TOKEN", where),
    tokenFile: inside(root, str(o, "tokenFile", "", where)),
    apiUrl: str(o, "apiUrl", "https://api.notion.com/v1", where),
    properties: {
      title: str(props, "title", "Name", `${where}.properties`),
      status: str(props, "status", "Status", `${where}.properties`),
      project: str(props, "project", "Project", `${where}.properties`),
      kind: str(props, "kind", "", `${where}.properties`),
      body: str(props, "body", "", `${where}.properties`),
      notes: str(props, "notes", "", `${where}.properties`),
      id: str(props, "id", "", `${where}.properties`),
    },
    statuses: statusMap,
    releaseKind: str(o, "releaseKind", "Release", where),
    filterProperty: str(filter, "property", "", `${where}.filter`),
    filterEquals: str(filter, "equals", "", `${where}.filter`),
  };
}

function sectionLabels(o: JsonObject): string[] {
  const labels = strList(o, "ticketSections", [], "config").map((l) => l.trim());
  const bad = labels.find((l) => l === "" || /[:：\r\n]/.test(l));
  if (bad !== undefined) throw new ConfigError(`config.ticketSections: "${bad}" must be a non-empty label without a colon or line break`);
  const dup = labels.find((l, i) => labels.findIndex((x) => x.toLowerCase() === l.toLowerCase()) !== i);
  if (dup !== undefined) throw new ConfigError(`config.ticketSections: "${dup}" is listed twice`);
  return labels;
}

function gateGlobs(o: JsonObject): string[] {
  const globs = strList(o, "gatePaths", [], "config").map((g) => g.trim());
  const bad = globs.find((g) => g === "" || /[\r\n]/.test(g));
  if (bad !== undefined) throw new ConfigError(`config.gatePaths: "${bad}" must be a non-empty glob without a line break`);
  return globs;
}

const DEFAULT_WEBHOOK_ENV: Record<NotifyService, string> = {
  [NotifyService.None]: "",
  [NotifyService.Telegram]: "",
  [NotifyService.Slack]: "NIGHTSHIFT_SLACK_WEBHOOK_URL",
  [NotifyService.Discord]: "NIGHTSHIFT_DISCORD_WEBHOOK_URL",
};

// What a Telegram chat id looks like: a number (groups are negative) or @channelname.
export const TELEGRAM_CHAT_ID_PATTERN = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

function notifyConfig(o: JsonObject): NotifyConfig {
  const where = "config.notify";
  const service = oneOf(o, "service", Object.values(NotifyService), NotifyService.None, where);
  const events = strList(o, "events", Object.values(NotifyEvent), where).map((e) => {
    const match = Object.values(NotifyEvent).find((n) => n === e);
    if (match === undefined) throw new ConfigError(`${where}.events: unknown event "${e}" (use ${Object.values(NotifyEvent).join(", ")})`);
    return match;
  });
  const cfg: NotifyConfig = {
    service,
    events: events.filter((e, i) => events.indexOf(e) === i),
    botTokenEnv: str(o, "botTokenEnv", "NIGHTSHIFT_TELEGRAM_BOT_TOKEN", where).trim(),
    chatId: str(o, "chatId", "", where).trim(),
    apiUrl: str(o, "apiUrl", "https://api.telegram.org", where).replace(/\/+$/, ""),
    webhookUrlEnv: str(o, "webhookUrlEnv", DEFAULT_WEBHOOK_ENV[service], where).trim(),
  };
  if (service === NotifyService.Telegram && cfg.chatId === "") throw new ConfigError(`${where}.chatId is required for telegram`);
  if (service === NotifyService.Telegram && cfg.botTokenEnv === "") throw new ConfigError(`${where}.botTokenEnv must name an environment variable`);
  if ((service === NotifyService.Slack || service === NotifyService.Discord) && cfg.webhookUrlEnv === "") {
    throw new ConfigError(`${where}.webhookUrlEnv must name an environment variable`);
  }
  return cfg;
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
    command: inside(root, str(boardRaw, "command", "", "board")),
    notion: notionConfig(optObject(boardRaw, "notion", "board"), root),
  };
  if (board.type === BoardType.Notion && board.notion.databaseId === "") throw new ConfigError("board.notion.databaseId is required for a Notion board");
  if (board.type === BoardType.Command && board.command === "") throw new ConfigError("board.command is required for a command board");

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
    builder: agent(optObject(top, "builder", "config"), "builder", "sonnet", root),
    reviewer: agent(optObject(top, "reviewer", "config"), "reviewer", "opus", root),
    maxSlots: num(top, "maxSlots", 3, "config"),
    maxRework: num(top, "maxRework", 1, "config"),
    maxStageTries: num(top, "maxStageTries", 3, "config"),
    maxBatches: num(top, "maxBatches", 5, "config"),
    resumeCooldownMinutes: num(top, "resumeCooldownMinutes", 15, "config"),
    heartbeatMinutes: num(top, "heartbeatMinutes", 30, "config"),
    pollSeconds: Math.max(30, num(top, "pollSeconds", 120, "config")),
    usageLimitWaitMinutes: num(top, "usageLimitWaitMinutes", 60, "config"),
    autoMerge: bool(top, "autoMerge", false, "config"),
    reviewHandoff: bool(top, "reviewHandoff", false, "config"),
    humanGates,
    notifyCommand: inside(root, str(top, "notifyCommand", "", "config")),
    workerDoneCommand: str(top, "workerDoneCommand", "", "config"),
    notify: notifyConfig(optObject(top, "notify", "config")),
    language: oneOf(top, "language", Object.values(NoteLanguage), NoteLanguage.English, "config"),
    ticketSections: sectionLabels(top),
    gatePaths: gateGlobs(top),
    tools: {
      git: str(toolsRaw, "git", "git", "tools"),
      gh: str(toolsRaw, "gh", "gh", "tools"),
      claude: str(toolsRaw, "claude", "claude", "tools"),
      codex: str(toolsRaw, "codex", "codex", "tools"),
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
