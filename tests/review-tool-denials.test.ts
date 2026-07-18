import { describe, expect, it } from "vitest";
import { reviewToolDenials } from "../src/claude-worker.js";

/** ADR 0013 追記(issue #59): review は行為の性質であって行為者の性質ではない
 *  (CONTEXT.md の Review)——ため、read-only はエージェントの authority profile
 *  ではなく task.type だけから決まる。`reviewToolDenials` はその1点だけを見る
 *  純関数で、`--disallowedTools` に折り込む前段。ping や CLI 呼び出しを伴わない
 *  ので computeSkillDenials と違って同期・純粋(issue #56 と同じ「組み立ては
 *  純関数、配線は claude-worker.ts の launch() 側」という分離)。 */
describe("reviewToolDenials", () => {
  it("review タスクは Edit / Write / NotebookEdit を deny する", () => {
    const denials = reviewToolDenials("review");
    expect(denials).toContain("Edit");
    expect(denials).toContain("Write");
    expect(denials).toContain("NotebookEdit");
  });

  it("review タスクは Bash の書き込み系パターンを deny する(git の書き込み操作 + ファイルシステム変更コマンド)", () => {
    const denials = reviewToolDenials("review");
    expect(denials).toEqual(
      expect.arrayContaining([
        "Bash(git commit*)",
        "Bash(git push*)",
        "Bash(git add*)",
        "Bash(git merge*)",
        "Bash(git rebase*)",
        "Bash(git reset*)",
        "Bash(rm*)",
        "Bash(mv*)",
        "Bash(cp*)",
        "Bash(mkdir*)",
        "Bash(touch*)",
        "Bash(sed -i*)",
        "Bash(tee*)",
        "Bash(chmod*)",
        "Bash(chown*)",
      ]),
    );
  });

  it("work タスクは何も deny しない(work タスクの spawn に影響しない)", () => {
    expect(reviewToolDenials("work")).toEqual([]);
  });

  it("question タスクも何も deny しない(review 以外は一律無関係)", () => {
    expect(reviewToolDenials("question")).toEqual([]);
  });
});
