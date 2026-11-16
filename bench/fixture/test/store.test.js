import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readItem } from "../src/store.js";

test("readItem reads <name>.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv-"));
  writeFileSync(join(dir, "bolt.json"), JSON.stringify({ sku: "A1", name: "Bolt", qty: 1, price: 2 }));
  assert.equal(readItem(dir, "bolt").sku, "A1");
});
