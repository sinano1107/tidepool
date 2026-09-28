import { expect, it } from "vitest";
import { type EventPayload, type EventRow, isDecisionLogEntry } from "../src/events.js";

const row = (payload: EventPayload): EventRow => ({
  id: 1,
  task_id: "t",
  worker_id: "tako",
  origin: "worker",
  kind: payload.kind,
  payload,
  created_at: "2026-09-28T00:00:00.000Z",
});

it("human-facing の3 kind の event は decision-log entry で、それ以外の kind と undefined は違う", () => {
  expect(
    [
      row({ kind: "decision_logged", line: "l" }),
      row({ kind: "task_completed", handoff_present: true, result: null }),
      row({ kind: "premise_breached", line: "l", based_on_decision: 1 }),
      row({ kind: "objection_raised", entry_id: 1, comment: "c", session_id: 1 }),
      undefined,
    ].map(isDecisionLogEntry),
  ).toEqual([true, true, true, false, false]);
});
