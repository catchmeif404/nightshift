// Tables of the third comparison (TK-461) from the private raw results. Usage:
//   node analyze3.mjs <taskA>,<taskB> [resultsDir=$BENCH_RESULTS_V3] [outDir=bench/results-v3] [baselineDir=$BENCH_PRIVATE/results]
// Writes runs.csv (one row per full run), reviews.csv (one row per planted-defect review), summary.json and summary.md: aggregates only,
// safe to publish (task names become A and B; no task text, no grader output beyond pass counts).
// The TK-458 A2 runs (baselineDir, arm A2) are the baseline; their stage numbers are recomputed from the Claude logs of their scratch folders.
// Harness-defect runs are listed in <resultsDir>/harness-defects.json ({ "<id>": "reason" }) and reported in a second table, apart from the valid ones.
// Missing values stay null and are left out of means (n_used says how many); nothing is filled with 0 or an estimate.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_ROOT, PRIVATE_ROOT, RESULTS_V3, WORK_ROOT_V2 } from "./common.mjs";
import { collectAt, stagesOf } from "./stages.mjs";
import { cv, mean, sd } from "./stats.mjs";

const present = (xs) => xs.filter((x) => x !== null && x !== undefined);
const median = (xs) => { if (xs.length === 0) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const avg = (xs) => (xs.length ? mean(xs) : null);
const BASELINE = "A2-0458"; // the TK-458 A2 runs, earlier day
export const ARM_ORDER = [BASELINE, "A2", "A3", "A4"];

export function loadRuns(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => /^r3-\d+$/.test(d) && existsSync(join(dir, d, "run.json"))).sort().map((d) => JSON.parse(readFileSync(join(dir, d, "run.json"), "utf8")));
}

// TK-458 A2 runs as records of the same shape (arm A2-0458, kind run), with stages from the logs when they still exist.
export function loadBaseline(dir, workRoot = WORK_ROOT_V2) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => /^r2-\d+$/.test(d) && existsSync(join(dir, d, "run.json")))
    .map((d) => JSON.parse(readFileSync(join(dir, d, "run.json"), "utf8")))
    .filter((r) => r.arm === "A2" && r.outcome === "finished")
    .map((r) => ({ ...r, kind: "run", arm: BASELINE, stages: stagesOf(collectAt(join(workRoot, r.anon_id))) }));
}

const stat = (rs, f) => { const v = present(rs.map(f)); return { n_used: v.length, mean: avg(v), median: median(v) }; };

