import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { lowStock, totalValue } = await import(`${process.cwd()}/src/items.js`);
const { run } = await import(`${process.cwd()}/src/cli.js`);
const it = (sku, name, qty, price = 1) => ({ sku, name, qty, price });
const items = [it("1", "b", 5), it("2", "a", 5), it("3", "z", 9), it("4", "m", 0), it("5", "B", 2)];
const file = join(mkdtempSync(join(tmpdir(), "grade-")), "i.json");
writeFileSync(file, JSON.stringify(items));
const bad = (fn) => assert.throws(fn, (e) => e instanceof Error && e.message === "invalid threshold");

test("R1a default threshold, filter and sort", () => assert.deepEqual(lowStock(items).map((i) => i.sku), ["4", "5", "2", "1"]));
test("R1b threshold is inclusive and code-point order", () => assert.deepEqual(lowStock(items, 2).map((i) => i.sku), ["4", "5"]));
test("R1c returns new array, no mutation", () => {
  const copy = structuredClone(items);
  const out = lowStock(items);
  assert.notEqual(out, items);
  assert.deepEqual(items, copy);
});
test("R2 invalid threshold", () => {
  for (const t of [-1, 1.5, NaN, "3", null, Infinity]) bad(() => lowStock(items, t));
});
test("R2b zero is valid", () => assert.deepEqual(lowStock(items, 0).map((i) => i.sku), ["4"]));
test("R3a cli default", () => assert.equal(run(["low", file]), "4 m 0\n5 B 2\n2 a 5\n1 b 5"));
test("R3b cli threshold", () => assert.equal(run(["low", file, "--threshold", "0"]), "4 m 0"));
test("R3d cli empty string when none", () => {
  const f = join(mkdtempSync(join(tmpdir(), "grade-")), "e.json");
  writeFileSync(f, JSON.stringify([it("9", "q", 50)]));
  assert.equal(run(["low", f]), "");
});
test("R3e cli bad threshold", () => {
  bad(() => run(["low", file, "--threshold"]));
  bad(() => run(["low", file, "--threshold", "x"]));
  bad(() => run(["low", file, "--threshold", "-2"]));
  bad(() => run(["low", file, "--threshold", "1.5"]));
});
test("R3f cli missing file", () => assert.throws(() => run(["low"]), (e) => e instanceof Error && e.message === "usage: low <file> [--threshold N]"));
test("R4 total unchanged", () => {
  assert.equal(run(["total", file]), String(totalValue(items)));
  assert.throws(() => run(["total"]), /usage: total <file>/);
});
