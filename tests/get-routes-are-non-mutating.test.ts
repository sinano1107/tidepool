import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApiRouter } from "../src/api.js";
import type { Clock } from "../src/clock.js";
import { type Db, openDb } from "../src/db.js";
import { unusedLanding } from "./fakes.js";
import { api, bootTidepool, registerQuestion, registerWork, type Tidepool } from "./harness.js";

// issue #140 / ADR 0034: worker からの読取(WebFetch 経由の人間面 GET)を
// 「到達しうるが監査つき」で受容できるのは、人間面の GET が無変異だという
// 前提があってこそ。CONTEXT.md の人間面節がこの前提をコードの不変条件に
// 格上げしている — ここでその釘を打つ。

let t: Tidepool;
afterEach(() => t?.stop());

/** src/api.ts に実際に登録されている GET ルートを機械的に洗い出す。
 *  createApiRouter は必須の3フィールド(db/clock/onQueueHeadChanged)以外
 *  すべて optional で、トップレベルで deps を呼ぶのは IssueContentCache の
 *  生成だけ(DB/クロックへは触れない)— ここではルーティングテーブルの
 *  構造だけを見るための構築で、返る router 自体はリクエストを捌かない。
 *  新しい router.get(...) が足されれば、このリストにも自動的に載る。 */
function listApiGetPaths(): string[] {
  const router = createApiRouter({
    db: {} as Db,
    clock: {} as Clock,
    onQueueHeadChanged: () => {},
    landing: unusedLanding,
  });
  const paths: string[] = [];
  for (const layer of (
    router as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }
  ).stack) {
    if (layer.route?.methods.get) paths.push(layer.route.path);
  }
  return paths;
}

/** DB ファイル全体のスナップショット。第二コネクション(WAL 下で安全 —
 *  harness の registerQuestion と同じ手筋)で全テーブルを rowid 順にダンプ
 *  する。tasks の主キーは TEXT だが WITHOUT ROWID 指定はどのテーブルにも
 *  無いので、暗黙の rowid で決定的にソートできる。 */
function dumpDb(dbPath: string): unknown {
  const db = openDb(dbPath);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const snapshot: Record<string, unknown> = {};
    for (const { name } of tables) {
      snapshot[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    }
    return snapshot;
  } finally {
    db.close();
  }
}

const GET_ROUTES = listApiGetPaths();

/** GET のうち id を要求するルート向けの実 URL 組み立て。新しい GET が
 *  足されたのにここへの追記が漏れていると、以下の2本の「網羅の釘」テスト
 *  のどちらかが必ず落ちる(前方: 未収載ルートの検知、後方: 死んだ
 *  エントリの検知)。 */
const ROUTE_URL: Record<string, (fx: { taskId: string }) => string> = {
  // workspace=home resolves against the boot-time `workspace` fixture below
  // (a fake path — FakeGitHubClient.listIssues never touches disk), so this
  // reaches the real github.listIssues()/res.json() branch instead of just
  // the zod-rejection 400.
  "/github-issues": () => "/github-issues?workspace=home",
  "/workspaces": () => "/workspaces",
  "/agents": () => "/agents",
  "/skills": () => "/skills",
  "/profiles": () => "/profiles",
  "/translate/usage": () => "/translate/usage",
  "/log": () => "/log",
  "/push/vapid-public-key": () => "/push/vapid-public-key",
  "/settings/quiet-hours": () => "/settings/quiet-hours",
  "/settings/pace-offsets": () => "/settings/pace-offsets",
  "/settings/provider-pace-offsets": () => "/settings/provider-pace-offsets",
  "/settings/timezone": () => "/settings/timezone",
  "/settings/display-language": () => "/settings/display-language",
  "/settings/github": () => "/settings/github",
  "/pause": () => "/pause",
  "/triage": () => "/triage",
  "/pending-dumps": () => "/pending-dumps",
  "/registry/candidates": () => "/registry/candidates",
  "/tasks": () => "/tasks",
  "/your-tasks": () => "/your-tasks",
  "/queue": () => "/queue",
  "/tasks/:id/events": (fx) => `/tasks/${fx.taskId}/events`,
  "/tasks/:id": (fx) => `/tasks/${fx.taskId}`,
};

