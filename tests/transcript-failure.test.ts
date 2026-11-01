import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeCodeWorker, type ClaudeWorkerOptions } from "../src/claude-worker.js";
import { CodexWorker } from "../src/codex-worker.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import type { Provider } from "../src/provider.js";
import type { WorkerFactory } from "../src/server.js";
import { type PromptRecord, RecordContainerError, type Transcript, TranscriptStore } from "../src/transcript-store.js";
import { closedCodexSkillsCall, FakeContainerRuntime, healthyOpenai, noSkillPings, recordingSpawn, withHealthyUsage } from "./fakes.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  git,
  HOUR,
  mcpClient,
  questions,
  queueWork,
  servedQuarantineQuestion,
  type Tidepool,
} from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

/** ADR 0149(issue #911)。transcript を取れない session は走らせず、走ってから書けなく
 *  なった session はその場で強制回収する —— 盤面は落ちず、記録を捨てて続けることもない。 */

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

const MIN = 60 * 1000;
const WATCHDOG = { timeLimits: { work: 90 * MIN }, grace: 30 * MIN, reclaimTimeout: 5 * MIN };

/** 後始末は回収済み観測の後ろ = microtask の先にある。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const status = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json.status;
const events = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json;
const teardown = async () => (await api(t.baseUrl, "GET", "/api/queue")).json.teardown;

/** 盤面に渡す transcript の器。テストは開かれた session の stream をここから取って落とす。 */
class RecordingTranscripts extends TranscriptStore {
  readonly opened = new Map<string, Transcript>();
  override open(taskId: string, workerSpawnedEventId: number, prompt: PromptRecord) {
    const opened = super.open(taskId, workerSpawnedEventId, prompt);
    this.opened.set(taskId, opened);
    return opened;
  }
}

/** 実 adapter を盤面に載せる。transcript の器の dir は adapter が `deps.transcripts.dir` で引ける。 */
async function bootWithAdapter(
  build: (deps: Parameters<WorkerFactory>[0]) => ClaudeCodeWorker | CodexWorker,
  provider: Provider,
) {
  const proc = recordingSpawn();
  const transcriptDir = await tempDir("transcript-store-");
  const transcripts = new RecordingTranscripts(transcriptDir);
  t = await bootTidepool({
    watchdog: WATCHDOG,
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t.db, { provider: [{ name: provider, advisor: false }], tier: undefined }, task),
    openaiUsage: healthyOpenai,
    containerRuntime: new FakeContainerRuntime(proc.spawn),
    transcripts,
    workerAdapter: (deps) => withHealthyUsage(build(deps), deps.clock),
  });
  return { proc, transcripts, transcriptDir };
}

/** 本番の形(`server-options.ts`)と同じく、Claude adapter の logDir(spawn の入力の置き場)は transcript の器と同じ dir。 */
async function bootClaude(registryFiles: Record<string, string> = {}, extra: Partial<ClaudeWorkerOptions> = {}) {
  const registryDir = await makeRegistry(registryFiles);
  return bootWithAdapter(
    (deps) =>
      new ClaudeCodeWorker({
        ...deps,
        registry: { dir: registryDir, mode: "purely-local" },
        agent: "deckhand",
        workspace: "tidepool",
        mcpUrl: "http://127.0.0.1:1/mcp",
        logDir: deps.transcripts.dir,
        ...noSkillPings,
        ...extra,
      }),
    "anthropic",
  );
}

