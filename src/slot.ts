/** The single execution slot (concurrency = 1, ADR 0001): one in-process fact.
 *
 *  枠を占めるのは **worker session であって task ではない**(ADR 0109 決定2 /
 *  CONTEXT.md「Slot」)—— タスクが決着しても、その session の後始末が終わるまで
 *  枠は空かない。`inTeardown` がその局面を表す。 */
export class Slot {
  private taskId: string | null = null;
  private teardown = false;

  get currentTaskId(): string | null {
    return this.taskId;
  }

  /** 後始末(CONTEXT.md「後始末」)に入っているか。最終 verb が着地してから
   *  回収済み観測が届いて枠が空くまでの間だけ true —— この間、その session が
   *  盤面に触れる口は attribution の門が閉じている(ADR 0109 決定6)。 */
  get inTeardown(): boolean {
    return this.teardown;
  }

  occupy(taskId: string): void {
    if (this.taskId !== null) throw new Error("slot already occupied");
    this.taskId = taskId;
    this.teardown = false;
  }

  /** 最終 verb(完了・分解・エスカレーション)が着地した。session はまだ枠を
   *  握っているが、タスクは決着しており、以降この session は盤面に触れない。 */
  enterTeardown(): void {
    this.teardown = true;
  }

  release(): void {
    this.taskId = null;
    this.teardown = false;
  }
}
