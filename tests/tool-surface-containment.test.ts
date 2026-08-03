import { afterEach, expect, it, vi } from "vitest";
import { probeToolSurfaceCapability } from "../src/claude-worker.js";
import type { ContainmentCapability } from "../src/containment.js";
import { api, bootTidepool, HOUR, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** fs 半分と人間面の半分は成立している盤面。ADR 0039 が足したのは**3つ目の問い**
 *  なので、他の半分の不成立と混ざらない盤面で駆動する(issue #154 が fs 半分に
 *  対して取ったのと同じ姿勢)。 */
const SANDBOX_OK = () => ({ available: true }) as const;

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

// ── ping から答えへの写像(正本の側)────────────────────────────────────

it("ping が観測した面が宣言どおりなら成立する", async () => {
  expect(await probeToolSurfaceCapability(async () => WORK_SURFACE)).toEqual({ available: true });
});

it("ping が失敗したら不成立 — 「測れなかった」は「無事」ではない", async () => {
  // `defaultEnumerateSkills` と同じ形で、CLI の不在・認証の詰まり・timeout はすべて
  // null に落ちる。ここを skip にすると3つ目の問いが黙って飾りになる。
  const result = await probeToolSurfaceCapability(async () => null);
  expect(result.available).toBe(false);
  expect(result.available === false && result.reason).toContain("could not");
});

it("ping が allowlist 外のツールを観測したら不成立 — 具体名が残る", async () => {
  const result = await probeToolSurfaceCapability(async () => [...WORK_SURFACE, "CronCreate"]);
  expect(result.available === false && result.reason).toContain("CronCreate");
});

it("検査は毎回 ping を撃ち直す(memoize しない)— 解除の検証がこれに依存する", async () => {
  let calls = 0;
  const enumerate = async () => {
    calls += 1;
    return WORK_SURFACE;
  };
  await probeToolSurfaceCapability(enumerate);
  await probeToolSurfaceCapability(enumerate);
  expect(calls).toBe(2);
});

// ── 封じ込め能力の3つ目の問いとしての振る舞い(ゲートの側)──────────────

it("ツール面がずれているホストは pickup が止まり、Tidepool 名義の確認 question が立つ", async () => {
  const drifted = scriptedProbe({
    available: false,
    reason: "this host's claude CLI offered CronCreate on top of the allowlist",
  });
  t = await bootTidepool({ sandboxCapability: SANDBOX_OK, toolSurface: drifted.probe });
  await registerWork(t, "work that must not run on a host whose tool surface drifted");

  const question = await openQuestion(t);
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
  // 既存の器のまま: 1択の確認型、盤面(Tidepool)名義、止まる資源は盤面全体
  expect(question.question_items[0].options).toEqual(["repaired by hand"]);
  expect(question.purpose).toContain("CronCreate");
});

it("成立しているホストは素通り — 3つ目の問いは pickup を止めない", async () => {
  const ok = scriptedProbe({ available: true });
  t = await bootTidepool({ sandboxCapability: SANDBOX_OK, toolSurface: ok.probe });
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
  t = await bootTidepool({ sandboxCapability: SANDBOX_OK, toolSurface: drifted.probe });
  const question = await openQuestion(t);

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(res.status).toBe(409);
  expect(res.json.error).toContain("worker containment is still not established");
  expect((await questions(t))[0].status).toBe("todo");
});

it("面を直せば回答が受理され、pickup が再開する(回答時にもう一度 ping が走る)", async () => {
  const drifted = scriptedProbe({
    available: false,
    reason: "this host's claude CLI offered CronCreate on top of the allowlist",
  });
  t = await bootTidepool({ sandboxCapability: SANDBOX_OK, toolSurface: drifted.probe });
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
  t = await bootTidepool({
    sandboxCapability: () => ({ available: false, reason: "bwrap could not create a sandbox" }),
    toolSurface: ok.probe,
  });
  await openQuestion(t);
  expect(ok.calls()).toBe(0);
});
