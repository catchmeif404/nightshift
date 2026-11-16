import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
}

const NOT_FOUND = 127;

export function exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => done({ code: NOT_FOUND, stdout: "", stderr: error.message }));
    child.on("close", (code) => {
      done({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}

// Run a tool in a folder with the current environment and no stdin.
export function run(command: string, args: string[], cwd: string): Promise<ExecResult> {
  return exec(command, args, { cwd, env: process.env, input: "" });
}
