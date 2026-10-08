/** `blocked` is derived from unfinished children the parent waits for
 *  (CONTEXT.md), never stored. */
export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";

/** Settled (CONTEXT.md): the task has reached a terminal status. */
export const isSettled = (status: string | undefined): boolean => status === "done" || status === "cancelled";
