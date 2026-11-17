// Drives ONE interactive `claude` session inside a tmux (virtual terminal) window, like a person typing one request.
// Usage: node interactive.mjs --cwd <dir> --prompt-file <file> --out <dir> [--model sonnet] [--permission-mode auto]
//          [--base-ref <sha>] [--max-min 20] [--stall-min 3] [--nudge "<fixed text>"]
// Writes <out>/interactive.json: outcome, wall seconds, interventions (kind + time), session id, stop-hook count.
//
// How "finished" is decided: an experiment-only --settings file registers a Stop hook that appends one line to
// <out>/stop.log every time Claude ends a turn. First Stop: if Claude asked a question (last text ends in "?") or changed
// nothing in the repo, the fixed nudge text is sent ONCE and recorded as one human intervention; otherwise it is finished.
// Claude's multiple-choice question window (AskUserQuestion) fires no Stop: it is closed with Esc and the same nudge is sent once.
// Second Stop (after the nudge) is always finished. A permission dialog is recorded as an intervention and approved.
// The folder-trust dialog is answered before the request is typed and is not an intervention. No progress for
// --stall-min minutes (screen and session log both unchanged) = outcome "stalled". --max-min = outcome "timeout".
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cleanEnv, encodeProjectDir, exec, readJsonl } from "./common.mjs";

export const Outcome = { Finished: "finished", Stalled: "stalled", Timeout: "timeout", UsageLimit: "usage_limit", Error: "error" };
export const Intervention = { Question: "question", QuestionDialog: "question_dialog", Stopped: "stopped_without_change", Permission: "permission_dialog" };
export const DEFAULT_NUDGE = "알아서 판단해서 끝까지 진행해";

const PERMISSION_DIALOG = /Do you want to (proceed|make this edit|create|run)|Allow this|❯ 1\. Yes|\(y\/n\)|Yes, and don't ask again/;
const TRUST_DIALOG = /trust the files in this folder|Do you trust|Yes, proceed|Is this a project you (created|trust)/i;
const QUESTION_DIALOG = /Enter to select · Tab\/Arrow keys to navigate|❯ \d\. .*\n(.*\n)*\s*\d\. Type something\./;
const LIMIT = /(usage|rate) limit (reached|will reset)|limit reached|You've hit your/i;
const READY = /\? for shortcuts|bypass permissions|auto mode|esc to interrupt|accept edits/;

