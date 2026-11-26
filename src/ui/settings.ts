import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Brand } from "../brand.js";
import { Check, configChecks } from "../commands.js";
import { Config, TELEGRAM_CHAT_ID_PATTERN, configPath, inside, parseConfig } from "../config.js";
import { AgentType, BoardType, CheckLevel, NotifyService } from "../enums.js";
import { clip, mask } from "../log.js";

type JsonObject = Record<string, unknown>;

// Only these values can be picked in the console. A "command" board or agent runs an executable named in the
// file, so it is shown and kept as it is but never chosen (or typed) here.
export const UI_BOARD_TYPES: readonly BoardType[] = [BoardType.LocalMarkdown, BoardType.GitHub];
export const UI_AGENT_TYPES: readonly AgentType[] = [AgentType.ClaudeCode, AgentType.Codex];

const MAX_SLOTS_LIMIT = 16;
// Upper bound for maxConflictRetries in the console.
const MAX_CONFLICT_RETRIES = 5;
const MAX_STALE_HOURS = 24 * 365;
const MAX_STAGE_TIMEOUT_MINUTES = 24 * 60;
const MAX_COMMAND_CHARS = 1000;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const SECRET_KEY = /token|secret|passw(or)?d|api[_-]?key|credential|authorization/i;
// Names of where a secret lives, not secrets themselves.
const REFERENCE_KEYS = new Set(["tokenEnv", "tokenFile"]);
const KEPT = "•••••• (kept)";

export interface AgentForm {
  type: AgentType;
  model: string;
}

export interface SettingsForm {
  projects: Array<{ name: string; repoPath: string; testCommand: string }>;
  board: { type: BoardType; dir: string; repos: string[]; trustedAuthors: string[] };
  builder: AgentForm;
  reviewer: AgentForm;
  maxSlots: number;
  // Extra developer runs that resolve a merge conflict before the ticket waits in review. 0: none.
  maxConflictRetries: number;
  // Hours a ticket in review or blocked may sit before it is reported as stuck. 0: off.
  staleHours: number;
  // Minutes one agent run of a stage may take. 0: no limit.
  stageTimeoutMinutes: number;
  ticketSections: string[];
  gatePaths: string[];
  // The secret is never here: only where to send. The environment variable names stay in the file as they are.
  notify: { service: NotifyService; chatId: string };
}

export interface Issue {
  level: CheckLevel;
  field: string;
  message: string;
}

export interface PreservedField {
  path: string;
  value: string;
  secret: boolean;
}

export interface SettingsView {
  form: SettingsForm;
  // Changes only when the file on disk changes; sent back to save so a CLI edit in between is not overwritten.
  revision: string;
  // Fields of the file this console does not edit: kept as they are on every save. Secret values are never shown.
  preserved: PreservedField[];
  problems: string[];
  lockedBoard: boolean;
  lockedBuilder: boolean;
  lockedReviewer: boolean;
}

export class SettingsError extends Error {
  constructor(message: string, readonly status: number, readonly issues: Issue[] = []) {
    super(message);
  }
}

interface RawFile {
  path: string;
  raw: JsonObject;
  revision: string;
}

function revisionOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function readRaw(root: string): RawFile {
  const path = configPath(root);
  if (!existsSync(path)) throw new SettingsError(`no ${Brand.configFile} in ${root}`, 404);
  const content = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new SettingsError(`${Brand.configFile} is not valid JSON, fix it by hand first: ${mask(error instanceof Error ? error.message : String(error))}`, 422);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SettingsError(`${Brand.configFile} must hold an object`, 422);
  return { path, raw: raw as JsonObject, revision: revisionOf(content) };
}

