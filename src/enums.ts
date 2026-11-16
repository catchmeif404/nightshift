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
}

export enum AgentType {
  ClaudeCode = "claude-code",
  // Any executable: gets the prompt on stdin, the session on env. Used for tests and custom agents.
  Command = "command",
}

export enum PublishMode {
  PullRequest = "pr",
  Branch = "branch",
}

export enum Stage {
  Build = "build",
  Review = "review",
}

// The first word of the one line a build run writes to its result file.
export enum BuildResult {
  PullRequest = "PR",
  Branch = "BRANCH",
  Doc = "DOC",
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

export enum SessionMode {
  New = "new",
  Resume = "resume",
}

export enum StageOutcome {
  Finished = "finished",
  Failed = "failed",
  GaveUp = "gave-up",
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
  Doctor = "doctor",
  Version = "version",
  Help = "help",
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