export function summarizeRuns(runs, label) {
  const keys = [...new Set(runs.map((r) => `${label(r.task)}|${r.arm}`))].sort();
  return keys.map((k) => {
    const [task, arm] = k.split("|");
    const rs = runs.filter((r) => label(r.task) === task && r.arm === arm);
    const cost = present(rs.map((r) => r.weighted_cost));
    const rate = (part) => { const g = rs.filter((r) => r.grade?.[part]); return { pass: g.reduce((s, r) => s + r.grade[part].pass, 0), total: g.reduce((s, r) => s + r.grade[part].total, 0), n_used: g.length }; };
    const outcomes = {};
    for (const r of rs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    return {
      task, arm, n: rs.length, outcomes, core: rate("core"), detail: rate("detail"),
      cost: { ...stat(rs, (r) => r.weighted_cost), sd: sd(cost), cv: cv(cost) },
      builder_cost: stat(rs, (r) => r.stages?.builder.cost ?? null),
      reviewer_cost: stat(rs, (r) => r.stages?.reviewer.cost ?? null),
      reviewer_share: avg(present(rs.map((r) => (r.stages?.reviewer.cost != null && r.weighted_cost ? r.stages.reviewer.cost / r.weighted_cost : null)))),
      reviewer_turns: stat(rs, (r) => r.stages?.reviewer.turns ?? null),
      reviewer_models: [...new Set(rs.flatMap((r) => r.stages?.reviewer.models ?? []))].sort(),
      builder_span_s: stat(rs, (r) => r.stages?.builder.span_s ?? null),
      reviewer_span_s: stat(rs, (r) => r.stages?.reviewer.span_s ?? null),
      wall_s: stat(rs, (r) => r.total_s),
      rework_mean: avg(present(rs.map((r) => r.rework_rounds))),
    };
  });
}

// "Noise rate" of the ticket: the share of planted-defect changes the reviewer sent back (first verdict not PASS).
export function summarizeReviews(reviews, label) {
  const group = (rs) => {
    const count = (d) => rs.filter((r) => r.decision === d).length;
    return {
      n: rs.length, returned: count("returned"), fixed_and_passed: count("fixed_and_passed"), passed: count("passed"),
      other: rs.length - count("returned") - count("fixed_and_passed") - count("passed"),
      reviewer_cost: stat(rs, (r) => r.stages?.reviewer.cost ?? null), reviewer_span_s: stat(rs, (r) => r.stages?.reviewer.span_s ?? null),
      reviewer_turns: stat(rs, (r) => r.stages?.reviewer.turns ?? null),
    };
  };
  const cells = [...new Set(reviews.map((r) => `${label(r.task)}|${r.defect}|${r.arm}`))].sort()
    .map((k) => { const [task, defect, arm] = k.split("|"); return { task, defect, arm, ...group(reviews.filter((r) => label(r.task) === task && r.defect === defect && r.arm === arm)) }; });
  const byArm = [...new Set(reviews.map((r) => r.arm))].sort().map((arm) => ({ arm, ...group(reviews.filter((r) => r.arm === arm)) }));
  const byArmDefect = [...new Set(reviews.map((r) => `${r.defect}|${r.arm}`))].sort()
    .map((k) => { const [defect, arm] = k.split("|"); return { defect, arm, ...group(reviews.filter((r) => r.defect === defect && r.arm === arm)) }; });
  return { cells, byArm, byArmDefect };
}

const f0 = (v) => (v === null || v === undefined ? "n/a" : Math.round(v).toLocaleString("en-US"));
const f2 = (v) => (v === null || v === undefined ? "n/a" : v.toFixed(2));
const pct = (v) => (v === null || v === undefined ? "n/a" : `${Math.round(v * 100)} %`);
const rate = (r) => (r.total === 0 ? "n/a" : `${r.pass}/${r.total}`);

export function runsTable(rows) {
  const head = "| task | arm | n | outcomes | core | detail | cost mean (CV) | builder cost | reviewer cost | reviewer share | reviewer turns | wall s median | builder s median | reviewer s median | rework mean |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const line = (s) => `| ${s.task} | ${s.arm} | ${s.n} | ${Object.entries(s.outcomes).map(([k, v]) => `${k} ${v}`).join(", ")} | ${rate(s.core)} | ${rate(s.detail)} | ${f0(s.cost.mean)} (${f2(s.cost.cv)}) | ${f0(s.builder_cost.mean)} | ${f0(s.reviewer_cost.mean)} | ${pct(s.reviewer_share)} | ${f2(s.reviewer_turns.mean)} | ${f0(s.wall_s.median)} | ${f0(s.builder_span_s.median)} | ${f0(s.reviewer_span_s.median)} | ${f2(s.rework_mean)} |`;
  return [head, ...rows.map(line)].join("\n");
}

export function reviewsTable(rows, first) {
  const head = `| ${first.join(" | ")} | n | returned | fixed and passed | passed | other | returned share | reviewer cost mean | reviewer s mean | reviewer turns mean |\n|${first.map(() => "---").join("|")}|---|---|---|---|---|---|---|---|---|`;
  const line = (r) => `| ${first.map((k) => r[k]).join(" | ")} | ${r.n} | ${r.returned} | ${r.fixed_and_passed} | ${r.passed} | ${r.other} | ${pct(r.n ? r.returned / r.n : null)} | ${f0(r.reviewer_cost.mean)} | ${f0(r.reviewer_span_s.mean)} | ${f2(r.reviewer_turns.mean)} |`;
  return [head, ...rows.map(line)].join("\n");
}

const csv = (rows, cols) => [cols.join(","), ...rows.map((r) => cols.map((c) => { const v = c.split(".").reduce((o, k) => o?.[k], r); return v === null || v === undefined ? "" : String(v); }).join(","))].join("\n") + "\n";

export function analyze({ runs, baseline, harnessDefects, label }) {
  const fullRuns = runs.filter((r) => r.kind === "run");
  const reviews = runs.filter((r) => r.kind === "review");
  const bad = (r) => Object.hasOwn(harnessDefects, r.anon_id);
  const validRuns = [...baseline, ...fullRuns.filter((r) => !bad(r))];
  const allRuns = [...baseline, ...fullRuns];
  return {
    runsValid: summarizeRuns(validRuns, label), runsAsRecorded: summarizeRuns(allRuns, label),
    reviewsValid: summarizeReviews(reviews.filter((r) => !bad(r)), label), reviewsAsRecorded: summarizeReviews(reviews, label),
    harnessDefects, counts: { full_runs: fullRuns.length, reviews: reviews.length, baseline: baseline.length, harness_defect_runs: [...fullRuns, ...reviews].filter(bad).length },
    validRuns, allRuns, reviews,
  };
}

export function renderMarkdown(a) {
  const defectIds = Object.keys(a.harnessDefects);
  return [
    "# TK-461 results (generated by `node scripts/analyze3.mjs`)", "",
    `Full runs ${a.counts.full_runs} (+ ${a.counts.baseline} TK-458 A2 baseline runs), review runs ${a.counts.reviews}, harness-defect runs ${a.counts.harness_defect_runs}${defectIds.length ? ` (${defectIds.join(", ")})` : ""}.`, "",
    "## Table 1: full runs, harness-defect runs left out", "", runsTable(a.runsValid), "",
    "## Table 2: full runs, as recorded (harness-defect runs included)", "", runsTable(a.runsAsRecorded), "",
    "## Table 3: planted-defect reviews per task, defect and arm (harness-defect runs left out)", "", reviewsTable(a.reviewsValid.cells, ["task", "defect", "arm"]), "",
    "## Table 4: planted-defect reviews per defect and arm", "", reviewsTable(a.reviewsValid.byArmDefect, ["defect", "arm"]), "",
    "## Table 5: planted-defect reviews per arm", "", reviewsTable(a.reviewsValid.byArm, ["arm"]), "",
    "## Table 6: planted-defect reviews per arm, as recorded", "", reviewsTable(a.reviewsAsRecorded.byArm, ["arm"]), "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tasks, resultsDir = RESULTS_V3, outDir = join(BENCH_ROOT, "results-v3"), baselineDir = join(PRIVATE_ROOT, "results")] = process.argv.slice(2);
  const [ta, tb] = tasks.split(",");
  const label = (t) => (t === ta ? "A" : t === tb ? "B" : t);
  const defectsFile = join(resultsDir, "harness-defects.json");
  const a = analyze({ runs: loadRuns(resultsDir), baseline: loadBaseline(baselineDir), harnessDefects: existsSync(defectsFile) ? JSON.parse(readFileSync(defectsFile, "utf8")) : {}, label });
  mkdirSync(outDir, { recursive: true });
  const rowOf = (r) => ({ ...r, task: label(r.task), harness_defect: Object.hasOwn(a.harnessDefects, r.anon_id) });
  writeFileSync(join(outDir, "runs.csv"), csv(a.allRuns.map(rowOf), ["anon_id", "task", "arm", "outcome", "harness_defect", "total_s", "weighted_cost", "tokens.input", "tokens.output", "tokens.cache_read", "tokens.cache_write", "rework_rounds", "grade.core.pass", "grade.core.total", "grade.detail.pass", "grade.detail.total", "stages.builder.cost", "stages.builder.span_s", "stages.builder.turns", "stages.reviewer.cost", "stages.reviewer.span_s", "stages.reviewer.turns", "stages.reviewer.models"]));
  writeFileSync(join(outDir, "reviews.csv"), csv(a.reviews.map(rowOf), ["anon_id", "task", "defect", "arm", "outcome", "harness_defect", "first_verdict", "decision", "reviewer_commits", "total_s", "stages.reviewer.cost", "stages.reviewer.span_s", "stages.reviewer.turns", "stages.reviewer.models"]));
  const { validRuns, allRuns, reviews, ...summary } = a;
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outDir, "summary.md"), renderMarkdown(a));
  console.log(renderMarkdown(a));
}
