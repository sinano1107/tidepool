import xtermHeadless from "@xterm/headless";
import { offsetMinutesEastOfUtc } from "./tz.js";

const { Terminal } = xtermHeadless;

/** Applies a raw PTY capture to a terminal of the same dimensions and returns
 *  the composed screen text (ADR 0074). `write` is asynchronous: reading the
 *  buffer before its callback would race the terminal parser. */
export async function composeTerminalScreen(capture: string, cols: number, rows: number): Promise<string> {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => terminal.write(capture, resolve));
    return Array.from(
      { length: terminal.buffer.active.length },
      (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? "",
    ).join("\n");
  } finally {
    terminal.dispose();
  }
}

/** A single window's utilization as observed via the interactive TUI's
 *  `/usage` panel (ADR 0028). `resetsAt` is always a full instant: session
 *  renders a dateless wall-clock time ("Resets 1:30pm") rounded to the
 *  soonest future occurrence, week renders a no-year date ("Resets Jul 23 at
 *  1pm") rounded the same way — `now` disambiguates both. Either line may
 *  omit its parenthesized tz, in which case the host machine's local zone is
 *  assumed (see resolveTz). */
export interface UsageWindowSnapshot {
  percent: number;
  resetsAt: Date;
}

export type ObservedUsageWindow = UsageWindowSnapshot | "idle";

export interface UsageSnapshot {
  session: ObservedUsageWindow | null;
  week: ObservedUsageWindow | null;
  /** fable の週次 per-model 行 (ADR 0030)。null は「行なし or 読めない」—
   *  session/week が健全なら「個別制限のないプラン」(Pro)と読み、fail-closed
   *  にはしない。書式変更で誤って null に化ける残リスクは全体線と100%キャップ
   *  が被害上限を抑え、UI の観測状態表示で人間が気づける(ADR 0030)。 */
  fable: ObservedUsageWindow | null;
}

// PTY capture of the interactive TUI's /usage panel (ADR 0028) — replaces the
// headless `-p /usage` text this module parsed before the CLI dropped
// percent/reset data from that path (issue #79). Cursor-positioning escapes
// (`\x1bG`, `\x1bC` …) leave no character behind once stripped, so tokens
// that were column-separated in the terminal render joined ("70%used").
const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

const SESSION_LABEL = "Current session";
const WEEK_LABEL = "Current week (all models)";
// 実機 PTY キャプチャで確定したラベル(issue #126、2026-07-22、claude 2.1.217)。
// per-model 行として (all models) の後に現れ、書式は week と同形。
const FABLE_LABEL = "Current week (Fable)";

const PERCENT_USED_PATTERN = /(\d+)%\s*used/;

// Session resets carry no date ("Resets 1:30pm (Asia/Tokyo)") — only week
// does ("Resets Jul 23 at 1pm (Asia/Tokyo)"), confirmed against real PTY
// captures (ADR 0028). The tz group is optional — issue #80's own
// illustrative sample renders both lines without one ("Resets 1:30pm") — see
// resolveTz for the fallback.
const SESSION_RESETS_PATTERN = /Resets\s+(?<hour>\d{1,2})(?::(?<minute>\d{2}))?(?<meridiem>am|pm)(?:\s*\((?<tz>[^)]+)\))?/;
const WEEK_RESETS_PATTERN =
  /Resets\s+(?<month>\w+)\s+(?<day>\d+)(?:\s+at\s+|,\s*)(?<hour>\d{1,2})(?::(?<minute>\d{2}))?(?<meridiem>am|pm)(?:\s*\((?<tz>[^)]+)\))?/;

/** The reset half of a parsed `/usage` line — the month/day/hour/minute/tz
 *  fields that only ever travel together, bundled so parseResetsAt takes one
 *  value instead of a clump of loose strings. */
interface ParsedResetTime {
  month: string;
  day: number;
  hour: number;
  minute: number;
  tz: string;
}

/** Session resets are a strict subset of ParsedResetTime — no month/day,
 *  just the wall-clock time and its zone. */
type ParsedTimeOfDay = Pick<ParsedResetTime, "hour" | "minute" | "tz">;

