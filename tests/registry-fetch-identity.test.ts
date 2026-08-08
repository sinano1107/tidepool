import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GitHubAuth } from "../src/github-auth.js";
import { fetchRegistryRef } from "../src/registry.js";
import { makeRemoteBackedRegistry } from "./registry-fixture.js";

/** 本物の `git` を PATH で差し替えて、盤面が実際に渡した argv と env を捕まえる。
 *
 *  この形を取るのは issue #209 の実測が理由である: ホストに人間の `gh` credential
 *  helper が居ると、machine user を一切使わなくても private な registry の fetch が
 *  **成功してしまう**。したがって「Pi で通った」は合格の証拠にならず、証明できるのは
 *  「盤面がどの名義で撃ったか」を直接見ることだけである。 */
async function gitShim(): Promise<{ cwd: string; record: string; restore: () => void }> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-git-shim-"));
  // git は実在する cwd でしか起動できない: 観測したいのは argv と env なので
  // registry の中身は要らず、空のディレクトリで足りる
  const cwd = await mkdtemp(join(tmpdir(), "tidepool-git-shim-cwd-"));
  const record = join(dir, "record.txt");
  writeFileSync(record, "");
  writeFileSync(
    join(dir, "git"),
    `#!/bin/sh\nfor arg in "$@"; do echo "arg=$arg" >> "$TIDEPOOL_GIT_SHIM_RECORD"; done\necho "GH_TOKEN=\${GH_TOKEN-}" >> "$TIDEPOOL_GIT_SHIM_RECORD"\necho "GIT_TERMINAL_PROMPT=\${GIT_TERMINAL_PROMPT-}" >> "$TIDEPOOL_GIT_SHIM_RECORD"\nexit 0\n`,
  );
  chmodSync(join(dir, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path ?? ""}`;
  process.env.TIDEPOOL_GIT_SHIM_RECORD = record;
  return {
    cwd,
    record,
    restore: () => {
      process.env.PATH = path;
      delete process.env.TIDEPOOL_GIT_SHIM_RECORD;
    },
  };
}

function observed(record: string): { args: string[]; env: Record<string, string> } {
  const lines = readFileSync(record, "utf8").split("\n").filter(Boolean);
  const args = lines.filter((l) => l.startsWith("arg=")).map((l) => l.slice("arg=".length));
  const env: Record<string, string> = {};
  for (const line of lines.filter((l) => !l.startsWith("arg="))) {
    const eq = line.indexOf("=");
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { args, env };
}

let restoreShim: (() => void) | undefined;
afterEach(() => {
  restoreShim?.();
  restoreShim = undefined;
});

async function tokenFile(token: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-secrets-"));
  const file = join(dir, "token");
  writeFileSync(file, `${token}\n`);
  chmodSync(file, 0o600);
  return file;
}

// issue #209 の完了条件: 盤面の registry fetch が machine user の token で認証され、
// **人間の `gh` credential helper に依存しない**こと。CONTEXT.md の GitHub identity
// が「盤面が執行する操作は読み取り・書き込み・merge を問わずすべてこの名義」と
// 書いており、registry の refresh は盤面が執行する読み取りである(ADR 0024)。
it("盤面の registry fetch は machine user の token で撃たれ、ホストの helper を先に消す(ADR 0024)", async () => {
  const shim = await gitShim();
  restoreShim = shim.restore;

  fetchRegistryRef(shim.cwd, new GitHubAuth(await tokenFile("machine-user-token")));

  const { args, env } = observed(shim.record);
  // 空の helper が先頭に来ることが要点である。これは「認証を足す」だけでなく
  // osxkeychain や `gh auth setup-git` —— Pi に実在する人間の identity —— を
  // **消す**引数であり、独立性はこれ1つに掛かっている。
  expect(args.indexOf("credential.helper=")).toBeLessThan(args.indexOf("fetch"));
  expect({
    clearsAmbientHelper: args.includes("credential.helper="),
    servesToken: args.some((a) => a.includes("password=$GH_TOKEN")),
    fetch: args.slice(-4),
    token: env.GH_TOKEN,
    // 悪い token を「ユーザ名プロンプトで固まる」ではなく即座の失敗にする
    noPrompt: env.GIT_TERMINAL_PROMPT,
  }).toEqual({
    clearsAmbientHelper: true,
    servesToken: true,
    fetch: ["fetch", "--quiet", "origin", "main"],
    token: "machine-user-token",
    noPrompt: "0",
  });
});

// 身元の不在は宣言であって暗黙のフォールバックではない(ADR 0041)。ここで credential
// 引数を付けてしまうと、token を持たない盤面が「空の helper」だけを渡すことになり、
// ホストの正当な設定を消したうえで何も渡さない —— 一番悪い形になる。
it("GitHub 身元を持たない盤面の fetch は credential を1つも渡さない(ADR 0024)", async () => {
  const shim = await gitShim();
  restoreShim = shim.restore;

  fetchRegistryRef(shim.cwd, undefined);

  const { args, env } = observed(shim.record);
  expect({ args, token: env.GH_TOKEN }).toEqual({
    args: ["fetch", "--quiet", "origin", "main"],
    token: "",
  });
});

// 実物の git でも通ること(ローカル remote では helper は無害 —— github-auth.test.ts
// の push / clone と同じ型)。token が盤面自身の process.env へ漏れないことも見る。
it("認証つき fetch が実際に origin/main を更新し、token は process.env に残らない", async () => {
  const { registryDir, publish } = await makeRemoteBackedRegistry();
  publish("agents/deckhand.md", "---\nname: deckhand\n---\nstub\n", "merged on remote");

  const result = fetchRegistryRef(registryDir, new GitHubAuth(await tokenFile("tok")));

  expect({ available: result.available, leaked: process.env.GH_TOKEN }).toEqual({
    available: true,
    leaked: undefined,
  });
});
