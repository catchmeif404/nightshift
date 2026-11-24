import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NoteLanguage, Stage } from "./enums.js";
import { safeId } from "./state.js";

// Weights of the cost formula: the same as bench/scripts (input x1, output x5, cache write x1.25, cache read x0.1).
const WEIGHT_INPUT = 1;
const WEIGHT_OUTPUT = 5;
const WEIGHT_CACHE_WRITE = 1.25;
const WEIGHT_CACHE_READ = 0.1;
const SYNTHETIC_MODEL = "<synthetic>";

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionUsage {
  // False: the session could not be read (no file, no assistant messages); the counts are then zero.
  known: boolean;
  tokens: TokenCounts;
  models: string[];
  // First to last timestamp of the session file; 0 when it has fewer than two stamps.
  seconds: number;
}

// One finished stage run of a ticket, one JSON line in the ticket's usage file.
export interface StageUsage {
  stage: Stage;
  round: number;
  // The agent session the stage ran in. A rerun that resumes it (a stage whose result was rejected) replaces the entry.
  session: string;
  // The model the stage was configured with.
  model: string;
  known: boolean;
  tokens: TokenCounts;
  weighted: number;
  seconds: number;
}

export function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function weighted(t: TokenCounts): number {
  return Math.round(t.input * WEIGHT_INPUT + t.output * WEIGHT_OUTPUT + t.cacheWrite * WEIGHT_CACHE_WRITE + t.cacheRead * WEIGHT_CACHE_READ);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// Sums the usage of the assistant messages of a Claude Code session file. A message is counted once by its id
// (a streamed message is logged several times); the span runs from the first to the last timestamp.
export function parseSessionUsage(text: string): SessionUsage {
  const byId = new Map<string, { model: string; usage: Record<string, unknown> }>();
  const stamps: number[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))) stamps.push(Date.parse(entry.timestamp));
    const message = record(entry.message);
    if (entry.type === "assistant" && typeof message.id === "string" && typeof message.usage === "object" && message.usage !== null) {
      byId.set(message.id, { model: typeof message.model === "string" ? message.model : "", usage: record(message.usage) });
    }
  }
  const rows = [...byId.values()].filter((r) => r.model !== SYNTHETIC_MODEL);
  const tokens = emptyTokens();
  for (const r of rows) {
    tokens.input += num(r.usage.input_tokens);
    tokens.output += num(r.usage.output_tokens);
    tokens.cacheRead += num(r.usage.cache_read_input_tokens);
    tokens.cacheWrite += num(r.usage.cache_creation_input_tokens);
  }
  return {
    known: rows.length > 0,
    tokens,
    models: [...new Set(rows.map((r) => r.model).filter((m) => m !== ""))],
    seconds: stamps.length > 1 ? Math.round((Math.max(...stamps) - Math.min(...stamps)) / 1000) : 0,
  };
}

// An unreadable or missing session file is not an error: the usage is just unknown.
export function readSessionUsage(file: string): SessionUsage {
  const unknown: SessionUsage = { known: false, tokens: emptyTokens(), models: [], seconds: 0 };
  if (file === "" || !existsSync(file)) return unknown;
  try {
    return parseSessionUsage(readFileSync(file, "utf8"));
  } catch {
    return unknown;
  }
}

// The per-ticket usage records, one file per ticket under the state directory.
export class UsageLog {
  constructor(private readonly dir: string, ticketId: string) {
    this.file = join(dir, `${safeId(ticketId)}.jsonl`);
  }

  readonly file: string;

  append(entry: StageUsage): void {
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }

  // Adds a finished stage run. A resumed session's file already holds the earlier run's tokens, so an entry of the
  // same session is replaced instead of counted twice. Its span covers both runs too; wall-clock seconds are added.
  record(entry: StageUsage): void {
    const entries = this.read();
    const index = entries.findIndex((e) => e.session !== "" && e.session === entry.session);
    const previous = entries[index];
    if (previous === undefined) return this.append(entry);
    entries[index] = { ...entry, seconds: entry.known && previous.known ? entry.seconds : previous.seconds + entry.seconds };
    writeFileSync(this.file, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }

  read(): StageUsage[] {
    if (!existsSync(this.file)) return [];
    const entries: StageUsage[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      try {
        const e = record(JSON.parse(line));
        const stage = Object.values(Stage).find((s) => s === e.stage);
        if (stage === undefined) continue;
        const t = record(e.tokens);
        entries.push({
          stage,
          round: num(e.round),
          session: typeof e.session === "string" ? e.session : "",
          model: typeof e.model === "string" ? e.model : "",
          known: e.known === true,
          tokens: { input: num(t.input), output: num(t.output), cacheRead: num(t.cacheRead), cacheWrite: num(t.cacheWrite) },
          weighted: num(e.weighted),
          seconds: num(e.seconds),
        });
      } catch {
        continue;
      }
    }
    return entries;
  }
}

export interface UsageTotal {
  // Whether at least one stage had readable tokens.
  known: boolean;
  weighted: number;
  seconds: number;
}

export function totalUsage(entries: StageUsage[]): UsageTotal {
  return {
    known: entries.some((e) => e.known),
    weighted: entries.reduce((s, e) => s + (e.known ? e.weighted : 0), 0),
    seconds: entries.reduce((s, e) => s + e.seconds, 0),
  };
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

// The short "217k · 3m27s" for a ticket row; tokens are left out when no stage could be read.
export function formatTotal(total: UsageTotal): string {
  return total.known ? `${formatTokens(total.weighted)} · ${formatDuration(total.seconds)}` : formatDuration(total.seconds);
}

interface UsageWords {
  stage: Record<Stage, string>;
  total: string;
  unknown: string;
}

const WORDS: Record<NoteLanguage, UsageWords> = {
  [NoteLanguage.English]: {
    stage: { [Stage.Build]: "build", [Stage.Review]: "review", [Stage.Release]: "release" },
    total: "total",
    unknown: "tokens unknown",
  },
  [NoteLanguage.Korean]: {
    stage: { [Stage.Build]: "개발", [Stage.Review]: "검토", [Stage.Release]: "출시" },
    total: "합계",
    unknown: "토큰 알 수 없음",
  },
};

const NOTE_SEPARATOR = " · ";

// The one-line board note: "build r1 sonnet 2m10s 124k · review r1 opus 1m17s 93k · total 217k".
export function usageNote(entries: StageUsage[], language: NoteLanguage): string {
  if (entries.length === 0) return "";
  const words = WORDS[language];
  const parts = entries.map((e) => {
    const tokens = e.known ? formatTokens(e.weighted) : words.unknown;
    return [words.stage[e.stage], `r${e.round}`, e.model, formatDuration(e.seconds), tokens].filter((p) => p !== "").join(" ");
  });
  const total = totalUsage(entries);
  parts.push(`${words.total} ${total.known ? formatTokens(total.weighted) : words.unknown}`);
  return parts.join(NOTE_SEPARATOR);
}
