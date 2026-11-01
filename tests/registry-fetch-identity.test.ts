import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GitHubAuth } from "../src/github-auth.js";
import { refreshRegistry } from "../src/registry.js";
import { type BrokerAnswer, type FakeBroker, issuedToken, startFakeBroker } from "./fake-broker.js";
import { type GitCall, shimGit } from "./harness.js";
import { makeRemoteBackedRegistry, writeUnannounced } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

/** 本物の `git` の前に shim を置いて、盤面が実際に渡した argv と env を捕まえる。
 *
 *  この形を取るのは issue #209 の実測が理由である: ホストに人間の `gh` credential
 *  helper が居ると、machine user を一切使わなくても private な registry の fetch が
 *  **成功してしまう**。したがって「Pi で通った」は合格の証拠にならず、証明できるのは
 *  「盤面がどの名義で撃ったか」を直接見ることだけである。
 *
 *  観測したいのは argv と env なので registry の中身は要らない —— github.com の origin を持つ空の checkout で足りる
 *  (`remote.origin.url` は盤面が URL と token の宛先を決める読み取り、ADR 0093 / ADR 0339 決定4)。網に出る verb と
 *  偽の sha を書く update-ref だけを偽装し、`ls-remote` には原本の sha を答える(ADR 0243 決定3: fetch はその sha を取る)。 */
async function shimmedCheckout(): Promise<{ cwd: string; calls: () => GitCall[] }> {
  const cwd = await tempDir("tidepool-git-shim-cwd-");
  gitOut(cwd, "init", "-b", "main");
  gitOut(cwd, "remote", "add", "origin", "https://github.com/acme/registry.git");
  const calls = await shimGit({ fake: ["ls-remote", "fetch", "push", "update-ref"], lsRemote: `${ORIGIN_SHA}\trefs/heads/main\n` });
  return { cwd, calls };
}

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** shim が答える原本の sha。 */
const ORIGIN_SHA = "1".repeat(40);

/** `verb` を撃った最初の呼び出し(fetch なら盤面所有の repo からの hop1)。 */
function observed(calls: GitCall[], verb: string): GitCall {
  return calls.find(({ args }) => args.includes(verb))!;
}

const brokers: FakeBroker[] = [];
afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.close();
});


/** 立てた仲介は afterEach で必ず閉じる。`GitHubAuth` 自身の観測は
 *  github-auth.test.ts が持つ —— ここが見たいのは「registry の fetch がその
 *  token を持って出たか」の配線だけである。 */
async function openBroker(reply: () => BrokerAnswer): Promise<FakeBroker> {
  const started = await startFakeBroker(reply);
  brokers.push(started);
  return started;
}

async function tokenFile(token: string): Promise<string> {
  const dir = await tempDir("tidepool-secrets-");
  const file = join(dir, "token");
  writeFileSync(file, `${token}\n`);
  chmodSync(file, 0o600);
  return file;
}

// issue #209 の完了条件: 盤面の registry fetch が盤面自身の token で認証され、
// **人間の `gh` credential helper に依存しない**こと。GLOSSARY.md の GitHub identity
// が「盤面が執行する操作は読み取り・書き込み・merge を問わずすべてこの名義」と
// 書いており、registry の refresh は盤面が執行する読み取りである(ADR 0024)。
// ADR 0093 で名義は App になり、子プロセスが運ぶのは**仲介が発行した repo 単位の
// installation token** —— ファイルの中身(user token)ではない。
// ADR 0339: 人間の helper が届かないのは組み立てた env と checkout の外の盤面所有 repo による(github-auth.test.ts が持つ)——
// ここが見るのは、registry の網の2往復が盤面の token と盤面が組んだ URL で出る配線である。
it("盤面の registry fetch は仲介の installation token で、盤面が組んだ URL へ撃たれる(ADR 0093 / ADR 0339 決定4)", async () => {
  const { cwd, calls } = await shimmedCheckout();
  const broker = await openBroker(() => issuedToken("installation-token"));

  await refreshRegistry(cwd, new GitHubAuth(await tokenFile("gho_user"), broker.url), writeUnannounced);

  // 網に出る2つ(原本の sha を読む ls-remote と、その sha の fetch)がどちらも同じ名義で撃たれる
  for (const [verb, command] of [
    ["ls-remote", ["ls-remote", "https://github.com/acme/registry.git", "refs/heads/main"]],
    ["fetch", ["fetch", "--quiet", "https://github.com/acme/registry.git", `${ORIGIN_SHA}:refs/board/fetched`]],
  ] as const) {
    const { args, env } = observed(calls(), verb);
    expect({
      servesToken: args.some((a) => a.includes("password=$GH_TOKEN")),
      command: args.slice(args.indexOf(verb)),
      token: env.GH_TOKEN,
      // 悪い token を「ユーザ名プロンプトで固まる」ではなく即座の失敗にする
      noPrompt: env.GIT_TERMINAL_PROMPT,
    }).toEqual({
      servesToken: true,
      command,
      token: "installation-token",
      noPrompt: "0",
    });
  }
});

