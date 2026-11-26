import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Agent } from "./agent/agent.js";
import { Board, Ticket } from "./board/board.js";
import { Config, ProjectConfig, hasProject, projectNamed } from "./config.js";
import {
  BuildResult,
  ConflictResult,
  GitHubState,
  Mergeable,
  JournalKind,
  NotifyEvent,
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
import { exec, execShell, run } from "./exec.js";
import { DiffSize, GitError, NO_DIFF, Worktree, baseRef, changedFiles, conflictFiles, diffSince, ensureWorktree, gateHits, gitCommonDir, headCommit, mergePullRequest, pullRequestMergeable, pullRequestState, removeWorktree, worktreeFor } from "./git.js";
import { Logger, clip, mask, oneLine } from "./log.js";
import { sendNotification, wants } from "./notify.js";
import { Messages, messagesFor } from "./messages.js";
import { RESUME_PROMPT, StageContext, buildPrompt, conflictPrompt, releasePrompt, reviewPrompt } from "./prompts.js";
import { Slots, StatePaths, TicketState, UsageLimits } from "./state.js";
import { detectLimit } from "./limits.js";
import { StageUsage, UsageLog, readSessionUsage, reviewerEdits, totalUsage, usageNote, weighted } from "./usage.js";
import { Journal } from "./report.js";

export interface Runner {
  config: Config;
  paths: StatePaths;
  log: Logger;
  board: Board;
  builder: Agent;
  reviewer: Agent;
  slots: Slots;
  limits: UsageLimits;
}

export enum TicketOutcome {
  // The ticket left the runner's hands: done, in review or blocked.
  Settled = "settled",
  // A stage did not finish; the ticket stays "working" and is resumed on a later dispatch.
  Paused = "paused",
  // The agent's account hit its usage limit; the worker should stop taking tickets until it resets.
  Limited = "limited",
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

export function parseConflictLine(line: string): Array<ParsedLine<ConflictResult>> {
  const { head, value } = splitLine(line);
  const kind = Object.values(ConflictResult).find((k) => k === head);
  return kind === undefined ? [] : [{ kind, value }];
}

export function parseVerdict(line: string): Verdict[] {
  const word = line.trim();
  return Object.values(Verdict).filter((v) => v === word);
}

// A passed ticket either settles or goes back to the developer to resolve a merge conflict.
enum MergeRetry {
  Conflict = "conflict",
}

// Which built-in notification a settled ticket triggers; reasons not listed send nothing.
const NOTICE_EVENTS: Partial<Record<SettleReason, NotifyEvent>> = {
  [SettleReason.ReadyToMerge]: NotifyEvent.Review,
  [SettleReason.Merged]: NotifyEvent.Merged,
  [SettleReason.Accepted]: NotifyEvent.Merged,
  [SettleReason.Released]: NotifyEvent.Merged,
  [SettleReason.Blocked]: NotifyEvent.Blocked,
  [SettleReason.NeedsHuman]: NotifyEvent.Blocked,
  [SettleReason.CutOff]: NotifyEvent.Blocked,
  [SettleReason.MergeFailed]: NotifyEvent.Blocked,
  [SettleReason.Misconfigured]: NotifyEvent.Blocked,
};

function readRules(project: ProjectConfig): string {
  return project.rulesFile !== "" && existsSync(project.rulesFile) ? readFileSync(project.rulesFile, "utf8").trim() : "";
}

function tail(text: string, chars: number): string {
  const lines = text.trim().split("\n");
  return clip(oneLine(lines.slice(-8).join(" ")), chars);
}

// Lines of the check's output the developer gets back, and the characters kept of them.
const CHECK_TAIL_LINES = 60;
const CHECK_TAIL_CHARS = 8000;

// The end of a command's output, at most CHECK_TAIL_LINES lines, secrets masked.
export function outputTail(output: string): string {
  const lines = output.trimEnd().split("\n");
  return clip(mask(lines.slice(-CHECK_TAIL_LINES).join("\n")), CHECK_TAIL_CHARS);
}

function lastOutputLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return clip(oneLine(mask(lines[lines.length - 1] ?? "")), 200);
}

// What the runner's own check found. `output` is empty when it passed.
interface CheckFailure {
  command: string;
  // The time limit in minutes when the check timed out, else 0.
  timeoutMinutes: number;
  output: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Run one ticket from wherever it stopped: build -> review -> (rework -> build -> review) -> settle.
// A release ticket is a single release stage instead.
export class TicketPipeline {
  private readonly state: TicketState;
  private readonly say: Messages;
  private readonly usage: UsageLog;

  constructor(
    private readonly r: Runner,
    private readonly ticket: Ticket,
    private readonly slotKey: string,
  ) {
    this.state = new TicketState(r.paths.results, ticket.id);
    this.say = messagesFor(r.config.language);
    this.usage = new UsageLog(r.paths.usage, ticket.id);
  }

  private log(message: string): void {
    this.r.log.line(`${this.ticket.id} ${message}`);
  }

  private async settle(status: TicketStatus, reason: SettleReason, note: string): Promise<TicketOutcome> {
    await this.r.board.setStatus(this.ticket.id, status, reason, clip(mask(note), 3000));
    this.log(`-> ${status} (${reason}): ${clip(oneLine(note), 200)}`);
    await this.noteUsage();
    const link = this.state.firstLine(StateFile.Result);
    this.journalSettled(status, reason, link, note);
    this.state.clearStage();
    this.state.remove(StateFile.Stale);
    await this.announce(reason, link);
    return TicketOutcome.Settled;
  }

  // What the morning report reads. A failure is only logged: the ticket has already moved.
  private journalSettled(status: TicketStatus, reason: SettleReason, link: string, note: string): void {
    try {
      const entries = this.usage.read();
      const total = totalUsage(entries);
      const edits = reviewerEdits(entries);
      const rounds = Math.max(1, ...entries.filter((e) => e.stage === Stage.Build).map((e) => e.round));
      new Journal(this.r.paths.journal).append({
        kind: JournalKind.Settled,
        at: Date.now(),
        ticket: this.ticket.id,
        title: clip(oneLine(mask(this.ticket.title)), 200),
        project: this.ticket.project,
        status,
        reason,
        link: /^\S+$/.test(link) ? link : "",
        rounds,
        known: total.known,
        weighted: total.weighted,
        seconds: total.seconds,
        reviewerFiles: edits.files,
        reviewerAdded: edits.added,
        reviewerRemoved: edits.removed,
        conflictRetries: this.conflictRetries(),
        note: clip(oneLine(mask(note)), 300),
      });
    } catch (error) {
      this.log(`journal write failed: ${errorText(error)}`);
    }
  }

  // One line on the board with what the stages cost. A failure is only logged: the ticket has already moved.
  private async noteUsage(): Promise<void> {
    try {
      const line = usageNote(this.usage.read(), this.r.config.language);
      if (line !== "") await this.r.board.addNote(this.ticket.id, line);
    } catch (error) {
      this.log(`usage note failed: ${errorText(error)}`);
    }
  }

  // Records what a finished stage used. Never fails the stage: unreadable usage is stored as unknown, with the wall-clock time.
  private recordUsage(stage: Stage, round: number, agent: Agent, model: string, sessionId: string, wallSeconds: number, edit: DiffSize): void {
    try {
      const session = readSessionUsage(agent.usageFile(sessionId));
      const entry: StageUsage = {
        stage,
        round,
        session: sessionId,
        model,
        known: session.known,
        tokens: session.tokens,
        weighted: weighted(session.tokens),
        seconds: session.known && session.seconds > 0 ? session.seconds : wallSeconds,
        editFiles: edit.files,
        editAdded: edit.added,
        editRemoved: edit.removed,
      };
      this.usage.record(entry);
    } catch (error) {
      this.log(`usage record failed: ${errorText(error)}`);
    }
  }

  // The built-in Telegram / Slack / Discord message. A failure is only logged: the ticket has already moved.
  private async announce(reason: SettleReason, link: string): Promise<void> {
    const event = NOTICE_EVENTS[reason];
    const cfg = this.r.config.notify;
    if (event === undefined || !wants(cfg, event)) return;
    const lines = [this.say.notice(event, this.ticket.id, clip(oneLine(this.ticket.title), 120))];
    if (/^https:\/\/\S+$/.test(link)) lines.push(link);
    const failure = await sendNotification(cfg, lines.join("\n"));
    if (failure !== "") this.r.log.line(`${this.ticket.id} notify (${cfg.service}) failed: ${failure}`);
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
      ticketSections: this.r.config.ticketSections,
      gatePaths: this.r.config.gatePaths,
      reviewHandoff: this.r.config.reviewHandoff,
      handoffFile: this.state.path(StateFile.Handoff),
      handoffText: "",
      changedFiles: [],
      baseRef: "",
      conflictFiles: [],
    };
  }

  // Files the branch changed, for the review handoff. A git failure leaves the list empty: the reviewer then looks for itself.
  private async handoffFiles(project: ProjectConfig, tree: Worktree): Promise<string[]> {
    try {
      return await changedFiles(this.r.config, project, tree);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      this.log(`handoff: changed files unknown (${clip(oneLine(error.message), 200)})`);
      return [];
    }
  }

  async run(): Promise<TicketOutcome> {
    if (!hasProject(this.r.config, this.ticket.project)) {
      return this.settle(TicketStatus.Blocked, SettleReason.Misconfigured, this.say.unknownProject(this.ticket.project));
    }
    const project = projectNamed(this.r.config, this.ticket.project);
    // The ticket moves again: a later stuck period gets its own notice.
    this.state.remove(StateFile.Stale);
    let stage = this.ticket.kind === TicketKind.Release ? Stage.Release : Stage.Build;
    let round = 1;
    const saved = this.state.firstLine(StateFile.Stage);
    if (saved !== "") {
      const [savedStage, savedRound] = saved.split(" ");
      stage = Object.values(Stage).find((s) => s === savedStage) ?? stage;
      round = Math.max(1, Number.parseInt(savedRound ?? "1", 10) || 1);
      this.log(`resuming at ${stage} r${round}`);
    } else {
      // A fresh run (also one a human sent back after an earlier merge-failed) gets its own maxConflictRetries.
      this.state.remove(StateFile.Build, StateFile.Verdict, StateFile.Review, StateFile.ReviewPrevious, StateFile.Handoff, StateFile.ReviewBase, StateFile.Conflict, StateFile.ConflictRetries, StateFile.ConflictFiles);
      this.state.clearStage();
      this.usage.clear();
    }

    let tree: Worktree;
    try {
      tree = await ensureWorktree(this.r.config, project, worktreeFor(this.r.paths.worktrees, this.ticket.id), (line) => this.log(line));
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
        this.state.remove(StateFile.Verdict, StateFile.ReviewBase);
        this.state.nextStage(Stage.Review, round);
        stage = Stage.Review;
      }

      if (stage === Stage.Conflict) {
        const unresolved = await this.resolveConflict(project, tree, round, rules);
        if (unresolved !== undefined) return unresolved;
        stage = Stage.Review;
      }

      const result = this.state.read(StateFile.Result);
      const resultKind = this.state.read(StateFile.ResultKind);
      if (!this.state.has(StateFile.Verdict)) {
        const reviewContext = this.context(project, tree, round, rules, StateFile.Verdict);
        if (reviewContext.reviewHandoff) {
          reviewContext.handoffText = this.state.read(StateFile.Handoff).trim();
          reviewContext.changedFiles = await this.handoffFiles(project, tree);
        }
        const prompt = reviewPrompt(reviewContext, `${resultKind} ${result}`);
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
            this.sendBack(round);
            round += 1;
            stage = Stage.Build;
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
        case Verdict.Pass: {
          // A PASS is only a verdict until the runner's own check agrees.
          const failure = await this.runCheck(project, tree);
          if (failure === undefined) {
            const outcome = await this.passed(project, tree, resultKind, result, review, round);
            if (outcome !== MergeRetry.Conflict) return outcome;
            stage = Stage.Conflict;
            continue;
          }
          if (!lastRound) {
            this.state.write(StateFile.Review, `${review}\n\n${this.say.checkFailedNotes(failure.command, failure.timeoutMinutes, failure.output)}`.trim());
            this.sendBack(round);
            round += 1;
            stage = Stage.Build;
            await this.r.board.addNote(this.ticket.id, this.say.checkSentBack(round - 1, failure.command, failure.timeoutMinutes));
            continue;
          }
          return this.settle(
            TicketStatus.Blocked,
            SettleReason.Blocked,
            this.say.checkBlocked(failure.command, failure.timeoutMinutes, lastOutputLine(failure.output), review),
          );
        }
      }
    }
  }

  // Moves the review notes aside for the developer and queues the next build round.
  private sendBack(round: number): void {
    this.state.remove(StateFile.ReviewPrevious, StateFile.Build, StateFile.Verdict, StateFile.ResultKind, StateFile.Handoff, StateFile.ReviewBase);
    this.state.move(StateFile.Review, StateFile.ReviewPrevious);
    this.state.nextStage(Stage.Build, round + 1);
  }

  // Runs the project's testCommand in the ticket's worktree itself, since an agent's "tests pass" is only its word.
  // Returns nothing when the check is off or passed; a failure or a timeout comes back with the end of the output.
  private async runCheck(project: ProjectConfig, tree: Worktree): Promise<CheckFailure | undefined> {
    if (project.testCommand === "") return undefined;
    const env = {
      ...process.env,
      [`${Brand.envPrefix}TICKET`]: this.ticket.id,
      [`${Brand.envPrefix}PROJECT`]: project.name,
    };
    const out = await execShell(project.testCommand, { cwd: tree.path, env, input: "" }, project.testTimeoutMinutes);
    const output = `${out.stdout}${out.stdout.endsWith("\n") || out.stdout === "" ? "" : "\n"}${out.stderr}`;
    this.log(`runner check exit ${out.code}${out.timedOut ? " (timed out)" : ""}: ${tail(output, 300)}`);
    if (!out.timedOut && out.code === 0) return undefined;
    return { command: project.testCommand, timeoutMinutes: out.timedOut ? project.testTimeoutMinutes : 0, output };
  }

  // The commit the review stage started from, kept across a resumed stage. Empty when git cannot say.
  private async reviewBase(tree: Worktree): Promise<string> {
    const saved = this.state.read(StateFile.ReviewBase);
    if (saved !== "") return saved;
    try {
      const head = await headCommit(this.r.config, tree);
      this.state.write(StateFile.ReviewBase, head);
      return head;
    } catch (error) {
      this.log(`reviewer edits: start commit unknown (${clip(oneLine(errorText(error)), 200)})`);
      return "";
    }
  }

  // What the reviewer changed since `base`: committed lines only. A git failure counts as no change, and is logged.
  private async reviewerEdit(tree: Worktree, base: string): Promise<DiffSize> {
    if (base === "") return NO_DIFF;
    try {
      return await diffSince(this.r.config, tree, base);
    } catch (error) {
      this.log(`reviewer edits unknown (${clip(oneLine(errorText(error)), 200)})`);
      return NO_DIFF;
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

  // A passing review still goes to a human when the change touches a gated path. Fails closed: if the changed
  // files cannot be listed, the ticket is held rather than waved through.
  private async gatedByPaths(project: ProjectConfig, tree: Worktree, result: string, review: string): Promise<TicketOutcome | undefined> {
    if (this.r.config.gatePaths.length === 0) return undefined;
    let note: string;
    try {
      const hits = gateHits(this.r.config.gatePaths, await changedFiles(this.r.config, project, tree));
      if (hits.length === 0) return undefined;
      note = this.say.gatePaths(hits, result, review);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      note = this.say.gatePathsUnknown(clip(oneLine(error.message), 300), result);
    }
    await this.notify(`${this.ticket.id} needs a human decision (gated paths)`);
    return this.settle(TicketStatus.Blocked, SettleReason.NeedsHuman, note);
  }

  private async passed(project: ProjectConfig, tree: Worktree, kind: string, result: string, review: string, round: number): Promise<TicketOutcome | MergeRetry> {
    const gated = await this.gatedByPaths(project, tree, result, review);
    if (gated !== undefined) return gated;
    if (kind === BuildResult.PullRequest && this.r.config.autoMerge) {
      const error = await mergePullRequest(this.r.config, result);
      if (error !== "") {
        return this.mergeFailed(project, tree, result, review, round, error);
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

  // The merge failed. A conflict (asked of GitHub, not read from gh's wording) goes back to the developer while
  // maxConflictRetries lasts; anything else, and a conflict once the retries are used up, waits in review.
  private async mergeFailed(project: ProjectConfig, tree: Worktree, result: string, review: string, round: number, error: string): Promise<TicketOutcome | MergeRetry> {
    const max = this.r.config.maxConflictRetries;
    const cause = clip(oneLine(error), 300);
    if (max <= 0 || (await pullRequestMergeable(this.r.config, result)) !== Mergeable.Conflicting) {
      return this.settle(TicketStatus.Review, SettleReason.MergeFailed, this.say.mergeFailed(cause, result, review));
    }
    const used = this.conflictRetries();
    const files = await this.conflictFilesOf(project, tree);
    if (used >= max) {
      return this.settle(TicketStatus.Review, SettleReason.MergeFailed, this.say.mergeConflicted(cause, files, used, result, review));
    }
    this.state.write(StateFile.ConflictRetries, String(used + 1));
    this.state.write(StateFile.ConflictFiles, files.join("\n"));
    this.state.remove(StateFile.Conflict, StateFile.Verdict, StateFile.ReviewBase);
    this.state.nextStage(Stage.Conflict, round);
    this.log(`merge conflict: sending the developer back (${used + 1}/${max}): ${clip(oneLine(files.join(", ")), 200)}`);
    await this.r.board.addNote(this.ticket.id, this.say.conflictSentBack(used + 1, max, files));
    return MergeRetry.Conflict;
  }

  private conflictRetries(): number {
    return Number.parseInt(this.state.read(StateFile.ConflictRetries), 10) || 0;
  }

  // Files that conflict with the base branch. A git failure leaves the list empty: the developer then finds them itself.
  private async conflictFilesOf(project: ProjectConfig, tree: Worktree): Promise<string[]> {
    try {
      return await conflictFiles(this.r.config, project, tree);
    } catch (error) {
      this.log(`conflict files unknown (${clip(oneLine(errorText(error)), 200)})`);
      return [];
    }
  }

  // The conflict stage: the developer merges the base branch in and resolves the conflicts. Returns an outcome when the
  // ticket left the runner's hands (or paused); nothing when the review should run again.
  private async resolveConflict(project: ProjectConfig, tree: Worktree, round: number, rules: string): Promise<TicketOutcome | undefined> {
    if (!this.state.has(StateFile.Conflict)) {
      const ctx = this.context(project, tree, round, rules, StateFile.Conflict);
      ctx.baseRef = await baseRef(this.r.config, project);
      ctx.conflictFiles = this.state.read(StateFile.ConflictFiles).split("\n").filter((f) => f !== "");
      const outcome = await this.runStage(Stage.Conflict, round, this.r.builder, this.r.config.builder.model, conflictPrompt(ctx), tree);
      if (outcome !== StageOutcome.Finished) return this.pausedOrSettled(outcome);
    }
    const fix = parseConflictLine(this.state.firstLine(StateFile.Conflict))[0];
    if (fix === undefined) return this.reject(StateFile.Conflict, "conflict run left no result or an unrecognized one");
    if (fix.kind === ConflictResult.Blocked) {
      const files = this.state.read(StateFile.ConflictFiles).split("\n").filter((f) => f !== "");
      const reason = this.say.conflictUnresolved(fix.value || this.say.noReason);
      return this.settle(TicketStatus.Review, SettleReason.MergeFailed, this.say.mergeConflicted(reason, files, this.conflictRetries(), this.state.read(StateFile.Result), this.state.read(StateFile.Review)));
    }
    this.state.remove(StateFile.Conflict, StateFile.Verdict, StateFile.ReviewBase);
    this.state.nextStage(Stage.Review, round);
    return undefined;
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
    if (outcome === StageOutcome.GaveUp) return TicketOutcome.Settled;
    return outcome === StageOutcome.Limited ? TicketOutcome.Limited : TicketOutcome.Paused;
  }

  private async runStage(stage: Stage, round: number, agent: Agent, model: string, prompt: string, tree: Worktree): Promise<StageOutcome> {
    const marker = `${stage} ${this.ticket.id} r${round}`;
    this.r.slots.setStage(this.slotKey, marker);
    this.state.write(StateFile.Stage, `${stage} ${round}`);
    const tries = (Number.parseInt(this.state.read(StateFile.Tries), 10) || 0) + 1;
    if (tries > this.r.config.maxStageTries) {
      const reason = clip(this.r.log.lastLineAbout(this.ticket.id), 300) || this.say.noReason;
      const limitMinutes = Number.parseFloat(this.state.read(StateFile.TimedOut)) || 0;
      if (limitMinutes > 0) {
        await this.notify(`${this.ticket.id} blocked: ${stage} stage passed its time limit of ${limitMinutes} min ${this.r.config.maxStageTries} times`);
        await this.settle(TicketStatus.Blocked, SettleReason.CutOff, this.say.stageTimedOut(stage, this.r.config.maxStageTries, limitMinutes, this.r.log.file));
      } else {
        await this.notify(`${this.ticket.id} blocked: ${stage} stage cut off ${this.r.config.maxStageTries} times`);
        await this.settle(TicketStatus.Blocked, SettleReason.CutOff, this.say.cutOff(stage, this.r.config.maxStageTries, reason, this.r.log.file));
      }
      return StageOutcome.GaveUp;
    }
    this.state.write(StateFile.Tries, String(tries));

    const saved = this.state.read(StateFile.Session);
    const resume = saved !== "" && agent.hasSession(saved);
    const sessionId = resume ? saved : randomUUID();
    if (!resume) this.state.write(StateFile.Session, sessionId);
    this.log(`${stage} r${round}: ${resume ? "resuming" : "starting"} ${agent.name} session ${sessionId} (try ${tries})`);

    const reviewBase = stage === Stage.Review ? await this.reviewBase(tree) : "";
    const gitDir = await gitCommonDir(this.r.config, tree);
    const heartbeat = this.heartbeat(stage, round, marker);
    const startedAt = Date.now();
    const result = await agent.run({
      prompt: resume ? RESUME_PROMPT : prompt,
      model,
      cwd: tree.path,
      sessionId,
      mode: resume ? SessionMode.Resume : SessionMode.New,
      writableDirs: gitDir === "" ? [this.r.paths.results] : [this.r.paths.results, gitDir],
      timeoutMinutes: this.r.config.stageTimeoutMinutes,
    });
    clearInterval(heartbeat);
    this.log(`${stage} r${round}: cleaned up ${result.cleaned} leftover process(es) of the run`);
    this.log(`${stage} r${round}: exit ${result.exitCode}: ${tail(result.output, 600)}`);
    if (result.exitCode !== 0) {
      const limit = detectLimit(result.output, Date.now(), this.r.config.usageLimitWaitMinutes)[0];
      if (limit !== undefined) {
        // Not the ticket's fault: give the try back, remember the reset for every ticket of this agent.
        this.state.write(StateFile.Tries, String(tries - 1));
        this.r.limits.set(agent.name, limit.until, limit.message);
        try {
          new Journal(this.r.paths.journal).append({ kind: JournalKind.Limited, at: Date.now(), until: limit.until, agent: agent.name });
        } catch (error) {
          this.log(`journal write failed: ${errorText(error)}`);
        }
        const until = new Date(limit.until).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
        this.log(`${stage} r${round}: usage limit (${agent.name}) until ${until}: ${clip(limit.message, 160)}`);
        await this.r.board.addNote(this.ticket.id, this.say.usageLimit(agent.name, until));
        return StageOutcome.Limited;
      }
      if (result.timedOut) {
        this.state.write(StateFile.TimedOut, String(this.r.config.stageTimeoutMinutes));
        this.log(`${stage} r${round}: passed the time limit of ${this.r.config.stageTimeoutMinutes} min, process group killed (try ${tries})`);
      } else {
        this.state.remove(StateFile.TimedOut);
      }
      this.state.touch(StateFile.Failed);
      return StageOutcome.Failed;
    }
    this.state.remove(StateFile.Failed, StateFile.TimedOut);
    const edit = stage === Stage.Review ? await this.reviewerEdit(tree, reviewBase) : NO_DIFF;
    this.recordUsage(stage, round, agent, model, sessionId, Math.round((Date.now() - startedAt) / 1000), edit);
    if (edit.files > 0) {
      this.log(`${stage} r${round}: the reviewer changed ${edit.files} files +${edit.added}/-${edit.removed}`);
      await this.r.board.addNote(this.ticket.id, this.say.reviewerEdited(round, edit.files, edit.added, edit.removed));
    }
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
