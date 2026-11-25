import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DependencyWait, dependencyWaits, isBroken, loadDependencyGraph } from "./board/board.js";
import { boardLabels } from "./board/github.js";
import { LocalMarkdownBoard } from "./board/localMarkdown.js";
import { Brand } from "./brand.js";
import { Config, ConfigError, TELEGRAM_CHAT_ID_PATTERN, configPath, hasProject, loadConfig } from "./config.js";
import { dispatch, missingSections, openRunner, sectionsTemplate, work } from "./dispatch.js";
import {
  AgentType, BoardType, CheckLevel, DEFAULT_GATE_PATHS, GATE_PATHS_DEFAULT_KEYWORD, NotifyService, PublishMode, SECTION_PRESET_LABELS, SectionPreset, TicketKind, TicketStatus,
} from "./enums.js";
import { UsageLog, formatTotal, totalUsage } from "./usage.js";
import { run } from "./exec.js";
import { missingEnv } from "./notify.js";
import { parseSince, readReport, renderReport, reportJson, sendReport } from "./report.js";
import { messagesFor } from "./messages.js";
import { checkPublish } from "./preflight.js";
import { statePaths } from "./state.js";

export const RULES_FILE = `${Brand.name}.rules.md`;

const RULES_TEMPLATE = `# Rules for every ${Brand.name} run

Both the developer and the reviewer read this. Keep it short: house rules the repository's own
CLAUDE.md / AGENTS.md does not already say.

- Commit messages follow Conventional Commits.
- Never commit secrets, and never print them in logs or pull request bodies.
`;

export interface InitOptions {
  board: BoardType;
  repo: string;
  repoPath: string;
  // GitHub logins whose issues may run. Empty: the signed-in gh user.
  trusted: string[];
  // ticketSections labels to write. Empty: off.
  sections: string[];
  // gatePaths globs to write. Empty: off.
  gatePaths: string[];
  // Built-in chat notifications. None: off.
  notify: NotifyService;
  // Telegram only: the chat to write to.
  notifyChatId: string;
}

// Turns the --sections, --gate-paths and --notify values into InitOptions parts. Throws on a value it cannot use.
export function initExtras(sections: string, gatePaths: string, notify: string, notifyChatId: string): Pick<InitOptions, "sections" | "gatePaths" | "notify" | "notifyChatId"> {
  const split = (v: string): string[] => v.split(",").map((x) => x.trim()).filter((x) => x !== "");
  const presets = split(sections).map((name) => {
    const preset = Object.values(SectionPreset).find((p) => p === name);
    if (preset === undefined) throw new ConfigError(`--sections: unknown "${name}" (use ${Object.values(SectionPreset).join(", ")})`);
    return preset;
  });
  const globs = split(gatePaths).flatMap((g) => (g === GATE_PATHS_DEFAULT_KEYWORD ? [...DEFAULT_GATE_PATHS] : [g]));
  const service = notify === "" ? NotifyService.None : Object.values(NotifyService).find((n) => n === notify);
  if (service === undefined || (notify !== "" && service === NotifyService.None)) {
    throw new ConfigError(`--notify must be one of: ${Object.values(NotifyService).filter((n) => n !== NotifyService.None).join(", ")}`);
  }
  if (service === NotifyService.Telegram && notifyChatId === "") throw new ConfigError("--notify telegram needs --notify-chat-id <chat id>");
  if (service !== NotifyService.Telegram && notifyChatId !== "") throw new ConfigError("--notify-chat-id is only for --notify telegram");
  if (notifyChatId !== "" && !TELEGRAM_CHAT_ID_PATTERN.test(notifyChatId)) {
    throw new ConfigError("--notify-chat-id must be a Telegram chat id (a number, e.g. -1001234567890) or @channelname");
  }
  return {
    sections: presets.filter((p, i) => presets.indexOf(p) === i).map((p) => SECTION_PRESET_LABELS[p]),
    gatePaths: globs.filter((g, i) => globs.indexOf(g) === i),
    notify: service,
    notifyChatId,
  };
}

