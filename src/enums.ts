export enum TicketStatus {
  Ready = "ready",
  Working = "working",
  Review = "review",
  Blocked = "blocked",
  Done = "done",
}

export enum TicketKind {
  Build = "build",
  // A release ticket runs alone: no other worker may be running while it does.
  Release = "release",
}

export enum BoardType {
  LocalMarkdown = "local-md",
  GitHub = "github",
  Notion = "notion",
  // Any executable that speaks the board protocol (list / set-status / note). See README.
  Command = "command",
}

export enum AgentType {
  ClaudeCode = "claude-code",
  Codex = "codex",
  // Any executable: gets the prompt on stdin, the session on env. Used for tests and custom agents.
  Command = "command",
}

// How much a Codex run may do unattended.
export enum CodexSandbox {
  // Codex's own "approve for me": workspace-write sandbox, and anything that needs more (a commit into the
  // repository's .git, a push) is escalated to Codex's automatic reviewer. Like Claude Code's auto mode.
  Auto = "auto",
  // Writes only in the worktree and the result folder, never escalates. Codex cannot commit from a worktree here.
  WorkspaceWrite = "workspace-write",
  ReadOnly = "read-only",
  FullAccess = "danger-full-access",
}

export enum PublishMode {
  PullRequest = "pr",
  Branch = "branch",
}

export enum Stage {
  Build = "build",
  Review = "review",
  // A release ticket is one run that follows the project's release rules; it has no review stage.
  Release = "release",
}

// The first word of the one line a build run writes to its result file.
export enum BuildResult {
  PullRequest = "PR",
  Branch = "BRANCH",
  Doc = "DOC",
  Blocked = "BLOCKED",
}

// The first word of the one line a release run writes.
export enum ReleaseResult {
  Done = "DONE",
  Blocked = "BLOCKED",
}

// The one word a review run writes to its verdict file.
export enum Verdict {
  Pass = "PASS",
  Rework = "REWORK",
  Blocked = "BLOCKED",
  NeedsHuman = "NEEDS_HUMAN",
}

// Files kept per ticket under <state>/results/<ticket>.<suffix>
export enum StateFile {
  Build = "build",
  Verdict = "verdict",
  Review = "review",
  ReviewPrevious = "review.prev",
  Stage = "stage",
  Session = "session",
  Tries = "tries",
  Failed = "failed",
  Result = "result",
  ResultKind = "kind",
}

// Why a ticket moved. Boards may act on it (e.g. file a decision page for NeedsHuman).
export enum SettleReason {
  Claimed = "claimed",
  ReadyToMerge = "ready-to-merge",
  Merged = "merged",
  MergeFailed = "merge-failed",
  Accepted = "accepted",
  Released = "released",
  NeedsHuman = "needs-human",
  Blocked = "blocked",
  CutOff = "cut-off",
  Misconfigured = "misconfigured",
}

export enum NoteLanguage {
  English = "en",
  Korean = "ko",
}

export enum SessionMode {
  New = "new",
  Resume = "resume",
}

export enum StageOutcome {
  Finished = "finished",
  Failed = "failed",
  GaveUp = "gave-up",
  // The agent's account hit its usage limit: not counted as a try; everything waits until it resets.
  Limited = "limited",
}

export enum WorkerMode {
  Project = "project",
  Release = "release",
}

export enum HumanGate {
  Money = "money",
  Legal = "legal",
  DestructiveData = "destructive-data",
  OutwardFacing = "outward-facing",
  ProductDirection = "product-direction",
}

export enum CliCommand {
  Init = "init",
  Add = "add",
  Run = "run",
  Work = "work",
  Daemon = "daemon",
  Status = "status",
  Logs = "logs",
  Service = "service",
  Doctor = "doctor",
  Version = "version",
  Help = "help",
}

export enum ServiceAction {
  Install = "install",
  Status = "status",
  Uninstall = "uninstall",
}

export enum GitHubState {
  Open = "OPEN",
  Merged = "MERGED",
  Closed = "CLOSED",
  Unknown = "UNKNOWN",
}

export enum CheckLevel {
  Ok = "ok",
  Warn = "warn",
  Fail = "fail",
}
