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
//
// ADR 0039 決定3: ツール面のドリフトは workspace の性質でも agent の性質でもなく
// **ホストの性質**である — このホストの CLI が盤面の宣言を honor しなくなった、
// という事実 — ので、封じ込め能力の3つ目の問いになる(CONTEXT.md の Containment
// capability)。`probeToolSurfaceCapability` は観測した面を盤面の唯一の照合関数に
// 通すだけで、その照合関数は実セッションの init 行の照合(claude-worker.test.ts)と
// **同じ1つ**を共有する(期待集合を2箇所に置かない)。
//
// 検知は双方向である。観測 ⊃ 期待は「宣言が honor されなくなった / 新ツールが
// 素通りしてきた」、観測 ⊂ 期待は「挙げた名前が改名・廃止されて黙って不活性化した」
// (測定8: `TodoWrite` と `Bogus` が何の警告もなく消えた)。後者は worker が能力を
// 1つ失ったまま走り続けるので、タスクが詰まって初めて分かる。したがって組み込み
// ツールの照合は**集合の一致**である。
//
// MCP 軸は非対称で、**過剰側だけ**を見る(ADR 0108 決定1)。`mcp__` を照合から
// 外した理由は欠落側にしか掛からないので、宣言外のサーバが面にあれば不成立、
// 欠落は一切見ない。

it("ping が観測した面が宣言どおりなら成立する", async () => {
  expect(
    await probeToolSurfaceCapability(async () => ({
      tools: WORK_SURFACE,
      mcpServers: [],
      autoMemoryPath: null,
    })),
  ).toEqual({ available: true });
  // init の `tools` 配列の順序は CLI の内部順であって盤面の綴り順ではない(集合の一致)
  expect(
    await probeToolSurfaceCapability(async () => ({
      tools: [...WORK_SURFACE].reverse(),
      mcpServers: [],
      autoMemoryPath: null,
    })),
  ).toEqual({ available: true });
});

it("`mcp__` で始まるエントリは比較対象から外す — MCP の落下を封じ込めの不成立に化けさせない", async () => {
  // MCP サーバーが繋がらなかったセッションでは verb が丸ごと消える。含めると
  // 「盤面の MCP が落ちている」が封じ込め能力の不成立に化ける。それは別の障害で
  // あり別の扱いを受けるべきである(ADR 0039 決定3)。
  const result = await probeToolSurfaceCapability(async () => ({
    tools: [...WORK_SURFACE, "mcp__tidepool__get_current_task"],
    mcpServers: [],
    autoMemoryPath: null,
  }));
  expect(result).toEqual({ available: true });
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

it("観測 ⊂ 期待も不成立 — 黙って不活性化した名前を挙げる(測定8)", async () => {
  const result = await probeToolSurfaceCapability(async () => ({
    tools: WORK_SURFACE.filter((tool) => tool !== "Glob" && tool !== "TaskOutput"),
    mcpServers: [],
    autoMemoryPath: null,
  }));
  expect(result.available === false && result.reason).toContain("Glob");
  expect(result.available === false && result.reason).toContain("TaskOutput");
});

it("過不足が同時に起きたら両方を挙げる(綴りの取り違えの形そのもの)", async () => {
  // `Glob` を `Globb` と書けば、期待側に `Globb` が現れ観測側から `Glob` が消える
  // ——「1本足して1本落ちた」ではなく綴りミス1つである、と読める文が要る。
  const result = await probeToolSurfaceCapability(async () => ({
    tools: [...WORK_SURFACE.filter((tool) => tool !== "Grep"), "Bogus"],
    mcpServers: [],
    autoMemoryPath: null,
  }));
  expect(result.available === false && result.reason).toContain("Bogus");
  expect(result.available === false && result.reason).toContain("Grep");
});

it("空の観測は不成立 — 「測れなかった」を「無事」と読ませない(ping が失敗した null とは別の形)", async () => {
  const result = await probeToolSurfaceCapability(async () => ({
    tools: [],
    mcpServers: [],
    autoMemoryPath: null,
  }));
  expect(result.available).toBe(false);
});

it("宣言していない MCP サーバが面にあれば不成立 — そのサーバ名が本文に載る", async () => {
  // 盤面が MCP について宣言しているのは自分が書いた `--mcp-config` と
  // `--strict-mcp-config` の2つだけなので、それ以外の名前が面にあることは
  // 「このホストの CLI が盤面の宣言を honor しなくなった」である。
  const result = await probeToolSurfaceCapability(async () => ({
    tools: WORK_SURFACE,
    mcpServers: ["tidepool", "computer-use"],
    autoMemoryPath: null,
  }));
  expect(result.available === false && result.reason).toContain("computer-use");
});

it("盤面が宣言した `tidepool` だけなら成立 — 実セッションの形", async () => {
  const result = await probeToolSurfaceCapability(async () => ({
    tools: WORK_SURFACE,
    mcpServers: ["tidepool"],
    autoMemoryPath: null,
  }));
  expect(result).toEqual({ available: true });
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

it("init 報告に memory_paths.auto が無ければ成立", async () => {
  expect((await probeWithInit({})).result).toEqual({ available: true });
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
