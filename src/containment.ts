/** 封じ込め能力(CONTEXT.md: Containment capability)— このホストで worker の
 *  封じ込めが成立しているか、を答える**1つ**の検査。3種類の問いを束ねる:
 *
 *  1. **fs サンドボックスに入れるか**(ホストの能力。ADR 0033 / issue #60)—
 *     `checkSandboxCapability`(sandbox.ts)。
 *  2. **自分の人間面が無認証リクエストを拒むか**(組み上がった自分自身の配線。
 *     ADR 0036 / issue #154)— 自分の人間ポートへ実際に1回撃って 401 を見る。
 *  3. **ツール面が宣言どおりか**(ホストの CLI が盤面の宣言を honor しているか。
 *     ADR 0039 / issue #164)— `/usage` ping の init が返す `tools` を Tool
 *     allowlist と集合として突き合わせる(`probeToolSurfaceCapability`)。
 *     3つ目もホストと盤面自身の性質であって特定の workspace や agent の性質では
 *     ないため、既存2つと同格に束ねられる。
 *
 *  **この3つは1つのゲートに束ねる。** どれも「worker の封じ込めが成立している
 *  か」への答えなので、停止機構も question も1つでよい — 人間から見た結果
 *  (盤面全体の pickup が止まる)が同じなのに機構が分かれていると、「今どちらで
 *  止まっているのか」を読み解く仕事が増える(ADR 0036)。したがってここは
 *  ADR 0033 が作った器(quarantine + 確認型 question + 検証つき解除)をそのまま
 *  広げたものであり、新しい器ではない。
 *
 *  **ただし「盤面全体を止めるゲートは1本だけ」ではない。** ADR 0052 が
 *  レジストリ到達性(`registry-reachability.ts`)を兄弟として足した — 器は同じ
 *  形だが束ねてはいない。「4つ目の問いとして束ねる」案は明示的に却下されている:
 *  registry に届くかは worker の封じ込めではないので、束ねるとこの束の名前が
 *  事実でなくなる。CONTEXT.md の「資源単位の原則が適用できない資源」は、その
 *  結果1つの主張ではなく2つの列挙になっている。
 *
 *  2番目の検査が「token ファイルが読めた」ではないのが要点である。前者は自分の
 *  コードを信じるだけだが、後者は listen したリスナー・ミドルウェアの順序・
 *  credential の解決までを一度に測る。 */
import type { Db } from "./db.js";
import { CAPABILITY_PROBE_TIMEOUT_MS, type SandboxCapability } from "./sandbox.js";
import { BOARD_WORKER_ID, registerTask } from "./tasks.js";

/** 成立か、不成立ならその理由か。fs 半分(`SandboxCapability`)と同じ形を使う —
 *  「どの問いが成立していないか」は reason の文面が担うのであって、型では
 *  ない。停止機構が1つである以上、答えの型も1つでよい。 */
export type ContainmentCapability = SandboxCapability;

/** 封じ込め能力の検査。人間面の半分が実 HTTP を1往復するので非同期になる。 */
export type ContainmentCheck = () => Promise<ContainmentCapability>;

/** 自己検査が撃つ先: **認証があれば 200 を返すパス**(ADR 0036)。存在しない
 *  パスを撃つと、認証が丸ごと外れていても 404 が返って「200 ではないから無事」に
 *  見えてしまう。 */
export const HUMAN_SURFACE_PROBE_PATH = "/api/tasks";

/** 「まだ測っていない」を「測って無事」と読ませないための fail-closed の答え。
 *  listen 前(= 撃つ相手がまだ無い)にゲートが引かれたときだけここに落ちる。 */
const UNPROBED: ContainmentCapability = {
  available: false,
  reason:
    "the board's own human surface has not been probed yet — the listener was not up when the " +
    "containment check ran, so whether an unauthenticated request is refused is unknown",
};

/** 人間面の自己検査: 自分の人間ポートへ**無認証で1回**撃ち、401 が返ることを
 *  確かめる(ADR 0036)。
 *
 *  401 **だけ**を合格にする。「200 でなければ合格」にすると、404 や 500 —
 *  つまり穴が別のパスに移っただけ・盤面が壊れているだけの状態 — を通してしまう。
 *  接続できなかった場合も不成立とする: 測れなかったことは「無事」ではない。 */
export async function checkHumanSurfaceRefusesAnonymous(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ContainmentCapability> {
  let status: number;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      // credential を1つも提示しない — 測るのは「無認証で撃ったら断られるか」
      // 上限は fs 半分の probe と同じ1つの定数(sandbox.ts)。無制限の fetch は、
      // 詰まったときに poll ごと止めて「止まっている理由が出ないまま盤面が沈黙
      // する」という、fail-closed より悪い状態を作る。
      signal: AbortSignal.timeout(CAPABILITY_PROBE_TIMEOUT_MS),
    });
    // socket を返す(keep-alive のまま放置すると poll のたびに1本ずつ溜まる)
    await res.arrayBuffer();
    status = res.status;
  } catch (err) {
    return {
      available: false,
      reason:
        `the board could not probe its own human surface at ${url} (${String(err)}) — ` +
        "whether an unauthenticated request is refused is unknown, and unknown is not safe",
    };
  }
  if (status === 401) return { available: true };
  return {
    available: false,
    reason:
      `the board's own human surface answered an unauthenticated GET ${url} with ${status}, ` +
      "not 401 — the WebUI, /api and the management MCP mounted there are reachable by anything " +
      "that can reach this port, worker sessions included (ADR 0036). The usual cause is a " +
      "missing or unusable token hash: the board then fail-opens the human surface on purpose, " +
      "and this gate is the half that keeps it safe",
  };
}

