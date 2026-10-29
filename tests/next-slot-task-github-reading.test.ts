import { afterEach, expect, it } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { nextSlotTask, registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI, humanDecomposeTaskViaWebui } from "./harness.js";

/** pickup で GitHub を読む task の集合(ADR 0328 決定2): issue-backed task と、issue-backed の親を持つ子。
 *  集合は親の参照の有無で引くので、材料の session を持つ RCA 子(GitHub を読まない)も外れる —— 受け入れた過剰除外。 */
const NOW = new Date("2026-10-30T00:00:00.000Z");

let db: Db;
afterEach(() => db?.close());

function walk(excludeGitHubReading: boolean): string[] {
  const seen: string[] = [];
  for (;;) {
    const head = nextSlotTask(db, undefined, undefined, undefined, undefined, seen, undefined, undefined, excludeGitHubReading);
    if (!head) return seen;
    seen.push(head.id);
  }
}

it("GitHub を読む task を外す引数は、自分の issue・issue-backed の親を持つ子・材料つき RCA 子を外し、通常 task だけを候補に残す", () => {
  db = openDb(":memory:");
  const own = registerTask(db, { type: "work", workspace: "tidepool", github_issue_number: 1 }, NOW, ...HUMAN_WEBUI);
  const decomposed = registerTask(db, { type: "work", workspace: "tidepool", github_issue_number: 2 }, NOW, ...HUMAN_WEBUI);
  const [child] = humanDecomposeTaskViaWebui(db, decomposed, {
    reason: "split",
    children: [{ title: "implement", purpose: "implement", completion_criteria: "implemented" }],
  }, NOW);
  const stoppedParent = registerTask(db, { type: "work", workspace: "tidepool", github_issue_number: 3 }, NOW, ...HUMAN_WEBUI);
  const stop = appendEvent(db, { taskId: stoppedParent.id, actorId: HUMAN_WEBUI[0], origin: "webui", at: NOW, payload: { kind: "session_stopped_by_human", reason: "stopped" } });
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(stoppedParent.id);
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "explain", completion_criteria: "explained", parent_id: stoppedParent.id, opened_on_event_ids: [stop] }, NOW, BOARD_ACTOR_ID, "board");
  const ordinary = registerTask(db, { type: "work", title: "ordinary", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);

  expect(walk(false).sort()).toEqual([own.id, child!.id, rca.id, ordinary.id].sort());
  expect(walk(true)).toEqual([ordinary.id]);
});
