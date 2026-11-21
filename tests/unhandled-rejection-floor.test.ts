import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { installUnhandledRejectionFloor } from "../src/unhandled-rejection-floor.js";

it("unhandledRejection の listener を1つ登録し、emit で理由を logger に渡す(uncaughtException は触らない)", () => {
  const emitter = new EventEmitter();
  const log = vi.fn();

  expect(() => installUnhandledRejectionFloor(emitter, log)).not.toThrow();

  expect(emitter.listenerCount("unhandledRejection")).toBe(1);
  expect(emitter.listenerCount("uncaughtException")).toBe(0);

  const reason = new Error("boom");
  emitter.emit("unhandledRejection", reason, Promise.resolve());
  expect(log).toHaveBeenCalledExactlyOnceWith(reason);
});

it("logs a SQLite-shaped rejection that did not come through openDb", () => {
  const emitter = new EventEmitter();
  const logged: unknown[] = [];
  installUnhandledRejectionFloor(emitter, (reason) => logged.push(reason));

  const reason = new Database.SqliteError("database or disk is full", "SQLITE_FULL");
  emitter.emit("unhandledRejection", reason, Promise.resolve());
  expect(logged).toEqual([reason]);
});
