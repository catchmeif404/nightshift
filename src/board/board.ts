import { SettleReason, TicketKind, TicketStatus } from "../enums.js";

export interface Ticket {
  id: string;
  title: string;
  body: string;
  // The project name in the config: which repo to work in.
  project: string;
  kind: TicketKind;
  status: TicketStatus;
  // ISO time; tickets are worked oldest first.
  createdAt: string;
  // Ids of the tickets that must be done (merged, or closed by a person) before this one starts.
  dependsOn: string[];
}

// Where tickets come from and where the runner reports back. The runner, not the agent, moves tickets.
export interface Board {
  readonly name: string;
  // Tickets in this status, oldest first. Tickets the board cannot trust are left out.
  list(status: TicketStatus): Promise<Ticket[]>;
  setStatus(id: string, status: TicketStatus, reason: SettleReason, note: string): Promise<void>;
  addNote(id: string, note: string): Promise<void>;
  // The tickets with these ids in any status (done ones too). An id the board does not know is left out.
  find(ids: string[]): Promise<Ticket[]>;
}

// Boards that can only list by status: look the ids up in every status.
export async function findByListing(board: Pick<Board, "list">, ids: string[]): Promise<Ticket[]> {
  const wanted = new Set(ids);
  const found: Ticket[] = [];
  for (const status of Object.values(TicketStatus)) {
    found.push(...(await board.list(status)).filter((t) => wanted.has(t.id)));
  }
  return found;
}

// "t-1, t-2" -> ["t-1", "t-2"]; blanks and repeats dropped.
export function splitIds(value: string): string[] {
  return value.split(",").map((v) => v.trim()).filter((v, i, all) => v !== "" && all.indexOf(v) === i);
}

export enum DependencyWaitCause {
  // The id is not on the board.
  Missing = "missing",
  Self = "self",
  // Part of a loop of tickets that wait for each other.
  Cycle = "cycle",
  // The ticket is blocked: it keeps waiting until a person unblocks and finishes it.
  Blocked = "blocked",
  // Not done yet (ready, working or in review).
  Pending = "pending",
}

export interface DependencyWait {
  cause: DependencyWaitCause;
  // The id of the ticket waited for.
  id: string;
}

// Tickets by id: the ones to judge and everything they depend on, however far back.
export type DependencyGraph = Map<string, Ticket>;

const MAX_GRAPH_ROUNDS = 20;

export async function loadDependencyGraph(board: Board, tickets: Ticket[]): Promise<DependencyGraph> {
  const graph: DependencyGraph = new Map(tickets.map((t) => [t.id, t]));
  const asked = new Set<string>();
  for (let round = 0; round < MAX_GRAPH_ROUNDS; round += 1) {
    const missing = [...graph.values()].flatMap((t) => t.dependsOn).filter((id) => !graph.has(id) && !asked.has(id));
    const unique = missing.filter((id, i) => missing.indexOf(id) === i);
    if (unique.length === 0) break;
    for (const id of unique) asked.add(id);
    for (const found of await board.find(unique)) graph.set(found.id, found);
  }
  return graph;
}

function reaches(graph: DependencyGraph, from: string, target: string): boolean {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.pop() ?? "";
    for (const next of graph.get(id)?.dependsOn ?? []) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

// What a ticket still waits for. Empty: every ticket it depends on is done, so it may start. Pure.
export function dependencyWaits(ticket: Ticket, graph: DependencyGraph): DependencyWait[] {
  const waits: DependencyWait[] = [];
  for (const id of ticket.dependsOn) {
    const dep = graph.get(id);
    if (id === ticket.id) waits.push({ cause: DependencyWaitCause.Self, id });
    else if (dep === undefined) waits.push({ cause: DependencyWaitCause.Missing, id });
    else if (dep.status === TicketStatus.Done) continue;
    else if (reaches(graph, id, ticket.id) || reaches(graph, id, id)) waits.push({ cause: DependencyWaitCause.Cycle, id });
    else waits.push({ cause: dep.status === TicketStatus.Blocked ? DependencyWaitCause.Blocked : DependencyWaitCause.Pending, id });
  }
  return waits;
}

// Never starts: no wait on a ticket that is just not done yet can ever be cleared by waiting alone.
export function isBroken(wait: DependencyWait): boolean {
  return wait.cause === DependencyWaitCause.Missing || wait.cause === DependencyWaitCause.Self || wait.cause === DependencyWaitCause.Cycle;
}

// Tickets with the ones they depend on first (among the given tickets), otherwise in the given order.
export function orderByDependencies(tickets: Ticket[]): Ticket[] {
  const ids = new Set(tickets.map((t) => t.id));
  const ordered: Ticket[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (ticket: Ticket): void => {
    if (placed.has(ticket.id) || visiting.has(ticket.id)) return;
    visiting.add(ticket.id);
    for (const id of ticket.dependsOn) {
      const dep = tickets.find((t) => t.id === id);
      if (dep !== undefined && ids.has(id)) place(dep);
    }
    visiting.delete(ticket.id);
    placed.add(ticket.id);
    ordered.push(ticket);
  };
  for (const ticket of tickets) place(ticket);
  return ordered;
}

export function oldestFirst(a: Ticket, b: Ticket): number {
  return a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);
}

export function kindFrom(value: string): TicketKind {
  return Object.values(TicketKind).find((k) => k === value) ?? TicketKind.Build;
}

export function isTicketStatus(value: string): value is TicketStatus {
  return Object.values(TicketStatus).some((s) => s === value);
}
