import { expect, it } from "vitest";
import { openDb } from "../src/db.js";

/** Memory のエントリ表(spec #586 A / issue #590)。表は events の投影なので、ここで
 *  言うのは CHECK が値域の外を拒むことだけ —— 読み書きの挙動はドメイン層が言う。 */
const insert = (overrides: Record<string, unknown> = {}) => {
  const row = {
    id: 1,
    kind: "knowledge",
    state: "approved",
    scope: null,
    path: "build/tests",
    title: "t",
    text: "x",
    source_kind: "commit",
    source_ref: "abc1234",
    author_activity: "worker_verb",
    author: "deckhand",
    invalidation_reason: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  return (db: ReturnType<typeof openDb>) =>
    db
      .prepare(`INSERT INTO memory_entries (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...Object.values(row));
};

it("fresh 盤面に memory のエントリ表があり、値域どおりの行は入る", () => {
  const db = openDb(":memory:");
  insert()(db);
  expect(db.prepare("SELECT kind, state, source_kind FROM memory_entries").all()).toEqual([
    { kind: "knowledge", state: "approved", source_kind: "commit" },
  ]);
  db.close();
});

it.each([
  ["種別", { kind: "fact" }],
  ["状態", { state: "rejected" }],
  ["出所の種別", { source_kind: "url" }],
  ["書き手の活動", { author_activity: "worker" }],
  ["無効化の理由コード", { invalidation_reason: "preference" }],
])("エントリ表の CHECK は値域の外の%sを拒む", (_, overrides) => {
  const db = openDb(":memory:");
  expect(() => insert(overrides)(db)).toThrow(/CHECK/);
  db.close();
});
