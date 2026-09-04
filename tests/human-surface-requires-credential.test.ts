import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApiRouter } from "../src/api.js";
import type { Db } from "../src/db.js";
import { FakeClock, unusedLanding } from "./fakes.js";
import { bootTidepool, mcpClient, TEST_TOKEN, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** `/api` の全ルートを実装そのもの(createApiRouter)から列挙する — 手書きの
 *  リストは将来のルート追加がこのテストの射程から黙って漏れる
 *  (tests/human-get-endpoints-are-read-only.test.ts と同じ手口)。GET だけでなく
 *  全メソッドを拾う: credential は読取も操作も等しく要求する(ADR 0036)。 */
function listRoutes(db: Db): { method: string; path: string }[] {
  const router = createApiRouter({
    db,
    clock: new FakeClock(),
    onQueueHeadChanged: () => {},
    landing: unusedLanding,
  });
  const stack = (
    router as unknown as {
      stack: { route?: { path: string; methods: Record<string, boolean> } }[];
    }
  ).stack;
  return stack.flatMap((layer) =>
    layer.route
      ? Object.keys(layer.route.methods).map((method) => ({
          method: method.toUpperCase(),
          path: layer.route!.path,
        }))
      : [],
  );
}

it("/api の全ルートは credential なしでは 401(issue #153 / ADR 0036)", async () => {
  t = await bootTidepool();
  const routes = listRoutes(t.db);
  // 列挙の空回り(express 内部構造の変化等)で vacuous に green になる事故を弾く
  // 番犬。総数は下限ではなく実数で固定する — ルートが増減したときに人間がこの
  // 数字を意図して更新することに意味がある
  expect(routes).toContainEqual({ method: "GET", path: "/tasks/:id" });
  expect(routes.length).toBe(59);

  for (const { method, path } of routes) {
    // パラメータは何でもよい: credential 検査はハンドラより手前で落ちる
    const url = `${t.baseUrl}/api${path.replace(/:[^/]+/g, "x")}`;
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "HEAD" ? undefined : "{}",
    });
    expect(res.status, `${method} /api${path} was reachable without a credential`).toBe(401);
  }
});

/** `server.ts` が `app` に直接登録する静的資産 — `createApiRouter` の列挙からは
 *  漏れるので、ここだけは手書きで固定する(静的資産も守ると決めた以上、列挙の
 *  射程外にあることを理由に落とせない)。 */
const STATIC_PATHS = [
  "/",
  "/index.html",
  "/styles.css",
  "/_ds_bundle.js",
  "/app.js",
  "/vendor/react.js",
  "/vendor/react-dom.js",
  "/vendor/lucide.js",
  "/manifest.json",
  "/sw.js",
  "/favicon.svg",
  "/icon.svg",
  "/apple-touch-icon.png",
  "/kit/index.html",
  "/tokens/colors.css",
];

it("静的資産も credential なしでは 401(issue #153)", async () => {
  t = await bootTidepool();
  for (const path of STATIC_PATHS) {
    const res = await fetch(`${t.baseUrl}${path}`);
    await res.text();
    expect(res.status, `GET ${path} was served without a credential`).toBe(401);
  }
});

// Even an unregistered path returning 401 proves the middleware covers the
// entire app. A 404 would reveal a route that bypasses credential enforcement.
it("未登録のパスも 404 ではなく 401 を返す — 射程は app 全体(issue #153)", async () => {
  t = await bootTidepool();
  const res = await fetch(`${t.baseUrl}/not-registered`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(401);
});

// このスライスで最も起こりやすい実装事故の番犬: Worker MCP に credential を
// 掛けると全 worker が死ぬ。あちらのアクセス制御は `?task=` + slot + サーバー側
// authority のままである(ADR 0036)。
it("Worker MCP は credential なしのまま通る(issue #153)", async () => {
  t = await bootTidepool();
  const client = await mcpClient(t.mcpBaseUrl);
  try {
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
  } finally {
    await client.close();
  }
});

it("bearer ヘッダを持つ道具は通る(issue #153)", async () => {
  t = await bootTidepool();
  const res = await fetch(`${t.baseUrl}/api/tasks`, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  expect(res.status).toBe(200);
});

// manifest はブラウザの別機構が取りに行き、既定では credential を付けない
// (= インストール済み PWA が 401 で manifest を失う)。この属性だけが cookie を
// 付けさせるので、実ブラウザ確認より手前で退行を止める
it("manifest は credential 付きで取得される(issue #153)", async () => {
  const html = await readFile(join(import.meta.dirname, "..", "public", "index.html"), "utf8");
  expect(html).toMatch(/<link rel="manifest"[^>]*crossorigin="use-credentials"/);
});
