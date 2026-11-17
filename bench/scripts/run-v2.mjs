// One phase-1 run of the second comparison. Usage: node run-v2.mjs <taskId> <B0|B2|A2> <anonId>
// Task data is PRIVATE and read from $BENCH_PRIVATE (default ~/.local/share/catchmeif404/nightshift-bench/v2):
//   tasks/<taskId>/task.json   { "repo": "<path to clone>", "base": "<commit>", "request_file": "request.txt" (the person's usual wording),
//                                "ticket_file": "ticket.md" (the real ticket text), "prepare": ["npm","ci"] (optional),
//                                "grade": ["node","<abs path to hidden grader>"] } ; the grader gets the result repo path as argv[2] and
//                                prints one JSON object { "core": {"pass":n,"total":n}, "detail": {"pass":n,"total":n} }.
// Raw results go to $BENCH_PRIVATE/results/<anonId>/ ; nothing about the task or the grader is written into this public repo.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Condition2, MAX_REWORK_V2, MAX_WALL_MS, MODEL, PRIVATE_ROOT, WORK_ROOT_V2, NIGHTSHIFT_CLI, cleanEnv, exec } from "./common.mjs";
import { runInteractive } from "./interactive.mjs";
import { collect } from "./usage.mjs";
import { weightedCost } from "./cost.mjs";

const [taskId, arm, anonId] = process.argv.slice(2);
if (!taskId || !Object.values(Condition2).includes(arm) || !anonId) { console.error("usage: run-v2.mjs <taskId> <B0|B2|A2> <anonId>"); process.exit(2); }
const env = cleanEnv();
const taskDir = join(PRIVATE_ROOT, "tasks", taskId);
const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
const runRoot = join(WORK_ROOT_V2, anonId);
const outDir = join(PRIVATE_ROOT, "results", anonId);
rmSync(runRoot, { recursive: true, force: true });
mkdirSync(runRoot, { recursive: true });
mkdirSync(outDir, { recursive: true });
const repo = join(runRoot, "repo");
const git = (...a) => exec("git", a, { cwd: repo, env, timeoutMs: 60000 });

async function makeRepo() {
  const c = await exec("git", ["clone", "-q", "--no-hardlinks", task.repo, repo], { env, timeoutMs: 120000 });
  if (c.code !== 0) throw new Error(`clone: ${c.stderr}`);
  await git("checkout", "-q", "-B", "main", task.base);
  await git("remote", "remove", "origin"); // nothing can be pushed from a scratch repo
  await git("config", "user.name", "bench");
  await git("config", "user.email", "bench@example.invalid");
  if (task.prepare) {
    const cache = join(PRIVATE_ROOT, "cache", `${taskId}-node_modules`);
    if (existsSync(cache)) cpSync(cache, join(repo, "node_modules"), { recursive: true });
    else {
      const p = await exec(task.prepare[0], task.prepare.slice(1), { cwd: repo, env, timeoutMs: 300000 });
      if (p.code !== 0) throw new Error(`prepare: ${p.stderr.slice(-300)}`);
      mkdirSync(join(PRIVATE_ROOT, "cache"), { recursive: true });
      cpSync(join(repo, "node_modules"), cache, { recursive: true });
    }
  }
}

const record = { anon_id: anonId, task: taskId, arm, model: MODEL, max_wall_s: MAX_WALL_MS / 1000 };
const t0 = Date.now();
record.started_at = new Date(t0).toISOString();

async function runInteractiveArm() {
  const file = join(taskDir, arm === Condition2.B0 ? task.request_file : task.ticket_file);
  const rec = await runInteractive({ cwd: repo, promptFile: file, out: outDir, model: MODEL, baseRef: task.base, maxMin: MAX_WALL_MS / 60000 });
  Object.assign(record, { outcome: rec.outcome, interventions: rec.interventions, unanswered_question: rec.unanswered_question ?? false, stops: rec.stops, wall_s: rec.wall_s ?? null, rework_rounds: null, error: rec.error ?? null, screen_tail: rec.screen_tail ?? null, interactive: rec });
  // snapshot whatever is in the tree so the grader sees one commit range (the person did not have to commit)
  await git("add", "-A");
  await git("commit", "-q", "-m", "bench snapshot", "--allow-empty");
}

