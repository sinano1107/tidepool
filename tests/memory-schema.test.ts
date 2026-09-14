import { expect, it } from "vitest";
import { openDb } from "../src/db.js";

/** Memory のエントリ表(spec #586 A / issue #590)。表は events の投影なので、ここで
 *  言うのは CHECK が値域の外を拒むことだけ —— 読み書きの挙動はドメイン層が言う。 */
const insert = (db: ReturnType<typeof openDb>, overrides: Record<string, unknown> = {}) => {
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
  return db
    .prepare(`INSERT INTO memory_entries (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
};

it("fresh 盤面に memory のエントリ表があり、値域どおりの行は入る", () => {
  const db = openDb(":memory:");
  insert(db);
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
  expect(() => insert(db, overrides)).toThrow(/CHECK/);
  db.close();
});

it("fresh 盤面に Memory の FTS 仮想表と、tokenizer id + 前処理の版の1行がある(spec #586 B / issue #591)", () => {
  const db = openDb(":memory:");
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'").get()).toEqual({
    sql: expect.stringMatching(/fts5\(text, title, path, original, tokenize = "unicode61 tokenchars '_-\.'"\)/),
  });
  expect(db.prepare("SELECT tokenizer, preprocess_version FROM memory_index_version").all()).toEqual([
    { tokenizer: "unicode61 tokenchars '_-.'", preprocess_version: "cjk-bigram-2" },
  ]);
  db.close();
});

it("episode_markers.kind の CHECK は memory マーカーを受ける(issue #591)", () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO tasks (id, type, status, title, purpose, completion_criteria, sort_key, created_at) VALUES ('t1', 'work', 'todo', 't', 'p', 'c', 1, '2026-09-14T00:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO episodes (id, worker_spawned_event_id, extractor_version, task_id, agent, lines) VALUES (1, 1, '3', 't1', 'tako', '{}')",
  ).run();
  const insert = db.prepare("INSERT INTO episode_markers (episode_id, seq, kind, position, event_id) VALUES (1, ?, ?, 0, 9)");
  insert.run(0, "memory");
  expect(db.prepare("SELECT kind FROM episode_markers").all()).toEqual([{ kind: "memory" }]);
  expect(() => insert.run(1, "injection")).toThrow(/CHECK/);
  db.close();
});

it("fresh 盤面に注入上限の1行表があり、正でない上限は CHECK が拒む(issue #592)", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO memory_defaults (id, injection_token_cap) VALUES (1, 500)").run();
  expect(db.prepare("SELECT injection_token_cap FROM memory_defaults").all()).toEqual([{ injection_token_cap: 500 }]);
  expect(() => db.prepare("UPDATE memory_defaults SET injection_token_cap = 0").run()).toThrow(/CHECK/);
  db.close();
});
