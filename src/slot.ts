/** The single execution slot (concurrency = 1, ADR 0001): one in-process fact. */
export class Slot {
  private taskId: string | null = null;

  get currentTaskId(): string | null {
    return this.taskId;
  }

  occupy(taskId: string): void {
    if (this.taskId !== null) throw new Error("slot already occupied");
    this.taskId = taskId;
  }

  release(): void {
    this.taskId = null;
  }
}
