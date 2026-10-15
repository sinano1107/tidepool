import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import {
  clearSpendDown,
  expireSpendDown,
  getSpendDown,
  isSpendDownActive,
  setSpendDown,
} from "../src/spend-down.js";
import { evaluateAndReportProviderUsage, reportProviderUsage } from "../src/throttle.js";

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

/** その Provider の最新の観測を永続化する(Provider ごとの使用量の観測、ADR 0144)。 */
function observe(
  db: ReturnType<typeof openDb>,
  provider: "anthropic" | "openai",
  observedAt: Date,
  windows: Array<{ window: string; resetsAt: Date }>,
  status: "observed" | "unobservable" = "observed",
): void {
  reportProviderUsage(db, {
    provider,
    status,
    plan: null,
    cliVersion: null,
    observedAt,
    windows: windows.map((w) => ({
      ...w,
      model: null,
      usedPercent: 10,
      durationMs: 5 * HOUR,
      throttled: false,
      resumesAt: null,
    })),
  });
}

// --- arm の時に結ぶ窓を決める(ADR 0260 決定1) ---

it("開いている窓に arm すると、最新の観測のその窓の reset に結ばれる", () => {
  const db = openDb(":memory:");
  const now = new Date("2026-08-20T10:00:00.000Z");
  const resetsAt = new Date(now.getTime() + 2 * HOUR);
  observe(db, "anthropic", new Date(now.getTime() - 10 * MIN), [{ window: "session", resetsAt }]);

  setSpendDown(db, "anthropic", "session", now);

  expect(getSpendDown(db).anthropic.session).toEqual({ activatedAt: now, resetsAt });
  db.close();
});

it.each([
  ["idle(観測にその窓が無い)", [{ window: "week", resetsAt: new Date("2026-08-25T00:00:00.000Z") }], "observed"],
  ["観測不能の Provider", [{ window: "session", resetsAt: new Date("2026-08-20T12:00:00.000Z") }], "unobservable"],
  // 観測の窓はもうリセット済み(5分の拒否の区間も過ぎている)
  ["観測が古い", [{ window: "session", resetsAt: new Date("2026-08-20T09:00:00.000Z") }], "observed"],
] as const)("%s の窓への arm は未確定(次に観測に現れる窓に結ぶ)", (_, windows, status) => {
  const db = openDb(":memory:");
  const now = new Date("2026-08-20T10:00:00.000Z");
  observe(db, "anthropic", new Date("2026-08-20T08:00:00.000Z"), [...windows], status);

  setSpendDown(db, "anthropic", "session", now);

  expect(getSpendDown(db).anthropic.session).toEqual({ activatedAt: now, resetsAt: null });
  db.close();
});

// --- 表示の reset を過ぎて5分以内の arm は拒む(ADR 0260 決定4) ---

it.each([
  ["reset ちょうど", 0, "refused", "observed"],
  ["reset の5分後の直前", 5 * MIN - 1, "refused", "observed"],
  // 終わりかけの窓のつもりの arm は、その窓に結ぶ
  ["reset の直前", -1, "bound", "observed"],
  // 区間を過ぎた arm は次に観測に現れる窓に結ぶ
  ["reset のちょうど5分後", 5 * MIN, "unbound", "observed"],
  // 観測不能の観測に保存された窓の行にも拒否は効く。結ぶのは観測済みの窓だけ
  ["観測不能: reset ちょうど", 0, "refused", "unobservable"],
  ["観測不能: reset の5分後の直前", 5 * MIN - 1, "refused", "unobservable"],
  ["観測不能: reset のちょうど5分後", 5 * MIN, "unbound", "unobservable"],
] as const)("最新の観測の reset に対する arm: %s", (_, offset, outcome, status) => {
  const db = openDb(":memory:");
  const resetsAt = new Date("2026-08-20T10:00:00.000Z");
  const now = new Date(resetsAt.getTime() + offset);
  observe(db, "anthropic", new Date(resetsAt.getTime() - HOUR), [{ window: "session", resetsAt }], status);

  if (outcome === "refused") {
    expect(() => setSpendDown(db, "anthropic", "session", now)).toThrow(
      new DomainError("window is resetting; arm again after the new window opens"),
    );
    expect(getSpendDown(db).anthropic.session).toBeNull();
  } else {
    setSpendDown(db, "anthropic", "session", now);
    expect(getSpendDown(db).anthropic.session).toEqual({
      activatedAt: now,
      resetsAt: outcome === "bound" ? resetsAt : null,
    });
  }
  db.close();
});

