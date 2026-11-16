import { SettleReason, TicketStatus } from "../enums.js";
import { exec } from "../exec.js";
import { Board, Ticket, kindFrom, oldestFirst } from "./board.js";

export enum BoardCall {
  List = "list",
  SetStatus = "set-status",
  Note = "note",
}

export class CommandBoardError extends Error {}

function field(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

// Any tracker, through one executable that speaks this protocol (exit 0 on success):
//   <command> list <status>                       -> prints a JSON array of tickets in that status:
//                                                    [{"id","title","body","project","kind","createdAt"}]
//   <command> set-status <id> <status> <reason>   note on stdin (may be empty)
//   <command> note <id>                           note on stdin
// Statuses and reasons are the runner's own words (ready, working, ... / needs-human, merged, ...);
// the command maps them to its tracker. Tickets it does not want run, it simply does not list.
export class CommandBoard implements Board {
  readonly name: string;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
  ) {
    this.name = `command (${command})`;
  }

  private async call(args: string[], input: string): Promise<string> {
    const result = await exec(this.command, args, { cwd: this.cwd, env: process.env, input });
    if (result.code !== 0) {
      throw new CommandBoardError(`${args[0] ?? ""} exited ${result.code}: ${result.stderr.trim().slice(0, 500)}`);
    }
    return result.stdout;
  }

  async list(status: TicketStatus): Promise<Ticket[]> {
    const parsed: unknown = JSON.parse((await this.call([BoardCall.List, status], "")) || "[]");
    if (!Array.isArray(parsed)) throw new CommandBoardError("list must print a JSON array");
    const tickets: Ticket[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      const ticket: Ticket = {
        id: field(o, "id"),
        title: field(o, "title"),
        body: field(o, "body"),
        project: field(o, "project"),
        kind: kindFrom(field(o, "kind")),
        status,
        createdAt: field(o, "createdAt"),
      };
      if (ticket.id !== "" && ticket.project !== "") tickets.push(ticket);
    }
    return tickets.sort(oldestFirst);
  }

  async setStatus(id: string, status: TicketStatus, reason: SettleReason, note: string): Promise<void> {
    await this.call([BoardCall.SetStatus, id, status, reason], note);
  }

  async addNote(id: string, note: string): Promise<void> {
    await this.call([BoardCall.Note, id], note);
  }
}
