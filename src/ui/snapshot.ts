import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { DependencyWait, DependencyWaitCause, Ticket, dependencyWaits, loadDependencyGraph } from "../board/board.js";
import { openBoard } from "../board/index.js";
import { Config } from "../config.js";
import { StateFile, TicketKind, TicketStatus } from "../enums.js";
import { mask } from "../log.js";
import { UsageLog, formatTotal, totalUsage } from "../usage.js";
import { PreflightMemory } from "../preflight.js";
import { ReportData, readReport } from "../report.js";
import { SlotInfo, Slots, TicketState, UsageLimits, projectSlotKey, statePaths } from "../state.js";

const LOG_LINES = 60;
const LOG_TAIL_BYTES = 64 * 1024;
const LIST_LIMIT = 15;

export enum WaitCause {
  UsageLimit = "usage-limit",
  ReleaseRunning = "release-running",
  ReleaseWaitsForIdle = "release-waits-for-idle",
  ProjectBusy = "project-busy",
  NoFreeSlot = "no-free-slot",
  UnknownProject = "unknown-project",
  PreflightFailed = "preflight-failed",
  NextDispatch = "next-dispatch",
  DependencyMissing = "dependency-missing",
  DependencySelf = "dependency-self",
  DependencyCycle = "dependency-cycle",
  DependencyBlocked = "dependency-blocked",
  DependencyPending = "dependency-pending",
}

const DEPENDENCY_CAUSE: Record<DependencyWaitCause, WaitCause> = {
  [DependencyWaitCause.Missing]: WaitCause.DependencyMissing,
  [DependencyWaitCause.Self]: WaitCause.DependencySelf,
  [DependencyWaitCause.Cycle]: WaitCause.DependencyCycle,
  [DependencyWaitCause.Blocked]: WaitCause.DependencyBlocked,
  [DependencyWaitCause.Pending]: WaitCause.DependencyPending,
};

export interface WaitReason {
  cause: WaitCause;
  // Free-form detail (the limit's end time, the busy project): shown next to the cause.
  detail: string;
}

export interface WorkerView {
  target: string;
  pid: number;
  stage: string;
  release: boolean;
}

export interface TicketView {
  id: string;
  title: string;
  project: string;
  status: TicketStatus;
  // The stage file of a ticket in progress, e.g. "review 1". Empty: none.
  stage: string;
  // Why a ready ticket has not started. Empty cause list: not waiting.
  waiting: WaitReason[];
  // Weighted tokens and time the stages used so far ("217k · 3m27s"). Empty: no stage has finished.
  usage: string;
}

export interface LimitView {
  agent: string;
  until: string;
  message: string;
}

const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

// The morning report of the last 24 hours, for the console card. Times are epoch milliseconds.
export type ReportView = ReportData;

export interface StatusSnapshot {
  report: ReportView;
  board: string;
  boardError: string;
  workers: WorkerView[];
  limits: LimitView[];
  tickets: Record<TicketStatus, { count: number; items: TicketView[] }>;
  log: string[];
  maxSlots: number;
  pollSeconds: number;
}

function stamp(ms: number): string {
  return new Date(ms).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
}

