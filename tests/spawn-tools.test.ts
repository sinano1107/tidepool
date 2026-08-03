import { describe, expect, it } from "vitest";
import { spawnTools } from "../src/claude-worker.js";

/** ADR 0039(issue #145): worker のツール面は `--tools` による**既定拒否の
 *  allowlist** である。ADR 0038 の「床 = 残余の既定」はファイル操作でない
 *  in-process ツールには届いておらず(`acceptEdits` + 本番フラグ一式で
 *  `CronCreate` が承認要求なしに実行された — 測定2)、その層は列挙 deny では
 *  なく向きを反転させた allowlist で閉じる。
 *
 *  `spawnAllowedTools` / `reviewToolDenials` と同じ「組み立ては純関数、配線は
 *  launch() 側」の分離。**期待値はこのファイル側の独立した literal** で書く —
 *  実装を import して組み立て直すとコードが計算する通りに期待値も計算する
 *  トートロジーになる(tests/review-tool-denials.test.ts の線)。review の14本も
 *  「work から3本引いた」ではなく手で全量を綴る。 */
describe("spawnTools", () => {
  it("work は17本 — 検索ツールとバックグラウンド実行の受け口まで含む(ADR 0039 決定1)", () => {
    // `Glob` / `Grep` は 2.1.220 の既定の面には出ていない(測定7)。work セッションに
    // 本物の検索ツールを与えられるのは、この allowlist を書くからである。
    // `Task`(Agent)は BOARD_DOCTRINE が意図的に開いている既決事項(ADR 0010 追記)、
    // `TaskOutput` / `TaskStop` は todo リストの仲間ではなく `Bash` の
    // `run_in_background` の受け口。
    expect(spawnTools("work")).toEqual([
      "Bash",
      "Read",
      "Write",
      "Edit",
      "NotebookEdit",
      "Glob",
      "Grep",
      "Skill",
      "Task",
      "WebFetch",
      "WebSearch",
      "TaskCreate",
      "TaskGet",
      "TaskList",
      "TaskUpdate",
      "TaskOutput",
      "TaskStop",
    ]);
  });

  it("review は14本 — 編集系3本が面から消える(深層防御・ADR 0039 決定2)", () => {
    // 床そのものは permission 層(`--permission-mode manual` + `autoAllowBashIfSandboxed:
    // false`)に残る。ここが2層目である理由は冗長性ではなく性質の違い: deny 層は
    // **黙って**効かなくなりうる(ADR 0037 追記)のに対し、`--tools` による除去は
    // init イベントの `tools` 配列を読めば**観測できる**。
    expect(spawnTools("review")).toEqual([
      "Bash",
      "Read",
      "Glob",
      "Grep",
      "Skill",
      "Task",
      "WebFetch",
      "WebSearch",
      "TaskCreate",
      "TaskGet",
      "TaskList",
      "TaskUpdate",
      "TaskOutput",
      "TaskStop",
    ]);
  });

  it("review 以外は work と同じ面 — read-only は review という task type の性質(ADR 0013)", () => {
    expect(spawnTools("question")).toEqual(spawnTools("work"));
  });

  it("落としたものは面に現れない: 人間のアカウント名義や人間の注意を直接触るツール", () => {
    // `RemoteTrigger` は claude.ai の API に**人間のアカウント名義の OAuth token を
    // プロセス内で自動付与**して routine を作る。`PushNotification` は Quiet hours と
    // Digest を素通りする。`EnterWorktree` はセッションの cwd を branch discipline の
    // 外へ移す。`CronCreate` は測定2 でそのまま実行できてしまったものである。
    for (const taskType of ["work", "review"] as const) {
      const tools = spawnTools(taskType);
      expect(tools).not.toContain("RemoteTrigger");
      expect(tools).not.toContain("PushNotification");
      expect(tools).not.toContain("CronCreate");
      expect(tools).not.toContain("EnterWorktree");
      expect(tools).not.toContain("DesignSync");
      expect(tools).not.toContain("Monitor");
      expect(tools).not.toContain("ToolSearch");
      // 存在しない名前は警告なく不活性になる(測定8)ので、綴りの取り違えは
      // 面を1本削るだけで済んでしまう。`AskUserQuestion` は headless の面に
      // そもそも現れない(測定1)ので、挙げれば黙って不活性な1行になる。
      expect(tools).not.toContain("AskUserQuestion");
    }
  });
});
