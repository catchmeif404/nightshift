import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Brand } from "./brand.js";
import { Config } from "./config.js";
import { CliCommand } from "./enums.js";
import { run } from "./exec.js";
import { statePaths } from "./state.js";

enum Platform {
  MacOS = "darwin",
  Linux = "linux",
}

export class ServiceError extends Error {}

// Everything the service file needs, gathered at install time.
export interface ServiceSpec {
  label: string;
  node: string;
  cli: string;
  root: string;
  pollSeconds: number;
  path: string;
  home: string;
  log: string;
}

const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

// One service per queue folder, so two queues on one machine do not collide.
export function serviceLabel(root: string): string {
  return `dev.${Brand.name}.${createHash("sha1").update(root).digest("hex").slice(0, 8)}`;
}

export function serviceSpec(config: Config): ServiceSpec {
  return {
    label: serviceLabel(config.root),
    node: process.execPath,
    cli: CLI_PATH,
    root: config.root,
    pollSeconds: config.pollSeconds,
    // The PATH of the shell that installs it, so the service finds node, git, gh, claude and codex the same way.
    path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    home: homedir(),
    log: join(config.stateDir, "service.log"),
  };
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A LaunchAgent that runs "nightshift run" every pollSeconds and at login. AbandonProcessGroup keeps launchd from
// killing the workers "run" leaves running in the background when it exits.
export function launchdPlist(s: ServiceSpec): string {
  const args = [s.node, s.cli, CliCommand.Run, "--root", s.root].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(s.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${xml(s.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(s.path)}</string>
    <key>HOME</key><string>${xml(s.home)}</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>StartInterval</key><integer>${s.pollSeconds}</integer>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(s.log)}</string>
  <key>StandardErrorPath</key><string>${xml(s.log)}</string>
</dict>
</plist>
`;
}

function quote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

// A oneshot service plus a timer. KillMode=process keeps systemd from stopping the background workers with "run".
export function systemdUnits(s: ServiceSpec): { service: string; timer: string } {
  const exec = [s.node, s.cli, CliCommand.Run, "--root", s.root].map(quote).join(" ");
  return {
    service: `[Unit]
Description=${Brand.name} queue in ${s.root}

[Service]
Type=oneshot
ExecStart=${exec}
WorkingDirectory=${s.root}
Environment=${quote(`PATH=${s.path}`)}
Environment=HOME=${s.home}
Environment=LANG=en_US.UTF-8
KillMode=process
StandardOutput=append:${s.log}
StandardError=append:${s.log}
`,
    timer: `[Unit]
Description=Run ${Brand.name} every ${s.pollSeconds}s for ${s.root}

[Timer]
OnBootSec=60
OnUnitActiveSec=${s.pollSeconds}
Unit=${s.label}.service

[Install]
WantedBy=timers.target
`,
  };
}

function launchAgentPath(label: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function systemdDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function domain(): string {
  return `gui/${userInfo().uid}`;
}

async function must(command: string, args: string[], cwd: string): Promise<string> {
  const result = await run(command, args, cwd);
  if (result.code !== 0) throw new ServiceError(`${command} ${args.join(" ")}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

export async function installService(config: Config): Promise<void> {
  statePaths(config.stateDir);
  const s = serviceSpec(config);
  if (platform() === Platform.MacOS) {
    const plist = launchAgentPath(s.label);
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    await run("launchctl", ["bootout", `${domain()}/${s.label}`], s.root);
    writeFileSync(plist, launchdPlist(s));
    await must("launchctl", ["bootstrap", domain(), plist], s.root);
    console.log(`installed ${s.label}: runs every ${s.pollSeconds}s and at login.\n  ${plist}\n  log: ${s.log}`);
  } else if (platform() === Platform.Linux) {
    const units = systemdUnits(s);
    mkdirSync(systemdDir(), { recursive: true });
    writeFileSync(join(systemdDir(), `${s.label}.service`), units.service);
    writeFileSync(join(systemdDir(), `${s.label}.timer`), units.timer);
    await must("systemctl", ["--user", "daemon-reload"], s.root);
    await must("systemctl", ["--user", "enable", "--now", `${s.label}.timer`], s.root);
    console.log(`installed ${s.label}.timer: runs every ${s.pollSeconds}s.\n  log: ${s.log}`);
    console.log(`To keep it running while you are logged out: loginctl enable-linger ${userInfo().username}`);
  } else {
    throw new ServiceError(`no service support on ${platform()} yet: run "${Brand.name} daemon" instead`);
  }
  console.log(`Tools are found through the PATH you installed it from. After installing a new CLI, run "${Brand.name} service install" again.`);
}

export async function serviceStatus(config: Config): Promise<void> {
  const s = serviceSpec(config);
  if (platform() === Platform.MacOS) {
    const result = await run("launchctl", ["print", `${domain()}/${s.label}`], s.root);
    if (result.code !== 0) {
      console.log(`not installed (${s.label}). Install with "${Brand.name} service install".`);
      return;
    }
    const pick = (key: string): string => new RegExp(`^\\s*${key} = (.*)$`, "m").exec(result.stdout)?.[1]?.trim() ?? "-";
    console.log(`${s.label}: ${pick("state")}, runs ${pick("runs")}, last exit ${pick("last exit code")}, every ${pick("run interval")}`);
  } else if (platform() === Platform.Linux) {
    const result = await run("systemctl", ["--user", "show", `${s.label}.timer`, "-p", "ActiveState", "-p", "NextElapseUSecRealtime"], s.root);
    console.log(result.code === 0 ? `${s.label}.timer\n${result.stdout.trim()}` : `not installed (${s.label}).`);
  } else {
    console.log(`no service support on ${platform()}.`);
    return;
  }
  if (existsSync(s.log)) {
    const tail = readFileSync(s.log, "utf8").trim().split("\n").slice(-5).join("\n");
    console.log(`last lines of ${s.log}:\n${tail}`);
  }
}

export async function uninstallService(config: Config): Promise<void> {
  const s = serviceSpec(config);
  if (platform() === Platform.MacOS) {
    await run("launchctl", ["bootout", `${domain()}/${s.label}`], s.root);
    rmSync(launchAgentPath(s.label), { force: true });
  } else if (platform() === Platform.Linux) {
    await run("systemctl", ["--user", "disable", "--now", `${s.label}.timer`], s.root);
    rmSync(join(systemdDir(), `${s.label}.timer`), { force: true });
    rmSync(join(systemdDir(), `${s.label}.service`), { force: true });
    await run("systemctl", ["--user", "daemon-reload"], s.root);
  } else {
    throw new ServiceError(`no service support on ${platform()}`);
  }
  console.log(`uninstalled ${s.label}. Running workers finish what they are doing.`);
}
