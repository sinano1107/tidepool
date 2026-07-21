import { afterEach, expect, it } from "vitest";
import { OPEN_ISSUES_LIMIT } from "../src/github.js";
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

it("GET /api/github-issues は workspace の open issue 一覧を truncated: false で返す(issue #67)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });
  t.github.scriptIssueList([
    { number: 12, title: "ログイン画面のバグ" },
    { number: 7, title: "テストを直す" },
  ]);

  const res = await api(t.baseUrl, "GET", "/api/github-issues?workspace=tidepool");
  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    issues: [
      { number: 12, title: "ログイン画面のバグ" },
      { number: 7, title: "テストを直す" },
    ],
    truncated: false,
  });
  expect(t.github.issueListFetches).toEqual([{ path: "/fake/path" }]);
});

it("GET /api/github-issues は listIssues の上限(OPEN_ISSUES_LIMIT)ちょうど返ってきたら truncated: true を返す(issue #67 グリリング決定: 切り詰めの明示)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });
  t.github.scriptIssueList(
    Array.from({ length: OPEN_ISSUES_LIMIT }, (_, i) => ({ number: i + 1, title: `issue ${i + 1}` })),
  );

  const res = await api(t.baseUrl, "GET", "/api/github-issues?workspace=tidepool");
  expect(res.status).toBe(200);
  expect(res.json.truncated).toBe(true);
  expect(res.json.issues).toHaveLength(OPEN_ISSUES_LIMIT);
});

it("GET /api/github-issues は未知の workspace を 400、GitHub 失敗を 502 で返す(issue #67, /api/issue-comments と同じ姿勢)", async () => {
  t = await bootTidepool({ resolveWorkspace: makeResolver(["tidepool"]) });

  const unknown = await api(t.baseUrl, "GET", "/api/github-issues?workspace=nope");
  expect(unknown.status).toBe(400);

  t.github.scriptIssueListFailure(new Error("network is down"));
  const failure = await api(t.baseUrl, "GET", "/api/github-issues?workspace=tidepool");
  expect(failure.status).toBe(502);
});