function initProjectName(options: InitOptions): string {
  return options.board === BoardType.GitHub ? options.repo : basename(resolve(options.repoPath)) || "my-app";
}

function initConfig(options: InitOptions): object {
  const project = initProjectName(options);
  return {
    board:
      options.board === BoardType.GitHub
        ? { type: BoardType.GitHub, repos: [options.repo], trustedAuthors: options.trusted }
        : { type: BoardType.LocalMarkdown, dir: Brand.ticketsDir },
    projects: {
      [project]: {
        repoPath: options.repoPath,
        baseBranch: "main",
        publish: options.board === BoardType.GitHub ? PublishMode.PullRequest : PublishMode.Branch,
        rulesFile: RULES_FILE,
      },
    },
    builder: { type: AgentType.ClaudeCode, model: "sonnet" },
    reviewer: { type: AgentType.ClaudeCode, model: "opus" },
    maxSlots: 3,
    maxRework: 1,
    autoMerge: false,
    // Only written when asked for, so a plain init stays as before.
    ...(options.sections.length > 0 ? { ticketSections: options.sections } : {}),
    ...(options.gatePaths.length > 0 ? { gatePaths: options.gatePaths } : {}),
    ...(options.notify === NotifyService.None
      ? {}
      : { notify: options.notify === NotifyService.Telegram ? { service: options.notify, chatId: options.notifyChatId } : { service: options.notify } }),
  };
}

async function signedInLogin(gh: string, root: string): Promise<string> {
  const result = await run(gh, ["api", "user", "--jq", ".login"], root);
  return result.code === 0 ? result.stdout.trim() : "";
}

export async function init(root: string, given: InitOptions): Promise<void> {
  let options = given;
  if (options.board === BoardType.GitHub && options.trusted.length === 0) {
    const login = await signedInLogin("gh", root);
    if (login !== "") {
      options = { ...options, trusted: [login] };
      console.log(`trusted author: ${login} (the signed-in gh user; add more with --trusted a,b)`);
    }
  }
  const path = configPath(root);
  if (existsSync(path)) {
    console.log(`${Brand.configFile} already exists; leaving it as it is.`);
  } else {
    writeFileSync(path, `${JSON.stringify(initConfig(options), null, 2)}\n`);
    console.log(`wrote ${path}`);
    if (options.notify !== NotifyService.None) {
      const config = loadConfig(root);
      const [name] = missingEnv(config.notify, {});
      if (name !== undefined) console.log(`notify ${options.notify}: export ${name} where the runner runs (the secret never goes in ${Brand.configFile}).`);
    }
  }
  const rules = join(root, RULES_FILE);
  if (!existsSync(rules)) {
    writeFileSync(rules, RULES_TEMPLATE);
    console.log(`wrote ${rules}`);
  }
  if (options.board === BoardType.LocalMarkdown) {
    mkdirSync(join(root, Brand.ticketsDir), { recursive: true });
  } else {
    const config = loadConfig(root);
    for (const label of boardLabels()) {
      const result = await run(
        config.tools.gh,
        ["label", "create", label.name, "--repo", options.repo, "--color", label.color, "--description", label.description, "--force"],
        root,
      );
      console.log(`${result.code === 0 ? "label" : "label FAILED"} ${label.name}${result.code === 0 ? "" : `: ${result.stderr.trim()}`}`);
    }
    if (options.trusted.length === 0) {
      console.log(`\nNo trusted author yet: add the GitHub logins whose issues may run to board.trustedAuthors in ${Brand.configFile}.`);
    }
    console.log(`\nNext: "${Brand.name} doctor", then label an issue ${Brand.labelPrefix}${TicketStatus.Ready} and "${Brand.name} run".`);
    return;
  }
  console.log(`\nNext:\n  ${Brand.name} doctor\n  ${Brand.name} add '<what to do>' --project ${initProjectName(options)}\n  ${Brand.name} run`);
}

