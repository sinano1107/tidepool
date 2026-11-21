import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { GitHubAuth } from "../src/github-auth.js";
import { InvalidAllowedDomainError, InvalidReviewAllowedCommandError, loadRegistry } from "../src/registry.js";
import { UnknownWorkspaceError } from "../src/workspace.js";
import {
  type UpdateWorkspaceInput,
  updateWorkspace,
  WorkspaceConfirmationRequiredError,
  WorkspaceRegistryUnprotectError,
} from "../src/workspace-create.js";
import { issuedToken, startFakeBroker } from "./fake-broker.js";
import { FakeGitHubClient } from "./fakes.js";
import { api, bootTidepool, git, makeWorkspace, shimGit, type Tidepool } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

let t: Tidepool;
afterEach(() => t?.stop());

// ADR 0082 決定1: 一覧は基点ディレクトリを属性として一緒に返す —— 規約導出の
// エントリの着地先を client が合成できる唯一の材料である。
it("GET /api/workspaces は設定面向けの一覧ビューを基点ディレクトリごと返す(issue #57 フェーズ3 / ADR 0082)", async () => {
  const list = {
    workspaces: [
      { name: "registry-edit", path: "/srv/registry-edit", protected: true, protectionReason: "registry_repository" as const },
      { name: "lagoon", repo: "https://github.com/example/lagoon.git", protected: false },
    ],
    workspacesBaseDir: { path: "/mnt/workspaces", source: "configured" as const },
  };
  t = await bootTidepool({ workspaceAdmin: { list: () => list } });

  const res = await api(t.baseUrl, "GET", "/api/workspaces");

  expect(res.status).toBe(200);
  expect(res.json).toEqual(list);
});

it("GET /api/workspaces は registry 未設定なら 503", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "GET", "/api/workspaces")).status).toBe(503);
});

it("PATCH /api/workspaces/:name は URL の名前と body を updateWorkspace へ渡し、200 を返す", async () => {
  const calls: UpdateWorkspaceInput[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", {
    notes: "run npm install",
    protected: true,
  });

  expect(res.status).toBe(200);
  expect(res.json).toEqual({});
  expect(calls).toEqual([{ name: "lagoon", notes: "run npm install", protected: true }]);
});

it("confirm なしの危険な値は 409 + confirm_required + 理由コード列挙 — UI はこれを見て確認 Dialog に進む", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      update: async () => {
        throw new WorkspaceConfirmationRequiredError("lagoon", ["unprotect", "review_allowed_commands_set"]);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { protected: false });

  expect(res.status).toBe(409);
  expect(res.json).toEqual({
    error: expect.any(String),
    confirm_required: true,
    dangerous_values: ["unprotect", "review_allowed_commands_set"],
  });
});

it("PATCH は review_allowed_commands を confirm ごと updateWorkspace へ渡す(ADR 0061 決定1)", async () => {
  const calls: UpdateWorkspaceInput[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", {
    review_allowed_commands: ["npm test"],
    confirm: true,
  });

  expect(res.status).toBe(200);
  expect(calls).toEqual([
    { name: "lagoon", review_allowed_commands: ["npm test"], confirm: true },
  ]);
});

it("PATCH は allowed_domains を confirm ごと updateWorkspace へ渡す(ADR 0072)", async () => {
  const calls: UpdateWorkspaceInput[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", {
    allowed_domains: ["registry.npmjs.org"],
    confirm: true,
  });

  expect(res.status).toBe(200);
  expect(calls).toEqual([
    { name: "lagoon", allowed_domains: ["registry.npmjs.org"], confirm: true },
  ]);
});

it("文法違反の review_allowed_commands は 400 — confirm では買えない失敗", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      update: async () => {
        throw new InvalidReviewAllowedCommandError("npm test,rm -rf /", "a comma would inject");
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", {
    review_allowed_commands: ["npm test,rm -rf /"],
    confirm: true,
  });

  expect(res.status).toBe(400);
});

it("文法違反の allowed_domains は 400 — confirm では買えない失敗", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      update: async () => {
        throw new InvalidAllowedDomainError("100.100.100.100", "IP literals are not allowed");
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", {
    allowed_domains: ["100.100.100.100"],
    confirm: true,
  });

  expect(res.status).toBe(400);
});

it("origin による保護の解除は確認付きでも 403 になる", async () => {
  const refusal = new WorkspaceRegistryUnprotectError("registry-edit", {
    reason: "registry_repository",
    repo: "https://github.com/octocat/registry.git",
  });
  t = await bootTidepool({
    workspaceAdmin: {
      update: async () => {
        throw refusal;
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/registry-edit", {
    protected: false,
    confirm: true,
  });

  expect(res.status).toBe(403);
  expect(res.json).toEqual({ error: refusal.message });
});

it("registry に居ない名前は 404", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      update: async () => {
        throw new UnknownWorkspaceError("ghost");
      },
    },
  });

  expect((await api(t.baseUrl, "PATCH", "/api/workspaces/ghost", { notes: "x" })).status).toBe(
    404,
  );
});

