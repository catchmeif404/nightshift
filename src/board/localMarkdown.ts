import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { TicketKind, TicketStatus } from "../enums.js";
import { Board, Ticket, isTicketStatus, kindFrom, oldestFirst } from "./board.js";

enum Field {
  Title = "title",
  Project = "project",
  Kind = "kind",
  Status = "status",
  Created = "created",
}

const FENCE = "---";
const NOTES_HEADING = "## Notes";
const EXTENSION = ".md";

interface ParsedFile {
  fields: Map<string, string>;
  body: string;
}

export function parseTicketFile(text: string): ParsedFile {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const fields = new Map<string, string>();
  if (lines[0] !== FENCE) return { fields, body: text };
  let end = 1;
  for (; end < lines.length && lines[end] !== FENCE; end += 1) {
    const line = lines[end] ?? "";
    const colon = line.indexOf(":");
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { fields, body: lines.slice(end + 1).join("\n").trim() };
}

export function renderTicketFile(fields: Map<string, string>, body: string): string {
  const head = [...fields.entries()].map(([k, v]) => `${k}: ${v}`);
  return [FENCE, ...head, FENCE, "", body.trim(), ""].join("\n");
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 16);
}

// Tickets as markdown files in one folder: front matter for the fields, the body for the ask,
// and a "## Notes" section the runner appends to. The file name (without .md) is the ticket id.
export class LocalMarkdownBoard implements Board {
  readonly name = "local markdown";

  constructor(private readonly dir: string) {}

  private pathOf(id: string): string {
    return join(this.dir, `${id}${EXTENSION}`);
  }

  private read(id: string): ParsedFile {
    return parseTicketFile(readFileSync(this.pathOf(id), "utf8"));
  }

  private write(id: string, file: ParsedFile): void {
    const target = this.pathOf(id);
    const temp = `${target}.tmp-${process.pid}`;
    writeFileSync(temp, renderTicketFile(file.fields, file.body));
    renameSync(temp, target);
  }

  // A file without a known status, a title or a project is not a ticket: none comes back.
  private toTickets(id: string, file: ParsedFile): Ticket[] {
    const status = file.fields.get(Field.Status) ?? "";
    const title = file.fields.get(Field.Title) ?? "";
    const project = file.fields.get(Field.Project) ?? "";
    if (!isTicketStatus(status) || title === "" || project === "") return [];
    const notesAt = file.body.indexOf(NOTES_HEADING);
    return [{
      id,
      title,
      body: (notesAt >= 0 ? file.body.slice(0, notesAt) : file.body).trim(),
      project,
      kind: kindFrom(file.fields.get(Field.Kind) ?? TicketKind.Build),
      status,
      createdAt: file.fields.get(Field.Created) ?? "",
    }];
  }

  async list(status: TicketStatus): Promise<Ticket[]> {
    if (!existsSync(this.dir)) return [];
    const tickets: Ticket[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(EXTENSION)) continue;
      const id = basename(name, EXTENSION);
      tickets.push(...this.toTickets(id, this.read(id)).filter((t) => t.status === status));
    }
    return tickets.sort(oldestFirst);
  }

  async setStatus(id: string, status: TicketStatus, note: string): Promise<void> {
    const file = this.read(id);
    file.fields.set(Field.Status, status);
    this.write(id, file);
    if (note !== "") await this.addNote(id, note);
  }

  async addNote(id: string, note: string): Promise<void> {
    const file = this.read(id);
    const heading = file.body.includes(NOTES_HEADING) ? "" : `\n\n${NOTES_HEADING}\n`;
    file.body = `${file.body}${heading}\n- ${timestamp()} ${note.replace(/\n+/g, " ")}`;
    this.write(id, file);
  }

  // Next free T-n id. Used by the "add" command.
  create(title: string, project: string, kind: TicketKind, body: string): string {
    mkdirSync(this.dir, { recursive: true });
    const used = existsSync(this.dir)
      ? readdirSync(this.dir)
          .map((n) => /^T-(\d+)\.md$/.exec(n)?.[1] ?? "0")
          .map((n) => Number.parseInt(n, 10))
      : [];
    const id = `T-${Math.max(0, ...used) + 1}`;
    const fields = new Map<string, string>([
      [Field.Title, title],
      [Field.Project, project],
      [Field.Kind, kind],
      [Field.Status, TicketStatus.Ready],
      [Field.Created, new Date().toISOString()],
    ]);
    this.write(id, { fields, body });
    return id;
  }
}
