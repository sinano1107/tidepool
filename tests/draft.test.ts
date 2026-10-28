import { expect, it } from "vitest";
import { BoardCallUsageError, listBoardCalls } from "../src/board-call-usage.js";
import { openDb } from "../src/db.js";
import { type ChildDraftContext, draftHandoff, draftTask } from "../src/draft.js";
import { BOARD_CALL_USAGE, FakeDraftClient } from "./fakes.js";

const now = new Date("2026-10-22T00:00:00.000Z");

const CHILD: ChildDraftContext = { parentTitle: "build the toolchain", parentPurpose: "p", parentCompletionCriteria: "c", siblingTitles: [] };

/** 用途ごとの下書きを1回撃つ(`client` が下書きの Board call)。 */
const fire = {
  task_draft: (db: ReturnType<typeof openDb>, client: FakeDraftClient) => draftTask(db, client, { dump: "d", language: "English" }, now),
  child_draft: (db: ReturnType<typeof openDb>, client: FakeDraftClient) => draftTask(db, client, { dump: "d", language: "English", context: CHILD }, now),
  handoff_draft: (db: ReturnType<typeof openDb>, client: FakeDraftClient) => draftHandoff(db, client, { dump: "d", language: "English", taskId: "T-1" }, now),
};

it.each(Object.keys(fire) as (keyof typeof fire)[])("%s の下書きは、撃った行でその用途の行を1つ残す(ADR 0299 決定1)", async (use) => {
  const db = openDb(":memory:");
  const client = new FakeDraftClient();

  await fire[use](db, client);

  expect(listBoardCalls(db)).toEqual([{ use, ...client.setting, fragments: null, model_swaps: [], refusals: [], usage: BOARD_CALL_USAGE, createdAt: now.toISOString() }]);
});

it.each(Object.keys(fire) as (keyof typeof fire)[])("usage を報告して失敗した %s の下書きも行を残し、失敗は呼び手へ投げる(ADR 0299 決定3)", async (use) => {
  const db = openDb(":memory:");
  const client = new FakeDraftClient();
  const failed = new BoardCallUsageError("answer did not match the schema", client.setting, BOARD_CALL_USAGE);
  client.scriptFailure(failed);
  client.scriptHandoffFailure(failed);

  await expect(fire[use](db, client)).rejects.toBe(failed);

  expect(listBoardCalls(db).map((row) => row.use)).toEqual([use]);
});