function obj(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function texts(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : fallback;
}

function agentForm(value: unknown, fallback: AgentForm): AgentForm {
  const o = obj(value);
  const type = Object.values(AgentType).find((t) => t === o.type) ?? fallback.type;
  return { type, model: text(o.model, type === fallback.type ? fallback.model : "") };
}

// The form values as written in the file (not resolved), with the defaults for what is missing or unusable.
function formFrom(raw: JsonObject, defaults: Config): SettingsForm {
  const board = obj(raw.board);
  const boardType = Object.values(BoardType).find((t) => t === board.type) ?? defaults.board.type;
  return {
    projects: Object.entries(obj(raw.projects)).map(([name, p]) => ({ name, repoPath: text(obj(p).repoPath, ""), testCommand: text(obj(p).testCommand, "") })),
    board: {
      type: boardType,
      dir: text(board.dir, Brand.ticketsDir),
      repos: texts(board.repos, []),
      trustedAuthors: texts(board.trustedAuthors, []),
    },
    builder: agentForm(raw.builder, { type: defaults.builder.type, model: defaults.builder.model }),
    reviewer: agentForm(raw.reviewer, { type: defaults.reviewer.type, model: defaults.reviewer.model }),
    maxSlots: typeof raw.maxSlots === "number" ? raw.maxSlots : defaults.maxSlots,
    maxConflictRetries: typeof raw.maxConflictRetries === "number" ? raw.maxConflictRetries : defaults.maxConflictRetries,
    staleHours: typeof raw.staleHours === "number" ? raw.staleHours : defaults.staleHours,
    stageTimeoutMinutes: typeof raw.stageTimeoutMinutes === "number" ? raw.stageTimeoutMinutes : defaults.stageTimeoutMinutes,
    ticketSections: texts(raw.ticketSections, []),
    gatePaths: texts(raw.gatePaths, []),
    notify: {
      service: Object.values(NotifyService).find((n) => n === obj(raw.notify).service) ?? NotifyService.None,
      chatId: text(obj(raw.notify).chatId, ""),
    },
  };
}

const EDITED_PATHS = new Set([
  "board.type", "board.dir", "board.repos", "board.trustedAuthors",
  "builder.type", "builder.model", "reviewer.type", "reviewer.model", "maxSlots", "maxConflictRetries", "staleHours", "stageTimeoutMinutes",
  "ticketSections", "gatePaths", "notify.service", "notify.chatId",
]);

function preservedFields(value: unknown, path: string, out: PreservedField[]): void {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) preservedFields(child, path === "" ? key : `${path}.${key}`, out);
    return;
  }
  if (EDITED_PATHS.has(path) || /^projects\.[^.]+\.(repoPath|testCommand)$/.test(path)) return;
  const key = path.split(".").pop() ?? "";
  const secret = SECRET_KEY.test(key) && !REFERENCE_KEYS.has(key);
  out.push({ path, value: secret ? KEPT : mask(clip(JSON.stringify(value), 120)), secret });
}

function configProblem(raw: JsonObject, root: string): string {
  try {
    parseConfig(raw, root);
    return "";
  } catch (error) {
    return mask(error instanceof Error ? error.message : String(error));
  }
}

export function readSettings(root: string): SettingsView {
  const file = readRaw(root);
  const preserved: PreservedField[] = [];
  preservedFields(file.raw, "", preserved);
  const form = formFrom(file.raw, parseConfig({}, root));
  const problem = configProblem(file.raw, root);
  return {
    form,
    revision: file.revision,
    preserved,
    problems: problem === "" ? [] : [problem],
    lockedBoard: !UI_BOARD_TYPES.includes(form.board.type),
    lockedBuilder: !UI_AGENT_TYPES.includes(form.builder.type),
    lockedReviewer: !UI_AGENT_TYPES.includes(form.reviewer.type),
  };
}

function issue(level: CheckLevel, field: string, message: string): Issue {
  return { level, field, message };
}

function insideRoot(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(root, path));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function checkAgent(label: string, edit: AgentForm, current: AgentForm, issues: Issue[]): void {
  if (!Object.values(AgentType).includes(edit.type)) {
    issues.push(issue(CheckLevel.Fail, `${label}.type`, `must be one of: ${UI_AGENT_TYPES.join(", ")}`));
  } else if (edit.type !== current.type && !UI_AGENT_TYPES.includes(edit.type)) {
    issues.push(issue(CheckLevel.Fail, `${label}.type`, `"${edit.type}" runs an executable named in ${Brand.configFile}; set it there, not here`));
  } else if (edit.type !== current.type && !UI_AGENT_TYPES.includes(current.type)) {
    issues.push(issue(CheckLevel.Fail, `${label}.type`, `a custom command agent stays as it is; change it in ${Brand.configFile}`));
  }
  if (typeof edit.model !== "string" || (edit.model !== "" && !MODEL_PATTERN.test(edit.model))) {
    issues.push(issue(CheckLevel.Fail, `${label}.model`, "letters, digits and . _ : / @ [ ] - only (up to 80), or empty for the agent's default"));
  }
}

