import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "$1***"],
  [/sk-[A-Za-z0-9_-]{10,}/g, "sk-***"],
  [/(Bearer\s+)[A-Za-z0-9._-]+/g, "$1***"],
  [/([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_-]*"?\s*[:=]\s*"?)[A-Za-z0-9._-]{6,}/gi, "$1***"],
];

// Hide anything that looks like a token, key or password before it reaches a log or a ticket note.
export function mask(text: string): string {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

// Cut by characters, not bytes, so Korean or emoji never end up half-cut.
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export class Logger {
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  }

  line(message: string): void {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    appendFileSync(this.file, `${stamp} ${mask(message)}\n`);
  }

  // The last log line that mentions this ticket, for a blocked note.
  lastLineAbout(ticketId: string): string {
    if (!existsSync(this.file)) return "";
    const lines = readFileSync(this.file, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i] ?? "";
      if (line.includes(`${ticketId} `)) return line;
    }
    return "";
  }
}
