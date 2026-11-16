// After run-one: collect usage from raw logs, grade (arm-blind), write results/raw/<anonId>.json and results/usage/<anonId>.jsonl.
// Usage: node finish-run.mjs <anonId>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_ROOT, Role, WORK_ROOT } from "./common.mjs";
import { grade } from "./grade.mjs";
import { collect } from "./usage.mjs";

const anonId = process.argv[2];
const run = JSON.parse(readFileSync(join(BENCH_ROOT, "results", "runs", `${anonId}.json`), "utf8"));
const sessions = collect(join(WORK_ROOT, anonId));
const g = await grade(run.repo, run.branch, run.task);
const { patch, ...gradeNoPatch } = g;

const spans = (pred) => sessions.filter(pred).reduce((s, x) => s + (x.span_s ?? 0), 0);
const sumTok = (k) => (sessions.length === 0 || sessions.some((s) => s[k] === null) ? null : sessions.reduce((s, x) => s + x[k], 0));
const buildRounds = new Set(sessions.filter((s) => s.role === Role.Builder).map((s) => s.round)).size;
const tokens = { input: sumTok("input"), output: sumTok("output"), cache_read: sumTok("cache_read"), cache_write: sumTok("cache_write") };
const totalTokens = Object.values(tokens).some((v) => v === null) ? null : Object.values(tokens).reduce((a, b) => a + b, 0);
const build = spans((s) => s.role === Role.Builder && s.round === 1);
const rework = spans((s) => s.role === Role.Builder && s.round > 1);
const review = spans((s) => s.role === Role.Reviewer);
const completed = run.outcome === "pass" && g.committed;
const out = {
  anon_id: anonId, task: run.task, condition: run.condition, outcome: run.outcome, error: run.error ?? null,
  models: [...new Set(sessions.flatMap((s) => s.models))],
  sessions: sessions.map(({ rows, ...r }) => r),
  tokens: { ...tokens, total: totalTokens },
  seconds: { total: run.total_s, build, rework, review, wait_overhead: run.total_s - (build + rework + review) },
  build_rounds: buildRounds, rework_rounds: Math.max(0, buildRounds - 1),
  completed, accepted_by_grader: completed && g.hidden_pass === g.hidden_total && !g.critical_defect && g.scope_ok,
  quality: gradeNoPatch,
};
mkdirSync(join(BENCH_ROOT, "results", "raw"), { recursive: true });
mkdirSync(join(BENCH_ROOT, "results", "usage"), { recursive: true });
writeFileSync(join(BENCH_ROOT, "results", "raw", `${anonId}.json`), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(join(BENCH_ROOT, "results", "raw", `${anonId}.patch`), patch);
writeFileSync(join(BENCH_ROOT, "results", "usage", `${anonId}.jsonl`),
  sessions.flatMap((s, i) => s.rows.map((r) => JSON.stringify({ session: i + 1, role: s.role, round: s.round, ...r }))).join("\n") + "\n");
console.log(JSON.stringify({ anonId, outcome: out.outcome, completed, hidden: `${g.hidden_pass}/${g.hidden_total}`, tokens: out.tokens }));
