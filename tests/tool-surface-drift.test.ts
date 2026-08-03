import { describe, expect, it } from "vitest";
import { checkToolSurface } from "../src/claude-worker.js";

/** ADR 0039 決定3: ツール面のドリフトは workspace の性質でも agent の性質でもなく
 *  **ホストの性質**である — このホストの CLI が盤面の宣言を honor しなくなった、
 *  という事実 — ので、封じ込め能力の3つ目の問いになる(CONTEXT.md の Containment
 *  capability)。この関数はその照合そのもの:純関数で、封じ込め能力の probe と
 *  worker 自身の init 行の照合が**同じ1つ**を共有する(期待集合を2箇所に置かない)。
 *
 *  検知は双方向である。観測 ⊃ 期待は「宣言が honor されなくなった / 新ツールが
 *  素通りしてきた」、観測 ⊂ 期待は「挙げた名前が改名・廃止されて黙って不活性化した」
 *  (測定8: `TodoWrite` と `Bogus` が何の警告もなく消えた)。後者は worker が能力を
 *  1つ失ったまま走り続けるので、タスクが詰まって初めて分かる。したがって照合は
 *  **集合の一致**である。
 *
 *  期待値はここでも独立した literal で書く。 */
describe("checkToolSurface", () => {
  /** 実セッションの init が返す形(ADR 0039 の測定と同じ17本 + MCP verb)。 */
  const WORK_SURFACE = [
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
  ];

  it("宣言どおりの面は成立 — 順序は問わない(集合の一致)", () => {
    expect(checkToolSurface(WORK_SURFACE, "work")).toEqual({ available: true });
    // init の `tools` 配列の順序は CLI の内部順であって盤面の綴り順ではない
    expect(checkToolSurface([...WORK_SURFACE].reverse(), "work")).toEqual({ available: true });
  });

  it("`mcp__` で始まるエントリは比較対象から外す — MCP の落下を封じ込めの不成立に化けさせない", () => {
    // MCP サーバーが繋がらなかったセッションでは verb が丸ごと消える。含めると
    // 「盤面の MCP が落ちている」が封じ込め能力の不成立に化ける。それは別の障害で
    // あり別の扱いを受けるべきである(ADR 0039 決定3)。
    expect(
      checkToolSurface([...WORK_SURFACE, "mcp__tidepool__get_current_task"], "work"),
    ).toEqual({ available: true });
    // verb が1本も無い(MCP 未接続)セッションも、ツール面としては宣言どおり
    expect(checkToolSurface(WORK_SURFACE, "work")).toEqual({ available: true });
  });

  it("観測 ⊃ 期待は不成立 — 素通りしてきたツールを名前で挙げる", () => {
    const result = checkToolSurface([...WORK_SURFACE, "CronCreate", "RemoteTrigger"], "work");
    // 3時にラズパイの前で読む文になっていること: 観測された**具体名**が要る
    // (`available === false &&` は判別共用体の絞り込み — sandbox-capability.test.ts と同形)
    expect(result.available === false && result.reason).toContain("CronCreate");
    expect(result.available === false && result.reason).toContain("RemoteTrigger");
  });

  it("観測 ⊂ 期待も不成立 — 黙って不活性化した名前を挙げる(測定8)", () => {
    const result = checkToolSurface(
      WORK_SURFACE.filter((tool) => tool !== "Glob" && tool !== "TaskOutput"),
      "work",
    );
    expect(result.available === false && result.reason).toContain("Glob");
    expect(result.available === false && result.reason).toContain("TaskOutput");
  });

  it("過不足が同時に起きたら両方を挙げる(綴りの取り違えの形そのもの)", () => {
    // `Glob` を `Globb` と書けば、期待側に `Globb` が現れ観測側から `Glob` が消える
    // ——「1本足して1本落ちた」ではなく綴りミス1つである、と読める文が要る。
    const result = checkToolSurface(
      [...WORK_SURFACE.filter((tool) => tool !== "Grep"), "Bogus"],
      "work",
    );
    expect(result.available === false && result.reason).toContain("Bogus");
    expect(result.available === false && result.reason).toContain("Grep");
  });

  it("review は review の期待集合で照合する — 編集系が面に残っていたら不成立", () => {
    // review の面に `Write` が残っているのは、`--tools` による除去が honor されて
    // いないということである。深層防御の2層目が observable であることの実体がこれ。
    const result = checkToolSurface(WORK_SURFACE, "review");
    expect(result.available === false && result.reason).toContain("Write");
    expect(result.available === false && result.reason).toContain("Edit");
    expect(result.available === false && result.reason).toContain("NotebookEdit");
  });

  it("review の14本はそのまま成立する", () => {
    expect(
      checkToolSurface(
        [
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
        ],
        "review",
      ),
    ).toEqual({ available: true });
  });

  it("空の観測は不成立 — 「測れなかった」を「無事」と読ませない", () => {
    const result = checkToolSurface([], "work");
    expect(result.available).toBe(false);
  });
});
