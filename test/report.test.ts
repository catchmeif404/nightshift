import assert from "node:assert/strict";
import { IncomingMessage, Server, ServerResponse, createServer } from "node:http";
import { AddressInfo } from "node:net";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { dispatch } from "../src/dispatch.js";
import { JournalKind, NoteLanguage, ReportGroup, SettleReason, TicketStatus, TodoKind } from "../src/enums.js";
import { TicketPipeline } from "../src/pipeline.js";
import {
  DailyReportOutcome, Journal, JournalRecord, SettledRecord, buildReport, dailyReportDue, parseSince, readReport, renderReport, reportJson, sendDailyReport,
} from "../src/report.js";
import { snapshot } from "../src/ui/snapshot.js";
import { Sandbox, readyTicket, sandbox } from "./helpers.js";

const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 25, 9, 0, 0).getTime();

function settled(ticket: string, hoursAgo: number, over: Partial<SettledRecord> = {}): SettledRecord {
  return {
    kind: JournalKind.Settled,
    at: NOW - hoursAgo * HOUR,
    ticket,
    title: `Title of ${ticket}`,
    project: "demo",
    status: TicketStatus.Done,
    reason: SettleReason.Merged,
    link: `https://example.com/pr/${ticket}`,
    rounds: 1,
    known: true,
    weighted: 217_000,
    seconds: 207,
    reviewerFiles: 0,
    reviewerAdded: 0,
    reviewerRemoved: 0,
    note: "",
    ...over,
  };
}

const SAMPLE: JournalRecord[] = [
  settled("T-1", 5),
  settled("T-2", 4, { status: TicketStatus.Review, reason: SettleReason.ReadyToMerge }),
  settled("T-3", 3, { rounds: 2, weighted: 400_000 }),
  settled("T-4", 2, { status: TicketStatus.Blocked, reason: SettleReason.Blocked, link: "", known: false, note: "the developer could not finish: no access\nsecond line" }),
  settled("T-5", 1, { status: TicketStatus.Blocked, reason: SettleReason.NeedsHuman, note: "needs a human decision (PR)" }),
  // Outside the 24 hours.
  settled("T-6", 30),
];

test("tickets are grouped by how they ended, with the totals and the to-do list", () => {
  const data = buildReport(SAMPLE, NOW - 24 * HOUR, NOW);
  const ids = (g: ReportGroup): string[] => data.groups[g].map((r) => r.ticket);
  assert.deepEqual(ids(ReportGroup.Passed), ["T-1", "T-2"]);
  assert.deepEqual(ids(ReportGroup.Reworked), ["T-3"]);
  assert.deepEqual(ids(ReportGroup.Blocked), ["T-4"]);
  assert.deepEqual(ids(ReportGroup.NeedsHuman), ["T-5"]);
  assert.equal(data.groups[ReportGroup.Blocked][0]?.reason, "the developer could not finish: no access second line");
  assert.deepEqual(data.todo.map((t) => [t.kind, t.ticket]), [[TodoKind.Merge, "T-2"], [TodoKind.Unblock, "T-4"], [TodoKind.Decide, "T-5"]]);
  // First-pass: 2 of the 4 tickets that were not waiting for a human.
  assert.deepEqual(data.totals, { tickets: 5, firstPass: 2, judged: 4, tokens: 217_000 * 3 + 400_000, seconds: 207 * 5, limitWaitSeconds: 0 });

  const english = renderReport(data, NoteLanguage.English);
  assert.match(english, /^nightshift report /);
  assert.match(english, /Passed after rework \(1\)\n- \[demo\] T-3 Title of T-3 - https:\/\/example\.com\/pr\/T-3 · 400k · 3m27s/);
  assert.match(english, /- \[demo\] T-4 Title of T-4 - tokens unknown · 3m27s\n {4}the developer could not finish/);
  assert.match(english, /Totals: 5 tickets · first-pass 2\/4 \(50%\) · 1\.1M tokens · waited for usage limits 0s/);
  assert.match(english, /To do now\n- T-2: review and merge https:\/\/example\.com\/pr\/T-2/);
  const korean = renderReport(data, NoteLanguage.Korean);
  assert.match(korean, /재작업 후 통과 \(1\)/);
  assert.match(korean, /합계: 티켓 5개 · 1회 통과 2\/4 \(50%\)/);
  assert.match(korean, /지금 할 일\n- T-2: 검토하고 머지/);
});