it("Provider × ウィンドウを独立に保存し、1つだけ取り消せる", () => {
  const db = openDb(":memory:");
  const sessionAt = new Date("2026-08-20T10:00:00.000Z");
  const primaryAt = new Date("2026-08-20T11:00:00.000Z");

  setSpendDown(db, "anthropic", "session", sessionAt);
  setSpendDown(db, "openai", "primary", primaryAt);
  expect(getSpendDown(db)).toEqual({
    anthropic: { session: { activatedAt: sessionAt, resetsAt: null }, week: null },
    openai: { primary: { activatedAt: primaryAt, resetsAt: null }, secondary: null },
  });

  clearSpendDown(db, "anthropic", "session");
  expect(getSpendDown(db)).toEqual({
    anthropic: { session: null, week: null },
    openai: { primary: { activatedAt: primaryAt, resetsAt: null }, secondary: null },
  });
  db.close();
});

it("同名の窓でも Provider が違えば別の対象になる", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-08-20T10:00:00.000Z");

  setSpendDown(db, "anthropic", "session", at);
  setSpendDown(db, "openai", "session", new Date("2026-08-20T12:00:00.000Z"));
  clearSpendDown(db, "openai", "session");

  expect(getSpendDown(db).anthropic.session).toEqual({ activatedAt: at, resetsAt: null });
  db.close();
});

// --- 失効: 結んだ窓と別の窓が観測されたら行を消す(ADR 0260 決定2) ---

it("結んだ窓と別の窓が観測されると、その対象の行だけが消え、reset の揺れの範囲の窓と他の対象の行は残る", () => {
  const db = openDb(":memory:");
  const armedAt = new Date("2026-08-20T10:00:00.000Z");
  const primaryResets = new Date(armedAt.getTime() + 2 * HOUR);
  const secondaryResets = new Date(armedAt.getTime() + 24 * HOUR);
  observe(db, "openai", armedAt, [
    { window: "primary", resetsAt: primaryResets },
    { window: "secondary", resetsAt: secondaryResets },
  ]);
  setSpendDown(db, "openai", "primary", armedAt);
  setSpendDown(db, "openai", "secondary", armedAt);
  setSpendDown(db, "anthropic", "session", armedAt);

  expireSpendDown(db, {
    provider: "openai",
    windows: [
      // primary は次の窓 —— 結んだ窓はリセット済み
      { window: "primary", resetsAt: new Date(primaryResets.getTime() + 5 * HOUR) },
      // secondary は同じ窓(表示が1分早い)
      { window: "secondary", resetsAt: new Date(secondaryResets.getTime() - MIN) },
    ],
  });

  expect(getSpendDown(db)).toEqual({
    anthropic: { session: { activatedAt: armedAt, resetsAt: null }, week: null },
    openai: { primary: null, secondary: { activatedAt: armedAt, resetsAt: secondaryResets } },
  });
  db.close();
});

it("観測に現れない窓(Idle・観測不能)の行は残る", () => {
  const db = openDb(":memory:");
  const armedAt = new Date("2026-08-20T10:00:00.000Z");
  const weekResets = new Date(armedAt.getTime() + 48 * HOUR);
  observe(db, "anthropic", armedAt, [{ window: "week", resetsAt: weekResets }]);
  setSpendDown(db, "anthropic", "week", armedAt);

  expireSpendDown(db, {
    provider: "anthropic",
    windows: [{ window: "session", resetsAt: new Date(armedAt.getTime() + 6 * HOUR) }],
  });

  expect(getSpendDown(db).anthropic.week).toEqual({ activatedAt: armedAt, resetsAt: weekResets });
  db.close();
});

