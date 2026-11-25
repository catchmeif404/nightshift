import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TimedExecResult extends ExecResult {
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
}

const NOT_FOUND = 127;
const MS_PER_MINUTE = 60_000;

// timeoutMs 0: no limit. A limit puts the child in its own process group so the whole tree is killed when it passes.
function spawnCollect(command: string, args: string[], options: ExecOptions, timeoutMs: number): Promise<TimedExecResult> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: timeoutMs > 0 });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
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
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: NOT_FOUND, stdout: "", stderr: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}

export async function exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  const { code, stdout, stderr } = await spawnCollect(command, args, options, 0);
  return { code, stdout, stderr };
}

// A shell command line with a time limit. A command that passes the limit is killed and reported as timed out.
export function execShell(commandLine: string, options: ExecOptions, timeoutMinutes: number): Promise<TimedExecResult> {
  return spawnCollect("/bin/sh", ["-c", commandLine], options, Math.max(1, Math.round(timeoutMinutes * MS_PER_MINUTE)));
}

// Run a tool in a folder with the current environment and no stdin.
export function run(command: string, args: string[], cwd: string): Promise<ExecResult> {
  return exec(command, args, { cwd, env: process.env, input: "" });
}
