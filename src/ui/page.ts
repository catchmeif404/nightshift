import { Brand } from "../brand.js";
import { NoteLanguage } from "../enums.js";

// The console is one static page. Every value from the server reaches the DOM through textContent, never innerHTML.
const STYLE = `
:root { color-scheme: light dark; --bg: #fafafa; --fg: #1b1b1f; --mut: #66666f; --line: #d9d9e0; --card: #fff; --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --accent: #3b5bdb; }
@media (prefers-color-scheme: dark) { :root { --bg: #121216; --fg: #ececf1; --mut: #9a9aa6; --line: #2d2d36; --card: #1a1a20; --ok: #3fb950; --warn: #d29922; --bad: #f85149; --accent: #8da2ff; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
header, main { max-width: 980px; margin: 0 auto; padding: 16px; }
header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 20px; margin: 0; } h2 { font-size: 16px; margin: 0 0 8px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
label { display: block; font-size: 13px; color: var(--mut); margin: 10px 0 2px; }
input, select, textarea { width: 100%; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
textarea { min-height: 64px; font-family: ui-monospace, monospace; font-size: 13px; }
input.bad, select.bad, textarea.bad { border-color: var(--bad); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0 16px; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button:disabled { opacity: .5; cursor: default; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
.mut { color: var(--mut); } .ok { color: var(--ok); } .warn { color: var(--warn); } .fail { color: var(--bad); }
.note { border-left: 3px solid var(--warn); padding: 4px 10px; margin: 8px 0; background: rgba(154,103,0,.08); }
table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
pre { margin: 0; max-height: 260px; overflow: auto; font: 12px/1.45 ui-monospace, monospace; white-space: pre-wrap; word-break: break-all; }
.tag { display: inline-block; font-size: 12px; border: 1px solid var(--line); border-radius: 10px; padding: 0 8px; margin-right: 4px; }
`;

