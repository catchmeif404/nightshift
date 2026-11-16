import assert from "node:assert/strict";
import { IncomingMessage, Server, ServerResponse, createServer } from "node:http";
import { AddressInfo } from "node:net";
import { test } from "node:test";
import { doctorChecks } from "../src/commands.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { CheckLevel, NotifyEvent, NotifyService, PublishMode, TicketStatus } from "../src/enums.js";
import { TicketOutcome, TicketPipeline } from "../src/pipeline.js";
import { Sandbox, readyTicket, sandbox, ticketStatus } from "./helpers.js";

interface Seen {
  url: string;
  body: string;
}

interface FakeService {
  base: string;
  seen: Seen[];
  close(): Promise<void>;
}

async function fakeService(status = 200): Promise<FakeService> {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body });
      res.statusCode = status;
      res.end("{}");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

async function runPipeline(box: Sandbox, id: string): Promise<TicketOutcome> {
  const ticket = (await box.board.list(TicketStatus.Working)).find((t) => t.id === id);
  assert.ok(ticket);
  return new TicketPipeline(box.runner, ticket, "slot-test").run();
}

const TOKEN_ENV = "TEST_NS_TG_TOKEN";
const HOOK_ENV = "TEST_NS_HOOK_URL";

test("notify is off by default and validates its settings", () => {
  assert.equal(parseConfig({ projects: {} }, "/w").notify.service, NotifyService.None);
  assert.deepEqual(parseConfig({ projects: {} }, "/w").notify.events, Object.values(NotifyEvent));
  assert.throws(() => parseConfig({ projects: {}, notify: { service: "sms" } }, "/w"), ConfigError);
  assert.throws(() => parseConfig({ projects: {}, notify: { service: "telegram" } }, "/w"), /chatId/);
  assert.throws(() => parseConfig({ projects: {}, notify: { service: "slack", events: ["done"] } }, "/w"), /unknown event/);
  assert.throws(() => parseConfig({ projects: {}, notify: { service: "slack", webhookUrlEnv: "" } }, "/w"), ConfigError);
});

test("telegram: bot API request, English text, PR link, token only from the environment", async () => {
  const svc = await fakeService();
  process.env[TOKEN_ENV] = "123:SECRET";
  try {
    const box = sandbox(
      { notify: { service: "telegram", botTokenEnv: TOKEN_ENV, chatId: "42", apiUrl: svc.base } },
      PublishMode.PullRequest,
    );
    const id = await readyTicket(box, "Touch work");
    box.plan(["BUILD_PR", "REVIEW PASS"]);
    await runPipeline(box, id);
    assert.equal(svc.seen.length, 1);
    assert.equal(svc.seen[0]?.url, "/bot123:SECRET/sendMessage");
    const body = JSON.parse(svc.seen[0]?.body ?? "{}") as { chat_id: string; text: string };
    assert.equal(body.chat_id, "42");
    assert.match(body.text, /^.+ Touch work: ready for your review\nhttps:\/\/example\.com\/pr\/\d+$/);
  } finally {
    delete process.env[TOKEN_ENV];
    await svc.close();
  }
});

test("slack and discord: webhook bodies, Korean text, blocked event", async () => {
  for (const [service, field] of [[NotifyService.Slack, "text"], [NotifyService.Discord, "content"]] as const) {
    const svc = await fakeService();
    process.env[HOOK_ENV] = `${svc.base}/hook/abc`;
    try {
      const box = sandbox({ language: "ko", notify: { service, webhookUrlEnv: HOOK_ENV } });
      const id = await readyTicket(box, "Touch work");
      box.plan(["BUILD_BLOCKED"]);
      await runPipeline(box, id);
      assert.equal(svc.seen.length, 1);
      assert.equal(svc.seen[0]?.url, "/hook/abc");
      const body = JSON.parse(svc.seen[0]?.body ?? "{}") as Record<string, string>;
      assert.deepEqual(Object.keys(body), [field]);
      assert.match(body[field] ?? "", /Touch work: 멈춤, 확인 필요$/);
    } finally {
      delete process.env[HOOK_ENV];
      await svc.close();
    }
  }
});

