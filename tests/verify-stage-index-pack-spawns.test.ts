import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { pickupTask, registerTask } from "../src/tasks.js";
import { recordTaskCheckoutTip } from "../src/workspace.js";
import { commitWork, GIT_FIXTURE_TEST_TIMEOUT, HUMAN_WEBUI, makeWorkspace, prepareAtPickup } from "./harness.js";

// 素通しの spy で git の起動だけを数える。mock がほかのテストへ漏れないよう、このファイルに隔離する(registry-git-spawns と同じ形)。
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-21T00:00:00.000Z");

it("落ちない検証の段は index-pack を --strict の1回だけ撃ち、名前の場所なしの確かめ直しを走らせない(issue #3495)", async () => {
  const db = openDb(":memory:");
  try {
    const ws = await makeWorkspace("index-pack-spawns");
    const task = pickupTask(db, registerTask(db, { type: "work", title: "one", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI), "deckhand", NOW)!;
    const place = await prepareAtPickup(db, ws, task);
    commitWork(place.path, "work.txt", "work\n");
    vi.mocked(execFileSync).mockClear();

    recordTaskCheckoutTip(db, place, task.id);

    // 運んだ後の確かめ(ADR 0398 決定1 の `misnamedObjects`)も flag の無い index-pack を撃つ —— 検証の段の `--strict` と確かめ直しの
    // `--fsck-objects` だけを数える
    const flags = vi
      .mocked(execFileSync)
      .mock.calls.filter(([file, args]) => file === "git" && (args as string[]).includes("index-pack"))
      .flatMap(([, args]) => (args as string[]).filter((arg) => arg === "--strict" || arg === "--fsck-objects"));
    expect(flags).toEqual(["--strict"]);
  } finally {
    db.close();
  }
});