// Why a ready ticket is not running yet, mirroring planDispatch. Pure.
export function waitReasons(
  ticket: Ticket,
  live: SlotInfo[],
  limits: { agent: string; until: number }[],
  maxSlots: number,
  knownProjects: string[],
  // Project name -> why it cannot publish (empty: nothing wrong).
  preflight: Record<string, string> = {},
  // What the ticket still waits for among the tickets it depends on.
  dependencies: DependencyWait[] = [],
): WaitReason[] {
  const reasons: WaitReason[] = dependencies.map((w) => ({ cause: DEPENDENCY_CAUSE[w.cause], detail: w.id }));
  if (limits.length > 0) {
    reasons.push({ cause: WaitCause.UsageLimit, detail: `${limits.map((l) => l.agent).join(", ")} until ${stamp(Math.max(...limits.map((l) => l.until)))}` });
  }
  if (live.some((slot) => slot.release)) reasons.push({ cause: WaitCause.ReleaseRunning, detail: "" });
  if (ticket.kind === TicketKind.Release) {
    if (live.length > 0) reasons.push({ cause: WaitCause.ReleaseWaitsForIdle, detail: `${live.length}` });
  } else {
    if (!knownProjects.includes(ticket.project)) reasons.push({ cause: WaitCause.UnknownProject, detail: ticket.project });
    const unpublishable = preflight[ticket.project] ?? "";
    if (unpublishable !== "") reasons.push({ cause: WaitCause.PreflightFailed, detail: unpublishable });
    if (live.some((slot) => slot.key === projectSlotKey(ticket.project))) reasons.push({ cause: WaitCause.ProjectBusy, detail: ticket.project });
    if (live.length >= maxSlots) reasons.push({ cause: WaitCause.NoFreeSlot, detail: `${live.length}/${maxSlots}` });
  }
  return reasons.length > 0 ? reasons : [{ cause: WaitCause.NextDispatch, detail: "" }];
}

// Reads only the end of the log, so a long-running runner's big log file costs the same as a small one.
function logTail(file: string): string[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const length = Math.min(size, LOG_TAIL_BYTES);
  const buf = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  // The first line may start mid-line (or mid-character) when the file was cut.
  if (size > length) lines.shift();
  return lines.filter((l) => l !== "").slice(-LOG_LINES).map(mask);
}

function usageText(dir: string, ticketId: string): string {
  const entries = new UsageLog(dir, ticketId).read();
  return entries.length === 0 ? "" : formatTotal(totalUsage(entries));
}

// What "status" and "logs" show, as data. Reads only: nothing is cleaned up, started or moved.
export async function snapshot(config: Config): Promise<StatusSnapshot> {
  const paths = statePaths(config.stateDir);
  const now = Date.now();
  const live = new Slots(paths.slots).peek();
  const limits = new UsageLimits(paths.limits).peek(now);
  const empty = (): { count: number; items: TicketView[] } => ({ count: 0, items: [] });
  const tickets: StatusSnapshot["tickets"] = {
    [TicketStatus.Working]: empty(),
    [TicketStatus.Ready]: empty(),
    [TicketStatus.Review]: empty(),
    [TicketStatus.Blocked]: empty(),
    [TicketStatus.Done]: empty(),
  };
  let boardError = "";
  const board = openBoard(config);
  const projects = config.projects.map((p) => p.name);
  const memory = new PreflightMemory(paths.preflight);
  const preflight: Record<string, string> = {};
  for (const name of projects) preflight[name] = memory.message(name);
  for (const status of [TicketStatus.Working, TicketStatus.Ready, TicketStatus.Review, TicketStatus.Blocked]) {
    try {
      const list = await board.list(status);
      const graph = status === TicketStatus.Ready ? await loadDependencyGraph(board, list.slice(0, LIST_LIMIT)) : new Map<string, Ticket>();
      tickets[status] = {
        count: list.length,
        items: list.slice(0, LIST_LIMIT).map((t) => ({
          id: t.id,
          title: mask(t.title),
          project: t.project,
          status,
          stage: new TicketState(paths.results, t.id).firstLine(StateFile.Stage),
          usage: usageText(paths.usage, t.id),
          waiting: status === TicketStatus.Ready ? waitReasons(t, live, limits, config.maxSlots, projects, preflight, dependencyWaits(t, graph)) : [],
        })),
      };
    } catch (error) {
      boardError = mask(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    report: readReport(paths, now - REPORT_WINDOW_MS, now),
    board: board.name,
    boardError,
    workers: live.map((s) => ({ target: s.target, pid: s.pid, stage: s.stage, release: s.release })),
    limits: limits.map((l) => ({ agent: l.agent, until: stamp(l.until), message: mask(l.message) })),
    tickets,
    log: existsSync(paths.log) && statSync(paths.log).isFile() ? logTail(paths.log) : [],
    maxSlots: config.maxSlots,
    pollSeconds: config.pollSeconds,
  };
}
