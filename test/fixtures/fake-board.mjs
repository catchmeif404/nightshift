#!/usr/bin/env node
// A stand-in tracker for the command board protocol. State lives in $FAKE_BOARD_FILE (JSON):
// {"tickets": [{id,title,body,project,kind,createdAt,status}], "calls": [[...args, stdin]]}
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_BOARD_FILE;
const db = JSON.parse(readFileSync(file, "utf8"));
const input = process.argv[2] === "list" ? "" : readFileSync(0, "utf8");
const [call, ...args] = process.argv.slice(2);
db.calls.push([call, ...args, input]);
if (call === "list") {
  const out = db.tickets.filter((t) => t.status === args[0]).map(({ status, ...rest }) => rest);
  process.stdout.write(JSON.stringify(out));
} else if (call === "set-status") {
  const t = db.tickets.find((x) => x.id === args[0]);
  if (!t) { process.stderr.write(`no ticket ${args[0]}`); process.exit(2); }
  t.status = args[1];
} else if (call !== "note") {
  process.stderr.write(`unknown call ${call}`);
  process.exit(2);
}
writeFileSync(file, JSON.stringify(db));
