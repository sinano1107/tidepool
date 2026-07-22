import { expect, it } from "vitest";
import { evaluateThrottle, parseUsage } from "../src/usage.js";

// ラズパイ実機で `claude --safe-mode` の /usage パネルを PTY 越しにキャプチャした生バイト列から
// 抜粋(issue #80 実測)。ANSI エスケープ・カーソル移動・プログレスバーのブロック文字を含む。
// ANSI 除去後は列位置指定(`\x1b[54G` 等)が消えて語間が結合する(`70%used`)。
const REAL_PTY_CAPTURE =
  "Current session\r\x1b[2C\x1b[1B\x1b[22m\x1b[48;2;80;83;112m\x1b[38;2;177;185;249m███████████████████████████████████               \x1b[54G\x1b[39m\x1b[49m70%\x1b[58Gused\r\x1b[2C\x1b[1B\x1b[38;2;153;153;153mResets 1:30pm (Asia/Tokyo)\r\x1b[2C\x1b[2B\x1b[39m\x1b[1mCurrent week (all models)\r\x1b[2C\x1b[1B\x1b[22m\x1b[48;2;80;83;112m\x1b[38;2;177;185;249m██████████████▍                                   \x1b[54G\x1b[39m\x1b[49m28%\x1b[58Gused\r\x1b[2C\x1b[1B\x1b[38;2;153;153;153mResets Jul 23 at 1pm (Asia/Tokyo)";

