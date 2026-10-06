/** Worker id attributed to bare (non ?task=) sessions, e.g. the JSON API. */
export const HUMAN_WORKER_ID = "human";

/** Worker id the board acts under when it enforces its own rules (issue #8):
 *  the tree rule's failures are the board's to report, never pinned on the
 *  agent. Also the sole registrant allowed a 1-choice confirmation question
 *  (issue #21) — a plain agent question always carries 2-4 choices. */
export const BOARD_WORKER_ID = "tidepool";

/** Worker ids that are not agents (the human and the board). Add a new
 *  non-agent id here and every "is this an agent?" check follows. */
export const NON_AGENT_WORKER_IDS: ReadonlySet<string> = new Set([HUMAN_WORKER_ID, BOARD_WORKER_ID]);

export const isNonAgentWorkerId = (id: string): boolean => NON_AGENT_WORKER_IDS.has(id);
