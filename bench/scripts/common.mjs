import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BENCH_ROOT = new URL("..", import.meta.url).pathname;
export const WORK_ROOT = process.env.BENCH_WORK ?? "/tmp/ns-bench";
export const NIGHTSHIFT_CLI = process.env.NIGHTSHIFT_CLI ?? join(homedir(), ".local/share/nightshift/app/dist/src/cli.js");
export const MODEL = "sonnet";
export const PERMISSION_MODE = "auto";
export const MAX_REWORK = 2;
export const MAX_WALL_MS = 20 * 60 * 1000;

export const Condition = { On: "ON", Off: "OFF" };
export const Role = { Builder: "builder", Reviewer: "reviewer" };
export const Outcome = { Pass: "pass", Blocked: "blocked", Timeout: "timeout", Error: "error" };

export const ALLOWED_FILES = {
  t1: ["src/csv.js", "test/csv.test.js"],
  t2: ["src/store.js", "test/store.test.js"],
  t3: ["src/items.js", "src/cli.js", "test/items.test.js", "test/cli.test.js"],
};

const PARENT_SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_|CODEX_)/;
export function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!PARENT_SESSION_VARS.test(k)) env[k] = v;
  return { ...env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
}

// Runs a command; resolves { code, stdout, stderr, timedOut }. Kills the whole process group at timeoutMs.
export function exec(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e), timedOut }));
  });
}

export const encodeProjectDir = (path) => path.replace(/[^A-Za-z0-9]/g, "-");

export function sessionFiles(runRootReal) {
  const projects = join(homedir(), ".claude", "projects");
  if (!existsSync(projects)) return [];
  const prefix = encodeProjectDir(runRootReal);
  return readdirSync(projects)
    .filter((d) => d.startsWith(prefix))
    .flatMap((d) => readdirSync(join(projects, d)).filter((f) => f.endsWith(".jsonl")).map((f) => join(projects, d, f)));
}

export function readJsonl(file) {
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => {
    try { return JSON.parse(l); } catch { return undefined; }
  }).filter((x) => x !== undefined);
}
