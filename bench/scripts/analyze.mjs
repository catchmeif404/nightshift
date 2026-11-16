// Recomputes every table from results/raw/*.json. Usage: node analyze.mjs  -> results/runs.csv, results/summary.json, results/summary.md
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_ROOT, Condition } from "./common.mjs";

const dir = join(BENCH_ROOT, "results", "raw");
const runs = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
const order = { t1: 1, t2: 2, t3: 3 };
runs.sort((a, b) => order[a.task] - order[b.task] || a.condition.localeCompare(b.condition));

const flat = runs.map((r) => ({
  anon_id: r.anon_id, task: r.task, condition: r.condition, outcome: r.outcome, completed: r.completed, accepted_by_grader: r.accepted_by_grader,
  input_tokens: r.tokens.input, output_tokens: r.tokens.output, cache_read_tokens: r.tokens.cache_read, cache_write_tokens: r.tokens.cache_write, total_tokens: r.tokens.total,
  total_s: r.seconds.total, build_s: r.seconds.build, rework_s: r.seconds.rework, review_s: r.seconds.review, wait_overhead_s: r.seconds.wait_overhead,
  build_rounds: r.build_rounds, rework_rounds: r.rework_rounds, sessions: r.sessions.length,
  hidden_pass: r.quality.hidden_pass, hidden_total: r.quality.hidden_total, own_tests_pass: r.quality.own_tests_pass,
  security_ok: r.quality.security_ok, scope_ok: r.quality.scope_ok, critical_defect: r.quality.critical_defect, out_of_scope_files: r.quality.out_of_scope_files.join(" "),
  models: r.models.join(" "), error: r.error ?? "",
}));
const q = (v) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const header = Object.keys(flat[0]);
writeFileSync(join(BENCH_ROOT, "results", "runs.csv"), `${[header.join(","), ...flat.map((r) => header.map((h) => q(r[h])).join(","))].join("\n")}\n`);

const METRICS = ["total_tokens", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_s", "build_s", "rework_s", "review_s", "wait_overhead_s", "rework_rounds", "hidden_pass"];
const median = (xs) => { if (xs.length === 0) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const tasks = [...new Set(flat.map((r) => r.task))];
const pairs = {};
for (const m of METRICS) {
  const rows = tasks.map((t) => {
    const on = flat.find((r) => r.task === t && r.condition === Condition.On)?.[m] ?? null;
    const off = flat.find((r) => r.task === t && r.condition === Condition.Off)?.[m] ?? null;
    const both = on !== null && off !== null;
    return { task: t, on, off, diff: both ? on - off : null, ratio: both && off !== 0 ? on / off : null };
  });
  const ok = rows.filter((r) => r.diff !== null);
  pairs[m] = { rows, n_pairs: ok.length, n_excluded: rows.length - ok.length, median_diff: median(ok.map((r) => r.diff)), median_ratio: median(ok.filter((r) => r.ratio !== null).map((r) => r.ratio)) };
}
const rate = (cond, key) => { const rs = flat.filter((r) => r.condition === cond); return { n: rs.length, count: rs.filter((r) => r[key] === true).length }; };
const arms = Object.fromEntries(Object.values(Condition).map((c) => [c, {
  completed: rate(c, "completed"), accepted_by_grader: rate(c, "accepted_by_grader"), critical_defect: rate(c, "critical_defect"), scope_ok: rate(c, "scope_ok"),
}]));
writeFileSync(join(BENCH_ROOT, "results", "summary.json"), `${JSON.stringify({ n_runs: flat.length, pairs, arms }, null, 2)}\n`);

const f = (v) => (v === null ? "n/a" : Number.isInteger(v) ? String(v) : v.toFixed(2));
const md = [];
md.push("| task | arm | outcome | completed | hidden tests | own tests | security | scope | rework rounds | total s | build s | rework s | review s | wait s | total tokens | out | cache read | cache write | input |", `|${"---|".repeat(19)}`);
for (const r of flat) md.push(`| ${r.task} | ${r.condition} | ${r.outcome} | ${r.completed} | ${r.hidden_pass}/${r.hidden_total} | ${r.own_tests_pass} | ${r.security_ok} | ${r.scope_ok} | ${r.rework_rounds} | ${f(r.total_s)} | ${f(r.build_s)} | ${f(r.rework_s)} | ${f(r.review_s)} | ${f(r.wait_overhead_s)} | ${f(r.total_tokens)} | ${f(r.output_tokens)} | ${f(r.cache_read_tokens)} | ${f(r.cache_write_tokens)} | ${f(r.input_tokens)} |`);
md.push("", "| metric | t1 ON−OFF | t2 ON−OFF | t3 ON−OFF | t1 ratio | t2 ratio | t3 ratio | n pairs | median diff | median ratio |", `|${"---|".repeat(10)}`);
for (const m of METRICS) { const p = pairs[m]; md.push(`| ${m} | ${p.rows.map((r) => f(r.diff)).join(" | ")} | ${p.rows.map((r) => f(r.ratio)).join(" | ")} | ${p.n_pairs} | ${f(p.median_diff)} | ${f(p.median_ratio)} |`); }
writeFileSync(join(BENCH_ROOT, "results", "summary.md"), `${md.join("\n")}\n`);
console.log(md.join("\n"));
