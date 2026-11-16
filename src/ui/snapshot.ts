import { existsSync, readFileSync, statSync } from "node:fs";
import { Ticket } from "../board/board.js";
import { openBoard } from "../board/index.js";
import { Config } from "../config.js";
import { StateFile, TicketKind, TicketStatus } from "../enums.js";
import { mask } from "../log.js";
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
  NextDispatch = "next-dispatch",
}

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
}

export interface LimitView {
  agent: string;
  until: string;
  message: string;
}

export interface StatusSnapshot {
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
): WaitReason[] {
  const reasons: WaitReason[] = [];
  if (limits.length > 0) {
    reasons.push({ cause: WaitCause.UsageLimit, detail: `${limits.map((l) => l.agent).join(", ")} until ${stamp(Math.max(...limits.map((l) => l.until)))}` });
  }
  if (live.some((slot) => slot.release)) reasons.push({ cause: WaitCause.ReleaseRunning, detail: "" });
  if (ticket.kind === TicketKind.Release) {
    if (live.length > 0) reasons.push({ cause: WaitCause.ReleaseWaitsForIdle, detail: `${live.length}` });
  } else {
    if (!knownProjects.includes(ticket.project)) reasons.push({ cause: WaitCause.UnknownProject, detail: ticket.project });
    if (live.some((slot) => slot.key === projectSlotKey(ticket.project))) reasons.push({ cause: WaitCause.ProjectBusy, detail: ticket.project });
    if (live.length >= maxSlots) reasons.push({ cause: WaitCause.NoFreeSlot, detail: `${live.length}/${maxSlots}` });
  }
  return reasons.length > 0 ? reasons : [{ cause: WaitCause.NextDispatch, detail: "" }];
}

function logTail(file: string): string[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const tail = text.length > LOG_TAIL_BYTES ? text.slice(-LOG_TAIL_BYTES) : text;
  return tail.split("\n").filter((l) => l !== "").slice(-LOG_LINES).map(mask);
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
  for (const status of [TicketStatus.Working, TicketStatus.Ready, TicketStatus.Review, TicketStatus.Blocked]) {
    try {
      const list = await board.list(status);
      tickets[status] = {
        count: list.length,
        items: list.slice(0, LIST_LIMIT).map((t) => ({
          id: t.id,
          title: mask(t.title),
          project: t.project,
          status,
          stage: new TicketState(paths.results, t.id).firstLine(StateFile.Stage),
          waiting: status === TicketStatus.Ready ? waitReasons(t, live, limits, config.maxSlots, projects) : [],
        })),
      };
    } catch (error) {
      boardError = mask(error instanceof Error ? error.message : String(error));
    }
  }
  return {
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
