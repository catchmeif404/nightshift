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
  const drates = present(rows.map((r) => (r.detail.total ? r.detail.pass / r.detail.total : null)));
  const pd = drates.length ? mean(drates) : null;
  return {
    cost_cv_median: med, cost_cv_max: worst,
    n_per_arm_cost: Object.fromEntries([0.1, 0.2].map((d) => [`diff_${d * 100}pct`, { by_median_cv: nPerArmForRelativeDiff(med, d), by_max_cv: nPerArmForRelativeDiff(worst, d) }])),
    // pass-rate difference: 20 and 30 points around the mean observed core rate (clamped inside 0..1)
    n_per_arm_pass: p === null ? null : Object.fromEntries([0.2, 0.3].map((d) => [`diff_${d * 100}pt`, nPerArmForProportions(Math.max(0.02, p - d / 2), Math.min(0.98, p + d / 2))])),
    mean_core_rate: p,
    // the core rate sits at the ceiling (about 1), so a difference around it is not estimable: the detail rate is reported too
    mean_detail_rate: pd,
    n_per_arm_pass_detail: pd === null ? null : Object.fromEntries([0.2, 0.3].map((d) => [`diff_${d * 100}pt`, nPerArmForProportions(Math.max(0.02, pd - d / 2), Math.min(0.98, pd + d / 2))])),
  };
}

// replacements.json (private, next to results/): { aliases: {taskId: "A"}, "<newRunId>": { replaces: "<oldRunId>", ... } }
// The replaced runs are harness defects (the harness, not the model or nightshift, ended or never started the session).
export function readReplacements(resultsDir) {
  const f = join(resultsDir, "..", "replacements.json");
  const j = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  const replaced = new Set(Object.values(j).filter((v) => v && typeof v === "object" && "replaces" in v).map((v) => v.replaces));
  return { aliases: j.aliases ?? {}, replaced };
}

export const f2 = (v, d = 2) => (v === null || v === undefined ? "n/a" : v.toFixed(d));

export function table(rows) {
  return ["| task | arm | n | outcomes | core | detail | weighted cost mean | CV | wall s (median) | interventions (mean) | rework (mean) |", `|${"---|".repeat(11)}`,
    ...rows.map((r) => `| ${r.task} | ${r.arm} | ${r.n} | ${JSON.stringify(r.outcomes)} | ${r.core.pass}/${r.core.total} | ${r.detail.pass}/${r.detail.total} | ${f2(r.cost.mean, 0)} (n=${r.cost.n_used}) | ${f2(r.cost.cv)} | ${f2(r.wall_s_median, 0)} | ${f2(r.interventions_mean)} | ${f2(r.rework_mean)} |`)].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? join(PRIVATE_ROOT, "results");
  const outDir = process.argv[3] ?? join(BENCH_ROOT, "results-v2");
  const { aliases, replaced } = readReplacements(dir);
  const all = load(dir).filter((r) => !/^smoke/.test(r.task) && !/^r-smoke/.test(r.anon_id)).map((r) => ({ ...r, task: aliases[r.task] ?? r.task, harness_defect: replaced.has(r.anon_id) }));
  const views = { as_recorded: all, harness_defects_replaced: all.filter((r) => !r.harness_defect) };
  mkdirSync(outDir, { recursive: true });
  const out = {};
  const md = [];
  for (const [name, runs] of Object.entries(views)) {
    const rows = summarize(runs);
    out[name] = { n_runs: runs.length, rows, plan: planPhase2(rows) };
    md.push(`## ${name} (${runs.length} runs)`, "", table(rows), "", `Phase-2 plan input: ${JSON.stringify(out[name].plan)}`, "");
  }
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(out, null, 2)}\n`);
  writeFileSync(join(outDir, "summary.md"), `${md.join("\n")}\n`);
  const csv = ["run,task,arm,outcome,harness_defect,core_pass,core_total,detail_pass,detail_total,weighted_cost,input,output,cache_read,cache_write,total_s,interventions,rework_rounds",
    ...all.sort((a, b) => a.anon_id.localeCompare(b.anon_id)).map((r) => [r.anon_id, r.task, r.arm, r.outcome, r.harness_defect, r.grade?.core.pass ?? "", r.grade?.core.total ?? "", r.grade?.detail.pass ?? "", r.grade?.detail.total ?? "",
      r.weighted_cost ?? "", r.tokens?.input ?? "", r.tokens?.output ?? "", r.tokens?.cache_read ?? "", r.tokens?.cache_write ?? "", r.total_s ?? "", r.interventions?.length ?? "", r.rework_rounds ?? ""].join(","))];
  writeFileSync(join(outDir, "runs.csv"), `${csv.join("\n")}\n`);
  console.log(md.join("\n"));
}
