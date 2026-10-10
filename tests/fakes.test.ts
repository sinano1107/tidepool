import { expect, it } from "vitest";
import type { ExecutionSetting } from "../src/execution-setting.js";
import type { Task } from "../src/tasks.js";
import { FakeClock, healthyUsageText, recordingSpawn, ScriptedWorker, withHealthyUsage } from "./fakes.js";

/** `recordingSpawn()` が spawn のたびに新しい stdio を作ること(issue #846)。 */

const opts = { cwd: "/workspace", env: {} };

it("2本の process を起こすと、それぞれの stdin に書けて別々に読める(write after end にならない)", () => {
  const { spawn, processes } = recordingSpawn();

  spawn("claude", ["one"], { ...opts, stdin: "pipe" });
  processes[0]!.stdin.end("from first\n");

  spawn("claude", ["two"], { ...opts, stdin: "pipe" });
  // 共有 stdio のままなら1本目の end() の後の write after end で ERR_STREAM_WRITE_AFTER_END
  // が非同期に飛ぶ。ここで拾って捨て、失敗時も次の assert のズレだけが見えるようにする。
  processes[1]!.stdin.on("error", () => {});
  processes[1]!.stdin.write("from second\n");

  expect(processes[0]!.stdin.read()?.toString()).toBe("from first\n");
  expect(processes[1]!.stdin.read()?.toString()).toBe("from second\n");
});

/** `withHealthyUsage()` は usage check だけを差し替え、残りは中の adapter へ素通しする(issue #1787)。 */

it("withHealthyUsage: id は中の adapter のもので、start は query を含む全引数を、gracefulStop は taskId を中へ渡す", () => {
  const inner = new ScriptedWorker(new FakeClock(), "inner-agent");
  const worker = withHealthyUsage(inner, new FakeClock());
  const task = { id: "t1" } as Task;
  const setting = { provider: "claude-code" } as unknown as ExecutionSetting;

  worker.start(task, setting, { view: "tide chart drift" });
  worker.gracefulStop("t1");

  expect(worker.id).toBe("inner-agent");
  expect(inner.started).toEqual([task]);
  expect(inner.startedSettings).toEqual([setting]);
  expect(inner.startedQueries).toEqual([{ view: "tide chart drift" }]);
  expect(inner.gracefulStops).toEqual(["t1"]);
});

it("withHealthyUsage: checkUsage は中がスクリプトした失敗に関わらず、渡した clock の now から作った健全 text を返す", async () => {
  const inner = new ScriptedWorker(new FakeClock(), "inner-agent");
  inner.scriptUsage(null);
  const clock = new FakeClock();
  const worker = withHealthyUsage(inner, clock);

  expect(await worker.checkUsage()).toBe(healthyUsageText(clock.now()));
});
