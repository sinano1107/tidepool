import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getEvent } from "../src/events.js";
import { changeMetaReviewSettings, readMetaReviewSettings } from "../src/meta-review.js";

const at = new Date("2026-09-23T00:00:00.000Z");

it("周期は未設定なら 7 日で、変更は読み口に効き、人間名義・task 無しの meta_review_settings_changed を1件だけ残す(issue #924)", () => {
  const db = openDb(":memory:");
  expect(readMetaReviewSettings(db)).toEqual({ period_days: 7 });

  const eventId = changeMetaReviewSettings(db, { period_days: 3 }, "mcp", at);

  expect(readMetaReviewSettings(db)).toEqual({ period_days: 3 });
  expect(db.prepare("SELECT id FROM events").all()).toEqual([{ id: eventId }]);
  expect(getEvent(db, eventId)).toMatchObject({ task_id: null, worker_id: "human", origin: "mcp" });
  expect(getEvent(db, eventId)?.payload).toEqual({ kind: "meta_review_settings_changed", period_days: 3 });
});
