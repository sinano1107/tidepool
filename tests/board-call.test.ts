import { expect, it, vi } from "vitest";
import { type BoardCallSpec, createBoardCalls } from "../src/board-call.js";
import type { ContainedProcess } from "../src/process-container.js";
import { ProcessContainers } from "../src/process-container.js";
import { RECLAIM_TIMEOUT } from "../src/watchdog.js";
import { FakeClock, FakeContainerRuntime, recordingSpawn } from "./fakes.js";

/** Board call の口(ADR 0136)のドメイン層。容器機構は fake、process は scripted、
 *  時間は FakeClock —— 口が持つのは「容器・上限・force・観測の順序」だけなので、
 *  実 CLI も実カーネルも要らない。 */

const LIMIT = 15_000;

const spec: BoardCallSpec = {
  kind: "skill enumeration",
  command: "claude",
  args: ["-p", "/usage"],
  cwd: "/workspaces/sandbox",
  env: { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" },
  limitMs: LIMIT,
};

/** stdout を読み切って返す reader。口は答えの形を知らないので、テストは
 *  「口が root の exit のあとに1度だけ読む」ことだけを使う。 */
const readAll = (proc: ContainedProcess) => {
  let text = "";
  proc.stdout.on("data", (chunk: Buffer | string) => {
    text += chunk.toString();
  });
  return () => text || null;
};

function setup() {
  const { calls: spawns, ...recorder } = recordingSpawn();
  const clock = new FakeClock();
  const runtime = new FakeContainerRuntime(recorder.spawn);
  const containers = new ProcessContainers(runtime);
  const quarantined: string[] = [];
  const calls = createBoardCalls({
    containers,
    clock,
    reclaimTimeout: RECLAIM_TIMEOUT,
    onReclaimTimeout: (reason) => quarantined.push(reason),
  });
  const spawned = (n: number) => vi.waitFor(() => expect(spawns.length).toBe(n));
  /** stdout に1行流して、reader がそれを受け取るまで待つ(PassThrough の data は
   *  次の tick で届くので、書いた直後に exit を撃つと読み落とす)。 */
  const say = async (text: string) => {
    recorder.stdout.write(text);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ...recorder, spawns, clock, runtime, containers, calls, quarantined, spawned, say };
}

it("呼び出し1回につき容器が1つ開き、重なった呼び出しは別の容器を持つ", async () => {
  const t = setup();
  const first = t.calls.call(spec, readAll);
  const second = t.calls.call(spec, readAll);
  await t.spawned(2);

  expect(new Set(t.runtime.created).size).toBe(2);
  t.emitExitAt(0, 0, null);
  t.emitExitAt(1, 0, null);
  await Promise.all([first, second]);
});

it("容器の中へ起こす — cwd と Board call の env がそのまま process 境界に現れる", async () => {
  const t = setup();
  const call = t.calls.call(spec, readAll);
  await t.spawned(1);

  expect(t.spawns[0]!.command).toBe("claude");
  expect(t.spawns[0]!.cwd).toBe("/workspaces/sandbox");
  expect(t.spawns[0]!.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
  t.emitExit(0, null);
  await call;
});

it("root の exit で強制回収が撃たれる", async () => {
  const t = setup();
  const call = t.calls.call(spec, readAll);
  await t.spawned(1);
  expect(t.runtime.forceReclaims).toEqual([]);

  await t.say("skills");
  t.emitExit(0, null);

  expect(await call).toBe("skills");
  expect(t.runtime.forceReclaims).toEqual(t.runtime.created);
});

it("時間上限の到達で強制回収が撃たれ、呼び出しは fail-closed の結果を返す", async () => {
  const t = setup();
  const call = t.calls.call(spec, readAll);
  await t.spawned(1);
  await t.say("half an answer");

  await t.clock.advance(LIMIT);

  expect(await call).toBeNull();
  expect(t.runtime.forceReclaims).toEqual(t.runtime.created);
});

it("既定の結果は root の exit で返る — 容器が空にならなくても待たない", async () => {
  const t = setup();
  const call = t.calls.call(spec, readAll);
  await t.spawned(1);
  t.runtime.hold(t.runtime.created[0]!); // force では空にならないホスト

  await t.say("skills");
  t.emitExit(0, null);

  expect(await call).toBe("skills");
});

it("回収済み観測のあとに返す呼び出しは、容器が空になるまで返らない", async () => {
  const t = setup();
  const call = t.calls.call({ ...spec, awaitReclaimed: true }, readAll);
  await t.spawned(1);
  const container = t.runtime.created[0]!;
  t.runtime.hold(container);

  await t.say("skills");
  t.emitExit(0, null);
  let settled = false;
  void call.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);

  t.runtime.fireEmpty(container);

  expect(await call).toBe("skills");
});

it("機構前提検査が不成立なら process を起こさず、その呼び出しの fail-closed の結果を返す", async () => {
  const t = setup();
  t.runtime.scriptPreflight("cgroup v2 is not mounted at /sys/fs/cgroup");

  expect(await t.calls.call(spec, readAll)).toBeNull();
  expect(t.spawns).toEqual([]);
  expect(t.runtime.created).toEqual([]);
});

it("強制回収のあと回収 timeout まで空を観測できなければ、盤面へ不成立を報告する", async () => {
  const t = setup();
  const call = t.calls.call(spec, readAll);
  await t.spawned(1);
  const container = t.runtime.created[0]!;
  t.runtime.hold(container);
  t.emitExit(0, null);
  await call;
  expect(t.quarantined).toEqual([]);

  await t.clock.advance(RECLAIM_TIMEOUT);

  // 文面から「Board call の容器であること」と「呼び出しの種類」が読める
  expect(t.quarantined).toHaveLength(1);
  expect(t.quarantined[0]).toContain("Board call");
  expect(t.quarantined[0]).toContain("skill enumeration");
  // 回答時の再検査が読む口も同じことを答える
  expect(t.calls.pendingReclaim()).toContain("skill enumeration");

  // 遅れて空になれば保留は解ける
  t.runtime.fireEmpty(container);
  await new Promise((resolve) => setImmediate(resolve));
  expect(t.calls.pendingReclaim()).toBeUndefined();
});

it("空になった呼び出しは回収 timeout を報告しない", async () => {
  const t = setup();
  const call = t.calls.call(spec, readAll);
  await t.spawned(1);
  t.emitExit(0, null);
  await call;

  await t.clock.advance(RECLAIM_TIMEOUT * 2);

  expect(t.quarantined).toEqual([]);
  expect(t.calls.pendingReclaim()).toBeUndefined();
});

it("機構前提検査に渡る「今生きている容器」に、実行中の Board call の容器が含まれる", async () => {
  const t = setup();
  const call = t.calls.call(spec, readAll);
  await t.spawned(1);

  t.containers.preflight();

  expect([...(t.runtime.preflightLive.at(-1) ?? [])]).toContain(t.runtime.created[0]!);
  t.emitExit(0, null);
  await call;
});

it("答えを読む関数は root の exit code を受け取る — 口が決着する前に読み手が exit を見る順序に依らない", async () => {
  const t = setup();
  const call = t.calls.call(spec, (proc) => {
    const text = readAll(proc);
    return (exitCode) => `${text()} exited ${exitCode}`;
  });
  await t.spawned(1);

  await t.say("envelope");
  t.emitExit(1, null);

  expect(await call).toBe("envelope exited 1");
});

it("stdin は既定で閉じており、opt-in した呼び出しだけが開けたまま書ける", async () => {
  const t = setup();
  const closed = t.calls.call(spec, readAll);
  await t.spawned(1);
  expect(t.spawns[0]!.stdin).toBeUndefined();
  t.emitExitAt(0, 0, null);
  await closed;

  const piped = t.calls.call({ ...spec, stdin: "pipe" }, (proc) => {
    proc.stdin!.write("request\n");
    return () => "written";
  });
  await t.spawned(2);
  expect(t.spawns[1]!.stdin).toBe("pipe");
  expect(t.stdin.read()?.toString()).toBe("request\n");
  t.emitExitAt(1, 0, null);
  expect(await piped).toBe("written");
});
