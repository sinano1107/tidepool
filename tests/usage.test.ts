import { expect, it } from "vitest";
import { claudeUsageObservation, composeTerminalScreen, parseUsage } from "../src/usage.js";
import { PI_USAGE_CAPTURE_2_1_221 } from "./fixtures/usage-pi-2.1.221.js";

it("Pi の実測差分描画を合成すると、ストリームに無い fable ラベルと全 usage を読める(issue #323)", async () => {
  expect(PI_USAGE_CAPTURE_2_1_221).not.toContain("Current week (Fable)");

  const screen = await composeTerminalScreen(PI_USAGE_CAPTURE_2_1_221, 200, 50);

  expect(screen).toContain("Current week (Fable)");
  expect(parseUsage(screen, new Date("2026-08-14T00:00:00.000Z"))).toEqual({
    session: { percent: 66, resetsAt: new Date("2026-08-14T07:59:00.000Z") },
    week: { percent: 4, resetsAt: new Date("2026-08-20T03:59:00.000Z") },
    fable: { percent: 7, resetsAt: new Date("2026-08-20T04:00:00.000Z") },
  });
});

it("実機キャプチャの Refreshing… 付き stale seed は全ウィンドウを観測不能にする(issue #334)", async () => {
  const marker = "Refreshing…";
  const markerOffset = PI_USAGE_CAPTURE_2_1_221.indexOf(marker);
  expect(markerOffset).not.toBe(-1);
  const screen = await composeTerminalScreen(
    PI_USAGE_CAPTURE_2_1_221.slice(0, markerOffset + marker.length),
    200,
    50,
  );

  expect(parseUsage(screen, new Date("2026-08-14T00:00:00.000Z"))).toEqual({
    session: null,
    week: null,
    fable: null,
  });
});

// 失敗系マーカーは CLI 2.1.232 バンドルの実読に基づく合成済み画面テキスト(ADR 0078)。
const SYNTHETIC_USAGE_SCREEN =
  "Current session\n10% used\nResets 1pm (Asia/Tokyo)\n" +
  "Current week (all models)\n20% used\nResets Aug 20 at 1pm (Asia/Tokyo)\n" +
  "Current week (Fable)\n30% used\nResets Aug 20 at 1pm (Asia/Tokyo)";

// CLI が実際に出す文字列(2.1.221 / 2.1.245 実読)。persisted seed は必ず
// `Showing last-known usage` を伴い、rate limit / refresh 失敗はその接尾辞として出る。
it.each([
  "Refreshing…",
  "Showing last-known usage (could not refresh)",
  "Showing last-known usage (rate limited — try again in a moment)",
  "Failed to load usage data",
])("%s 付き画面は全ウィンドウを観測不能にする(issue #334)", (marker) => {
  expect(parseUsage(`${SYNTHETIC_USAGE_SCREEN}\n${marker}`, new Date("2026-08-14T00:00:00.000Z"))).toEqual({
    session: null,
    week: null,
    fable: null,
  });
});

// 本番 Pi が永続 fail-closed を踏んだ回の /usage 画面(issue #492)。生バイトは
// 残っておらず issue 本文の画面テキストからの転記 — ADR 0078 が失敗マーカーに
// 認めた synthetic と同じ扱いで、検査対象はパーサのテキスト述語そのもの。
// per-model の内訳だけが取れず、session / week は描かれている。fable ラベルは
// 出ないので fable は null(issue #492 の再現出力もそう報告している)。
const PER_MODEL_RATE_LIMITED_SCREEN = `Current session
██████████████████████████████████████████████████ 100% used
Resets 8pm (Asia/Tokyo)

Current week (all models)
███████████████████████████████████████████████▌   95% used
Resets Aug 27, 1pm (Asia/Tokyo)

Per-model breakdown unavailable (rate limited — try again in a moment)`;

// 当時の盤面に残った使用量観測の observed_at そのもの(18:41:49 Asia/Tokyo)。
// 画面の `Resets 8pm` が意味する 5h 窓(15:00〜20:00 Asia/Tokyo)の中にある。
const PER_MODEL_RATE_LIMITED_NOW = new Date("2026-08-25T09:41:49.623Z");

it("per-model の内訳だけが rate limited な実機画面は、session / week を観測値として読む(issue #492)", () => {
  expect(parseUsage(PER_MODEL_RATE_LIMITED_SCREEN, PER_MODEL_RATE_LIMITED_NOW)).toEqual({
    session: { percent: 100, resetsAt: new Date("2026-08-25T11:00:00.000Z") },
    week: { percent: 95, resetsAt: new Date("2026-08-27T04:00:00.000Z") },
    fable: null,
  });
});

