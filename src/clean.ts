import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Board, Ticket } from "./board/board.js";
import { Config } from "./config.js";
import { StateFile, TicketStatus } from "./enums.js";
import { run } from "./exec.js";
import { knownWorktrees } from "./git.js";
import { StatePaths, statePaths } from "./state.js";

const DAY_MS = 86_400_000;
const WORK_DIR = "work";

export enum CleanKind {
  // A finished ticket's worktree that git knows and that has nothing uncommitted.
  Worktree = "worktree",
  // A folder under worktrees that git does not know as a worktree.
  Stray = "stray folder",
  // A file or folder in results that the runner did not make, of a done ticket older than keepDays.
  Results = "results",
  // The ticket's folder in work, done and older than keepDays.
  Work = "work",
}

export interface CleanItem {
  kind: CleanKind;
  path: string;
  bytes: number;
  ticket: string;
  // The repository that owns the worktree (Worktree only; "" for the rest).
  repo: string;
}

export interface CleanKept {
  path: string;
  why: string;
}

export interface CleanPlan {
  items: CleanItem[];
  kept: CleanKept[];
  keepDays: number;
}

// Size in bytes and the newest modification time (ms) of a file or a whole folder. Symlinks are not followed.
export function measure(path: string): { bytes: number; newest: number } {
  const info = lstatSync(path);
  if (!info.isDirectory()) return { bytes: info.size, newest: info.mtimeMs };
  let bytes = 0;
  let newest = info.mtimeMs;
  for (const name of readdirSync(path)) {
    const inner = measure(join(path, name));
    bytes += inner.bytes;
    newest = Math.max(newest, inner.newest);
  }
  return { bytes, newest };
}

// The ticket a result or work name belongs to: the name starts with the ticket id (any case, with or without the
// dash) and then stops being a letter or digit. "tk-446.old-…" and "TK-446-evidence" belong to TK-446, not to TK-44.
export function ticketOfName(name: string, tickets: Ticket[]): Ticket | undefined {
  const lower = name.toLowerCase();
  const matches = tickets.filter((t) => {
    const id = t.id.toLowerCase();
    return [id, id.replace(/[-_]/g, "")].some((p) => lower.startsWith(p) && !/[a-z0-9]/.test(lower.charAt(p.length)));
  });
  return matches.sort((a, b) => b.id.length - a.id.length)[0];
}

const RUNNER_FILE_FIRST = new Set<string>(Object.values(StateFile).map((f) => f.split(".")[0] ?? f));

// Whether a results entry is one the runner reads or sets aside: "<id>.build", "<id>.review.prev", "<id>.build.invalid-…".
export function isRunnerFile(name: string, ticket: Ticket): boolean {
  const id = ticket.id.toLowerCase();
  if (!name.toLowerCase().startsWith(`${id}.`)) return false;
  return RUNNER_FILE_FIRST.has(name.slice(id.length + 1).split(".")[0] ?? "");
}

async function allTickets(board: Board): Promise<Ticket[]> {
  const out: Ticket[] = [];
  for (const status of Object.values(TicketStatus)) out.push(...(await board.list(status)));
  return out;
}

async function uncommitted(config: Config, path: string): Promise<boolean> {
  const result = await run(config.tools.git, ["status", "--porcelain"], path);
  return result.code !== 0 || result.stdout.trim() !== "";
}

function subfolders(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => lstatSync(join(dir, n)).isDirectory()).sort() : [];
}

// What "clean" would remove and what it keeps. Touches nothing. Throws when git cannot say which folders are worktrees:
// then nothing may be called a leftover.
export async function planClean(config: Config, board: Board, now: number, paths: StatePaths = statePaths(config.stateDir)): Promise<CleanPlan> {
  const tickets = await allTickets(board);
  const plan: CleanPlan = { items: [], kept: [], keepDays: config.keepDays };
  const known = new Map<string, string>();
  for (const project of config.projects) {
    for (const path of await knownWorktrees(config, project.repoPath)) known.set(path, project.repoPath);
  }
  for (const name of subfolders(paths.worktrees)) {
    const path = join(paths.worktrees, name);
    const ticket = ticketOfName(name, tickets);
    if (ticket !== undefined && ticket.status !== TicketStatus.Done) {
      plan.kept.push({ path, why: `${ticket.id} is ${ticket.status}` });
      continue;
    }
    const repo = known.get(realpathSync(path));
    if (repo === undefined) {
      plan.items.push({ kind: CleanKind.Stray, path, bytes: measure(path).bytes, ticket: ticket?.id ?? "", repo: "" });
    } else if (ticket === undefined) {
      plan.kept.push({ path, why: "a worktree of a ticket the board does not list" });
    } else if (await uncommitted(config, path)) {
      plan.kept.push({ path, why: `${ticket.id} is done but the worktree has uncommitted changes` });
    } else {
      plan.items.push({ kind: CleanKind.Worktree, path, bytes: measure(path).bytes, ticket: ticket.id, repo });
    }
  }

  const old = (newest: number): boolean => now - newest > config.keepDays * DAY_MS;
  const consider = (kind: CleanKind, dir: string, entries: string[]): void => {
    for (const name of entries) {
      const ticket = ticketOfName(name, tickets);
      if (ticket === undefined || ticket.status !== TicketStatus.Done || isRunnerFile(name, ticket)) continue;
      const path = join(dir, name);
      const size = measure(path);
      if (old(size.newest)) plan.items.push({ kind, path, bytes: size.bytes, ticket: ticket.id, repo: "" });
    }
  };
  consider(CleanKind.Results, paths.results, existsSync(paths.results) ? readdirSync(paths.results).sort() : []);
  const workDir = join(config.stateDir, WORK_DIR);
  consider(CleanKind.Work, workDir, existsSync(workDir) ? readdirSync(workDir).sort() : []);
  return plan;
}

export function totalBytes(items: CleanItem[]): number {
  return items.reduce((sum, i) => sum + i.bytes, 0);
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export interface CleanOutcome {
  removed: CleanItem[];
  failed: CleanKept[];
}

// Removes what the plan lists. A worktree goes through "git worktree remove" without --force, so git refuses it if
// something changed since the plan; the branch always stays.
export async function applyClean(config: Config, plan: CleanPlan): Promise<CleanOutcome> {
  const outcome: CleanOutcome = { removed: [], failed: [] };
  for (const item of plan.items) {
    try {
      if (item.kind === CleanKind.Worktree) {
        const result = await run(config.tools.git, ["worktree", "remove", item.path], item.repo);
        if (result.code !== 0) throw new Error(result.stderr.trim() || `git worktree remove exited ${result.code}`);
      } else {
        rmSync(item.path, { recursive: true, force: true });
      }
      outcome.removed.push(item);
    } catch (error) {
      outcome.failed.push({ path: item.path, why: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcome;
}
