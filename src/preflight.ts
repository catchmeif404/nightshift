import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Config, ProjectConfig } from "./config.js";
import { PreflightCause, PublishMode } from "./enums.js";
import { ExecResult, run } from "./exec.js";
import { clip, oneLine } from "./log.js";
import { messagesFor } from "./messages.js";
import { safeId } from "./state.js";

// Runs one tool in a folder. Tests replace it, so no real git or gh is called.
export type Probe = (command: string, args: string[], cwd: string) => Promise<ExecResult>;

export interface PreflightResult {
  ok: boolean;
  cause: PreflightCause;
  // The localized reason (empty when ok).
  message: string;
}

const GITHUB_HOST = "github.com";
const REMOTE = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

export interface RemoteRepo {
  host: string;
  owner: string;
  name: string;
}

export function parseRemote(url: string): RemoteRepo | undefined {
  const m = REMOTE.exec(url.trim());
  return m === null ? undefined : { host: m[1] ?? "", owner: m[2] ?? "", name: m[3] ?? "" };
}

const PASSED: PreflightResult = { ok: true, cause: PreflightCause.GhFailed, message: "" };

// Can the runner publish this project? Only a pull-request project needs an origin on GitHub and push rights there;
// a branch project stays in the local repository.
export async function checkPublish(config: Config, project: ProjectConfig, probe: Probe = run): Promise<PreflightResult> {
  if (project.publish !== PublishMode.PullRequest) return PASSED;
  const say = messagesFor(config.language).preflight;
  const fail = (cause: PreflightCause, detail: string): PreflightResult => ({ ok: false, cause, message: say(cause, project.name, detail) });
  const remote = await probe(config.tools.git, ["remote", "get-url", "origin"], project.repoPath);
  if (remote.code !== 0 || remote.stdout.trim() === "") return fail(PreflightCause.NoOrigin, "");
  const repo = parseRemote(remote.stdout);
  if (repo === undefined) return fail(PreflightCause.NotGitHub, clip(oneLine(remote.stdout), 120));
  const args = ["api", `repos/${repo.owner}/${repo.name}`, "--jq", ".permissions.push"];
  if (repo.host.toLowerCase() !== GITHUB_HOST) args.push("--hostname", repo.host);
  const answer = await probe(config.tools.gh, args, project.repoPath);
  if (answer.code !== 0) return fail(PreflightCause.GhFailed, `${repo.owner}/${repo.name}: ${clip(oneLine(answer.stderr || answer.stdout), 160)}`);
  if (answer.stdout.trim() !== "true") return fail(PreflightCause.NoPushPermission, `${repo.owner}/${repo.name}`);
  return PASSED;
}

// The last reason sent per project, kept in the state folder so the same reason is announced once.
// File: line 1 = the reason key, line 2 = the message (the console shows it).
export class PreflightMemory {
  constructor(private readonly dir: string) {}

  private file(project: string): string {
    return join(this.dir, `preflight-${safeId(project)}`);
  }

  // The message of an unresolved reason for this project; empty when there is none.
  message(project: string): string {
    return this.read(project).message;
  }

  private read(project: string): { key: string; message: string } {
    const path = this.file(project);
    if (!existsSync(path)) return { key: "", message: "" };
    const [key = "", ...rest] = readFileSync(path, "utf8").split("\n");
    return { key, message: rest.join("\n").trim() };
  }

  // True when this reason is new for the project (so it should be announced); records it either way.
  record(project: string, result: PreflightResult): boolean {
    const key = result.cause;
    const known = this.read(project).key === key;
    writeFileSync(this.file(project), `${key}\n${result.message}\n`);
    return !known;
  }

  // The problem is gone: forget it, so the same problem later is announced again.
  clear(project: string): void {
    rmSync(this.file(project), { force: true });
  }
}