// issue #287 で Pi 上の静止 session window を ADR 0074 の画面合成に通して
// 確定した最終画面。初期フレームの仮 Resets 行は redraw 後には残らない。
const IDLE_SESSION_SCREEN = `Current session
                                                     0% used

  Current week (all models)
  ███▌                                               7% used
  Resets Aug 20, 12:59pm (Asia/Tokyo)`;

it("Resets 行のない実機由来の 0% session は、観測不能でなく idle として読む(issue #287)", () => {
  expect(parseUsage(IDLE_SESSION_SCREEN, new Date("2026-08-14T00:00:00.000Z"))).toEqual({
    session: "idle",
    week: { percent: 7, resetsAt: new Date("2026-08-20T03:59:00.000Z") },
    fable: null,
  });
});

it("Resets 行のない 0%超の session は破損疑いとして観測不能のままにする(issue #287)", () => {
  expect(
    parseUsage(
      "Current session\n                                                     1% used\n\nCurrent week (all models)\n7% used\nResets Aug 20, 12:59pm (Asia/Tokyo)",
      new Date("2026-08-14T00:00:00.000Z"),
    ),
  ).toEqual({
    session: null,
    week: { percent: 7, resetsAt: new Date("2026-08-20T03:59:00.000Z") },
    fable: null,
  });
});

it("Resets 行のない 0% week は後続の fable Resets と混ぜず、session と同じく idle として読む(issue #287)", () => {
  expect(
    parseUsage(
      "Current session\n7% used\nResets 12:59pm (Asia/Tokyo)\n\nCurrent week (all models)\n0% used\n\nCurrent week (Fable)\n7% used\nResets Aug 20, 12:59pm (Asia/Tokyo)",
      new Date("2026-08-14T00:00:00.000Z"),
    ),
  ).toEqual({
    session: { percent: 7, resetsAt: new Date("2026-08-14T03:59:00.000Z") },
    week: "idle",
    fable: { percent: 7, resetsAt: new Date("2026-08-20T03:59:00.000Z") },
  });
});

// ラズパイ実機で `claude --safe-mode` の /usage パネルを PTY 越しにキャプチャした生バイト列から
// 抜粋(issue #80 実測)。ANSI エスケープ・カーソル移動・プログレスバーのブロック文字を含む。
// ANSI 除去後は列位置指定(`\x1b[54G` 等)が消えて語間が結合する(`70%used`)。
const REAL_PTY_CAPTURE =
  "Current session\r\x1b[2C\x1b[1B\x1b[22m\x1b[48;2;80;83;112m\x1b[38;2;177;185;249m███████████████████████████████████               \x1b[54G\x1b[39m\x1b[49m70%\x1b[58Gused\r\x1b[2C\x1b[1B\x1b[38;2;153;153;153mResets 1:30pm (Asia/Tokyo)\r\x1b[2C\x1b[2B\x1b[39m\x1b[1mCurrent week (all models)\r\x1b[2C\x1b[1B\x1b[22m\x1b[48;2;80;83;112m\x1b[38;2;177;185;249m██████████████▍                                   \x1b[54G\x1b[39m\x1b[49m28%\x1b[58Gused\r\x1b[2C\x1b[1B\x1b[38;2;153;153;153mResets Jul 23 at 1pm (Asia/Tokyo)";

it("実機で観測した PTY 生キャプチャ(ANSI・カーソル移動混じり)を合成して session/week の使用率と reset 時刻をパースする(issue #80)", async () => {
  const now = new Date("2026-07-17T00:00:00.000Z"); // 両方の reset より前、同年

  const screen = await composeTerminalScreen(REAL_PTY_CAPTURE, 200, 50);
  const snapshot = parseUsage(screen, now);

  expect(snapshot.session).toEqual({
    percent: 70,
    resetsAt: new Date("2026-07-17T04:30:00.000Z"),
  });
  expect(snapshot.week).toEqual({
    percent: 28,
    resetsAt: new Date("2026-07-23T04:00:00.000Z"),
  });
});

it("session の日付なし Resets は、now より過去の時刻なら翌日に丸まる(issue #80 境界)", () => {
  const resultText = "Current session\r70%used\rResets 1:30pm (Asia/Tokyo)";
  const now = new Date("2026-07-17T05:00:00.000Z"); // JST 14:00 — 1:30pm(13:30 JST)より後

  const snapshot = parseUsage(resultText, now);

  expect(snapshot.session).toEqual({
    percent: 70,
    resetsAt: new Date("2026-07-18T04:30:00.000Z"), // 翌日 1:30pm JST
  });
});

