import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeCodeWorker, type ClaudeWorkerOptions } from "../src/claude-worker.js";
import { CodexWorker } from "../src/codex-worker.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import type { Provider } from "../src/provider.js";
import type { WorkerFactory } from "../src/server.js";
import { type Transcript, TranscriptStore } from "../src/transcript-store.js";
import { closedCodexSkillsCall, FakeContainerRuntime, healthyOpenai, recordingSpawn, withHealthyUsage } from "./fakes.js";
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
  override open(taskId: string, workerSpawnedEventId: number) {
    const opened = super.open(taskId, workerSpawnedEventId);
    this.opened.set(taskId, opened);
    return opened;
  }
}

/** 実 adapter を盤面に載せる。transcript の器の dir は adapter の logDir(mcp.json 等の置き場)と
 *  分ける —— 同じ dir を消すと、先に書かれる mcp.json の ENOENT が器の失敗に化ける。 */
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

async function bootClaude(registryFiles: Record<string, string> = {}, extra: Partial<ClaudeWorkerOptions> = {}) {
  const registryDir = await makeRegistry(registryFiles);
  const logDir = await tempDir("transcript-failure-logs-");
  return bootWithAdapter(
    (deps) =>
      new ClaudeCodeWorker({
        ...deps,
        registry: { dir: registryDir, mode: "purely-local" },
        agent: "deckhand",
        workspace: "tidepool",
        mcpUrl: "http://127.0.0.1:1/mcp",
        logDir,
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
      "---\nname: codex-agent\ndescription: Codex agent\nversion: 1.2.3\nauthority: standard\n" +
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
    "---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\n" +
    "description: General work agent\nskills:\n  - code-review\n---\nYou are Deckhand.\n",
};
const bootClaudeAfterSkillEnumeration = () => bootClaude(SKILLED_DECKHAND, { enumerateSkills: async () => ["code-review"] });

const HARNESSES = [
  ["Claude", () => bootClaude()],
  ["Claude(skill 列挙の後)", bootClaudeAfterSkillEnumeration],
  ["Codex", bootCodex],
] as const;

for (const [harness, boot] of HARNESSES) {
  it(`${harness} adapter: transcript を開けない pickup は process を起こさず、盤面全体が記録の器の停止で止まり、踏んだ task は todo の先頭へ戻る —— 器が直って回答すれば先頭から走り直す`, async () => {
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
    expect(halt.purpose).toContain("returned to the queue head");
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

/** transcript の open より前で落ちる同期の失敗 —— 器の失敗ではない。 */
const NON_OPEN_FAILURES = [
  ["Claude(skill の列挙の失敗)", () => bootClaude(SKILLED_DECKHAND, { enumerateSkills: async () => null })],
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
