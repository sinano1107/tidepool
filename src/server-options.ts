import type { ServerOptions } from "./server.js";
import type { WatchdogConfig } from "./watchdog.js";

/** 盤面の watchdog(#9 / CONTEXT.md の Watchdog)を本番で成立させる時間リミット。
 *  **コード定数であってホストごとの設定ではない** — ADR 0037 と同じ軸で、盤面の
 *  不変条件(唯一の slot が誰にも回収されずに握られたままにならない)を
 *  `/etc/default/tidepool` の綴りに委ねない。
 *
 *  すべての値は分単位に量子化される: WATCHDOG_TICK が 60秒なので、それ未満の差は
 *  1 tick に丸められる。
 *
 *  - `work` = 90分。`/etc/default/tidepool` の `CLAUDE_STREAM_IDLE_TIMEOUT_MS` が
 *    10分(#33 / anthropics/claude-code#69238 の回避)なので、byte-idle 由来の
 *    ストールは CLI 側が拾う。拾えないのはループに入ったセッション —— バイトを
 *    出し続けるので idle 検知が効かず、watchdog だけが backstop になる。kill は
 *    失敗 question(retry / abandon)+ push に落ちる回復可能な事象なので、夜の
 *    8時間のうち最大90分の損失に抑える側へ倒す。
 *  - `review` = 45分。読んで判断する仕事で、work のような長い実装ループを持たない。
 *  - `question` は**意図的に無い**。`Partial<Record<TaskType, number>>` の口は
 *    「キーを書かない = 監視しない」で、人間の回答を待つタスクを時限で殺すのは
 *    端的に誤りである(そもそも question は slot の外で回答される)。
 *  - `grace` = 60秒 = 1 tick。SIGTERM から SIGKILL までの猶予で、watchdog.ts の
 *    比較は `>=` なので次の tick で SIGKILL が出る。 */
export const WATCHDOG: WatchdogConfig = {
  timeLimits: { work: 90 * 60_000, review: 45 * 60_000 },
  grace: 60_000,
};

/** ServerOptions のうち、合成 root が**意図的に渡さない**もの。
 *
 *  `authority`(issue #11 の盤面固定 1本)は ADR 0012 / issue #36 の
 *  `resolveAuthority` に置換済みで、両方渡せば後者が前者を覆う(server.ts の
 *  doc コメント)。ここに1行足すことは「この口は本番で永久に立たない」と
 *  宣言することであり、#172 と同じ穴を型で開け直す行為でもある —
 *  tests/server-options.test.ts がこの一覧の伸長を見張る。 */
type IntentionallyAbsent = "authority";

/** 合成 root(main.ts)が startServer へ渡す部品一式。**ServerOptions の任意性を
 *  ここで必須へ反転させる**のが目的の型で、口が1つ増えたら main.ts がコンパイル
 *  エラーで落ちる — #172 は「型が任意で、テスト盤面だけが渡していた」ために
 *  誰にも気づかれなかった。値が undefined でありうる口は `| undefined` のまま
 *  必須にしてあるので、「無い」を選ぶにも明示的に書く必要がある。
 *
 *  `watchdog` だけは部品ではなく上の定数なので除く。 */
export type ServerOptionParts = {
  [K in Exclude<keyof ServerOptions, IntentionallyAbsent | "watchdog">]: ServerOptions[K];
};

/** 盤面のオプション組み立て。main.ts は top-level await のスクリプトで、import
 *  すると盤面そのものが起動してしまう — 組み立てをここへ出しておくことで、
 *  「本番がどの口を配線しているか」がテストから観測できる seam になる
 *  (ADR 0027 の server 境界より**上**の話なので、あの線には触れない)。 */
export function buildServerOptions(parts: ServerOptionParts): ServerOptions {
  return { ...parts, watchdog: WATCHDOG };
}
