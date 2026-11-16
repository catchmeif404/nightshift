import { Ticket } from "./board/board.js";
import { ProjectConfig } from "./config.js";
import { BuildResult, HumanGate, PublishMode, ReleaseResult, Verdict } from "./enums.js";
import { Worktree } from "./git.js";

const GATE_TEXT: Record<HumanGate, string> = {
  [HumanGate.Money]: "money: payments, paid plans, new paid services or subscriptions",
  [HumanGate.Legal]: "legal or policy text: terms, privacy policy, license changes, store listing claims",
  [HumanGate.DestructiveData]:
    "destructive data changes: a migration that drops or rewrites data or breaks installed clients, any write to production data",
  [HumanGate.OutwardFacing]: "outward-facing actions: public posts, emails, publishing a site or a store release",
  [HumanGate.ProductDirection]: "product direction the ticket does not already settle",
};

export const RESUME_PROMPT =
  "The previous run of this stage was cut off (reboot, usage limit or a killed process). Check where it stopped " +
  "(worktree, branch, commits, pull request, the result file your instructions name) and finish this same stage " +
  "from there. Do not redo finished steps, and still write the result file last.";

export interface StageContext {
  ticket: Ticket;
  project: ProjectConfig;
  worktree: Worktree;
  round: number;
  lastRound: boolean;
  rules: string;
  resultFile: string;
  reviewFile: string;
  humanGates: HumanGate[];
  ticketSections: string[];
}

function ticketBlock(ticket: Ticket): string {
  return [`## Ticket ${ticket.id}: ${ticket.title}`, "", ticket.body === "" ? "(no description)" : ticket.body].join("\n");
}

function sectionsBlock(labels: string[], reviewer: boolean): string {
  if (labels.length === 0) return "";
  const list = labels.map((l) => `  - ${l}:`).join("\n");
  const rule = reviewer
    ? "The review grades the work by these items and runs the items that say how to check it itself, instead of trusting the description."
    : "Deliver what these items ask, keep out of what they rule out, and expect the review to grade by them and run the check items itself.";
  return `\n## Ticket form\nThis ticket body carries these items:\n${list}\n${rule}\n`;
}

function rulesBlock(rules: string): string {
  return rules === "" ? "" : `\n## Project rules\n\n${rules}\n`;
}

function gatesBlock(gates: HumanGate[]): string {
  return gates.map((g) => `  - ${GATE_TEXT[g]}`).join("\n");
}

function publishSteps(ctx: StageContext): string {
  if (ctx.project.publish === PublishMode.PullRequest) {
    return [
      `- Commit, push the branch \`${ctx.worktree.branch}\` and open a pull request against \`${ctx.project.baseBranch}\``,
      "  (or update the open one for this branch). Say in its body what changed, how you verified it and what you could not verify.",
      `- Then write \`${BuildResult.PullRequest} <pull request url>\`.`,
    ].join("\n");
  }
  return [
    `- Commit on the branch \`${ctx.worktree.branch}\`. Do not push and do not merge.`,
    `- Then write \`${BuildResult.Branch} ${ctx.worktree.branch}\`.`,
  ].join("\n");
}

export function buildPrompt(ctx: StageContext, reviewNotes: string): string {
  const notes = reviewNotes === "" ? "" : `\n## Review notes from the previous round (fix these first)\n\n${reviewNotes}\n`;
  return `You are the developer for one ticket, round ${ctx.round}. You work alone and unattended: nobody will answer questions.

${ticketBlock(ctx.ticket)}
${sectionsBlock(ctx.ticketSections, false)}${notes}
## How to work
- Your working directory is a git worktree on branch \`${ctx.worktree.branch}\`, made for this ticket. Work only here.
- Read the repository's own agent instructions (CLAUDE.md, AGENTS.md, CONTRIBUTING.md) first and follow them.
- Do not use subagents. Build it yourself in this run and finish only when it is done.
- Keep the change to what the ticket asks. Run the tests, build and lint for what you touched.
- Do not review your own work as final and do not merge: a separate reviewer run does that.
${rulesBlock(ctx.rules)}
## When you are done
The last thing you do is write exactly one line to \`${ctx.resultFile}\`:
${publishSteps(ctx)}
- If the deliverable is a document, not code, write \`${BuildResult.Doc} <url of the document>\`.
- If you cannot finish (failing tests you cannot fix, missing access, a decision only a human can make), write
  \`${BuildResult.Blocked} <one-line reason>\` and leave what you have committed on the branch.
`;
}

