import { DependencyWait, DependencyWaitCause } from "./board/board.js";
import { NoteLanguage, NotifyEvent, PreflightCause, ReportGroup, Stage } from "./enums.js";
import type { GateHit } from "./git.js";

// The words of the morning report (CLI, chat message and console card).
export interface ReportWords {
  title(from: string, to: string): string;
  none: string;
  group: Record<ReportGroup, string>;
  tokensUnknown: string;
  totals(tickets: number, firstPass: string, tokens: string, limitWait: string): string;
  todoHeader: string;
  todoNone: string;
  todoMerge(ticket: string, where: string): string;
  todoUnblock(ticket: string): string;
  todoDecide(ticket: string): string;
  sendNothing: string;
  sent: string;
}

// Every note the runner writes on a ticket, in each supported language.
export interface Messages {
  claimed: string;
  unknownProject(project: string): string;
  worktreeFailed(error: string): string;
  missingSections(labels: string[]): string;
  // Why a ticket waits for (or never starts because of) a ticket it depends on.
  dependencyWait(wait: DependencyWait): string;
  buildBlocked(reason: string): string;
  sentBack(round: number): string;
  stillNotRight(rounds: number, review: string): string;
  reviewBlocked(review: string): string;
  needsHuman(result: string, review: string): string;
  gatePaths(hits: GateHit[], result: string, review: string): string;
  gatePathsUnknown(error: string, result: string): string;
  mergeFailed(error: string, result: string, review: string): string;
  merged(result: string, review: string, postMerge: string): string;
  docAccepted(result: string, review: string): string;
  readyToMerge(where: string, review: string): string;
  branch(name: string): string;
  cutOff(stage: Stage, times: number, reason: string, log: string): string;
  stillWorking(stage: Stage, round: number): string;
  usageLimit(agent: string, until: string): string;
  postMerge(code: number, tail: string): string;
  released(summary: string): string;
  releaseBlocked(reason: string): string;
  noReason: string;
  // Why a project cannot start: the publish check failed. detail may be empty.
  preflight(cause: PreflightCause, project: string, detail: string): string;
  // The first line of the Blocked message for a project that cannot start.
  preflightNotice(project: string): string;
  report: ReportWords;
  // The first line of a Telegram / Slack / Discord message.
  notice(event: NotifyEvent, id: string, title: string): string;
}

function hitList(hits: GateHit[]): string {
  return hits.map((h) => `${h.glob} -> ${h.files.join(", ")}`).join("; ");
}

function withReview(review: string, label: string): string {
  return review === "" ? "" : ` ${label}: ${review}`;
}

const NOTICE_EN: Record<NotifyEvent, string> = {
  [NotifyEvent.Review]: "ready for your review",
  [NotifyEvent.Blocked]: "stopped, needs you",
  [NotifyEvent.Merged]: "merged",
  [NotifyEvent.DailyReport]: "morning report",
};

const NOTICE_KO: Record<NotifyEvent, string> = {
  [NotifyEvent.Review]: "검토 대기",
  [NotifyEvent.Blocked]: "멈춤, 확인 필요",
  [NotifyEvent.Merged]: "머지 완료",
  [NotifyEvent.DailyReport]: "아침 보고",
};

const REPORT_EN: ReportWords = {
  title: (from, to) => `nightshift report ${from} - ${to}`,
  none: "none: no ticket moved in this period.",
  group: {
    [ReportGroup.Passed]: "Passed (merged or waiting for review)",
    [ReportGroup.Reworked]: "Passed after rework",
    [ReportGroup.Blocked]: "Blocked",
    [ReportGroup.NeedsHuman]: "Needs a human decision",
  },
  tokensUnknown: "tokens unknown",
  totals: (tickets, firstPass, tokens, limitWait) => `Totals: ${tickets} tickets · first-pass ${firstPass} · ${tokens} tokens · waited for usage limits ${limitWait}`,
  todoHeader: "To do now",
  todoNone: "nothing waits for you.",
  todoMerge: (id, where) => `${id}: review and merge${where === "" ? "" : ` ${where}`}`,
  todoUnblock: (id) => `${id}: read why it is blocked, fix it and set it ready again`,
  todoDecide: (id) => `${id}: decide, then set it ready again or close it`,
  sendNothing: "nothing to send with: set notify.service or notifyCommand in the config.",
  sent: "report sent.",
};

