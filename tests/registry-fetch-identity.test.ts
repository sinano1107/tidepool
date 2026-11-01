import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GitHubAuth } from "../src/github-auth.js";
import { refreshRegistry } from "../src/registry.js";
import { type BrokerAnswer, type FakeBroker, issuedToken, startFakeBroker } from "./fake-broker.js";
import { makeRemoteBackedRegistry, writeUnannounced } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

/** 本物の `git` を PATH で差し替えて、盤面が実際に渡した argv と env を捕まえる。
 *
 *  この形を取るのは issue #209 の実測が理由である: ホストに人間の `gh` credential
 *  helper が居ると、machine user を一切使わなくても private な registry の fetch が
 *  **成功してしまう**。したがって「Pi で通った」は合格の証拠にならず、証明できるのは
 *  「盤面がどの名義で撃ったか」を直接見ることだけである。 */
async function gitShim(): Promise<{ cwd: string; record: string; restore: () => void }> {
  const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  const dir = await tempDir("tidepool-git-shim-");
  // 観測したいのは argv と env なので registry の中身は要らない —— github.com の origin を持つ空の checkout で足りる
  // (`remote.origin.url` は盤面が URL と token の宛先を決める読み取り、ADR 0093 / ADR 0339 決定4)
  const cwd = await tempDir("tidepool-git-shim-cwd-");
  gitOut(cwd, "init", "-b", "main");
  gitOut(cwd, "remote", "add", "origin", "https://github.com/acme/registry.git");
  const record = join(dir, "record.txt");
  writeFileSync(record, "");
  writeFileSync(
    join(dir, "git"),
    // 網に出る verb(と、偽の sha を書く update-ref)だけを偽装して記録し、盤面所有の repo の作成や checkout を読む local の git は本物へ渡す。
    // `ls-remote` には原本の sha を答える(ADR 0243 決定3: fetch はその sha を取る)。
    // 子の env は盤面が組み立てる(ADR 0339 決定1)ので、記録先は env でなく script に焼く
    `#!/bin/sh\ncase " $* " in *" ls-remote "*|*" fetch "*|*" push "*|*" update-ref "*) ;; *) exec "${real}" "$@";; esac\necho "---" >> "${record}"\nfor arg in "$@"; do echo "arg=$arg" >> "${record}"; [ "$arg" = "ls-remote" ] && printf '${ORIGIN_SHA}\\trefs/heads/main\\n'; done\necho "GH_TOKEN=\${GH_TOKEN-}" >> "${record}"\necho "GIT_TERMINAL_PROMPT=\${GIT_TERMINAL_PROMPT-}" >> "${record}"\nexit 0\n`,
  );
  chmodSync(join(dir, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path ?? ""}`;
  return {
    cwd,
    record,
    restore: () => {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    },
  };
}

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** shim が答える原本の sha。 */
const ORIGIN_SHA = "1".repeat(40);

/** `verb` を撃った呼び出し1回ぶんの argv と env。 */
function observed(record: string, verb: string): { args: string[]; env: Record<string, string> } {
  const invocations = readFileSync(record, "utf8")
    .split("---\n")
    .map((block) => {
      const lines = block.split("\n").filter(Boolean);
      const args = lines.filter((l) => l.startsWith("arg=")).map((l) => l.slice("arg=".length));
      const env: Record<string, string> = {};
      for (const line of lines.filter((l) => !l.startsWith("arg="))) {
        const eq = line.indexOf("=");
        env[line.slice(0, eq)] = line.slice(eq + 1);
      }
      return { args, env };
    });
  return invocations.find(({ args }) => args.includes(verb))!;
}

const brokers: FakeBroker[] = [];
let restoreShim: (() => void) | undefined;
afterEach(async () => {
  restoreShim?.();
  restoreShim = undefined;
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
  const shim = await gitShim();
  restoreShim = shim.restore;
  const broker = await openBroker(() => issuedToken("installation-token"));

  await refreshRegistry(shim.cwd, new GitHubAuth(await tokenFile("gho_user"), broker.url), writeUnannounced);

  // 網に出る2つ(原本の sha を読む ls-remote と、その sha の fetch)がどちらも同じ名義で撃たれる
  for (const [verb, command] of [
    ["ls-remote", ["ls-remote", "https://github.com/acme/registry.git", "refs/heads/main"]],
    ["fetch", ["fetch", "--quiet", "https://github.com/acme/registry.git", `${ORIGIN_SHA}:refs/board/fetched`]],
  ] as const) {
    const { args, env } = observed(shim.record, verb);
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

// 身元の不在は宣言であって暗黙のフォールバックではない(ADR 0041)。ADR 0339 決定1・2: 床は認証の無い分岐にも掛かり、
// 盤面の `-c` は stall と auto maintenance の停止だけ —— 打ち消しの reset は1つも無い。
it("GitHub 身元を持たない盤面の fetch は credential を1つも渡さない(ADR 0024)", async () => {
  const own = ["-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=30", "-c", "maintenance.auto=false", "-c", "gc.auto=0"];
  const shim = await gitShim();
  restoreShim = shim.restore;

  await refreshRegistry(shim.cwd, undefined, writeUnannounced);

  const lsRemote = observed(shim.record, "ls-remote");
  const fetch = observed(shim.record, "fetch");
  expect([
    { args: lsRemote.args.slice(1), token: lsRemote.env.GH_TOKEN },
    { args: fetch.args.slice(1), token: fetch.env.GH_TOKEN },
  ]).toEqual([
    { args: [...own, "ls-remote", "https://github.com/acme/registry.git", "refs/heads/main"], token: "" },
    { args: [...own, "fetch", "--quiet", "https://github.com/acme/registry.git", `${ORIGIN_SHA}:refs/board/fetched`], token: "" },
  ]);
  expect([lsRemote.args[0], fetch.args[0]]).toEqual([expect.stringMatching(/^--git-dir=/), expect.stringMatching(/^--git-dir=/)]);
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
  const shim = await gitShim();
  restoreShim = shim.restore;
  const broker = await openBroker(() => ({ status: 401, body: { error: "invalid_user_token" } }));

  const result = await refreshRegistry(shim.cwd, new GitHubAuth(await tokenFile("gho_user"), broker.url), writeUnannounced);

  expect({
    available: result.available,
    names: /invalid_user_token/.test(result.reason ?? ""),
    // 仲介が断った時点で fetch は撃たれない — 出て行くのは要求そのものが無い
    fetched: readFileSync(shim.record, "utf8"),
  }).toEqual({ available: false, names: true, fetched: "" });
});