/** **4つの問い**を1つの答えに束ねる。安い順に引く: worker 容器の機構前提は
 *  cgroupfs の読み書き数回(ADR 0099 決定5 — boot 時だけでなく pickup と回答時にも
 *  ここで読み直される)、fs 側は spawnSync 1回で listen にも依存しない、人間面は
 *  loopback を1往復、ツール面は実 CLI を1本起こす(~2s)。手前で答えが出ているなら
 *  後ろは撃たない。
 *  `humanSurface` が undefined を返すのは listen 前だけ(server.ts が listen 後に
 *  armed する)。
 *
 *  `toolSurface` は **`null` を明示して**初めて3つ目の問いを持たない盤面になる —
 *  実 CLI を持たないテスト盤面の形であり、ゲートそのものの有無と同じ扱いである
 *  (本番の合成 root は常に渡す)。省略可能にしないのは、この口が**塞ぐ側ではなく
 *  開く側**へ倒れるためである: 忘れれば検査が1つ黙って消える。「省略 = 無制限」
 *  という footgun は作らない(CONTEXT.md の Skill allowlist が同じ理由で省略を
 *  不正にしているのと同じ線)。人間面の `undefined` はこれとは別物で、listen 前
 *  という**一過性**の状態なので fail-closed(`UNPROBED`)に倒れる。 */
export function composeContainment(
  containerRuntime: () => SandboxCapability,
  sandbox: () => SandboxCapability,
  humanSurface: () => Promise<ContainmentCapability> | undefined,
  toolSurface: (() => Promise<ContainmentCapability>) | null,
): ContainmentCheck {
  return async () => {
    const container = containerRuntime();
    if (!container.available) return container;
    const filesystem = sandbox();
    if (!filesystem.available) return filesystem;
    const human = (await humanSurface()) ?? UNPROBED;
    if (!human.available) return human;
    return toolSurface === null ? { available: true } : await toolSurface();
  };
}

/** ADR 0033 の fail-closed stop を issue #154 が広げたもの。quarantineWorkspace /
 *  quarantineAgent の host-wide 版で、封じ込めが成立しないホストは盤面全体の
 *  pickup を止め(封じ込めはホストと盤面自身の性質なので、止められるより狭い
 *  資源が存在しない)、Tidepool 名義の確認型 question を1枚立てる。 */
export function quarantineContainment(db: Db, reason: string, now: Date): void {
  // 呼び出し側のゲートも先に見ているが、await を挟む非同期の検査になった以上、
  // 2つの poll が同時にすり抜ける窓が原理的に開く。1資源につき確認は最大1枚
  // (CONTEXT.md)なので、登録の直前でもう一度見る。
  if (openContainmentQuestion(db)) return;
  const title = "worker containment is not established — pickup is stopped";
  registerTask(
    db,
    {
      type: "question",
      title,
      purpose:
        `${reason}. ` +
        "No agent task is picked up while this stands: a worker that believes it is contained " +
        "but is not is worse than no containment at all, so the board refuses to run one bare " +
        "(ADR 0033 / ADR 0036). Repair the host, then answer — the board re-runs the capability " +
        "check before it accepts the answer, and any answer text is kept as a repair note. " +
        "If the human surface is the broken half, run `npm run token` on the board and open the " +
        "bootstrap URL it prints on this device *before* answering: rotating the token kills the " +
        "cookie you are reading this with.",
      completion_criteria: "the host's worker containment is repaired by hand",
      question: [{ title, options: ["repaired by hand"], recommendation: "repaired by hand" }],
      quarantine_sandbox: true,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
}

/** 立っている封じ込めの確認 question。その存在がゲートの半分である: workspace の
 *  quarantine と同じく、直っただけでは pickup は再開せず、人間の確認回答だけが
 *  唯一の門になる — 一過性の破れが誰も見ないまま盤面を黙って再開させない。
 *
 *  列名 `question_quarantine_sandbox` は ADR 0033 当時のもので、検査が
 *  「サンドボックスに入れるか」から「封じ込めが成立しているか」に広がった今も
 *  そのまま使う(問いが広がっただけで、止まる資源も question も1つのまま)。 */
export function openContainmentQuestion(db: Db): { id: string } | undefined {
  return db
    .prepare(
      `SELECT id FROM tasks WHERE question_quarantine_sandbox IS NOT NULL AND status = 'todo'`,
    )
    .get() as { id: string } | undefined;
}

/** pickup ゲート: worker を1枚も spawn してよくない間 true。検査が初めて落ちた
 *  ときにだけ確認 question を登録する(立っている question が手前で短絡する)。
 *
 *  **pickup ゲートは fail-closed、人間面は fail-open**(auth.ts)。この非対称は
 *  ADR 0036 の意図であって取りこぼしではない — 「統一」しないこと。 */
export async function containmentPickupBlocked(
  db: Db,
  capability: ContainmentCheck,
  now: Date,
): Promise<boolean> {
  if (openContainmentQuestion(db)) return true;
  const result = await capability();
  if (result.available) return false;
  quarantineContainment(db, result.reason, now);
  return true;
}