it("session の日付なし Resets は、now よりまだ先の時刻なら当日に丸まる(境界の反対側)", () => {
  const resultText = "Current session\r70%used\rResets 1:30pm (Asia/Tokyo)";
  const now = new Date("2026-07-17T04:00:00.000Z"); // JST 13:00 — 1:30pm(13:30 JST)より前

  const snapshot = parseUsage(resultText, now);

  expect(snapshot.session).toEqual({
    percent: 70,
    resetsAt: new Date("2026-07-17T04:30:00.000Z"), // 当日 1:30pm JST
  });
});

it("30分単位のタイムゾーンオフセット(Asia/Kolkata, GMT+5:30)の session でも分単位まで正確にパースする", () => {
  const resultText = "Current session\r40%used\rResets 8:15pm (Asia/Kolkata)";
  const now = new Date("2026-07-08T10:00:00.000Z"); // Kolkata 15:30 — 20:15より前、当日中

  const snapshot = parseUsage(resultText, now);

  expect(snapshot.session).toEqual({
    percent: 40,
    resetsAt: new Date("2026-07-08T14:45:00.000Z"), // 20:15 IST = 14:45 UTC
  });
});

it("week の年境界をまたぐ reset(12月末の now → 1月の resets)は常に未来側の年に丸める", () => {
  const resultText =
    "Current session\r10%used\rResets 9:00am (Asia/Tokyo)\rCurrent week (all models)\r15%used\rResets Jan 3 at 9:00am (Asia/Tokyo)";
  const now = new Date("2026-12-30T00:00:00.000Z");

  const snapshot = parseUsage(resultText, now);

  expect(snapshot.week).toEqual({
    percent: 15,
    resetsAt: new Date("2027-01-03T00:00:00.000Z"),
  });
});

