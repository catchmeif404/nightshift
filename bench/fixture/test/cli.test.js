import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli.js";

test("total command", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv-"));
  const file = join(dir, "items.json");
  writeFileSync(file, JSON.stringify([{ sku: "A1", name: "Bolt", qty: 2, price: 3 }]));
  assert.equal(run(["total", file]), "6");
});
