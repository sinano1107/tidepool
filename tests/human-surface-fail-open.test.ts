import { afterEach, expect, it } from "vitest";
import { AUTH_COOKIE, BOOTSTRAP_PATH } from "../src/auth.js";
import { bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** 使えるハッシュを1つも持たない盤面 — ファイルを失った・壊れた・書けなかった、
 *  のいずれでも `tokenHash()` は undefined を返す(auth.ts)。 */
const NO_CREDENTIAL = { tokenHash: () => undefined };

it("使えるハッシュを持たない盤面は人間面を開ける(ADR 0036 の fail-open)", async () => {
  t = await bootTidepool({ credential: NO_CREDENTIAL });

  const res = await fetch(`${t.baseUrl}/api/tasks`);
  expect(res.status).toBe(200);
});

it("fail-open は静的資産にも及ぶ — 開いているのが人間の復旧経路なので、面ごとに割らない", async () => {
  t = await bootTidepool({ credential: NO_CREDENTIAL });

  const res = await fetch(`${t.baseUrl}/`, { headers: { accept: "text/html" } });
  await res.text();
  expect(res.status).toBe(200);
});

// 「認証が立たない = 人間面が開く」であって「誰でも cookie を貰える」ではない。
// 検証できない token に cookie を張ると、ローテーションで盤面が閉じた瞬間に
// その端末だけ黙って締め出される(張られた cookie は新しいハッシュに通らない)。
it("認証が立たない盤面の bootstrap は cookie を張らない — 張る根拠が無い", async () => {
  t = await bootTidepool({ credential: NO_CREDENTIAL });

  const res = await fetch(`${t.baseUrl}${BOOTSTRAP_PATH}?token=anything`, { redirect: "manual" });
  await res.text();
  expect(res.headers.get("set-cookie") ?? "").not.toContain(AUTH_COOKIE);
  // それでも盤面には入れる(開いているので): 行き止まりのエラーには落とさない
  expect(res.status).toBe(302);
});
