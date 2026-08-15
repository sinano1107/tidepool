import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { GitHubAuth } from "../src/github-auth.js";
import {
  type BoardComposition,
  buildServerOptions,
  buildWorkerOptions,
  declaredRegistryMode,
  WATCHDOG,
} from "../src/server-options.js";
import { FakeClock, FakeTranslationClient } from "./fakes.js";
import { TEST_CREDENTIAL } from "./harness.js";
import { makeRegistry, makeRemoteBackedRegistry } from "./registry-fixture.js";

/** 盤面1台ぶんの入力。渡すのは env 由来のスカラと、合成 root でしか作れない
 *  部品だけで、**口の一覧はここには無い** —— 一覧を持つのは `buildServerOptions`
 *  と `buildWorkerOptions` だけである。
 *
 *  ADR 0041 §1 はこれを「`ServerOptions` のキーを1つも含まない」と書き、再演は
 *  **構造的に**不可能だとしていたが、**それは文字通りには成立していない**
 *  (ADR 0043 の訂正): `dbPath` / `port` / `mcpPort` / `credential` / `clock` /
 *  `auditorName` は同名同義のまま残っている。したがってこのテストを守っている
 *  のは入力の型の純度ではなく、**下の実行時の突き合わせ**そのものである
 *  —— 口を1つ落とせばその名前で落ちる、という性質のほうを信頼すること。
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
    registryDir: undefined,
    registryMode: "purely-local",
    logDir: "/nonexistent/worker-logs",
    advisorDisabled: false,
    workspaceName: "sandbox",
    workspacesDir: "/nonexistent/workspaces",
    workspacesDirSource: "configured",
    defaultAgentName: "tako",
    auditorName: "shako",
    boardState: [],
    githubAuth: undefined,
    vapid: undefined,
    translationClient: new FakeTranslationClient(),
    cliAuthExpiresAt: undefined,
  };
}

// ADR 0052 決定3 の宣言そのもの。main.ts の三項をここへ引き出してあるのは、
// **main.ts が import した瞬間に盤面が起動する top-level await のスクリプト**で、
// 向こうに置いた分岐はどのテストからも触れないからである(ADR 0041 §1 と同じ理由)。
it("registryDir を設定した盤面は remote-backed を宣言する。clone は覗かない(ADR 0052)", () => {
  expect({
    configured: declaredRegistryMode("/some/registry/clone"),
    absent: declaredRegistryMode(undefined),
  }).toEqual({ configured: "remote-backed", absent: "purely-local" });
});

// spawn がどの ref を読むかは worker options の口に載っていなければ決まらない
// (ADR 0043: 口の一覧を持つ唯一の場所)。落とすと worker はローカル main へ落ち、
// 盤面側の resolver だけが remote を読む——という ADR 0052 が直した壊れ方に戻る。
it("worker options は宣言された registryMode を運ぶ(ADR 0052 / ADR 0043)", async () => {
  const registryDir = await makeRegistry();
  dirs.push(registryDir);
  const clock = new FakeClock();

  const options = buildWorkerOptions(
    { ...composition(), registryDir, registryMode: "remote-backed", workspaceName: "tidepool" },
    { db: openDb(":memory:"), clock },
  );

  expect(options.registry.mode).toBe("remote-backed");
});

it("remote-backed registry を宣言した盤面は到達性検査を持つ(ADR 0052)", async () => {
  const { registryDir } = await makeRemoteBackedRegistry();
  dirs.push(registryDir);

  const options = buildServerOptions({
    ...composition(),
    registryDir,
    registryMode: "remote-backed",
    workspaceName: "tidepool",
  });

  expect(options.registryReachability).toBeTypeOf("function");
  // 上の purely-local な1本との対(ADR 0041 §5 の「解決子ごとに別々の答え」): pickup が
  // 読む `registry` の mode は**宣言から**来ていて、clone を覗いた結果ではない
  expect(options.registry).toEqual({ dir: registryDir, mode: "remote-backed" });
});

// Codex のレビュー指摘そのものの筋書き。`git remote remove` は remote-tracking ref
// も一緒に消すので、**quarantine question 自身が人間に促す修理**(credential や URL
// を直すための remote の張り直し)の直後がこの状態になる。ここで起動を拒むと、
// ADR 0036 が復旧経路と定めた人間面ごと開かない —— 機能が指示した修理手順を機能
// 自身が塞ぐ。起動時 refresh を `startServer` ではなく合成 root の先頭に置くのは
// このためで、`workspace` と draft の candidates はここで即座に registry を読む。
it("origin/main がまだ無い remote-backed 盤面でも、起動時 refresh が先に走って合成できる(ADR 0052)", async () => {
  const { registryDir } = await makeRemoteBackedRegistry();
  dirs.push(registryDir);
  // remote は生きているが tracking ref だけが無い = 張り直した直後の姿
  execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: registryDir });

  const options = buildServerOptions({
    ...composition(),
    registryDir,
    registryMode: "remote-backed",
    workspaceName: "tidepool",
  });

  expect(options.listAgents?.().map((agent) => agent.name)).toEqual(["deckhand"]);
});

// 決定4 の fail-open。remote へ届かないこと自体は起動を拒む理由にならない —— 床は
// pickup ゲートの1枚だけで、ここは騒ぐだけである。
it("起動時 refresh が失敗しても合成は落ちず、理由を1度だけ警告する(ADR 0052)", async () => {
  const { registryDir } = await makeRemoteBackedRegistry();
  dirs.push(registryDir);
  execFileSync("git", ["remote", "set-url", "origin", "/nonexistent/registry-remote"], {
    cwd: registryDir,
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  const options = buildServerOptions({
    ...composition(),
    registryDir,
    registryMode: "remote-backed",
    workspaceName: "tidepool",
  });

  expect({
    composed: options.listAgents?.().map((agent) => agent.name),
    warnings: error.mock.calls.length,
    warning: error.mock.calls.flat().join(" "),
  }).toMatchObject({
    composed: ["deckhand"],
    warnings: 1,
    warning: expect.stringContaining("[registry] startup refresh failed"),
  });
  error.mockRestore();
});

// ローカル `main` は fixture のまま据え置き、変更はリモートにだけ載せる —— PR が
// GitHub 上で merge され、ホストの checkout はまだ動いていない状態そのもの。
it("remote-backed の registry resolver は origin/main の内容を返す(ADR 0052)", async () => {
  const { registryDir, publish } = await makeRemoteBackedRegistry();
  dirs.push(registryDir);
  publish(
    "agents/deckhand.md",
    `---\nname: deckhand\ndescription: Definition from remote main\nversion: 0.4.0\nauthority: standard\nskills:\n  - "*"\n---\nRemote definition.\n`,
    "remote registry definition",
  );

  const options = buildServerOptions({
    ...composition(),
    registryDir,
    registryMode: "remote-backed",
    workspaceName: "tidepool",
  });

  expect(options.listAgents?.()[0]?.description).toBe("Definition from remote main");
});

const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

/** `src/<file>` の `export interface <name>` から、**インターフェース直下**
 *  (インデント2)の任意フィールド名を読む。ソースを読み直すのが要点である ——
 *  型を import すると、テストが観測するのは自分が書いた期待値の写しになる。
 *  入れ子のフィールド(`boardState` / `containment` の中身はインデント4)は
 *  拾わない。 */
