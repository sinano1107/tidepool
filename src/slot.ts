import type { TaskContent } from "./tasks.js";

/** 子自身の pickup で凍結した親の文面(ADR 0321)。 */
export type ParentBriefing = Partial<TaskContent> & {
  issue?: { number: number; state: "open" | "closed" | "not_found" };
  briefing_as_spawned?: Array<{ text: string | null; for: number[] }>;
  briefing_note?: string;
};

/** The single execution slot (concurrency = 1, ADR 0001): one in-process fact.
 *
 *  枠を占めるのは **worker session であって task ではない**(ADR 0109 決定2 /
 *  CONTEXT.md「Slot」)—— タスクが決着しても、その session の後始末が終わるまで
 *  枠は空かない。`inTeardown` がその局面を表す。 */
export class Slot {
  private taskId: string | null = null;
  private teardown = false;
  private taskContent: TaskContent | undefined;
  private parentContent: ParentBriefing | undefined;

  get currentTaskId(): string | null {
    return this.taskId;
  }

  /** 後始末(CONTEXT.md「後始末」)に入っているか。最終 verb が着地してから
   *  回収済み観測が届いて枠が空くまでの間だけ true —— この間、その session が
   *  盤面に触れる口は attribution の門が閉じている(ADR 0109 決定6)。 */
  get inTeardown(): boolean {
    return this.teardown;
  }

  /** pickup が spawn に渡した title / purpose / 完了基準(ADR 0320 決定1)。session のあいだ変わらず、`get_current_task` が返す。
   *  後始末の再開・受理の占有は持たない —— 直後に後始末へ入り、verb は門で拒まれる(ADR 0109 決定6)。 */
  get content(): TaskContent | undefined {
    return this.taskContent;
  }

  get parentBriefing(): ParentBriefing | undefined {
    return this.parentContent;
  }

  occupy(taskId: string, content?: TaskContent, parentBriefing?: ParentBriefing): void {
    if (this.taskId !== null) throw new Error("slot already occupied");
    this.taskId = taskId;
    this.teardown = false;
    this.taskContent = content;
    this.parentContent = parentBriefing;
  }

  /** 最終 verb(完了・分解・エスカレーション)が着地した。session はまだ枠を
   *  握っているが、タスクは決着しており、以降この session は盤面に触れない。 */
  enterTeardown(): void {
    this.teardown = true;
  }

  release(): void {
    this.taskId = null;
    this.teardown = false;
    this.taskContent = undefined;
    this.parentContent = undefined;
  }
}
