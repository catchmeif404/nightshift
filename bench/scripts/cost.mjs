// Price-weighted token cost. Weights come from config/prices.json (ratios against one uncached input token).
// Library: weightedCost(tokens). CLI: node cost.mjs  -> recomputes the TK-454 pilot (results/raw/*.json) into results/weighted-tk454.md
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_ROOT } from "./common.mjs";

export const PRICES = JSON.parse(readFileSync(join(BENCH_ROOT, "config", "prices.json"), "utf8")).ratios;

// tokens = { input, output, cache_read, cache_write }; any null part makes the cost null (never filled with 0 or an estimate).
export function weightedCost(tokens, prices = PRICES) {
  const parts = [["input", "input"], ["output", "output"], ["cache_write", "cache_write"], ["cache_read", "cache_read"]];
  if (parts.some(([k]) => tokens[k] === null || tokens[k] === undefined)) return null;
  return parts.reduce((s, [k, p]) => s + tokens[k] * prices[p], 0);
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = join(BENCH_ROOT, "results", "raw");
  const runs = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  runs.sort((a, b) => a.task.localeCompare(b.task) || a.condition.localeCompare(b.condition));
  const rows = runs.map((r) => ({ task: r.task, arm: r.condition, raw_total: r.tokens.total, weighted: weightedCost(r.tokens) }));
  const tasks = [...new Set(rows.map((r) => r.task))];
  const pairs = tasks.map((t) => {
    const on = rows.find((r) => r.task === t && r.arm === "ON"); const off = rows.find((r) => r.task === t && r.arm === "OFF");
    return { task: t, raw: on.raw_total / off.raw_total, weighted: on.weighted / off.weighted };
  });
  const f = (v) => (v === null ? "n/a" : v.toFixed(1));
  const md = ["# TK-454 pilot recomputed with price weights", "",
    `Weights (ratio to uncached input): ${JSON.stringify(PRICES)}. Same 6 runs, no new runs. Exploratory, 1 run per cell: not a claim of any saving.`, "",
    "| task | arm | raw total tokens | price-weighted units |", "|---|---|---|---|",
    ...rows.map((r) => `| ${r.task} | ${r.arm} | ${r.raw_total} | ${f(r.weighted)} |`), "",
    "| task | ON/OFF raw total | ON/OFF price-weighted |", "|---|---|---|",
    ...pairs.map((p) => `| ${p.task} | ${p.raw.toFixed(3)} | ${p.weighted.toFixed(3)} |`),
    `| median | ${median(pairs.map((p) => p.raw)).toFixed(3)} | ${median(pairs.map((p) => p.weighted)).toFixed(3)} |`, ""].join("\n");
  writeFileSync(join(BENCH_ROOT, "results", "weighted-tk454.md"), md);
  console.log(md);
}
