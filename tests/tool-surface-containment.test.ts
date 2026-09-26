import { homedir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { enumerateToolsThrough, probeToolSurfaceCapability } from "../src/claude-worker.js";
import type { ContainmentCapability } from "../src/containment.js";
import { ProcessContainers } from "../src/process-container.js";
import { containerHarness, FakeClock, FakeContainerRuntime, recordingSpawn } from "./fakes.js";
import { api, bootTidepool, HOUR, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** 宣言どおりの work セッションの面(ADR 0039 の測定と同じ17本)。ここでも実装を
 *  import せず独立した literal で書く。 */
const WORK_SURFACE = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "Skill",
  "Task",
  "WebFetch",
  "WebSearch",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskOutput",
  "TaskStop",
];

const questions = async (t: Tidepool) =>
  ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((x) => x.type === "question");

const openQuestion = async (t: Tidepool) =>
  await vi.waitFor(async () => {
    const open = await questions(t);
    expect(open).toHaveLength(1);
    return open[0];
  });

/** ping を実際に何回撃ったか数えられる seam。**memoize しない**ことが要件である
 *  (解除は「能力検査を回答時にもう一度走らせて成立する」ことで検証されるため、
 *  再実行できない検査は確認 question を受理できない — ADR 0039 決定3)。 */
function scriptedProbe(initial: ContainmentCapability) {
  let current = initial;
  let calls = 0;
  return {
    probe: async () => {
      calls += 1;
      return current;
    },
    repair: (next: ContainmentCapability) => {
      current = next;
    },
    calls: () => calls,
  };
}

const harnessCheck = (check: () => Promise<ContainmentCapability>) => async (harness: string) =>
  harness === "claude-code" ? check() : ({ available: true } as const);

// ── ping から答えへの写像(正本の側)────────────────────────────────────

it("ping が観測した面が宣言どおりなら成立する", async () => {
  const observed = async () => ({ tools: WORK_SURFACE, mcpServers: [], autoMemoryPath: null });
  expect(await probeToolSurfaceCapability(observed)).toEqual({ available: true });
});

it("ping が失敗したら不成立 — 「測れなかった」は「無事」ではない", async () => {
  // `defaultEnumerateSkills` と同じ形で、CLI の不在・認証の詰まり・timeout はすべて
  // null に落ちる。ここを skip にすると3つ目の問いが黙って飾りになる。
  const result = await probeToolSurfaceCapability(async () => null);
  expect(result.available).toBe(false);
  expect(result.available === false && result.reason).toContain("could not");
});

it("ping は Board call の口を通り、口が答えを返さなければ(上限到達)不成立に倒れる", async () => {
  const spawn = recordingSpawn();
  const clock = new FakeClock();
  const { boardCall } = containerHarness(new ProcessContainers(new FakeContainerRuntime(spawn.spawn)), clock);
  const result = probeToolSurfaceCapability(enumerateToolsThrough(boardCall));
  await vi.waitFor(() => expect(spawn.calls).toHaveLength(1));
  // 容器の中へ、盤面が宣言する --tools と Board call の env(advisor を閉じる)で起こす
  expect(spawn.calls[0]!.command).toBe("claude");
  expect(spawn.calls[0]!.args).toContain("--tools");
  expect(spawn.calls[0]!.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");

  await clock.advance(60_000);

  expect((await result).available).toBe(false);
});

it("ping が allowlist 外のツールを観測したら不成立 — 具体名が残る", async () => {
  const result = await probeToolSurfaceCapability(async () => ({
    tools: [...WORK_SURFACE, "CronCreate"],
    mcpServers: [],
    autoMemoryPath: null,
  }));
  expect(result.available === false && result.reason).toContain("CronCreate");
});

it("検査は毎回 ping を撃ち直す(memoize しない)— 解除の検証がこれに依存する", async () => {
  let calls = 0;
  const enumerate = async () => {
    calls += 1;
    return { tools: WORK_SURFACE, mcpServers: [], autoMemoryPath: null };
  };
  await probeToolSurfaceCapability(enumerate);
  await probeToolSurfaceCapability(enumerate);
  expect(calls).toBe(2);
});

// ── auto-memory の閉鎖(ADR 0156 決定3)────────────────────────────────
// 正本の ping は auto-memory を閉じる設定**だけ**を inline の `--settings` で運び、
// init 報告の `memory_paths.auto` の不在を期待値にする。CLI がキーを改名して設定が
// 効かなくなれば `auto` が現れ、pickup の前に不成立になる。

/** ping を Board call の口に1回通し、偽の process に init 行を書いて exit させる。 */
async function probeWithInit(init: Record<string, unknown>) {
  const spawn = recordingSpawn();
  const { boardCall } = containerHarness(new ProcessContainers(new FakeContainerRuntime(spawn.spawn)));
  const result = probeToolSurfaceCapability(enumerateToolsThrough(boardCall));
  await vi.waitFor(() => expect(spawn.calls).toHaveLength(1));
  spawn.processes[0]!.stdout.write(
    `${JSON.stringify({ type: "system", subtype: "init", tools: WORK_SURFACE, mcp_servers: [], ...init })}\n`,
  );
  spawn.emitExit(0, null);
  return { result: await result, args: spawn.calls[0]!.args };
}

it("ping は auto-memory を閉じる設定だけを inline の --settings で運ぶ", async () => {
  const { args } = await probeWithInit({});
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
  // 期待値は独立した literal: #881 の実測で閉じた2キー(deny は書きの話で init に出ない)
  expect(settings).toEqual({
    autoMemoryEnabled: false,
    autoMemoryDirectory: `${homedir()}/.tidepool/claude-auto-memory`,
  });
});

it("init 報告に memory_paths.auto が有れば不成立 — 観測した値と ADR 0156 を言う", async () => {
  const { result } = await probeWithInit({ memory_paths: { auto: "/home/pi/.claude/projects/x/memory" } });
  expect(result.available).toBe(false);
  expect(result.available === false && result.reason).toContain("/home/pi/.claude/projects/x/memory");
  expect(result.available === false && result.reason).toContain("ADR 0156");
});

it("memory_paths が無い / auto 以外の項目だけなら成立 — ベンダーが別種の memory を足しても誤停止しない", async () => {
  expect((await probeWithInit({})).result).toEqual({ available: true });
  expect((await probeWithInit({ memory_paths: { team: "/x" } })).result).toEqual({ available: true });
});

// ── 封じ込め能力の3つ目の問いとしての振る舞い(ゲートの側)──────────────

it("ツール面がずれた Claude Harness は pickup が止まり、確認 question が立つ", async () => {
  const drifted = scriptedProbe({
    available: false,
    reason: "this host's claude CLI offered CronCreate on top of the allowlist",
  });
  t = await bootTidepool({
    harnessContainment: harnessCheck(drifted.probe),
  });
  await registerWork(t, "work that must not run on a host whose tool surface drifted");

  const question = await openQuestion(t);
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
  // 既存の器のまま: 1択の確認型、盤面(Tidepool)名義、停止は Harness 資源だけ
  expect(question.question_items[0].options).toEqual(["repaired by hand"]);
  expect(question).toMatchObject({ question_quarantine_kind: "harnessContainment", question_quarantine_value: "claude-code" });
  expect(question.purpose).toContain("CronCreate");
});

it("ツール面が成立している Claude Harness は pickup を止めない", async () => {
  const ok = scriptedProbe({ available: true });
  t = await bootTidepool({ harnessContainment: harnessCheck(ok.probe) });
  const task = await registerWork(t, "work on a host whose tool surface matches the allowlist");

  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([task.id]));
  expect(await questions(t)).toEqual([]);
});

it("ずれたままの回答は受理されない — question は open のまま(検証つき解除)", async () => {
  const drifted = scriptedProbe({
    available: false,
    reason: "this host's claude CLI offered CronCreate on top of the allowlist",
  });
  t = await bootTidepool({
    harnessContainment: harnessCheck(drifted.probe),
  });
  const question = await openQuestion(t);

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(res.status).toBe(409);
  expect(res.json.error).toContain("claude-code Harness containment is still not established");
  expect((await questions(t))[0].status).toBe("todo");
});

it("面を直せば回答が受理され、pickup が再開する(回答時にもう一度 ping が走る)", async () => {
  const drifted = scriptedProbe({
    available: false,
    reason: "this host's claude CLI offered CronCreate on top of the allowlist",
  });
  t = await bootTidepool({
    harnessContainment: harnessCheck(drifted.probe),
  });
  const task = await registerWork(t, "work that waited for a repaired tool surface");
  const question = await openQuestion(t);
  const before = drifted.calls();

  drifted.repair({ available: true });
  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(res.status).toBe(200);
  // 受理の判断は「回答が来た」ではなく「もう一度撃って成立した」に依っている
  expect(drifted.calls()).toBeGreaterThan(before);
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([task.id]));
});

it("fs 半分が不成立ならツール面の ping は撃たない — 安い順に引く", async () => {
  // 実 CLI を1本起こす検査なので、手前の半分で答えが出ているなら撃たない。
  const ok = scriptedProbe({ available: true });
  const sandbox: ContainmentCapability = {
    available: false,
    reason: "bwrap could not create a sandbox",
  };
  t = await bootTidepool({
    harnessContainment: harnessCheck(async () => {
      return sandbox.available ? ok.probe() : sandbox;
    }),
  });
  await openQuestion(t);
  expect(ok.calls()).toBe(0);
});