// ADR 0395 決定2: 出元 repo の値の検査と危険な値の門 —— 本物の扉(updateWorkspace)を fake の GitHub client で束ねる
describe("出元 repo の宣言(ADR 0395 決定2)", () => {
  async function headRepoBoard(githubAuth?: GitHubAuth) {
    const checkout = await makeWorkspace("lagoon");
    const yaml = `lagoon:\n  path: ${JSON.stringify(checkout.path)}\n  repo: https://github.com/acme/lagoon.git\n`;
    const registryDir = await makeRegistry({ "workspaces.yaml": yaml });
    git(registryDir, "remote", "add", "origin", "https://github.com/acme/registry.git");
    const registry = { dir: registryDir, mode: "purely-local" as const };
    const github = new FakeGitHubClient();
    github.scriptRepositoryParent("acme/fork", "acme/lagoon");
    github.scriptRepositoryParent("acme/registry", null);
    github.scriptRepositoryParent("acme/lagoon", null);
    github.scriptRepositoryParent("acme/stranger", "acme/elsewhere");
    t = await bootTidepool({ workspaceAdmin: { update: (input) => updateWorkspace(input, { db: t.db, github, githubAuth, registry, workspacesBaseDir: t.dir }) } });
    const entry = () => loadRegistry(registryDir, "purely-local").workspaces.lagoon!;
    // 扉の外の手編集(registry-edit の PR の merge と同じ形)
    const handEdit = (head: string) => {
      writeFileSync(join(registryDir, "workspaces.yaml"), `${yaml}  head_repo: ${head}\n`);
      git(registryDir, "commit", "-am", "hand edit");
    };
    return { checkout, github, entry, handEdit, registryDir };
  }

  it("出元 repo の差し替えは危険な値の確認を求め、確認すれば宣言・remote・覚えた値を書く", async () => {
    const { checkout, entry, handEdit } = await headRepoBoard();

    const unconfirmed = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { head_repo: "acme/fork" });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.json).toMatchObject({ confirm_required: true, dangerous_values: ["head_repo_set"] });
    expect(entry().head_repo).toBeUndefined();

    const confirmed = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { head_repo: "acme/fork", confirm: true });
    expect(confirmed.status).toBe(200);
    expect(entry().head_repo).toBe("acme/fork");
    expect(git(checkout.path, "config", "remote.head-repo.url")).toBe("https://github.com/acme/fork.git");
    expect(git(checkout.path, "remote")).toBe("head-repo");

    // 外すのは安全側なので確認は要らない。扉は書く前に覚えた値と宣言を比べるので、通ること自体が扉が覚えた証拠
    const removed = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { head_repo: "" });
    expect(removed.status).toBe(200);
    expect(entry().head_repo).toBeUndefined();
    expect(git(checkout.path, "remote")).toBe("");

    // 扉の外で足した出元 repo は、扉も素通りしない
    handEdit("acme/fork");
    const afterHandEdit = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { head_repo: "acme/fork", confirm: true });
    expect(afterHandEdit.status).toBe(400);
    expect(afterHandEdit.json).toMatchObject({
      error: "workspace lagoon declares head repo acme/fork, but the board never recorded one for it. Clear the head repo in the workspace settings, or remove `head_repo:` by hand, and answer; then set it there to use it.",
    });

    // 外すのは閉じる側なので、扉の外の値でも扉から外せる —— その後は扉から設定し直せる(#3560)
    const cleared = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { head_repo: "" });
    expect(cleared.status).toBe(200);
    expect(entry().head_repo).toBeUndefined();
    const reset = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { head_repo: "acme/fork", confirm: true });
    expect(reset.status).toBe(200);
    expect(entry().head_repo).toBe("acme/fork");

    // 同じ値をもう一度通しても壊れない(ADR 0395 決定3 の段2 の撃ち直しの扉)—— registry の書き込みは変更が無ければ何も積まない
    const resent = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { head_repo: "acme/fork", confirm: true });
    expect(resent.status).toBe(200);
    expect(entry().head_repo).toBe("acme/fork");
    expect(git(checkout.path, "config", "remote.head-repo.url")).toBe("https://github.com/acme/fork.git");
  });

  it("URL の綴り(資格情報つき)で送った出元 repo は owner/name に直して書き、資格情報を registry に残さない", async () => {
    const { checkout, entry, registryDir } = await headRepoBoard();

    const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { head_repo: "https://someone:dummy-token@github.com/Acme/Fork.git", confirm: true });

    expect(res.status).toBe(200);
    expect(entry().head_repo).toBe("acme/fork");
    expect(readFileSync(join(registryDir, "workspaces.yaml"), "utf8")).not.toContain("dummy-token");
    expect(git(checkout.path, "config", "remote.head-repo.url")).toBe("https://github.com/acme/fork.git");
  });

  // ADR 0395 決定3 の段2: 宣言の後に扉が `task/*` を1本ずつ出元 repo へ送る。段1 の不変条件は持ち込まない —— 失敗しても宣言は残り、
  // 同じ値をもう一度通せば送り直す。出元 repo は GitHub の名前なので、盤面が組んだ URL を shim で手元の bare へ回す
  it("出元 repo を宣言すると task/* が出元 repo へ送られ、送れなかった枝があっても宣言は残り、同じ値をもう一度通すと送り直す", async () => {
    const broker = await startFakeBroker((request) => issuedToken(`token-for-${request.repo}`));
    onTestFinished(() => broker.close());
    const tokenFile = join(await tempDir("tidepool-token-"), "token");
    writeFileSync(tokenFile, "gho_test\n", { mode: 0o600 });
    const { checkout, entry } = await headRepoBoard(new GitHubAuth(tokenFile, broker.url));
    git(checkout.path, "branch", "task/aaa");
    git(checkout.path, "branch", "task/bbb");
    git(checkout.path, "branch", "feature");
    const sha = git(checkout.path, "rev-parse", "main");
    const fork = await tempDir("tidepool-fork-");
    git(fork, "init", "--bare", "-b", "main");
    // fork の task/aaa は盤面の知らない履歴にある —— non-fast-forward で拒まれる
    const outside = await tempDir("tidepool-outside-");
    git(outside, "init", "-b", "main");
    git(outside, "commit", "--allow-empty", "-m", "diverged on the fork");
    git(outside, "push", fork, "main:refs/heads/task/aaa");
    const diverged = git(fork, "rev-parse", "task/aaa");
    const calls = await shimGit({ route: ["https://github.com/acme/fork.git", fork] });
    const forkBranches = () => git(fork, "for-each-ref", "--format=%(refname:lstrip=2) %(objectname)", "refs/heads/");
    const copies = () => git(checkout.path, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/");

    const failed = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { head_repo: "acme/fork", confirm: true });

    expect(failed.status).toBe(502);
    expect(failed.json.error).toMatch(
      /^The head repo acme\/fork of workspace lagoon was saved, but these task branches were not sent to it: task\/aaa \(.+\)\. Set the same head repo again to send them\.$/s,
    );
    // remote の値は上のテストが確かめる —— shim は盤面の `remote set-url` の引数も書き換える
    expect(entry().head_repo).toBe("acme/fork");
    expect(forkBranches()).toBe(`task/aaa ${diverged}\ntask/bbb ${sha}`);
    expect(copies()).toBe(`refs/remotes/head-repo/task/bbb ${sha}`);
    // 1本ずつの push は、どれも出元 repo に絞った token で撃たれる
    const pushes = calls().filter(({ args }) => args.includes("push"));
    expect(pushes.map(({ args, env }) => [args.at(-1), env.GH_TOKEN])).toEqual([
      [`${sha}:refs/heads/task/aaa`, "token-for-acme/fork"],
      [`${sha}:refs/heads/task/bbb`, "token-for-acme/fork"],
    ]);

    git(fork, "update-ref", "-d", "refs/heads/task/aaa");
    const again = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { head_repo: "acme/fork", confirm: true });

    expect(again.status).toBe(200);
    expect(entry().head_repo).toBe("acme/fork");
    expect(forkBranches()).toBe(`task/aaa ${sha}\ntask/bbb ${sha}`);
    expect(copies()).toBe(`refs/remotes/head-repo/task/aaa ${sha}\nrefs/remotes/head-repo/task/bbb ${sha}`);
  });

  it.each([
    ["宣言 repo そのもの", "acme/lagoon", "head repo acme/lagoon is workspace \"lagoon\"'s own repo; it must be a fork of it."],
    ["registry の repo", "acme/registry", "head repo acme/registry is the registry's repository; it must be a fork of workspace \"lagoon\"'s repo."],
    ["宣言 repo の fork でない repo", "acme/stranger", "head repo acme/stranger is not a fork of https://github.com/acme/lagoon.git: GitHub reports its parent as acme/elsewhere."],
    ["親を読めない repo", "acme/unreadable", "the parent of head repo acme/unreadable could not be read from GitHub, so it is refused (gh: Not Found (HTTP 404) for repos/acme/unreadable). Install the App on its owner and try again."],
    ["GitHub でない値", "../somewhere", "head repo ../somewhere must be a GitHub repository written as owner/name."],
  ])("%sは確認があっても 400 で拒まれ、宣言も remote も書かない", async (_, head, error) => {
    const { checkout, entry } = await headRepoBoard();

    const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { head_repo: head, confirm: true });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error });
    expect(entry().head_repo).toBeUndefined();
    expect(git(checkout.path, "remote")).toBe("");
  });
});
