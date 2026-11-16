import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { boardLabels } from "./board/github.js";
import { LocalMarkdownBoard } from "./board/localMarkdown.js";
import { Brand } from "./brand.js";
import { Config, configPath, hasProject, loadConfig } from "./config.js";
import { dispatch, openRunner, work } from "./dispatch.js";
import { AgentType, BoardType, CheckLevel, PublishMode, TicketKind, TicketStatus } from "./enums.js";
import { run } from "./exec.js";
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
}

function initConfig(options: InitOptions): object {
  const project = options.board === BoardType.GitHub ? options.repo : "my-app";
  return {
    board:
      options.board === BoardType.GitHub
        ? { type: BoardType.GitHub, repos: [options.repo], trustedAuthors: [] }
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
  };
}

export async function init(root: string, options: InitOptions): Promise<void> {
  const path = configPath(root);
  if (existsSync(path)) {
    console.log(`${Brand.configFile} already exists; leaving it as it is.`);
  } else {
    writeFileSync(path, `${JSON.stringify(initConfig(options), null, 2)}\n`);
    console.log(`wrote ${path}`);
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
    console.log(`\nAdd the GitHub logins whose issues may run to board.trustedAuthors in ${Brand.configFile}.`);
  }
  console.log(`\nNext: "${Brand.name} doctor", then add a ticket and "${Brand.name} run".`);
}

export function add(config: Config, title: string, project: string, kind: TicketKind, body: string): string {
  if (config.board.type !== BoardType.LocalMarkdown) {
    // Other boards have their own way to add tickets.
    throw new Error(`"add" works with the local markdown board; on GitHub, open an issue with the ${Brand.labelPrefix}${TicketStatus.Ready} label.`);
  }
  if (!hasProject(config, project)) throw new Error(`project "${project}" is not in ${Brand.configFile}`);
  return new LocalMarkdownBoard(config.board.dir).create(title, project, kind, body);
}

export async function runOnce(config: Config): Promise<void> {
  const starts = await dispatch(openRunner(config));
  console.log(starts.length === 0 ? "nothing to start." : starts.map((s) => `started ${s.mode} worker: ${s.target}`).join("\n"));
}

export async function workSlot(config: Config, key: string): Promise<void> {
  const runner = openRunner(config);
  await work(runner, key);
  if (config.workerDoneCommand !== "") {
    const result = await run("/bin/sh", ["-c", config.workerDoneCommand], config.root);
    runner.log.line(`worker-done hook exit ${result.code}`);
  }
  await dispatch(runner);
}

export async function daemon(config: Config): Promise<void> {
  const minutes = Math.max(1, config.daemonIntervalMinutes);
  console.log(`dispatching every ${minutes} min. Ctrl+C to stop (running workers keep going).`);
  for (;;) {
    await runOnce(config);
    await sleep(minutes * 60_000);
  }
}

export async function status(config: Config): Promise<void> {
  const runner = openRunner(config);
  const live = runner.slots.live();
  console.log(`board: ${runner.board.name}`);
  console.log(live.length === 0 ? "workers: none running" : "workers:");
  for (const slot of live) console.log(`  ${slot.target} (pid ${slot.pid})${slot.stage === "" ? "" : ` - ${slot.stage}`}`);
  for (const s of [TicketStatus.Working, TicketStatus.Ready, TicketStatus.Review, TicketStatus.Blocked]) {
    const tickets = await runner.board.list(s);
    console.log(`${s}: ${tickets.length}`);
    for (const t of tickets.slice(0, 10)) console.log(`  ${t.id}  ${t.title}  [${t.project}]`);
  }
}

interface Check {
  level: CheckLevel;
  what: string;
}

async function tool(cmd: string, args: string[], cwd: string): Promise<boolean> {
  return (await run(cmd, args, cwd)).code === 0;
}

export async function doctor(root: string): Promise<boolean> {
  const checks: Check[] = [];
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({ level: major >= 20 ? CheckLevel.Ok : CheckLevel.Fail, what: `node ${process.versions.node} (need 20+)` });
  let config: Config;
  try {
    config = loadConfig(root);
    checks.push({ level: CheckLevel.Ok, what: `${Brand.configFile} is valid` });
  } catch (error) {
    checks.push({ level: CheckLevel.Fail, what: error instanceof Error ? error.message : String(error) });
    return report(checks);
  }
  statePaths(config.stateDir);
  checks.push({ level: CheckLevel.Ok, what: `state folder ${config.stateDir}` });
  checks.push({ level: (await tool(config.tools.git, ["--version"], root)) ? CheckLevel.Ok : CheckLevel.Fail, what: "git" });
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
    if (p.rulesFile !== "" && !existsSync(p.rulesFile)) {
      checks.push({ level: CheckLevel.Warn, what: `project ${p.name}: rules file ${p.rulesFile} not found` });
    }
  }
  if (config.autoMerge) checks.push({ level: CheckLevel.Warn, what: "autoMerge is on: passed pull requests merge without you" });
  return report(checks);
}

function report(checks: Check[]): boolean {
  const mark: Record<CheckLevel, string> = { [CheckLevel.Ok]: "ok  ", [CheckLevel.Warn]: "warn", [CheckLevel.Fail]: "FAIL" };
  for (const c of checks) console.log(`${mark[c.level]}  ${c.what}`);
  return !checks.some((c) => c.level === CheckLevel.Fail);
}
