import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { quarantineCliAuthForProvider } from "../src/cli-auth.js";
import type { CodexAppServerProbeResult } from "../src/codex-app-server.js";
import { type ExecutionSetting, executionSettingsFor } from "../src/execution-setting.js";
import type { Provider } from "../src/registry.js";
import { healthyOpenai } from "./fakes.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  HOUR,
  mcpClient,
  queueWork,
  registerWork,
  type Tidepool,
} from "./harness.js";

/** issue #446 / ADR 0097 決定2: provider 単位の資源への細分化のゲート面。
 *  moonshot の失効は moonshot を喋る agent の pickup だけを止め(確認型
 *  question が立つ)、anthropic の worker と board call は止まらない。 */

/** 除外を当てる前の候補1件(provider-scheduler.test.ts と同じ形)。 */
const candidate = (provider: Provider, model: string): ExecutionSetting => ({
  provider,
  model,
  effort: "high",
  advisor: undefined,
  source: { tier: "board", provider: "only" },
});

/** agent の entry 宣言を名前の列から組む(provider-scheduler.test.ts と同じ形)。 */
const entries = (...names: string[]) => ({
  provider: names.map((name) => ({ name, advisor: false })),
  tier: undefined,
});

let t: Tidepool;
afterEach(() => t?.stop());

const MOONSHOT_QUESTION_TITLE =
  "moonshot authentication is unavailable — pickup of moonshot-speaking agents is stopped";

function quarantineMoonshot(tidepool: Tidepool): void {
  const db = tidepool.db;
  quarantineCliAuthForProvider(db, "moonshot", tidepool.clock.now());
}

it("moonshot 失効中は moonshot agent の pickup のみが止まり、anthropic の worker は流れ続ける(確認型 question が立つ)", async () => {
  t = await bootTidepool({
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t.db, task.assignee === "kipper" ? entries("moonshot") : entries("anthropic"), task),
  });
  quarantineMoonshot(t);
  const kimi = await registerWork(t, "kimi task waits for its provider", undefined, undefined, "kipper");
  const claude = await registerWork(t, "claude task still flows", undefined, undefined, "deckhand");

  // 即時 poll を撃つ(FakeClock の hourly tick は進まない)。move の発火条件は
  // 「既に候補の先頭に居る行をもう一度先頭へ」(issue #299) — 候補の先頭は
  // quarantine で skip された kimi ではなく claude 側なので、こちらを動かす。
  await api(t.baseUrl, "POST", `/api/tasks/${claude.id}/move`, { after: null });

  await vi.waitFor(() => expect(t.worker.started.map((started) => started.id)).toEqual([claude.id]));

  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const question = tasks.find((candidate) => candidate.title === MOONSHOT_QUESTION_TITLE);
  const pause = (await api(t.baseUrl, "GET", "/api/pause")).json;
  expect({
    kimiStarted: t.worker.started.some((started) => started.id === kimi.id),
    questionOptions: question?.question_items?.[0]?.options,
    halts: pause.halts.map((halt: { kind: string }) => halt.kind),
  }).toEqual({
    kimiStarted: false,
    questionOptions: ["authentication restored"],
    // 資源単位の停止は盤面全体の停止の列挙に入らない(ADR 0058 決定1)
    halts: [],
  });

  // キュービューは pickup の述語と同じ集合を見る(tasks.ts の「乖離させない」の線):
  // quarantine 中の provider のタスクだけが skipped 表示になる(claude 側は既に
  // pickup されて in_progress)
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json as { tasks: any[] };
  expect({
    kimi: queue.tasks.find((row) => row.id === kimi.id)?.status,
    claude: queue.tasks.find((row) => row.id === claude.id)?.status,
  }).toEqual({ kimi: "skipped", claude: "in_progress" });
});

