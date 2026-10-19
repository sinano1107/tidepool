import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { boardHalts } from "../src/board-halt.js";
import { openDb } from "../src/db.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { openQuarantineQuestion, registerQuarantine } from "../src/quarantine.js";
import { getTask } from "../src/tasks.js";
import { FakeClock, unusedLanding } from "./fakes.js";
import { tempDir } from "./temp-dir.js";

// 盤面の記録の器の停止の解放の門(ADR 0266 決定3)。入口(transcript の open)は transcript-failure.test.ts が言う(ADR 0276 決定5)。

it("器がまだ書けなければ回答は拒まれて停止が残り、書けるようになれば受理されて停止が外れる", async () => {
  const recordDir = join(await tempDir("tidepool-record-container-release-"), "worker-logs");
  const db = openDb(":memory:");
  const clock = new FakeClock();
  registerQuarantine(db, "recordContainer", null, "worker-logs is gone", clock.now());
  const question = getTask(db, openQuarantineQuestion(db, "recordContainer", null)!.id)!;
  const answer = () =>
    submitAnswer({ db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ db, recordDir }) }, question, ["repaired by hand"], undefined, () => clock.now(), "webui");

  await expect(answer()).rejects.toThrow(`the board's record container ${recordDir} still cannot be written`);
  expect(boardHalts(db)).toEqual([{ kind: "recordContainer" }]);
  expect(getTask(db, question.id)!.status).toBe("todo");

  mkdirSync(recordDir);
  await answer();

  expect(boardHalts(db)).toEqual([]);
});
