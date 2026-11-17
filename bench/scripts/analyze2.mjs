// Phase-1 tables from private raw results. Usage: node analyze2.mjs [resultsDir] [outDir]
//   resultsDir default $BENCH_PRIVATE/results (run.json per run), outDir default bench/results-v2 (aggregates only, safe to publish).
// Per task x arm: n, outcomes, core/detail pass rate, weighted cost mean/sd/CV, median wall seconds, interventions, rework.
// Then the phase-2 sample sizes from the observed CV (cost, 10 % and 20 % differences) and from pass rates.
// Missing values stay null and are left out of means (the count n_used says how many); nothing is filled with 0 or an estimate.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_ROOT, PRIVATE_ROOT } from "./common.mjs";
import { cv, mean, nPerArmForProportions, nPerArmForRelativeDiff, sd } from "./stats.mjs";

export function load(dir) {
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, "run.json"))).map((d) => JSON.parse(readFileSync(join(dir, d, "run.json"), "utf8")));
}
const present = (xs) => xs.filter((x) => x !== null && x !== undefined);
const median = (xs) => { if (xs.length === 0) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function summarize(runs) {
  const keys = [...new Set(runs.map((r) => `${r.task}|${r.arm}`))].sort();
  return keys.map((k) => {
    const [task, arm] = k.split("|");
    const rs = runs.filter((r) => r.task === task && r.arm === arm);
    const cost = present(rs.map((r) => r.weighted_cost));
    const rate = (part) => {
      const g = rs.filter((r) => r.grade?.[part]);
      const total = g.reduce((s, r) => s + r.grade[part].total, 0);
      return { pass: g.reduce((s, r) => s + r.grade[part].pass, 0), total, n_used: g.length };
    };
    const outcomes = {};
    for (const r of rs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    const col = (f) => present(rs.map(f));
    return {
      task, arm, n: rs.length, outcomes, core: rate("core"), detail: rate("detail"),
      cost: { n_used: cost.length, mean: cost.length ? mean(cost) : null, sd: sd(cost), cv: cv(cost) },
      wall_s_median: median(col((r) => r.total_s)),
      interventions_mean: col((r) => r.interventions?.length ?? null).length ? mean(col((r) => r.interventions?.length ?? null)) : null,
      rework_mean: col((r) => r.rework_rounds).length ? mean(col((r) => r.rework_rounds)) : null,
      raw_tokens_mean: Object.fromEntries(["input", "output", "cache_read", "cache_write"].map((t) => { const v = col((r) => r.tokens?.[t] ?? null); return [t, v.length ? mean(v) : null]; })),
    };
  });
}

export function planPhase2(rows) {
  const cvs = present(rows.map((r) => r.cost.cv));
  const worst = cvs.length ? Math.max(...cvs) : null;
  const med = median(cvs);
  const rates = present(rows.map((r) => (r.core.total ? r.core.pass / r.core.total : null)));
  const p = rates.length ? mean(rates) : null;
  return {
    cost_cv_median: med, cost_cv_max: worst,
    n_per_arm_cost: Object.fromEntries([0.1, 0.2].map((d) => [`diff_${d * 100}pct`, { by_median_cv: nPerArmForRelativeDiff(med, d), by_max_cv: nPerArmForRelativeDiff(worst, d) }])),
    // pass-rate difference: 20 and 30 points around the mean observed core rate (clamped inside 0..1)
    n_per_arm_pass: p === null ? null : Object.fromEntries([0.2, 0.3].map((d) => [`diff_${d * 100}pt`, nPerArmForProportions(Math.max(0.02, p - d / 2), Math.min(0.98, p + d / 2))])),
    mean_core_rate: p,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? join(PRIVATE_ROOT, "results");
  const outDir = process.argv[3] ?? join(BENCH_ROOT, "results-v2");
  const runs = load(dir).filter((r) => !/^smoke/.test(r.task));
  const rows = summarize(runs);
  const plan = planPhase2(rows);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify({ n_runs: runs.length, rows, plan }, null, 2)}\n`);
  const f = (v, d = 2) => (v === null || v === undefined ? "n/a" : v.toFixed(d));
  const md = ["| task | arm | n | outcomes | core | detail | weighted cost mean | CV | wall s (median) | interventions (mean) | rework (mean) |", `|${"---|".repeat(11)}`,
    ...rows.map((r) => `| ${r.task} | ${r.arm} | ${r.n} | ${JSON.stringify(r.outcomes)} | ${r.core.pass}/${r.core.total} | ${r.detail.pass}/${r.detail.total} | ${f(r.cost.mean, 0)} (n=${r.cost.n_used}) | ${f(r.cost.cv)} | ${f(r.wall_s_median, 0)} | ${f(r.interventions_mean)} | ${f(r.rework_mean)} |`),
    "", `Phase-2 plan input: ${JSON.stringify(plan)}`, ""].join("\n");
  writeFileSync(join(outDir, "summary.md"), md);
  console.log(md);
}
