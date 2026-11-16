import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { initExtras } from "../src/commands.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { DEFAULT_GATE_PATHS, NotifyService } from "../src/enums.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runInit(args: string[]): { root: string; code: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), "nightshift-init-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const r = spawnSync(process.execPath, [CLI, "init", "--root", root, "--repo-path", repo, ...args], { encoding: "utf8" });
  return { root, code: r.status, out: `${r.stdout}${r.stderr}` };
}

function written(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "nightshift.json"), "utf8")) as Record<string, unknown>;
}

test("a plain init writes none of the new settings", () => {
  const { root, code } = runInit([]);
  assert.equal(code, 0);
  const file = written(root);
  for (const key of ["ticketSections", "gatePaths", "notify"]) assert.ok(!(key in file), key);
  const config = loadConfig(root);
  assert.deepEqual([config.ticketSections, config.gatePaths, config.notify.service], [[], [], NotifyService.None]);
});

test("--sections, --gate-paths and --notify write settings the config loader accepts", () => {
  const combos: Array<{ args: string[]; sections: string[]; gates: string[]; service: NotifyService }> = [
    { args: ["--sections", "deliverable,verify,out-of-scope"], sections: ["Deliverable", "Check", "Out of scope"], gates: [], service: NotifyService.None },
    { args: ["--sections", "verify"], sections: ["Check"], gates: [], service: NotifyService.None },
    { args: ["--gate-paths", "default"], sections: [], gates: [...DEFAULT_GATE_PATHS], service: NotifyService.None },
    { args: ["--gate-paths", "infra/**,**/*.tf"], sections: [], gates: ["infra/**", "**/*.tf"], service: NotifyService.None },
    { args: ["--notify", "slack"], sections: [], gates: [], service: NotifyService.Slack },
    { args: ["--notify", "discord"], sections: [], gates: [], service: NotifyService.Discord },
    { args: ["--notify", "telegram", "--notify-chat-id=-1001234567"], sections: [], gates: [], service: NotifyService.Telegram },
    {
      args: ["--sections", "deliverable,verify,out-of-scope", "--gate-paths", "default", "--notify", "telegram", "--notify-chat-id", "42"],
      sections: ["Deliverable", "Check", "Out of scope"],
      gates: [...DEFAULT_GATE_PATHS],
      service: NotifyService.Telegram,
    },
  ];
  for (const c of combos) {
    const { root, code, out } = runInit(c.args);
    assert.equal(code, 0, `${c.args.join(" ")}: ${out}`);
    const config = loadConfig(root);
    assert.deepEqual(config.ticketSections, c.sections, c.args.join(" "));
    assert.deepEqual(config.gatePaths, c.gates, c.args.join(" "));
    assert.equal(config.notify.service, c.service, c.args.join(" "));
    if (c.service !== NotifyService.None) assert.match(out, /export NIGHTSHIFT_\w+ where the runner runs/);
    assert.ok(!JSON.stringify(written(root)).match(/https?:\/\/hooks|token":/i), "no secret in the file");
  }
});

test("bad flag values stop init before anything is written", () => {
  for (const args of [["--sections", "nope"], ["--notify", "email"], ["--notify", "telegram"], ["--notify", "slack", "--notify-chat-id", "1"], ["--notify", "none"]]) {
    const { root, code, out } = runInit(args);
    assert.notEqual(code, 0, args.join(" "));
    assert.match(out, /--sections|--notify/);
    assert.throws(() => loadConfig(root), ConfigError);
  }
});

test("initExtras de-duplicates and expands the default keyword", () => {
  const e = initExtras("verify,verify", "default,default,x/**", "", "");
  assert.deepEqual(e.sections, ["Check"]);
  assert.deepEqual(e.gatePaths, [...DEFAULT_GATE_PATHS, "x/**"]);
  assert.equal(e.notify, NotifyService.None);
});
