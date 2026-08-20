import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { clearSpendDown, getSpendDown, setSpendDown } from "../src/spend-down.js";

it("session と week を独立に保存し、片方だけ取り消せる", () => {
  const db = openDb(":memory:");
  const sessionAt = new Date("2026-08-20T10:00:00.000Z");
  const weekAt = new Date("2026-08-20T11:00:00.000Z");

  setSpendDown(db, "session", sessionAt);
  setSpendDown(db, "week", weekAt);
  expect(getSpendDown(db)).toEqual({
    session: { activatedAt: sessionAt },
    week: { activatedAt: weekAt },
  });

  clearSpendDown(db, "session");
  expect(getSpendDown(db)).toEqual({
    session: null,
    week: { activatedAt: weekAt },
  });
  db.close();
});
