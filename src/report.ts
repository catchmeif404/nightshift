import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Config, ConfigError } from "./config.js";
import { JournalKind, NoteLanguage, NotifyEvent, NotifyService, ReportGroup, SettleReason, TicketStatus, TodoKind } from "./enums.js";
import { run } from "./exec.js";
import { clip, mask, oneLine } from "./log.js";
import { Messages, messagesFor } from "./messages.js";
import { sendNotification, wants } from "./notify.js";
import { StatePaths } from "./state.js";
import { formatDuration, formatTokens } from "./usage.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const DEFAULT_SINCE = "24h";
const REASON_CHARS = 160;
// Telegram allows 4096 characters in a message; the report stays under it.
const SEND_CHARS = 3500;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SPAN_PATTERN = /^(\d{1,4})([hd])$/;

// A ticket left the runner's hands. Written when it settles, with what the usage records said at that moment.
export interface SettledRecord {
  kind: JournalKind.Settled;
  at: number;
  ticket: string;
  title: string;
  project: string;
  status: TicketStatus;
  reason: SettleReason;
  // The pull request URL or the branch name. Empty: none.
  link: string;
  // Build rounds the ticket needed (1: no rework).
  rounds: number;
  // Whether at least one stage had readable tokens.
  known: boolean;
  weighted: number;
  seconds: number;
  // What the reviewer changed in the code itself, over all review rounds (0: nothing).
  reviewerFiles: number;
  reviewerAdded: number;
  reviewerRemoved: number;
  // The first line of the note the ticket got, shortened.
  note: string;
}

// An agent's account hit its usage limit at `at`; work waited until `until`.
export interface LimitedRecord {
  kind: JournalKind.Limited;
  at: number;
  until: number;
  agent: string;
}

export type JournalRecord = SettledRecord | LimitedRecord;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// The runner's record of what happened, one JSON line each, in the state directory.
export class Journal {
  constructor(readonly file: string) {}

  append(record: JournalRecord): void {
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }

  // Lines that are not valid records are skipped, never an error.
  read(): JournalRecord[] {
    if (!existsSync(this.file)) return [];
    const records: JournalRecord[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      try {
        const e = fields(JSON.parse(line));
        const at = num(e.at);
        if (at <= 0) continue;
        if (e.kind === JournalKind.Limited) {
          records.push({ kind: JournalKind.Limited, at, until: num(e.until), agent: text(e.agent) });
          continue;
        }
        const status = Object.values(TicketStatus).find((s) => s === e.status);
        const reason = Object.values(SettleReason).find((r) => r === e.reason);
        if (e.kind !== JournalKind.Settled || status === undefined || reason === undefined || text(e.ticket) === "") continue;
        records.push({
          kind: JournalKind.Settled,
          at,
          ticket: text(e.ticket),
          title: text(e.title),
          project: text(e.project),
          status,
          reason,
          link: text(e.link),
          rounds: Math.max(1, num(e.rounds)),
          known: e.known === true,
          weighted: num(e.weighted),
          seconds: num(e.seconds),
          reviewerFiles: num(e.reviewerFiles),
          reviewerAdded: num(e.reviewerAdded),
          reviewerRemoved: num(e.reviewerRemoved),
          note: text(e.note),
        });
      } catch {
        continue;
      }
    }
    return records;
  }
}

// "24h", "3d" (back from now) or "YYYY-MM-DD" (from that day's midnight, this computer's time zone), as milliseconds.
export function parseSince(value: string, now: number): number {
  const span = SPAN_PATTERN.exec(value);
  if (span !== null) {
    const amount = Number(span[1]);
    if (amount > 0) return now - amount * (span[2] === "d" ? DAY_MS : HOUR_MS);
  }
  const date = DATE_PATTERN.exec(value);
  if (date !== null) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const start = new Date(year, month - 1, day);
    if (start.getFullYear() === year && start.getMonth() === month - 1 && start.getDate() === day) return start.getTime();
  }
  throw new ConfigError('--since must be a span like 24h or 3d, or a date like 2026-11-24');
}

export interface ReportRow {
  group: ReportGroup;
  ticket: string;
  title: string;
  project: string;
  // The pull request URL or the branch. Empty: none.
  where: string;
  tokensKnown: boolean;
  tokens: number;
  seconds: number;
  rounds: number;
  // What the reviewer changed itself; zeros when nothing.
  reviewerFiles: number;
  reviewerAdded: number;
  reviewerRemoved: number;
  // Why it is blocked or waits for a human, one line. Empty for passed tickets.
  reason: string;
  at: number;
}

export interface ReportTodo {
  kind: TodoKind;
  ticket: string;
  where: string;
}

export interface ReportTotals {
  tickets: number;
  // Tickets that passed review without rework, out of `judged` (every ticket except those waiting for a human).
  firstPass: number;
  judged: number;
  tokens: number;
  seconds: number;
  limitWaitSeconds: number;
}

