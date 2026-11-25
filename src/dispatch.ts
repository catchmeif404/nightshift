import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openAgent } from "./agent/index.js";
import { Ticket, dependencyWaits, isBroken, loadDependencyGraph, orderByDependencies } from "./board/board.js";
import { openBoard } from "./board/index.js";
import { Config, hasProject, projectNamed } from "./config.js";
import { CliCommand, NotifyEvent, SettleReason, StateFile, TicketKind, TicketStatus, WorkerMode } from "./enums.js";
import { messagesFor } from "./messages.js";
import { PreflightMemory, Probe, checkPublish } from "./preflight.js";
import { run } from "./exec.js";
import { sendNotification, wants } from "./notify.js";
import { Logger, mask } from "./log.js";
import { Runner, TicketOutcome, TicketPipeline } from "./pipeline.js";
import { DailyReportOutcome, sendDailyReport } from "./report.js";
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

// Tickets whose predecessors are all done. The others stay as they are (ready); the reason is logged.
// With inBatch, a predecessor that is ready in the same list does not hold a ticket back here: it runs first
// (orderByDependencies), and the wait is checked again just before each ticket starts.
export async function awaitDependencies(r: Runner, tickets: Ticket[], inBatch = false): Promise<Ticket[]> {
  if (tickets.every((t) => t.dependsOn.length === 0)) return tickets;
  const say = messagesFor(r.config.language);
  const graph = await loadDependencyGraph(r.board, tickets);
  const inList = new Set(tickets.map((t) => t.id));
  const ok: Ticket[] = [];
  for (const ticket of tickets) {
    const waits = dependencyWaits(ticket, graph).filter((w) => !(inBatch && !isBroken(w) && inList.has(w.id) && graph.get(w.id)?.status === TicketStatus.Ready));
    if (waits.length === 0) ok.push(ticket);
    else r.log.line(`${ticket.id} waits: ${waits.map(say.dependencyWait).join("; ")}`);
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

// Tickets of projects that can publish. A project that cannot is not started and its tickets are left as they are;
// the reason is logged, and sent once (to notifyCommand and the chat notifier) until it is resolved.
export async function publishable(r: Runner, tickets: Ticket[], probe: Probe = run): Promise<Ticket[]> {
  const memory = new PreflightMemory(r.paths.preflight);
  const verdict = new Map<string, boolean>();
  for (const ticket of tickets) {
    if (ticket.kind === TicketKind.Release || verdict.has(ticket.project) || !hasProject(r.config, ticket.project)) continue;
    const result = await checkPublish(r.config, projectNamed(r.config, ticket.project), probe);
    verdict.set(ticket.project, result.ok);
    if (result.ok) {
      memory.clear(ticket.project);
      continue;
    }
    r.log.line(`dispatch: ${result.message}`);
    if (memory.record(ticket.project, result)) await announceBlocked(r, ticket.project, result.message);
  }
  return tickets.filter((t) => t.kind === TicketKind.Release || verdict.get(t.project) !== false);
}

// notifyCommand and the built-in notifier (blocked event); a failure is only logged.
async function announceBlocked(r: Runner, project: string, message: string): Promise<void> {
  const say = messagesFor(r.config.language);
  const text = `${say.preflightNotice(project)}\n${message}`;
  if (r.config.notifyCommand !== "") {
    const result = await run(r.config.notifyCommand, [mask(text)], r.config.root);
    if (result.code !== 0) r.log.line(`dispatch: notify failed: ${result.stderr.trim().slice(0, 200)}`);
  }
  if (wants(r.config.notify, NotifyEvent.Blocked)) {
    const failure = await sendNotification(r.config.notify, text);
    if (failure !== "") r.log.line(`dispatch: notify (${r.config.notify.service}) failed: ${failure}`);
  }
}

// The first dispatch after dailyReportAt sends the morning report. It never stops a dispatch.
async function morningReport(r: Runner): Promise<void> {
  try {
    const { outcome, failures } = await sendDailyReport(r.config, r.paths, Date.now());
    if (outcome === DailyReportOutcome.Sent) r.log.line("dispatch: morning report sent");
    for (const failure of failures) r.log.line(`dispatch: morning report failed: ${failure}`);
  } catch (error) {
    r.log.line(`dispatch: morning report failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function dispatch(r: Runner, spawner: WorkerSpawner = spawnWorker, probe: Probe = run): Promise<WorkerStart[]> {
  if (!(await acquireLock(r.paths.dispatchLock, 24, 5_000))) {
    r.log.line("dispatch: lock still busy, skipping this round");
    return [];
  }
  try {
    await morningReport(r);
    // While an agent's account is over its usage limit, start nothing: every run would be refused anyway.
    const limited = r.limits.active(Date.now());
    if (limited.length > 0) {
      const until = new Date(Math.max(...limited.map((l) => l.until))).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
      r.log.line(`dispatch: usage limit (${limited.map((l) => l.agent).join(", ")}) until ${until}, waiting`);
      return [];
    }
    const live = r.slots.live();
    const candidates = await publishable(r, [...(await stuckTickets(r)), ...(await awaitDependencies(r, await requireSections(r, await r.board.list(TicketStatus.Ready))))], probe);
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
      const ready = await claim(r, await awaitDependencies(r, await requireSections(r, (await r.board.list(TicketStatus.Ready)).filter((t) => t.id === target))));
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
      const ready = orderByDependencies(await awaitDependencies(r, await requireSections(r, (await r.board.list(TicketStatus.Ready)).filter(mine)), true));
      if (ready.length === 0) break;
      r.log.line(`work ${target}: batch ${batch + 1}: ${ready.map((t) => t.id).join(" ")}`);
      // Claim each ticket just before it runs, so a stop (usage limit) never leaves claimed tickets nobody works on.
      let ran = 0;
      for (const ticket of ready) {
        // A predecessor from this batch must be done by now, not only have run.
        if ((await awaitDependencies(r, [ticket])).length === 0) continue;
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
