// Collects token usage and stage spans from the raw Claude Code logs of one run. Usage: usage.mjs <runRoot>
import { realpathSync } from "node:fs";
import { Role, readJsonl, sessionFiles } from "./common.mjs";

const DEV = /You are the developer for (?:one|this) ticket, round (\d+)/;
const REV = /You are the reviewer(?: \(the CTO\))? for (?:one|this) ticket, round (\d+)/;

function classify(lines) {
  for (const line of lines.slice(0, 8)) {
    const text = JSON.stringify(line);
    const dev = DEV.exec(text.replace(/\\n/g, " "));
    if (dev) return { role: Role.Builder, round: Number(dev[1]) };
    const rev = REV.exec(text.replace(/\\n/g, " "));
    if (rev) return { role: Role.Reviewer, round: Number(rev[1]) };
  }
  return { role: "unknown", round: 0 };
}

export function collect(runRoot, { missingOk = false } = {}) {
  const sessions = sessionFiles(missingOk ? runRoot : realpathSync(runRoot)).map((file) => {
    const lines = readJsonl(file);
    const { role, round } = classify(lines);
    const byId = new Map();
    const stamps = [];
    for (const l of lines) {
      if (typeof l.timestamp === "string") stamps.push(Date.parse(l.timestamp));
      if (l.type === "assistant" && l.message?.id !== undefined && l.message.usage !== undefined) {
        byId.set(l.message.id, { model: l.message.model, usage: l.message.usage, ts: l.timestamp });
      }
    }
    const rows = [...byId.values()].filter((r) => r.model !== "<synthetic>");
    const sum = (k) => rows.reduce((s, r) => s + (r.usage[k] ?? 0), 0);
    const hasUsage = rows.length > 0;
    return {
      role, round,
      models: [...new Set(rows.map((r) => r.model))],
      messages: rows.length,
      span_s: stamps.length > 1 ? (Math.max(...stamps) - Math.min(...stamps)) / 1000 : null,
      first_ts: stamps.length ? new Date(Math.min(...stamps)).toISOString() : null,
      input: hasUsage ? sum("input_tokens") : null,
      output: hasUsage ? sum("output_tokens") : null,
      cache_read: hasUsage ? sum("cache_read_input_tokens") : null,
      cache_write: hasUsage ? sum("cache_creation_input_tokens") : null,
      rows: rows.map((r) => ({ ts: r.ts, model: r.model, input: r.usage.input_tokens ?? null, output: r.usage.output_tokens ?? null,
        cache_read: r.usage.cache_read_input_tokens ?? null, cache_write: r.usage.cache_creation_input_tokens ?? null })),
    };
  }).sort((a, b) => String(a.first_ts).localeCompare(String(b.first_ts)));
  return sessions;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = collect(process.argv[2]).map(({ rows, ...rest }) => rest);
  console.log(JSON.stringify(out, null, 2));
}
