import { inspect } from "node:util";
import Database from "better-sqlite3";

export type SqliteError = InstanceType<typeof Database.SqliteError>;

/** 拒まれた書き込みを投げた操作と task id(分かる範囲)。 */
export type BoardDbRefusalSite = { operation?: string; taskId?: string };

/** 再 throw が底に届かない口が呼ぶ終了(ADR 0342 決定4)。本番は `terminateOnBoardDbRefusal`、テストは fake。 */
export type TerminateOnBoardDbRefusal = (error: SqliteError, where?: BoardDbRefusalSite) => void;

/** stderr への1行。`done` は書き込みの完了で撃つ —— macOS の pipe では `process.stderr` が非同期なので、
 *  直後に exit すると1行が落ちうる(#2853)。 */
type WriteLine = (line: string, done: () => void) => void;
type Exit = (code: number) => void;

const writeStderr: WriteLine = (line, done) => process.stderr.write(line, () => done());
const exitProcess: Exit = (code) => process.exit(code);

/** ADR 0342 決定2: 盤面 DB が書きを拒んだときの exit code。通常の 1 と、Codex の canary の 32〜40
 *  (codex-worker.ts)を避ける(sysexits の EX_IOERR)。 */
export const BOARD_DB_REFUSAL_EXIT_CODE = 74;

/** ADR 0342 決定1: 盤面 DB が書きを拒んだ(A)か。6つの族はどれも拡張 code(`SQLITE_IOERR_WRITE` など)も含む ——
 *  better-sqlite3 は拡張 code を返す。
 *  BUSY / LOCKED / CONSTRAINT_* / ERROR と、SqliteError でないものは盤面のバグ(B)で false。 */
export function isBoardDbRefusal(error: unknown): error is SqliteError {
  return error instanceof Database.SqliteError && /^SQLITE_(FULL|IOERR|READONLY|CANTOPEN|CORRUPT|NOTADB)(_|$)/.test(error.code);
}

/** ADR 0342 決定2: (A) の行き先は process の終了。原因を固定の1行で stderr に出し、書き終えてから専用の code で終える。 */
export function terminateOnBoardDbRefusal(
  error: SqliteError,
  where: BoardDbRefusalSite = {},
  write: WriteLine = writeStderr,
  exit: Exit = exitProcess,
): void {
  const fields = [
    "tidepool: board db refused a write",
    error.code,
    where.operation && `operation=${where.operation}`,
    where.taskId && `task=${where.taskId}`,
    error.message,
  ];
  write(`${fields.filter(Boolean).join(" | ")}\n`, () => exit(BOARD_DB_REFUSAL_EXIT_CODE));
}

/** ADR 0294 決定4: process 全体の床。fire-and-forget の鎖が reject しても process は
 *  落とさず、理由(Error なら stack ごと)を log に出す —— 人間面が開いたままなのが
 *  復旧経路(ADR 0036)。ADR 0342 決定3: 理由が (A) なら人間面も書けないので process を終える。
 *  同期の throw は別の受け手(`installUncaughtExceptionReceiver`)。 */
export function installUnhandledRejectionFloor(
  emitter: NodeJS.EventEmitter = process,
  log: (reason: unknown) => void = console.error,
  write: WriteLine = writeStderr,
  exit: Exit = exitProcess,
): void {
  emitter.on("unhandledRejection", (reason) =>
    isBoardDbRefusal(reason) ? terminateOnBoardDbRefusal(reason, {}, write, exit) : log(reason),
  );
}

/** ADR 0342 決定3: 同期の throw の底。(A) は床と同じ終わり方、それ以外は Node の既定と同じく error を出して
 *  code 1 で終える —— 続行しない(ADR 0294 決定4 が登録を退けた理由は、必ず終える受け手には当たらない)。 */
export function installUncaughtExceptionReceiver(
  emitter: NodeJS.EventEmitter = process,
  write: WriteLine = writeStderr,
  exit: Exit = exitProcess,
): void {
  emitter.on("uncaughtException", (error) =>
    isBoardDbRefusal(error)
      ? terminateOnBoardDbRefusal(error, {}, write, exit)
      : write(`${inspect(error)}\n`, () => exit(1)),
  );
}