export function add(config: Config, title: string, project: string, kind: TicketKind, body: string, dependsOn: string[] = []): string {
  if (config.board.type !== BoardType.LocalMarkdown) {
    // Other boards have their own way to add tickets.
    throw new Error(`"add" works with the local markdown board; on GitHub, open an issue with the ${Brand.labelPrefix}${TicketStatus.Ready} label.`);
  }
  if (!hasProject(config, project)) throw new Error(`project "${project}" is not in ${Brand.configFile}`);
  // Only the items the given body does not already fill, so a complete --body gets no second, empty form.
  const form = kind === TicketKind.Release ? "" : sectionsTemplate(missingSections(body, config.ticketSections));
  const full = body === "" ? form : form === "" ? body : `${body}\n\n${form}`;
  return new LocalMarkdownBoard(config.board.dir).create(title, project, kind, full, dependsOn);
}

// The config's env joins this process's environment, so the agent, git and gh it starts (and the workers) see it.
export function applyEnv(config: Config): void {
  Object.assign(process.env, config.env);
}

export async function runOnce(config: Config): Promise<void> {
  applyEnv(config);
  const runner = openRunner(config);
  const starts = await dispatch(runner);
  if (starts.length > 0) {
    for (const s of starts) console.log(`started ${s.mode} worker: ${s.target}`);
    console.log(`Workers run in the background. Follow them with "${Brand.name} logs -f"; see results with "${Brand.name} status".`);
    return;
  }
  const busy = runner.slots.live().length;
  const ready = (await runner.board.list(TicketStatus.Ready)).length;
  if (ready === 0) console.log("nothing to start: no ready tickets.");
  else console.log(`nothing to start: ${ready} ready ticket(s) wait for a project that is already being worked on (${busy} worker(s) running).`);
}

export function logs(config: Config, lines: number, follow: boolean): Promise<void> {
  const file = statePaths(config.stateDir).log;
  if (!existsSync(file)) {
    console.log(`no log yet (${file}).`);
    return Promise.resolve();
  }
  const text = readFileSync(file, "utf8");
  process.stdout.write(text.split("\n").slice(-(lines + 1)).join("\n"));
  if (!follow) return Promise.resolve();
  let offset = statSync(file).size;
  return new Promise(() => {
    setInterval(() => {
      const size = statSync(file).size;
      if (size < offset) offset = 0;
      if (size === offset) return;
      const fd = openSync(file, "r");
      const chunk = Buffer.alloc(size - offset);
      readSync(fd, chunk, 0, chunk.length, offset);
      closeSync(fd);
      offset = size;
      process.stdout.write(chunk.toString("utf8"));
    }, 1000);
  });
}

export async function workSlot(config: Config, key: string): Promise<void> {
  applyEnv(config);
  const runner = openRunner(config);
  await work(runner, key);
  if (config.workerDoneCommand !== "") {
    const result = await run("/bin/sh", ["-c", config.workerDoneCommand], config.root);
    runner.log.line(`worker-done hook exit ${result.code}`);
  }
  await dispatch(runner);
}

export async function daemon(config: Config): Promise<void> {
  applyEnv(config);
  const seconds = config.pollSeconds;
  console.log(`looking for work every ${seconds}s. Ctrl+C to stop (running workers keep going).`);
  for (;;) {
    await runOnce(config);
    await sleep(seconds * 1000);
  }
}

