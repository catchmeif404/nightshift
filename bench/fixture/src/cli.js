import { readFileSync } from "node:fs";
import { totalValue } from "./items.js";

// run(argv) returns the text the command prints (no trailing newline). Bad usage throws Error.
export function run(argv) {
  const [command, file] = argv;
  if (command === "total") {
    if (file === undefined) throw new Error("usage: total <file>");
    const items = JSON.parse(readFileSync(file, "utf8"));
    return String(totalValue(items));
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