export interface ReportData {
  since: number;
  until: number;
  groups: Record<ReportGroup, ReportRow[]>;
  totals: ReportTotals;
  todo: ReportTodo[];
}

function groupOf(r: SettledRecord): ReportGroup {
  switch (r.reason) {
    case SettleReason.NeedsHuman:
      return ReportGroup.NeedsHuman;
    case SettleReason.Blocked:
    case SettleReason.CutOff:
    case SettleReason.Misconfigured:
      return ReportGroup.Blocked;
    default:
      return r.rounds > 1 ? ReportGroup.Reworked : ReportGroup.Passed;
  }
}

function todoOf(row: ReportRow, status: TicketStatus): ReportTodo[] {
  if (row.group === ReportGroup.NeedsHuman) return [{ kind: TodoKind.Decide, ticket: row.ticket, where: row.where }];
  if (row.group === ReportGroup.Blocked) return [{ kind: TodoKind.Unblock, ticket: row.ticket, where: row.where }];
  return status === TicketStatus.Review ? [{ kind: TodoKind.Merge, ticket: row.ticket, where: row.where }] : [];
}

// Total length of the time spans, each cut to [from, to], where overlapping spans count once.
function unionSeconds(spans: Array<{ from: number; to: number }>, from: number, to: number): number {
  const cut = spans.map((s) => ({ from: Math.max(s.from, from), to: Math.min(s.to, to) })).filter((s) => s.to > s.from);
  cut.sort((a, b) => a.from - b.from);
  let total = 0;
  let end = from;
  for (const s of cut) {
    const start = Math.max(s.from, end);
    if (s.to > start) total += s.to - start;
    end = Math.max(end, s.to);
  }
  return Math.round(total / 1000);
}

// Groups the tickets that settled in [since, until]. A ticket that settled more than once counts once, as its last time.
export function buildReport(records: JournalRecord[], since: number, until: number): ReportData {
  const last = new Map<string, SettledRecord>();
  for (const r of records) {
    if (r.kind !== JournalKind.Settled || r.at < since || r.at > until) continue;
    const seen = last.get(r.ticket);
    if (seen === undefined || seen.at <= r.at) last.set(r.ticket, r);
  }
  const groups: Record<ReportGroup, ReportRow[]> = {
    [ReportGroup.Passed]: [],
    [ReportGroup.Reworked]: [],
    [ReportGroup.Blocked]: [],
    [ReportGroup.NeedsHuman]: [],
  };
  const todo: ReportTodo[] = [];
  const settled = [...last.values()].sort((a, b) => a.at - b.at);
  for (const r of settled) {
    const group = groupOf(r);
    const row: ReportRow = {
      group,
      ticket: r.ticket,
      title: oneLine(mask(r.title)),
      project: r.project,
      where: r.link,
      tokensKnown: r.known,
      tokens: r.known ? r.weighted : 0,
      seconds: r.seconds,
      rounds: r.rounds,
      reviewerFiles: r.reviewerFiles,
      reviewerAdded: r.reviewerAdded,
      reviewerRemoved: r.reviewerRemoved,
      reason: group === ReportGroup.Blocked || group === ReportGroup.NeedsHuman ? clip(oneLine(mask(r.note)), REASON_CHARS) : "",
      at: r.at,
    };
    groups[group].push(row);
    todo.push(...todoOf(row, r.status));
  }
  const rows = Object.values(groups).flat();
  const spans = records.flatMap((r) => (r.kind === JournalKind.Limited ? [{ from: r.at, to: r.until }] : []));
  return {
    since,
    until,
    groups,
    totals: {
      tickets: rows.length,
      firstPass: groups[ReportGroup.Passed].length,
      judged: rows.length - groups[ReportGroup.NeedsHuman].length,
      tokens: rows.reduce((sum, r) => sum + r.tokens, 0),
      seconds: rows.reduce((sum, r) => sum + r.seconds, 0),
      limitWaitSeconds: unionSeconds(spans, since, until),
    },
    todo,
  };
}

export function readReport(paths: StatePaths, since: number, until: number): ReportData {
  return buildReport(new Journal(paths.journal).read(), since, until);
}

function stamp(ms: number): string {
  return new Date(ms).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
}

function firstPassText(totals: ReportTotals): string {
  if (totals.judged === 0) return "-";
  return `${totals.firstPass}/${totals.judged} (${Math.round((totals.firstPass / totals.judged) * 100)}%)`;
}

function rowLine(row: ReportRow, say: Messages): string {
  const tokens = row.tokensKnown ? formatTokens(row.tokens) : say.report.tokensUnknown;
  const head = [`[${row.project}]`, row.ticket, row.title].filter((p) => p !== "").join(" ");
  const edit = row.reviewerFiles > 0 ? say.report.reviewerEdit(row.reviewerAdded, row.reviewerRemoved) : "";
  const tail = [row.where, tokens, formatDuration(row.seconds), edit].filter((p) => p !== "").join(" · ");
  return `- ${head} - ${tail}${row.reason === "" ? "" : `\n    ${row.reason}`}`;
}

