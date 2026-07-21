import { afterEach, expect, it } from "vitest";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

function makeResolver(known: string[]) {
  return (name: string | null) => {
    const n = name ?? "sandbox";
    if (!known.includes(n)) throw new UnknownWorkspaceError(n);
    return { name: n, path: `/fake/${n}` } as WorkspaceConfig;
  };
}

it("GET /api/github-issues は workspace の open issue 一覧を返す(issue #67)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });
  t.github.scriptIssueList([
    { number: 12, title: "ログイン画面のバグ" },
    { number: 7, title: "テストを直す" },
  ]);

  const res = await api(t.baseUrl, "GET", "/api/github-issues?workspace=tidepool");
  expect(res.status).toBe(200);
  expect(res.json).toEqual([
    { number: 12, title: "ログイン画面のバグ" },
    { number: 7, title: "テストを直す" },
  ]);
  expect(t.github.issueListFetches).toEqual([{ path: "/fake/path" }]);
});

it("GET /api/github-issues は未知の workspace を 400、GitHub 失敗を 502 で返す(issue #67, /api/issue-comments と同じ姿勢)", async () => {
  t = await bootTidepool({ resolveWorkspace: makeResolver(["tidepool"]) });

  const unknown = await api(t.baseUrl, "GET", "/api/github-issues?workspace=nope");
  expect(unknown.status).toBe(400);

  t.github.scriptIssueListFailure(new Error("network is down"));
  const failure = await api(t.baseUrl, "GET", "/api/github-issues?workspace=tidepool");
  expect(failure.status).toBe(502);
});
