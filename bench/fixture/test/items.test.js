import assert from "node:assert/strict";
import { test } from "node:test";
import { findByName, totalValue } from "../src/items.js";

const items = [
  { sku: "A1", name: "Bolt", qty: 10, price: 0.5 },
  { sku: "B2", name: "Nut", qty: 4, price: 0.25 },
];

test("totalValue", () => assert.equal(totalValue(items), 6));
test("findByName", () => assert.equal(findByName(items, "Nut")?.sku, "B2"));