async function runNightshift() {
  const q = join(runRoot, "q");
  mkdirSync(q);
  const cli = (...a) => exec("node", [NIGHTSHIFT_CLI, ...a, "--root", q], { cwd: q, env, timeoutMs: 60000 });
  const init = await exec("node", [NIGHTSHIFT_CLI, "init", "--repo-path", repo], { cwd: q, env, timeoutMs: 60000 });
  if (init.code !== 0) throw new Error(`init: ${init.stderr}`);
  const cfgPath = join(q, "nightshift.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  Object.assign(cfg.builder, { model: "sonnet" });
  Object.assign(cfg.reviewer, { model: "opus" });
  Object.assign(cfg, { maxRework: MAX_REWORK_V2, maxSlots: 1, maxStageTries: 1 });
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  // operating rules: the Building/Reviewing parts supplied privately (tasks/<id>/../rules.md); default rules stay if absent
  const rules = join(PRIVATE_ROOT, "rules.md");
  if (existsSync(rules)) cpSync(rules, join(q, "rules.md"));
  const ticket = readFileSync(join(taskDir, task.ticket_file), "utf8");
  const title = ticket.split("\n")[0].replace(/^#+\s*/, "");
  const add = await cli("add", title, "--project", "repo", "--body", ticket);
  if (add.code !== 0) throw new Error(`add: ${add.stderr}`);
  await cli("run");
  const ticketFile = join(q, ".tickets", "T-1.md");
  let status = "ready";
  while (Date.now() - t0 < MAX_WALL_MS) {
    await new Promise((r) => setTimeout(r, 3000));
    status = /^status: (\w+)/m.exec(readFileSync(ticketFile, "utf8"))?.[1] ?? status;
    if (["review", "blocked", "done"].includes(status)) break;
  }
  record.outcome = status === "review" || status === "done" ? "finished" : status === "blocked" ? "blocked" : "timeout";
  if (record.outcome === "timeout") await exec("/bin/sh", ["-c", `pkill -f -- "${runRoot}" || true`], { env });
  record.interventions = [];
  record.error = null;
  await git("checkout", "-q", "-B", "result", "nightshift/t-1").catch(() => undefined);
}

try {
  await makeRepo();
  if (arm === Condition2.A2) await runNightshift(); else await runInteractiveArm();
} catch (e) {
  record.outcome = "error";
  record.error = String(e.message ?? e).slice(0, 400);
}
record.total_s = (Date.now() - t0) / 1000;
const sessions = existsSync(runRoot) ? collect(runRoot) : [];
const sum = (k) => (sessions.length === 0 || sessions.some((s) => s[k] === null) ? null : sessions.reduce((s, x) => s + x[k], 0));
record.tokens = { input: sum("input"), output: sum("output"), cache_read: sum("cache_read"), cache_write: sum("cache_write") };
record.weighted_cost = weightedCost(record.tokens);
record.sessions = sessions.length;
if (arm === Condition2.A2) {
  const builds = new Set(sessions.filter((s) => s.role === "builder").map((s) => s.round)).size;
  record.rework_rounds = sessions.length === 0 ? null : Math.max(0, builds - 1);
}
const g = await exec(task.grade[0], [...task.grade.slice(1), repo], { env, timeoutMs: 300000 });
try { record.grade = JSON.parse(g.stdout.trim().split("\n").pop()); } catch { record.grade = null; record.grade_error = (g.stdout + g.stderr).slice(-300); }
writeFileSync(join(outDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ anonId, outcome: record.outcome, total_s: record.total_s, interventions: record.interventions?.length ?? null, grade: record.grade }));
