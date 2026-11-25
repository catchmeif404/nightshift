import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DependencyWaitCause, Ticket } from "../src/board/board.js";
import { loadConfig } from "../src/config.js";
import { AgentType, BoardType, CheckLevel, NotifyService, TicketKind, TicketStatus } from "../src/enums.js";
import { SlotInfo, Slots, projectSlotKey } from "../src/state.js";
import { UiServer, startUi } from "../src/ui/server.js";
import { SettingsForm, readSettings } from "../src/ui/settings.js";
import { WaitCause, waitReasons } from "../src/ui/snapshot.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SECRET = "sk-ant-supersecretvalue1234567890";
const TOKEN = "ghp_abcdefghijklmnop1234";
const servers: UiServer[] = [];
const children: ChildProcess[] = [];

after(async () => {
  for (const s of servers) await s.close();
  for (const c of children) c.kill("SIGKILL");
});

interface Box {
  root: string;
  repo: string;
  server: UiServer;
  configFile: string;
}

function raw(repo: string): Record<string, unknown> {
  return {
    board: { type: BoardType.LocalMarkdown, dir: ".tickets", notion: { databaseId: "abc", token: TOKEN } },
    projects: { demo: { repoPath: repo, baseBranch: "main", postMergeCommand: `curl -H "Authorization: Bearer ${TOKEN}" x` } },
    builder: { type: AgentType.ClaudeCode, model: "sonnet", apiKey: SECRET },
    reviewer: { type: AgentType.ClaudeCode, model: "opus" },
    maxSlots: 3,
    autoMerge: false,
    futureField: { keep: ["me"] },
  };
}