async function bootCodex() {
  const workspace = await tempDir("transcript-failure-codex-ws-");
  git(workspace, "init", "-b", "main");
  const registryDir = await makeRegistry({
    "agents/codex-agent.md":
      "---\ndescription: Codex agent\nversion: 1.2.3\nauthority: standard\n" +
      "provider: openai\nskills: []\n---\nYou are the Codex worker.",
    "workspaces.yaml": `work:\n  path: ${workspace}\n`,
  });
  const codexHome = await tempDir("transcript-failure-codex-home-");
  const booted = await bootWithAdapter(
    ({ db, clock, containers, onSpawnFailed, onRecordContainerFailed, onWorkerExited, transcripts }) =>
      new CodexWorker({
        db,
        clock,
        containers,
        onSpawnFailed,
        onRecordContainerFailed,
        onWorkerExited,
        transcripts,
        registry: { dir: registryDir, mode: "purely-local" },
        agent: "codex-agent",
        workspace: "work",
        workspacesDir: tmpdir(),
        mcpUrl: "http://127.0.0.1:1/mcp",
        codexHome,
        cliVersion: "codex-cli 0.147.0",
        executable: "/opt/tidepool/bin/codex",
        boardCall: closedCodexSkillsCall(),
      }),
    "openai",
  );
  return { ...booted, workspace };
}

/** 列挙が要る skill の許可リストを持つ agent —— spawn は skill 列挙の `.then` の中から起きる。 */
const SKILLED_DECKHAND = {
  "agents/deckhand.md":
    "---\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\n" +
    "description: General work agent\nskills:\n  - code-review\n---\nYou are Deckhand.\n",
};
/** skill 許可リストが空の agent —— ping の無い形で、spawn は start() の中で同期に起きる(ADR 0335 決定1)。 */
const SKILLLESS_DECKHAND = {
  "agents/deckhand.md":
    "---\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\n" +
    "description: General work agent\nskills: []\n---\nYou are Deckhand.\n",
};
const bootClaudeAfterSkillEnumeration = () =>
  bootClaude(SKILLED_DECKHAND, { enumerateSkills: async () => ["code-review"], enumerateHostSkills: async () => ["code-review"] });

const HARNESSES = [
  ["Claude", () => bootClaude(SKILLLESS_DECKHAND)],
  ["Claude(skill 列挙の後)", bootClaudeAfterSkillEnumeration],
  ["Codex", bootCodex],
] as const;

for (const [harness, boot] of HARNESSES) {
  it(`${harness} adapter: transcript を開けない pickup は process を起こさず、盤面全体が記録の器の停止で止まり、踏んだ task は todo へ戻る —— 器が直って回答すれば走り直す`, async () => {
    const { proc, transcriptDir } = await boot();
    await rm(transcriptDir, { recursive: true });
    const task = queueWork(t, "no transcript");
    const behind = queueWork(t, "behind it");
    await t.clock.advance(HOUR);
    await settle();

    expect(proc.calls).toHaveLength(0);
    const recorded = await events(task.id);
    // worker_spawned が運ぶ事実は process の有無に依らない(ADR 0149 決定2)
    const spawned = recorded.filter((e: any) => e.kind === "worker_spawned");
    expect(spawned).toHaveLength(1);
    expect(recorded.filter((e: any) => e.kind === "spawn_failed")).toEqual([]);
    expect(recorded.filter((e: any) => e.kind === "record_container_unwritable").map((e: any) => e.payload)).toEqual([
      {
        kind: "record_container_unwritable",
        path: join(transcriptDir, `${task.id}.${spawned[0].id}.stream.jsonl`),
        reason: expect.stringContaining("ENOENT"),
      },
    ]);
    const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
    expect(queue.halts).toEqual([{ kind: "recordContainer" }]);
    const halt = await servedQuarantineQuestion(t, "recordContainer", null);
    expect((await questions(t)).map((q: any) => q.id)).toEqual([halt.id]);
    expect(halt.purpose).toContain(task.id);
    expect(halt.purpose).toContain("returned to the queue in its current place");
    expect(queue.tasks.filter((x: any) => x.type === "work").map((x: any) => [x.id, x.status])).toEqual([
      [task.id, "todo"],
      [behind.id, "todo"],
    ]);
    expect(queue.teardown).toBeUndefined();

    await mkdir(transcriptDir);
    const answered = await api(t.baseUrl, "POST", `/api/tasks/${halt.id}/answer`, { answers: ["repaired by hand"] });
    expect(answered.status).toBe(200);
    await vi.waitFor(() => expect(proc.calls).toHaveLength(1));
    expect((await events(task.id)).filter((e: any) => e.kind === "worker_spawned")).toHaveLength(2);
    expect(await status(task.id)).toBe("in_progress");
    expect(await status(behind.id)).toBe("todo");
  });
}