export async function status(config: Config): Promise<void> {
  const runner = openRunner(config);
  const live = runner.slots.live();
  const say = messagesFor(config.language);
  console.log(`board: ${runner.board.name}`);
  console.log(`log:   ${runner.paths.log}`);
  for (const limit of runner.limits.active(Date.now())) {
    const until = new Date(limit.until).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
    console.log(`usage limit: ${limit.agent} until ${until} (${limit.message})`);
  }
  console.log(live.length === 0 ? "workers: none running" : "workers:");
  for (const slot of live) console.log(`  ${slot.target} (pid ${slot.pid})${slot.stage === "" ? "" : ` - ${slot.stage}`}`);
  for (const s of [TicketStatus.Working, TicketStatus.Ready, TicketStatus.Review, TicketStatus.Blocked]) {
    const tickets = await runner.board.list(s);
    console.log(`${s}: ${tickets.length}`);
    const graph = s === TicketStatus.Ready ? await loadDependencyGraph(runner.board, tickets) : new Map();
    for (const t of tickets.slice(0, 10)) {
      const entries = new UsageLog(runner.paths.usage, t.id).read();
      console.log(`  ${t.id}  ${t.title}  [${t.project}]${entries.length === 0 ? "" : `  ${formatTotal(totalUsage(entries))}`}`);
      for (const wait of dependencyWaits(t, graph)) console.log(`    ${say.dependencyWait(wait)}`);
    }
  }
}

export interface ReportOptions {
  since: string;
  json: boolean;
  send: boolean;
}

// The morning report from the runner's own records; it never asks the board. Returns the exit code.
export async function showReport(config: Config, options: ReportOptions): Promise<number> {
  const now = Date.now();
  const data = readReport(statePaths(config.stateDir), parseSince(options.since, now), now);
  const body = renderReport(data, config.language);
  console.log(options.json ? reportJson(data) : body);
  if (!options.send) return 0;
  const say = messagesFor(config.language).report;
  const failures = await sendReport(config, body, false);
  if (config.notify.service === NotifyService.None && config.notifyCommand === "") {
    console.error(say.sendNothing);
    return 1;
  }
  for (const failure of failures) console.error(failure);
  if (failures.length === 0) console.error(say.sent);
  return failures.length === 0 ? 0 : 1;
}

export interface Check {
  level: CheckLevel;
  what: string;
}

async function tool(cmd: string, args: string[], cwd: string): Promise<boolean> {
  return (await run(cmd, args, cwd)).code === 0;
}

export async function doctor(root: string): Promise<boolean> {
  try {
    applyEnv(loadConfig(root));
  } catch {
    // doctorChecks reports a config that cannot be read.
  }
  return report(await doctorChecks(root));
}

// Everything "doctor" looks at, for the saved config in root.
export async function doctorChecks(root: string): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({ level: major >= 20 ? CheckLevel.Ok : CheckLevel.Fail, what: `node ${process.versions.node} (need 20+)` });
  let config: Config;
  try {
    config = loadConfig(root);
    checks.push({ level: CheckLevel.Ok, what: `${Brand.configFile} is valid` });
  } catch (error) {
    checks.push({ level: CheckLevel.Fail, what: error instanceof Error ? error.message : String(error) });
    return checks;
  }
  return [...checks, ...(await configChecks(config, root))];
}