async function box(config: Record<string, unknown> | undefined = undefined): Promise<Box> {
  const root = mkdtempSync(join(tmpdir(), "nightshift-ui-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const configFile = join(root, "nightshift.json");
  writeFileSync(configFile, `${JSON.stringify(config ?? raw(repo), null, 2)}\n`, { mode: 0o600 });
  const server = await startUi(root, 0);
  servers.push(server);
  return { root, repo, server, configFile };
}

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

// node:http, so the Host and Origin headers can be set freely (fetch forbids Host).
function call(server: UiServer, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: server.port, path, method: options.method ?? "GET", headers: { host: `127.0.0.1:${server.port}`, ...options.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

async function csrfOf(server: UiServer): Promise<string> {
  const page = await call(server, "/");
  const match = /name="csrf" content="([0-9a-f]+)"/.exec(page.body);
  assert.ok(match?.[1], "page carries a CSRF token");
  return match[1];
}

async function post(b: Box, path: string, body: unknown, token?: string, extra: Record<string, string> = {}): Promise<Reply> {
  const csrf = token ?? (await csrfOf(b.server));
  return call(b.server, path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${b.server.port}`, "x-nightshift-csrf": csrf, ...extra },
    body: JSON.stringify(body),
  });
}

async function formOf(b: Box): Promise<{ form: SettingsForm; revision: string }> {
  const r = await call(b.server, "/api/settings");
  assert.equal(r.status, 200);
  return JSON.parse(r.body) as { form: SettingsForm; revision: string };
}

function ls(dir: string): string {
  return readdirSync(dir).sort().join(",");
}

test("the console listens on the loopback address only", async () => {
  const b = await box();
  assert.match(b.server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test("a wrong Host (DNS rebinding) or a foreign Origin is refused", async () => {
  const b = await box();
  assert.equal((await call(b.server, "/api/status", { headers: { host: "evil.example:80" } })).status, 403);
  assert.equal((await call(b.server, "/api/status", { headers: { origin: "http://evil.example" } })).status, 403);
  assert.equal((await call(b.server, "/api/status", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await call(b.server, "/api/status", { headers: { host: `localhost:${b.server.port}` } })).status, 200);
});

test("writes need the page's CSRF token, an Origin and a JSON body", async () => {
  const b = await box();
  const { form, revision } = await formOf(b);
  const body = { edit: form, revision };
  assert.equal((await post(b, "/api/settings/save", body, "0".repeat(64))).status, 403);
  assert.equal((await call(b.server, "/api/settings/save", { method: "POST", headers: { "content-type": "application/json", "x-nightshift-csrf": await csrfOf(b.server) }, body: JSON.stringify(body) })).status, 403);
  assert.equal((await post(b, "/api/settings/save", body, undefined, { origin: "http://evil.example" })).status, 403);
  assert.equal((await post(b, "/api/settings/save", body, undefined, { "content-type": "text/plain" })).status, 415);
  assert.equal((await call(b.server, "/api/settings/save")).status, 404);
  assert.equal((await call(b.server, "/etc/passwd")).status, 404);
  assert.equal((await call(b.server, "/../../etc/passwd")).status, 404);
});

test("the page has a CSP with a nonce, no secret and no framing", async () => {
  const b = await box();
  const page = await call(b.server, "/");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-security-policy"]), /script-src 'nonce-/);
  assert.equal(page.headers["x-frame-options"], "DENY");
  for (const secret of [SECRET, TOKEN]) assert.ok(!page.body.includes(secret));
});

test("settings and status never reveal a secret, and reading changes nothing", async () => {
  const b = await box();
  const before = ls(b.root);
  const fileBefore = readFileSync(b.configFile, "utf8");
  const settings = await call(b.server, "/api/settings");
  const status = await call(b.server, "/api/status");
  const doctor = await post(b, "/api/doctor", {});
  for (const reply of [settings, status, doctor]) {
    assert.equal(reply.status, 200, reply.body);
    for (const secret of [SECRET, TOKEN]) assert.ok(!reply.body.includes(secret), `${secret} leaked`);
  }
  const view = readSettings(b.root);
  assert.ok(view.preserved.some((p) => p.path === "builder.apiKey" && p.secret && p.value.includes("kept")));
  assert.ok(view.preserved.some((p) => p.path === "projects.demo.postMergeCommand" && !p.value.includes(TOKEN)));
  assert.equal(readFileSync(b.configFile, "utf8"), fileBefore);
  assert.equal(ls(b.root), before.includes(".nightshift") ? before : `${before},.nightshift`.split(",").sort().join(","));
});

test("status shows real workers, their stage and why a ticket waits", async () => {
  const b = await box();
  const config = loadConfig(b.root);
  const slots = new Slots(join(config.stateDir, "slots"));
  mkdirSync(join(config.stateDir, "slots"), { recursive: true });
  assert.ok(slots.tryCreate(projectSlotKey("demo"), "demo", false));
  slots.setPid(projectSlotKey("demo"), process.pid);
  slots.setStage(projectSlotKey("demo"), "T-1 review 2");
  mkdirSync(config.board.dir, { recursive: true });
  writeFileSync(join(config.board.dir, "T-1.md"), "---\ntitle: Wait for me\nproject: demo\nkind: build\nstatus: ready\ncreated: 2026-11-16 00:00\n---\n\nbody\n");
  const status = JSON.parse((await call(b.server, "/api/status")).body) as {
    workers: Array<{ target: string; stage: string; pid: number }>;
    tickets: Record<string, { count: number; items: Array<{ id: string; waiting: Array<{ cause: string }> }> }>;
  };
  assert.deepEqual(status.workers.map((w) => [w.target, w.stage, w.pid]), [["demo", "T-1 review 2", process.pid]]);
  assert.equal(status.tickets.ready?.items[0]?.waiting[0]?.cause, WaitCause.ProjectBusy);
});

test("wait reasons follow the dispatch rules", () => {
  const ticket = (project: string, kind = TicketKind.Build): Ticket => ({ id: "T", title: "t", body: "", project, kind, status: TicketStatus.Ready, createdAt: "", dependsOn: [] });
  const slot = (key: string, release = false): SlotInfo => ({ key, target: key, pid: 1, stage: "", release });
  const causes = (r: ReturnType<typeof waitReasons>): string[] => r.map((x) => x.cause);
  assert.deepEqual(causes(waitReasons(ticket("a"), [], [], 3, ["a"])), [WaitCause.NextDispatch]);
  assert.deepEqual(causes(waitReasons(ticket("a"), [], [{ agent: "claude-code", until: Date.now() + 1000 }], 3, ["a"])), [WaitCause.UsageLimit]);
  assert.deepEqual(causes(waitReasons(ticket("a"), [slot(projectSlotKey("a"))], [], 3, ["a"])), [WaitCause.ProjectBusy]);
  assert.deepEqual(causes(waitReasons(ticket("a"), [slot("x")], [], 1, ["a"])), [WaitCause.NoFreeSlot]);
  assert.deepEqual(causes(waitReasons(ticket("zzz"), [], [], 3, ["a"])), [WaitCause.UnknownProject]);
  assert.deepEqual(causes(waitReasons(ticket("a", TicketKind.Release), [slot("x")], [], 3, ["a"])), [WaitCause.ReleaseWaitsForIdle]);
  assert.ok(causes(waitReasons(ticket("a"), [slot("r", true)], [], 3, ["a"])).includes(WaitCause.ReleaseRunning));
});

test("a predecessor that is not done is a wait reason", () => {
  const t: Ticket = { id: "T", title: "t", body: "", project: "a", kind: TicketKind.Build, status: TicketStatus.Ready, createdAt: "", dependsOn: ["P"] };
  const reasons = waitReasons(t, [], [], 3, ["a"], {}, [{ cause: DependencyWaitCause.Blocked, id: "P" }]);
  assert.deepEqual(reasons, [{ cause: WaitCause.DependencyBlocked, detail: "P" }]);
});

test("edit, check, save: the CLI loader sees it, the rest of the file is kept, a backup exists", async () => {
  const b = await box();
  const before = JSON.parse(readFileSync(b.configFile, "utf8")) as Record<string, unknown>;
  const { form, revision } = await formOf(b);
  const edit: SettingsForm = { ...form, maxSlots: 2, builder: { type: AgentType.Codex, model: "gpt-5.5" }, reviewer: { type: AgentType.ClaudeCode, model: "opus" } };
  const checked = JSON.parse((await post(b, "/api/settings/check", { edit, revision })).body) as { issues: unknown[]; checks: Array<{ what: string }>; changed: string[] };
  assert.deepEqual(checked.changed, ["builder.type", "builder.model", "maxSlots"]);
  assert.ok(checked.checks.length > 0);
  assert.equal(readFileSync(b.configFile, "utf8"), `${JSON.stringify(before, null, 2)}\n`, "check writes nothing");

  const saved = await post(b, "/api/settings/save", { edit, revision });
  assert.equal(saved.status, 200, saved.body);
  const result = JSON.parse(saved.body) as { backup: string; runningWorkers: unknown[] };
  assert.ok(existsSync(result.backup));
  assert.deepEqual(JSON.parse(readFileSync(result.backup, "utf8")), before);

  const config = loadConfig(b.root);
  assert.equal(config.maxSlots, 2);
  assert.deepEqual([config.builder.type, config.builder.model], [AgentType.Codex, "gpt-5.5"]);
  const after = JSON.parse(readFileSync(b.configFile, "utf8")) as Record<string, Record<string, unknown>>;
  assert.equal(after.builder?.apiKey, SECRET, "the secret value is kept as it was");
  assert.deepEqual(after.futureField, { keep: ["me"] });
  assert.equal(after.autoMerge as unknown, false, "saving never approves auto-merge");
  assert.equal(readFileSync(b.configFile, "utf8").includes(TOKEN), true);
  assert.equal((await import("node:fs")).statSync(b.configFile).mode & 0o777, 0o600);
  assert.ok(!readdirSync(b.root).some((f) => f.includes(".tmp-")), "no temp file is left");
  // Saving starts nothing: no worker slot, no ticket.
  assert.deepEqual(readdirSync(join(loadConfig(b.root).stateDir, "slots")), []);
  assert.ok(!existsSync(join(b.root, ".tickets")) || readdirSync(join(b.root, ".tickets")).length === 0);
});

test("a saved setting survives a restart of the console", async () => {
  const b = await box();
  const { form, revision } = await formOf(b);
  assert.equal((await post(b, "/api/settings/save", { edit: { ...form, maxSlots: 5 }, revision })).status, 200);
  await b.server.close();
  const again = await startUi(b.root, 0);
  servers.push(again);
  const view = JSON.parse((await call(again, "/api/settings")).body) as { form: SettingsForm };
  assert.equal(view.form.maxSlots, 5);
});

test("a symlinked config stays a symlink; the file it points to is saved", async () => {
  const b = await box();
  const real = join(b.root, "real.json");
  renameSync(b.configFile, real);
  symlinkSync("real.json", b.configFile);
  const { form, revision } = await formOf(b);
  assert.equal((await post(b, "/api/settings/save", { edit: { ...form, maxSlots: 4 }, revision })).status, 200);
  assert.ok(lstatSync(b.configFile).isSymbolicLink());
  assert.equal(loadConfig(b.root).maxSlots, 4);
  assert.equal((JSON.parse(readFileSync(real, "utf8")) as { maxSlots: number }).maxSlots, 4);
});

test("wrong values are refused with the field named, and nothing is written", async () => {
  const b = await box();
  const file = readFileSync(b.configFile, "utf8");
  const { form, revision } = await formOf(b);
  const bad: Array<[string, SettingsForm]> = [
    ["maxSlots", { ...form, maxSlots: 0 }],
    ["maxSlots", { ...form, maxSlots: 2.5 }],
    ["builder.model", { ...form, builder: { type: AgentType.ClaudeCode, model: "sonnet; rm -rf /" } }],
    ["builder.type", { ...form, builder: { type: AgentType.Command, model: "x" } }],
    ["board.type", { ...form, board: { ...form.board, type: BoardType.Command } }],
    ["board.dir", { ...form, board: { ...form.board, dir: "../../elsewhere" } }],
    ["board.dir", { ...form, board: { ...form.board, dir: "/etc" } }],
    ["board.repos", { ...form, board: { ...form.board, type: BoardType.GitHub, repos: ["not a repo"] } }],
    ["board.repos", { ...form, board: { ...form.board, type: BoardType.GitHub, repos: [] } }],
    ["projects.demo.repoPath", { ...form, projects: [{ name: "demo", repoPath: join(b.root, "missing"), testCommand: "" }] }],
    ["projects.ghost.repoPath", { ...form, projects: [{ name: "ghost", repoPath: b.repo, testCommand: "" }] }],
  ];
  for (const [field, edit] of bad) {
    const r = await post(b, "/api/settings/save", { edit, revision });
    assert.equal(r.status, 422, `${field}: ${r.body}`);
    const issues = (JSON.parse(r.body) as { issues: Array<{ field: string; level: CheckLevel }> }).issues;
    assert.ok(issues.some((i) => i.field === field && i.level === CheckLevel.Fail), `${field} named in ${r.body}`);
  }
  assert.equal(readFileSync(b.configFile, "utf8"), file);
  assert.deepEqual(readdirSync(b.root).filter((f) => f.includes(".bak-")), []);
  assert.equal((await post(b, "/api/settings/save", { edit: { ...form, extra: 1, builder: "x" }, revision })).status, 400);
});

test("a change made on disk after the page loaded is not overwritten", async () => {
  const b = await box();
  const { form, revision } = await formOf(b);
  const onDisk = JSON.parse(readFileSync(b.configFile, "utf8")) as Record<string, unknown>;
  writeFileSync(b.configFile, JSON.stringify({ ...onDisk, maxRework: 4 }));
  const r = await post(b, "/api/settings/save", { edit: { ...form, maxSlots: 2 }, revision });
  assert.equal(r.status, 409);
  assert.equal((JSON.parse(readFileSync(b.configFile, "utf8")) as Record<string, unknown>).maxRework, 4);
});

test("a field that was already wrong is kept, and does not lock the other fields", async () => {
  const b = await box({ ...raw("/tmp"), pollSeconds: "often", builder: { type: AgentType.ClaudeCode, model: "sonnet", apiKey: SECRET } });
  const view = JSON.parse((await call(b.server, "/api/settings")).body) as { form: SettingsForm; revision: string; problems: string[] };
  assert.match(view.problems.join(), /pollSeconds/);
  const r = await post(b, "/api/settings/save", { edit: { ...view.form, maxSlots: 4 }, revision: view.revision });
  assert.equal(r.status, 200, r.body);
  const after = JSON.parse(readFileSync(b.configFile, "utf8")) as Record<string, unknown>;
  assert.equal(after.pollSeconds, "often");
  assert.equal(after.maxSlots, 4);
  // A new error in an edited field is still refused, even though the file already had one.
  const again = JSON.parse((await call(b.server, "/api/settings")).body) as { form: SettingsForm; revision: string };
  assert.equal((await post(b, "/api/settings/save", { edit: { ...again.form, maxSlots: 99 }, revision: again.revision })).status, 422);
});

test("board, executor and model combinations all load through the CLI's own parser", async () => {
  const b = await box();
  const combos: Array<[BoardType, AgentType, string, AgentType, string]> = [
    [BoardType.LocalMarkdown, AgentType.ClaudeCode, "sonnet", AgentType.ClaudeCode, "opus"],
    [BoardType.GitHub, AgentType.ClaudeCode, "claude-sonnet-5-5", AgentType.Codex, "gpt-5.5"],
    [BoardType.GitHub, AgentType.Codex, "", AgentType.Codex, ""],
    [BoardType.LocalMarkdown, AgentType.Codex, "gpt-5.5", AgentType.ClaudeCode, ""],
  ];
  for (const [board, bType, bModel, rType, rModel] of combos) {
    const { form, revision } = await formOf(b);
    const edit: SettingsForm = {
      ...form,
      board: { ...form.board, type: board, repos: board === BoardType.GitHub ? ["catchmeif404/nightshift"] : [], trustedAuthors: board === BoardType.GitHub ? ["catchmeif404"] : [] },
      builder: { type: bType, model: bModel },
      reviewer: { type: rType, model: rModel },
    };
    const r = await post(b, "/api/settings/save", { edit, revision });
    assert.equal(r.status, 200, r.body);
    const config = loadConfig(b.root);
    assert.equal(config.board.type, board);
    assert.deepEqual([config.builder.type, config.reviewer.type], [bType, rType]);
  }
});

test("a custom command executor is shown as locked and stays as it is", async () => {
  const b = await box({ ...raw("/tmp"), builder: { type: AgentType.Command, command: "/bin/true", model: "m" } });
  const view = JSON.parse((await call(b.server, "/api/settings")).body) as { form: SettingsForm; revision: string; lockedBuilder: boolean };
  assert.equal(view.lockedBuilder, true);
  const r = await post(b, "/api/settings/save", { edit: { ...view.form, maxSlots: 2 }, revision: view.revision });
  assert.equal(r.status, 200, r.body);
  assert.equal((JSON.parse(readFileSync(b.configFile, "utf8")) as { builder: { command: string } }).builder.command, "/bin/true");
});

test("`nightshift ui` really starts, serves the page and stops", async () => {
  const b = await box();
  const child = spawn(process.execPath, [CLI, "ui", "--root", b.root, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (m?.[1]) resolve(m[1]);
    });
    child.on("exit", () => reject(new Error(`exited: ${out}`)));
  });
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /nightshift/);
  child.kill("SIGINT");
  await new Promise((r) => child.on("exit", r));
});

test("ticket form, gated paths and notifications are shown, saved and read back, and the rest of the file is kept", async () => {
  const b = await box({ ...raw("/tmp"), notify: { service: NotifyService.Slack, webhookUrlEnv: "MY_HOOK", events: ["review"] } });
  const first = await formOf(b);
  assert.deepEqual(first.form.ticketSections, []);
  assert.equal(first.form.notify.service, NotifyService.Slack);
  const edit: SettingsForm = {
    ...first.form,
    ticketSections: ["Deliverable", "Check", "Out of scope"],
    gatePaths: ["db/migration/**", "**/*.sql"],
    notify: { service: NotifyService.Telegram, chatId: "-1001234567" },
  };
  const r = await post(b, "/api/settings/save", { edit, revision: first.revision });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual((JSON.parse(r.body) as { changed: string[] }).changed, ["ticketSections", "gatePaths", "notify.service", "notify.chatId"]);
  const config = loadConfig(b.root);
  assert.deepEqual(config.ticketSections, edit.ticketSections);
  assert.deepEqual(config.gatePaths, edit.gatePaths);
  assert.deepEqual([config.notify.service, config.notify.chatId], [NotifyService.Telegram, "-1001234567"]);
  const file = JSON.parse(readFileSync(b.configFile, "utf8")) as { notify: Record<string, unknown> };
  assert.equal(file.notify.webhookUrlEnv, "MY_HOOK");
  assert.deepEqual(file.notify.events, ["review"]);
  const again = await formOf(b);
  assert.deepEqual(again.form.ticketSections, edit.ticketSections);
  assert.deepEqual(again.form.gatePaths, edit.gatePaths);
  assert.deepEqual(again.form.notify, edit.notify);
  const off = await post(b, "/api/settings/save", { edit: { ...again.form, ticketSections: [], gatePaths: [], notify: { service: NotifyService.None, chatId: "" } }, revision: again.revision });
  assert.equal(off.status, 200, off.body);
  assert.deepEqual(loadConfig(b.root).ticketSections, []);
});

test("a bad ticket label, glob or chat id is refused and nothing is written", async () => {
  const b = await box();
  const { form, revision } = await formOf(b);
  const file = readFileSync(b.configFile, "utf8");
  const bad: Array<[string, SettingsForm]> = [
    ["config", { ...form, ticketSections: ["Check:"] }],
    ["config", { ...form, ticketSections: ["A", "a"] }],
    ["config", { ...form, gatePaths: [" "] }],
    ["notify.chatId", { ...form, notify: { service: NotifyService.Telegram, chatId: "not a chat" } }],
    ["config", { ...form, notify: { service: NotifyService.Telegram, chatId: "" } }],
  ];
  for (const [field, edit] of bad) {
    const r = await post(b, "/api/settings/save", { edit, revision });
    assert.equal(r.status, 422, r.body);
    assert.ok((JSON.parse(r.body) as { issues: Array<{ field: string }> }).issues.some((i) => i.field === field), `${field}: ${r.body}`);
  }
  assert.equal(readFileSync(b.configFile, "utf8"), file);
});

test("testCommand can be edited in the console, is written to the project and leaves the rest of it alone", async () => {
  const b = await box();
  const { form, revision } = await formOf(b);
  assert.deepEqual(form.projects.map((p) => p.testCommand), [""]);
  const edit: SettingsForm = { ...form, projects: form.projects.map((p) => ({ ...p, testCommand: "npm test" })) };
  const saved = await post(b, "/api/settings/save", { edit, revision });
  assert.equal(saved.status, 200, saved.body);
  assert.equal(loadConfig(b.root).projects[0]?.testCommand, "npm test");
  const file = JSON.parse(readFileSync(b.configFile, "utf8")) as { projects: { demo: Record<string, unknown> } };
  assert.equal(file.projects.demo.baseBranch, "main");
  assert.equal(file.projects.demo.testCommand, "npm test");
  const bad = await post(b, "/api/settings/check", { edit: { ...edit, projects: [{ ...(edit.projects[0] ?? { name: "demo", repoPath: b.repo }), testCommand: "x".repeat(2000) }] }, revision: readSettings(b.root).revision });
  assert.match(bad.body, /testCommand/);
});