it("未確定の行は、reset が arm より後の最初に観測された窓に結ばれ、その後の別の窓で消える", () => {
  const db = openDb(":memory:");
  const armedAt = new Date("2026-08-20T10:00:00.000Z");
  setSpendDown(db, "openai", "primary", armedAt);

  // arm 以前にリセット済みの窓の(古い)観測では結ばない
  expireSpendDown(db, { provider: "openai", windows: [{ window: "primary", resetsAt: armedAt }] });
  expect(getSpendDown(db).openai.primary).toEqual({ activatedAt: armedAt, resetsAt: null });

  const opened = new Date(armedAt.getTime() + 5 * HOUR);
  expireSpendDown(db, { provider: "openai", windows: [{ window: "primary", resetsAt: opened }] });
  expect(getSpendDown(db).openai.primary).toEqual({ activatedAt: armedAt, resetsAt: opened });

  expireSpendDown(db, {
    provider: "openai",
    windows: [{ window: "primary", resetsAt: new Date(opened.getTime() + 5 * HOUR) }],
  });
  expect(getSpendDown(db).openai.primary).toBeNull();
  db.close();
});

it("week に結んだ arm は、同じ reset の anthropic の fable の線も外す", () => {
  const db = openDb(":memory:");
  const now = new Date("2026-08-20T10:00:00.000Z");
  const resetsAt = new Date("2026-08-25T00:00:00.000Z");
  observe(db, "anthropic", now, [{ window: "week", resetsAt }]);
  setSpendDown(db, "anthropic", "week", now);

  // 同じ瞬間に失効する予算(ADR 0091 決定2)
  expect(isSpendDownActive(getSpendDown(db), "anthropic", "fable", resetsAt)).toBe(true);
  db.close();
});

it("week が idle の間の次の窓への arm は、開いている fable の窓に当たらず、fable の観測でも結ばれない", () => {
  const db = openDb(":memory:");
  const armedAt = new Date("2026-08-20T10:00:00.000Z");
  const fableResetsAt = new Date("2026-08-25T00:00:00.000Z");
  setSpendDown(db, "anthropic", "week", armedAt);

  expect(isSpendDownActive(getSpendDown(db), "anthropic", "fable", fableResetsAt)).toBe(false);
  expireSpendDown(db, { provider: "anthropic", windows: [{ window: "fable", resetsAt: fableResetsAt }] });
  expect(getSpendDown(db).anthropic.week).toEqual({ activatedAt: armedAt, resetsAt: null });
  db.close();
});

it.each([
  // fable は週次予算で、session と失効時刻を共有しない
  ["anthropic の session は fable の線に触れない", "anthropic", "session", "anthropic", "fable", false],
  // Provider をまたがない(ADR 0143)
  ["openai の primary は anthropic の session の線に触れない", "openai", "primary", "anthropic", "session", false],
] as const)("Spend-down の述語: %s", (_, armedProvider, armedWindow, provider, window, active) => {
  const db = openDb(":memory:");
  const armedAt = new Date("2026-08-20T01:00:00.000Z");
  setSpendDown(db, armedProvider, armedWindow, armedAt);

  expect(isSpendDownActive(getSpendDown(db), provider, window, new Date(armedAt.getTime() + 4 * HOUR))).toBe(active);
  db.close();
});

// --- 当たりは結んだ窓の reset との一致で決まる(ADR 0260 決定1) ---

