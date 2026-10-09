import type { Response } from "express";
import type { Unstored } from "./tasks.js";

/** HTTP の JSON 応答の唯一の出口(ADR 0220): 解決を通っていない行は型で拒む。`res.json` の直書きは lint が禁じる。
 *  状態コードは `sendJson(res.status(n), body)` で渡す。 */
export function sendJson<T>(res: Response, body: Unstored<T>) {
  // biome-ignore lint/plugin: the typed exit itself (ADR 0220)
  return res.json(body);
}
