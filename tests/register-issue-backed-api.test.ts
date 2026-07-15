import { afterEach, expect, it } from "vitest";
import { IssueGoneError } from "../src/github.js";
import { FakeDraftClient } from "./fakes.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("POST /api/tasks は issue参照タスク(work + workspace + issue番号)を受け付ける(issue #49 設計点4)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });
  t.github.scriptIssue(49, { title: "ログイン画面のバグ", body: "b", comments: [] });

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    github_issue_number: 49,
    workspace: "tidepool",
  });
  expect(res.status).toBe(201);
  expect(res.json.github_issue_number).toBe(49);
  expect(res.json.workspace).toBe("tidepool");
  // 内容は保存されない — 同期リーダー向けの "#N" プレースホルダーのみ
  expect(res.json.title).toBe("#49");
});

it("issue参照の登録門は type work のみで、内容フィールドとの同居も拒否する(issue #49 設計点8)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });
  t.github.scriptIssue(49, { title: "t", body: "b", comments: [] });

  const review = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "review",
    github_issue_number: 49,
    workspace: "tidepool",
  });
  expect(review.status).toBe(400);

  const mixed = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    github_issue_number: 49,
    workspace: "tidepool",
    title: "snapshotted title",
  });
  expect(mixed.status).toBe(400);

  const noWorkspace = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    github_issue_number: 49,
  });
  expect(noWorkspace.status).toBe(400);
});

it("登録ゲート: 閉じた/存在しない issue は 400 で弾き、一時的失敗は 502 で登録を失敗させる(issue #49 設計点4)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });

  // 確定的失敗: 登録の段階で fail-fast(ADR 0009 の人間の同期リクエスト)
  t.github.scriptIssueFailure(new IssueGoneError({ path: "/fake/path", number: 49 }, "closed"));
  const gone = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    github_issue_number: 49,
    workspace: "tidepool",
  });
  expect(gone.status).toBe(400);
  expect(gone.json.error).toMatch(/gone|closed/i);

  // 一時的失敗: quarantine もプレースホルダー登録もせず、リトライ可能な失敗
  t.github.scriptIssueFailure(new Error("network is down"));
  const outage = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    github_issue_number: 49,
    workspace: "tidepool",
  });
  expect(outage.status).toBe(502);

  // どちらのケースでもタスクは登録されていない
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board).toEqual([]);
});

it("登録ゲート: LLM検査の不合格は 422 で missing と suggested_comment を返し、合格すれば 201(issue #49 設計点4)", async () => {
  const draftClient = new FakeDraftClient();
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" }, draftClient });
  t.github.scriptIssue(49, { title: "曖昧なメモ", body: "なんとかする", comments: [] });

  const body = { type: "work", github_issue_number: 49, workspace: "tidepool" };

  draftClient.scriptInspection({
    ok: false,
    missing: "completion criteria cannot be derived from the issue body",
    suggested_comment: "## Completion criteria\n- the login form submits without a console error",
  });
  const rejected = await api(t.baseUrl, "POST", "/api/tasks", body);
  expect(rejected.status).toBe(422);
  expect(rejected.json.missing).toBe("completion criteria cannot be derived from the issue body");
  expect(rejected.json.suggested_comment).toContain("Completion criteria");
  // 検査対象は fetch した issue そのもの(title + 本文 + コメント)
  expect(draftClient.inspected[0]?.title).toBe("曖昧なメモ");
  // 不合格では登録されない
  expect((await api(t.baseUrl, "GET", "/api/tasks")).json).toEqual([]);

  draftClient.scriptInspection({ ok: true });
  const accepted = await api(t.baseUrl, "POST", "/api/tasks", body);
  expect(accepted.status).toBe(201);

  // LLM 到達不能は draft エンドポイントと同じ 503(fail-fast、登録されない)
  draftClient.scriptInspectionFailure(new Error("llm down"));
  const llmDown = await api(t.baseUrl, "POST", "/api/tasks", body);
  expect(llmDown.status).toBe(503);
});

it("POST /api/issue-comments は人間が承認したサジェストを issue へ追記する(issue #49 設計点4)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });

  const res = await api(t.baseUrl, "POST", "/api/issue-comments", {
    workspace: "tidepool",
    github_issue_number: 49,
    body: "## Completion criteria\n- the login form submits cleanly",
  });
  expect(res.status).toBe(201);
  expect(t.github.issueComments).toEqual([
    {
      ref: { path: "/fake/path", number: 49 },
      body: "## Completion criteria\n- the login form submits cleanly",
    },
  ]);

  // 空 body は schema で弾く
  const empty = await api(t.baseUrl, "POST", "/api/issue-comments", {
    workspace: "tidepool",
    github_issue_number: 49,
    body: "",
  });
  expect(empty.status).toBe(400);
});