it("prompt の記録を書けない器では open が prompt のファイルの絶対 path を名指す RecordContainerError で落ちる —— stream と同じ記録の器の停止の入口(ADR 0313 決定1 / ADR 0266 決定3)", async () => {
  const dir = await tempDir("transcript-store-");
  await mkdir(join(dir, "task-p.7.prompt.json"));
  const open = () => new TranscriptStore(dir).open("task-p", 7, { harness: "claude-code", board: [], task: "u", placement: { board: "system" } });

  expect(open).toThrow(RecordContainerError);
  expect(open).toThrow(expect.objectContaining({ path: join(dir, "task-p.7.prompt.json") }));
});

/** transcript の open 以外で落ちる launch の同期の失敗 —— 器の失敗ではない。Claude は skill 列挙の continuation の中で、
 *  器の外に置いた spawn の入力の dir が無い。 */
const NON_OPEN_FAILURES = [
  [
    "Claude(spawn の入力の dir が無い)",
    async () =>
      bootClaude(SKILLED_DECKHAND, {
        enumerateSkills: async () => ["code-review"],
        enumerateHostSkills: async () => ["code-review"],
        logDir: join(await tempDir("transcript-failure-logs-"), "gone"),
      }),
  ],
  ["Codex(checkout が無い)", async () => rm((await bootCodex()).workspace, { recursive: true })],
] as const;

for (const [harness, boot] of NON_OPEN_FAILURES) {
  it(`${harness}: transcript の open 以外の同期の失敗は今までどおり spawn_failed と failure question 1枚で、盤面は止まらない`, async () => {
    await boot();
    const task = queueWork(t, "never starts");
    await t.clock.advance(HOUR);
    await settle();

    expect((await events(task.id)).filter((e: any) => e.kind === "spawn_failed")).toHaveLength(1);
    expect((await questions(t)).map((q: any) => q.title)).toEqual(["worker never started for task: never starts"]);
    expect((await api(t.baseUrl, "GET", "/api/queue")).json.halts).toEqual([]);
    expect(await status(task.id)).toBe("blocked");
  });
}

