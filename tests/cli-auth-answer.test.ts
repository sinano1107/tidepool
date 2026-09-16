import { afterEach, expect, it, vi } from "vitest";
import { quarantineCliAuthForProvider } from "../src/cli-auth.js";
import { api, bootTidepool, registerWork, type Tidepool } from "./harness.js";

/** ADR 0097 決定2 / ADR 0098 決定6: anthropic の失効も他 provider と同じ資源単位の
 *  quarantine に落ちる —— 盤面全体は止まらない(`/api/pause` の halts は空)。
 *  `bootTidepool` の `cliAuth` は server が `providerCliAuth.anthropic` へ畳み込む
 *  ので、回答時の再検証はその probe が受ける。 */
const ANTHROPIC_QUESTION_TITLE =
  "anthropic authentication is unavailable — pickup of anthropic-speaking agents is stopped";

let t: Tidepool;
afterEach(() => t?.stop());

it("authentication がまだ失敗するなら確認回答を拒否し、question を開いたまま保つ(盤面全体は止まらない)", async () => {
  t = await bootTidepool({
    cliAuth: async () => ({ status: "unauthorized", reason: "API returned 401" }),
  });
  quarantineCliAuthForProvider(t.db, "anthropic", t.clock.now());
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const question = tasks.find((task) => task.title === ANTHROPIC_QUESTION_TITLE);

  const response = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["authentication restored"],
  });
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  const pause = (await api(t.baseUrl, "GET", "/api/pause")).json;

  expect({
    status: response.status,
    error: response.json.error,
    questionStatus: after.status,
    // 資源単位の停止は盤面全体の停止の列挙に入らない(ADR 0058 決定1)
    halts: pause.halts.map((halt: { kind: string }) => halt.kind),
  }).toEqual({
    status: 409,
    error: "anthropic authentication is still unavailable: API returned 401",
    questionStatus: "todo",
    halts: [],
  });
});

it("authentication を直して回答すると確認が解除され、anthropic agent の pickup が再開する", async () => {
  let authenticated = false;
  t = await bootTidepool({
    // 既定の harness は registry を持たない(= どの agent も skip されない)ので、
    // provider の quarantine が pickup の門になることを見るには宣言側を明示する
    agentsSpeakingProviders: (providers) => (providers.includes("anthropic") ? ["deckhand"] : []),
    cliAuth: async () =>
      authenticated
        ? { status: "authenticated" }
        : { status: "unauthorized", reason: "API returned 401" },
  });
  quarantineCliAuthForProvider(t.db, "anthropic", t.clock.now());
  const task = await registerWork(t, "work resumed after authentication repair", undefined, undefined, "deckhand");
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const question = tasks.find((candidate) => candidate.title === ANTHROPIC_QUESTION_TITLE);

  expect(t.worker.started).toEqual([]);

  authenticated = true;
  const response = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["authentication restored"],
  });

  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(t.worker.started.map((started) => started.id)).toEqual([task.id]));
});
