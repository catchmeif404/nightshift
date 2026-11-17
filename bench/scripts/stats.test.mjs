import assert from "node:assert/strict";
import { test } from "node:test";
import { cv, mean, nPerArmForProportions, nPerArmForRelativeDiff, rateWindow, sd } from "./stats.mjs";
import { weightedCost } from "./cost.mjs";

test("sd and cv use the sample formula and return null when undefined", () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.equal(sd([2, 4, 6]), 2);
  assert.equal(cv([2, 4, 6]), 0.5);
  assert.equal(sd([5]), null);
  assert.equal(cv([0, 0]), null);
});

test("sample size for a relative difference follows 2(za+zb)^2 cv^2/delta^2", () => {
  // cv 0.25, delta 0.10: 2 * 7.849 * 0.0625 / 0.01 = 98.1 -> 99
  assert.equal(nPerArmForRelativeDiff(0.25, 0.1), 99);
  assert.equal(nPerArmForRelativeDiff(0.25, 0.2), 25);
  assert.equal(nPerArmForRelativeDiff(null, 0.1), null);
});

test("sample size for proportions (0.5 vs 0.8 needs about 36 per arm at 80 % power)", () => {
  assert.equal(nPerArmForProportions(0.5, 0.8), 36);
  assert.equal(nPerArmForProportions(0.5, 0.5), null);
});

test("weightedCost applies the ratios and never fills a missing part", () => {
  assert.equal(weightedCost({ input: 10, output: 2, cache_write: 8, cache_read: 100 }), 10 + 10 + 10 + 10);
  assert.equal(weightedCost({ input: 10, output: null, cache_write: 8, cache_read: 100 }), null);
});

import { schedule } from "./schedule-v2.mjs";
import { planPhase2, summarize } from "./analyze2.mjs";

test("schedule is a seeded permutation of 24 cells, 4 per task x arm", () => {
  const a = schedule(458, ["t1", "t2"]);
  assert.equal(a.length, 24);
  assert.deepEqual(a.map((c) => c.id), schedule(458, ["t1", "t2"]).map((c) => c.id));
  assert.deepEqual(a.map((c) => c.arm), schedule(458, ["t1", "t2"]).map((c) => c.arm));
  for (const t of ["t1", "t2"]) for (const arm of ["B0", "B2", "A2"]) assert.equal(a.filter((c) => c.task === t && c.arm === arm).length, 4);
  assert.notDeepEqual(a.map((c) => c.arm), schedule(7, ["t1", "t2"]).map((c) => c.arm));
});

test("summarize leaves missing cost out and reports n_used; plan uses the CV", () => {
  const run = (arm, cost, pass) => ({ task: "t1", arm, outcome: "finished", weighted_cost: cost, total_s: 100, interventions: [], tokens: { input: 1, output: 1, cache_read: 1, cache_write: 1 }, grade: { core: { pass, total: 2 }, detail: { pass: 0, total: 3 } } });
  const rows = summarize([run("B0", 100, 2), run("B0", 150, 1), run("B0", null, 2), run("A2", 100, 2), run("A2", 100, 2)]);
  const b0 = rows.find((r) => r.arm === "B0");
  assert.equal(b0.cost.n_used, 2);
  assert.equal(b0.cost.mean, 125);
  assert.equal(b0.core.pass, 5);
  assert.equal(rows.find((r) => r.arm === "A2").cost.cv, 0);
  const plan = planPhase2(rows);
  assert.ok(plan.n_per_arm_cost.diff_10pct.by_max_cv > plan.n_per_arm_cost.diff_20pct.by_max_cv);
});

import { test as t2 } from "node:test";
import assert2 from "node:assert/strict";
t2("question dialog regex matches both known footers", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("./interactive.mjs", import.meta.url), "utf8");
  const re = new RegExp(/const QUESTION_DIALOG = \/(.*)\/;/.exec(src)[1]);
  assert2.ok(re.test("  5. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel"));
  assert2.ok(re.test("Enter to select · Tab/Arrow keys to navigate"));
  assert2.ok(!re.test("Do you want to proceed?\n❯ 1. Yes"));
});

test("rate window keeps the full difference near the ceiling", () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  const [a, b] = rateWindow(0.5, 0.2); close(a, 0.4); close(b, 0.6);
  const [c, e] = rateWindow(1, 0.3); close(c, 0.68); close(e, 0.98);
  const [f, g] = rateWindow(0, 0.2); close(f, 0.02); close(g, 0.22);
});