// Field-level rules for what the console may write. Everything the file already holds is judged by parseConfig.
export function validateEdit(edit: SettingsForm, current: SettingsForm, root: string): Issue[] {
  const issues: Issue[] = [];
  if (!Number.isInteger(edit.maxSlots) || edit.maxSlots < 1 || edit.maxSlots > MAX_SLOTS_LIMIT) {
    issues.push(issue(CheckLevel.Fail, "maxSlots", `a whole number from 1 to ${MAX_SLOTS_LIMIT}`));
  }
  if (!Number.isInteger(edit.maxConflictRetries) || edit.maxConflictRetries < 0 || edit.maxConflictRetries > MAX_CONFLICT_RETRIES) {
    issues.push(issue(CheckLevel.Fail, "maxConflictRetries", `a whole number from 0 (none) to ${MAX_CONFLICT_RETRIES}`));
  }
  if (!Number.isInteger(edit.staleHours) || edit.staleHours < 0 || edit.staleHours > MAX_STALE_HOURS) {
    issues.push(issue(CheckLevel.Fail, "staleHours", `a whole number of hours from 0 (off) to ${MAX_STALE_HOURS}`));
  }
  if (!Number.isInteger(edit.stageTimeoutMinutes) || edit.stageTimeoutMinutes < 0 || edit.stageTimeoutMinutes > MAX_STAGE_TIMEOUT_MINUTES) {
    issues.push(issue(CheckLevel.Fail, "stageTimeoutMinutes", `a whole number of minutes from 0 (no limit) to ${MAX_STAGE_TIMEOUT_MINUTES}`));
  }
  checkAgent("builder", edit.builder, current.builder, issues);
  checkAgent("reviewer", edit.reviewer, current.reviewer, issues);

  const b = edit.board;
  if (!Object.values(BoardType).includes(b.type)) {
    issues.push(issue(CheckLevel.Fail, "board.type", `must be one of: ${UI_BOARD_TYPES.join(", ")}`));
  } else if (b.type !== current.board.type && !UI_BOARD_TYPES.includes(b.type)) {
    issues.push(issue(CheckLevel.Fail, "board.type", `a ${b.type} board needs an executable or a token; set it in ${Brand.configFile}`));
  } else if (b.type !== current.board.type && !UI_BOARD_TYPES.includes(current.board.type)) {
    issues.push(issue(CheckLevel.Fail, "board.type", `the ${current.board.type} board stays as it is; change it in ${Brand.configFile}`));
  }
  if (typeof b.dir !== "string" || b.dir === "" || b.dir.includes("\0")) {
    issues.push(issue(CheckLevel.Fail, "board.dir", "a folder inside the config root"));
  } else if (b.dir !== current.board.dir && (b.dir.startsWith("~") || !insideRoot(root, b.dir))) {
    issues.push(issue(CheckLevel.Fail, "board.dir", "must stay inside the config root"));
  }
  const repos = Array.isArray(b.repos) ? b.repos : [];
  const logins = Array.isArray(b.trustedAuthors) ? b.trustedAuthors : [];
  if (!Array.isArray(b.repos) || repos.some((r) => typeof r !== "string" || !REPO_PATTERN.test(r))) {
    issues.push(issue(CheckLevel.Fail, "board.repos", "owner/name, one per entry"));
  }
  if (!Array.isArray(b.trustedAuthors) || logins.some((l) => typeof l !== "string" || !LOGIN_PATTERN.test(l))) {
    issues.push(issue(CheckLevel.Fail, "board.trustedAuthors", "GitHub logins, one per entry"));
  }
  if (b.type === BoardType.GitHub && repos.length === 0) issues.push(issue(CheckLevel.Fail, "board.repos", "a GitHub board needs at least one repository"));
  if (b.type === BoardType.GitHub && logins.length === 0) issues.push(issue(CheckLevel.Warn, "board.trustedAuthors", "empty: no issue will run"));

  if (!Object.values(NotifyService).includes(edit.notify.service)) {
    issues.push(issue(CheckLevel.Fail, "notify.service", `must be one of: ${Object.values(NotifyService).join(", ")}`));
  }
  if (typeof edit.notify.chatId !== "string" || (edit.notify.chatId !== current.notify.chatId && edit.notify.chatId !== "" && !TELEGRAM_CHAT_ID_PATTERN.test(edit.notify.chatId))) {
    issues.push(issue(CheckLevel.Fail, "notify.chatId", "a Telegram chat id (a number, e.g. -1001234567890) or @channelname"));
  }
  if (!Array.isArray(edit.ticketSections) || edit.ticketSections.some((l) => typeof l !== "string")) {
    issues.push(issue(CheckLevel.Fail, "ticketSections", "labels, one per line"));
  }
  if (!Array.isArray(edit.gatePaths) || edit.gatePaths.some((g) => typeof g !== "string")) {
    issues.push(issue(CheckLevel.Fail, "gatePaths", "globs, one per line"));
  }

  for (const p of edit.projects) {
    const field = `projects.${p.name}.repoPath`;
    const before = current.projects.find((c) => c.name === p.name);
    if (before === undefined) {
      issues.push(issue(CheckLevel.Fail, field, "unknown project: add projects in the file, not here"));
    } else if (typeof p.repoPath !== "string" || p.repoPath === "" || p.repoPath.includes("\0")) {
      issues.push(issue(CheckLevel.Fail, field, "a folder path"));
    } else if (p.repoPath !== before.repoPath && !isDirectory(inside(root, p.repoPath))) {
      issues.push(issue(CheckLevel.Fail, field, `${inside(root, p.repoPath)} is not a folder`));
    }
    if (typeof p.testCommand !== "string" || p.testCommand.includes("\0") || p.testCommand.length > MAX_COMMAND_CHARS) {
      issues.push(issue(CheckLevel.Fail, `projects.${p.name}.testCommand`, `a shell command line (up to ${MAX_COMMAND_CHARS} characters), or empty to turn the runner's own check off`));
    }
  }
  return issues;
}