function todoLine(item: ReportTodo, say: Messages): string {
  switch (item.kind) {
    case TodoKind.Merge:
      return say.report.todoMerge(item.ticket, item.where);
    case TodoKind.Unblock:
      return say.report.todoUnblock(item.ticket);
    case TodoKind.Decide:
      return say.report.todoDecide(item.ticket);
  }
}

// The text of the report: the same for the terminal and for a chat message.
export function renderReport(data: ReportData, language: NoteLanguage): string {
  const say = messagesFor(language);
  const lines = [say.report.title(stamp(data.since), stamp(data.until)), ""];
  if (data.totals.tickets === 0) {
    lines.push(say.report.none);
  } else {
    for (const group of Object.values(ReportGroup)) {
      const rows = data.groups[group];
      if (rows.length === 0) continue;
      lines.push(`${say.report.group[group]} (${rows.length})`, ...rows.map((r) => rowLine(r, say)), "");
    }
    const t = data.totals;
    lines.push(say.report.totals(t.tickets, firstPassText(t), formatTokens(t.tokens), formatDuration(t.limitWaitSeconds)));
  }
  lines.push("", say.report.todoHeader);
  lines.push(...(data.todo.length === 0 ? [`- ${say.report.todoNone}`] : data.todo.map((i) => `- ${todoLine(i, say)}`)));
  return lines.join("\n");
}

// The report as JSON for scripts: times as ISO strings, no language.
export function reportJson(data: ReportData): string {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const groups = Object.fromEntries(Object.entries(data.groups).map(([g, rows]) => [g, rows.map((r) => ({ ...r, at: iso(r.at) }))]));
  return JSON.stringify({ since: iso(data.since), until: iso(data.until), groups, totals: data.totals, todo: data.todo }, null, 2);
}

// Where a report can go: the built-in chat service and the notifyCommand. `service` is false when the events list leaves the report out.
export function reportChannels(config: Config, onlyWanted: boolean): { service: boolean; command: boolean } {
  const serviceOn = config.notify.service !== NotifyService.None;
  return {
    service: onlyWanted ? wants(config.notify, NotifyEvent.DailyReport) : serviceOn,
    command: config.notifyCommand !== "",
  };
}

// Sends the text through the chat service and the notifyCommand. Returns the failures, empty when all that were tried worked.
export async function sendReport(config: Config, body: string, onlyWanted: boolean): Promise<string[]> {
  const channels = reportChannels(config, onlyWanted);
  const failures: string[] = [];
  if (channels.service) {
    const failure = await sendNotification(config.notify, body, process.env, SEND_CHARS);
    if (failure !== "") failures.push(`${config.notify.service}: ${failure}`);
  }
  if (channels.command) {
    const result = await run(config.notifyCommand, [mask(body)], config.root);
    if (result.code !== 0) failures.push(`notifyCommand: ${clip(oneLine(result.stderr), 200)}`);
  }
  return failures;
}

function localDate(ms: number): string {
  return new Date(ms).toLocaleDateString("sv-SE");
}

// Whether the morning report is due: dailyReportAt has passed today and today's report has not gone out.
export function dailyReportDue(config: Config, paths: StatePaths, now: number): boolean {
  if (config.dailyReportAt === "") return false;
  const [hours, minutes] = config.dailyReportAt.split(":").map(Number);
  const at = new Date(now);
  at.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  if (now < at.getTime()) return false;
  const sent = existsSync(paths.reportSent) ? readFileSync(paths.reportSent, "utf8").trim() : "";
  return sent !== localDate(now);
}

export enum DailyReportOutcome {
  NotDue = "not-due",
  NoChannel = "no-channel",
  Sent = "sent",
  Failed = "failed",
}

// Sends the last 24 hours once a day. The date is written only after a send that worked, so a failure is tried again
// at the next dispatch. Called while the dispatch lock is held, so two workers never send it twice.
export async function sendDailyReport(config: Config, paths: StatePaths, now: number): Promise<{ outcome: DailyReportOutcome; failures: string[] }> {
  if (!dailyReportDue(config, paths, now)) return { outcome: DailyReportOutcome.NotDue, failures: [] };
  const channels = reportChannels(config, true);
  if (!channels.service && !channels.command) return { outcome: DailyReportOutcome.NoChannel, failures: [] };
  const body = renderReport(readReport(paths, now - DAY_MS, now), config.language);
  const failures = await sendReport(config, body, true);
  const tried = Number(channels.service) + Number(channels.command);
  if (failures.length >= tried) return { outcome: DailyReportOutcome.Failed, failures };
  writeFileSync(paths.reportSent, `${localDate(now)}\n`);
  return { outcome: DailyReportOutcome.Sent, failures };
}
