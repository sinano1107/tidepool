import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { createApiRouter } from "../src/api.js";
import type { Db } from "../src/db.js";
import { FakeClock, unusedLanding } from "./fakes.js";
import {
  AUTH_HEADERS,
  bootTidepool,
  makeWorkspace,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** 人間用リスナーの GET のうち `server.ts` が直接 `app` に登録するもの。ここだけは
 *  手書きになる — `startServer` は `app` を返さないので、`createApiRouter` に対して
 *  やっているような実装からの列挙ができない。したがって**このリストは server.ts に
 *  静的ルートが増えても自動では追随しない**。盤面の状態を持たないファイル配信なので
 *  変異のリスクは低く、手書きの代価に見合うと判断している。 */
const STATIC_GET_PATHS = ["/", "/styles.css", "/_ds_bundle.js"];

// /api の全 GET ルートを実装そのもの(createApiRouter)から列挙する。手書きの
// リストは将来のルート追加がこのテストの射程から黙って漏れる — 列挙が実装と
// 同じ源から出ていれば、新しい GET は登録された瞬間からここを通る。
function listGetRoutes(db: Db): string[] {
  const router = createApiRouter({
    db,
    clock: new FakeClock(),
    onQueueHeadChanged: () => {},
    landing: unusedLanding,
  });
  return (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack
    .filter((layer) => layer.route?.methods.get)
    .map((layer) => layer.route!.path);
}

// 射程は**人間用リスナーの GET 全部**(CONTEXT.md の人間面)。今日それは `/api` の
// ルーターと `server.ts` が直接 `app` に置く静的配信の2種で尽きている — 管理MCP
// (ADR 0032)はまだこのリスナーに mount されていない。mount された時点でその GET
// (SSE のストリーム開始)はこことは別の扱いが要る。
it("人間面の全 GET エンドポイントは盤面 DB を1行も変異させない(issue #140 / ADR 0036)", async () => {
  // 503 の早期 return で読み取り経路が素通りにならないよう、GET が読む先の
  // 依存はすべて埋めて boot する
  const workspace = await makeWorkspace(dirs, "board-ws");
  t = await bootTidepool({
    workspace,
    registryCandidates: { assignees: ["tako"], workspaces: ["board-ws"], icons: {} },
    workspaceAdmin: { list: () => ({ workspaces: [], workspacesBaseDir: { path: "/work", source: "default" as const } }) },
    agentAdmin: { list: () => [], authorityProfiles: () => [] },
    profileAdmin: { list: () => [] },
    hostSkills: async () => ["review"],
  });

  // :id 系ルートが 404 の早期 return で終わらず本物の表示経路を走るよう、
  // 実在するタスクを1つ置く(この POST 自体は snapshot の前)
  const task = await registerWork(t, "a task to view");
  expect(task.id).toBeTruthy();

  // harness の db は setup 専用。fixture を置いた後に共有 connection 自体を
  // read-only にし、どの GET からでも書き込みを試みれば 200 でなくす。
  t.db.pragma("query_only = ON");

  const routes = listGetRoutes(t.db);
  // 列挙の空回り(express 内部構造の変化等)で vacuous に green になる事故を
  // 弾く番犬。総数は下限ではなく実数で固定する — 下限だと1本消えても気づけず、
  // ルートが増減したときに人間がこの数字を意図して更新することに意味がある
  expect(routes).toContain("/tasks/:id");
  expect(routes.length).toBe(23);

  const paths = [
    ...STATIC_GET_PATHS,
    // パラメータには実在するタスク id を差す(未知のパラメータ名が将来増えても、
    // 読み取り専用であるべき点は変わらない)。/github-issues は必須クエリを足して
    // 400 の早期 return を避ける
    ...routes.map((route) =>
      route === "/github-issues"
        ? "/api/github-issues?workspace=board-ws"
        : `/api${route.replace(/:[^/]+/g, task.id)}`,
    ),
  ];

  for (const path of paths) {
    // issue #153: 人間面は credential を要求する。ここが測るのは無変異性で
    // あって認証ではないので、道具側の bearer を付けて読み取り経路まで届かせる
    const res = await fetch(`${t.baseUrl}${path}`, { headers: AUTH_HEADERS });
    await res.text();
    // 200 で固定する。「500 未満」だと将来 404 や 503 の早期 return に落ちた
    // ルートを素通りさせ、読み取り経路を1行も走らないまま合格してしまう
    expect(res.status, `GET ${path} did not reach its read path`).toBe(200);
  }
});