function optionalFields(file: string, name: string): string[] {
  const s = source(file);
  const rest = s.slice(s.indexOf(`export interface ${name} {`));
  const body = rest.slice(0, rest.indexOf("\n}\n"));
  return [...body.matchAll(/^ {2}(\w+)\?:/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
}

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

// question に値を書いても**死んだ設定**にしかならない: pickup の抽出が
// `t.type <> 'question'` で question を外し(tasks.ts の `nextSlotTask`)、
// `in_progress` を立てるのは `pickupTask` だけなので、watchdog の tick が
// question 型のタスクを見ることは起こり得ない。キーの不在そのものを主張するのは、
// 将来の読者が「watchdog が question も governs する」と読める1行を足さないため。
// (`question: undefined` でも挙動は同じ — watchdog.ts は `limit === undefined`
// で抜ける。ここで見張っているのは挙動ではなく含意である。)
it("question には時間リミットを持たせない(#172)", () => {
  expect("question" in WATCHDOG.timeLimits).toBe(false);
});

/** #172 の穴は「型が任意で、テスト盤面だけが渡していた」ために誰にも気づかれ
 *  なかった。ServerOptions の任意フィールドを**ソースから読み直して**、本番が
 *  実際に組み立てたオブジェクトと突き合わせるので、口を1つ落とせばその名前で
 *  ここが落ちる。 */
it("ServerOptions の任意フィールドは authority を除いて全て組み立てられる(#172)", () => {
  const optional = optionalFields("server.ts", "ServerOptions");
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

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** ADR 0043 / issue #33: 同じ網羅を **worker options 層**にも掛ける。
 *
 *  ADR 0041 は `ClaudeWorkerOptions` を「#172 の類ではない」と除外していたが、
 *  その根拠は当時の任意フィールドが `spawn` / `pty` / `enumerateSkills` ——
 *  **不在 = 実物を使う**というテスト用の注入 seam —— だけだったことにある。
 *  advisor の kill switch は機能そのもので、渡し忘れれば「緊急マスクが効かない」
 *  形で fail-open に壊れる: 全部が健康に見えたまま advisor が止まらない。
 *  除外一覧をテスト側に置くのは ADR 0041 §3 と同じ理由 —— 除外を1つ増やすことは
 *  「その口は本番で永久に立たない」という宣言だからである。 */
it("ClaudeWorkerOptions の任意フィールドは、テスト用の注入 seam を除いて全て組み立てられる(ADR 0043)", async () => {
  const optional = optionalFields("claude-worker.ts", "ClaudeWorkerOptions");
  // 走査が壊れていないことの control(server 側の網羅テストと同じ形)
  expect(optional).toEqual(expect.arrayContaining(["advisorDisabled", "spawn", "boardState"]));

  const registryDir = await makeRegistry();
  dirs.push(registryDir);
  const emitted = new Set(
    Object.keys(buildWorkerOptions({ ...composition(), registryDir }, { db: openDb(":memory:"), clock: new FakeClock() })),
  );
  // 不在が正当なのは注入 seam の3つだけ —— そこでの不在は「機能が静かに切れる」
  // ではなく「実プロセスを使う」を意味する(ADR 0027 の fake 注入の形)。
  expect(optional.filter((key) => !emitted.has(key))).toEqual(["spawn", "pty", "enumerateSkills"]);
});

/** 上の網羅は `buildWorkerOptions` の戻り値を見ている。本番の worker がその
 *  リテラルで組まれていなければ空振りする —— ADR 0041 §4 の「テストは合成 root が
 *  組み立てたものを観測する」を、この層にも同じ形で適用する。
 *
 *  経由そのものは `ServerOptions.worker` の網羅(上の #172 のテスト)が既に
 *  押さえている: `buildServerOptions` が `buildWorkerFactory` を呼んで埋める口な
 *  ので、そこが切れれば必須フィールドとして型が落ちる。ここが足すのは**口の一覧が
 *  main.ts に戻っていないこと**だけ —— リテラルが向こうにあれば、上の網羅テストが
 *  観測するのはテスト自身が書いた複製にしかならない(#172 の構図が一段ずれて再現
 *  する)。 */
it("worker options の口の一覧は main.ts に戻っていない(ADR 0043)", () => {
  expect(source("main.ts")).not.toMatch(/new ClaudeCodeWorker\(/);
  // 本番の合成が実際にその一覧を使っていること(呼び出しの**形**は主張しない)
  expect(source("server-options.ts")).toMatch(/new ClaudeCodeWorker\(buildWorkerOptions\(/);
});

/** キーが揃っていることと、**どのキーに何が刺さっているか**は別の主張である
 *  (ADR 0041 §5 と同じ線)。kill switch は真偽値1つなので、取り違えても型検査は
 *  黙る —— しかも壊れ方が fail-open なので、黙ったまま advisor が止まらなくなる。 */
it("kill switch は盤面の合成からそのまま worker options へ届く(判断8)", async () => {
  const registryDir = await makeRegistry();
  dirs.push(registryDir);
  const options = (advisorDisabled: boolean) =>
    buildWorkerOptions(
      { ...composition(), registryDir, advisorDisabled },
      { db: openDb(":memory:"), clock: new FakeClock() },
    );

  expect(options(true).advisorDisabled).toBe(true);
  expect(options(false).advisorDisabled).toBe(false);
});

/** ADR 0040 の線: worker ログの置き場と、盤面が「重なるな」と守っている
 *  パスは**同じ1つ**でなければならない —— 綴りが2つあると、守る対象と実際の
 *  置き場が黙ってずれる。#33 で `logDir` が `BoardComposition` の口になり、
 *  合成 root では `boardState` の組み立てと `buildWorkerOptions` の**2箇所**に
 *  流れるようになったので、一致をここで観測する(どちらも `string` なので
 *  取り違えても型は黙る — ADR 0041 §5 と同じ理由)。 */
it("worker ログの置き場は、盤面が守っているパスと同じ1つである(ADR 0040)", async () => {
  const registryDir = await makeRegistry();
  dirs.push(registryDir);
  const logDir = "/opt/tidepool/worker-logs";
  const board = {
    ...composition(),
    registryDir,
    logDir,
    boardState: [{ label: "worker logs (TIDEPOOL_WORKER_LOGS)", path: logDir }],
  };
  const options = buildWorkerOptions(board, { db: openDb(":memory:"), clock: new FakeClock() });

  expect(options.logDir).toBe(logDir);
  expect(options.boardState?.map((p) => p.path)).toContain(options.logDir);
});

/** 上の網羅テストは `registryDir` 未設定で走る — registry 由来の口が**すべて**
 *  そこ1つに掛かっているので、13本の解決子はどれも早期 return しか通らない。
 *  つまりキーが揃っていることは分かっても、**どのキーにどの解決子が刺さって
 *  いるか**は何も分からない。`agentRegistered` と `isProtectedWorkspace` は
 *  どちらも `(name: string) => boolean` で、取り違えても型検査は黙る。
 *
 *  そこで registry を1つ立てて、解決子ごとに**別々の答え**を要求する。
 *  registry を配線する経路はここにしか無い(ADR 0027 の盤面ハーネスは
 *  `bootTidepool` 経由で、この組み立てを通らない)。 */
it("registry があるとき、各口には対応する解決子が刺さっている(#172)", async () => {
  const registryDir = await makeRegistry({
    // `guarded` は protected、`derived` は path を省く(ADR 0018 の基底ディレクトリ
    // 由来に落ちる)—— workspacesDir が正しく渡っていなければ後者が破綻する
    "workspaces.yaml":
      "tidepool:\n  path: /home/pi/work/tidepool\n" +
      "guarded:\n  path: /home/pi/work/guarded\n  protected: true\n" +
      "derived: {}\n",
  });
  dirs.push(registryDir);
  const workspacesDir = "/base/workspaces";
  // composition() の既定は "configured" —— ここだけ "default" に振ることで、
  // 一覧の口が定数を焼き付けている綴りと区別がつく(ADR 0082 決定2)
  const workspacesDirSource = "default" as const;
  // ADR 0024: 盤面の GitHub 身元。token ファイルは読まれるまで触られないので、実在
  // しないパスでも「身元を持つ盤面」を組める(同一性だけを見る下の assertion 用)
  const githubAuth = new GitHubAuth("/nonexistent/github-token");
  const options = buildServerOptions({
    ...composition(),
    registryDir,
    workspacesDir,
    workspacesDirSource,
    githubAuth,
    // `workspaceName` と `defaultAgentName` と `auditorName` はどれも string で、
    // 取り違えても型検査は黙る。fixture に実在するのは前2つが指す名前だけなので、
    // 入れ替われば下の解決がそのまま失敗する。
    workspaceName: "derived",
    defaultAgentName: "deckhand",
  });

  // workspaceConfig: 盤面自身の workspace 名で解決され、path 省略なら
  // workspacesDir 由来に落ちる(ADR 0018)—— 名前と基底ディレクトリの両方を通す
  expect(options.workspace?.name).toBe("derived");
  expect(options.workspace?.path).toBe(join(workspacesDir, "derived"));
  // resolveWorkspace: タスクが名指しした workspace を優先し、null なら盤面自身へ
  expect(options.resolveWorkspace?.("tidepool").path).toBe("/home/pi/work/tidepool");
  expect(options.resolveWorkspace?.("derived").path).toBe(join(workspacesDir, "derived"));
  expect(options.resolveWorkspace?.(null).name).toBe("derived");
  // この2つは同じ型なので、取り違えるとここで初めて分かる
  expect(options.agentRegistered?.("deckhand")).toBe(true);
  expect(options.agentRegistered?.("guarded")).toBe(false);
  expect(options.isProtectedWorkspace?.("guarded")).toBe(true);
  expect(options.isProtectedWorkspace?.("deckhand")).toBe(false);
  // 残りの registry 由来の口も、registry の中身をそのまま映していること
  expect(options.listAgents?.().map((agent) => agent.name)).toEqual(["deckhand"]);
  expect(options.registryCandidates?.()?.assignees).toEqual(["deckhand", "human"]);
  // assignee 未設定は defaultAgentName へ、registry の知らない名前は undefined へ
  expect(options.resolveAuthority?.(null)).toBeDefined();
  expect(options.resolveAuthority?.("nobody")).toBeUndefined();
  expect(options.fableAgents?.()).toEqual([]); // fixture の agent に model 指定は無い
  expect(options.agentAdmin?.authorityProfiles?.()).toEqual(["standard"]);
  // registry ゲートで初めて立つ口
  expect(options.draftClient).toBeDefined();
  expect(options.workspaceAdmin).toBeDefined();
  // ADR 0082 決定1/2: 登録の門が着地先とその出所を見せる材料は一覧の口から来る。
  // 基点と出所は別々の口から合流するので、片方だけ配線しても型検査は黙る
  expect(options.workspaceAdmin?.list?.().workspacesBaseDir).toEqual({
    path: workspacesDir,
    source: workspacesDirSource,
  });
  expect(options.profileAdmin).toBeDefined();
  const swept = options.boardState?.listWorkspaces().map((ws) => ws.name);
  expect(swept?.sort()).toEqual(["derived", "guarded", "tidepool"]);
  // ADR 0052 決定3 / issue #211: pickup が registry clone の2宣言を突き合わせるのに
  // 使う口。`registryDir` ゲートで初めて立つので、上の網羅(registry 未設定)では
  // `undefined` のままキーだけが揃い、何が刺さっているかは分からない。dir と宣言
  // された mode の**組**を名指しで要求する(下の remote-backed の1本と対で、mode が
  // 宣言から来ていることまで見る)
  expect(options.registry).toEqual({ dir: registryDir, mode: "purely-local" });
  // ADR 0024: workspace の pickup 時 fetch がこの名義で撃つ。落とすと private remote の
  // workspace が「認証が無い」理由で黙って quarantine に落ち続ける
  expect(options.githubAuth).toBe(githubAuth);
});
