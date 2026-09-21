import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  CODEX_CLI_VERSION,
  CODEX_DEVELOPER_MARKER,
  CODEX_FEATURE_SNAPSHOT,
  type CodexCapabilityObservation,
  checkCodexCapability,
  createCodexCapabilityCheck,
  observedDeveloperMarkers,
  observedHooks,
} from "../src/codex-worker.js";
import { listEvents } from "../src/events.js";
import { harnessContainmentPickupBlocked } from "../src/harness-containment.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { ProcessContainers } from "../src/process-container.js";
import { canonicalHarness } from "../src/registry.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { getTask, listBoard, registerTask, type Task } from "../src/tasks.js";
import type { WorkerAdapter } from "../src/worker.js";
import {
  containerHarness,
  FakeClock,
  FakeContainerRuntime,
  healthyUsageText,
  passthroughContainers,
  recordingSpawn,
  unusedLanding,
} from "./fakes.js";
import { api, bootTidepool, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** 盤面が `installBoardHook` で置く hook のパス。preflight はこのパスから期待する登録を組む。 */
const BOARD_HOOK_PATH = "/board/codex-home/tidepool-hooks/main-thread-mcp.mjs";
/** 盤面が Codex に登録されていることを要求する hook —— ADR 0130 決定3 の4項目
 *  (event・matcher・enabled・source)に #731 が `command` を足したもの。
 *  `trustStatus` は session flags 由来なら常に untrusted なので見ない。 */
const BOARD_HOOK_REGISTRATION = {
  event: "preToolUse",
  matcher: "mcp__tidepool__.*",
  enabled: true,
  source: "sessionFlags",
  command: BOARD_HOOK_PATH,
};

const VALID: CodexCapabilityObservation = {
  cliVersion: CODEX_CLI_VERSION,
  skills: [],
  hooks: [BOARD_HOOK_REGISTRATION],
  permissions: ["tidepool-work", "tidepool-review"],
  features: CODEX_FEATURE_SNAPSHOT,
  developerMarkers: [CODEX_DEVELOPER_MARKER],
};

it("preflight は Board call の口を通り、口が答えを返さなければ(上限到達)封じ込めを不成立に倒す", async () => {
  const spawn = recordingSpawn();
  const clock = new FakeClock();
  const { boardCall } = containerHarness(new ProcessContainers(new FakeContainerRuntime(spawn.spawn)), clock);
  const capability = createCodexCapabilityCheck({
    executable: "/opt/tidepool/bin/codex",
    codexHome: "/nonexistent/codex-home",
    workspace: mkdtempSync(join(tmpdir(), "tidepool-codex-preflight-ws-")),
    call: boardCall,
  })();
  await vi.waitFor(() =>
    expect(spawn.calls.map((c) => [c.command, ...c.args])).toEqual([["/opt/tidepool/bin/codex", "--version"]]),
  );

  await clock.advance(60_000);

  expect(await capability).toMatchObject({
    available: false,
    reason: expect.stringContaining("Codex containment preflight could not run"),
  });
});

it("workspace を cwd にする preflight の呼び出しは、容器が空になるまで次へ進まない(ADR 0136 決定5)", async () => {
  const spawn = recordingSpawn();
  const runtime = new FakeContainerRuntime(spawn.spawn);
  const clock = new FakeClock();
  const { boardCall } = containerHarness(new ProcessContainers(runtime), clock);
  const workspace = mkdtempSync(join(tmpdir(), "tidepool-codex-preflight-ws-"));
  const capability = createCodexCapabilityCheck({
    executable: "/opt/tidepool/bin/codex",
    codexHome: "/nonexistent/codex-home",
    workspace,
    call: boardCall,
  })();
  await vi.waitFor(() => expect(spawn.calls).toHaveLength(1));
  spawn.emitExitAt(0, 0, null);
  await vi.waitFor(() => expect(spawn.calls).toHaveLength(2));
  expect(spawn.calls[1]!.args.slice(0, 2)).toEqual(["debug", "prompt-input"]);
  runtime.hold(runtime.created[1]!); // force では空にならないホスト
  spawn.emitExitAt(1, 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  expect(spawn.calls).toHaveLength(2);

  runtime.fireEmpty(runtime.created[1]!);
  await vi.waitFor(() => expect(spawn.calls).toHaveLength(3));
  await clock.advance(60_000);
  expect((await capability).available).toBe(false);
});

it("宣言どおりの観測は封じ込めを成立させる", async () => {
  expect(await checkCodexCapability(async () => VALID, BOARD_HOOK_PATH)).toEqual({ available: true });
});

it.each([
  ["version", { cliVersion: "codex-cli 0.148.0" }],
  ["skill", { skills: ["openai-docs"] }],
  // hook の登録 drift(ADR 0130 決定3): 登録されなかった、matcher が書き換わった、
  // 無効化された、別 source から上書きされた、別のスクリプトが登録された
  ["hook (登録が無い)", { hooks: [] }],
  ["hook (matcher が違う)", { hooks: [{ ...BOARD_HOOK_REGISTRATION, matcher: ".*" }] }],
  ["hook (enabled=false)", { hooks: [{ ...BOARD_HOOK_REGISTRATION, enabled: false }] }],
  ["hook (別 source)", { hooks: [{ ...BOARD_HOOK_REGISTRATION, source: "userConfig" }] }],
  ["hook (別の command)", { hooks: [{ ...BOARD_HOOK_REGISTRATION, command: "/tmp/someone-elses-hook.mjs" }] }],
  ["permission", { permissions: ["tidepool-work"] }],
  // 盤面の文面が developer 層に届かなかった3つの形(ADR 0124 決定4): 鍵が無視された、
  // 別の層に載った、item の構造が変わった
  ["developer instructions (空)", { developerMarkers: [] }],
  ["developer instructions (別値)", { developerMarkers: ["some other text"] }],
  ["developer instructions (重複)", { developerMarkers: [CODEX_DEVELOPER_MARKER, CODEX_DEVELOPER_MARKER] }],
] as const)("Codex %s surface drift fails its Harness preflight closed", async (_, changed) => {
  const capability = await checkCodexCapability(async () => ({ ...VALID, ...changed }), BOARD_HOOK_PATH);
  expect(capability.available).toBe(false);
  if (!capability.available) expect(capability.reason).toContain("Codex containment preflight");
});

it.each([
  [
    "ベンダーが増やした未知の名前",
    { ...CODEX_FEATURE_SNAPSHOT, vendor_new_thing: "true" },
    "vendor_new_thing (expected absent, observed true)",
  ],
  [
    "既存の名前が false から true へ転ぶ",
    { ...CODEX_FEATURE_SNAPSHOT, code_mode: "true" },
    "code_mode (expected false, observed true)",
  ],
  [
    "期待していた名前が面から消える",
    Object.fromEntries(Object.entries(CODEX_FEATURE_SNAPSHOT).filter(([name]) => name !== "computer_use")),
    "computer_use (expected false, observed absent)",
  ],
] as const)("feature 面の%sは preflight を倒し、reason は差分だけを載せる", async (_, features, expected) => {
  const capability = await checkCodexCapability(async () => ({ ...VALID, features }), BOARD_HOOK_PATH);
  expect(capability.available).toBe(false);
  if (!capability.available) {
    expect(capability.reason).toContain(expected);
    expect(capability.reason).not.toContain("apply_patch_freeform");
  }
});

it("届かなかった理由は期待値と観測値の両方を名指す(ADR 0124 決定4)", async () => {
  const capability = await checkCodexCapability(async () => ({ ...VALID, developerMarkers: [] }), BOARD_HOOK_PATH);
  expect(capability.available).toBe(false);
  if (!capability.available) {
    expect(capability.reason).toContain(CODEX_DEVELOPER_MARKER);
    expect(capability.reason).toContain("observed []");
  }
});

// 実物の `codex debug prompt-input` 出力(0.147.0、運用者の config から隔離した盤面所有の
// CODEX_HOME で叩いたもの)。採取時は preflight と同じ config 列だったが、その後 preflight から
// `features.multi_agent=false` が外れた(ADR 0134 決定1)—— ここが読むのは marker と skills だけで
// feature 値も `-c` 列も見ないので採り直していない。
// workspace のパスだけ無害な固定値へ、marker だけ実装の定数へ置換してある。
const promptInput = (name: string) =>
  readFileSync(new URL(`fixtures/codex-prompt-input-${name}.json`, import.meta.url), "utf8");

it("prompt-input の developer item に載った marker だけを拾う(ADR 0124 決定4)", () => {
  expect(observedDeveloperMarkers(promptInput("developer-marker"))).toEqual([CODEX_DEVELOPER_MARKER]);
  expect(observedDeveloperMarkers(promptInput("no-marker"))).toEqual([]);

  // 同じ文字列が user item に載っているだけの形(別の層に載った)は観測に数えない
  const items = JSON.parse(promptInput("no-marker")) as Array<{ content: Array<{ type: string; text: string }> }>;
  items.at(-1)!.content.push({ type: "input_text", text: CODEX_DEVELOPER_MARKER });
  expect(observedDeveloperMarkers(JSON.stringify(items))).toEqual([]);
});

// 実物の `hooks/list` 応答の `result`(codex-cli 0.147.0、盤面所有の CODEX_HOME、model 呼び出し無し。
// `initialize` → `initialized` → `hooks/list {"cwds":[]}` を app-server へ流して得たもの)。
// `cwd` と `command` だけ無害な固定パスへ置換してある —— vendor は `command` を realpath せず、
// 渡した文字列をそのまま返す。
const hooksListResult = () =>
  JSON.parse(readFileSync(new URL("fixtures/codex-hooks-list.json", import.meta.url), "utf8"));

it("hooks/list の応答から、盤面が照合する登録の項目だけを取り出す(ADR 0130 決定3)", () => {
  expect(observedHooks(hooksListResult())).toEqual([BOARD_HOOK_REGISTRATION]);

  // 登録が1つも無い形の2種: cwd の entry 自体が無い / entry はあるが hooks が空
  expect(observedHooks({ data: [] })).toEqual([]);
  const empty = hooksListResult();
  empty.data[0].hooks = [];
  expect(observedHooks(empty)).toEqual([]);

  // vendor の schema では matcher / command とも optional かつ nullable —— 欠けた形は null に揃える
  const bare = hooksListResult();
  delete bare.data[0].hooks[0].matcher;
  bare.data[0].hooks[0].command = null;
  expect(observedHooks(bare)).toEqual([{ ...BOARD_HOOK_REGISTRATION, matcher: null, command: null }]);

  // 複数件は cwd を跨いでも並びのまま畳む —— 宣言との比較は集合ではなく列で行う
  const many = hooksListResult();
  const second = { ...many.data[0].hooks[0], matcher: "Bash", enabled: false };
  many.data.push({ ...many.data[0], hooks: [second] });
  expect(observedHooks(many)).toEqual([
    BOARD_HOOK_REGISTRATION,
    { ...BOARD_HOOK_REGISTRATION, matcher: "Bash", enabled: false },
  ]);
});

it("a failed Codex Harness preflight skips that route and starts a Claude-route row in the same poll", async () => {
  t = await bootTidepool();
  const db = t.db;
  const clock = new FakeClock();
  const started: string[] = [];
  const worker: WorkerAdapter = {
    id: "claude-agent",
    start: (task) => started.push(task.id),
    gracefulStop() {},
    checkUsage: async () => healthyUsageText(clock.now()),
  };
  const codex = registerTask(db, {
    type: "work",
    assignee: "codex-agent",
    title: "Codex head",
    purpose: "exercise Codex",
    completion_criteria: "done",
  }, clock.now());
  const claude = registerTask(db, {
    type: "work",
    assignee: "claude-agent",
    title: "Claude next",
    purpose: "keep working",
    completion_criteria: "done",
  }, clock.now());
  const providers = new Map<string, "openai" | "anthropic">([
    ["codex-agent", "openai"],
    ["claude-agent", "anthropic"],
  ]);
  const scheduler = startScheduler({
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: passthroughContainers(),
    onSpawnFailed: () => {},
    resolveHarness: (task: Task) => canonicalHarness(providers.get(task.assignee!)!),
    harnessContainment: async (harness) =>
      harness === "codex"
        ? { available: false, reason: "Codex containment preflight: permission drift" }
        : { available: true },
  });

  await clock.advance(HOURLY);

  expect(started).toEqual([claude.id]);
  expect(codex.status).toBe("todo");
  const quarantine = listBoard(db).find(
    (task) => (task.question_quarantine_kind === "harnessContainment" && task.question_quarantine_value === "codex") && task.status === "todo",
  );
  expect(quarantine).toMatchObject({ question_quarantine_kind: "harnessContainment", question_quarantine_value: "codex", status: "todo" });
  scheduler.stop();
});

it("a Harness quarantine answer is accepted only after the same live check recovers", async () => {
  t = await bootTidepool();
  const db = t.db;
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
  );
  expect(getTask(db, questionId!)?.status).toBe("done");
  expect(listEvents(db, questionId!).at(-1)?.payload).toMatchObject({
    kind: "quarantine_released",
    quarantine: "harnessContainment",
    value: "codex",
  });
});

it("the public queue and answer routes expose a durable Harness-scoped stop without halting another route", async () => {
  let codexHealthy = false;
  const tidepool = await bootTidepool({
    resolveHarness: (task) => task.assignee === "codex-agent" ? "codex" : "claude-code",
    harnessContainment: async (harness) =>
      harness === "codex" && !codexHealthy
        ? { available: false, reason: "permission canary failed" }
        : { available: true },
    quarantineResolvers: {
      harnessContainment: (harnesses) => (harnesses.includes("codex") ? ["codex-agent"] : []),
    },
  });
  try {
    const codex = await registerWork(
      tidepool,
      "Codex waits for its Harness",
      undefined,
      undefined,
      "codex-agent",
    );
    const claude = await registerWork(
      tidepool,
      "Claude keeps flowing",
      undefined,
      undefined,
      "claude-agent",
    );
    await api(tidepool.baseUrl, "POST", `/api/tasks/${claude.id}/move`, { after: null });
    await vi.waitFor(() => expect(tidepool.worker.started.map((task) => task.id)).toEqual([claude.id]));

    const queue = (await api(tidepool.baseUrl, "GET", "/api/queue")).json as { tasks: any[] };
    expect(queue.tasks.find((task) => task.id === codex.id)?.status).toBe("skipped");
    const tasks = (await api(tidepool.baseUrl, "GET", "/api/tasks")).json as any[];
    const question = tasks.find((task) => (task.question_quarantine_kind === "harnessContainment" && task.question_quarantine_value === "codex"));
    expect(question?.question_items[0].options).toEqual(["repaired by hand"]);

    const refused = await api(tidepool.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
      answers: ["repaired by hand"],
    });
    expect(refused.status).toBe(409);
    codexHealthy = true;
    const accepted = await api(tidepool.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
      answers: ["repaired by hand"],
    });
    expect(accepted.status).toBe(200);
  } finally {
    await tidepool.stop();
  }
});
