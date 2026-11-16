import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openAgent } from "./agent/index.js";
import { Ticket } from "./board/board.js";
import { openBoard } from "./board/index.js";
import { Config } from "./config.js";
import { CliCommand, SettleReason, StateFile, TicketKind, TicketStatus, WorkerMode } from "./enums.js";
import { messagesFor } from "./messages.js";
import { Logger } from "./log.js";
import { Runner, TicketPipeline } from "./pipeline.js";
import {
  SlotInfo,
  Slots,
  TicketState,
  acquireLock,
  projectSlotKey,
  releaseLock,
  releaseSlotKey,
  statePaths,
} from "./state.js";

export function openRunner(config: Config): Runner {
  const paths = statePaths(config.stateDir);
  return {
    config,
    paths,
    log: new Logger(paths.log),
    board: openBoard(config),
    builder: openAgent(config, config.builder, paths.sessions),
    reviewer: openAgent(config, config.reviewer, paths.sessions),
    slots: new Slots(paths.slots),
  };
}

export interface WorkerStart {
  mode: WorkerMode;
  key: string;
  target: string;
}

// Which workers to start: one per project, at most maxSlots at once, a release ticket only when nothing runs
// and then alone. Cut-off tickets come before new ones. Pure, so it is easy to test.
export function planDispatch(candidates: Ticket[], live: SlotInfo[], maxSlots: number): WorkerStart[] {
  if (live.some((slot) => slot.release)) return [];
  const starts: WorkerStart[] = [];
  const busy = new Set(live.map((slot) => slot.key));
  let count = live.length;
  for (const ticket of candidates) {
    if (ticket.kind === TicketKind.Release) {
      if (count > 0) continue;
      starts.push({ mode: WorkerMode.Release, key: releaseSlotKey(ticket.id), target: ticket.id });
      break;
    }
    const key = projectSlotKey(ticket.project);
    if (busy.has(key)) continue;
    if (count >= maxSlots) break;
    starts.push({ mode: WorkerMode.Project, key, target: ticket.project });
    busy.add(key);
    count += 1;
  }
  return starts;
}

// "working" tickets this runner started and that stopped mid-stage, once their cool-down is over.
export async function stuckTickets(r: Runner): Promise<Ticket[]> {
  const working = await r.board.list(TicketStatus.Working);
  return working.filter((ticket) => {
    const state = new TicketState(r.paths.results, ticket.id);
    return state.has(StateFile.Stage) && state.ageMinutes(StateFile.Failed) >= r.config.resumeCooldownMinutes;
  });
}

const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

function spawnWorker(r: Runner, key: string): number {
  const out = openSync(r.paths.log, "a");
  const child = spawn(process.execPath, [CLI_PATH, CliCommand.Work, key, "--root", r.config.root], {
    cwd: r.config.root,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return child.pid ?? 0;
}

export type WorkerSpawner = (r: Runner, key: string) => number;

export async function dispatch(r: Runner, spawner: WorkerSpawner = spawnWorker): Promise<WorkerStart[]> {
  if (!(await acquireLock(r.paths.dispatchLock, 24, 5_000))) {
    r.log.line("dispatch: lock still busy, skipping this round");
    return [];
  }
  try {
    const live = r.slots.live();
    const candidates = [...(await stuckTickets(r)), ...(await r.board.list(TicketStatus.Ready))];
    const starts = planDispatch(candidates, live, r.config.maxSlots);
    for (const start of starts) {
      if (!r.slots.tryCreate(start.key, start.target, start.mode === WorkerMode.Release)) continue;
      r.slots.setPid(start.key, spawner(r, start.key));
      r.log.line(`dispatch: ${start.mode} worker for ${start.target}`);
    }
    r.log.line(`dispatch: running=${live.length + starts.length} started=${starts.length}`);
    return starts;
  } finally {
    releaseLock(r.paths.dispatchLock);
  }
}

async function claim(r: Runner, tickets: Ticket[]): Promise<Ticket[]> {
  const claimed: Ticket[] = [];
  for (const ticket of tickets) {
    try {
      await r.board.setStatus(ticket.id, TicketStatus.Working, SettleReason.Claimed, messagesFor(r.config.language).claimed);
      claimed.push({ ...ticket, status: TicketStatus.Working });
    } catch (error) {
      r.log.line(`${ticket.id} could not claim: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return claimed;
}

async function runTicket(r: Runner, ticket: Ticket, key: string): Promise<void> {
  try {
    await new TicketPipeline(r, ticket, key).run();
  } catch (error) {
    r.log.line(`${ticket.id} stage error, will resume later: ${error instanceof Error ? error.message : String(error)}`);
    new TicketState(r.paths.results, ticket.id).touch(StateFile.Failed);
  }
}

// One worker: a project's cut-off tickets first, then its ready tickets in batches, oldest first.
// A release worker runs exactly its one ticket.
export async function work(r: Runner, key: string): Promise<void> {
  const target = r.slots.target(key);
  const release = key === releaseSlotKey(target);
  r.log.line(`work ${target}: start`);
  try {
    if (release) {
      const stuck = (await stuckTickets(r)).filter((t) => t.id === target);
      const ready = await claim(r, (await r.board.list(TicketStatus.Ready)).filter((t) => t.id === target));
      for (const ticket of [...stuck, ...ready]) await runTicket(r, ticket, key);
      return;
    }
    const mine = (t: Ticket): boolean => t.project === target && t.kind !== TicketKind.Release;
    for (const ticket of (await stuckTickets(r)).filter(mine)) await runTicket(r, ticket, key);
    for (let batch = 0; batch < r.config.maxBatches; batch += 1) {
      const ready = (await r.board.list(TicketStatus.Ready)).filter(mine);
      if (ready.length === 0) break;
      const claimed = await claim(r, ready);
      if (claimed.length === 0) break;
      r.log.line(`work ${target}: batch ${batch + 1}: ${claimed.map((t) => t.id).join(" ")}`);
      for (const ticket of claimed) await runTicket(r, ticket, key);
    }
  } finally {
    r.slots.remove(key);
    r.log.line(`work ${target}: done`);
  }
}
