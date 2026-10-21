import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { installUnhandledRejectionFloor } from "../src/unhandled-rejection-floor.js";

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
