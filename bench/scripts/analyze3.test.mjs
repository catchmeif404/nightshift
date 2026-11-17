import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, renderMarkdown, summarizeReviews, summarizeRuns } from "./analyze3.mjs";
import { REVIEW_REPEATS, RUN_REPEATS, argsFor, schedule } from "./schedule-v3.mjs";

const label = (t) => (t === "x" ? "A" : "B");
const stage = (cost, span_s, turns, models = []) => ({ n: 1, cost, span_s, turns, models, tokens: null });
const run = (id, arm, cost, b, r, extra = {}) => ({
  anon_id: id, kind: "run", task: "x", arm, outcome: "finished", total_s: 100, weighted_cost: cost, rework_rounds: 0,
  grade: { core: { pass: 2, total: 2 }, detail: { pass: 4, total: 5 } }, stages: { builder: stage(b, 30, 10, ["claude-sonnet"]), reviewer: stage(r, 60, 6, ["claude-opus"]) }, ...extra,
});
const review = (id, arm, defect, decision, extra = {}) => ({ anon_id: id, kind: "review", task: "x", defect, arm, outcome: "finished", decision, stages: { builder: stage(null, null, null), reviewer: stage(1000, 50, 5) }, ...extra });

test("the schedule has 56 cells, is repeatable and hides the arm in the id", () => {
  const a = schedule(461, ["x", "y"]);
  assert.equal(a.length, 2 * (2 + 4 + 4) + 2 * 3 * 3 * 2);
  assert.deepEqual(a, schedule(461, ["x", "y"]));
  assert.notDeepEqual(a.map((c) => c.id + c.arm), schedule(462, ["x", "y"]).map((c) => c.id + c.arm));
  for (const arm of Object.keys(RUN_REPEATS)) assert.equal(a.filter((c) => c.kind === "run" && c.task === "x" && c.arm === arm).length, RUN_REPEATS[arm]);
  assert.equal(a.filter((c) => c.kind === "review" && c.task === "y" && c.defect === "hidden" && c.arm === "A4").length, REVIEW_REPEATS);
  assert.deepEqual(argsFor({ kind: "review", task: "x", defect: "build", arm: "A3", id: "r3-001" }), ["review", "x", "build", "A3", "r3-001"]);
  assert.ok(a.every((c) => /^r3-\d{3}$/.test(c.id)));
});

test("stage costs, reviewer share and missing values", () => {
  const rows = summarizeRuns([run("r3-001", "A3", 1000, 600, 400), run("r3-002", "A3", 2000, 1200, 800), run("r3-003", "A3", null, null, null, { stages: undefined })], label);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 3);
  assert.equal(rows[0].cost.n_used, 2);
  assert.equal(rows[0].cost.mean, 1500);
  assert.equal(rows[0].reviewer_cost.mean, 600);
  assert.ok(Math.abs(rows[0].reviewer_share - 0.4) < 1e-9);
  assert.deepEqual(rows[0].core, { pass: 6, total: 6, n_used: 3 });
  assert.deepEqual(rows[0].reviewer_models, ["claude-opus"]);
});

test("returned share counts only a first verdict that is not PASS; a reviewer fix is counted apart", () => {
  const s = summarizeReviews([
    review("r3-001", "A2", "build", "returned"), review("r3-002", "A2", "build", "passed"), review("r3-003", "A2", "build", "fixed_and_passed"),
    review("r3-004", "A2", "build", "timeout", { outcome: "timeout" }),
  ], label);
  assert.equal(s.byArm[0].n, 4);
  assert.deepEqual([s.byArm[0].returned, s.byArm[0].fixed_and_passed, s.byArm[0].passed, s.byArm[0].other], [1, 1, 1, 1]);
});

test("harness-defect runs are left out of the valid tables and stay in the recorded ones", () => {
  const runs = [run("r3-001", "A3", 1000, 600, 400), run("r3-002", "A3", 3000, 1800, 1200), review("r3-003", "A4", "hidden", "returned"), review("r3-004", "A4", "hidden", "error", { outcome: "error" })];
  const a = analyze({ runs, baseline: [run("r2-001", "A2-0458", 900, 500, 400)], harnessDefects: { "r3-002": "trust dialog", "r3-004": "tmux" }, label });
  assert.equal(a.runsValid.find((r) => r.arm === "A3").n, 1);
  assert.equal(a.runsAsRecorded.find((r) => r.arm === "A3").n, 2);
  assert.equal(a.reviewsValid.byArm[0].n, 1);
  assert.equal(a.reviewsAsRecorded.byArm[0].n, 2);
  assert.equal(a.counts.harness_defect_runs, 2);
  const md = renderMarkdown(a);
  assert.match(md, /Table 1/);
  assert.match(md, /Table 6/);
});
