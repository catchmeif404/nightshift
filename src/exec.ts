import { spawn, spawnSync } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TimedExecResult extends ExecResult {
  timedOut: boolean;
  // Processes still alive in the run's process group when it ended, killed by the runner (0: none were left).
  cleaned: number;
}

export interface ExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
}

const NOT_FOUND = 127;
const MS_PER_MINUTE = 60_000;

// Kills what is left in a process group after its leader exited (a dev server the agent started, a background job)
// and returns how many processes that was. Called only after the run has finished, so its results are already written.
export function killGroup(pgid: number): number {
  const listing = spawnSync("ps", ["-A", "-o", "pgid=,pid="], { encoding: "utf8" });
  const left = listing.status === 0 ? listing.stdout.split("\n").filter((l) => Number.parseInt(l.trim().split(/\s+/)[0] ?? "", 10) === pgid).length : 0;
  if (left === 0) return 0;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    return 0;
  }
  return left;
}

// timeoutMs 0: no limit. The child always runs in its own process group, so the whole tree can be killed when the
// limit passes, and (ownGroup) whatever it left running is killed when it ends.
function spawnCollect(command: string, args: string[], options: ExecOptions, timeoutMs: number, ownGroup: boolean): Promise<TimedExecResult> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: ownGroup || timeoutMs > 0 });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let cleaned = 0;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }, timeoutMs)
        : undefined;
    if (ownGroup) {
      // "exit", not "close": a leftover process holding the output pipes would keep "close" from ever firing.
      child.on("exit", () => {
        if (child.pid !== undefined) cleaned = killGroup(child.pid);
      });
    }
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: NOT_FOUND, stdout: "", stderr: error.message, timedOut, cleaned });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut, cleaned });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}

export async function exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  const { code, stdout, stderr } = await spawnCollect(command, args, options, 0, false);
  return { code, stdout, stderr };
}

// A shell command line with a time limit. A command that passes the limit is killed and reported as timed out.
export function execShell(commandLine: string, options: ExecOptions, timeoutMinutes: number): Promise<TimedExecResult> {
  return spawnCollect("/bin/sh", ["-c", commandLine], options, Math.max(1, Math.round(timeoutMinutes * MS_PER_MINUTE)), false);
}

// An agent run: a program with a time limit in minutes (0: none). A run that passes it has its whole process group
// killed, and when it ends by itself the processes it left running are killed too.
export function execTimed(command: string, args: string[], options: ExecOptions, timeoutMinutes: number): Promise<TimedExecResult> {
  return spawnCollect(command, args, options, Math.round(timeoutMinutes * MS_PER_MINUTE), true);
}

// Run a tool in a folder with the current environment and no stdin.
export function run(command: string, args: string[], cwd: string): Promise<ExecResult> {
  return exec(command, args, { cwd, env: process.env, input: "" });
}
