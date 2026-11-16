import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Agent } from "./agent/agent.js";
import { Board, Ticket } from "./board/board.js";
import { Config, ProjectConfig, hasProject, projectNamed } from "./config.js";
import {
  BuildResult,
  GitHubState,
  PublishMode,
  ReleaseResult,
  SessionMode,
  SettleReason,
  Stage,
  StageOutcome,
  StateFile,
  TicketKind,
  TicketStatus,
  Verdict,
} from "./enums.js";
import { Brand } from "./brand.js";
import { exec, run } from "./exec.js";
import { Worktree, ensureWorktree, mergePullRequest, pullRequestState, removeWorktree, worktreeFor } from "./git.js";
import { Logger, clip, mask, oneLine } from "./log.js";
import { Messages, messagesFor } from "./messages.js";
import { RESUME_PROMPT, StageContext, buildPrompt, releasePrompt, reviewPrompt } from "./prompts.js";
import { Slots, StatePaths, TicketState } from "./state.js";

export interface Runner {
  config: Config;
  paths: StatePaths;
  log: Logger;
  board: Board;
  builder: Agent;
  reviewer: Agent;
  slots: Slots;
}

export enum TicketOutcome {
  // The ticket left the runner's hands: done, in review or blocked.
  Settled = "settled",
  // A stage did not finish; the ticket stays "working" and is resumed on a later dispatch.
  Paused = "paused",
}

interface ParsedLine<K> {
  kind: K;
  value: string;
}

function splitLine(line: string): { head: string; value: string } {
  const space = line.indexOf(" ");
  return space < 0 ? { head: line, value: "" } : { head: line.slice(0, space), value: line.slice(space + 1).trim() };
}

export function parseBuildLine(line: string): Array<ParsedLine<BuildResult>> {
  const { head, value } = splitLine(line);
  const kind = Object.values(BuildResult).find((k) => k === head);
  if (kind === undefined) return [];
  if (kind !== BuildResult.Blocked && value === "") return [];
  if ((kind === BuildResult.PullRequest || kind === BuildResult.Doc) && !/^https:\/\/\S+$/.test(value)) return [];
  return [{ kind, value }];
}

export function parseReleaseLine(line: string): Array<ParsedLine<ReleaseResult>> {
  const { head, value } = splitLine(line);
  const kind = Object.values(ReleaseResult).find((k) => k === head);
  return kind === undefined ? [] : [{ kind, value }];
}

export function parseVerdict(line: string): Verdict[] {
  const word = line.trim();
  return Object.values(Verdict).filter((v) => v === word);
}

function readRules(project: ProjectConfig): string {
  return project.rulesFile !== "" && existsSync(project.rulesFile) ? readFileSync(project.rulesFile, "utf8").trim() : "";
}

