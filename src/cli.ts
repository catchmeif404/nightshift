#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Brand } from "./brand.js";
import { add, daemon, doctor, init, initExtras, logs, runOnce, showReport, status, workSlot } from "./commands.js";
import { ConfigError, loadConfig } from "./config.js";
import { DEFAULT_SINCE } from "./report.js";
import { BoardType, CliCommand, ServiceAction, TicketKind } from "./enums.js";
import { DEFAULT_PORT, startUi } from "./ui/server.js";
import { installService, serviceStatus, uninstallService } from "./service.js";

const HELP = `${Brand.name}: tickets in, one model builds, another reviews, you decide only what a human must.

Usage: ${Brand.name} <command> [options]

  init [--board local-md|github] [--repo owner/name] [--repo-path .] [--trusted a,b]
       [--sections deliverable,verify,out-of-scope] [--gate-paths default|glob,glob]
       [--notify telegram|slack|discord] [--notify-chat-id=<id>  (telegram; use = for a negative id)]
                      write ${Brand.configFile} and a rules file (github: also create the labels)
  add "<title>" --project <name> [--body "..."] [--release]
                      add a ticket to the local markdown board
  run                 start workers for ready and cut-off tickets, then exit
  daemon              run every pollSeconds (default 120) until stopped
  service install|status|uninstall
                      run it on its own: launchd (macOS) or systemd (Linux), every pollSeconds
  status              running workers and tickets by status
  logs [-f] [-n 40]   the runner's log (-f: keep following)
  report [--since 24h|YYYY-MM-DD] [--json] [--send]
                      what finished overnight and what waits for you (from the runner's own records);
                      --send also sends it to notify / notifyCommand
  doctor              check tools, sign-ins and the config
  ui [--port 4404]    a local web console (127.0.0.1 only): status, settings, doctor

Options: --root <dir>  folder that holds ${Brand.configFile} (default: current folder)
`;

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return typeof pkg === "object" && pkg !== null && "version" in pkg ? String(pkg.version) : "unknown";
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string", default: "." },
      board: { type: "string", default: BoardType.LocalMarkdown },
      repo: { type: "string", default: "" },
      "repo-path": { type: "string", default: "." },
      trusted: { type: "string", default: "" },
      sections: { type: "string", default: "" },
      "gate-paths": { type: "string", default: "" },
      notify: { type: "string", default: "" },
      "notify-chat-id": { type: "string", default: "" },
      follow: { type: "boolean", short: "f", default: false },
      lines: { type: "string", short: "n", default: "40" },
      project: { type: "string", default: "" },
      body: { type: "string", default: "" },
      release: { type: "boolean", default: false },
      since: { type: "string", default: DEFAULT_SINCE },
      json: { type: "boolean", default: false },
      send: { type: "boolean", default: false },
      port: { type: "string", default: String(DEFAULT_PORT) },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const root = resolve(values.root);
  const command = positionals[0] ?? CliCommand.Help;
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  switch (command) {
    case CliCommand.Init: {
      const board = Object.values(BoardType).find((b) => b === values.board);
      if (board === undefined) throw new ConfigError(`--board must be one of: ${Object.values(BoardType).join(", ")}`);
      if (board === BoardType.GitHub && values.repo === "") throw new ConfigError("--repo owner/name is required for --board github");
      const trusted = values.trusted.split(",").map((t) => t.trim()).filter((t) => t !== "");
      // The repo path is where the user is now, not relative to --root: store it absolute.
      const extras = initExtras(values.sections, values["gate-paths"], values.notify, values["notify-chat-id"].trim());
      await init(root, { board, repo: values.repo, repoPath: resolve(values["repo-path"]), trusted, ...extras });
      return 0;
    }
    case CliCommand.Add: {
      const title = positionals[1] ?? "";
      if (title === "" || values.project === "") throw new ConfigError(`usage: ${Brand.name} add "<title>" --project <name>`);
      const id = add(loadConfig(root), title, values.project, values.release ? TicketKind.Release : TicketKind.Build, values.body);
      console.log(`added ${id}. Start it with "${Brand.name} run".`);
      return 0;
    }
    case CliCommand.Run:
      await runOnce(loadConfig(root));
      return 0;
    case CliCommand.Work:
      await workSlot(loadConfig(root), positionals[1] ?? "");
      return 0;
    case CliCommand.Daemon:
      await daemon(loadConfig(root));
      return 0;
    case CliCommand.Status:
      await status(loadConfig(root));
      return 0;
    case CliCommand.Logs:
      await logs(loadConfig(root), Math.max(1, Number.parseInt(values.lines, 10) || 40), values.follow);
      return 0;
    case CliCommand.Service: {
      const config = loadConfig(root);
      switch (positionals[1] ?? "") {
        case ServiceAction.Install:
          await installService(config);
          return 0;
        case ServiceAction.Status:
          await serviceStatus(config);
          return 0;
        case ServiceAction.Uninstall:
          await uninstallService(config);
          return 0;
        default:
          throw new ConfigError(`usage: ${Brand.name} service ${Object.values(ServiceAction).join("|")}`);
      }
    }
    case CliCommand.Report:
      return showReport(loadConfig(root), { since: values.since, json: values.json, send: values.send });
    case CliCommand.Doctor:
      return (await doctor(root)) ? 0 : 1;
    case CliCommand.Ui: {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("--port must be a number from 0 to 65535");
      const server = await startUi(root, port);
      console.log(`${Brand.name} console: ${server.url}  (this computer only; Ctrl+C to stop)`);
      console.log("It never starts work: saving settings only writes " + Brand.configFile + ".");
      await new Promise<void>((done) => {
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
      await server.close();
      return 0;
    }
    case CliCommand.Version:
      console.log(version());
      return 0;
    default:
      console.log(HELP);
      return command === CliCommand.Help ? 0 : 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`${Brand.name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
