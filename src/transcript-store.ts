import { closeSync, createWriteStream, openSync, type WriteStream } from "node:fs";
import { join } from "node:path";

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

  constructor(private readonly dir: string) {}

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
