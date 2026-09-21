import { afterEach, expect, it } from "vitest";
import { bootTidepool, type Tidepool } from "./harness.js";

/** issue #775: `stopServer()` は盤面1つにつき高々1回しかサーバの停止を走らせず、
 *  停止中に来た2度目以降の呼び手は同じ停止の完了を待つ —— vitest の testTimeout が
 *  1度目の `await` を中断しても、`afterEach` の撃ち直しが ERR_SERVER_NOT_RUNNING を
 *  本当の症状の隣に並べない。 */

let t: Tidepool;
afterEach(async () => {
  // 2度目の呼び出し(停止済みの経路)も併せて exercise する。
  await t?.stop();
});

it("同じ盤面で stopServer() を同時に2回撃っても、両方が reject せずに解決する", async () => {
  t = await bootTidepool();
  await Promise.all([t.stopServer(), t.stopServer()]);
});

it("1度目の停止が完了する前に2度目の呼び出しは解決しない", async () => {
  t = await bootTidepool();
  let firstDone = false;
  const first = t.stopServer();
  void first.then(() => (firstDone = true));
  await t.stopServer();
  expect(firstDone).toBe(true);
});
