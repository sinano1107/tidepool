import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GitHubAuth } from "../src/github-auth.js";
import { RepoAccessMissingError } from "../src/repo-access.js";
import { UnknownWorkspaceError } from "../src/workspace.js";
import {
  CheckoutHasOriginError,
  GitHubIdentityMissingError,
  ProtectedBranchMissingError,
  type PublishWorkspaceInput,
  publishWorkspace,
  WorkspaceAlreadyPublishedError,
} from "../src/workspace-create.js";
import { api, bootTidepool, git, makeWorkspace, type Tidepool } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** publish は ADR 0061 の「危険な値」族ではない(エージェントの権限を広げない)ので
 *  confirm を要求しない —— 宛先 URL が毎回人間の入力であること自体が同意の形である
 *  (ADR 0066 決定8)。 */
it("POST /api/workspaces/:name/publish は宛先を publish オーケストレーションへ渡す", async () => {
  const calls: PublishWorkspaceInput[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      publish: async (input) => {
        calls.push(input);
        return "published";
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", {
    repo: "https://github.com/sinano1107/sandbox.git",
  });

  expect(res.status).toBe(200);
  expect(calls).toEqual([
    { name: "sandbox", repo: "https://github.com/sinano1107/sandbox.git" },
  ]);
});

// issue #3563: 成功文は送った範囲(保護ブランチ)と次の手順(出元 repo を用意して宣言する)を言う。送る範囲そのものは publishWorkspace のテストが持つ
it("POST /api/workspaces/:name/publish は送った範囲と次の手順を返す", async () => {
  const ws = await makeWorkspace("sandbox");
  const registryDir = await makeRegistry({ "workspaces.yaml": `sandbox:\n  path: ${ws.path}\n` });
  const dest = await tempDir("tidepool-dest-");
  git(dest, "init", "--bare", "-b", "main");
  const token = join(await tempDir("tidepool-token-"), "token");
  writeFileSync(token, "ghp_test\n");
  const deps = { registry: { dir: registryDir, mode: "purely-local" as const }, workspacesBaseDir: await tempDir("tidepool-ws-base-"), githubAuth: new GitHubAuth(token) };
  t = await bootTidepool({ workspaceAdmin: { publish: (input) => publishWorkspace(input, { ...deps, db: t.db }) } });

  const res = await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", { repo: dest });

  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    message: `Published workspace sandbox: sent its protected branch main to origin (${dest}); task branches were not sent. Next, fork ${dest} and set the fork as this workspace's head repo in the workspace settings; that sends the task branches to the fork.`,
  });
});

it("publish が未設定(registry なしの盤面)なら 503 を返す", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", {
    repo: "https://github.com/sinano1107/sandbox.git",
  });

  expect(res.status).toBe(503);
});

it("宛先が空文字なら 400 で、オーケストレーションを呼ばない", async () => {
  const calls: PublishWorkspaceInput[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      publish: async (input) => {
        calls.push(input);
        return "published";
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", { repo: "" });

  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

it("知らない workspace 名は 404(update の扉と同じ)", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      publish: async () => {
        throw new UnknownWorkspaceError("sandbox");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", { repo: "x" });

  expect(res.status).toBe(404);
});

// 「出し直せば通り得る呼び出し側の入力・状態の問題」の族(create の扉と同じ読み)
it.each([
  ["already published", new WorkspaceAlreadyPublishedError("sandbox", "https://example/x.git")],
  ["checkout already has origin", new CheckoutHasOriginError("sandbox", "https://example/y.git", "/tmp/sandbox")],
  ["protected branch missing", new ProtectedBranchMissingError("sandbox", "trunk", "/tmp/sandbox")],
  ["repo access missing", new RepoAccessMissingError("grant write access with: gh api ...")],
])("%s は 400 でメッセージを返す", async (_label, err) => {
  t = await bootTidepool({
    workspaceAdmin: {
      publish: async () => {
        throw err;
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", { repo: "x" });

  expect(res.status).toBe(400);
  expect(res.json.error).toBe(err.message);
});

it("GitHub 身元を持たない盤面は 503(未設定と同じ族)", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      publish: async () => {
        throw new GitHubIdentityMissingError();
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", { repo: "x" });

  expect(res.status).toBe(503);
});

it("push が落ちた場合は 502(外部の一手が失敗した — ADR 0052 決定1)", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      publish: async () => {
        throw new Error("failed to push some refs");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", { repo: "x" });

  expect(res.status).toBe(502);
});