const REPORT_KO: ReportWords = {
  title: (from, to) => `nightshift 보고 ${from} ~ ${to}`,
  none: "없음: 이 기간에 움직인 티켓이 없습니다.",
  group: {
    [ReportGroup.Passed]: "통과 (머지됨 또는 리뷰 대기)",
    [ReportGroup.Reworked]: "재작업 후 통과",
    [ReportGroup.Blocked]: "막힘",
    [ReportGroup.NeedsHuman]: "사람 판단 필요",
  },
  tokensUnknown: "토큰 알 수 없음",
  totals: (tickets, firstPass, tokens, limitWait) => `합계: 티켓 ${tickets}개 · 1회 통과 ${firstPass} · 토큰 ${tokens} · 사용 한도로 기다린 시간 ${limitWait}`,
  todoHeader: "지금 할 일",
  todoNone: "기다리는 일이 없습니다.",
  todoMerge: (id, where) => `${id}: 검토하고 머지${where === "" ? "" : ` ${where}`}`,
  todoUnblock: (id) => `${id}: 막힌 사유를 읽고 고친 뒤 다시 할 일로 두기`,
  todoDecide: (id) => `${id}: 결정한 뒤 다시 할 일로 두거나 닫기`,
  sendNothing: "보낼 곳이 없습니다: 설정에 notify.service 또는 notifyCommand 를 넣으세요.",
  sent: "보고를 보냈습니다.",
};

const english: Messages = {
  claimed: "picked up by the developer run.",
  unknownProject: (p) => `project "${p}" is not in the config; add it and set the ticket ready again.`,
  worktreeFailed: (e) => `could not make a worktree: ${e}`,
  missingSections: (l) => `the ticket body lacks these sections (a "Label: text" line each): ${l.join(", ")}. Add them and set the ticket ready again.`,
  dependencyWait: (w) => ({
    [DependencyWaitCause.Missing]: `depends on ${w.id}, which is not on the board`,
    [DependencyWaitCause.Self]: `depends on itself (${w.id})`,
    [DependencyWaitCause.Cycle]: `waits in a loop with ${w.id}`,
    [DependencyWaitCause.Blocked]: `predecessor ${w.id} is blocked`,
    [DependencyWaitCause.Pending]: `waiting for predecessor ${w.id} to be done`,
  })[w.cause],
  buildBlocked: (r) => `the developer could not finish: ${r}`,
  sentBack: (round) => `review round ${round}: sent back for rework.`,
  stillNotRight: (rounds, review) => `still not right after ${rounds} rounds.${withReview(review, "Review")}`,
  reviewBlocked: (review) => `review blocked it.${withReview(review, "Review")}`,
  needsHuman: (result, review) => `needs a human decision before merging (${result}).${withReview(review, "Review")}`,
  gatePaths: (hits, result, review) => `review passed, but the change touches gated paths, so a human must look before merging (${result}). Matched: ${hitList(hits)}.${withReview(review, "Review")}`,
  gatePathsUnknown: (e, result) => `could not list the changed files to check gatePaths, so a human must look before merging (${result}): ${e}`,
  mergeFailed: (e, result, review) => `review passed but the merge failed (${e}): ${result}.${withReview(review, "Review")}`,
  merged: (result, review, post) => `merged ${result}.${withReview(review, "Review")}${post}`,
  docAccepted: (result, review) => `document accepted: ${result}.${withReview(review, "Review")}`,
  readyToMerge: (where, review) => `review passed, ready for you to merge: ${where}.${withReview(review, "Review")}`,
  branch: (name) => `branch ${name}`,
  cutOff: (stage, n, reason, log) => `the ${stage} stage was cut off ${n} times. Last log line: ${reason} (log: ${log})`,
  stillWorking: (stage, round) => `still working: ${stage} stage, round ${round}.`,
  usageLimit: (agent, until) => `${agent} hit its usage limit; waiting until ${until}, then resuming the same session (not counted as a try).`,
  postMerge: (code, tail) => ` Post-merge check (exit ${code}): ${tail}`,
  released: (summary) => `release done: ${summary}`,
  releaseBlocked: (reason) => `release blocked: ${reason}`,
  noReason: "no reason given",
  preflight: (cause, project, detail) => {
    const where = detail === "" ? "" : ` (${detail})`;
    switch (cause) {
      case PreflightCause.NoOrigin:
        return `project ${project}: the repository has no "origin" remote, so a pull request cannot be opened. Add one (git remote add origin <url>) or set publish to "branch".`;
      case PreflightCause.NotGitHub:
        return `project ${project}: the "origin" remote is not a GitHub repository${where}.`;
      case PreflightCause.NoPushPermission:
        return `project ${project}: the active gh account cannot push to ${detail}. Switch with "gh auth switch" or ask for write access.`;
      case PreflightCause.GhFailed:
        return `project ${project}: could not ask GitHub about push access${where}. Check "gh auth status".`;
    }
  },
  preflightNotice: (project) => `${project}: not started, cannot publish`,
  report: REPORT_EN,
  notice: (event, id, title) => `${id} ${title}: ${NOTICE_EN[event]}`,
};

