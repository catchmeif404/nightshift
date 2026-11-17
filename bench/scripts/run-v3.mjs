// One run of the third comparison (TK-461). Needs the private task data of TK-458 ($BENCH_PRIVATE, see run-v2.mjs).
//   node run-v3.mjs run    <taskId> <A2|A3|A4> <anonId>            a full nightshift run on the real ticket (builder sonnet), graded
//   node run-v3.mjs review <taskId> <build|missing|hidden> <A2|A3|A4> <anonId>
//        a planted-defect change ($BENCH_PRIVATE/tasks/<taskId>/defects/<defect>.patch, a patch against the task's start commit)
//        goes to the arm's reviewer; plant-builder.mjs stands in for the developer (no model call). Records what the reviewer decided.
// Arms (all builder sonnet, maxRework 1): A2 reviewer opus; A3 reviewer opus + reviewHandoff; A4 reviewer sonnet.
// nightshift is this repository's build (NIGHTSHIFT_CLI, default ../../dist/src/cli.js); with the handoff off its prompts are the same as 0.2.0's.
// Raw results go to $BENCH_RESULTS_V3/<anonId>/run.json (private); nothing about the task or the grader is written into this repository.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARM3, Condition3, Defect, MAX_REVIEW_WALL_MS, MAX_WALL_MS, MODEL, NIGHTSHIFT_CLI_V3, PRIVATE_ROOT, RESULTS_V3, WORK_ROOT_V3, cleanEnv, exec } from "./common.mjs";
import { collectAt, stagesOf } from "./stages.mjs";
import { weightedCost } from "./cost.mjs";

const [kind, ...rest] = process.argv.slice(2);
const isReview = kind === "review";
const [taskId, defect, arm, anonId] = isReview ? rest : [rest[0], undefined, rest[1], rest[2]];
const usage = "usage: run-v3.mjs run <task> <A2|A3|A4> <id> | review <task> <build|missing|hidden> <A2|A3|A4> <id>";
if ((kind !== "run" && !isReview) || !taskId || !Object.values(Condition3).includes(arm) || !anonId || (isReview && !Object.values(Defect).includes(defect))) { console.error(usage); process.exit(2); }

const env = cleanEnv();
const taskDir = join(PRIVATE_ROOT, "tasks", taskId);
const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
const runRoot = join(WORK_ROOT_V3, anonId);
const outDir = join(RESULTS_V3, anonId);
rmSync(runRoot, { recursive: true, force: true });
mkdirSync(runRoot, { recursive: true });
mkdirSync(outDir, { recursive: true });
const repo = join(runRoot, "repo");
const q = join(runRoot, "q");
const git = (...a) => exec("git", a, { cwd: repo, env, timeoutMs: 60000 });
const maxWall = isReview ? MAX_REVIEW_WALL_MS : MAX_WALL_MS;

async function makeRepo() {
  const c = await exec("git", ["clone", "-q", "--no-hardlinks", task.repo, repo], { env, timeoutMs: 120000 });
  if (c.code !== 0) throw new Error(`clone: ${c.stderr}`);
  await git("checkout", "-q", "-B", "main", task.base);
  await git("remote", "remove", "origin"); // nothing can be pushed from a scratch repo
  await git("config", "user.name", "bench");
  await git("config", "user.email", "bench@example.invalid");
}

const record = { anon_id: anonId, kind, task: taskId, defect: defect ?? null, arm, model: MODEL, reviewer_model: ARM3[arm].reviewer, review_handoff: ARM3[arm].handoff, max_wall_s: maxWall / 1000 };
const t0 = Date.now();
record.started_at = new Date(t0).toISOString();

function findLog(dir) {
  for (const f of readdirSync(dir, { recursive: true })) if (String(f).endsWith("nightshift.log")) return join(dir, String(f));
  return "";
}

