import { afterEach, expect, it } from "vitest";
import { AUTH_COOKIE } from "../src/auth.js";
import { AUTH_HEADERS, bootstrapUrl, bootTidepool, TEST_TOKEN, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** cookie を張るだけの導線なので、リダイレクトは追わない。 */
const noRedirect = { redirect: "manual" as const };

it("bootstrap URL は cookie を張って `/` へ 302(issue #153 / ADR 0036)", async () => {
  t = await bootTidepool();
  const res = await fetch(bootstrapUrl(t.baseUrl), noRedirect);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");

  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain(`${AUTH_COOKIE}=${TEST_TOKEN}`);
  expect(setCookie).toContain("HttpOnly");
  // Lax であること。Strict はスマホのメッセージアプリ起点のトップレベル遷移で
  // cookie が送られず導線が壊れる(ADR 0036)ので、ここは「より安全に」しない
  expect(setCookie).toMatch(/SameSite=Lax/i);
  // Secure も付けない: loopback は http、tailnet 側は tailscale が TLS を終端
  expect(setCookie).not.toMatch(/;\s*Secure/i);
});

it("bootstrap で得た cookie で人間面が通る(issue #153)", async () => {
  t = await bootTidepool();
  const bootstrapped = await fetch(bootstrapUrl(t.baseUrl), noRedirect);
  const cookie = (bootstrapped.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const page = await fetch(t.baseUrl, { headers: { cookie } });
  await page.text();
  expect(page.status).toBe(200);

  const board = await fetch(`${t.baseUrl}/api/tasks`, { headers: { cookie } });
  expect(board.status).toBe(200);
});

it("誤った token の bootstrap は cookie を張らない(issue #153)", async () => {
  t = await bootTidepool();
  const res = await fetch(`${t.baseUrl}/auth?token=not-the-token`, {
    ...noRedirect,
    headers: { accept: "text/html" },
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("set-cookie")).toBeNull();
});

// インストール済み PWA にはアドレスバーが無く、「この URL を開いてください」では
// 端末が復旧できない(ADR 0036)。だから HTML の 401 は token 入力欄を持つ。
it("HTML の 401 は token 入力欄を持つ自己完結ページ(issue #153)", async () => {
  t = await bootTidepool();
  const res = await fetch(t.baseUrl, { headers: { accept: "text/html" } });
  expect(res.status).toBe(401);
  const html = await res.text();
  expect(html).toContain('name="token"');
  expect(html).toContain('action="/auth"');
  // 完全自己完結であること: 守られている資産を参照すると、ログインページ自身が
  // 401 の連鎖でスタイルもスクリプトも失う
  expect(html).not.toContain("/styles.css");
  expect(html).not.toContain("/_ds_bundle.js");
  expect(html).not.toContain("http://");
  expect(html).not.toContain("https://");
});

it("401 ページのフォーム POST で cookie が張られる(issue #153)", async () => {
  t = await bootTidepool();
  const res = await fetch(`${t.baseUrl}/auth`, {
    ...noRedirect,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: TEST_TOKEN }).toString(),
  });
  expect(res.status).toBe(302);
  expect(res.headers.get("set-cookie") ?? "").toContain(`${AUTH_COOKIE}=${TEST_TOKEN}`);
});

it("`/api` の 401 は素の JSON(issue #153)", async () => {
  t = await bootTidepool();
  const res = await fetch(`${t.baseUrl}/api/tasks`, { headers: { accept: "text/html" } });
  expect(res.status).toBe(401);
  expect(res.headers.get("content-type")).toContain("application/json");
  // WebUI の api() は `err.error` を読む
  expect((await res.json()).error).toBeTypeOf("string");
});

// 「データの面」の判定は境界まで見る — prefix 一致だけだと `/apiary` のような
// 別のパスまで `/api` 扱いになる
it("`/api` の判定は境界まで見る(issue #153)", async () => {
  t = await bootTidepool();
  const res = await fetch(`${t.baseUrl}/apiary`, { headers: { accept: "text/html" } });
  expect(res.status).toBe(401);
  expect(res.headers.get("content-type")).toContain("text/html");
});

// CSRF の二枚目(ADR 0036): SameSite=Lax はクロスサイト POST に cookie を付けない
// が、`/api` 側でも JSON content-type を要求してクロスオリジン fetch に preflight
// を強制する。認証済みでも content-type が違えば通らない。
it("`/api` の変更系は JSON content-type を要求する(issue #153)", async () => {
  t = await bootTidepool();
  const res = await fetch(`${t.baseUrl}/api/tasks`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ type: "work", title: "x", purpose: "p", completion_criteria: "c" }),
  });
  expect(res.status).toBe(415);
});

// 順序の番犬: content-type 検査が credential 検査より手前に出ると、無認証の
// POST が 415 で落ちて 401 にならなくなる(列挙型 401 テストの穴になる)
it("無認証かつ content-type 不正なら 415 ではなく 401(issue #153)", async () => {
  t = await bootTidepool();
  const res = await fetch(`${t.baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  expect(res.status).toBe(401);
});