function to24Hour(hour12: number, meridiem: "am" | "pm"): number {
  if (meridiem === "am") return hour12 === 12 ? 0 : hour12;
  return hour12 === 12 ? 12 : hour12 + 12;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** No tz in the source line — issue #80's own "実測済み" sample renders
 *  `Resets 1:30pm` with nothing in parens at all, and a future TUI render
 *  could drop it entirely. Falling back to null (unobservable) would revive
 *  the permanent fail-closed #79 exists to fix, so this assumes the host
 *  machine's own zone: the panel is rendered by a CLI running on this same
 *  machine, so an unlabeled reset time is a local wall-clock time by
 *  construction. */
function resolveTz(rawTz: string | undefined): string {
  return rawTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Builds the UTC instant for `time` on the given (year, month 1-based, day)
 *  in `time.tz`, then rounds forward via `advance` if that instant has
 *  already passed relative to `now`. The shared "resolve to the soonest
 *  future occurrence of whatever date is given" rule both session (day-less
 *  — `advance` bumps the day) and week (year-less — `advance` bumps the
 *  year) resets follow; `Date.UTC` normalizes an out-of-range day/month from
 *  `advance` on its own. */
function roundToFutureUtc(
  now: Date,
  time: ParsedTimeOfDay,
  base: { year: number; month: number; day: number },
  advance: (base: { year: number; month: number; day: number }) => { year: number; month: number; day: number },
): Date {
  const offsetMinutes = offsetMinutesEastOfUtc(time.tz, now);
  const asUtcMinutes = time.hour * 60 + time.minute - offsetMinutes;
  const candidate = new Date(Date.UTC(base.year, base.month - 1, base.day, 0, asUtcMinutes));
  if (candidate.getTime() > now.getTime()) return candidate;
  const next = advance(base);
  return new Date(Date.UTC(next.year, next.month - 1, next.day, 0, asUtcMinutes));
}

/** No year in the source text (issue #22 grill) — always rounds to the
 *  soonest future occurrence of month/day relative to `now`, so a Dec→Jan
 *  reset correctly lands in the following year. */
function parseResetsAt(reset: ParsedResetTime, now: Date): Date {
  const monthIndex = MONTHS.indexOf(reset.month);
  return roundToFutureUtc(
    now,
    reset,
    { year: now.getUTCFullYear(), month: monthIndex + 1, day: reset.day },
    (base) => ({ ...base, year: base.year + 1 }),
  );
}

/** The session window's Resets line carries no date — just a wall-clock time
 *  in `time.tz` — so "today" must be read out of `now` via `time.tz`, not
 *  UTC, before rounding to the soonest future occurrence (ADR 0028). */
function parseSessionResetsAt(time: ParsedTimeOfDay, now: Date): Date {
  const todayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: time.tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(todayParts.find((p) => p.type === "year")!.value);
  const month = Number(todayParts.find((p) => p.type === "month")!.value);
  const day = Number(todayParts.find((p) => p.type === "day")!.value);
  return roundToFutureUtc(now, time, { year, month, day }, (base) => ({ ...base, day: base.day + 1 }));
}

// ADR 0030: ウィンドウ長は Anthropic のプロダクト事実でありハードコード定数。
// 仕様が変われば /usage 書式変更と同類のスクレイパー破損イベントとして直す。
export const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
export const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** ADR 0030: 人間の取り分の予約(pt)。盤面がペースからこの分だけ遅れて
 *  走ることで、空いた分が人間の対話利用に残る。 */
export interface PaceOffsets {
  session: number;
  week: number;
  fable: number;
}

/** 一つのウィンドウのペース判定。resumeAt は catch-up 時刻(経過割合 =
 *  使用率 + オフセット になる瞬間)— リセット時刻ではない(ADR 0030)。 */
export interface WindowDecision {
  throttled: boolean;
  resumeAt: Date | null;
}

export interface ThrottleDecision {
  throttled: boolean;
  /** 再開見込み時刻(超過した線の catch-up の最大値)。fail-closed 時は null。 */
  resetsAt: Date | null;
  /** ウィンドウ別の内訳(UI 表示用)。session/week の null はそのウィンドウが
   *  観測不能(パース失敗または逆算の不整合)であること。fable の null は
   *  「個別制限の観測なし」(行なし = Pro プラン、または読めない行)であり、
   *  fail-closed の入力ではない(ADR 0030)。 */
  windows: {
    session: WindowDecision | null;
    week: WindowDecision | null;
    fable: WindowDecision | null;
  };
}

/** Spend-down (ADR 0030 / issue #128): 終盤に残り予算を盤面で使い切る人間専用の
 *  盤面状態。対象ウィンドウのペース線だけを外して100%ハードキャップへ切り替える。 */
export interface SpendDownState {
  window: "session" | "week";
  activatedAt: Date;
}

/** ADR 0030: throttled ⟺ 使用率% > 経過時間割合% − オフセット(pt)(strict)。
 *  経過割合は「リセット時刻 − ウィンドウ長」で逆算した開始時刻から出す。
 *  now が逆算した開始より前(不整合)は観測不能と同じ fail-closed に落とす。 */
function evaluateWindow(
  w: UsageWindowSnapshot,
  windowMs: number,
  offsetPt: number,
  now: Date,
): WindowDecision | null {
  const startMs = w.resetsAt.getTime() - windowMs;
  if (now.getTime() < startMs) return null;
  const elapsedPct = ((now.getTime() - startMs) / windowMs) * 100;
  if (!(w.percent > elapsedPct - offsetPt)) return { throttled: false, resumeAt: null };
  // 使用率 + オフセットが100%以上だと catch-up はウィンドウ内に来ない —
  // その場合はリセット自体が再開の瞬間
  const catchUpMs = Math.min(
    startMs + ((w.percent + offsetPt) / 100) * windowMs,
    w.resetsAt.getTime(),
  );
  return { throttled: true, resumeAt: new Date(catchUpMs) };
}

/** Spend-down 中の対象ウィンドウの判定: ペース線の代わりに100%ハードキャップ
 *  (全ウィンドウ常時有効の唯一の上限)だけを見る。キャップ到達の再開見込みは
 *  リセット時刻そのもの — catch-up は存在しない(ADR 0030)。 */
function evaluateCappedWindow(w: UsageWindowSnapshot, windowMs: number, now: Date): WindowDecision | null {
  const startMs = w.resetsAt.getTime() - windowMs;
  if (now.getTime() < startMs) return null;
  if (w.percent < 100) return { throttled: false, resumeAt: null };
  return { throttled: true, resumeAt: w.resetsAt };
}

/** Spend-down が対象ウィンドウのリセットで自動失効したか: 有効化時刻が観測
 *  された現ウィンドウの開始より前なら、有効化されたウィンドウはもうリセット
 *  済み。対象が観測不能なら判定できず失効させない(fail-closed 側は
 *  evaluateThrottle 本体が受ける)。evaluateThrottle 自身の無視と scheduler の
 *  状態クリアが同じ述語を共有する。 */
export function isSpendDownExpired(spendDown: SpendDownState, snapshot: UsageSnapshot): boolean {
  const target = spendDown.window === "session" ? snapshot.session : snapshot.week;
  if (!target) return false;
  if (target === "idle") return true;
  const windowMs = spendDown.window === "session" ? SESSION_WINDOW_MS : WEEK_WINDOW_MS;
  return spendDown.activatedAt.getTime() < target.resetsAt.getTime() - windowMs;
}

/** ADR 0030: session / week のどちらかがペース線を超えていれば盤面全体の新規
 *  pickup を絞る。fable 線は盤面を止めない — fable モデルのタスクだけを絞る
 *  資源単位の線で、windows.fable として運ばれ scheduler がタスク単位に適用する。
 *  実行中のタスクには決して触れない。spendDown(失効済みは無視)は対象
 *  ウィンドウの判定を evaluateCappedWindow に差し替える。 */
export function evaluateThrottle(
  snapshot: UsageSnapshot,
  offsets: PaceOffsets,
  now: Date,
  spendDown?: SpendDownState | null,
): ThrottleDecision {
  const active = spendDown && !isSpendDownExpired(spendDown, snapshot) ? spendDown : null;
  const session =
    snapshot.session === "idle"
      ? { throttled: false, resumeAt: null }
      : snapshot.session &&
        (active?.window === "session"
          ? evaluateCappedWindow(snapshot.session, SESSION_WINDOW_MS, now)
          : evaluateWindow(snapshot.session, SESSION_WINDOW_MS, offsets.session, now));
  // spend-down(week) は fable の線も一緒に外す — 同じ瞬間に失効する予算(ADR 0030)
  const week =
    snapshot.week === "idle"
      ? { throttled: false, resumeAt: null }
      : snapshot.week &&
        (active?.window === "week"
          ? evaluateCappedWindow(snapshot.week, WEEK_WINDOW_MS, now)
          : evaluateWindow(snapshot.week, WEEK_WINDOW_MS, offsets.week, now));
  // fable の逆算不整合も null(観測なし)へ倒す: fail-closed は session/week の
  // 意味論で、fable でそれをやると Pro プラン運用時に恒久 skip を製造する側に
  // 倒れかねない。誤読の被害は全体線と100%キャップが上限を抑える(ADR 0030)。
  const fable =
    snapshot.fable === "idle"
      ? { throttled: false, resumeAt: null }
      : snapshot.fable &&
        (active?.window === "week"
          ? evaluateCappedWindow(snapshot.fable, WEEK_WINDOW_MS, now)
          : evaluateWindow(snapshot.fable, WEEK_WINDOW_MS, offsets.fable, now));
  const windows = { session: session ?? null, week: week ?? null, fable: fable ?? null };
  // fail-closed: either window unobserved means the decision can't be trusted,
  // even if the other window looks fine (issue #22: "観測不能なとき...は
  // fail-closed で skip する")
  if (!session || !week) return { throttled: true, resetsAt: null, windows };
  const violated = [session, week].filter((w) => w.throttled);
  if (violated.length === 0) return { throttled: false, resetsAt: null, windows };
  const resumeAt = violated.reduce(
    (latest, w) => (w.resumeAt! > latest ? w.resumeAt! : latest),
    violated[0]!.resumeAt!,
  );
  return { throttled: true, resetsAt: resumeAt, windows };
}

/** The text between `label` and the next occurrence of `until` (or end of
 *  string if `until` is null/absent) — scopes percent/resets matching to one
 *  window so week's numbers can't be picked up while parsing session, and
 *  vice versa. Returns null if `label` itself isn't present. */
function extractBlock(text: string, label: string, until: string | null): string | null {
  const labelIndex = text.indexOf(label);
  if (labelIndex === -1) return null;
  const start = labelIndex + label.length;
  const untilIndex = until === null ? -1 : text.indexOf(until, start);
  return text.slice(start, untilIndex === -1 ? undefined : untilIndex);
}

function parseSessionWindow(block: string, now: Date): ObservedUsageWindow | null {
  const percent = PERCENT_USED_PATTERN.exec(block);
  const resets = SESSION_RESETS_PATTERN.exec(block)?.groups;
  if (!percent) return null;
  if (!resets) return Number(percent[1]) === 0 ? "idle" : null;
  return {
    percent: Number(percent[1]),
    resetsAt: parseSessionResetsAt(
      {
        hour: to24Hour(Number(resets.hour), resets.meridiem as "am" | "pm"),
        minute: resets.minute === undefined ? 0 : Number(resets.minute),
        tz: resolveTz(resets.tz),
      },
      now,
    ),
  };
}

function parseWeekWindow(block: string, now: Date): ObservedUsageWindow | null {
  const percent = PERCENT_USED_PATTERN.exec(block);
  const resets = WEEK_RESETS_PATTERN.exec(block)?.groups;
  if (!percent) return null;
  if (!resets) return Number(percent[1]) === 0 ? "idle" : null;
  return {
    percent: Number(percent[1]),
    resetsAt: parseResetsAt(
      {
        month: resets.month!,
        day: Number(resets.day),
        hour: to24Hour(Number(resets.hour), resets.meridiem as "am" | "pm"),
        minute: resets.minute === undefined ? 0 : Number(resets.minute),
        tz: resolveTz(resets.tz),
      },
      now,
    ),
  };
}

/** Parses the composed screen text of the interactive TUI's `/usage` panel
 *  (ADR 0074). ANSI stripping remains as defensive tolerance for direct
 *  callers. Only the all-models week line is read: `weekBlock` runs from the
 *  "(all models)" label to end-of-string, but `.exec()` takes the first
 *  percent/resets match in it, which is that label's own — any per-model
 *  breakdown rows further down are never reached. */
export function parseUsage(resultText: string, now: Date): UsageSnapshot {
  const stripped = resultText.replace(ANSI_PATTERN, "").replace(/\r/g, "\n");
  const sessionBlock = extractBlock(stripped, SESSION_LABEL, WEEK_LABEL);
  const weekBlock = extractBlock(stripped, WEEK_LABEL, null);
  // fable は per-model 行 (ADR 0030): 書式は week と同形。行が無い(Pro プラン)
  // 場合は null — session/week と違い fail-closed の入力ではない。
  const fableBlock = extractBlock(stripped, FABLE_LABEL, null);
  return {
    session: sessionBlock === null ? null : parseSessionWindow(sessionBlock, now),
    week: weekBlock === null ? null : parseWeekWindow(weekBlock, now),
    fable: fableBlock === null ? null : parseWeekWindow(fableBlock, now),
  };
}