it("moonshot の確認回答は provider の再検証が通るまで受理されず、通れば moonshot agent の pickup が再開する", async () => {
  let authenticated = false;
  t = await bootTidepool({
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t.db, task.assignee === "kipper" ? entries("moonshot") : entries("anthropic"), task),
    providerCliAuth: {
      moonshot: async () =>
        authenticated
          ? { status: "authenticated" }
          : { status: "unauthorized", reason: "API returned 401" },
    },
  });
  quarantineMoonshot(t);
  const kimi = await registerWork(t, "kimi task resumes after repair", undefined, undefined, "kipper");
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const question = tasks.find((candidate) => candidate.title === MOONSHOT_QUESTION_TITLE);

  const refused = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["authentication restored"],
  });
  expect({ status: refused.status, error: refused.json.error }).toEqual({
    status: 409,
    error: "moonshot authentication is still unavailable: API returned 401",
  });
  expect(t.worker.started).toEqual([]);

  authenticated = true;
  const accepted = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["authentication restored"],
  });
  expect(accepted.status).toBe(200);
  await vi.waitFor(() => expect(t.worker.started.map((started) => started.id)).toEqual([kimi.id]));
});

it("OpenAI の unauthorized は OpenAI だけの確認を立て、HTTP 回答時に App Server を再probeし、他 Provider は流し続ける", async () => {
  let authenticated = false;
  const openaiUsage = async (now: Date): Promise<CodexAppServerProbeResult> =>
    authenticated
      ? {
          status: "observed",
          provider: "openai",
          cliVersion: "codex-cli 0.147.0",
          plan: "plus",
          windows: [
            {
              name: "primary",
              model: null,
              usedPercent: 0,
              durationMs: 5 * HOUR,
              resetsAt: new Date(now.getTime() + 4 * HOUR).toISOString(),
            },
            {
              name: "secondary",
              model: null,
              usedPercent: 0,
              durationMs: 7 * 24 * HOUR,
              resetsAt: new Date(now.getTime() + 6 * 24 * HOUR).toISOString(),
            },
          ],
        }
      : {
          status: "unauthorized",
          provider: "openai",
          cliVersion: "codex-cli 0.147.0",
          reason: "Codex credential is no longer usable: account/read reports no account",
        };
  t = await bootTidepool({
    openaiUsage,
    taskExecutionCandidates: (task) => [
      task.assignee === "codex-agent"
        ? candidate("openai", "gpt-5.6-sol")
        : candidate("anthropic", "claude-opus-4-1"),
    ],
  });
  const codex = await registerWork(t, "waits for Codex login", undefined, undefined, "codex-agent");
  const claude = await registerWork(t, "keeps flowing", undefined, undefined, "claude-agent");

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([claude.id]);
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const question = tasks.find((task) => (task.question_quarantine_kind === "providerAuth" && task.question_quarantine_value === "openai"));
  expect(question?.title).toBe(
    "openai authentication is unavailable — pickup of openai-speaking agents is stopped",
  );
  expect(tasks.filter((task) => task.question_quarantine_kind === "providerAuth")).toHaveLength(1);

  const refused = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["authentication restored"],
  });
  expect(refused).toMatchObject({
    status: 409,
    json: { error: "openai authentication is still unavailable: Codex credential is no longer usable: account/read reports no account" },
  });

  authenticated = true;
  expect(
    (await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
      answers: ["authentication restored"],
    })).status,
  ).toBe(200);
  const client = await mcpClient(t.mcpBaseUrl, claude.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([claude.id, codex.id]);
});

it("codexHome に auth.json が無い openai は probe を撃たずに absent で除外され question も立たず、置かれて probe が unauthorized なら従来どおり確認が立つ(ADR 0116 決定4)", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "tidepool-codex-home-"));
  let probes = 0;
  t = await bootTidepool({
    codexHome,
    openaiUsage: async () => {
      probes += 1;
      return {
        status: "unauthorized",
        provider: "openai",
        cliVersion: "codex-cli 0.147.0",
        reason: "Codex credential is no longer usable: account/read reports no account",
      };
    },
    taskExecutionCandidates: () => [candidate("openai", "gpt-5.6-sol")],
  });
  await registerWork(t, "Codex login を待つ", undefined, undefined, "codex-agent");

  await t.clock.advance(HOUR);
  const authQuestions = async () =>
    ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter(
      (task) => (task.question_quarantine_kind === "providerAuth" && task.question_quarantine_value === "openai"),
    );
  const openai = (await api(t.baseUrl, "GET", "/api/pause")).json.providerUsage.find(
    (usage: any) => usage.provider === "openai",
  );
  expect({ probes, started: t.worker.started, questions: await authQuestions(), status: openai?.status }).toEqual({
    probes: 0,
    started: [],
    questions: [],
    status: "absent",
  });

  writeFileSync(join(codexHome, "auth.json"), "{}");
  await t.clock.advance(HOUR);
  expect({ probes, questions: (await authQuestions()).length }).toEqual({ probes: 1, questions: 1 });
});

