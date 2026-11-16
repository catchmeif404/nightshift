// Agent CLIs stop with a message when the account's usage limit is reached, for example
//   Claude Code: "You've hit your 5-hour limit · resets 3:30pm (Asia/Seoul)"
//                "You've hit your session limit · resets 11:10pm (Asia/Seoul)"
//                "You've hit your weekly limit · resets Nov 18, 9am (Asia/Seoul)"
//   others:      "... usage limit ... try again in 2 hours 13 minutes"
// Such a run is not a failure of the ticket: the runner waits until the limit resets and resumes the same session.

const LIMIT_HIT = /hit your [\w -]*limit|usage limit|rate limit reached|quota (?:exceeded|reached)/i;
const RESETS_AT = /resets\s+(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([A-Za-z_]+\/[A-Za-z_/+-]+)\))?/i;
const TRY_IN = /try again in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MINUTE = 60_000;
// Resume a little after the stated reset, so the first try is not refused at the edge.
const MARGIN_MS = 2 * MINUTE;

export interface LimitHit {
  // When to try again (ms since epoch).
  until: number;
  // The line that said so, for notes and logs.
  message: string;
}

// The offset (ms) of a time zone from UTC at a moment: local wall time minus UTC.
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at / 1000) * 1000;
}

function wallDate(at: number, timeZone: string): { year: number; month: number; day: number } {
  const local = new Date(at + zoneOffset(at, timeZone));
  return { year: local.getUTCFullYear(), month: local.getUTCMonth(), day: local.getUTCDate() };
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// The first moment at or after `now` whose wall clock in `timeZone` shows that date (or any date) and time.
function nextWallTime(now: number, timeZone: string, hour: number, minute: number, month: number, day: number): number {
  const today = wallDate(now, timeZone);
  const year = month >= 0 && month < today.month - 6 ? today.year + 1 : today.year;
  const base = month >= 0 ? { year, month, day } : today;
  let candidate = Date.UTC(base.year, base.month, base.day, hour, minute) ;
  candidate -= zoneOffset(candidate, timeZone);
  if (month < 0) {
    while (candidate <= now) candidate += 24 * 60 * MINUTE;
  }
  return candidate;
}

export function detectLimit(output: string, now: number, fallbackMinutes: number): LimitHit[] {
  const line = output.split("\n").find((l) => LIMIT_HIT.test(l)) ?? "";
  if (line === "") return [];
  const message = line.trim().slice(0, 300);
  const resets = RESETS_AT.exec(line);
  if (resets) {
    let hour = Number(resets[3]) % 12;
    if ((resets[5] ?? "").toLowerCase() === "pm") hour += 12;
    const minute = Number(resets[4] ?? "0");
    const zone = resets[6] && validZone(resets[6]) ? resets[6] : localTimeZone();
    const month = resets[1] ? MONTHS.indexOf(resets[1].toLowerCase().slice(0, 3)) : -1;
    const day = resets[2] ? Number(resets[2]) : 0;
    return [{ until: nextWallTime(now, zone, hour, minute, month, day) + MARGIN_MS, message }];
  }
  const tryIn = TRY_IN.exec(line);
  if (tryIn && (tryIn[1] || tryIn[2])) {
    const minutes = Number(tryIn[1] ?? "0") * 60 + Number(tryIn[2] ?? "0");
    return [{ until: now + minutes * MINUTE + MARGIN_MS, message }];
  }
  return [{ until: now + fallbackMinutes * MINUTE, message }];
}
