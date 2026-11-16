// One measured run. Usage: node run-one.mjs <task t1|t2|t3> <ON|OFF> <anonId>
// Writes bench/results/runs/<anonId>.json (arm + timings + sessions) and results/usage/<anonId>.jsonl (de-duplicated usage rows).
// Grading is a separate, arm-blind step (grade.mjs) run by finish-run.mjs.
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_ROOT, Condition, MAX_REWORK, MAX_WALL_MS, MODEL, NIGHTSHIFT_CLI, Outcome, PERMISSION_MODE, WORK_ROOT, cleanEnv, exec } from "./common.mjs";
import { collect } from "./usage.mjs";

const [task, condition, anonId] = process.argv.slice(2);
if (!["t1", "t2", "t3"].includes(task) || !Object.values(Condition).includes(condition) || anonId === undefined) {
  console.error("usage: run-one.mjs <t1|t2|t3> <ON|OFF> <anonId>");
  process.exit(2);
}
const env = cleanEnv();
const runRoot = join(WORK_ROOT, anonId);
rmSync(runRoot, { recursive: true, force: true });
mkdirSync(runRoot, { recursive: true });
const repo = join(runRoot, "repo");

const raw = readFileSync(join(BENCH_ROOT, "tasks", `${task}.md`), "utf8");
const title = /^title: (.+)$/m.exec(raw)[1];
const body = raw.split("\n---\n")[1].trim();

