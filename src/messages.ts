import { NoteLanguage, NotifyEvent, Stage } from "./enums.js";
import type { GateHit } from "./git.js";

// Every note the runner writes on a ticket, in each supported language.
export interface Messages {
  claimed: string;
  unknownProject(project: string): string;
  worktreeFailed(error: string): string;
  missingSections(labels: string[]): string;
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
};

const NOTICE_KO: Record<NotifyEvent, string> = {
  [NotifyEvent.Review]: "검토 대기",
  [NotifyEvent.Blocked]: "멈춤, 확인 필요",
  [NotifyEvent.Merged]: "머지 완료",
};

const english: Messages = {
  claimed: "picked up by the developer run.",
  unknownProject: (p) => `project "${p}" is not in the config; add it and set the ticket ready again.`,
  worktreeFailed: (e) => `could not make a worktree: ${e}`,
  missingSections: (l) => `the ticket body lacks these sections (a "Label: text" line each): ${l.join(", ")}. Add them and set the ticket ready again.`,
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
  notice: (event, id, title) => `${id} ${title}: ${NOTICE_EN[event]}`,
};

const korean: Messages = {
  claimed: "개발 실행이 받음.",
  unknownProject: (p) => `설정에 없는 프로젝트 "${p}". 설정에 넣고 다시 할 일로 두세요.`,
  worktreeFailed: (e) => `작업 폴더(worktree)를 만들지 못함: ${e}`,
  missingSections: (l) => `티켓 본문에 빠진 항목: ${l.join(", ")} ("항목: 내용" 한 줄씩). 채운 뒤 다시 할 일로 두세요.`,
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
  notice: (event, id, title) => `${id} ${title}: ${NOTICE_KO[event]}`,
};

export function messagesFor(language: NoteLanguage): Messages {
  return language === NoteLanguage.Korean ? korean : english;
}