/** 各ルートの本流の分岐を GET で踏むための盤面状態。 */
async function seedBoard(t: Tidepool): Promise<{ taskId: string }> {
  const task = await registerWork(t, "seed task for GET route coverage");
  registerQuestion(t, {
    title: "should we proceed?",
    purpose: "need a human call",
    completion_criteria: "a human answers",
    question: [{ title: "proceed?", options: ["yes", "no"], recommendation: "yes" }],
  });
  await api(t.baseUrl, "POST", "/api/triage/start");
  const scratch = (await api(t.baseUrl, "POST", "/api/triage/scratchpad", { line: "a stray idea" }))
    .json;
  await api(t.baseUrl, "POST", "/api/triage/close", {
    scratchpad: [{ id: scratch.id, disposition: "register" }],
  });
  await api(t.baseUrl, "POST", "/api/settings/quiet-hours", { start: "22:00", end: "06:00" });
  await api(t.baseUrl, "POST", "/api/settings/pace-offsets", { session: 5, week: 5, fable: 5 });
  await api(t.baseUrl, "POST", "/api/settings/timezone", { tz: "Asia/Tokyo" });
  await api(t.baseUrl, "POST", "/api/settings/display-language", { language: "English" });
  await api(t.baseUrl, "POST", "/api/pause", { paused: true });
  return { taskId: task.id };
}

it("コントロール: 何もしなければ DB ダンプは安定している(比較機構そのものの健全性)", async () => {
  t = await bootTidepool();
  await seedBoard(t);
  const dbPath = join(t.dir, "board.sqlite");
  expect(dumpDb(dbPath)).toEqual(dumpDb(dbPath));
});

/** 「未収載ルート」の失敗メッセージ — 収載テスト自身と it.each 内の防御的
 *  throw(収載テストが緑のまま it.each 側だけ知らないルートを踏む、という
 *  ズレを踏んだ場合の保険)の両方から参照する、唯一の文言。 */
function notCoveredMessage(route: string): string {
  return `GET ${route} is not covered by tests/get-routes-are-non-mutating.test.ts — add it to ROUTE_URL (ADR 0034: human-facing GET routes must stay non-mutating)`;
}

it("洗い出した GET ルートは全て ROUTE_URL に収載されている(新規ルートの列挙漏れを検知)", () => {
  for (const route of GET_ROUTES) {
    expect(route in ROUTE_URL, notCoveredMessage(route)).toBe(true);
  }
});

it("ROUTE_URL の全キーは実在の GET ルートである(削除済みルートの死んだエントリを検知)", () => {
  for (const route of Object.keys(ROUTE_URL)) {
    expect(
      GET_ROUTES,
      `ROUTE_URL has a stale entry for GET ${route}, which no longer exists in src/api.ts — remove it`,
    ).toContain(route);
  }
});

/** ADR 0034 の主張は「ダンプの前後で同じ」ではなく「GET を挟んでも同じ」。
 *  コントロール(上のテスト)はリクエストなしの back-to-back 比較なので、
 *  リクエストを挟むことで生まれる時間差(スケジューラの pollNow 等)を
 *  見逃す。ここでは実際に GET を1本挟んで、それでも安定していることを
 *  確かめる — すでに露出のない実装と分かっている /push/vapid-public-key
 *  (db に一切触れない一行ハンドラ)を使うことで、比較機構そのものと
 *  「盤面が GET の前後で静止している」という前提の両方を検証する。 */
it("コントロール: 純粋な GET を挟んでも DB ダンプは安定している(before/after 比較の窓を閉じる)", async () => {
  t = await bootTidepool();
  await seedBoard(t);
  const dbPath = join(t.dir, "board.sqlite");

  const before = dumpDb(dbPath);
  const res = await api(t.baseUrl, "GET", "/api/push/vapid-public-key");
  const after = dumpDb(dbPath);

  expect(res.status).toBe(200);
  expect(after).toEqual(before);
});

it.each(GET_ROUTES)("GET /api%s は DB を変異させない(ADR 0034)", async (route) => {
  t = await bootTidepool({
    workspace: { name: "home", path: "/fake/home" },
    registryCandidates: { assignees: [], workspaces: [], icons: {} },
    hostSkills: async () => [],
    fableAgents: () => [],
    workspaceAdmin: { list: () => ({ workspaces: [], workspacesBaseDir: { path: "/work", source: "default" as const } }) },
    agentAdmin: { list: () => [], authorityProfiles: () => [] },
    profileAdmin: { list: () => [] },
  });
  const fixtures = await seedBoard(t);

  const buildUrl = ROUTE_URL[route];
  if (!buildUrl) throw new Error(notCoveredMessage(route));
  const url = buildUrl(fixtures);
  const dbPath = join(t.dir, "board.sqlite");

  const before = dumpDb(dbPath);
  const res = await api(t.baseUrl, "GET", `/api${url}`);
  const after = dumpDb(dbPath);

  // seedBoard exists precisely so every route's happy path is live — a bare
  // DB-diff check can't tell "reached the real read and changed nothing"
  // apart from "errored out before touching the db", so pin the status too.
  expect(res.status, `GET /api${url} returned ${res.status}, expected 200`).toBe(200);
  expect(after, `GET /api${url} changed the DB contents`).toEqual(before);
});