async function git(...args) {
  const r = await exec("git", args, { cwd: repo, env });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

async function makeRepo() {
  cpSync(join(BENCH_ROOT, "fixture"), repo, { recursive: true });
  await exec("git", ["init", "-q", "-b", "main", repo], { env });
  await git("config", "user.name", "bench");
  await git("config", "user.email", "bench@example.invalid");
  await git("add", "-A");
  await git("commit", "-q", "-m", "fixture");
}

const record = { anon_id: anonId, task, condition, model_alias: MODEL, permission_mode: PERMISSION_MODE, max_rework: MAX_REWORK, max_wall_s: MAX_WALL_MS / 1000 };
const t0 = Date.now();
record.started_at = new Date(t0).toISOString();
const remaining = () => Math.max(1000, MAX_WALL_MS - (Date.now() - t0));

async function runOn() {
  const q = join(runRoot, "q");
  mkdirSync(q);
  const cli = (...args) => exec("node", [NIGHTSHIFT_CLI, ...args, "--root", q], { cwd: q, env, timeoutMs: 60000 });
  const init = await exec("node", [NIGHTSHIFT_CLI, "init", "--repo-path", repo], { cwd: q, env, timeoutMs: 60000 });
  if (init.code !== 0) throw new Error(`init: ${init.stderr}`);
  const cfgPath = join(q, "nightshift.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.reviewer.model = MODEL;
  cfg.builder.model = MODEL;
  cfg.maxRework = MAX_REWORK;
  cfg.maxSlots = 1;
  cfg.maxStageTries = 1;
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  const add = await cli("add", title, "--project", "repo", "--body", body);
  if (add.code !== 0) throw new Error(`add: ${add.stderr}`);
  const started = Date.now();
  const run = await cli("run");
  record.run_stdout = run.stdout.slice(-400);
  const ticketFile = join(q, ".tickets", "T-1.md");
  let status = "ready";
  while (Date.now() - t0 < MAX_WALL_MS) {
    await new Promise((r) => setTimeout(r, 3000));
    status = /^status: (\w+)/m.exec(readFileSync(ticketFile, "utf8"))?.[1] ?? status;
    if (["review", "blocked", "done"].includes(status)) break;
  }
  record.dispatch_started_after_s = (started - t0) / 1000;
  if (!["review", "blocked", "done"].includes(status)) {
    record.outcome = Outcome.Timeout;
    const st = await cli("status");
    record.status_at_timeout = st.stdout.slice(-600);
    // kill only this run's worker: its pid file lives under this run's queue folder
    const pids = await exec("/bin/sh", ["-c", `pgrep -f -- "${q}" || true`], { env });
    for (const pid of pids.stdout.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    await exec("/bin/sh", ["-c", `pkill -f -- "${runRoot}" || true`], { env });
  } else {
    record.outcome = status === "blocked" ? Outcome.Blocked : Outcome.Pass;
  }
  record.ticket_notes = readFileSync(ticketFile, "utf8").split("\n").slice(-12).join("\n");
  record.branch = "nightshift/t-1";
}

const DEV_PROMPT = (round, notes) => `You are the developer for this ticket, round ${round}. You work alone and unattended: nobody will answer questions.

## Ticket ${task.toUpperCase()}: ${title}

${body}
${notes === "" ? "" : `\n## Review notes from the previous round (fix these first)\n\n${notes}\n`}
## How to work
- Your working directory is a git worktree on branch \`bench/${task}\`. Work only here.
- Read the repository's own instructions (README.md) first.
- Do not use subagents. Keep the change to what the ticket asks. Run the tests (\`npm test\`).
- Commit your work on the branch with a Conventional Commits message. Do not merge.
`;
const REV_PROMPT = (round, last) => `You are the reviewer for this ticket, round ${round}. A separate developer run built it. You work unattended.

## Ticket ${task.toUpperCase()}: ${title}

${body}

## What to review
Your working directory is the ticket's worktree on branch \`bench/${task}\`; compare it with \`main\`.
- Read the whole change against the ticket. Check: it does what the ticket asks and nothing more; correctness and edge cases; security; tests.
- Run the tests yourself. Do not trust a claim that tests pass.
- Small problems: fix them yourself on the branch, rerun the tests and commit.
${last ? "- This is the last round. Small problems you fix yourself. If it is still not right, say so and give the verdict REWORK." : "- Bigger problems (wrong approach, missing pieces): do not fix them. List the findings for the developer (what is wrong, where, what done looks like) and give the verdict REWORK."}
- Do not use subagents. Never merge.

End your answer with exactly one line: \`VERDICT: PASS\` or \`VERDICT: REWORK\`.
`;

async function claude(prompt, cwd) {
  const args = ["-p", prompt, "--model", MODEL, "--permission-mode", PERMISSION_MODE, "--disallowedTools", "Agent", "--output-format", "text", "--session-id", randomUUID()];
  return exec("claude", args, { cwd, env, timeoutMs: remaining() });
}

async function runOff() {
  const work = join(runRoot, "work");
  await git("worktree", "add", "-q", "-b", `bench/${task}`, work, "main");
  let notes = "";
  record.outcome = Outcome.Blocked;
  for (let round = 1; round <= MAX_REWORK + 1; round++) {
    const build = await claude(DEV_PROMPT(round, notes), work);
    if (build.timedOut) { record.outcome = Outcome.Timeout; break; }
    if (build.code !== 0) { record.outcome = Outcome.Error; record.error = (build.stdout + build.stderr).slice(-300); break; }
    const review = await claude(REV_PROMPT(round, round > MAX_REWORK), work);
    if (review.timedOut) { record.outcome = Outcome.Timeout; break; }
    if (review.code !== 0) { record.outcome = Outcome.Error; record.error = (review.stdout + review.stderr).slice(-300); break; }
    const verdict = /VERDICT:\s*(PASS|REWORK)\s*$/m.exec(review.stdout.trim().split("\n").slice(-3).join("\n"))?.[1];
    record.last_review_tail = review.stdout.slice(-300);
    if (verdict === "PASS") { record.outcome = Outcome.Pass; break; }
    notes = review.stdout.trim();
  }
  record.branch = `bench/${task}`;
}

try {
  await makeRepo();
  if (condition === Condition.On) await runOn(); else await runOff();
} catch (e) {
  record.outcome = Outcome.Error;
  record.error = String(e.message ?? e).slice(0, 400);
}
const t1 = Date.now();
record.ended_at = new Date(t1).toISOString();
record.total_s = (t1 - t0) / 1000;
record.repo = repo;
mkdirSync(join(BENCH_ROOT, "results", "runs"), { recursive: true });
writeFileSync(join(BENCH_ROOT, "results", "runs", `${anonId}.json`), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ anonId, outcome: record.outcome, total_s: record.total_s, error: record.error }));
