import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stderrTail } from "./child-stream.js";
import type { Db } from "./db.js";
import { appendEvent, type EventPayload, listEventsOfKinds, NEVER_RAN_KINDS, sessionWindow } from "./events.js";
import { hasEpisodeOfAnyVersion, projectAndPersist } from "./precedent.js";

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
 *  以下の spawn だけ —— 受理の門から走るとき、走行中の別の盤面の session に偽の exit を書かない。1件の失敗は記録して流す。 */
export function closeUnclosedSessions(db: Db, opts: { logDir: string; tmpDir: string; watermark: number; now: Date }): void {
  const events = listEventsOfKinds(db, ["worker_spawned", "worker_exited", ...NEVER_RAN_KINDS]);
  for (const spawned of events) {
    if (spawned.payload.kind !== "worker_spawned" || spawned.id > opts.watermark || spawned.task_id === null) continue;
    // ponytail: spawn ごとに盤面全体の event を舐める O(n²)。起動が遅くなったら task ごとに分けて渡す
    const window = sessionWindow(events, spawned);
    // process を1つも持たなかった session は閉じない —— exit も Episode も一時領域の削除も無い(ADR 0316 決定4 / #2633)
    if (window.neverRan) continue;
    const taskId = spawned.task_id;
    const base = join(opts.logDir, `${taskId}.${spawned.id}`);
    const project = () => {
      if (!hasEpisodeOfAnyVersion(db, spawned.id)) projectAndPersist(db, { workerSpawnedEventId: spawned.id, transcriptPath: `${base}.stream.jsonl` });
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
            reported_error: null,
            last_message: null,
            worker_spawned_event_id: spawned.id,
            output_closed: false,
            usage: null,
          },
        },
        () => removeTaskTemps(opts.tmpDir, taskId),
        project,
      );
    } catch (err) {
      // transcript が無い・読めない = 記録の dir が後から失われた印(ADR 0314 決定2)。起動は落とさない
      console.error(`[recovery] could not close session ${spawned.id} of task ${taskId}:`, err);
    }
  }
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
