import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalMarkdownBoard } from "../src/board/localMarkdown.js";
import { Config, parseConfig } from "../src/config.js";
import { openRunner } from "../src/dispatch.js";
import { AgentType, BoardType, PublishMode, SettleReason, TicketKind, TicketStatus } from "../src/enums.js";
import { Runner } from "../src/pipeline.js";

// Compiled tests run from dist/test; the fixtures stay in the source tree.
export const FIXTURES = fileURLToPath(new URL("../../test/fixtures/", import.meta.url));

export interface Sandbox {
  root: string;
  repo: string;
  config: Config;
  runner: Runner;
  board: LocalMarkdownBoard;
  plan(lines: string[]): void;
  calls(): string[];
  prompt(n: number): string;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "ignore" });
}

export function sandbox(overrides: Record<string, unknown> = {}, publish: PublishMode = PublishMode.Branch): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "nightshift-test-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "demo\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);

  const agent = join(FIXTURES, "fake-agent.sh");
  chmodSync(agent, 0o755);
  const planFile = join(root, "plan.txt");
  const callsFile = join(root, "calls.txt");
  process.env.FAKE_PLAN_FILE = planFile;
  process.env.FAKE_CALLS_FILE = callsFile;
  writeFileSync(planFile, "");

  const config = parseConfig(
    {
      board: { type: BoardType.LocalMarkdown, dir: ".tickets" },
      projects: { demo: { repoPath: repo, publish } },
      builder: { type: AgentType.Command, command: agent, model: "fake-builder" },
      reviewer: { type: AgentType.Command, command: agent, model: "fake-reviewer" },
      resumeCooldownMinutes: 0,
      ...overrides,
    },
    root,
  );
  const runner = openRunner(config);
  return {
    root,
    repo,
    config,
    runner,
    board: new LocalMarkdownBoard(config.board.dir),
    plan: (lines) => writeFileSync(planFile, `${lines.join("\n")}\n`),
    calls: () => {
      try {
        return readFileSync(callsFile, "utf8").trim().split("\n").filter((l) => l !== "");
      } catch {
        return [];
      }
    },
    prompt: (n) => readFileSync(`${callsFile}.${n}`, "utf8"),
  };
}

export async function readyTicket(box: Sandbox, title: string, kind: TicketKind = TicketKind.Build): Promise<string> {
  const id = box.board.create(title, "demo", kind, `Please ${title.toLowerCase()}.`);
  await box.board.setStatus(id, TicketStatus.Working, SettleReason.Claimed, "");
  return id;
}

export async function ticketStatus(box: Sandbox, id: string): Promise<TicketStatus> {
  for (const status of Object.values(TicketStatus)) {
    if ((await box.board.list(status)).some((t) => t.id === id)) return status;
  }
  throw new Error(`ticket ${id} not found`);
}

export function ticketFile(box: Sandbox, id: string): string {
  return readFileSync(join(box.config.board.dir, `${id}.md`), "utf8");
}
