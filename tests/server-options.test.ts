import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { type BoardComposition, buildServerOptions, WATCHDOG } from "../src/server-options.js";
import { FakeClock, FakeTranslationClient, ScriptedWorker } from "./fakes.js";
import { TEST_CREDENTIAL } from "./harness.js";

/** 盤面1台ぶんの入力。**ServerOptions のキーは1つも含まない**ので、この
 *  テストは自分が検査している一覧を写し取ることが構造的にできない —— 口の一覧を
 *  持つのは `buildServerOptions` だけで、ここが渡すのは env 由来のスカラと部品
 *  だけである。
 *
 *  `registryDir` は未設定にする: registry 由来の口がすべてそこ1つに掛かって
 *  いるので、ディスクを一切触らずに本番と同じ組み立てを走らせられる。 */
function composition(): BoardComposition {
  const clock = new FakeClock();
  return {
    dbPath: ":memory:",
    port: 0,
    mcpPort: 0,
    credential: TEST_CREDENTIAL,
    clock,
    worker: () => new ScriptedWorker(clock),
    registryDir: undefined,
    workspaceName: "sandbox",
    workspacesDir: "/nonexistent/workspaces",
    defaultAgentName: "tako",
    auditorName: "shako",
    boardState: [],
    githubAuth: undefined,
    vapid: undefined,
    translationClient: new FakeTranslationClient(),
  };
}

const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

// #172 そのもの。本番の盤面は watchdog を**必ず**持つ — 持たない盤面は、詰まった
// セッションが唯一の slot を握ったまま誰にも回収されない盤面である。
it("組み立てられたオプションは watchdog を持つ(#172)", () => {
  const options = buildServerOptions(composition());

  expect(options.watchdog).toBe(WATCHDOG);
});

// 値は「一晩を無駄にしない上限」と「正常な長時間タスクを殺さない下限」の間の判断で
// あって導出ではないので、動かすときに目に入るようここで固定する。すべて分単位に
// 量子化される — WATCHDOG_TICK が 60秒なので、それ未満の差は tick に丸められる。
it("時間リミットは work=90分 / review=45分、猶予は 1 tick(#172)", () => {
  expect(WATCHDOG).toEqual({
    timeLimits: { work: 90 * 60_000, review: 45 * 60_000 },
    grace: 60_000,
  });
});

// question は**意図的に監視しない**。人間の回答を待つタスクを時限で殺すのは端的に
// 誤りで、しかも `Partial<Record<TaskType, number>>` は「キーを書かない」ことでしか
// それを表現できない。`question: undefined` を書くとキーは生えるが、watchdog.ts は
// `limit === undefined` で抜けるので挙動は同じ — 型ではなく形で意図を残すため、
// キーの不在そのものを主張する。
it("question には時間リミットを持たせない(#172)", () => {
  expect("question" in WATCHDOG.timeLimits).toBe(false);
});

/** #172 の穴は「型が任意で、テスト盤面だけが渡していた」ために誰にも気づかれ
 *  なかった。ServerOptions の任意フィールドを**ソースから読み直して**、本番が
 *  実際に組み立てたオブジェクトと突き合わせるので、口を1つ落とせばその名前で
 *  ここが落ちる。 */
it("ServerOptions の任意フィールドは authority を除いて全て組み立てられる(#172)", () => {
  const body = (() => {
    const s = source("server.ts");
    const rest = s.slice(s.indexOf("export interface ServerOptions {"));
    return rest.slice(0, rest.indexOf("\n}\n"));
  })();
  // インターフェース直下(インデント2)の任意フィールドだけ。入れ子の
  // `boardState` / `containment` の中身はインデント4なので拾わない。
  const optional = [...body.matchAll(/^ {2}(\w+)\?:/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
  // 走査そのものが壊れていないことの control。件数だけでは正規表現が**部分的に**
  // 効かなくなった場合を見逃すので、性質の違う3つを名指しで要求する:
  // 素の口・短縮記法で渡される口・入れ子の口。
  expect(optional).toEqual(expect.arrayContaining(["watchdog", "github", "containment"]));

  const emitted = new Set(Object.keys(buildServerOptions(composition())));
  // 意図的な不在は `authority` だけ(ADR 0012 / issue #36 の `resolveAuthority` に
  // 置換済み)。**この期待値は src ではなくここに置く** — 除外を1つ増やすことは
  // 「その口は本番で永久に立たない」という宣言であり、#172 と同じ穴を開け直す
  // 行為でもあるので、src 側の1行で自動的に緑へ戻せてはいけない。
  expect(optional.filter((key) => !emitted.has(key))).toEqual(["authority"]);
});

/** 上の網羅は `buildServerOptions` の戻り値を見ている。main.ts がその戻り値で
 *  盤面を起こしていなければ空振りする —— そして main.ts は top-level await の
 *  スクリプトなので、import して確かめることができない(import した瞬間に盤面が
 *  起動する)。残る観測手段はソースである。
 *
 *  主張するのは呼び出しの**形**ではなく2点だけ: 組み立てを経由していること、
 *  そして口の一覧が main.ts に戻っていないこと。中間変数を挟むリファクタでは
 *  赤くならない。 */
it("main.ts は buildServerOptions が組み立てたオプションで盤面を起こす(#172)", () => {
  const main = source("main.ts");

  expect(main).toMatch(/\bbuildServerOptions\(/);
  expect(main).not.toMatch(/startServer\(\s*\{/);
});