function setPath(raw: JsonObject, path: string[], value: unknown): void {
  let node = raw;
  path.slice(0, -1).forEach((key, i) => {
    const next = node[key];
    if (next === undefined) node[key] = {};
    else if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new SettingsError(`${path.slice(0, i + 1).join(".")} in ${Brand.configFile} is not an object; fix it by hand first`, 422);
    }
    node = node[key] as JsonObject;
  });
  node[path[path.length - 1] ?? ""] = value;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Copy of the file's own JSON with only the changed console fields set; every other field stays as it was.
export function applyEdit(raw: JsonObject, edit: SettingsForm, current: SettingsForm): { raw: JsonObject; changed: string[] } {
  const next = structuredClone(raw);
  const changed: string[] = [];
  const set = (path: string[], value: unknown): void => {
    setPath(next, path, value);
    changed.push(path.join("."));
  };
  for (const p of edit.projects) {
    if (p.repoPath !== current.projects.find((c) => c.name === p.name)?.repoPath) set(["projects", p.name, "repoPath"], p.repoPath);
    if (p.testCommand !== current.projects.find((c) => c.name === p.name)?.testCommand) set(["projects", p.name, "testCommand"], p.testCommand);
  }
  if (edit.board.type !== current.board.type) set(["board", "type"], edit.board.type);
  if (edit.board.dir !== current.board.dir) set(["board", "dir"], edit.board.dir);
  if (!sameList(edit.board.repos, current.board.repos)) set(["board", "repos"], edit.board.repos);
  if (!sameList(edit.board.trustedAuthors, current.board.trustedAuthors)) set(["board", "trustedAuthors"], edit.board.trustedAuthors);
  for (const key of ["builder", "reviewer"] as const) {
    if (edit[key].type !== current[key].type) set([key, "type"], edit[key].type);
    if (edit[key].model !== current[key].model) set([key, "model"], edit[key].model);
  }
  if (edit.maxSlots !== current.maxSlots) set(["maxSlots"], edit.maxSlots);
  if (edit.maxConflictRetries !== current.maxConflictRetries) set(["maxConflictRetries"], edit.maxConflictRetries);
  if (edit.staleHours !== current.staleHours) set(["staleHours"], edit.staleHours);
  if (edit.stageTimeoutMinutes !== current.stageTimeoutMinutes) set(["stageTimeoutMinutes"], edit.stageTimeoutMinutes);
  if (!sameList(edit.ticketSections, current.ticketSections)) set(["ticketSections"], edit.ticketSections);
  if (!sameList(edit.gatePaths, current.gatePaths)) set(["gatePaths"], edit.gatePaths);
  if (edit.notify.service !== current.notify.service) set(["notify", "service"], edit.notify.service);
  if (edit.notify.chatId !== current.notify.chatId) set(["notify", "chatId"], edit.notify.chatId);
  return { raw: next, changed };
}