test("events filter: only the chosen events are sent", async () => {
  const svc = await fakeService();
  process.env[HOOK_ENV] = `${svc.base}/h`;
  try {
    const box = sandbox({ notify: { service: "slack", webhookUrlEnv: HOOK_ENV, events: ["blocked"] } });
    const id = await readyTicket(box, "Touch work");
    box.plan(["BUILD", "REVIEW PASS"]);
    await runPipeline(box, id);
    assert.equal(await ticketStatus(box, id), TicketStatus.Review);
    assert.equal(svc.seen.length, 0);

    const id2 = await readyTicket(box, "Other work");
    box.plan(["BUILD", "REVIEW PASS", "BUILD_BLOCKED"]);
    await runPipeline(box, id2);
    assert.equal(svc.seen.length, 1);
    assert.match(svc.seen[0]?.body ?? "", /Other work: stopped, needs you/);
  } finally {
    delete process.env[HOOK_ENV];
    await svc.close();
  }
});

test("review event is sent when the filter allows it", async () => {
  const svc = await fakeService();
  process.env[HOOK_ENV] = `${svc.base}/h`;
  try {
    const box = sandbox({ notify: { service: "discord", webhookUrlEnv: HOOK_ENV, events: ["review", "merged"] } });
    const id = await readyTicket(box, "Touch work");
    box.plan(["BUILD", "REVIEW PASS"]);
    await runPipeline(box, id);
    assert.equal(svc.seen.length, 1);
    assert.match(svc.seen[0]?.body ?? "", /ready for your review/);
  } finally {
    delete process.env[HOOK_ENV];
    await svc.close();
  }
});

test("a failing service (HTTP 500, unreachable, unset variable) is logged and the ticket still settles", async () => {
  const bad = await fakeService(500);
  const cases: Array<[string | undefined, string]> = [
    [`${bad.base}/h`, "HTTP 500"],
    ["http://127.0.0.1:1/h", "request failed"],
    [undefined, "is not set"],
  ];
  try {
    for (const [url, expected] of cases) {
      if (url === undefined) delete process.env[HOOK_ENV];
      else process.env[HOOK_ENV] = url;
      const box = sandbox({ notify: { service: "slack", webhookUrlEnv: HOOK_ENV } });
      const id = await readyTicket(box, "Touch work");
      box.plan(["BUILD", "REVIEW PASS"]);
      assert.equal(await runPipeline(box, id), TicketOutcome.Settled);
      assert.equal(await ticketStatus(box, id), TicketStatus.Review);
      const log = box.runner.log.lastLineAbout(id);
      assert.match(log, /notify \(slack\) failed/);
      assert.match(log, new RegExp(expected));
      assert.doesNotMatch(log, /127\.0\.0\.1/);
    }
  } finally {
    delete process.env[HOOK_ENV];
    await bad.close();
  }
});

test("doctor warns about a missing environment variable and says ok when set", async () => {
  const find = async (): Promise<{ level: CheckLevel; what: string } | undefined> => {
    const box = sandbox({ notify: { service: "telegram", chatId: "1", botTokenEnv: TOKEN_ENV } });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${box.root}/nightshift.json`, JSON.stringify({ notify: { service: "telegram", chatId: "1", botTokenEnv: TOKEN_ENV }, projects: { demo: { repoPath: box.repo } } }));
    return (await doctorChecks(box.root)).find((c) => c.what.startsWith("notify"));
  };
  delete process.env[TOKEN_ENV];
  const missing = await find();
  assert.equal(missing?.level, CheckLevel.Warn);
  assert.match(missing?.what ?? "", new RegExp(TOKEN_ENV));
  process.env[TOKEN_ENV] = "x";
  try {
    assert.equal((await find())?.level, CheckLevel.Ok);
  } finally {
    delete process.env[TOKEN_ENV];
  }
});
