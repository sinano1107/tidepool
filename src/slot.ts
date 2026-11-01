import type { TaskContent } from "./tasks.js";
import type { TeardownAction } from "./teardown.js";

/** 子自身の pickup で凍結した親の文面(ADR 0321)。 */
export type ParentBriefing = Partial<TaskContent> & {
  issue?: { number: number; state: "open" | "closed" | "not_found" };
  briefing_as_spawned?: Array<{ text: string | null; for: number[] }>;
  briefing_note?: string;
};

/** The single execution slot (concurrency = 1, ADR 0001): one in-process fact.
 *
 *  枠を占めるのは **worker session であって task ではない**(ADR 0109 決定2 /
 *  GLOSSARY.md「Slot」)—— タスクが決着しても、その session の後始末が終わるまで
 *  枠は空かない。`inTeardown` がその局面を表す。 */
export class Slot {
  private taskId: string | null = null;
  private teardown = false;
  private taskContent: TaskContent | undefined;
  private parentContent: ParentBriefing | undefined;
  private failedTeardownRest: { taskId: string; actions: TeardownAction[] } | undefined;
  private acceptingTeardown = false;

  get currentTaskId(): string | null {
    return this.taskId;
  }

  /** 後始末(GLOSSARY.md「後始末」)に入っているか。最終 verb が着地してから
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

  /** 落ちた後始末の残り —— 投げた手から先(ADR 0342 決定6)。受理が撃ち直す。memory なので再起動を越えず、
   *  越えた受理は後始末そのものを撃ち直す。1つの task の分だけ持ち、受理の後始末が枠を空けた後に投げた手は枠が空いたまま持つ。
   *  先に残った手は捨てず、その後ろに継ぐ。 */
  appendFailedTeardownRest(taskId: string, actions: TeardownAction[]): void {
    const earlier = this.failedTeardownRest?.taskId === taskId ? this.failedTeardownRest.actions : [];
    this.failedTeardownRest = { taskId, actions: [...earlier, ...actions] };
  }

  /** 落ちた後始末の残りを持っていれば `action` をその後ろに継いで true —— 呼び手は自分では撃たず、受理に任せる(ADR 0112 決定4)。 */
  deferToFailedTeardownRest(taskId: string, action: TeardownAction): boolean {
    if (!this.hasFailedTeardownRest(taskId)) return false;
    this.appendFailedTeardownRest(taskId, [action]);
    return true;
  }

  hasFailedTeardownRest(taskId: string): boolean {
    return this.failedTeardownRest?.taskId === taskId;
  }

  takeFailedTeardownRest(taskId: string): TeardownAction[] | undefined {
    if (this.failedTeardownRest?.taskId !== taskId) return undefined;
    const { actions } = this.failedTeardownRest;
    this.failedTeardownRest = undefined;
    return actions;
  }

  /** 落ちた後始末の受理が走っている印。同期に取り、取れなければ undefined。後始末が枠を空けた後も受理の終わりまで持つので `release` は触らない。 */
  takeTeardownAcceptanceMark(): (() => void) | undefined {
    if (this.acceptingTeardown) return undefined;
    this.acceptingTeardown = true;
    return () => {
      this.acceptingTeardown = false;
    };
  }

  release(): void {
    this.failedTeardownRest = undefined;
    this.taskId = null;
    this.teardown = false;
    this.taskContent = undefined;
    this.parentContent = undefined;
  }
}