interface Candidate {
  file: RawFile;
  raw: JsonObject;
  changed: string[];
  issues: Issue[];
  // Set when the edited file parses; only then can it be checked further.
  config: Config | undefined;
}

function candidate(root: string, edit: SettingsForm, revision: string): Candidate {
  const file = readRaw(root);
  if (revision !== file.revision) {
    throw new SettingsError(`${Brand.configFile} changed on disk since this page loaded; reload the page`, 409);
  }
  const current = formFrom(file.raw, parseConfig({}, root));
  const issues = validateEdit(edit, current, root);
  if (hasFailure(issues)) return { file, raw: file.raw, changed: [], issues, config: undefined };
  const { raw, changed } = applyEdit(file.raw, edit, current);
  let config: Config | undefined;
  try {
    config = parseConfig(raw, root);
  } catch (error) {
    const message = mask(error instanceof Error ? error.message : String(error));
    // A problem the file already had must not lock the fields next to it.
    const before = configProblem(file.raw, root);
    issues.push(before === message ? issue(CheckLevel.Warn, "config", `still invalid, as before: ${message}`) : issue(CheckLevel.Fail, "config", message));
  }
  return { file, raw, changed, issues, config };
}

export function hasFailure(issues: Issue[]): boolean {
  return issues.some((i) => i.level === CheckLevel.Fail);
}

export interface CheckResult {
  issues: Issue[];
  checks: Check[];
  changed: string[];
}

// Everything that can be known before saving: field rules, the whole config through parseConfig, then doctor's checks.
export async function checkEdit(root: string, edit: SettingsForm, revision: string): Promise<CheckResult> {
  const c = candidate(root, edit, revision);
  const checks = c.config !== undefined && !hasFailure(c.issues) ? await configChecks(c.config, root) : [];
  return { issues: c.issues, checks: checks.map((k) => ({ level: k.level, what: mask(k.what) })), changed: c.changed };
}

export interface SaveResult {
  revision: string;
  changed: string[];
  // The copy of the previous file; empty when nothing changed.
  backup: string;
  issues: Issue[];
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

// Backup, then write a temp file next to the config and rename it over: a crash leaves the old file or the new one.
export function saveEdit(root: string, edit: SettingsForm, revision: string): SaveResult {
  const c = candidate(root, edit, revision);
  if (hasFailure(c.issues)) throw new SettingsError("not saved: fix the marked fields", 422, c.issues);
  if (c.changed.length === 0) return { revision: c.file.revision, changed: [], backup: "", issues: c.issues };
  // A symlinked config (e.g. kept in a dotfiles repo) stays a symlink: the file it points to is replaced.
  const target = realpathSync(c.file.path);
  const mode = statSync(target).mode & 0o777;
  const backup = `${target}.bak-${stamp()}`;
  copyFileSync(target, backup);
  chmodSync(backup, mode);
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const body = `${JSON.stringify(c.raw, null, 2)}\n`;
  try {
    const fd = openSync(tmp, "wx", mode);
    try {
      writeFileSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return { revision: revisionOf(body), changed: c.changed, backup, issues: c.issues };
}
