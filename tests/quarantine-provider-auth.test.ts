import { afterEach, expect, it, vi } from "vitest";
import { quarantineCliAuthForProvider } from "../src/cli-auth.js";
import type { CodexAppServerProbeResult } from "../src/codex-app-server.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  HOUR,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

/** issue #446 / ADR 0097 決定2: provider 単位の資源への細分化のゲート面。
 *  moonshot の失効は moonshot を喋る agent の pickup だけを止め(確認型
 *  question が立つ)、anthropic の worker と board call は止まらない。 */
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
    agentsSpeakingProviders: (providers) => (providers.includes("moonshot") ? ["kipper"] : []),
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
    agentsSpeakingProviders: (providers) => (providers.includes("moonshot") ? ["kipper"] : []),
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
          reason: "Codex reports that OpenAI authentication is required",
        };
  t = await bootTidepool({
    openaiUsage,
    resolveUsageResource: (task) =>
      task.assignee === "codex-agent"
        ? { provider: "openai", model: "gpt-5.6-sol" }
        : { provider: "anthropic", model: "claude-opus-4-1" },
    agentsSpeakingProviders: (providers) =>
      providers.includes("openai") ? ["codex-agent"] : ["claude-agent"],
  });
  const codex = await registerWork(t, "waits for Codex login", undefined, undefined, "codex-agent");
  const claude = await registerWork(t, "keeps flowing", undefined, undefined, "claude-agent");

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([claude.id]);
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const question = tasks.find((task) => task.question_quarantine_provider_auth === "openai");
  expect(question?.title).toBe(
    "openai authentication is unavailable — pickup of openai-speaking agents is stopped",
  );
  expect(tasks.filter((task) => task.question_quarantine_provider_auth !== null)).toHaveLength(1);

  const refused = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["authentication restored"],
  });
  expect(refused).toMatchObject({
    status: 409,
    json: { error: "openai authentication is still unavailable: Codex reports that OpenAI authentication is required" },
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
