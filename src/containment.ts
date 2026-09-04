/** 封じ込め能力(CONTEXT.md: Containment capability)の共通部分。このホストで
 *  worker の封じ込めが成立しているかを答える2種類の問いを束ねる:
 *
 *  1. **worker 容器の機構前提が成立するか**(ADR 0099)。
 *  2. **自分の人間面が無認証リクエストを拒むか**(組み上がった自分自身の配線。
 *     ADR 0036 / issue #154)— 自分の人間ポートへ実際に1回撃って 401 を見る。
 *
 *  Harness ごとの fs sandbox と tool surface は各 adapter が
 *  `HarnessContainmentCheck` として証明する。この共通検査を各 adapter の答えに
 *  前置した4問の結果が Harness quarantine に落ちるため、共通部分の不成立は全
 *  Harness が同じ原因で止まる集積であって、別の盤面全体停止ではない。
 *
 *  2番目の検査が「token ファイルが読めた」ではないのが要点である。前者は自分の
 *  コードを信じるだけだが、後者は listen したリスナー・ミドルウェアの順序・
 *  credential の解決までを一度に測る。 */
import type { Db } from "./db.js";
import { CAPABILITY_PROBE_TIMEOUT_MS, type SandboxCapability } from "./sandbox.js";
import { BOARD_WORKER_ID, registerTask } from "./tasks.js";

/** 成立か、不成立ならその理由か。fs 検査(`SandboxCapability`)と同じ形を使う —
 *  「どの問いが成立していないか」は reason の文面が担うのであって、型では
 *  ない。 */
export type ContainmentCapability = SandboxCapability;

/** 封じ込め能力の検査。人間面や CLI probe が非同期なので Promise を返す。 */
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

/** Harnesses share the container runtime and the Board's human surface, while
 * each adapter proves its own sandbox and tool surface. This result is
 * prepended to each Harness check; it does not create a separate board-wide
 * stop (CONTEXT.md: Containment capability). */
export function composeCommonContainment(
  containerRuntime: () => SandboxCapability,
  humanSurface: () => Promise<ContainmentCapability> | undefined,
): ContainmentCheck {
  return async () => {
    const container = containerRuntime();
    if (!container.available) return container;
    return (await humanSurface()) ?? UNPROBED;
  };
}

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