// Pure decision used on the first Stop: should the fixed nudge be sent?
export function needsNudge({ lastText, changedFiles }) {
  const text = (lastText ?? "").trim();
  const asked = /[?？]\s*$/.test(text) || /[?？]\s*["')\]]?\s*$/m.test(text.split("\n").slice(-3).join("\n"));
  return asked || changedFiles === 0;
}

export function lastAssistantText(sessionFile) {
  if (!existsSync(sessionFile)) return "";
  const lines = readJsonl(sessionFile).filter((l) => l.type === "assistant" && Array.isArray(l.message?.content));
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    if (t !== "") return t;
  }
  return "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args) => exec("tmux", args, { env: cleanEnv(), timeoutMs: 15000 });

export async function runInteractive({ cwd, promptFile, out, baseRef = "HEAD", model = "sonnet", permissionMode = "auto", maxMin = 20, stallMin = 3, nudge = DEFAULT_NUDGE }) {
  const env = cleanEnv();
  mkdirSync(out, { recursive: true });
  const stopLog = join(out, "stop.log");
  writeFileSync(stopLog, "");
  const settingsFile = join(out, "settings.json");
  writeFileSync(settingsFile, `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `/bin/sh -c 'date +%s >> "${stopLog}"; cat >/dev/null'` }] }] } }, null, 2)}\n`);
  const sessionId = randomUUID();
  const sessionFile = join(homedir(), ".claude", "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
  const name = `ns2-${sessionId.slice(0, 8)}`;
  const unset = Object.keys(process.env).filter((k) => /^(CLAUDECODE|CLAUDE_CODE_|CODEX_)/.test(k)).map((k) => `-u ${k}`).join(" ");
  const cmd = `env ${unset} claude --model ${model} --permission-mode ${permissionMode} --settings '${settingsFile}' --session-id ${sessionId}`;
  const started = await tmux("new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", cwd, cmd);
  const base = (await exec("git", ["rev-parse", baseRef], { cwd, env, timeoutMs: 15000 })).stdout.trim();
  const rec = { session_id: sessionId, base_commit: base, cwd, model, permission_mode: permissionMode, max_min: maxMin, stall_min: stallMin, nudge, interventions: [], stops: 0, outcome: Outcome.Error };
  if (started.code !== 0) { rec.error = started.stderr.slice(0, 300); return rec; }
  const pane = async () => (await tmux("capture-pane", "-p", "-t", name)).stdout;
  const stops = () => (existsSync(stopLog) ? readFileSync(stopLog, "utf8").split("\n").filter(Boolean).length : 0);
  const paste = async (text) => {
    const f = join(out, `.paste-${Date.now()}`);
    writeFileSync(f, text);
    await tmux("load-buffer", "-b", name, f);
    await tmux("paste-buffer", "-p", "-b", name, "-t", name);
    await sleep(700);
    await tmux("send-keys", "-t", name, "Enter");
  };
  try {
    // before the request: folder trust dialog (not an intervention), then wait for the input box
    const boot = Date.now();
    for (;;) {
      const p = await pane();
      if (TRUST_DIALOG.test(p) && /Enter to confirm|1\. Yes/.test(p)) {
        // the dialog pre-selects "No, exit": move to "Yes, I trust this folder" first
        if (/❯\s*(\d\.\s*)?No/.test(p)) { await tmux("send-keys", "-t", name, "Down"); await sleep(400); }
        await tmux("send-keys", "-t", name, "Enter"); rec.trust_dialog_answered = true; await sleep(1500); continue; }
      if (READY.test(p)) break;
      if (Date.now() - boot > 90000) { rec.error = "claude did not become ready in 90 s"; rec.screen_tail = p.slice(-500); return rec; }
      await sleep(1000);
    }
    const t0 = Date.now();
    rec.prompt_sent_at = new Date(t0).toISOString();
    await paste(readFileSync(promptFile, "utf8").trim());
    let lastProgress = Date.now();
    let lastScreen = "";
    let lastSize = 0;
    let handledStops = 0;
    let nudged = false;
    const limitMs = maxMin * 60000;
    for (;;) {
      await sleep(2000);
      const now = Date.now();
      const p = await pane();
      const size = existsSync(sessionFile) ? statSync(sessionFile).size : 0;
      if (p !== lastScreen || size !== lastSize) { lastProgress = now; lastScreen = p; lastSize = size; }
      const seen = stops();
      if (seen > handledStops) {
        handledStops = seen;
        rec.stops = seen;
        await sleep(1500);
        const changed = (await exec("git", ["status", "--porcelain"], { cwd, env, timeoutMs: 15000 })).stdout.split("\n").filter(Boolean).length
          + Number((await exec("git", ["rev-list", "--count", "HEAD", `^${base}`], { cwd, env, timeoutMs: 15000 })).stdout.trim() || 0);
        const lastText = lastAssistantText(sessionFile);
        if (!nudged && needsNudge({ lastText, changedFiles: changed })) {
          nudged = true;
          rec.interventions.push({ kind: /[?？]/.test(lastText.slice(-200)) ? Intervention.Question : Intervention.Stopped, at_s: (now - t0) / 1000 });
          await paste(nudge);
          lastProgress = Date.now();
          continue;
        }
        rec.outcome = Outcome.Finished;
        break;
      }
      if (LIMIT.test(p)) { rec.outcome = Outcome.UsageLimit; rec.screen_tail = p.slice(-400); break; }
      if (QUESTION_DIALOG.test(p.split("\n").slice(-16).join("\n"))) {
        // Claude's multiple-choice question window does not fire Stop. A person would answer in words: Esc closes it,
        // then the fixed text goes in once. A second question window after that is left unanswered (outcome finished, flag set).
        await tmux("send-keys", "-t", name, "Escape");
        await sleep(2500);
        if (nudged) { rec.unanswered_question = true; rec.outcome = Outcome.Finished; break; }
        nudged = true;
        rec.interventions.push({ kind: Intervention.QuestionDialog, at_s: (now - t0) / 1000 });
        await paste(nudge);
        lastProgress = Date.now();
        continue;
      }
      if (PERMISSION_DIALOG.test(p.split("\n").slice(-14).join("\n"))) {
        rec.interventions.push({ kind: Intervention.Permission, at_s: (now - t0) / 1000 });
        await tmux("send-keys", "-t", name, "Enter");
        await sleep(1500);
        lastProgress = Date.now();
        continue;
      }
      if (now - lastProgress > stallMin * 60000) { rec.outcome = Outcome.Stalled; rec.screen_tail = p.slice(-400); break; }
      if (now - t0 > limitMs) { rec.outcome = Outcome.Timeout; break; }
    }
    rec.wall_s = (Date.now() - t0) / 1000;
  } finally {
    await tmux("send-keys", "-t", name, "C-c");
    await sleep(500);
    await tmux("kill-session", "-t", name);
  }
  return rec;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, all) => (x.startsWith("--") ? [...acc, [x.slice(2), all[i + 1]]] : acc), []));
  if (!a.cwd || !a["prompt-file"] || !a.out) { console.error("usage: interactive.mjs --cwd D --prompt-file F --out D [--model m] [--permission-mode m] [--max-min n] [--stall-min n] [--nudge text]"); process.exit(2); }
  const rec = await runInteractive({ cwd: resolve(a.cwd), promptFile: resolve(a["prompt-file"]), out: resolve(a.out), baseRef: a["base-ref"], model: a.model, permissionMode: a["permission-mode"],
    maxMin: a["max-min"] ? Number(a["max-min"]) : undefined, stallMin: a["stall-min"] ? Number(a["stall-min"]) : undefined, nudge: a.nudge });
  writeFileSync(join(resolve(a.out), "interactive.json"), `${JSON.stringify(rec, null, 2)}\n`);
  console.log(JSON.stringify(rec));
}
