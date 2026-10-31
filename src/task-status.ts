/** `blocked` is derived from unfinished children the parent waits for
 *  (GLOSSARY.md), never stored. */
export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";

/** Settled (GLOSSARY.md): the task has reached a terminal status. */
export const isSettled = (status: string | undefined): boolean => status === "done" || status === "cancelled";

/** SQL spelling of the unsettled set, the complement of `isSettled` — keep the two in step. */
export const unsettledSql = (statusRef: string): string => `${statusRef} NOT IN ('done', 'cancelled')`;
