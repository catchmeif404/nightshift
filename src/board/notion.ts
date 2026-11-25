import { existsSync, readFileSync } from "node:fs";
import { SettleReason, TicketKind, TicketStatus } from "../enums.js";
import { Board, Ticket, findByListing, oldestFirst } from "./board.js";

export interface NotionProperties {
  // Property names in the database. Empty: not used.
  title: string;
  status: string;
  project: string;
  kind: string;
  body: string;
  notes: string;
  id: string;
}

export interface NotionBoardConfig {
  databaseId: string;
  tokenEnv: string;
  tokenFile: string;
  apiUrl: string;
  properties: NotionProperties;
  // The option name in the status property for each runner status.
  statuses: Record<TicketStatus, string>;
  // The value of the kind property that makes a release ticket.
  releaseKind: string;
  // Only pages where this property equals this value are tickets (e.g. an "Assignee" select = "nightshift").
  filterProperty: string;
  filterEquals: string;
}

export const NOTION_VERSION = "2022-06-28";
const TEXT_LIMIT = 2000;
const MAX_TEXT_OBJECTS = 100;

enum PropertyType {
  Title = "title",
  RichText = "rich_text",
  Status = "status",
  Select = "select",
  MultiSelect = "multi_select",
  Relation = "relation",
  UniqueId = "unique_id",
  Checkbox = "checkbox",
}

type Json = Record<string, unknown>;

const NO_BODY = Symbol("no request body");

export class NotionError extends Error {}

function obj(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function plain(richText: unknown): string {
  return list(richText).map((t) => str(obj(t).plain_text)).join("");
}

export function chunks(text: string): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < text.length && out.length < MAX_TEXT_OBJECTS; i += TEXT_LIMIT) {
    out.push({ type: "text", text: { content: text.slice(i, i + TEXT_LIMIT) } });
  }
  return out;
}

// Any Notion database as the board: one page per ticket, a status property for the runner's statuses,
// and a property that names the project. Notes go to a text property or, by default, the page's comments.
export class NotionBoard implements Board {
  readonly name: string;
  private schema: Map<string, PropertyType> = new Map();
  private titles: Map<string, string> = new Map();

  constructor(private readonly cfg: NotionBoardConfig) {
    this.name = `Notion database ${cfg.databaseId}`;
  }

  private token(): string {
    const fromEnv = this.cfg.tokenEnv === "" ? "" : (process.env[this.cfg.tokenEnv] ?? "");
    if (fromEnv !== "") return fromEnv.trim();
    if (this.cfg.tokenFile !== "" && existsSync(this.cfg.tokenFile)) return readFileSync(this.cfg.tokenFile, "utf8").trim();
    throw new NotionError(`no Notion token: set ${this.cfg.tokenEnv || "board.notion.tokenEnv"} or board.notion.tokenFile`);
  }

