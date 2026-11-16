import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { StateFile } from "./enums.js";

export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

export interface StatePaths {
  root: string;
  log: string;
  results: string;
  slots: string;
  worktrees: string;
  sessions: string;
  dispatchLock: string;
  limits: string;
}

export function statePaths(stateDir: string): StatePaths {
  const paths = {
    root: stateDir,
    log: join(stateDir, "nightshift.log"),
    results: join(stateDir, "results"),
    slots: join(stateDir, "slots"),
    worktrees: join(stateDir, "worktrees"),
    sessions: join(stateDir, "sessions"),
    dispatchLock: join(stateDir, "dispatch.lock"),
    limits: join(stateDir, "limits"),
  };
  for (const dir of [paths.root, paths.results, paths.slots, paths.worktrees, paths.sessions, paths.limits]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return paths;
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

// What the runner remembers about one ticket between runs: stage, session, tries and the stage results.
export class TicketState {
  private readonly base: string;

  constructor(resultsDir: string, readonly ticketId: string) {
    this.base = join(resultsDir, safeId(ticketId));
  }

  path(file: StateFile): string {
    return `${this.base}.${file}`;
  }

  read(file: StateFile): string {
    return readText(this.path(file));
  }

  firstLine(file: StateFile): string {
    return this.read(file).split("\n")[0]?.trim() ?? "";
  }

  has(file: StateFile): boolean {
    return this.read(file) !== "";
  }

  write(file: StateFile, value: string): void {
    writeFileSync(this.path(file), `${value}\n`);
  }

  touch(file: StateFile): void {
    writeFileSync(this.path(file), `${new Date().toISOString()}\n`);
  }

  ageMinutes(file: StateFile): number {
    const path = this.path(file);
    return existsSync(path) ? (Date.now() - statSync(path).mtimeMs) / 60_000 : Number.POSITIVE_INFINITY;
  }

  remove(...files: StateFile[]): void {
    for (const file of files) rmSync(this.path(file), { force: true });
  }

  move(from: StateFile, to: StateFile): void {
    if (existsSync(this.path(from))) renameSync(this.path(from), this.path(to));
  }

  // Keep a rejected result for a human to look at, out of the runner's way.
  setAside(file: StateFile): void {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    if (existsSync(this.path(file))) renameSync(this.path(file), `${this.path(file)}.invalid-${stamp}`);
  }

  clearStage(): void {
    this.remove(StateFile.Stage, StateFile.Session, StateFile.Tries, StateFile.Failed, StateFile.Result, StateFile.ResultKind);
  }

  nextStage(stage: string, round: number): void {
    this.remove(StateFile.Session, StateFile.Tries, StateFile.Failed);
    this.write(StateFile.Stage, `${stage} ${round}`);
  }
}

export interface SlotInfo {
  key: string;
  target: string;
  pid: number;
  stage: string;
  release: boolean;
}

enum SlotFile {
  Target = "target",
  Pid = "pid",
  Stage = "stage",
  Release = "release",
}

export function projectSlotKey(project: string): string {
  return createHash("sha1").update(project).digest("hex").slice(0, 12);
}

export function releaseSlotKey(ticketId: string): string {
  return `release-${safeId(ticketId)}`;
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

// One folder per running worker. A slot whose process is gone is cleaned up when listed.
export class Slots {
  constructor(private readonly dir: string) {}

  private file(key: string, file: SlotFile): string {
    return join(this.dir, key, file);
  }

  exists(key: string): boolean {
    return existsSync(join(this.dir, key));
  }

  tryCreate(key: string, target: string, release: boolean): boolean {
    try {
      mkdirSync(join(this.dir, key));
    } catch {
      return false;
    }
    writeFileSync(this.file(key, SlotFile.Target), target);
    if (release) writeFileSync(this.file(key, SlotFile.Release), "");
    return true;
  }

  setPid(key: string, pid: number): void {
    writeFileSync(this.file(key, SlotFile.Pid), String(pid));
  }

  setStage(key: string, stage: string): void {
    if (this.exists(key)) writeFileSync(this.file(key, SlotFile.Stage), stage);
  }

  target(key: string): string {
    return readText(this.file(key, SlotFile.Target));
  }

  owner(key: string): number {
    return Number.parseInt(readText(this.file(key, SlotFile.Pid)), 10);
  }

  stage(key: string): string {
    return readText(this.file(key, SlotFile.Stage));
  }

  remove(key: string): void {
    rmSync(join(this.dir, key), { recursive: true, force: true });
  }

  live(): SlotInfo[] {
    if (!existsSync(this.dir)) return [];
    const result: SlotInfo[] = [];
    for (const key of readdirSync(this.dir)) {
      const pid = this.owner(key);
      if (!processAlive(pid)) {
        this.remove(key);
        continue;
      }
      result.push({
        key,
        target: this.target(key),
        pid,
        stage: this.stage(key),
        release: existsSync(this.file(key, SlotFile.Release)),
      });
    }
    return result;
  }
}

// mkdir is atomic, so the folder is the lock. A lock whose owner died is taken over.
export async function acquireLock(dir: string, tries: number, waitMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      return true;
    } catch {
      const owner = Number.parseInt(readText(join(dir, "pid")), 10);
      if (Number.isInteger(owner) && !processAlive(owner)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      await sleep(waitMs);
    }
  }
  return false;
}

export function releaseLock(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface ActiveLimit {
  agent: string;
  until: number;
  message: string;
}

// Usage limits are per account, so they are kept per agent (claude-code, codex, ...), not per ticket.
// One file per agent: "<until ms>\t<message>".
export class UsageLimits {
  constructor(private readonly dir: string) {}

  private file(agent: string): string {
    return join(this.dir, safeId(agent));
  }

  set(agent: string, until: number, message: string): void {
    writeFileSync(this.file(agent), `${until}\t${message.replace(/\s+/g, " ")}\n`);
  }

  // Limits still in force; expired ones are removed.
  active(now: number): ActiveLimit[] {
    if (!existsSync(this.dir)) return [];
    const out: ActiveLimit[] = [];
    for (const agent of readdirSync(this.dir)) {
      const [untilText, ...rest] = readText(join(this.dir, agent)).split("\t");
      const until = Number.parseInt(untilText ?? "", 10);
      if (!Number.isFinite(until) || until <= now) {
        rmSync(join(this.dir, agent), { force: true });
        continue;
      }
      out.push({ agent, until, message: rest.join("\t") });
    }
    return out;
  }
}