it.each([
  ["同じ reset", 0, true],
  // 表示の reset の揺れ(#853 の実測は分単位)は別の窓と見なさない
  ["reset が1分早く表示される", -1 * MIN, true],
  ["reset が1分遅く表示される", 1 * MIN, true],
  // 窓の開始は使わない —— 次の窓の reset は5時間先
  ["次の窓の reset", 5 * HOUR, false],
] as const)("開いている窓に結んだ arm が当たるか: %s", (_, shift, active) => {
  const db = openDb(":memory:");
  const now = new Date("2026-08-20T10:00:00.000Z");
  const resetsAt = new Date(now.getTime() + 2 * HOUR);
  observe(db, "openai", now, [{ window: "primary", resetsAt }]);
  setSpendDown(db, "openai", "primary", now);

  expect(isSpendDownActive(getSpendDown(db), "openai", "primary", new Date(resetsAt.getTime() + shift))).toBe(active);
  db.close();
});

it("未確定の arm は、reset が arm より後の窓に当たり、reset が arm 以前の(古い)窓には当たらない", () => {
  const db = openDb(":memory:");
  const armedAt = new Date("2026-08-20T10:00:00.000Z");
  setSpendDown(db, "anthropic", "session", armedAt);
  const state = getSpendDown(db);

  expect(isSpendDownActive(state, "anthropic", "session", new Date(armedAt.getTime() + 5 * HOUR))).toBe(true);
  expect(isSpendDownActive(state, "anthropic", "session", armedAt)).toBe(false);
  db.close();
});

// --- #853 の実測: idle の間の arm の直後に開いた窓(ADR 0260) ---

/** session 10% —— 窓の頭ではペース線(経過 − 既定オフセット20)を超えるので、Spend-down が当たらなければ絞られる。 */
function evaluateSession(db: ReturnType<typeof openDb>, now: Date, resetsAt: Date) {
  const observed = evaluateAndReportProviderUsage(
    db,
    {
      provider: "anthropic",
      status: "observed",
      plan: null,
      cliVersion: null,
      windows: [{ window: "session", model: null, usedPercent: 10, durationMs: 5 * HOUR, resetsAt }],
    },
    now,
  );
  return observed.windows[0]!.throttled;
}

it("idle の間に arm した直後に開いた窓には、表示の reset が実際より早く揺れても Spend-down が当たり、次の窓では当たらず行が消える", () => {
  const db = openDb(":memory:");
  // arm は hi を送った時刻 —— session 窓はこの直後に開いた(#853 の対照実測)
  const armedAt = new Date("2026-10-14T23:10:52.753Z");
  observe(db, "anthropic", new Date("2026-10-14T22:00:00.000Z"), [
    { window: "week", resetsAt: new Date("2026-10-17T04:00:00.000Z") },
  ]);
  setSpendDown(db, "anthropic", "session", armedAt);

  // 表示の reset は Oct 15 1:09pm / 1:10pm JST で揺れる —— 逆算した開始は arm より最大1分52秒前
  for (const [at, resetsAt] of [
    ["2026-10-14T23:11:09.589Z", "2026-10-15T04:09:00.000Z"],
    ["2026-10-14T23:12:32.603Z", "2026-10-15T04:10:00.000Z"],
    ["2026-10-14T23:16:42.541Z", "2026-10-15T04:09:00.000Z"],
  ] as const) {
    const observed = { provider: "anthropic" as const, windows: [{ window: "session", resetsAt: new Date(resetsAt) }] };
    expect(evaluateSession(db, new Date(at), new Date(resetsAt))).toBe(false);
    expireSpendDown(db, observed);
    expect(getSpendDown(db).anthropic.session).toEqual({
      activatedAt: armedAt,
      resetsAt: new Date("2026-10-15T04:09:00.000Z"),
    });
  }

  // 次の窓: 失効処理の前の評価でも当たらない
  const nextResets = new Date("2026-10-15T09:20:00.000Z");
  expect(evaluateSession(db, new Date("2026-10-15T04:20:00.000Z"), nextResets)).toBe(true);
  expireSpendDown(db, { provider: "anthropic", windows: [{ window: "session", resetsAt: nextResets }] });
  expect(getSpendDown(db).anthropic.session).toBeNull();
  db.close();
});
