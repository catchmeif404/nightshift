// Runs the frozen plan of phase 1 sequentially and resumably. Usage: node run-plan-v2.mjs <seed> <taskA,taskB> [maxRuns]
// A cell whose results/<id>/run.json already exists is skipped (finished runs are never repeated). After a `usage_limit`
// outcome the plan waits (default 30 min) and goes on with the NEXT cell; the limited run stays in the data.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { PRIVATE_ROOT, cleanEnv } from "./common.mjs";
import { schedule } from "./schedule-v2.mjs";

const [seed, tasks, maxRuns] = process.argv.slice(2);
const limitWaitMs = Number(process.env.BENCH_LIMIT_WAIT_MIN ?? 30) * 60000;
let started = 0;
for (const cell of schedule(Number(seed), tasks.split(","))) {
  if (existsSync(join(PRIVATE_ROOT, "results", cell.id, "run.json"))) continue;
  if (maxRuns !== undefined && started >= Number(maxRuns)) break;
  started++;
  console.log(new Date().toISOString(), "start", cell.id);
  // wait for the child's EXIT, not for its pipes: a detached grandchild (nightshift daemon) may keep a pipe open for a long time
  const out = [];
  const child = spawn("node", [new URL("./run-v2.mjs", import.meta.url).pathname, cell.task, cell.arm, cell.id], { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  const code = await new Promise((res) => child.on("exit", (c) => res(c ?? -1)));
  console.log(new Date().toISOString(), "end", cell.id, out.join("").trim().split("\n").pop(), code === 0 ? "" : `exit ${code}`);
  const rec = existsSync(join(PRIVATE_ROOT, "results", cell.id, "run.json")) ? JSON.parse(readFileSync(join(PRIVATE_ROOT, "results", cell.id, "run.json"), "utf8")) : { outcome: "no_record" };
  if (rec.outcome === "usage_limit") await new Promise((res) => setTimeout(res, limitWaitMs));
}
console.log("plan pass done");
