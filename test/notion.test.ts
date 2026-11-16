import assert from "node:assert/strict";
import { IncomingMessage, Server, ServerResponse, createServer } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { NotionBoard, NotionBoardConfig } from "../src/board/notion.js";
import { parseConfig } from "../src/config.js";
import { SettleReason, TicketKind, TicketStatus } from "../src/enums.js";

type Json = Record<string, unknown>;

// A tiny in-memory stand-in for the parts of the Notion API the board uses.
const schema = {
  Name: { type: "title" },
  Status: { type: "status" },
  Project: { type: "relation" },
  Kind: { type: "select" },
  ID: { type: "unique_id" },
  Notes: { type: "rich_text" },
  Assignee: { type: "select" },
};

const rt = (text: string): Json[] => (text === "" ? [] : [{ plain_text: text }]);

interface FakePage {
  id: string;
  number: number;
  name: string;
  status: string;
  kind: string;
  assignee: string;
  notes: string;
  created: string;
}

let pages: FakePage[] = [];
const comments: Array<{ page: string; text: string }> = [];
const auth: string[] = [];

function pageJson(p: FakePage): Json {
  return {
    id: p.id,
    url: `https://notion.so/${p.id}`,
    created_time: p.created,
    properties: {
      Name: { type: "title", title: rt(p.name) },
      Status: { type: "status", status: { name: p.status } },
      Project: { type: "relation", relation: [{ id: "proj-1" }] },
      Kind: { type: "select", select: p.kind === "" ? null : { name: p.kind } },
      ID: { type: "unique_id", unique_id: { prefix: "TK", number: p.number } },
      Notes: { type: "rich_text", rich_text: rt(p.notes) },
      Assignee: { type: "select", select: { name: p.assignee } },
    },
  };
}

function matches(p: FakePage, filter: Json): boolean {
  if (Array.isArray(filter.and)) return filter.and.every((f) => matches(p, f as Json));
  const value = (key: string): string => ((filter[key] as Json).equals as string | number).toString();
  if (filter.property === "Status") return p.status === value("status");
  if (filter.property === "Assignee") return p.assignee === value("select");
  if (filter.property === "ID") return String(p.number) === value("unique_id");
  return false;
}

function handle(req: IncomingMessage, body: Json): [number, Json] {
  auth.push(req.headers.authorization ?? "");
  const url = req.url ?? "";
  if (req.method === "GET" && url === "/databases/db1") return [200, { properties: schema }];
  if (req.method === "POST" && url === "/databases/db1/query") {
    return [200, { results: pages.filter((p) => matches(p, body.filter as Json)).map(pageJson), has_more: false }];
  }
  if (req.method === "GET" && url === "/pages/proj-1") return [200, { properties: { Name: { type: "title", title: rt("figdex") } } }];
  const page = pages.find((p) => url.includes(p.id));
  if (req.method === "GET" && url.startsWith("/blocks/") && page) {
    return [200, { results: [{ type: "paragraph", paragraph: { rich_text: rt(`Do ${page.name}.`) } }, { type: "divider", divider: {} }] }];
  }
  if (req.method === "GET" && url.startsWith("/pages/") && page) return [200, pageJson(page)];
  if (req.method === "PATCH" && url.startsWith("/pages/") && page) {
    const props = body.properties as Json;
    if (props.Status) page.status = ((props.Status as Json).status as Json).name as string;
    if (props.Notes) page.notes = ((props.Notes as Json).rich_text as Json[]).map((t) => (t.text as Json).content).join("");
    return [200, pageJson(page)];
  }
  if (req.method === "POST" && url === "/comments") {
    comments.push({ page: (body.parent as Json).page_id as string, text: ((body.rich_text as Json[])[0]?.text as Json).content as string });
    return [200, {}];
  }
  return [404, { message: `no route ${req.method} ${url}` }];
}

let server: Server;
let apiUrl = "";

before(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const [code, out] = handle(req, raw === "" ? {} : (JSON.parse(raw) as Json));
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

function reset(): void {
  pages = [
    { id: "page-7", number: 7, name: "add sorting", status: "Ready", kind: "", assignee: "nightshift", notes: "", created: "2026-11-02" },
    { id: "page-8", number: 8, name: "ship 1.2", status: "Ready", kind: "Release", assignee: "nightshift", notes: "", created: "2026-11-01" },
    { id: "page-9", number: 9, name: "not ours", status: "Ready", kind: "", assignee: "someone", notes: "", created: "2026-10-01" },
  ];
  comments.length = 0;
}

function board(extra: Json): NotionBoard {
  process.env.TEST_NOTION_TOKEN = "secret-test-token";
  const config = parseConfig(
    { board: { type: "notion", notion: { databaseId: "db1", apiUrl, tokenEnv: "TEST_NOTION_TOKEN", filter: { property: "Assignee", equals: "nightshift" }, ...extra } } },
    "/work",
  );
  return new NotionBoard(config.board.notion as NotionBoardConfig);
}

test("Notion pages become tickets: filtered, oldest first, with id, project, kind and body", async () => {
  reset();
  const tickets = await board({ properties: { kind: "Kind", id: "ID" } }).list(TicketStatus.Ready);
  assert.deepEqual(tickets.map((t) => t.id), ["TK-8", "TK-7"]);
  assert.equal(tickets[1]?.project, "figdex");
  assert.equal(tickets[0]?.kind, TicketKind.Release);
  assert.equal(tickets[1]?.kind, TicketKind.Build);
  assert.match(tickets[1]?.body ?? "", /^Do add sorting\.\n\nNotion: https:\/\/notion\.so\/page-7$/);
  assert.ok(auth.every((a) => a === "Bearer secret-test-token"));
});

test("moving a ticket sets the status option and writes the note to the notes property or a comment", async () => {
  reset();
  const withNotes = board({ properties: { id: "ID", notes: "Notes" }, statuses: { working: "Doing" } });
  await withNotes.setStatus("TK-7", TicketStatus.Working, SettleReason.Claimed, "picked up");
  await withNotes.addNote("TK-7", "still working");
  const page = pages.find((p) => p.number === 7);
  assert.equal(page?.status, "Doing");
  assert.match(page?.notes ?? "", /^\[.+\] picked up\n\[.+\] still working$/);

  const withComments = board({});
  await withComments.setStatus("page-8", TicketStatus.Done, SettleReason.Merged, "merged");
  assert.equal(pages.find((p) => p.number === 8)?.status, "Done");
  assert.equal(comments[0]?.page, "page-8");
  assert.match(comments[0]?.text ?? "", /merged$/);
});

test("a database without the configured properties is a clear error", async () => {
  reset();
  await assert.rejects(board({ properties: { status: "State" } }).list(TicketStatus.Ready), /no property "State"/);
});