const korean: Messages = {
  claimed: "개발 실행이 받음.",
  unknownProject: (p) => `설정에 없는 프로젝트 "${p}". 설정에 넣고 다시 할 일로 두세요.`,
  worktreeFailed: (e) => `작업 폴더(worktree)를 만들지 못함: ${e}`,
  missingSections: (l) => `티켓 본문에 빠진 항목: ${l.join(", ")} ("항목: 내용" 한 줄씩). 채운 뒤 다시 할 일로 두세요.`,
  dependencyWait: (w) => ({
    [DependencyWaitCause.Missing]: `선행 ${w.id} 이 보드에 없음`,
    [DependencyWaitCause.Self]: `자기 자신(${w.id})에 의존함`,
    [DependencyWaitCause.Cycle]: `${w.id} 와 서로 기다리는 순환`,
    [DependencyWaitCause.Blocked]: `선행 ${w.id} 이 막힘`,
    [DependencyWaitCause.Pending]: `선행 ${w.id} 이 끝나기를 기다림`,
  })[w.cause],
  buildBlocked: (r) => `개발 단계에서 막힘: ${r}`,
  sentBack: (round) => `${round}회차 검토: 재작업으로 돌려보냄.`,
  stillNotRight: (rounds, review) => `${rounds}회차까지 고쳐도 통과 못 함.${withReview(review, "검토")}`,
  reviewBlocked: (review) => `검토 단계에서 막힘.${withReview(review, "검토")}`,
  needsHuman: (result, review) => `머지 전에 사람 결정이 필요함 (${result}).${withReview(review, "검토")}`,
  gatePaths: (hits, result, review) => `검토는 통과했지만 지정 경로(gatePaths)가 바뀌어 머지 전에 사람이 봐야 함 (${result}). 맞은 글롭 -> 파일: ${hitList(hits)}.${withReview(review, "검토")}`,
  gatePathsUnknown: (e, result) => `바뀐 파일 목록을 얻지 못해 gatePaths를 검사할 수 없음. 머지 전에 사람이 봐야 함 (${result}): ${e}`,
  mergeFailed: (e, result, review) => `검토는 통과했지만 머지 실패 (${e}): ${result}.${withReview(review, "검토")}`,
  merged: (result, review, post) => `머지함: ${result}.${withReview(review, "검토")}${post}`,
  docAccepted: (result, review) => `문서 결과 통과: ${result}.${withReview(review, "검토")}`,
  readyToMerge: (where, review) => `검토 통과, 머지만 남음: ${where}.${withReview(review, "검토")}`,
  branch: (name) => `브랜치 ${name}`,
  cutOff: (stage, n, reason, log) => `${stage} 단계가 ${n}번 끊김. 마지막 로그: ${reason} (로그: ${log})`,
  stillWorking: (stage, round) => `생존 신호: ${stage} 단계 진행 중 (${round}회차).`,
  usageLimit: (agent, until) => `${agent} 사용량 한도. ${until}까지 기다렸다가 같은 세션으로 이어 갑니다 (시도 횟수로 세지 않음).`,
  postMerge: (code, tail) => ` 머지 뒤 점검 (exit ${code}): ${tail}`,
  released: (summary) => `출시 처리 끝: ${summary}`,
  releaseBlocked: (reason) => `출시 막힘: ${reason}`,
  noReason: "사유 없음",
  preflight: (cause, project, detail) => {
    const where = detail === "" ? "" : ` (${detail})`;
    switch (cause) {
      case PreflightCause.NoOrigin:
        return `프로젝트 ${project}: 저장소에 "origin" 원격이 없어 PR 을 열 수 없습니다. 원격을 추가하거나(git remote add origin <url>) publish 를 "branch" 로 바꾸세요.`;
      case PreflightCause.NotGitHub:
        return `프로젝트 ${project}: "origin" 원격이 GitHub 저장소가 아닙니다${where}.`;
      case PreflightCause.NoPushPermission:
        return `프로젝트 ${project}: 지금 활성인 gh 계정이 ${detail} 에 push 할 수 없습니다. "gh auth switch" 로 계정을 바꾸거나 쓰기 권한을 받으세요.`;
      case PreflightCause.GhFailed:
        return `프로젝트 ${project}: push 권한을 GitHub 에 물어보지 못했습니다${where}. "gh auth status" 를 확인하세요.`;
    }
  },
  preflightNotice: (project) => `${project}: 시작하지 않음, 게시할 수 없음`,
  report: REPORT_KO,
  notice: (event, id, title) => `${id} ${title}: ${NOTICE_KO[event]}`,
};

export function messagesFor(language: NoteLanguage): Messages {
  return language === NoteLanguage.Korean ? korean : english;
}
