// R-ids are the requirement numbers of the ticket. Run with: node --test grader/t1.test.js  (cwd = the repo under test)
import assert from "node:assert/strict";
import { test } from "node:test";
const { toCsv } = await import(`${process.cwd()}/src/csv.js`);
const it = (sku, name, qty, price) => ({ sku, name, qty, price });

test("R1 header and column order", () => assert.equal(toCsv([it("A1", "Bolt", 3, 2)]).split("\n")[0], "sku,name,qty,price"));
test("R2 price has two decimals, qty as is", () => assert.equal(toCsv([it("A1", "Bolt", 3, 0.5)]), "sku,name,qty,price\nA1,Bolt,3,0.50\n"));
test("R3a comma is quoted", () => assert.equal(toCsv([it("A1", "Nut, M4", 1, 1)]), 'sku,name,qty,price\nA1,"Nut, M4",1,1.00\n'));
test("R3b quote is doubled", () => assert.equal(toCsv([it("A1", 'The "big" one', 1, 1)]), 'sku,name,qty,price\nA1,"The ""big"" one",1,1.00\n'));
test("R3c LF and CR are quoted", () => {
  assert.equal(toCsv([it("A1", "a\nb", 1, 1)]), 'sku,name,qty,price\nA1,"a\nb",1,1.00\n');
  assert.equal(toCsv([it("A1", "a\rb", 1, 1)]), 'sku,name,qty,price\nA1,"a\rb",1,1.00\n');
});
test("R3d sku is escaped too", () => assert.equal(toCsv([it("A,1", "x", 1, 1)]), 'sku,name,qty,price\n"A,1",x,1,1.00\n'));
test("R4 LF endings and one trailing LF", () => {
  const out = toCsv([it("A", "a", 1, 1), it("B", "b", 2, 2)]);
  assert.equal(out, "sku,name,qty,price\nA,a,1,1.00\nB,b,2,2.00\n");
  assert.ok(!out.includes("\r"));
});
test("R5 empty array is header only", () => assert.equal(toCsv([]), "sku,name,qty,price\n"));
test("R6 does not mutate", () => {
  const items = [it("A", "a,b", 1, 1.5)];
  const copy = structuredClone(items);
  toCsv(items);
  assert.deepEqual(items, copy);
});
