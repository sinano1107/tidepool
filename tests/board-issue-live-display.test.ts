import { afterEach, expect, it } from "vitest";
import { registerTask } from "../src/tasks.js";
import { UnknownWorkspaceError } from "../src/workspace.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/tasks はissue参照タスクの内容をGitHubからlive展開し issue_live_state: 'live' を付ける(issue #49 設計点6)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });

  const db = t.db;
  const issueBacked = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
  );
  const ordinary = registerTask(
    db,
    { type: "work", title: "ordinary todo", purpose: "p", completion_criteria: "c" },
    t.clock.now(),
  );

  t.github.scriptIssue(49, {
    title: "ログイン画面のバグ",
    body: "再現手順: ...",
    comments: ["追加情報です"],
  });

  const res = await api(t.baseUrl, "GET", "/api/tasks");
  expect(res.status).toBe(200);

  const live = res.json.find((x: any) => x.id === issueBacked.id);
  expect(live.title).toBe("ログイン画面のバグ");
  expect(live.purpose).toBe("再現手順: ...\n\n## Issue comments\n\n追加情報です");
  expect(live.completion_criteria).toBe("See the issue content above for completion criteria.");
  expect(live.issue_live_state).toBe("live");

  const plain = res.json.find((x: any) => x.id === ordinary.id);
  expect(plain.title).toBe("ordinary todo");
  expect(plain.issue_live_state).toBeUndefined();
});

it("issue内容は短TTL(30秒)のプロセス内キャッシュから返り、TTL経過後にだけGitHubへ再取得しにいく(issue #49 設計点6)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });

  const db = t.db;
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
  );

  t.github.scriptIssue(49, { title: "ログイン画面のバグ", body: "b", comments: [] });

  // ポーリング2回目はTTL内 — GitHubへは最初の1回しか行かない
  await api(t.baseUrl, "GET", "/api/tasks");
  await api(t.baseUrl, "GET", "/api/tasks");
  expect(t.github.issueFetches.length).toBe(1);

  // TTLが切れたら再取得し、issueの編集が盤面に反映される
  t.github.scriptIssue(49, { title: "改題: 認証全体の見直し", body: "b2", comments: [] });
  await t.clock.advance(30_000);
  const res = await api(t.baseUrl, "GET", "/api/tasks");
  expect(t.github.issueFetches.length).toBe(2);
  const row = res.json.find((x: any) => x.id === task.id);
  expect(row.title).toBe("改題: 認証全体の見直し");
  expect(row.issue_live_state).toBe("live");
});

it("TTL切れ後の再取得に失敗したら、最後に成功した内容を issue_live_state: 'stale' で返す(issue #49 設計点6)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });

  const db = t.db;
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
  );

  t.github.scriptIssue(49, { title: "ログイン画面のバグ", body: "再現手順: ...", comments: [] });
  await api(t.baseUrl, "GET", "/api/tasks");

  t.github.scriptIssueFailure(new Error("GitHub is down"));
  await t.clock.advance(30_000);
  const res = await api(t.baseUrl, "GET", "/api/tasks");
  expect(res.status).toBe(200);
  const row = res.json.find((x: any) => x.id === task.id);
  expect(row.title).toBe("ログイン画面のバグ");
  expect(row.issue_live_state).toBe("stale");

  // 障害が直れば次の取得で live に戻る
  t.github.scriptIssueFailure(null);
  const recovered = await api(t.baseUrl, "GET", "/api/tasks");
  const back = recovered.json.find((x: any) => x.id === task.id);
  expect(back.issue_live_state).toBe("live");
});

it("一度も取得に成功していなければ '#N' プレースホルダーのまま issue_live_state: 'unavailable' を返す(issue #49 設計点6)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });

  const db = t.db;
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
  );

  t.github.scriptIssueFailure(new Error("GitHub is down"));

  const res = await api(t.baseUrl, "GET", "/api/tasks");
  expect(res.status).toBe(200);
  const row = res.json.find((x: any) => x.id === task.id);
  expect(row.title).toBe("#49");
  expect(row.purpose).toBe("#49");
  expect(row.issue_live_state).toBe("unavailable");
});

it("workspace が解決できない(registry drift)issue参照タスクは unavailable になり、閲覧は quarantine を起こさない(issue #49 設計点6)", async () => {
  const tidepool = { name: "tidepool", path: "/fake/path" };
  t = await bootTidepool({
    workspace: tidepool,
    resolveWorkspace: (name) => {
      if ((name ?? "tidepool") !== "tidepool") throw new UnknownWorkspaceError(name ?? "tidepool");
      return tidepool;
    },
  });

  // 登録時には存在した workspace 名が registry から消えた状況(drift)
  const db = t.db;
  const task = registerTask(
    db,
    { type: "work", workspace: "ghost", github_issue_number: 49 },
    t.clock.now(),
  );

  t.github.scriptIssue(49, { title: "ログイン画面のバグ", body: "b", comments: [] });

  const res = await api(t.baseUrl, "GET", "/api/tasks");
  expect(res.status).toBe(200);
  const row = res.json.find((x: any) => x.id === task.id);
  expect(row.title).toBe("#49");
  expect(row.issue_live_state).toBe("unavailable");

  // workspace が同定できない内容は取得しようがない — GitHub へは行かない
  expect(t.github.issueFetches.length).toBe(0);
  // 閲覧(GET)は quarantine の承認 question を生まない
  expect(res.json.filter((x: any) => x.type === "question")).toEqual([]);
});

it("GET /api/queue と GET /api/tasks/:id もissue参照タスクをlive展開する(issue #49 設計点6)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });

  const db = t.db;
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
  );

  t.github.scriptIssue(49, { title: "ログイン画面のバグ", body: "再現手順: ...", comments: [] });

  const queue = await api(t.baseUrl, "GET", "/api/queue");
  const queued = queue.json.tasks.find((x: any) => x.id === task.id);
  expect(queued.title).toBe("ログイン画面のバグ");
  expect(queued.issue_live_state).toBe("live");

  const single = await api(t.baseUrl, "GET", `/api/tasks/${task.id}`);
  expect(single.json.title).toBe("ログイン画面のバグ");
  expect(single.json.purpose).toBe("再現手順: ...");
  expect(single.json.issue_live_state).toBe("live");
});

it("同一issueへの並行リクエストはフェッチを共有し、GitHubへ二重に問い合わせない(issue #49 設計点6)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });

  const db = t.db;
  registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
  );

  t.github.scriptIssue(49, { title: "ログイン画面のバグ", body: "b", comments: [] });

  // コールドキャッシュで /tasks と /queue のポーリングが同時に着火した状況。
  // 1本目のフェッチをゲートで保留し、2本目のリクエストが確実に
  // in-flight 中へ重なるようにする
  let release!: () => void;
  t.github.scriptIssueGate(new Promise((r) => (release = r)));
  const p1 = api(t.baseUrl, "GET", "/api/tasks");
  const p2 = api(t.baseUrl, "GET", "/api/queue");
  await new Promise((r) => setTimeout(r, 50));
  release();
  const [board, queue] = await Promise.all([p1, p2]);
  expect(board.status).toBe(200);
  expect(queue.status).toBe(200);
  expect(t.github.issueFetches.length).toBe(1);
});
