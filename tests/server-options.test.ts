import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildServerOptions, type ServerOptionParts, WATCHDOG } from "../src/server-options.js";
import { FakeClock, ScriptedWorker } from "./fakes.js";
import { TEST_CREDENTIAL } from "./harness.js";

/** 合成 root(main.ts)が組み立てる部品を、**このファイルで手ずから全件**書く。
 *  `ServerOptionParts` の型は全キー必須なので、ServerOptions に任意フィールドが
 *  1つ増えるとここが型エラーで落ちる — それが狙いで、この関数は下の網羅テストに
 *  とっての**独立した列挙**である。ここを harness や main.ts から借りてくると、
 *  「盤面の配線を盤面の配線で検査する」形(#172 を素通しさせた形そのもの)に戻る。
 *
 *  値は一切主張しない: 観測するのは**どのキーが出るか**だけなので、任意の口は
 *  すべて undefined でよい。 */
function parts(): ServerOptionParts {
  const clock = new FakeClock();
  return {
    dbPath: ":memory:",
    port: 0,
    mcpPort: 0,
    credential: TEST_CREDENTIAL,
    clock,
    worker: () => new ScriptedWorker(clock),
    workspace: undefined,
    resolveWorkspace: undefined,
    github: undefined,
    resolveAuthority: undefined,
    registryCandidates: undefined,
    draftClient: undefined,
    agentRegistered: undefined,
    push: undefined,
    vapidPublicKey: undefined,
    auditorName: undefined,
    isProtectedWorkspace: undefined,
    fableAgents: undefined,
    listAgents: undefined,
    workspaceAdmin: undefined,
    agentAdmin: undefined,
    profileAdmin: undefined,
    hostSkills: undefined,
    translationClient: undefined,
    boardState: undefined,
    containment: undefined,
  };
}

const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

// #172 そのもの。本番の盤面は watchdog を**必ず**持つ — 持たない盤面は、詰まった
// セッションが唯一の slot を握ったまま誰にも回収されない盤面である。
it("組み立てられたオプションは watchdog を持つ(#172)", () => {
  const options = buildServerOptions(parts());

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
 *  なかった。ServerOptions の任意フィールドを**ソースから読み直して**突き合わせる
 *  ので、新しい口が増えて main.ts が渡し忘れれば、その口の名前でここが落ちる。
 *
 *  `ServerOptionParts` の型(任意を必須へ反転させる写像型)が同じことを
 *  コンパイル時にやるが、型だけでは「意図的な不在」の一覧に黙って1行足して
 *  すり抜ける道が残る。ここはその一覧が育っていないことを実行時に見張る。 */
it("ServerOptions の任意フィールドは authority を除いて全て組み立てられる(#172)", () => {
  const body = (() => {
    const s = source("server.ts");
    const rest = s.slice(s.indexOf("export interface ServerOptions {"));
    return rest.slice(0, rest.indexOf("\n}\n"));
  })();
  // インターフェース直下(インデント2)の任意フィールドだけ。入れ子の
  // `boardState` / `containment` の中身はインデント4なので拾わない。
  const optional = [...body.matchAll(/^ {2}(\w+)\?:/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
  expect(optional.length).toBeGreaterThan(20); // 走査そのものが壊れていないことの control

  const emitted = new Set(Object.keys(buildServerOptions(parts())));
  // `authority` だけが意図的な不在 — ADR 0012 / issue #36 の `resolveAuthority` に
  // 置換済みで、両方を渡すと後者が前者を覆う(server.ts の doc コメント)。
  expect(optional.filter((key) => !emitted.has(key))).toEqual(["authority"]);
});

/** ここまでのテストは `buildServerOptions` の戻り値しか見ていない。main.ts が
 *  その戻り値を実際に startServer へ渡していなければ全部が空振りする —— そして
 *  main.ts は top-level await のスクリプトなので、import して確かめることが
 *  できない(import した瞬間に盤面が起動する)。残る観測手段はソースである。 */
it("main.ts は buildServerOptions の戻り値をそのまま startServer に渡す(#172)", () => {
  const main = source("main.ts");

  expect(main).toMatch(/startServer\(\s*buildServerOptions\(/);
  // リテラルを直に渡す形が残っていない = 口の一覧が2箇所に分かれていない
  expect(main).not.toMatch(/startServer\(\s*\{/);
});