// The tool, sign-in and path checks for a parsed config. Used by "doctor" and by the console's check before saving.
export async function configChecks(config: Config, root: string): Promise<Check[]> {
  const checks: Check[] = [];
  statePaths(config.stateDir);
  checks.push({ level: CheckLevel.Ok, what: `state folder ${config.stateDir}` });
  checks.push({ level: (await tool(config.tools.git, ["--version"], root)) ? CheckLevel.Ok : CheckLevel.Fail, what: "git" });
  if (config.board.type === BoardType.Notion) {
    try {
      await openRunner(config).board.list(TicketStatus.Ready);
      checks.push({ level: CheckLevel.Ok, what: `Notion database ${config.board.notion.databaseId} is readable` });
    } catch (error) {
      checks.push({ level: CheckLevel.Fail, what: `Notion: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (config.board.type === BoardType.Command) {
    checks.push({ level: existsSync(config.board.command) ? CheckLevel.Ok : CheckLevel.Fail, what: `board command ${config.board.command}` });
  }
  const needsGh = config.board.type === BoardType.GitHub || config.projects.some((p) => p.publish === PublishMode.PullRequest);
  if (needsGh) {
    checks.push({ level: (await tool(config.tools.gh, ["auth", "status"], root)) ? CheckLevel.Ok : CheckLevel.Fail, what: "gh is installed and signed in" });
  }
  for (const agent of [config.builder, config.reviewer]) {
    if (agent.type === AgentType.ClaudeCode) {
      checks.push({ level: (await tool(config.tools.claude, ["--version"], root)) ? CheckLevel.Ok : CheckLevel.Fail, what: `claude CLI (${agent.model})` });
    } else if (agent.type === AgentType.Codex) {
      checks.push({ level: (await tool(config.tools.codex, ["--version"], root)) ? CheckLevel.Ok : CheckLevel.Fail, what: `codex CLI (${agent.model || "its default model"}, sandbox ${agent.sandbox})` });
    } else {
      checks.push({ level: existsSync(agent.command) ? CheckLevel.Ok : CheckLevel.Fail, what: `agent command ${agent.command}` });
    }
  }
  if (config.board.type === BoardType.GitHub && config.board.trustedAuthors.length === 0) {
    checks.push({ level: CheckLevel.Warn, what: "board.trustedAuthors is empty: no issue will run" });
  }
  if (config.projects.length === 0) checks.push({ level: CheckLevel.Fail, what: "no projects configured" });
  for (const p of config.projects) {
    const isRepo = await tool(config.tools.git, ["rev-parse", "--git-dir"], p.repoPath).catch(() => false);
    checks.push({ level: isRepo ? CheckLevel.Ok : CheckLevel.Fail, what: `project ${p.name}: ${p.repoPath} is a git repo` });
    if (isRepo) {
      const publish = await checkPublish(config, p);
      checks.push({ level: publish.ok ? CheckLevel.Ok : CheckLevel.Fail, what: publish.ok ? `project ${p.name}: ${publishOk(p.publish)}` : publish.message });
    }
    if (p.rulesFile !== "" && !existsSync(p.rulesFile)) {
      checks.push({ level: CheckLevel.Warn, what: `project ${p.name}: rules file ${p.rulesFile} not found` });
    }
  }
  if (config.notify.service !== NotifyService.None) {
    const missing = missingEnv(config.notify);
    checks.push({
      level: missing.length === 0 ? CheckLevel.Ok : CheckLevel.Warn,
      what: missing.length === 0
        ? `notify ${config.notify.service}: environment variable is set`
        : `notify ${config.notify.service}: environment variable ${missing.join(", ")} is not set, so no message will be sent`,
    });
  }
  checks.push(...(await dependencyChecks(config)));
  if (config.autoMerge) checks.push({ level: CheckLevel.Warn, what: "autoMerge is on: passed pull requests merge without you" });
  return checks;
}

// Ready and blocked tickets whose predecessors can never be done: a missing id, itself, a loop.
export async function dependencyChecks(config: Config): Promise<Check[]> {
  const say = messagesFor(config.language);
  try {
    const board = openRunner(config).board;
    const tickets = [...(await board.list(TicketStatus.Ready)), ...(await board.list(TicketStatus.Blocked))];
    const graph = await loadDependencyGraph(board, tickets);
    return tickets.flatMap((t) =>
      dependencyWaits(t, graph).filter(isBroken).map((w: DependencyWait) => ({ level: CheckLevel.Warn, what: `ticket ${t.id}: ${say.dependencyWait(w)}, so it will not start` })),
    );
  } catch {
    // The board is not readable here; the other checks say so.
    return [];
  }
}

function publishOk(publish: PublishMode): string {
  return publish === PublishMode.PullRequest ? "origin exists and the gh account can push" : "publishes to a branch, no remote needed";
}

function report(checks: Check[]): boolean {
  const mark: Record<CheckLevel, string> = { [CheckLevel.Ok]: "ok  ", [CheckLevel.Warn]: "warn", [CheckLevel.Fail]: "FAIL" };
  for (const c of checks) console.log(`${mark[c.level]}  ${c.what}`);
  return !checks.some((c) => c.level === CheckLevel.Fail);
}
