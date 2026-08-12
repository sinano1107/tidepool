import { afterEach, expect, it } from "vitest";
import { RepoAccessMissingError } from "../src/repo-access.js";
import { UnknownWorkspaceError } from "../src/workspace.js";
import {
  CheckoutHasOriginError,
  GitHubIdentityMissingError,
  type PublishWorkspaceInput,
  RegistrySelfPublishError,
  WorkspaceAlreadyPublishedError,
} from "../src/workspace-create.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

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
  ["checkout already has origin", new CheckoutHasOriginError("sandbox", "https://example/y.git")],
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

// ADR 0013 と同じ形の、確認でも出し直しでも買えない拒否 —— unprotect の 403 に揃える
it("registry clone 自身の publish は 403", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      publish: async () => {
        throw new RegistrySelfPublishError("registry");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces/registry/publish", { repo: "x" });

  expect(res.status).toBe(403);
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