async function runNightshift() {
  mkdirSync(q);
  const cli = (...a) => exec("node", [NIGHTSHIFT_CLI_V3, ...a, "--root", q], { cwd: q, env, timeoutMs: 60000 });
  const init = await exec("node", [NIGHTSHIFT_CLI_V3, "init", "--repo-path", repo], { cwd: q, env, timeoutMs: 60000 });
  if (init.code !== 0) throw new Error(`init: ${init.stderr}`);
  const cfgPath = join(q, "nightshift.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  Object.assign(cfg.builder, isReview ? { type: "command", command: new URL("./plant-builder.mjs", import.meta.url).pathname, model: "planted" } : { model: "sonnet" });
  Object.assign(cfg.reviewer, { model: ARM3[arm].reviewer });
  Object.assign(cfg, { maxRework: 1, maxSlots: 1, maxStageTries: 1 });
  if (ARM3[arm].handoff) cfg.reviewHandoff = true;
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  const rules = join(PRIVATE_ROOT, "rules.md");
  if (existsSync(rules)) cpSync(rules, join(q, "rules.md"));
  const ticket = readFileSync(join(taskDir, task.ticket_file), "utf8");
  const title = ticket.split("\n")[0].replace(/^#+\s*/, "");
  const add = await cli("add", title, "--project", "repo", "--body", ticket);
  if (add.code !== 0) throw new Error(`add: ${add.stderr}`);
  if (isReview) process.env.PLANT_PATCH = join(taskDir, "defects", `${defect}.patch`);
  await exec("node", [NIGHTSHIFT_CLI_V3, "run", "--root", q], { cwd: q, env: { ...env, ...(isReview ? { PLANT_PATCH: process.env.PLANT_PATCH } : {}) }, timeoutMs: 60000 });
  const ticketFile = join(q, ".tickets", "T-1.md");
  let status = "ready";
  while (Date.now() - t0 < maxWall) {
    await new Promise((r) => setTimeout(r, 3000));
    status = /^status: (\w+)/m.exec(readFileSync(ticketFile, "utf8"))?.[1] ?? status;
    if (["review", "blocked", "done"].includes(status)) break;
  }
  record.status = status;
  record.outcome = status === "review" || status === "done" ? "finished" : status === "blocked" ? "blocked" : "timeout";
  if (record.outcome === "timeout") await exec("/bin/sh", ["-c", `pkill -f -- "${runRoot}" || true`], { env });
  const log = findLog(q);
  record.verdicts = log === "" ? [] : [...readFileSync(log, "utf8").matchAll(/verdict r(\d+): (\w+)/g)].map((m) => ({ round: Number(m[1]), verdict: m[2] }));
  record.error = null;
  // The account's usage limit stopped the run (nightshift logs "usage limit ... waiting"): not the model's or nightshift's result.
  if (log !== "" && /dispatch: usage limit/.test(readFileSync(log, "utf8"))) { record.usage_limit = true; record.error = "usage limit"; if (record.outcome === "timeout") record.outcome = "usage_limit"; }
  await git("checkout", "-q", "-B", "result", "nightshift/t-1").catch(() => undefined);
}

try {
  await makeRepo();
  await runNightshift();
} catch (e) {
  record.outcome = "error";
  record.error = String(e.message ?? e).slice(0, 400);
}
record.total_s = (Date.now() - t0) / 1000;
const sessions = existsSync(runRoot) ? collectAt(runRoot) : [];
const sum = (k) => (sessions.length === 0 || sessions.some((s) => s[k] === null) ? null : sessions.reduce((s, x) => s + x[k], 0));
record.tokens = { input: sum("input"), output: sum("output"), cache_read: sum("cache_read"), cache_write: sum("cache_write") };
record.weighted_cost = weightedCost(record.tokens);
record.sessions = sessions.length;
record.stages = stagesOf(sessions);

if (isReview) {
  // Sent back = the first review's verdict is anything but PASS. A pass with extra commits on the branch = the reviewer fixed it itself.
  const first = record.verdicts?.find((v) => v.round === 1)?.verdict ?? null;
  const commits = Number((await git("rev-list", "--count", `main..nightshift/t-1`)).stdout.trim());
  record.first_verdict = first;
  record.reviewer_commits = Number.isFinite(commits) ? Math.max(0, commits - 1) : null;
  record.decision = record.outcome === "error" || record.outcome === "timeout" ? record.outcome
    : first === null ? "no_verdict"
    : first !== "PASS" ? "returned"
    : record.reviewer_commits > 0 ? "fixed_and_passed" : "passed";
} else {
  const builds = new Set(sessions.filter((s) => s.role === "builder").map((s) => s.round)).size;
  record.rework_rounds = sessions.length === 0 ? null : Math.max(0, builds - 1);
  const g = await exec(task.grade[0], [...task.grade.slice(1), repo], { env, timeoutMs: 300000 });
  try { record.grade = JSON.parse(g.stdout.trim().split("\n").pop()); } catch { record.grade = null; record.grade_error = (g.stdout + g.stderr).slice(-300); }
}
writeFileSync(join(outDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ anonId, kind, outcome: record.outcome, total_s: record.total_s, decision: record.decision ?? null, grade: record.grade ?? null }));
