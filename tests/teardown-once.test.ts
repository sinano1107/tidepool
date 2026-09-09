import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { Slot } from "../src/slot.js";
import { listBoard, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { runTeardown, type TeardownDeps } from "../src/teardown.js";
import {
  prepareWorkspaceAtPickup,
  resolveOrQuarantine,
  UnknownWorkspaceError,
  type WorkspaceConfig,
} from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import { git, makeWorkspace } from "./harness.js";

/** 後始末モジュール(ADR 0109 決定1)。3経路が共有する型であり、**門は
 *  `slot.currentTaskId` の再観測ひとつ**である —— 回収済み観測は非同期に届くので、
 *  その間に次の session が枠に入っていることがありうる。 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function pickedUpSession(): Promise<{
  deps: TeardownDeps;
  slot: Slot;
  task: Task;
  ws: WorkspaceConfig;
}> {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace(dirs, "sandbox");
  const slot = new Slot();
  const registered = registerTask(
    db,
    { type: "work", title: "one", purpose: "why", completion_criteria: "done" },
    clock.now(),
  );
  const task = pickupTask(db, registered, "deckhand", clock.now());
  slot.occupy(task.id);
  await prepareWorkspaceAtPickup(db, ws, task, {});
  return { deps: { db, clock, slot, resolve: () => ws }, slot, task, ws };
}

it("後始末は1つの session につきちょうど1回走る —— 2度目は枠の再観測で落ちる", async () => {
  const { deps, slot, task, ws } = await pickedUpSession();
  writeFileSync(join(ws.path, "half-done.txt"), "work in flight\n");
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
  const { deps, slot, task, ws } = await pickedUpSession();
  writeFileSync(join(ws.path, "half-done.txt"), "work in flight\n");
  // 回収済み観測を待つ間に、次の session が枠に入っていた
  slot.release();
  slot.occupy("someone-else");
  const transitions: string[] = [];

  await runTeardown(deps, task.id, { transition: (t: Task) => transitions.push(t.id) });

  expect(transitions).toEqual([]);
  expect(slot.currentTaskId).toBe("someone-else");
  expect(git(ws.path, "status", "--porcelain")).not.toBe("");
});

it("門が既に解決した workspace は後始末で解決し直さない —— 同じ観測で2度撃たない", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const registered = registerTask(
    db,
    {
      type: "work",
      title: "one",
      purpose: "why",
      completion_criteria: "done",
      workspace: "ghost",
    },
    clock.now(),
  );
  const task = pickupTask(db, registered, "deckhand", clock.now());
  slot.occupy(task.id);
  let resolveCalls = 0;
  const resolve = () => {
    resolveCalls++;
    throw new UnknownWorkspaceError("ghost");
  };

  // 完了の門(`runReleasingVerb`)が verb の**手前**で解決する —— 解決できない名前は
  // ここで quarantine される。その結果は「解決済み・該当なし」として後始末へ渡る
  const resolved = resolveOrQuarantine(db, resolve, task.workspace, clock.now());
  expect(resolved).toBeUndefined();
  await runTeardown({ db, clock, slot, resolve }, task.id, {
    completion: true,
    workspace: resolved ?? null,
  });

  expect(resolveCalls).toBe(1);
  const quarantine = listBoard(db).find((t) => t.question_quarantine_workspace === "ghost");
  expect(quarantine).toBeDefined();
  // 2度目は同じ観測を cause として重ねて記録するだけ = 人間には理由が二重に見える
  expect(listEvents(db, quarantine?.id ?? "").map((e) => e.payload.kind)).not.toContain(
    "quarantine_refired",
  );
  // 門が閉じたわけではない: 枠はきちんと空く
  expect(slot.currentTaskId).toBeNull();
});