  private async call(method: string, path: string, body: Json | typeof NO_BODY): Promise<Json> {
    const response = await fetch(`${this.cfg.apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token()}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      ...(body === NO_BODY ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new NotionError(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
    return obj(text === "" ? {} : JSON.parse(text));
  }

  private async types(): Promise<Map<string, PropertyType>> {
    if (this.schema.size > 0) return this.schema;
    const db = await this.call("GET", `/databases/${this.cfg.databaseId}`, NO_BODY);
    for (const [name, prop] of Object.entries(obj(db.properties))) {
      const type = Object.values(PropertyType).find((t) => t === str(obj(prop).type));
      if (type !== undefined) this.schema.set(name, type);
    }
    for (const required of [this.cfg.properties.title, this.cfg.properties.status, this.cfg.properties.project]) {
      if (!this.schema.has(required)) throw new NotionError(`the database has no property "${required}"`);
    }
    return this.schema;
  }

  private async typeOf(name: string): Promise<PropertyType> {
    const type = (await this.types()).get(name);
    if (type === undefined) throw new NotionError(`the database has no supported property "${name}"`);
    return type;
  }

  private async equalsFilter(property: string, value: string): Promise<Json> {
    const type = await this.typeOf(property);
    switch (type) {
      case PropertyType.Status:
      case PropertyType.Select:
        return { property, [type]: { equals: value } };
      case PropertyType.MultiSelect:
        return { property, multi_select: { contains: value } };
      case PropertyType.Checkbox:
        return { property, checkbox: { equals: value === "true" } };
      default:
        return { property, [type]: { equals: value } };
    }
  }

  private async relationTitle(pageId: string): Promise<string> {
    const cached = this.titles.get(pageId);
    if (cached !== undefined) return cached;
    const page = await this.call("GET", `/pages/${pageId}`, NO_BODY);
    const title = Object.values(obj(page.properties))
      .map(obj)
      .filter((p) => p.type === PropertyType.Title)
      .map((p) => plain(p.title))
      .join("");
    this.titles.set(pageId, title);
    return title;
  }

  private async valueOf(page: Json, property: string): Promise<string> {
    if (property === "") return "";
    const prop = obj(obj(page.properties)[property]);
    switch (str(prop.type)) {
      case PropertyType.Title:
        return plain(prop.title);
      case PropertyType.RichText:
        return plain(prop.rich_text);
      case PropertyType.Status:
      case PropertyType.Select:
        return str(obj(prop[str(prop.type)]).name);
      case PropertyType.MultiSelect:
        return str(obj(list(prop.multi_select)[0]).name);
      case PropertyType.Relation: {
        const first = str(obj(list(prop.relation)[0]).id);
        return first === "" ? "" : this.relationTitle(first);
      }
      case PropertyType.UniqueId: {
        const id = obj(prop.unique_id);
        const prefix = str(id.prefix);
        return prefix === "" ? String(id.number) : `${prefix}-${String(id.number)}`;
      }
      default:
        return "";
    }
  }

  private async pageText(pageId: string): Promise<string> {
    const children = await this.call("GET", `/blocks/${pageId}/children?page_size=100`, NO_BODY);
    return list(children.results)
      .map((block) => {
        const b = obj(block);
        return plain(obj(b[str(b.type)]).rich_text);
      })
      .filter((line) => line !== "")
      .join("\n");
  }

  private async toTicket(page: Json, status: TicketStatus): Promise<Ticket> {
    const p = this.cfg.properties;
    const pageId = str(page.id).replace(/-/g, "");
    const id = p.id === "" ? pageId : await this.valueOf(page, p.id);
    const body = p.body === "" ? await this.pageText(str(page.id)) : await this.valueOf(page, p.body);
    return {
      id,
      title: await this.valueOf(page, p.title),
      body: `${body}\n\nNotion: ${str(page.url)}`.trim(),
      project: await this.valueOf(page, p.project),
      kind: p.kind !== "" && (await this.valueOf(page, p.kind)) === this.cfg.releaseKind ? TicketKind.Release : TicketKind.Build,
      status,
      createdAt: str(page.created_time),
      dependsOn: [],
    };
  }

  private async query(filters: Json[]): Promise<Json[]> {
    const pages: Json[] = [];
    let cursor = "";
    do {
      const body: Json = {
        filter: filters.length === 1 ? filters[0] : { and: filters },
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        page_size: 100,
        ...(cursor === "" ? {} : { start_cursor: cursor }),
      };
      const result = await this.call("POST", `/databases/${this.cfg.databaseId}/query`, body);
      pages.push(...list(result.results).map(obj));
      cursor = result.has_more === true ? str(result.next_cursor) : "";
    } while (cursor !== "");
    return pages;
  }

  async list(status: TicketStatus): Promise<Ticket[]> {
    const filters = [await this.equalsFilter(this.cfg.properties.status, this.cfg.statuses[status])];
    if (this.cfg.filterProperty !== "") filters.push(await this.equalsFilter(this.cfg.filterProperty, this.cfg.filterEquals));
    const tickets: Ticket[] = [];
    for (const page of await this.query(filters)) {
      const ticket = await this.toTicket(page, status);
      if (ticket.id !== "" && ticket.project !== "") tickets.push(ticket);
    }
    return tickets.sort(oldestFirst);
  }

  // A ticket id is the page id, or the value of the unique ID property when one is configured.
  private async pageId(id: string): Promise<string> {
    if (this.cfg.properties.id === "") return id;
    const number = Number.parseInt(id.slice(id.lastIndexOf("-") + 1), 10);
    const found = await this.query([{ property: this.cfg.properties.id, unique_id: { equals: number } }]);
    const page = found[0];
    if (page === undefined) throw new NotionError(`no page with ${this.cfg.properties.id} ${id}`);
    return str(page.id);
  }

  find(ids: string[]): Promise<Ticket[]> {
    return findByListing(this, ids);
  }

  async setStatus(id: string, status: TicketStatus, _reason: SettleReason, note: string): Promise<void> {
    const pageId = await this.pageId(id);
    const property = this.cfg.properties.status;
    const type = await this.typeOf(property);
    await this.call("PATCH", `/pages/${pageId}`, { properties: { [property]: { [type]: { name: this.cfg.statuses[status] } } } });
    if (note !== "") await this.note(pageId, note);
  }

  async addNote(id: string, note: string): Promise<void> {
    await this.note(await this.pageId(id), note);
  }

  private async note(pageId: string, note: string): Promise<void> {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    const line = `[${stamp}] ${note}`;
    const property = this.cfg.properties.notes;
    if (property === "") {
      await this.call("POST", "/comments", { parent: { page_id: pageId }, rich_text: chunks(line) });
      return;
    }
    const page = await this.call("GET", `/pages/${pageId}`, NO_BODY);
    const before = await this.valueOf(page, property);
    const text = before === "" ? line : `${before}\n${line}`;
    await this.call("PATCH", `/pages/${pageId}`, { properties: { [property]: { rich_text: chunks(text.slice(-TEXT_LIMIT * 50)) } } });
  }
}