export function reviewPrompt(ctx: StageContext, result: string): string {
  const reworkRule = ctx.lastRound
    ? `- This is the last round. Small problems you fix yourself. If it is still not right, write your findings to \`${ctx.reviewFile}\` and the verdict \`${Verdict.Blocked}\`.`
    : `- Bigger problems (wrong approach, missing pieces): do not fix them. Write your findings for the developer to \`${ctx.reviewFile}\` (what is wrong, where, what done looks like) and the verdict \`${Verdict.Rework}\`.`;
  return `You are the reviewer (the CTO) for one ticket, round ${ctx.round}. A separate developer run built it. You work unattended.

${ticketBlock(ctx.ticket)}
${sectionsBlock(ctx.ticketSections, true)}
## What to review
The developer's result: \`${result}\`. Your working directory is the ticket's worktree on branch \`${ctx.worktree.branch}\`;
compare it with \`${ctx.project.baseBranch}\` (for a pull request, \`gh pr diff\` shows the same change).
If the result is a document (\`${BuildResult.Doc}\`), read the document itself and check its claims the way you would check a diff.
- Read the whole change against the ticket and the repository's own agent instructions. Check: it does what the ticket
  asks and nothing more; correctness and edge cases; security (secrets, injection, auth, user data, logs); tests.
- Run the tests yourself. Do not trust "tests pass" in a description.
- Small problems: fix them yourself on the branch, rerun the tests, commit${ctx.project.publish === PublishMode.PullRequest ? " and push" : ""}.
${reworkRule}
- Do not use subagents. Never merge: the runner merges, when it is allowed to.
${rulesBlock(ctx.rules)}
## Things only a human decides
If merging this would need a human's call on any of these, the verdict is \`${Verdict.NeedsHuman}\`:
${gatesBlock(ctx.humanGates)}
Write what the human must decide, the options and your recommendation to \`${ctx.reviewFile}\`.

## When you are done
- On \`${Verdict.Pass}\`, write a short review to \`${ctx.reviewFile}\`: what you checked, what you changed, what is still unverified.
- The last thing you do is write exactly one word to \`${ctx.resultFile}\`: ${Object.values(Verdict).join(", ")}.
`;
}

export function releasePrompt(ctx: StageContext): string {
  return `You are running a release ticket, alone: no other ticket is being worked on right now. You work unattended.

${ticketBlock(ctx.ticket)}

## How to work
- Your working directory is a git worktree on branch \`${ctx.worktree.branch}\`, made from \`${ctx.project.baseBranch}\`.
- Follow the project's release rules below and the repository's own agent instructions exactly. Do not use subagents.
- Verify the release the way the rules say (for example a health check on the live service) before you call it done.
- If anything fails, stop: do not retry blindly and do not roll back on your own unless the rules say so.
${rulesBlock(ctx.rules)}
## Things only a human decides
If the release needs a human's call on any of these, do not release; write \`${ReleaseResult.Blocked}\` with what must be decided:
${gatesBlock(ctx.humanGates)}

## When you are done
The last thing you do is write exactly one line to \`${ctx.resultFile}\`:
- \`${ReleaseResult.Done} <what was released and how you verified it>\` (also when you decided nothing needed releasing, and why), or
- \`${ReleaseResult.Blocked} <one-line reason>\`.
`;
}