const SCRIPT = String.raw`
"use strict";
var CSRF = document.querySelector('meta[name="csrf"]').content;
var STR = {
  en: {
    title: "nightshift console", local: "This page only listens on this computer (127.0.0.1).",
    status: "Status", workers: "Workers", noWorkers: "No worker running.", stage: "stage", limits: "Usage limit",
    tickets: "Tickets", waiting: "Waiting because", log: "Recent log", board: "Board", noTickets: "none",
    settings: "Settings", projects: "Projects: repository path", boardH: "Board", boardType: "Board type", boardDir: "Ticket folder (inside the config root)",
    repos: "GitHub repositories (owner/name, one per line)", trusted: "Trusted GitHub logins (one per line)",
    builder: "Developer", reviewer: "Reviewer", agentType: "Executor", model: "Model (empty: the executor's default)", maxSlots: "Concurrent workers (1-16)",
    check: "Check before saving", save: "Save", reload: "Reload", saved: "Saved. A backup of the previous file: ", nothing: "Nothing changed.",
    nextDispatch: "Saving only writes nightshift.json. It does not start work, install the service or approve auto-merge. Workers that are running now keep the old settings; the new ones apply at the next dispatch (every poll interval).",
    runningNow: "Running now with the old settings: ", preserved: "Other fields in the file (not edited here, kept as they are on every save)", secretKept: "secret: kept, never shown",
    locked: "This value is a custom command; change it in the config file.", doctor: "Doctor", runDoctor: "Run doctor", checkResult: "Check result", lang: "한국어",
    problem: "The saved file has a problem: ", changed: "Changes: ", failed: "Not saved.", refreshed: "Updated ",
    "usage-limit": "usage limit", "release-running": "a release is running", "release-waits-for-idle": "a release waits until no worker runs",
    "project-busy": "the project already has a worker", "no-free-slot": "all worker slots are busy", "unknown-project": "project is not in the config", "next-dispatch": "starts at the next dispatch",
  },
  ko: {
    title: "nightshift 콘솔", local: "이 페이지는 이 컴퓨터(127.0.0.1)에서만 열립니다.",
    status: "현황", workers: "워커", noWorkers: "실행 중인 워커 없음.", stage: "단계", limits: "사용량 한도",
    tickets: "티켓", waiting: "대기 원인", log: "최근 로그", board: "보드", noTickets: "없음",
    settings: "설정", projects: "프로젝트: 저장소 경로", boardH: "보드", boardType: "보드 종류", boardDir: "티켓 폴더 (설정 root 안)",
    repos: "GitHub 저장소 (owner/name, 한 줄에 하나)", trusted: "신뢰할 GitHub 로그인 (한 줄에 하나)",
    builder: "개발자", reviewer: "검토자", agentType: "실행기", model: "모델 (비우면 실행기 기본값)", maxSlots: "동시 작업 수 (1-16)",
    check: "저장 전 검사", save: "저장", reload: "다시 불러오기", saved: "저장했습니다. 이전 파일 백업: ", nothing: "바뀐 것이 없습니다.",
    nextDispatch: "저장은 nightshift.json만 씁니다. 작업을 시작하거나 서비스를 설치하거나 자동 머지를 승인하지 않습니다. 지금 실행 중인 워커는 예전 설정으로 계속 돌고, 새 설정은 다음 배차(확인 주기)부터 적용됩니다.",
    runningNow: "예전 설정으로 실행 중: ", preserved: "파일의 다른 필드 (여기서 편집하지 않고, 저장할 때마다 그대로 보존)", secretKept: "비밀값: 그대로 유지, 표시하지 않음",
    locked: "사용자 지정 command 값입니다. 설정 파일에서 바꾸세요.", doctor: "Doctor", runDoctor: "doctor 실행", checkResult: "검사 결과", lang: "English",
    problem: "저장된 파일에 문제가 있습니다: ", changed: "변경: ", failed: "저장하지 않았습니다.", refreshed: "갱신 ",
    "usage-limit": "사용량 한도", "release-running": "출시 작업 실행 중", "release-waits-for-idle": "실행 중인 워커가 없어질 때까지 출시가 대기",
    "project-busy": "이 프로젝트에 이미 워커가 있음", "no-free-slot": "워커 슬롯이 모두 사용 중", "unknown-project": "설정에 없는 프로젝트", "next-dispatch": "다음 배차에 시작",
  },
};
var lang = localStorage.getItem("lang") || document.documentElement.lang;
if (!STR[lang]) lang = "en";
function t(k) { return STR[lang][k] || STR.en[k] || k; }

function h(tag, attrs) {
  var el = document.createElement(tag);
  for (var k in (attrs || {})) { if (k === "class") el.className = attrs[k]; else el.setAttribute(k, attrs[k]); }
  for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c === null || c === undefined) continue; el.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
function $(id) { return document.getElementById(id); }

async function api(path, body) {
  var opts = body === undefined ? { headers: {} } : { method: "POST", headers: { "content-type": "application/json", "x-nightshift-csrf": CSRF }, body: JSON.stringify(body) };
  var res = await fetch(path, opts);
  var data = await res.json().catch(function () { return { error: res.statusText }; });
  if (!res.ok) { var e = new Error(data.error || res.statusText); e.data = data; throw e; }
  return data;
}

var settings = null, lastStatus = null;

function renderStatus(s) {
  lastStatus = s;
  var box = clear($("status"));
  box.append(h("p", { class: "mut" }, t("board") + ": " + s.board + " · max " + s.maxSlots + " · poll " + s.pollSeconds + "s · " + t("refreshed") + new Date().toLocaleTimeString()));
  if (s.boardError) box.append(h("p", { class: "fail" }, s.boardError));
  s.limits.forEach(function (l) { box.append(h("div", { class: "note" }, t("limits") + ": " + l.agent + " → " + l.until + " (" + l.message + ")")); });
  box.append(h("h2", {}, t("workers")));
  if (s.workers.length === 0) box.append(h("p", { class: "mut" }, t("noWorkers")));
  else {
    var wt = h("table", {}, h("tr", {}, h("th", {}, "target"), h("th", {}, "pid"), h("th", {}, t("stage"))));
    s.workers.forEach(function (w) { wt.append(h("tr", {}, h("td", {}, w.target + (w.release ? " (release)" : "")), h("td", {}, w.pid), h("td", {}, w.stage || "-"))); });
    box.append(wt);
  }
  box.append(h("h2", { style: "margin-top:12px" }, t("tickets")));
  ["working", "ready", "review", "blocked"].forEach(function (k) {
    var g = s.tickets[k];
    box.append(h("div", {}, h("strong", {}, k + ": " + g.count)));
    if (g.items.length === 0) return;
    var tb = h("table", {});
    g.items.forEach(function (it) {
      var why = it.waiting.map(function (w) { return t(w.cause) + (w.detail ? " (" + w.detail + ")" : ""); });
      tb.append(h("tr", {}, h("td", {}, it.id), h("td", {}, it.title, h("div", { class: "mut" }, it.project)),
        h("td", {}, it.stage ? h("span", { class: "tag" }, it.stage) : null, why.length ? h("span", { class: "warn" }, t("waiting") + ": " + why.join(", ")) : null)));
    });
    box.append(tb);
  });
  box.append(h("h2", { style: "margin-top:12px" }, t("log")), h("pre", {}, s.log.join("\n")));
}

async function refreshStatus() {
  try { renderStatus(await api("/api/status")); } catch (e) { clear($("status")).append(h("p", { class: "fail" }, e.message)); }
}

function field(id, label, el, issueKey) { el.id = id; el.dataset.issue = issueKey || ""; return h("div", {}, h("label", { for: id }, label), el); }
function opts(sel, values, current) { values.forEach(function (v) { var o = h("option", { value: v }, v); if (v === current) o.selected = true; sel.append(o); }); return sel; }
function lines(v) { return v.split("\n").map(function (x) { return x.trim(); }).filter(function (x) { return x !== ""; }); }

var BOARD_TYPES = ["local-md", "github"], AGENT_TYPES = ["claude-code", "codex"];
function typeOptions(allowed, current, locked) { return locked ? [current] : allowed; }

function renderSettings(v) {
  settings = v;
  var f = v.form, box = clear($("form"));
  v.problems.forEach(function (p) { box.append(h("div", { class: "note fail" }, t("problem") + p)); });
  box.append(h("div", { class: "note" }, t("nextDispatch")));
  box.append(h("h2", {}, t("projects")));
  var pg = h("div", { class: "grid" });
  f.projects.forEach(function (p, i) { pg.append(field("proj" + i, p.name, h("input", { value: p.repoPath }), "projects." + p.name + ".repoPath")); });
  box.append(pg);
  box.append(h("h2", { style: "margin-top:12px" }, t("boardH")));
  var bg = h("div", { class: "grid" });
  bg.append(field("boardType", t("boardType"), opts(h("select", v.lockedBoard ? { disabled: "" } : {}), typeOptions(BOARD_TYPES, f.board.type, v.lockedBoard), f.board.type), "board.type"));
  bg.append(field("boardDir", t("boardDir"), h("input", { value: f.board.dir }), "board.dir"));
  var repos = h("textarea", {}); repos.value = f.board.repos.join("\n");
  var trusted = h("textarea", {}); trusted.value = f.board.trustedAuthors.join("\n");
  bg.append(field("boardRepos", t("repos"), repos, "board.repos"), field("boardTrusted", t("trusted"), trusted, "board.trustedAuthors"));
  box.append(bg);
  [["builder", "builder", v.lockedBuilder], ["reviewer", "reviewer", v.lockedReviewer]].forEach(function (a) {
    box.append(h("h2", { style: "margin-top:12px" }, t(a[0])));
    var g = h("div", { class: "grid" });
    g.append(field(a[1] + "Type", t("agentType"), opts(h("select", a[2] ? { disabled: "" } : {}), typeOptions(AGENT_TYPES, f[a[1]].type, a[2]), f[a[1]].type), a[1] + ".type"));
    g.append(field(a[1] + "Model", t("model"), h("input", { value: f[a[1]].model }), a[1] + ".model"));
    box.append(g);
    if (a[2]) box.append(h("div", { class: "mut" }, t("locked")));
  });
  box.append(h("div", { class: "grid" }, field("maxSlots", t("maxSlots"), h("input", { type: "number", min: "1", max: "16", value: f.maxSlots }), "maxSlots")));
  if (v.preserved.length) {
    var pt = h("table", {});
    v.preserved.forEach(function (p) { pt.append(h("tr", {}, h("td", {}, p.path), h("td", { class: p.secret ? "mut" : "" }, p.secret ? "•••••• (" + t("secretKept") + ")" : p.value))); });
    box.append(h("h2", { style: "margin-top:12px" }, t("preserved")), pt);
  }
}

function collect() {
  var f = settings.form;
  return {
    projects: f.projects.map(function (p, i) { return { name: p.name, repoPath: $("proj" + i).value }; }),
    board: { type: $("boardType").value, dir: $("boardDir").value, repos: lines($("boardRepos").value), trustedAuthors: lines($("boardTrusted").value) },
    builder: { type: $("builderType").value, model: $("builderModel").value.trim() },
    reviewer: { type: $("reviewerType").value, model: $("reviewerModel").value.trim() },
    maxSlots: Number($("maxSlots").value),
  };
}

function showIssues(issues, checks, extra) {
  var box = clear($("result"));
  document.querySelectorAll(".bad").forEach(function (e) { e.classList.remove("bad"); });
  (extra || []).forEach(function (m) { if (m) box.append(m); });
  (issues || []).forEach(function (i) {
    box.append(h("div", { class: i.level === "fail" ? "fail" : "warn" }, (i.level === "fail" ? "FAIL " : "warn ") + i.field + ": " + i.message));
    var el = document.querySelector('[data-issue="' + i.field + '"]');
    if (el && i.level === "fail") el.classList.add("bad");
  });
  (checks || []).forEach(function (c) { box.append(h("div", { class: c.level }, (c.level === "ok" ? "ok   " : c.level === "warn" ? "warn " : "FAIL ") + c.what)); });
}

function busy(on) { document.querySelectorAll("button").forEach(function (b) { b.disabled = on; }); }

async function doCheck() {
  busy(true);
  try {
    var r = await api("/api/settings/check", { edit: collect(), revision: settings.revision });
    showIssues(r.issues, r.checks, [h("div", { class: "mut" }, t("checkResult") + " · " + t("changed") + (r.changed.join(", ") || "-"))]);
  } catch (e) { showIssues([], [], [h("div", { class: "fail" }, e.message)]); }
  busy(false);
}

async function doSave() {
  busy(true);
  try {
    var r = await api("/api/settings/save", { edit: collect(), revision: settings.revision });
    var msg = r.changed.length === 0 ? t("nothing") : t("saved") + r.backup + " · " + t("changed") + r.changed.join(", ");
    var running = r.runningWorkers.length ? h("div", { class: "note" }, t("runningNow") + r.runningWorkers.map(function (w) { return w.target; }).join(", ")) : null;
    renderSettings(await api("/api/settings"));
    showIssues(r.issues, [], [h("div", { class: "ok" }, msg), running]);
  } catch (e) {
    showIssues(e.data && e.data.issues, [], [h("div", { class: "fail" }, t("failed") + " " + e.message)]);
  }
  busy(false);
  refreshStatus();
}

async function doDoctor() {
  busy(true);
  var box = clear($("doctor"));
  try {
    var r = await api("/api/doctor", {});
    r.checks.forEach(function (c) { box.append(h("div", { class: c.level }, (c.level === "ok" ? "ok   " : c.level === "warn" ? "warn " : "FAIL ") + c.what)); });
  } catch (e) { box.append(h("div", { class: "fail" }, e.message)); }
  busy(false);
}

function labels() {
  document.title = t("title");
  $("lang").textContent = t("lang");
  $("title").textContent = t("title");
  $("local").textContent = t("local");
  $("hStatus").textContent = t("status");
  $("hSettings").textContent = t("settings");
  $("hDoctor").textContent = t("doctor");
  $("check").textContent = t("check"); $("save").textContent = t("save"); $("reload").textContent = t("reload"); $("runDoctor").textContent = t("runDoctor");
}

async function loadSettings() {
  try { renderSettings(await api("/api/settings")); } catch (e) { clear($("form")).append(h("p", { class: "fail" }, e.message)); }
}

$("lang").onclick = function () { lang = lang === "en" ? "ko" : "en"; localStorage.setItem("lang", lang); document.documentElement.lang = lang; labels(); if (lastStatus) renderStatus(lastStatus); if (settings) renderSettings(settings); };
$("check").onclick = doCheck; $("save").onclick = doSave; $("reload").onclick = function () { clear($("result")); loadSettings(); };
$("runDoctor").onclick = doDoctor;
labels(); refreshStatus(); loadSettings(); setInterval(refreshStatus, 5000);
`;

export function renderPage(nonce: string, csrf: string, language: NoteLanguage): string {
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf" content="${csrf}">
<title>${Brand.name}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header><div><h1 id="title">${Brand.name}</h1><div class="mut" id="local"></div></div><button id="lang" type="button"></button></header>
<main>
<section><h2 id="hStatus"></h2><div id="status"></div></section>
<section><h2 id="hSettings"></h2><div id="form"></div>
<div class="row"><button id="check" type="button"></button><button id="save" type="button" class="primary"></button><button id="reload" type="button"></button></div>
<div id="result" style="margin-top:12px"></div></section>
<section><h2 id="hDoctor"></h2><div class="row" style="margin:0 0 8px"><button id="runDoctor" type="button"></button></div><div id="doctor"></div></section>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}

