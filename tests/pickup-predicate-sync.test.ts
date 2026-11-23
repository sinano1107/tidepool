import { expect, it } from "vitest";
import type { PickupPredicate } from "../src/pickup-predicates.js";

// #3524: 開く前の項は同期で撃たれ await されない(`fireBeforeOpenPredicates`)。async の項は reject が拾われず門を素通りするので、型で拒む
it("開く前の項は async の check を型で拒み、同期の check だけを受ける(#3524)", () => {
  const sync: PickupPredicate = { phase: "before-open", describe: "sync", check: () => {} };
  // @ts-expect-error —— async の開く前の項は型が通らない
  const asyncCheck: PickupPredicate = { phase: "before-open", describe: "async", check: async () => {} };
  expect([sync.phase, asyncCheck.phase]).toEqual(["before-open", "before-open"]);
});
