import { StringDecoder } from "node:string_decoder";

/** 子プロセスの出力を読む vendor 中立の層(issue #1299)。chunk 単位の toString() は
 *  UTF-8 文字を境界で割ると置換文字に化ける(#1298)ので、StringDecoder が境界を
 *  またぐシーケンスを繰り越す。全量ファイルへの pipe はバイト正確なのでここを通らない。 */
function decodeChunks(stream: NodeJS.ReadableStream, onText: (text: string) => void): () => string {
  const decoder = new StringDecoder("utf8");
  stream.on("data", (chunk: Buffer | string) => {
    onText(typeof chunk === "string" ? chunk : decoder.write(chunk));
  });
  return () => decoder.end();
}

/** stdout を `\n` で割って1行ずつ `onLine` に渡す。行の解釈(JSON など)は呼び出し側の
 *  vendor 固有の仕事。返す関数は呼び出し側が exit で呼ぶ flush —— stream が未終端の行で
 *  閉じたとき、その行を最後の1回として渡す。 */
export function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
  let buffered = "";
  const take = (text: string) => {
    const lines = (buffered + text).split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
  const end = decodeChunks(stream, take);
  return () => {
    take(end());
    if (buffered !== "") onLine(buffered);
    buffered = "";
  };
}

// issue #125: worker_exited が運ぶ stderr 末尾の行数。全量は
// <taskId>.<worker_spawned event id>.stderr.log(issue #379)に残るので、
// イベント側は失敗形の判別に足る末尾だけを持つ。
const STDERR_TAIL_LINES = 20;

/** Per-chunk trim for the in-memory stderr tail (issue #125): keeps the last
 *  STDERR_TAIL_LINES lines plus the final `split("\n")` element (the empty
 *  string a trailing "\n" produces, or an unterminated partial line) — so
 *  concatenating the next chunk can never glue two real lines together. This
 *  bounds the buffer regardless of how chatty a session's stderr is; the
 *  verbatim full text is on disk, not here. */
function trimStderrTail(text: string): string {
  return text
    .split("\n")
    .slice(-(STDERR_TAIL_LINES + 1))
    .join("\n");
}

/** The worker_exited summary (issue #125): the last STDERR_TAIL_LINES lines
 *  of the captured stderr, or null when the session wrote nothing (or only a
 *  bare newline) — 実内容の無い stderr を空文字で残すと「捕捉が欠落した」形と
 *  紛れるので、null 側に倒す。A trailing "\n" terminates the last line rather
 *  than opening an empty one. */
function stderrTail(text: string): string | null {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const tail = lines.slice(-STDERR_TAIL_LINES).join("\n");
  return tail === "" ? null : tail;
}

/** stderr の末尾だけを chunk ごとに保持し、返す関数(呼び出し側が exit で呼ぶ)で
 *  worker_exited の stderr_tail を返す。文字の途中で stream が閉じた場合の未完バイト列も
 *  flush する(この場合の置換文字は捏造ではなく「途中で切れた」事実そのもの)。 */
export function readStderrTail(stream: NodeJS.ReadableStream): () => string | null {
  let buffered = "";
  const end = decodeChunks(stream, (text) => {
    buffered = trimStderrTail(buffered + text);
  });
  return () => stderrTail(buffered + end());
}
