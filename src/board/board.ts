import { TicketKind, TicketStatus } from "../enums.js";

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
}

// Where tickets come from and where the runner reports back. The runner, not the agent, moves tickets.
export interface Board {
  readonly name: string;
  // Tickets in this status, oldest first. Tickets the board cannot trust are left out.
  list(status: TicketStatus): Promise<Ticket[]>;
  setStatus(id: string, status: TicketStatus, note: string): Promise<void>;
  addNote(id: string, note: string): Promise<void>;
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
