import { randomUUID } from "node:crypto";
import { closeSync, createWriteStream, openSync, rmSync, type WriteStream, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 盤面の記録の器(worker transcript と受験者の答案の写しを置く dir)への書き込みが fs の例外で落ちた(ADR 0266 決定3)。
 *  どの task の・どの path への書き込みが・どの例外で落ちたかを運ぶ —— 原因の所在は断言しない。 */
export class RecordContainerError extends Error {
  constructor(
    readonly taskId: string,
    readonly path: string,
    readonly reason: string,
  ) {
    super(`the board's record container could not be written for task ${taskId} at ${path}: ${reason}`);
  }
}

/** 記録の器の停止の解放の門(ADR 0266 決定3): 同じ dir へ一時ファイルを書いて消す。先行の検査は無く、書けるかは書いてみて知る。
 *  書けなければ fs の例外をそのまま投げる。 */
export function probeRecordContainer(dir: string): void {
  const probe = join(dir, `.write-check-${randomUUID()}`);
  writeFileSync(probe, "");
  rmSync(probe);
}

/** 走ってから書けなくなった transcript の観測(ADR 0149 決定4)。 */
export interface TranscriptFailure {
  taskId: string;
  workerSpawnedEventId: number;
  error_code: string | null;
  message: string;
  file: "stream" | "stderr";
}

/** 開いた session の transcript。`stream` の path は fd から作った stream が持たないので別に運ぶ。 */
export interface Transcript {
  streamPath: string;
  stream: WriteStream;
  stderr: WriteStream;
}

/** worker session ごとの transcript(CONTEXT.md「Transcript」—— stream と stderr の2本で
 *  1単位)を開く盤面側の器(ADR 0149 決定5)。容器(`ProcessContainers`)と同じ立て付けで、
 *  失敗方針はここ1箇所に住み、adapter は開いた2本へ pipe するだけである。順序は
 *  データ依存で固定される —— open は `worker_spawned` の event id を要り、spawn は
 *  open が返した2本へ pipe する。
 *  dir は作らない —— 無ければ過去の transcript が失われた事実ごと表に出す(決定2)。 */
export class TranscriptStore {
  /** 走ってから書けなくなった観測の盤面側の一撃。盤面(`startServer`)が差し込む。 */
  onFailed: (failure: TranscriptFailure) => void = () => {};

  /** 盤面の記録の器(ADR 0266)—— 受験者の答案の写しも同じ dir に置く。 */
  constructor(readonly dir: string) {}

  /** `worker_spawned` の後・spawn の前に同期で開く。開けなければ例外が呼び手へ返る
   *  (ADR 0118 の族、`spawn_failed`)。ファイル名は event id でセッションごとに一意
   *  (issue #379 / ADR 0083 追記2)。 */
  open(
    taskId: string,
    workerSpawnedEventId: number,
  ): Transcript {
    const base = join(this.dir, `${taskId}.${workerSpawnedEventId}`);
    const streamPath = `${base}.stream.jsonl`;
    const streamFd = openSync(streamPath, "w");
    let stderrFd: number;
    try {
      stderrFd = openSync(`${base}.stderr.log`, "w");
    } catch (err) {
      closeSync(streamFd);
      throw err;
    }
    let reported = false;
    const watch = (file: TranscriptFailure["file"], out: WriteStream) =>
      out.on("error", (err: NodeJS.ErrnoException) => {
        if (reported) return;
        reported = true;
        this.onFailed({ taskId, workerSpawnedEventId, error_code: err.code ?? null, message: err.message, file });
      });
    return {
      streamPath,
      stream: watch("stream", createWriteStream("", { fd: streamFd })),
      stderr: watch("stderr", createWriteStream("", { fd: stderrFd })),
    };
  }
}
