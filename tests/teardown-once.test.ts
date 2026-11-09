import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { Slot } from "../src/slot.js";
import { completeTask, escalateTask, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { runTeardown, type TeardownDeps, teardownStep } from "../src/teardown.js";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import {
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HUMAN_WEBUI,
  makeWorkspace,
  prepareAtPickup,
  quarantineQuestion,
  sessionId,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

/** 後始末モジュール(ADR 0109 決定1)。3経路が共有する型である。門の主は
 *  `slot.currentTaskId` の再観測 —— 回収済み観測は非同期に届くので、その間に次の
 *  session が枠に入っていることがありうる。梯子の底で保留されている session
 *  (`heldForContainment`)も同じ点で弾く(ADR 0099 決定3)。 */

async function pickedUpSession(): Promise<{
  deps: TeardownDeps;
  slot: Slot;
  task: Task;
  ws: WorkspaceConfig;
  checkout: string;
}> {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace("sandbox");
  const slot = new Slot();
  const registered = registerTask(
    db,
    { type: "work", title: "one", purpose: "why", completion_criteria: "done" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  const task = pickupTask(db, registered, "deckhand", clock.now())!;
  slot.occupy(task.id, sessionId(db, task.id));
  const { path: checkout } = await prepareAtPickup(db, ws, task);
  return { deps: { db, clock, slot, resolve: () => ws, pollNow: () => {} }, slot, task, ws, checkout };
}

it("後始末は1つの session につきちょうど1回走る —— 2度目は枠の再観測で落ちる", async () => {
  const { deps, slot, task, ws, checkout } = await pickedUpSession();
  writeFileSync(join(checkout, "half-done.txt"), "work in flight\n");
  const transitions: string[] = [];
  const step = { transition: (t: Task) => transitions.push(t.id) };

  await runTeardown(deps, task.id, step);
  await runTeardown(deps, task.id, step);

  // tree rule → 状態遷移 → slot 解放が、1つの session につき1度だけ
  expect(transitions).toEqual([task.id]);
  expect(slot.currentTaskId).toBeNull();
  expect(
    git(ws.path, "log", "--oneline", `task/${task.id}`)
      .split("\n")
      .filter((line) => line.includes("WIP")),
  ).toHaveLength(1);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

it("枠の主が入れ替わっていたら何もしない —— 他人の slot を解放しない", async () => {
  const { deps, slot, task, checkout } = await pickedUpSession();
  writeFileSync(join(checkout, "half-done.txt"), "work in flight\n");
  // 回収済み観測を待つ間に、次の session が枠に入っていた
  slot.release();
  slot.occupy("someone-else", sessionId(deps.db, "someone-else"));
  const transitions: string[] = [];

  await runTeardown(deps, task.id, { transition: (t: Task) => transitions.push(t.id) });

  expect(transitions).toEqual([]);
  expect(slot.currentTaskId).toBe("someone-else");
  expect(git(checkout, "status", "--porcelain")).not.toBe("");
});

it("drift を観測する後始末は1つの session につき1度だけ解決する —— 2度目は枠の再観測で落ち、同じ観測を2度撃たない(ADR 0363 決定2)", async () => {
  const { deps, task } = await pickedUpSession();
  let resolveCalls = 0;
  const resolve = (name: string | null): WorkspaceConfig => {
    resolveCalls++;
    throw new UnknownWorkspaceError(name ?? "sandbox");
  };
  // 完了の門は drift を拒むだけで登録しない —— worker は escalate する
  escalateTask(deps.db, task, { context: "the workspace is gone", questions: [{ title: "which?", options: ["a", "b"], recommendation: "a" }] }, "deckhand", deps.clock.now(), "worker");

  await runTeardown({ ...deps, resolve }, task.id, teardownStep(deps.db, task.id));
  await runTeardown({ ...deps, resolve }, task.id, teardownStep(deps.db, task.id));

  expect(resolveCalls).toBe(1);
  const quarantine = quarantineQuestion(deps.db, "workspace", "sandbox");
  expect(quarantine).toBeDefined();
  // 2度目は同じ観測を cause として重ねて記録するだけ = 人間には理由が二重に見える
  expect(listEvents(deps.db, quarantine?.id ?? "").map((e) => e.payload.kind)).not.toContain("quarantine_refired");
  // 門が閉じたわけではない: 枠はきちんと空く
  expect(deps.slot.currentTaskId).toBeNull();
});

/** 完了済みの session を枠に置き、後始末が撃つ契機を1本の列に記録する deps を返す。 */
function completedSession() {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const registered = registerTask(
    db,
    { type: "work", title: "one", purpose: "why", completion_criteria: "done" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  const task = completeTask(db, pickupTask(db, registered, "deckhand", clock.now())!, FULL_HANDOFF, "deckhand", clock.now(), "worker");
  slot.occupy(task.id, sessionId(db, task.id));
  const calls: string[] = [];
  const deps: TeardownDeps = {
    db,
    clock,
    slot,
    resolve: undefined,
    pollNow: () => calls.push("pollNow"),
  };
  return { deps, slot, task, calls };
}

// ADR 0119 決定3 / ADR 0241 決定5: slot の解放は pickup の契機である。着地はその契機が突く収束が撃つ
it("後始末は着地を直接撃たず、枠を空けた後に pickup の契機を1回撃つ", async () => {
  const { deps, slot, task, calls } = completedSession();

  await runTeardown(deps, task.id, { completion: true });

  expect(calls).toEqual(["pollNow"]);
  expect(slot.currentTaskId).toBeNull();
});

it("枠の主が変わっていた・梯子の底で保留された後始末は、pickup の契機を撃たない", async () => {
  const changed = completedSession();
  changed.slot.release();
  changed.slot.occupy("someone-else", sessionId(changed.deps.db, "someone-else"));
  await runTeardown(changed.deps, changed.task.id, { completion: true });

  const held = completedSession();
  await runTeardown({ ...held.deps, heldForContainment: () => true }, held.task.id, { completion: true });

  expect([changed.calls, held.calls]).toEqual([[], []]);
});