for (const [harness, boot] of [HARNESSES[0], HARNESSES[2]] as const) {
  for (const file of ["stream", "stderr"] as const) {
    it(`${harness} adapter: 走ってから ${file} が書けなくなった session は、その場で強制回収されて理由つきの failure question を残し、盤面全体も記録の器の停止で止まる`, async () => {
      const { proc, transcripts } = await boot();
      const task = queueWork(t, "loses its transcript");
      await t.clock.advance(HOUR);
      expect(proc.calls).toHaveLength(1);

      const spawned = (await events(task.id)).find((e: any) => e.kind === "worker_spawned");
      transcripts.opened
        .get(task.id)!
        [file].destroy(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
      // fd の stream は close の後に 'error' を撃つので、観測は数 tick 先にある
      await vi.waitFor(() => expect(t.containers.forceReclaims).toContain(task.id));
      // 強制回収で root が exit する —— ADR 0145 の question は重ならない
      proc.emitExit(null, "SIGKILL");
      await settle();

      expect((await events(task.id)).find((e: any) => e.kind === "transcript_failed").payload).toEqual({
        kind: "transcript_failed",
        error_code: "ENOSPC",
        message: "ENOSPC: no space left on device, write",
        file,
        worker_spawned_event_id: spawned.id,
      });
      const halt = await servedQuarantineQuestion(t, "recordContainer", null);
      const [question, ...more] = (await questions(t)).filter((q: any) => q.id !== halt.id);
      expect(more).toEqual([]);
      expect(halt.purpose).toContain(`${task.id}.${spawned.id}.${file === "stream" ? "stream.jsonl" : "stderr.log"}`);
      expect(halt.purpose).toContain("ENOSPC");
      expect(halt.purpose).toContain("its own failure question");
      expect((await api(t.baseUrl, "GET", "/api/queue")).json.halts).toEqual([{ kind: "recordContainer" }]);
      expect(question.title).toBe("worker transcript could not be written: loses its transcript");
      expect(question.question_items[0].options).toEqual(["retry", "abandon"]);
      expect(question.question_items[0].recommendation).toBe("retry");
      expect(question.purpose).toContain(task.id);
      expect(question.purpose).toContain("force-reclaimed");
      expect(question.purpose).toContain("ENOSPC");
      expect(question.purpose).toContain(`${file} file`);
      expect(await status(task.id)).toBe("blocked");
      expect(await teardown()).toBeUndefined();
    });
  }

  it(`${harness} adapter: transcript_failed の書き込みが rollback したら落ちた後始末が立ち、次の失敗の観測は2行目を書かず、受理の撃ち直しが書く(ADR 0342 決定5・6)`, async () => {
    const { proc, transcripts } = await boot();
    const task = queueWork(t, "loses its transcript twice");
    await t.clock.advance(HOUR);
    t.db.exec(
      "CREATE TRIGGER fail_transcript_failed BEFORE INSERT ON events WHEN NEW.kind = 'transcript_failed' " +
        "BEGIN SELECT RAISE(ABORT, 'transcript_failed write failed'); END",
    );
    const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    const opened = transcripts.opened.get(task.id)!;

    // destroy の 'error' は次の tick に撃たれ、投げると盤面の外へ抜ける —— 一撃が投げないことを見るため同期に撃つ
    expect(() => opened.stream.emit("error", enospc())).not.toThrow();
    const failed = await servedQuarantineQuestion(t, "failedTeardown", task.id);
    expect(failed.purpose).toContain("transcript_failed write failed");
    t.db.exec("DROP TRIGGER fail_transcript_failed");
    opened.stderr.emit("error", enospc());
    proc.emitExit(null, "SIGKILL");
    await settle();
    const written = async () => (await events(task.id)).filter((e: any) => e.kind === "transcript_failed").map((e: any) => e.payload.file);
    expect(await written()).toEqual([]);

    expect((await api(t.baseUrl, "POST", `/api/tasks/${failed.id}/answer`, { answers: ["repaired by hand"] })).status).toBe(200);
    await settle();

    expect(await written()).toEqual(["stream"]);
  });

  it(`${harness} adapter: 最終 verb が着地して後始末に入った session の transcript が落ちても、event だけが残り後始末は完走する`, async () => {
    const { proc, transcripts } = await boot();
    const task = queueWork(t, "already reported");
    await t.clock.advance(HOUR);
    const client = await mcpClient(t.mcpBaseUrl, task.id);
    try {
      await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
    } finally {
      await client.close();
    }
    expect(await teardown()).toBeDefined();

    transcripts.opened.get(task.id)!.stream.destroy(Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" }));
    await vi.waitFor(async () =>
      expect((await events(task.id)).filter((e: any) => e.kind === "transcript_failed")).toHaveLength(1),
    );
    proc.emitExit(0, null);
    await settle();

    // 完了後の盤面の都合(着地・review の pickup)で立つ question はこの session の話ではない
    const titles = (await questions(t)).map((q: any) => q.title);
    expect(titles.filter((title: string) => /^worker (transcript|exited)/.test(title))).toEqual([]);
    expect(await teardown()).toBeUndefined();
    expect(await status(task.id)).not.toBe("in_progress");
  });
}
