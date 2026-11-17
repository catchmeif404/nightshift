// Per-stage cost and time from the sessions of one nightshift run (usage.mjs rows): builder and reviewer apart.
// A role with no session gives n 0 and null numbers (never 0). Time is first to last log line of the session(s), summed.
import { existsSync, realpathSync } from "node:fs";
import { Role } from "./common.mjs";
import { collect } from "./usage.mjs";
import { weightedCost } from "./cost.mjs";

const TOKEN_KEYS = ["input", "output", "cache_read", "cache_write"];

export function stageOf(sessions, role) {
  const rs = sessions.filter((s) => s.role === role);
  if (rs.length === 0) return { n: 0, cost: null, span_s: null, turns: null, models: [], tokens: null };
  const sum = (k) => (rs.some((s) => s[k] === null) ? null : rs.reduce((a, s) => a + s[k], 0));
  const tokens = Object.fromEntries(TOKEN_KEYS.map((k) => [k, sum(k)]));
  const spans = rs.map((s) => s.span_s);
  return {
    n: rs.length,
    cost: weightedCost(tokens),
    span_s: spans.some((x) => x === null) ? null : spans.reduce((a, b) => a + b, 0),
    turns: rs.reduce((a, s) => a + s.messages, 0),
    models: [...new Set(rs.flatMap((s) => s.models))].sort(),
    tokens,
  };
}

export function stagesOf(sessions) {
  return { builder: stageOf(sessions, Role.Builder), reviewer: stageOf(sessions, Role.Reviewer) };
}

// Sessions of a run whose scratch folder may be gone (the Claude logs stay under ~/.claude/projects). macOS: /tmp is /private/tmp.
export function collectAt(runRoot) {
  if (existsSync(runRoot)) return collect(runRoot);
  return collect(runRoot.replace(/^\/tmp\//, "/private/tmp/"), { missingOk: true });
}
export { realpathSync };
