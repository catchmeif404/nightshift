import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { readItem } = await import(`${process.cwd()}/src/store.js`);

const root = mkdtempSync(join(tmpdir(), "grade-"));
const dir = join(root, "data");
mkdirSync(dir);
writeFileSync(join(dir, "bolt.json"), JSON.stringify({ sku: "A1" }));
writeFileSync(join(dir, "bad.json"), "{nope");
writeFileSync(join(root, "secret.json"), JSON.stringify({ secret: true }));
const invalid = (name) => assert.throws(() => readItem(dir, name), (e) => e instanceof Error && e.message.startsWith("invalid item name"));

test("R1a traversal is rejected (the security check)", () => {
  invalid("../secret");
  invalid("..");
  invalid(join(root, "secret"));
});
test("R1b other invalid names", () => {
  invalid("");
  invalid("a/b");
  invalid("a\\b");
  invalid("a.b");
  invalid("a\0b");
  invalid(undefined);
  invalid(42);
  invalid(null);
});
test("R2 missing file", () => assert.throws(() => readItem(dir, "nothing"), (e) => e instanceof Error && e.message === "item not found: nothing"));
test("R3 valid name still works", () => assert.equal(readItem(dir, "bolt").sku, "A1"));
test("R4 malformed json is not hidden", () => assert.throws(() => readItem(dir, "bad"), (e) => e instanceof SyntaxError));
