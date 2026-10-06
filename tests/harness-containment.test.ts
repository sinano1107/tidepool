import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { harnessContainmentPickupBlocked } from "../src/harness-containment.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { getTask, listBoard } from "../src/tasks.js";
import { FakeClock, unusedLanding } from "./fakes.js";

it("a Harness quarantine answer is accepted only after the same live check recovers", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  let repaired = false;
  const check = async () => repaired
    ? { available: true as const }
    : { available: false as const, reason: "permission canary failed" };

  expect(await harnessContainmentPickupBlocked(db, "codex", check, clock.now())).toBe(true);
  const questionId = listBoard(db).find(
    (task) => (task.question_quarantine_kind === "harnessContainment" && task.question_quarantine_value === "codex"),
  )?.id;
  expect(questionId).toBeDefined();
  const question = getTask(db, questionId!);
  expect(question).toBeDefined();
  await expect(submitAnswer(
    {
      db,
      pollNow() {},
      quarantineChecks: quarantineChecks({ db, harnessContainment: async () => check() }),
      landing: unusedLanding,
    },
    question!,
    ["repaired by hand"],
    undefined,
    () => clock.now(),
    "webui",
  )).rejects.toThrow("still not established");
  expect(getTask(db, questionId!)?.status).toBe("todo");

  repaired = true;
  await submitAnswer(
    {
      db,
      pollNow() {},
      quarantineChecks: quarantineChecks({ db, harnessContainment: async () => check() }),
      landing: unusedLanding,
    },
    question!,
    ["repaired by hand"],
    "updated the pinned CLI",
    () => clock.now(),
    "webui",
  );
  expect(getTask(db, questionId!)?.status).toBe("done");
  expect(listEvents(db, questionId!).at(-1)?.payload).toMatchObject({
    kind: "quarantine_released",
    quarantine: "harnessContainment",
    value: "codex",
  });
});
