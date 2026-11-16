import { readFileSync } from "node:fs";
import { join } from "node:path";

// Reads one item file, <dataDir>/<name>.json, and returns the parsed object.
export function readItem(dataDir, name) {
  const raw = readFileSync(join(dataDir, `${name}.json`), "utf8");
  return JSON.parse(raw);
}
