import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { dispatch } from "../src/dispatch.js";
import { PreflightCause, PublishMode, TicketKind, TicketStatus } from "../src/enums.js";
import { ExecResult } from "../src/exec.js";
import { Probe, checkPublish, parseRemote } from "../src/preflight.js";
import { snapshot } from "../src/ui/snapshot.js";
import { WaitCause } from "../src/ui/snapshot.js";
import { sandbox } from "./helpers.js";

const done = (code: number, stdout = "", stderr = ""): ExecResult => ({ code, stdout, stderr });

// A fake git and gh: the remote url and gh's answer to "repos/<owner>/<repo>".
function fake(remote: ExecResult, gh: ExecResult, calls: string[] = []): Probe {
  return async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return command === "git" ? remote : gh;
  };
}

const ORIGIN = done(0, "git@github.com:acme/app.git\n");

function projectOf(publish: PublishMode): { config: ReturnType<typeof parseConfig>; project: ReturnType<typeof parseConfig>["projects"][number] } {
  const config = parseConfig({ projects: { app: { repoPath: "/tmp/app", publish } } }, "/tmp");
  return { config, project: config.projects[0]! };
}

test("remote urls: ssh, https, other hosts", () => {
  assert.deepEqual(parseRemote("git@github.com:acme/app.git"), { host: "github.com", owner: "acme", name: "app" });
  assert.deepEqual(parseRemote("https://github.com/acme/app"), { host: "github.com", owner: "acme", name: "app" });
  assert.deepEqual(parseRemote("ssh://git@ghe.example.com:22/acme/app.git"), { host: "ghe.example.com", owner: "acme", name: "app" });
  assert.equal(parseRemote("/local/path"), undefined);
});

test("a pull-request project passes when gh says the account can push", async () => {
  const { config, project } = projectOf(PublishMode.PullRequest);
  const calls: string[] = [];
  const result = await checkPublish(config, project, fake(ORIGIN, done(0, "true\n"), calls));
  assert.equal(result.ok, true);
  assert.ok(calls.includes("gh api repos/acme/app --jq .permissions.push"));
});

test("no push permission is a failure that names the repository", async () => {
  const { config, project } = projectOf(PublishMode.PullRequest);
  const result = await checkPublish(config, project, fake(ORIGIN, done(0, "false\n")));
  assert.equal(result.ok, false);
  assert.equal(result.cause, PreflightCause.NoPushPermission);
  assert.match(result.message, /acme\/app/);
});

test("no origin is a failure, and gh is never asked", async () => {
  const { config, project } = projectOf(PublishMode.PullRequest);
  const calls: string[] = [];
  const result = await checkPublish(config, project, fake(done(2, "", "error: No such remote 'origin'"), done(0, "true"), calls));
  assert.equal(result.cause, PreflightCause.NoOrigin);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
});

test("a gh failure is reported, not mistaken for 'allowed'", async () => {
  const { config, project } = projectOf(PublishMode.PullRequest);
  const result = await checkPublish(config, project, fake(ORIGIN, done(1, "", "HTTP 404")));
  assert.equal(result.cause, PreflightCause.GhFailed);
  assert.equal(result.ok, false);
});

test("a branch project passes without a remote and without calling anything", async () => {
  const { config, project } = projectOf(PublishMode.Branch);
  const calls: string[] = [];
  const result = await checkPublish(config, project, fake(done(2), done(1), calls));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, []);
});

test("dispatch leaves the tickets of an unpublishable project alone and tells once", async () => {
  const box = sandbox({ notifyCommand: "" }, PublishMode.PullRequest);
  const sent: string[] = [];
  const script = `${box.root}/notify.sh`;
  const { writeFileSync, chmodSync } = await import("node:fs");
  writeFileSync(script, `#!/bin/sh\necho "$1" >> ${box.root}/sent.txt\n`);
  chmodSync(script, 0o755);
  const runner = { ...box.runner, config: { ...box.runner.config, notifyCommand: script } };
  box.board.create("Do it", "demo", TicketKind.Build, "Goal: x");
  let spawned = 0;
  const probe = fake(ORIGIN, done(0, "false\n"));
  assert.deepEqual(await dispatch(runner, () => (spawned += 1), probe), []);
  assert.deepEqual(await dispatch(runner, () => (spawned += 1), probe), []);
  assert.equal(spawned, 0);
  assert.equal((await box.board.list(TicketStatus.Ready)).length, 1, "the ticket is still ready");
  sent.push(...readFileSync(`${box.root}/sent.txt`, "utf8").trim().split("\n"));
  assert.equal(sent.filter((l) => l.includes("demo")).length >= 1, true);
  assert.equal(readFileSync(`${box.root}/sent.txt`, "utf8").split("not started").length - 1, 1, "same reason: one message");
  assert.match(readFileSync(runner.paths.log, "utf8"), /cannot push to acme\/app/);

  // The console shows it as a reason to wait.
  const view = await snapshot(runner.config);
  assert.equal(view.tickets.ready.items[0]?.waiting[0]?.cause, WaitCause.PreflightFailed);

  // Fixed: the ticket starts, and a later problem is announced again.
  const starts = await dispatch(runner, () => process.pid, fake(ORIGIN, done(0, "true\n")));
  assert.equal(starts.length, 1);
  runner.slots.remove(starts[0]!.key);
  await dispatch(runner, () => (spawned += 1), fake(ORIGIN, done(0, "false\n")));
  assert.equal(readFileSync(`${box.root}/sent.txt`, "utf8").split("not started").length - 1, 2);
});
