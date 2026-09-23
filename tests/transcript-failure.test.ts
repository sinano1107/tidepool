import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeCodeWorker, type ClaudeWorkerOptions } from "../src/claude-worker.js";
import { CodexWorker } from "../src/codex-worker.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import type { Provider } from "../src/registry.js";
import type { WorkerFactory } from "../src/server.js";
import { TranscriptStore } from "../src/transcript-store.js";
import { FakeContainerRuntime, healthyOpenai, healthyUsageText, recordingSpawn } from "./fakes.js";
import { api, bootTidepool, FULL_HANDOFF, git, HOUR, mcpClient, questions, queueWork, type Tidepool } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

/** ADR 0149(issue #911)。transcript を取れない session は走らせず、走ってから書けなく
 *  なった session はその場で強制回収する —— 盤面は落ちず、記録を捨てて続けることもない。 */

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const MIN = 60 * 1000;
const WATCHDOG = { timeLimits: { work: 90 * MIN }, grace: 30 * MIN, reclaimTimeout: 5 * MIN };

/** 後始末は回収済み観測の後ろ = microtask の先にある。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const status = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json.status;
const events = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json;
const teardown = async () => (await api(t.baseUrl, "GET", "/api/queue")).json.teardown;

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** 盤面に渡す transcript の器。テストは開かれた session の stream をここから取って落とす。 */
class RecordingTranscripts extends TranscriptStore {
  readonly opened = new Map<string, ReturnType<TranscriptStore["open"]>>();
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
    workerAdapter: (deps) => {
      const worker = build(deps);
      return {
        id: "adapter",
        start: (task, setting) => worker.start(task, setting),
        gracefulStop: (id) => worker.gracefulStop(id),
        checkUsage: async () => healthyUsageText(t.clock.now()),
      };
    },
  });
  return { proc, transcripts, transcriptDir };
}

async function bootClaude(registryFiles: Record<string, string> = {}, extra: Partial<ClaudeWorkerOptions> = {}) {
  const registryDir = await makeRegistry(registryFiles);
  dirs.push(registryDir);
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
  dirs.push(registryDir);
  const codexHome = await tempDir("transcript-failure-codex-home-");
  return bootWithAdapter(
    ({ db, clock, containers, onSpawnFailed, onWorkerExited, transcripts }) =>
      new CodexWorker({
        db,
        clock,
        containers,
        onSpawnFailed,
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
      }),
    "openai",
  );
}

/** 列挙が要る skill の許可リストを持つ agent —— spawn は skill 列挙の `.then` の中から起きる。 */
const bootClaudeAfterSkillEnumeration = () =>
  bootClaude(
    {
      "agents/deckhand.md":
        "---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\n" +
        "description: General work agent\nskills:\n  - code-review\n---\nYou are Deckhand.\n",
    },
    { enumerateSkills: async () => ["code-review"] },
  );

const HARNESSES = [
  ["Claude", () => bootClaude()],
  ["Claude(skill 列挙の後)", bootClaudeAfterSkillEnumeration],
  ["Codex", bootCodex],
] as const;

for (const [harness, boot] of HARNESSES) {
  it(`${harness} adapter: transcript を開けない pickup は process を起こさず、spawn_failed と question 1枚を残して枠を空ける`, async () => {
    const { proc, transcriptDir } = await boot();
    await rm(transcriptDir, { recursive: true });
    const task = queueWork(t, "no transcript");
    await t.clock.advance(HOUR);
    await settle();

    expect(proc.calls).toHaveLength(0);
    const failed = (await events(task.id)).filter((e: any) => e.kind === "spawn_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.message).toContain("ENOENT");
    expect(failed[0].payload.message).toContain(".stream.jsonl");
    const all = await questions(t);
    expect(all.map((q: any) => q.title)).toEqual(["worker never started for task: no transcript"]);
    expect(await status(task.id)).toBe("blocked");
    expect(await teardown()).toBeUndefined();
  });
}

for (const [harness, boot] of [HARNESSES[0], HARNESSES[2]] as const) {
  for (const file of ["stream", "stderr"] as const) {
    it(`${harness} adapter: 走ってから ${file} が書けなくなった session は、その場で強制回収され、理由つき question が1枚だけ立つ`, async () => {
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
      const [question, ...more] = await questions(t);
      expect(more).toEqual([]);
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
