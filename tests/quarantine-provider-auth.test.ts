import { afterEach, expect, it, vi } from "vitest";
import { quarantineCliAuthForProvider } from "../src/cli-auth.js";
import { openDb } from "../src/db.js";
import { api, bootTidepool, registerWork, type Tidepool } from "./harness.js";

/** issue #446 / ADR 0097 決定2: provider 単位の資源への細分化のゲート面。
 *  moonshot の失効は moonshot を喋る agent の pickup だけを止め(確認型
 *  question が立つ)、anthropic の worker と board call は止まらない。 */
let t: Tidepool;
afterEach(() => t?.stop());

const MOONSHOT_QUESTION_TITLE =
  "moonshot authentication is unavailable — pickup of moonshot-speaking agents is stopped";

function quarantineMoonshot(tidepool: Tidepool): void {
  const db = openDb(`${tidepool.dir}/board.sqlite`);
  quarantineCliAuthForProvider(db, "moonshot", tidepool.clock.now());
  db.close();
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
