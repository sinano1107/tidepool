import { afterEach, expect, it } from "vitest";
import { quarantineCliAuthForProvider } from "../src/cli-auth.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

/** ADR 0098 決定6 の**配線**だけを言う: `bootTidepool` の `cliAuth` を server が
 *  `providerCliAuth.anthropic` へ畳み込むので、anthropic の確認回答の再検証はその
 *  probe が受ける。resource 単位の門・解除・盤面全体が止まらないことは provider に
 *  依らないので、最下位 seam の cli-auth-provider.test.ts と、HTTP 写像を言う
 *  quarantine-provider-auth.test.ts が1度ずつ言う(ADR 0107 決定3)。 */
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

  expect({
    status: response.status,
    error: response.json.error,
    questionStatus: after.status,
  }).toEqual({
    status: 409,
    error: "anthropic authentication is still unavailable: API returned 401",
    questionStatus: "todo",
  });
});
