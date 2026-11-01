import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stderrTail } from "./child-stream.js";
import { claudeExitFields, claudeStreamObservation, observeClaudeLine } from "./claude-stream-reader.js";
import { codexExitFields, codexStreamObservation, observeCodexLine, parseJsonl } from "./codex-stream-reader.js";
import type { Db } from "./db.js";
import { appendEvent, type EventPayload, listEventsOfKinds, SESSION_WINDOW_KINDS, sessionWindow } from "./events.js";
import { hasEpisodeOfAnyVersion, projectAndPersist } from "./precedent.js";
import type { Harness } from "./registry.js";
import { parseStreamLine } from "./stream-json.js";
import { isBoardDbRefusal } from "./unhandled-rejection-floor.js";

/** session の一時領域の名前の頭(ADR 0257 決定2)。adapter の mkdtemp と起動時の復旧の削除が共有する(ADR 0315 決定5)。 */
export const taskTempPrefix = (harness: "claude" | "codex", taskId: string) => `tidepool-${harness}-${taskId}-`;

/** session を閉じる1本(ADR 0315 決定1): exit の記録 → 一時領域の削除 → 投影、この順で。exit は投影より先 ——
 *  投影は `worker_exited_event_id` を写し、同じ版では作り直せない。adapter の終了処理と起動時の復旧が呼ぶ。 */
export function closeSession(
  db: Db,
  exit: { taskId: string; actorId: string; at: Date; payload: Extract<EventPayload, { kind: "worker_exited" }> },
  removeTaskTemp: () => void,
  project: () => void,
): void {
  appendEvent(db, { taskId: exit.taskId, actorId: exit.actorId, origin: "board", payload: exit.payload, at: exit.at });
  removeTaskTemp();
  project();
}

/** 前の盤面が閉じ切らなかった session を閉じる起動時の復旧(ADR 0315 決定1〜5)。対象は `watermark`(起動時点の最大 event id)
 *  以下の spawn だけ —— 受理の門から走るとき、走行中の別の盤面の session に偽の exit を書かない。1件の失敗は記録して流す
 *  —— 盤面 DB の拒否だけは投げて起動を拒む(ADR 0342 決定4)。 */
export function closeUnclosedSessions(db: Db, opts: { logDir: string; tmpDir: string; watermark: number; now: Date }): void {
  const events = listEventsOfKinds(db, SESSION_WINDOW_KINDS);
  for (const spawned of events) {
    if (spawned.payload.kind !== "worker_spawned" || spawned.id > opts.watermark || spawned.task_id === null) continue;
    // shortcut: spawn ごとに盤面全体の event を舐める O(n²)、transcript も読み手と投影器で2度読む。起動が遅くなったら task ごとに分けて渡し、読みを1度にする
    const window = sessionWindow(events, spawned);
    // process を1つも持たなかった session は閉じない —— exit も Episode も一時領域の削除も無い(ADR 0316 決定4 / #2633)
    if (window.neverRan) continue;
    const taskId = spawned.task_id;
    const base = join(opts.logDir, `${taskId}.${spawned.id}`);
    const transcriptPath = `${base}.stream.jsonl`;
    // transcript が無い session は投影できない —— 試みず記録もしない。exit があっても起動のたびに報告し続けない(ADR 0316 決定2)
    const transcript = existsSync(transcriptPath);
    const project = () => {
      if (transcript && !hasEpisodeOfAnyVersion(db, spawned.id)) projectAndPersist(db, { workerSpawnedEventId: spawned.id, transcriptPath });
    };
    try {
      // 後の spawn があれば窓は既に閉じている —— exit を書くと次の session に重なり、一時領域は後の session のもの
      if (window.exited || window.hasNextSpawn) {
        project();
        continue;
      }
      closeSession(
        db,
        {
          taskId,
          actorId: spawned.actor_id,
          at: opts.now,
          payload: {
            kind: "worker_exited",
            exit_observed: false,
            exit_code: null,
            signal: null,
            stderr_tail: readStderrTail(`${base}.stderr.log`),
            ...streamExitFields(spawned.payload.harness, transcriptPath),
            worker_spawned_event_id: spawned.id,
            output_closed: false,
          },
        },
        () => removeTaskTemps(opts.tmpDir, taskId),
        project,
      );
    } catch (err) {
      // ADR 0342 決定4: 盤面 DB の拒否は飲まない —— 投げて起動を拒む(壊れた器の上で盤面を半分だけ動かさない)
      if (isBoardDbRefusal(err)) throw err;
      // transcript が読めない = 記録の dir が後から壊れた印(ADR 0314 決定2)。起動は落とさない
      console.error(`[recovery] could not close session ${spawned.id} of task ${taskId}:`, err);
    }
  }
}

/** live の adapter と同じ読み手に transcript の行を食わせる(ADR 0316 決定1)。読み手は投影器と同じく `worker_spawned.harness` で選ぶ。
 *  末尾の改行の無い行も1行として読む(live の flush と同じ)。無い・読めない transcript は欄を欠測にする —— 閉じる事実は変わらない(決定2)。 */
function streamExitFields(harness: Harness, path: string) {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    lines = [];
  }
  if (harness === "codex") {
    const observed = codexStreamObservation();
    for (const line of lines) observeCodexLine(observed, parseJsonl(line));
    return codexExitFields(observed);
  }
  const observed = claudeStreamObservation();
  for (const line of lines) observeClaudeLine(observed, parseStreamLine(line));
  return claudeExitFields(observed);
}

function readStderrTail(path: string): string | null {
  try {
    return stderrTail(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function removeTaskTemps(tmpDir: string, taskId: string): void {
  const prefixes = [taskTempPrefix("claude", taskId), taskTempPrefix("codex", taskId)];
  for (const name of readdirSync(tmpDir)) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    try {
      rmSync(join(tmpDir, name), { recursive: true, force: true });
    } catch (error) {
      console.error(`[recovery] could not remove ${join(tmpDir, name)}:`, error);
    }
  }
}