it("実機で観測した PTY 生キャプチャ(ANSI・カーソル移動混じり)から session/week の使用率と reset 時刻をパースする(issue #80)", () => {
  const now = new Date("2026-07-17T00:00:00.000Z"); // 両方の reset より前、同年

  const snapshot = parseUsage(REAL_PTY_CAPTURE, now);

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

it("既知の行パターンに一致しないテキスト(該当行なし・unavailable 表示など)は session/week とも null(fail-closed の入力)", () => {
  const snapshot = parseUsage(
    "Current session\rusage data unavailable\rCurrent week (all models)\rusage data unavailable",
    new Date("2026-07-08T00:00:00.000Z"),
  );

  expect(snapshot).toEqual({ session: null, week: null });
});

it("Current session / Current week のラベル自体が現れないテキストも session/week とも null(fail-closed の入力)", () => {
  const snapshot = parseUsage("something went wrong\n", new Date("2026-07-08T00:00:00.000Z"));

  expect(snapshot).toEqual({ session: null, week: null });
});

// --- ペース基準判定 (ADR 0030): throttled ⟺ 使用率% > 経過時間割合% − オフセット(pt) ---
// 経過割合はリセット時刻からウィンドウ長(session 5時間 / week 7日)を引いて逆算する。
// now = 12:00, session resets 13:00 → 開始 08:00、経過 4h/5h = 80%。
const PACE_NOW = new Date("2026-07-22T12:00:00.000Z");
const SESSION_RESETS = new Date("2026-07-22T13:00:00.000Z");
// week resets 2日後 → 開始 Jul 17 12:00、経過 5/7 ≈ 71.4%。オフセット10で線は61.4。
const WEEK_RESETS = new Date("2026-07-24T12:00:00.000Z");
const OFFSETS = { session: 20, week: 10 };

it("使用率がペース線(経過% − オフセット)以下なら throttled しない(経過80%・オフセット20 → 線60、使用率55は通る)", () => {
  const decision = evaluateThrottle(
    {
      session: { percent: 55, resetsAt: SESSION_RESETS },
      week: { percent: 30, resetsAt: WEEK_RESETS },
    },
    OFFSETS,
    PACE_NOW,
  );

  expect(decision).toEqual({
    throttled: false,
    resetsAt: null,
    windows: {
      session: { throttled: false, resumeAt: null },
      week: { throttled: false, resumeAt: null },
    },
  });
});

it("使用率がペース線を超えたら throttled、再開はリセットではなく catch-up 時刻(経過% = 使用率 + オフセット になる瞬間)", () => {
  const decision = evaluateThrottle(
    {
      // 70 > 80−20=60 で超過。catch-up は経過90%の瞬間 = 開始08:00 + 4.5h = 12:30
      session: { percent: 70, resetsAt: SESSION_RESETS },
      week: { percent: 30, resetsAt: WEEK_RESETS },
    },
    OFFSETS,
    PACE_NOW,
  );

  expect(decision).toEqual({
    throttled: true,
    resetsAt: new Date("2026-07-22T12:30:00.000Z"),
    windows: {
      session: { throttled: true, resumeAt: new Date("2026-07-22T12:30:00.000Z") },
      week: { throttled: false, resumeAt: null },
    },
  });
});

it("使用率がペース線ちょうどなら通す(strict 比較 — 線上は「ペースどおり」)", () => {
  const decision = evaluateThrottle(
    {
      session: { percent: 60, resetsAt: SESSION_RESETS },
      week: { percent: 30, resetsAt: WEEK_RESETS },
    },
    OFFSETS,
    PACE_NOW,
  );

  expect(decision.throttled).toBe(false);
});

it("複数線が同時に超過したら、再開見込みは catch-up 時刻の最大値(全部の線が解消するまで待つ)", () => {
  const decision = evaluateThrottle(
    {
      // session: catch-up 12:30(前テストと同じ)
      session: { percent: 70, resetsAt: SESSION_RESETS },
      // week: 85 > 71.4−10 で超過。catch-up は経過95%の瞬間 = Jul 17 12:00 + 6.65日 = Jul 24 03:36
      week: { percent: 85, resetsAt: WEEK_RESETS },
    },
    OFFSETS,
    PACE_NOW,
  );

  expect(decision.throttled).toBe(true);
  expect(decision.resetsAt).toEqual(new Date("2026-07-24T03:36:00.000Z"));
});

it("使用率 + オフセットが100%以上なら、ウィンドウ内に catch-up は来ない — 再開見込みはリセット時刻へクランプ", () => {
  const decision = evaluateThrottle(
    {
      // 85 + 20 = 105% — 経過がそこへ達する前にリセットが来る
      session: { percent: 85, resetsAt: SESSION_RESETS },
      week: { percent: 30, resetsAt: WEEK_RESETS },
    },
    OFFSETS,
    PACE_NOW,
  );

  expect(decision.resetsAt).toEqual(SESSION_RESETS);
  expect(decision.windows.session).toEqual({ throttled: true, resumeAt: SESSION_RESETS });
});

it("逆算の不整合(リセットがウィンドウ長より先 = 開始時刻が未来)はそのウィンドウを観測不能として fail-closed に落とす", () => {
  const decision = evaluateThrottle(
    {
      // resets が6時間先 — session ウィンドウは5時間なので開始が未来になり矛盾
      session: { percent: 5, resetsAt: new Date("2026-07-22T18:00:00.000Z") },
      week: { percent: 30, resetsAt: WEEK_RESETS },
    },
    OFFSETS,
    PACE_NOW,
  );

  expect(decision.throttled).toBe(true);
  expect(decision.resetsAt).toBeNull();
  expect(decision.windows.session).toBeNull();
});

it("パース不能(session/week とも観測不能)なら fail-closed で throttled、resetsAt は null(次回 hourly tick で再試行)", () => {
  const decision = evaluateThrottle({ session: null, week: null }, OFFSETS, PACE_NOW);

  expect(decision).toEqual({
    throttled: true,
    resetsAt: null,
    windows: { session: null, week: null },
  });
});

it("片方の窓だけ観測不能でも fail-closed で throttled(観測できた側がペース線以下でも)、観測できた側の内訳は残す", () => {
  const decision = evaluateThrottle(
    { session: { percent: 5, resetsAt: SESSION_RESETS }, week: null },
    OFFSETS,
    PACE_NOW,
  );

  expect(decision).toEqual({
    throttled: true,
    resetsAt: null,
    windows: { session: { throttled: false, resumeAt: null }, week: null },
  });
});