test("the period filter keeps only tickets that settled inside it; a ticket counts once, as its last time", () => {
  assert.equal(buildReport(SAMPLE, NOW - 2.5 * HOUR, NOW).totals.tickets, 2);
  assert.equal(buildReport(SAMPLE, NOW - 48 * HOUR, NOW).totals.tickets, 6);
  const again = [...SAMPLE, settled("T-4", 0.5, { rounds: 2 })];
  const data = buildReport(again, NOW - 24 * HOUR, NOW);
  assert.deepEqual(data.groups[ReportGroup.Blocked], []);
  assert.deepEqual(data.groups[ReportGroup.Reworked].map((r) => r.ticket), ["T-3", "T-4"]);
  assert.equal(data.totals.tickets, 5);

  assert.equal(parseSince("24h", NOW), NOW - 24 * HOUR);
  assert.equal(parseSince("2d", NOW), NOW - 48 * HOUR);
  assert.equal(parseSince("2026-11-24", NOW), new Date(2026, 10, 24).getTime());
  for (const bad of ["", "0h", "yesterday", "2026-13-01", "2026-02-30", "24"]) assert.throws(() => parseSince(bad, NOW), /--since/);
});

test("time waiting for a usage limit counts overlapping limits once and only inside the period", () => {
  const limits: JournalRecord[] = [
    { kind: JournalKind.Limited, at: NOW - 10 * HOUR, until: NOW - 8 * HOUR, agent: "claude-code" },
    { kind: JournalKind.Limited, at: NOW - 9 * HOUR, until: NOW - 7 * HOUR, agent: "codex" },
    // Began before the period and runs past now: cut to the period.
    { kind: JournalKind.Limited, at: NOW - 30 * HOUR, until: NOW - 23 * HOUR, agent: "claude-code" },
    { kind: JournalKind.Limited, at: NOW - 1 * HOUR, until: NOW + 5 * HOUR, agent: "claude-code" },
  ];
  // 10h-7h ago = 3h, 24h-23h ago = 1h, 1h ago-now = 1h.
  assert.equal(buildReport(limits, NOW - 24 * HOUR, NOW).totals.limitWaitSeconds, 5 * 3600);
});

test("an empty period says so in one line and has an empty JSON report", () => {
  const data = buildReport([], NOW - 24 * HOUR, NOW);
  const english = renderReport(data, NoteLanguage.English);
  assert.match(english, /\nnone: no ticket moved in this period\.\n/);
  assert.doesNotMatch(english, /Totals/);
  assert.match(renderReport(data, NoteLanguage.Korean), /\n없음: 이 기간에 움직인 티켓이 없습니다\.\n/);
  const parsed = JSON.parse(reportJson(data)) as { totals: { tickets: number }; todo: unknown[]; groups: Record<string, unknown[]> };
  assert.equal(parsed.totals.tickets, 0);
  assert.deepEqual(parsed.todo, []);
  assert.deepEqual(Object.keys(parsed.groups), Object.values(ReportGroup));
});

test("the journal skips lines it cannot read", () => {
  const box = sandbox();
  const journal = new Journal(box.runner.paths.journal);
  journal.append(settled("T-1", 1));
  journal.append({ kind: JournalKind.Limited, at: NOW, until: NOW + HOUR, agent: "codex" });
  writeLine(box, "not json");
  writeLine(box, JSON.stringify({ kind: "settled", at: 1, ticket: "T-9", status: "nope", reason: "merged" }));
  assert.deepEqual(journal.read().map((r) => r.kind), [JournalKind.Settled, JournalKind.Limited]);
});

function writeLine(box: Sandbox, line: string): void {
  appendFileSync(box.runner.paths.journal, `${line}\n`);
}

test("a ticket that finishes writes its journal line, with rounds and time; a rework counts as reworked", async () => {
  const box = sandbox();
  const id = await readyTicket(box, "Add a footer");
  box.plan(["BUILD", "REVIEW REWORK", "BUILD", "REVIEW PASS"]);
  const ticket = (await box.board.list(TicketStatus.Working)).find((t) => t.id === id);
  assert.ok(ticket);
  await new TicketPipeline(box.runner, ticket, "slot-test").run();

  const records = new Journal(box.runner.paths.journal).read();
  const record = records.find((r): r is SettledRecord => r.kind === JournalKind.Settled);
  assert.ok(record);
  assert.deepEqual([record.ticket, record.title, record.project, record.status, record.reason, record.rounds], [id, "Add a footer", "demo", TicketStatus.Review, SettleReason.ReadyToMerge, 2]);
  const now = Date.now();
  const data = readReport(box.runner.paths, now - 24 * HOUR, now);
  assert.deepEqual(data.groups[ReportGroup.Reworked].map((r) => r.ticket), [id]);
  assert.deepEqual(data.todo.map((t) => t.kind), [TodoKind.Merge]);

  const snap = await snapshot(box.config);
  assert.equal(snap.report.totals.tickets, 1);
});

test("dailyReportAt is validated and off by default", () => {
  assert.equal(parseConfig({ projects: {} }, "/w").dailyReportAt, "");
  assert.equal(parseConfig({ projects: {}, dailyReportAt: "08:00" }, "/w").dailyReportAt, "08:00");
  for (const bad of ["8:00", "24:00", "08:60", "morning"]) assert.throws(() => parseConfig({ projects: {}, dailyReportAt: bad }, "/w"), /dailyReportAt/);
});

interface Seen {
  url: string;
  body: string;
}