it("issue #80 記載のサンプル通り tz 注記なし(`Resets 1:30pm` / `Resets Jul 23 at 1pm`)でも、ホストのローカル tz を仮定してパースする(恒久 fail-closed への回帰防止)", () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  try {
    const resultText =
      "Current session\r42%used\rResets 1:30pm\rCurrent week (all models)\r30%used\rResets Jul 23 at 1pm";
    const now = new Date("2026-07-17T00:00:00.000Z"); // JST 09:00 — 両方の reset より前

    const snapshot = parseUsage(resultText, now);

    expect(snapshot.session).toEqual({
      percent: 42,
      resetsAt: new Date("2026-07-17T04:30:00.000Z"), // 1:30pm JST(ローカル tz 仮定)
    });
    expect(snapshot.week).toEqual({
      percent: 30,
      resetsAt: new Date("2026-07-23T04:00:00.000Z"), // Jul 23 1pm JST(ローカル tz 仮定)
    });
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

it("week ブロックに per-model の内訳行があっても、先頭に現れる (all models) 自身の %/resets だけを読む", () => {
  const resultText =
    "Current session\r10%used\rResets 9:00am (Asia/Tokyo)\r" +
    "Current week (all models)\r52%used\rResets Jul 16 at 1pm (Asia/Tokyo)\r" +
    "Current week (some-other-model)\r30%used\rResets Jul 16 at 1pm (Asia/Tokyo)";
  const now = new Date("2026-07-12T00:00:00.000Z");

  const snapshot = parseUsage(resultText, now);

  expect(snapshot.week).toEqual({
    percent: 52,
    resetsAt: new Date("2026-07-16T04:00:00.000Z"),
  });
});

// macOS 実機で claude 2.1.217 の /usage パネルを PTY キャプチャした生バイト列から
// fable 行を抜粋(issue #126 実測、2026-07-22)。ラベルは "Current week (Fable)"、
// 書式は (all models) と同形で、パネル下部の per-model 行として現れる。
const REAL_PTY_CAPTURE_WITH_FABLE =
  REAL_PTY_CAPTURE +
  "\r\x1b[3C\x1b[2B\x1b[39m\x1b[1mCurrent week (Fable)\x1b[22m\x1b[K\r\x1b[3C\x1b[1B\x1b[48;2;80;83;112m\x1b[38;2;177;185;249m██████████████████████████████████████            \x1b[55G\x1b[39m\x1b[49m75%\x1b[59Gused\r\x1b[3C\x1b[1B\x1b[38;2;153;153;153mResets Jul 23 at 1pm (Asia/Tokyo)";

it("fable 行(Current week (Fable))のある実機キャプチャを合成して fable ウィンドウの使用率と reset 時刻をパースする(issue #126)", async () => {
  const now = new Date("2026-07-17T00:00:00.000Z");

  const screen = await composeTerminalScreen(REAL_PTY_CAPTURE_WITH_FABLE, 200, 50);
  const snapshot = parseUsage(screen, now);

  // session/week は従来どおり読めたまま
  expect(snapshot.session).toMatchObject({ percent: 70 });
  expect(snapshot.week).toMatchObject({ percent: 28 });
  expect(snapshot.fable).toEqual({
    percent: 75,
    resetsAt: new Date("2026-07-23T04:00:00.000Z"),
  });
});

it("fable 行が無いパネル(Pro プラン — 個別制限が存在しない)を合成しても fable=null で、session/week の読みは損なわれない(ADR 0030: 不在は fail-closed にしない)", async () => {
  const now = new Date("2026-07-17T00:00:00.000Z");

  const screen = await composeTerminalScreen(REAL_PTY_CAPTURE, 200, 50);
  const snapshot = parseUsage(screen, now);

  expect(snapshot.fable).toBeNull();
  expect(snapshot.session).toMatchObject({ percent: 70 });
  expect(snapshot.week).toMatchObject({ percent: 28 });
});

it("既知の行パターンに一致しないテキスト(該当行なし・unavailable 表示など)は session/week とも null(fail-closed の入力)", () => {
  const snapshot = parseUsage(
    "Current session\rusage data unavailable\rCurrent week (all models)\rusage data unavailable",
    new Date("2026-07-08T00:00:00.000Z"),
  );

  expect(snapshot).toEqual({ session: null, week: null, fable: null });
});

it("Current session / Current week のラベル自体が現れないテキストも session/week とも null(fail-closed の入力)", () => {
  const snapshot = parseUsage("something went wrong\n", new Date("2026-07-08T00:00:00.000Z"));

  expect(snapshot).toEqual({ session: null, week: null, fable: null });
});

// now 基準の観測: session は 13:00、week は2日後にリセットする。
const SESSION_RESETS = new Date("2026-07-22T13:00:00.000Z");
const WEEK_RESETS = new Date("2026-07-24T12:00:00.000Z");

// --- `/usage` → Provider ごとの使用量の観測への変換(ADR 0144 決定2) ---
const H = 60 * 60 * 1000;

it("session / week は Provider 全体の窓(5時間 / 7日)、fable は model 固有の窓(7日)として観測に載る", () => {
  expect(
    claudeUsageObservation({
      session: { percent: 55, resetsAt: SESSION_RESETS },
      week: { percent: 30, resetsAt: WEEK_RESETS },
      fable: { percent: 85, resetsAt: WEEK_RESETS },
    }),
  ).toEqual({
    status: "observed",
    windows: [
      { window: "session", model: null, usedPercent: 55, durationMs: 5 * H, resetsAt: SESSION_RESETS },
      { window: "week", model: null, usedPercent: 30, durationMs: 7 * 24 * H, resetsAt: WEEK_RESETS },
      { window: "fable", model: "fable", usedPercent: 85, durationMs: 7 * 24 * H, resetsAt: WEEK_RESETS },
    ],
  });
});

it.each([
  ["week", { session: { percent: 55, resetsAt: SESSION_RESETS }, week: null, fable: null }, ["session"]],
  ["session", { session: null, week: { percent: 30, resetsAt: WEEK_RESETS }, fable: null }, ["week"]],
] as const)("%s が読めなければ観測不能(fail-closed)、読めた側の窓は内訳として残す", (_, snapshot, readable) => {
  const observation = claudeUsageObservation(snapshot);

  expect(observation.status).toBe("unobservable");
  expect(observation.reason).toBe("Claude usage windows are unobservable");
  expect(observation.windows.map((window) => window.window)).toEqual(readable);
});

it("idle の session は fail-closed の入力にせず、窓の列から落とす(issue #287)", () => {
  expect(
    claudeUsageObservation({ session: "idle", week: { percent: 30, resetsAt: WEEK_RESETS }, fable: null }),
  ).toEqual({
    status: "observed",
    windows: [{ window: "week", model: null, usedPercent: 30, durationMs: 7 * 24 * H, resetsAt: WEEK_RESETS }],
  });
});

it.each([null, "idle"] as const)(
  "fable が %s なら fable の窓は観測に無く、fail-closed の入力でもない(ADR 0030)",
  (fable) => {
    const observation = claudeUsageObservation({
      session: { percent: 55, resetsAt: SESSION_RESETS },
      week: { percent: 30, resetsAt: WEEK_RESETS },
      fable,
    });

    expect(observation.status).toBe("observed");
    expect(observation.windows.map((window) => window.window)).toEqual(["session", "week"]);
  },
);