// 身元の不在は宣言であって暗黙のフォールバックではない(ADR 0041)。ADR 0339 決定2: 床は認証の無い分岐にも掛かる ——
// 盤面の `-c` の並びは github-auth.test.ts が持つ。
it("GitHub 身元を持たない盤面の fetch は credential を1つも渡さない(ADR 0024)", async () => {
  const { cwd, calls } = await shimmedCheckout();

  await refreshRegistry(cwd, undefined, writeUnannounced);

  expect(
    (["ls-remote", "fetch"] as const).map((verb) => {
      const { args, env } = observed(calls(), verb);
      return { command: args.slice(args.indexOf(verb)), servesToken: args.some((a) => a.includes("password=$GH_TOKEN")), token: env.GH_TOKEN };
    }),
  ).toEqual([
    { command: ["ls-remote", "https://github.com/acme/registry.git", "refs/heads/main"], servesToken: false, token: "" },
    { command: ["fetch", "--quiet", "https://github.com/acme/registry.git", `${ORIGIN_SHA}:refs/board/fetched`], servesToken: false, token: "" },
  ]);
});

// 実物の git でも通ること。ローカル remote は GitHub ではないので token は要求
// されず(ADR 0093: repo を名指しできない呼び出しには credential を渡さない)、
// それでも fetch は成立する。token が盤面自身の process.env へ漏れないことも見る。
it("fetch が実際に origin/main を更新し、token は process.env に残らない", async () => {
  const { registryDir, publish } = await makeRemoteBackedRegistry();
  const before = gitOut(registryDir, "rev-parse", "refs/remotes/origin/main");
  const merged = publish("agents/deckhand.md", "---\nname: deckhand\n---\nstub\n", "merged on remote");

  const result = await refreshRegistry(registryDir, new GitHubAuth(await tokenFile("tok")), writeUnannounced);

  // 「落ちなかった」ではなく「**ref が動いた**」を見る: refspec を間違えても
  // exit 0 は返るので、available だけでは題目を検証したことにならない
  expect({
    available: result.available,
    movedTo: gitOut(registryDir, "rev-parse", "refs/remotes/origin/main"),
    wasStale: before !== merged,
    leaked: process.env.GH_TOKEN,
  }).toEqual({ available: true, movedTo: merged, wasStale: true, leaked: undefined });
});

// ADR 0093 決定7: 仲介の不達も user token の失効も「registry が refresh できな
// かった」1つの答えに畳む —— 盤面側に新しい失敗の語彙を作らないための線であり、
// 既存の到達性 quarantine(ADR 0052)がそのまま受ける。
it("仲介が token を出せなければ registry は到達不能として返る(投げない)", async () => {
  const { cwd, calls } = await shimmedCheckout();
  const broker = await openBroker(() => ({ status: 401, body: { error: "invalid_user_token" } }));

  const result = await refreshRegistry(cwd, new GitHubAuth(await tokenFile("gho_user"), broker.url), writeUnannounced);

  expect({
    available: result.available,
    names: /invalid_user_token/.test(result.reason ?? ""),
    // 仲介が断った時点で網の verb は撃たれない — 出て行くのは要求そのものが無い
    network: calls().filter(({ args }) => args.includes("ls-remote") || args.includes("fetch")),
  }).toEqual({ available: false, names: true, network: [] });
});