async function fakeService(status = 200): Promise<{ base: string; seen: Seen[]; close(): Promise<void> }> {
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

const HOOK_ENV = "TEST_NS_REPORT_HOOK";

test("the morning report goes out once a day, at the first dispatch after dailyReportAt", async () => {
  const svc = await fakeService();
  process.env[HOOK_ENV] = `${svc.base}/hook`;
  try {
    const box = sandbox({ dailyReportAt: "08:00", language: "ko", notify: { service: "slack", webhookUrlEnv: HOOK_ENV } });
    new Journal(box.runner.paths.journal).append(settled("T-1", 1, { at: Date.now() - HOUR }));
    const at = (h: number, m: number): number => new Date(2026, 10, 25, h, m).getTime();

    // Before 08:00 nothing is sent.
    assert.equal(dailyReportDue(box.config, box.runner.paths, at(7, 59)), false);
    assert.equal((await sendDailyReport(box.config, box.runner.paths, at(7, 59))).outcome, DailyReportOutcome.NotDue);
    assert.equal(svc.seen.length, 0);

    // The first dispatch after 08:00 sends; the second one the same day does not.
    assert.equal((await sendDailyReport(box.config, box.runner.paths, at(8, 1))).outcome, DailyReportOutcome.Sent);
    assert.equal((await sendDailyReport(box.config, box.runner.paths, at(8, 3))).outcome, DailyReportOutcome.NotDue);
    assert.equal((await sendDailyReport(box.config, box.runner.paths, at(23, 0))).outcome, DailyReportOutcome.NotDue);
    assert.equal(svc.seen.length, 1);
    assert.match((JSON.parse(svc.seen[0]?.body ?? "{}") as { text: string }).text, /^nightshift 보고 /);
    assert.equal(readFileSync(box.runner.paths.reportSent, "utf8").trim(), "2026-11-25");

    // The next day it is due again.
    const next = new Date(2026, 10, 26, 8, 5).getTime();
    assert.equal((await sendDailyReport(box.config, box.runner.paths, next)).outcome, DailyReportOutcome.Sent);
    assert.equal(svc.seen.length, 2);
  } finally {
    delete process.env[HOOK_ENV];
    await svc.close();
  }
});

test("dispatch sends the morning report itself, once, even with nothing to start", async () => {
  const svc = await fakeService();
  process.env[HOOK_ENV] = `${svc.base}/hook`;
  try {
    const box = sandbox({ dailyReportAt: "00:00", notify: { service: "slack", webhookUrlEnv: HOOK_ENV } });
    await dispatch(box.runner, () => process.pid);
    await dispatch(box.runner, () => process.pid);
    assert.equal(svc.seen.length, 1);
    assert.match((JSON.parse(svc.seen[0]?.body ?? "{}") as { text: string }).text, /none: no ticket moved/);
  } finally {
    delete process.env[HOOK_ENV];
    await svc.close();
  }
});

test("a failed send is tried again at the next dispatch, and the report stays off when not configured", async () => {
  const svc = await fakeService(500);
  process.env[HOOK_ENV] = `${svc.base}/hook`;
  try {
    const box = sandbox({ dailyReportAt: "00:00", notify: { service: "slack", webhookUrlEnv: HOOK_ENV } });
    const now = Date.now();
    const first = await sendDailyReport(box.config, box.runner.paths, now);
    assert.equal(first.outcome, DailyReportOutcome.Failed);
    assert.match(first.failures.join(), /HTTP 500/);
    assert.equal(existsSync(box.runner.paths.reportSent), false);
    assert.equal((await sendDailyReport(box.config, box.runner.paths, now)).outcome, DailyReportOutcome.Failed);
    assert.equal(svc.seen.length, 2);
  } finally {
    delete process.env[HOOK_ENV];
    await svc.close();
  }
  const off = sandbox({ dailyReportAt: "00:00" });
  assert.equal((await sendDailyReport(off.config, off.runner.paths, Date.now())).outcome, DailyReportOutcome.NoChannel);
  const none = sandbox({ notify: { service: "slack", webhookUrlEnv: HOOK_ENV } });
  assert.equal((await sendDailyReport(none.config, none.runner.paths, Date.now())).outcome, DailyReportOutcome.NotDue);
});

test("a ticket the reviewer edited shows the size of the edit in both languages", () => {
  const data = buildReport([settled("T-1", 1, { reviewerFiles: 2, reviewerAdded: 12, reviewerRemoved: 3 }), settled("T-2", 2)], NOW - 24 * HOUR, NOW);
  assert.match(renderReport(data, NoteLanguage.English), /T-1 Title of T-1 - .* · reviewer edit \+12\/-3\n/);
  assert.match(renderReport(data, NoteLanguage.Korean), /T-1 Title of T-1 - .* · 검토자 수정 \+12\/-3\n/);
  assert.doesNotMatch(renderReport(data, NoteLanguage.English).split("\n").filter((l) => l.includes("T-2 Title"))[0] ?? "", /reviewer edit/);
});
