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
import { Runner, TicketOutcome, TicketPipeline } from "./pipeline.js";
import {
  SlotInfo,
  Slots,
  TicketState,
  UsageLimits,
  acquireLock,
  projectSlotKey,
  releaseLock,
  releaseSlotKey,
  statePaths,
} from "./state.js";

const COLON = "[:：]";

// Labels from `labels` that have no "Label: text" line in the ticket body (text after the colon; full-width colon allowed).
export function missingSections(body: string, labels: string[]): string[] {
  const lines = body.split(/\r?\n/).map((l) => l.replace(/^[\s>*+#-]+/, "").replace(/\*\*|__/g, ""));
  return labels.filter((label) => {
    const head = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*${COLON}\\s*(.*)$`, "i");
    return !lines.some((line) => (head.exec(line)?.[1] ?? "").trim() !== "");
  });
}

// An empty form for `add`: one "Label:" line per configured section.
export function sectionsTemplate(labels: string[]): string {
  return labels.map((l) => `${l}:`).join("\n\n");
}

// Tickets that pass the ticketSections check; the others move to blocked with a note naming what is missing.
export async function requireSections(r: Runner, tickets: Ticket[]): Promise<Ticket[]> {
  const labels = r.config.ticketSections;
  if (labels.length === 0) return tickets;
  const ok: Ticket[] = [];
  for (const ticket of tickets) {
    const missing = ticket.kind === TicketKind.Release ? [] : missingSections(ticket.body, labels);
    if (missing.length === 0) {
      ok.push(ticket);
      continue;
    }
    try {
      await r.board.setStatus(ticket.id, TicketStatus.Blocked, SettleReason.Blocked, messagesFor(r.config.language).missingSections(missing));
      r.log.line(`${ticket.id} blocked: missing sections ${missing.join(", ")}`);
    } catch (error) {
      r.log.line(`${ticket.id} could not be blocked: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return ok;
}

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
    limits: new UsageLimits(paths.limits),
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
    // While an agent's account is over its usage limit, start nothing: every run would be refused anyway.
    const limited = r.limits.active(Date.now());
    if (limited.length > 0) {
      const until = new Date(Math.max(...limited.map((l) => l.until))).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
      r.log.line(`dispatch: usage limit (${limited.map((l) => l.agent).join(", ")}) until ${until}, waiting`);
      return [];
    }
    const live = r.slots.live();
    const candidates = [...(await stuckTickets(r)), ...(await requireSections(r, await r.board.list(TicketStatus.Ready)))];
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

async function runTicket(r: Runner, ticket: Ticket, key: string): Promise<TicketOutcome> {
  try {
    return await new TicketPipeline(r, ticket, key).run();
  } catch (error) {
    r.log.line(`${ticket.id} stage error, will resume later: ${error instanceof Error ? error.message : String(error)}`);
    new TicketState(r.paths.results, ticket.id).touch(StateFile.Failed);
    return TicketOutcome.Paused;
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
      const ready = await claim(r, await requireSections(r, (await r.board.list(TicketStatus.Ready)).filter((t) => t.id === target)));
      for (const ticket of [...stuck, ...ready]) {
        if ((await runTicket(r, ticket, key)) === TicketOutcome.Limited) return;
      }
      return;
    }
    const mine = (t: Ticket): boolean => t.project === target && t.kind !== TicketKind.Release;
    // A usage limit stops this worker: the next tickets would hit the same limit. Dispatch resumes after the reset.
    for (const ticket of (await stuckTickets(r)).filter(mine)) {
      if ((await runTicket(r, ticket, key)) === TicketOutcome.Limited) return;
    }
    for (let batch = 0; batch < r.config.maxBatches; batch += 1) {
      const ready = await requireSections(r, (await r.board.list(TicketStatus.Ready)).filter(mine));
      if (ready.length === 0) break;
      r.log.line(`work ${target}: batch ${batch + 1}: ${ready.map((t) => t.id).join(" ")}`);
      // Claim each ticket just before it runs, so a stop (usage limit) never leaves claimed tickets nobody works on.
      let ran = 0;
      for (const ticket of ready) {
        const claimed = (await claim(r, [ticket]))[0];
        if (claimed === undefined) continue;
        ran += 1;
        if ((await runTicket(r, claimed, key)) === TicketOutcome.Limited) return;
      }
      if (ran === 0) break;
    }
  } finally {
    r.slots.remove(key);
    r.log.line(`work ${target}: done`);
  }
}
