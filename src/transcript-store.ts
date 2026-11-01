import { randomUUID } from "node:crypto";
import { closeSync, createWriteStream, openSync, readFileSync, rmSync, type WriteStream, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PromptPart } from "./board-prose.js";
import type { Harness } from "./registry.js";

/** 盤面の記録の器(worker transcript を置く dir)への書き込みが fs の例外で落ちた(ADR 0266 決定3)。
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

/** 器への書き込みを1つ撃ち、fs の例外を `RecordContainerError` に包む。event に残る path は盤面の cwd に依らない絶対 path
 *  (既定の器は相対の `worker-logs`)。 */
function writeRecord<T>(taskId: string, path: string, write: () => T): T {
  try {
    return write();
  } catch (err) {
    throw new RecordContainerError(taskId, resolve(path), err instanceof Error ? err.message : String(err));
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
  /** 書けなくなったファイルの絶対 path —— 記録の器の停止の question が名指す。 */
  path: string;
}

/** Owned board text, task-only text, and their actual prompt placement (ADR 0326). */
export interface PromptRecord {
  harness: Harness;
  board: PromptPart[];
  task: string;
  placement: { board: "system" } | { board: "user"; separator: string };
}

/** Workers and the CLI conformance probes construct the same input. */
export function workerPromptRecord(harness: Harness, board: PromptPart[], task: string): PromptRecord {
  return { harness, board, task, placement: harness === "codex" ? { board: "user", separator: "\n\n--- Task ---\n\n" } : { board: "system" } };
}

/** Reconstruct exactly what the CLI receives, including the recorded separator. */
export function promptInput(prompt: PromptRecord): { system: string; user: string } {
  const board = prompt.board.map((part) => part.text).join("");
  return prompt.placement.board === "system"
    ? { system: board, user: prompt.task }
    : { system: "", user: board + prompt.placement.separator + prompt.task };
}

/** 開いた session の transcript。`stream` の path は fd から作った stream が持たないので別に運ぶ。 */
export interface Transcript {
  streamPath: string;
  stream: WriteStream;
  stderr: WriteStream;
}

/** worker session ごとの transcript(GLOSSARY.md「Transcript」—— stream・stderr・prompt の3本で
 *  1単位、ADR 0313 決定1)を開く盤面側の器(ADR 0149 決定5)。容器(`ProcessContainers`)と同じ立て付けで、
 *  adapter は開いた stream と stderr へ pipe するだけである —— prompt は open が書き切って閉じる。記録の器への書き込み(この open・解放の検査)と
 *  その失敗方針はこの module 1箇所に住む —— 書けなければ `RecordContainerError`、走ってからなら `onFailed`。順序は
 *  データ依存で固定される —— open は `worker_spawned` の event id を要り、spawn は
 *  open が返した2本へ pipe する。
 *  dir は作らない —— 無ければ過去の transcript が失われた事実ごと表に出す(決定2)。 */
export class TranscriptStore {
  /** 走ってから書けなくなった観測の盤面側の一撃。盤面(`startServer`)が差し込む。 */
  onFailed: (failure: TranscriptFailure) => void = () => {};

  /** 盤面の記録の器(ADR 0266 決定3)—— 記録の器の停止の解放の門もこの dir を検査する。 */
  constructor(readonly dir: string) {}

  /** `worker_spawned` の後・spawn の前に同期で開く。開けなければ `RecordContainerError` が呼び手へ返り、
   *  盤面全体の停止になる(ADR 0266 決定4 / ADR 0149 追記1)。ファイル名は event id でセッションごとに一意
   *  (issue #379 / ADR 0083 追記2)。prompt は spawn の前にここで書き切って閉じるので、走ってから書けなくなる経路を持たない。 */
  open(
    taskId: string,
    workerSpawnedEventId: number,
    prompt: PromptRecord,
  ): Transcript {
    const base = this.base(taskId, workerSpawnedEventId);
    const streamPath = `${base}.stream.jsonl`;
    const streamFd = writeRecord(taskId, streamPath, () => openSync(streamPath, "w"));
    const promptPath = `${base}.prompt.json`;
    const stderrPath = `${base}.stderr.log`;
    let stderrFd: number;
    try {
      // prompt は書き切って閉じるので、stderr より先に置けば落ちたとき閉じる fd は stream の1本だけ
      const promptJson = JSON.stringify(prompt);
      writeRecord(taskId, promptPath, () => writeFileSync(promptPath, promptJson));
      stderrFd = writeRecord(taskId, stderrPath, () => openSync(stderrPath, "w"));
    } catch (err) {
      closeSync(streamFd);
      throw err;
    }
    let reported = false;
    const watch = (file: TranscriptFailure["file"], path: string, out: WriteStream) =>
      out.on("error", (err: NodeJS.ErrnoException) => {
        if (reported) return;
        this.onFailed({ taskId, workerSpawnedEventId, error_code: err.code ?? null, message: err.message, file, path: resolve(path) });
        // ADR 0342 決定5・6: 印は一撃が返った後。盤面のバグで rollback した書き込みは落ちた後始末の question が持つ(受理が書き直す)ので、
        // 次の fd の error は2行目を書かない。印が立たないのは盤面 DB の拒否で一撃が投げたときだけ
        reported = true;
      });
    return {
      streamPath,
      stream: watch("stream", streamPath, createWriteStream("", { fd: streamFd })),
      stderr: watch("stderr", stderrPath, createWriteStream("", { fd: stderrFd })),
    };
  }

  /** `open` が書いた spawn の prompt(ADR 0314 決定1)。無い・parse できない記録(記録の dir が後から失われた・書き込みの途中で
   *  落ちた)は null —— 読み手は欄を空にして進む(決定2)。他の fs の例外は投げる。 */
  readPrompt(taskId: string, workerSpawnedEventId: number): PromptRecord | null {
    try {
      return JSON.parse(readFileSync(`${this.base(taskId, workerSpawnedEventId)}.prompt.json`, "utf8")) as PromptRecord;
    } catch (err) {
      if (err instanceof SyntaxError || (err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** `open` が開いた stream の行(ADR 0325 決定5)—— 走行中なら書かれたところまで。無い記録は null、他の fs の例外は投げる。 */
  readStream(taskId: string, workerSpawnedEventId: number): string[] | null {
    try {
      return readFileSync(`${this.base(taskId, workerSpawnedEventId)}.stream.jsonl`, "utf8").split("\n");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** 1 session の transcript の3本が共有する path の頭(issue #379 / ADR 0083 追記2)。 */
  private base(taskId: string, workerSpawnedEventId: number): string {
    return join(this.dir, `${taskId}.${workerSpawnedEventId}`);
  }
}