function tail(text: string, chars: number): string {
  const lines = text.trim().split("\n");
  return clip(oneLine(lines.slice(-8).join(" ")), chars);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Run one ticket from wherever it stopped: build -> review -> (rework -> build -> review) -> settle.
// A release ticket is a single release stage instead.
export class TicketPipeline {
  private readonly state: TicketState;
  private readonly say: Messages;

  constructor(
    private readonly r: Runner,
    private readonly ticket: Ticket,
    private readonly slotKey: string,
  ) {
    this.state = new TicketState(r.paths.results, ticket.id);
    this.say = messagesFor(r.config.language);
  }

  private log(message: string): void {
    this.r.log.line(`${this.ticket.id} ${message}`);
  }

  private async settle(status: TicketStatus, reason: SettleReason, note: string): Promise<TicketOutcome> {
    await this.r.board.setStatus(this.ticket.id, status, reason, clip(mask(note), 3000));
    this.log(`-> ${status} (${reason}): ${clip(oneLine(note), 200)}`);
    this.state.clearStage();
    return TicketOutcome.Settled;
  }

  private async notify(message: string): Promise<void> {
    const command = this.r.config.notifyCommand;
    if (command === "") return;
    const result = await run(command, [mask(message)], this.r.config.root);
    if (result.code !== 0) this.r.log.line(`notify failed: ${clip(oneLine(result.stderr), 200)}`);
  }

  private context(project: ProjectConfig, tree: Worktree, round: number, rules: string, resultFile: StateFile): StageContext {
    return {
      ticket: this.ticket,
      project,
      worktree: tree,
      round,
      lastRound: round > this.r.config.maxRework,
      rules,
      resultFile: this.state.path(resultFile),
      reviewFile: this.state.path(StateFile.Review),
      humanGates: this.r.config.humanGates,
    };
  }

  async run(): Promise<TicketOutcome> {
    if (!hasProject(this.r.config, this.ticket.project)) {
      return this.settle(TicketStatus.Blocked, SettleReason.Misconfigured, this.say.unknownProject(this.ticket.project));
    }
    const project = projectNamed(this.r.config, this.ticket.project);
    let stage = this.ticket.kind === TicketKind.Release ? Stage.Release : Stage.Build;
    let round = 1;
    const saved = this.state.firstLine(StateFile.Stage);
    if (saved !== "") {
      const [savedStage, savedRound] = saved.split(" ");
      stage = Object.values(Stage).find((s) => s === savedStage) ?? stage;
      round = Math.max(1, Number.parseInt(savedRound ?? "1", 10) || 1);
      this.log(`resuming at ${stage} r${round}`);
    } else {
      this.state.remove(StateFile.Build, StateFile.Verdict, StateFile.Review, StateFile.ReviewPrevious);
      this.state.clearStage();
    }

    let tree: Worktree;
    try {
      tree = await ensureWorktree(this.r.config, project, worktreeFor(this.r.paths.worktrees, this.ticket.id));
    } catch (error) {
      return this.settle(TicketStatus.Blocked, SettleReason.Misconfigured, this.say.worktreeFailed(errorText(error)));
    }
    const rules = readRules(project);
    if (stage === Stage.Release) return this.release(project, tree, rules);

    for (;;) {
      const lastRound = round > this.r.config.maxRework;

      if (stage === Stage.Build) {
        if (!this.state.has(StateFile.Build)) {
          const notes = round > 1 ? this.state.read(StateFile.ReviewPrevious) : "";
          const prompt = buildPrompt(this.context(project, tree, round, rules, StateFile.Build), notes);
          const outcome = await this.runStage(Stage.Build, round, this.r.builder, this.r.config.builder.model, prompt, tree);
          if (outcome !== StageOutcome.Finished) return this.pausedOrSettled(outcome);
        }
        const build = parseBuildLine(this.state.firstLine(StateFile.Build))[0];
        if (build === undefined) return this.reject(StateFile.Build, "build left no result or an unrecognized one");
        if (build.kind === BuildResult.Blocked) {
          return this.settle(TicketStatus.Blocked, SettleReason.Blocked, this.say.buildBlocked(build.value || this.say.noReason));
        }
        this.state.write(StateFile.Result, build.value);
        this.state.write(StateFile.ResultKind, build.kind);
        this.state.remove(StateFile.Verdict);
        this.state.nextStage(Stage.Review, round);
        stage = Stage.Review;
      }

      const result = this.state.read(StateFile.Result);
      const resultKind = this.state.read(StateFile.ResultKind);
      if (!this.state.has(StateFile.Verdict)) {
        const prompt = reviewPrompt(this.context(project, tree, round, rules, StateFile.Verdict), `${resultKind} ${result}`);
        const outcome = await this.runStage(Stage.Review, round, this.r.reviewer, this.r.config.reviewer.model, prompt, tree);
        if (outcome !== StageOutcome.Finished) return this.pausedOrSettled(outcome);
      }
      const verdict = parseVerdict(this.state.firstLine(StateFile.Verdict))[0];
      if (verdict === undefined) return this.reject(StateFile.Verdict, "review left no verdict or an unrecognized one");
      const review = this.state.read(StateFile.Review);
      this.log(`verdict r${round}: ${verdict} (${resultKind} ${result})`);

      switch (verdict) {
        case Verdict.Rework:
          if (!lastRound) {
            this.state.remove(StateFile.ReviewPrevious, StateFile.Build, StateFile.Verdict, StateFile.ResultKind);
            this.state.move(StateFile.Review, StateFile.ReviewPrevious);
            round += 1;
            stage = Stage.Build;
            this.state.nextStage(Stage.Build, round);
            await this.r.board.addNote(this.ticket.id, this.say.sentBack(round - 1));
            continue;
          }
          return this.settle(TicketStatus.Blocked, SettleReason.Blocked, this.say.stillNotRight(round, review));
        case Verdict.Blocked:
          await this.notify(`${this.ticket.id} blocked in review`);
          return this.settle(TicketStatus.Blocked, SettleReason.Blocked, this.say.reviewBlocked(review));
        case Verdict.NeedsHuman:
          await this.notify(`${this.ticket.id} needs a human decision`);
          return this.settle(TicketStatus.Blocked, SettleReason.NeedsHuman, this.say.needsHuman(`${resultKind} ${result}`, review));
        case Verdict.Pass:
          return this.passed(project, tree, resultKind, result, review);
      }
    }
  }

  private async release(project: ProjectConfig, tree: Worktree, rules: string): Promise<TicketOutcome> {
    if (!this.state.has(StateFile.Build)) {
      const prompt = releasePrompt(this.context(project, tree, 1, rules, StateFile.Build));
      const outcome = await this.runStage(Stage.Release, 1, this.r.reviewer, this.r.config.reviewer.model, prompt, tree);
      if (outcome !== StageOutcome.Finished) return this.pausedOrSettled(outcome);
    }
    const line = parseReleaseLine(this.state.firstLine(StateFile.Build))[0];
    if (line === undefined) return this.reject(StateFile.Build, "release left no result or an unrecognized one");
    this.state.remove(StateFile.Build);
    if (line.kind === ReleaseResult.Blocked) {
      await this.notify(`${this.ticket.id} release blocked`);
      return this.settle(TicketStatus.Blocked, SettleReason.Blocked, this.say.releaseBlocked(line.value || this.say.noReason));
    }
    await removeWorktree(this.r.config, project, tree);
    return this.settle(TicketStatus.Done, SettleReason.Released, this.say.released(line.value));
  }

  private async passed(project: ProjectConfig, tree: Worktree, kind: string, result: string, review: string): Promise<TicketOutcome> {
    if (kind === BuildResult.PullRequest && this.r.config.autoMerge) {
      const error = await mergePullRequest(this.r.config, result);
      if (error !== "") {
        return this.settle(TicketStatus.Review, SettleReason.MergeFailed, this.say.mergeFailed(clip(oneLine(error), 300), result, review));
      }
      if ((await pullRequestState(this.r.config, result)) === GitHubState.Merged) {
        await removeWorktree(this.r.config, project, tree);
        const post = await this.postMerge(project, result);
        return this.settle(TicketStatus.Done, SettleReason.Merged, this.say.merged(result, review, post));
      }
    }
    if (kind === BuildResult.Doc && this.r.config.autoMerge) {
      await removeWorktree(this.r.config, project, tree);
      return this.settle(TicketStatus.Done, SettleReason.Accepted, this.say.docAccepted(result, review));
    }
    const where = project.publish === PublishMode.Branch && kind === BuildResult.Branch ? this.say.branch(result) : result;
    return this.settle(TicketStatus.Review, SettleReason.ReadyToMerge, this.say.readyToMerge(where, review));
  }

  // A post-merge check is evidence for the ticket note only; it never undoes a merge.
  private async postMerge(project: ProjectConfig, result: string): Promise<string> {
    if (project.postMergeCommand === "") return "";
    const env = {
      ...process.env,
      [`${Brand.envPrefix}TICKET`]: this.ticket.id,
      [`${Brand.envPrefix}PROJECT`]: project.name,
      [`${Brand.envPrefix}RESULT`]: result,
    };
    const out = await exec("/bin/sh", ["-c", project.postMergeCommand], { cwd: project.repoPath, env, input: "" });
    const last = tail(`${out.stdout}\n${out.stderr}`, 300);
    this.log(`post-merge exit ${out.code}: ${last}`);
    return this.say.postMerge(out.code, last);
  }

  private async reject(file: StateFile, why: string): Promise<TicketOutcome> {
    this.log(`${why}; setting the file aside and retrying the stage`);
    this.state.setAside(file);
    this.state.touch(StateFile.Failed);
    return TicketOutcome.Paused;
  }

  private async pausedOrSettled(outcome: StageOutcome): Promise<TicketOutcome> {
    return outcome === StageOutcome.GaveUp ? TicketOutcome.Settled : TicketOutcome.Paused;
  }

  private async runStage(stage: Stage, round: number, agent: Agent, model: string, prompt: string, tree: Worktree): Promise<StageOutcome> {
    const marker = `${stage} ${this.ticket.id} r${round}`;
    this.r.slots.setStage(this.slotKey, marker);
    this.state.write(StateFile.Stage, `${stage} ${round}`);
    const tries = (Number.parseInt(this.state.read(StateFile.Tries), 10) || 0) + 1;
    if (tries > this.r.config.maxStageTries) {
      const reason = clip(this.r.log.lastLineAbout(this.ticket.id), 300) || this.say.noReason;
      await this.notify(`${this.ticket.id} blocked: ${stage} stage cut off ${this.r.config.maxStageTries} times`);
      await this.settle(TicketStatus.Blocked, SettleReason.CutOff, this.say.cutOff(stage, this.r.config.maxStageTries, reason, this.r.log.file));
      return StageOutcome.GaveUp;
    }
    this.state.write(StateFile.Tries, String(tries));

    const saved = this.state.read(StateFile.Session);
    const resume = saved !== "" && agent.hasSession(saved);
    const sessionId = resume ? saved : randomUUID();
    if (!resume) this.state.write(StateFile.Session, sessionId);
    this.log(`${stage} r${round}: ${resume ? "resuming" : "starting"} ${agent.name} session ${sessionId} (try ${tries})`);

    const heartbeat = this.heartbeat(stage, round, marker);
    const result = await agent.run({
      prompt: resume ? RESUME_PROMPT : prompt,
      model,
      cwd: tree.path,
      sessionId,
      mode: resume ? SessionMode.Resume : SessionMode.New,
      writableDirs: [this.r.paths.results],
    });
    clearInterval(heartbeat);
    this.log(`${stage} r${round}: exit ${result.exitCode}: ${tail(result.output, 600)}`);
    if (result.exitCode !== 0) {
      this.state.touch(StateFile.Failed);
      return StageOutcome.Failed;
    }
    this.state.remove(StateFile.Failed);
    return StageOutcome.Finished;
  }

  // Leave a "still working" note only while this worker still owns the slot and the stage has not moved on.
  private heartbeat(stage: Stage, round: number, marker: string): NodeJS.Timeout {
    const ms = Math.max(1, this.r.config.heartbeatMinutes) * 60_000;
    const timer = setInterval(() => {
      if (this.r.slots.owner(this.slotKey) !== process.pid || this.r.slots.stage(this.slotKey) !== marker) return;
      this.r.board.addNote(this.ticket.id, this.say.stillWorking(stage, round)).catch((error: unknown) => {
        this.log(`heartbeat note failed: ${errorText(error)}`);
      });
    }, ms);
    timer.unref();
    return timer;
  }
}
