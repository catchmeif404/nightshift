#!/usr/bin/env node
// Stand-in developer for the review-quality measurement (TK-461). It makes no model call: it applies the planted change
// ($PLANT_PATCH, a patch against the task's start commit) as one commit, writes the handoff if the prompt asks for one, and
// reports the branch. In a later round (the reviewer sent it back) it only writes BLOCKED, which ends the run.
// The handoff is the same fixed template for every defect: what a developer who did not notice the defect would write.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
const first = prompt.split("\n")[0];
const round = Number(/round (\d+)/.exec(first)?.[1] ?? "1");
const resultFile = /one line to `([^`]+)`/.exec(prompt)?.[1];
const handoffFile = /short handoff to `([^`]+)`/.exec(prompt)?.[1];
const title = /^## Ticket [^:]+: (.*)$/m.exec(prompt)?.[1] ?? "the ticket";
if (resultFile === undefined) { console.error("plant-builder: no result file in the prompt"); process.exit(3); }
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

if (round > 1) {
  writeFileSync(resultFile, "BLOCKED harness stand-in developer does not rework\n");
} else {
  const patch = process.env.PLANT_PATCH;
  if (!patch) { console.error("plant-builder: PLANT_PATCH not set"); process.exit(3); }
  git("apply", patch);
  git("add", "-A");
  git("-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-q", "-m", `feat: ${title}`);
  const files = git("diff", "--name-only", "HEAD~1").split("\n").filter((f) => f !== "");
  if (handoffFile !== undefined) {
    writeFileSync(handoffFile, [
      `Summary: implemented "${title}" as the ticket describes, in one commit.`,
      "Files:", ...files.map((f) => `- ${f}`),
      "Tests: ran the project's test suite; everything passed.", "",
    ].join("\n"));
  }
  writeFileSync(resultFile, `BRANCH ${git("rev-parse", "--abbrev-ref", "HEAD")}\n`);
}