/* ------------------------------------------------------------------ *
 * entry 経路(server 境界): 開いた quarantine が外すのは Provider であって
 * agent ではない(ADR 0110 決定3 / issue #791)。候補は**実物の selector**
 * (`executionSettingsFor` + 盤面の表)から作る。
 * ------------------------------------------------------------------ */

it("openai を quarantine 中でも openai と anthropic の entry を持つ agent の task は anthropic で走り、openai entry しか持たない agent の task だけが skipped —— queue 表示と pickup の判定は同じ式(ADR 0110 決定3・5)", async () => {
  t = await bootTidepool({
    // openai の usage 観測を健全にしておく —— 未設定だと「unobservable」の
    // fail-closed 自体が openai を除外してしまい、quarantine を外しても
    // このテストが落ちなくなる(除外の原因が quarantine 単独と言えなくなる)
    openaiUsage: healthyOpenai,
    taskExecutionCandidates: (task) =>
      executionSettingsFor(
        t.db,
        task.assignee === "multi-agent" ? entries("openai", "anthropic") : entries("openai"),
        task,
      ),
  });
  quarantineCliAuthForProvider(t.db, "openai", t.clock.now());

  // 扉を通す(quarantine は登録より前に開いているので、pickup の契機である
  // 登録の poll がそのまま今の除外集合を読む)
  const solo = await registerWork(t, "openai entry しか持たない agent の task", undefined, undefined, "solo-agent");
  const multi = await registerWork(t, "openai と anthropic の entry を持つ agent の task", undefined, undefined, "multi-agent");

  // openai は候補にすら残らず anthropic entry で走る。選ばれた設定は adapter へ
  // そのまま運ばれ、実 adapter はこれを worker_spawned に刻む
  expect(t.worker.started.map((task) => task.id)).toEqual([multi.id]);
  expect(t.worker.startedSettings[0]).toMatchObject({ provider: "anthropic" });

  // queue の skipped 表示は scheduler のゲートと同じ1つの式から出る —— openai
  // entry しか持たない task だけが skipped で、別 Provider の entry を持つ
  // task は道連れにならない
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks as any[];
  expect({
    solo: queue.find((task) => task.id === solo.id)?.status,
    multi: queue.find((task) => task.id === multi.id)?.status,
  }).toEqual({ solo: "skipped", multi: "in_progress" });
});

it("openai entry しか持たない行は quarantine 中は Pickable head ではない —— 下の行の ↑ を飲まない(ADR 0110 決定3 / CONTEXT.md「Pickable head」)", async () => {
  t = await bootTidepool({
    // openai の usage 観測を健全にしておく —— 理由は上のテストと同じ
    openaiUsage: healthyOpenai,
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t.db, task.assignee === "runnable-agent" ? entries("anthropic") : entries("openai"), task),
  });
  quarantineCliAuthForProvider(t.db, "openai", t.clock.now());
  // 扉を通さずに置く(扉の登録は pickup の契機 —— ADR 0119 決定2 —— なので、
  // todo のまま待つことを前提にするテストはこちらを使う)
  const blocked = queueWork(t, "openai entry しか持たない行", undefined, undefined, "solo-agent");

  await t.clock.advance(HOUR);
  // この poll では候補が blocked しか無く、全 entry 除外なので何も走らない
  expect(t.worker.started).toEqual([]);
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks as any[];
  expect(queue.find((task) => task.id === blocked.id)?.status).toBe("skipped");

  // 素の先頭は blocked のままだが、候補の先頭は下の runnable(anthropic entry)。
  // 1回の ↑ が空振りしないことが、Pickable head が entry 集合で判定されている証拠である
  const runnable = queueWork(t, "anthropic entry を持つので別の行で走る", undefined, undefined, "runnable-agent");
  await api(t.baseUrl, "POST", `/api/tasks/${runnable.id}/move`, { after: null });
  expect(t.worker.started.map((task) => task.id)).toEqual([runnable.id]);
});
