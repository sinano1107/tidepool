import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { clearSpendDown, expireSpendDown, getSpendDown, setSpendDown } from "../src/spend-down.js";

const HOUR = 60 * 60 * 1000;

it("Provider × ウィンドウを独立に保存し、1つだけ取り消せる", () => {
  const db = openDb(":memory:");
  const sessionAt = new Date("2026-08-20T10:00:00.000Z");
  const primaryAt = new Date("2026-08-20T11:00:00.000Z");

  setSpendDown(db, "anthropic", "session", sessionAt);
  setSpendDown(db, "openai", "primary", primaryAt);
  expect(getSpendDown(db)).toEqual({
    anthropic: { session: { activatedAt: sessionAt }, week: null },
    openai: { primary: { activatedAt: primaryAt }, secondary: null },
  });

  clearSpendDown(db, "anthropic", "session");
  expect(getSpendDown(db)).toEqual({
    anthropic: { session: null, week: null },
    openai: { primary: { activatedAt: primaryAt }, secondary: null },
  });
  db.close();
});

it("同名の窓でも Provider が違えば別の対象になる", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-08-20T10:00:00.000Z");

  setSpendDown(db, "anthropic", "session", at);
  setSpendDown(db, "openai", "session", new Date("2026-08-20T12:00:00.000Z"));
  clearSpendDown(db, "openai", "session");

  expect(getSpendDown(db).anthropic.session).toEqual({ activatedAt: at });
  db.close();
});

it("arm の後に開いた窓が観測されると、その対象の行だけが消え、他の対象は残る", () => {
  const db = openDb(":memory:");
  const armedAt = new Date("2026-08-20T10:00:00.000Z");
  setSpendDown(db, "openai", "primary", armedAt);
  setSpendDown(db, "openai", "secondary", armedAt);
  setSpendDown(db, "anthropic", "session", armedAt);

  expireSpendDown(db, {
    provider: "openai",
    windows: [
      // arm の1時間後に開いた primary —— arm した窓はリセット済み
      { window: "primary", durationMs: 5 * HOUR, resetsAt: new Date(armedAt.getTime() + 6 * HOUR) },
      // arm より前に開いた secondary —— まだ arm した窓のまま
      { window: "secondary", durationMs: 168 * HOUR, resetsAt: new Date(armedAt.getTime() + 24 * HOUR) },
    ],
  });

  expect(getSpendDown(db)).toEqual({
    anthropic: { session: { activatedAt: armedAt }, week: null },
    openai: { primary: null, secondary: { activatedAt: armedAt } },
  });
  db.close();
});

it("観測に現れない窓(Idle・観測不能)の行は残る", () => {
  const db = openDb(":memory:");
  const armedAt = new Date("2026-08-20T10:00:00.000Z");
  setSpendDown(db, "anthropic", "week", armedAt);

  expireSpendDown(db, {
    provider: "anthropic",
    windows: [{ window: "session", durationMs: 5 * HOUR, resetsAt: new Date(armedAt.getTime() + 6 * HOUR) }],
  });

  expect(getSpendDown(db).anthropic.week).toEqual({ activatedAt: armedAt });
  db.close();
});
