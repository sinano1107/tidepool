import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  BOARD_DB_REFUSAL_EXIT_CODE,
  installUncaughtExceptionReceiver,
  installUnhandledRejectionFloor,
  terminateOnBoardDbRefusal,
} from "../src/unhandled-rejection-floor.js";

it("unhandledRejection の listener を1つ登録し、emit で理由を logger に渡す(uncaughtException は触らない)", () => {
  const emitter = new EventEmitter();
  const logged: unknown[] = [];

  expect(() => installUnhandledRejectionFloor(emitter, (reason) => logged.push(reason))).not.toThrow();

  expect(emitter.listenerCount("unhandledRejection")).toBe(1);
  expect(emitter.listenerCount("uncaughtException")).toBe(0);

  const reason = new Error("boom");
  emitter.emit("unhandledRejection", reason, Promise.resolve());
  expect(logged).toEqual([reason]);
});

/** 盤面 DB が書きを拒んだ署名(ADR 0342 決定1)。better-sqlite3 は拡張 code を返すので、6つの族はどれも拡張 code も含む。 */
const REFUSALS = [
  "SQLITE_FULL",
  "SQLITE_IOERR",
  "SQLITE_IOERR_WRITE",
  "SQLITE_READONLY",
  "SQLITE_READONLY_DBMOVED",
  "SQLITE_CANTOPEN",
  "SQLITE_CANTOPEN_ISDIR",
  "SQLITE_CORRUPT",
  "SQLITE_CORRUPT_INDEX",
  "SQLITE_NOTADB",
];

/** 書き込みの完了(callback)をテストが撃つ fake の stderr と、呼ばれた code を記録する exit。 */
function fakeStderrAndExit() {
  const lines: string[] = [];
  const codes: number[] = [];
  const pending: (() => void)[] = [];
  return {
    lines,
    codes,
    write: (line: string, done: () => void) => {
      lines.push(line);
      pending.push(done);
    },
    exit: (code: number) => void codes.push(code),
    flush: () => {
      for (const done of pending.splice(0)) done();
    },
  };
}

it.each(REFUSALS)("盤面 DB が書きを拒んだ reject(%s)は、1行を書き終えてから専用の code で process を終える", (code) => {
  const emitter = new EventEmitter();
  const logged: unknown[] = [];
  const out = fakeStderrAndExit();
  installUnhandledRejectionFloor(emitter, (reason) => logged.push(reason), out.write, out.exit);

  emitter.emit("unhandledRejection", new Database.SqliteError("database or disk is full", code), Promise.resolve());

  expect(out.lines).toHaveLength(1);
  expect(out.lines[0]).toContain(code);
  expect(out.lines[0]).toContain("database or disk is full");
  expect(out.codes).toEqual([]);
  out.flush();
  expect(out.codes).toEqual([BOARD_DB_REFUSAL_EXIT_CODE]);
  expect(logged).toEqual([]);
});

/** 盤面のバグ(B)と、SqliteError でないもの(ADR 0342 決定1)。 */
const NOT_REFUSALS: [string, Error][] = [
  ["SQLITE_CONSTRAINT_TRIGGER", new Database.SqliteError("aborted", "SQLITE_CONSTRAINT_TRIGGER")],
  ["SQLITE_BUSY", new Database.SqliteError("database is locked", "SQLITE_BUSY")],
  ["族の境界の外の SQLITE_FULLX", new Database.SqliteError("lookalike", "SQLITE_FULLX")],
  ["SqliteError でない", Object.assign(new Error("not sqlite"), { code: "SQLITE_FULL" })],
];

it.each(NOT_REFUSALS)("盤面 DB の拒否でない reject(%s)は log だけで process を終えない", (_, reason) => {
  const emitter = new EventEmitter();
  const logged: unknown[] = [];
  const out = fakeStderrAndExit();
  installUnhandledRejectionFloor(emitter, (r) => logged.push(r), out.write, out.exit);

  emitter.emit("unhandledRejection", reason, Promise.resolve());
  out.flush();

  expect(logged).toEqual([reason]);
  expect(out.lines).toEqual([]);
  expect(out.codes).toEqual([]);
});

it("終了の1行は、分かっていれば投げた操作と task id を載せる", () => {
  const out = fakeStderrAndExit();

  terminateOnBoardDbRefusal(
    new Database.SqliteError("disk I/O error", "SQLITE_IOERR_WRITE"),
    { operation: "appendEvent", taskId: "t-42" },
    out.write,
    out.exit,
  );
  out.flush();

  expect(out.lines).toEqual([
    "tidepool: board db refused a write | SQLITE_IOERR_WRITE | operation=appendEvent | task=t-42 | disk I/O error\n",
  ]);
  expect(out.codes).toEqual([BOARD_DB_REFUSAL_EXIT_CODE]);
});

it.each(REFUSALS)("盤面 DB が書きを拒んだ同期の throw(%s)は、reject と同じ1行と専用の code で process を終える", (code) => {
  const emitter = new EventEmitter();
  const out = fakeStderrAndExit();
  installUncaughtExceptionReceiver(emitter, out.write, out.exit);

  emitter.emit("uncaughtException", new Database.SqliteError("database or disk is full", code), "uncaughtException");

  expect(out.lines).toEqual([`tidepool: board db refused a write | ${code} | database or disk is full\n`]);
  expect(out.codes).toEqual([]);
  out.flush();
  expect(out.codes).toEqual([BOARD_DB_REFUSAL_EXIT_CODE]);
});

it.each(NOT_REFUSALS)("盤面 DB の拒否でない同期の throw(%s)は、error を出して code 1 で終える(続行しない)", (_, error) => {
  const emitter = new EventEmitter();
  const out = fakeStderrAndExit();
  installUncaughtExceptionReceiver(emitter, out.write, out.exit);

  emitter.emit("uncaughtException", error, "uncaughtException");

  expect(out.lines).toHaveLength(1);
  expect(out.lines[0]).toContain(error.message);
  expect(out.codes).toEqual([]);
  out.flush();
  expect(out.codes).toEqual([1]);
});
