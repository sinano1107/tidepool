import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";

/** ADR 0107 決定1 の schema 層 —— 列そのものを SQL で言う。ドメイン層は値の
 *  解決順と拒否を言い、この層は「新規盤面が列を持つ」を言う。 */
function taskColumns(db: Db): string[] {
  return (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
}

it("新規盤面の tasks は要求2列(tier / priority)を持つ(ADR 0110 決定2)", () => {
  expect(taskColumns(openDb(":memory:"))).toEqual(expect.arrayContaining(["tier", "priority"]));
});

it("新規盤面の tasks は独立した review_by / review_tier を持つ(ADR 0111)", () => {
  const db = openDb(":memory:");
  expect(taskColumns(db)).toEqual(expect.arrayContaining(["review_by", "review_tier"]));
  db.close();
});

it("制約(Provider 制限・予算)は task 側の列として存在しない(ADR 0110 決定2: 制約は workspace と盤面設定の側)", () => {
  const columns = taskColumns(openDb(":memory:"));
  expect(columns).not.toContain("provider");
  expect(columns).not.toContain("budget");
});
