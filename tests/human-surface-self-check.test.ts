import { expect, it } from "vitest";
import { checkHumanSurfaceRefusesAnonymous } from "../src/containment.js";

const URL = "http://127.0.0.1:4589/api/tasks";

/** fetch のシーム(ADR 0027 と同じ posture): 実リスナーを起こさずに、返ってきた
 *  「形」だけを変えて自己検査の判定を駆動する。組み上がった実物を撃つ側は
 *  tests/containment-pickup-gate.test.ts が実ポートで受け持つ。 */
const responds = (status: number) => (async () => new Response("", { status })) as typeof fetch;

it("401 だけが合格 — 無認証が実際に断られたことの唯一の証拠(ADR 0036)", async () => {
  expect(await checkHumanSurfaceRefusesAnonymous(URL, responds(401))).toEqual({ available: true });
});

// 「200 でなければ合格」にはしない。404 や 500 は、認証が外れたうえに穴が別の
// パスに移った・盤面が壊れた、という状態を通してしまう(canary と同じ立場)。
it.each([200, 204, 403, 404, 500])("%i は不成立 — 401 以外は測れていない", async (status) => {
  const result = await checkHumanSurfaceRefusesAnonymous(URL, responds(status));
  expect(result.available).toBe(false);
  // 観測された実際の形が残る: 人間はこれを読んでどちらの半分が壊れたか判断する
  expect(result.available === false && result.reason).toContain(String(status));
});

it("接続できなければ不成立 — 「測れなかった」は「無事」ではない", async () => {
  const refused = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:4589");
  }) as typeof fetch;

  const result = await checkHumanSurfaceRefusesAnonymous(URL, refused);
  expect(result.available).toBe(false);
  expect(result.available === false && result.reason).toContain("ECONNREFUSED");
});

// 詰まった fetch を待ち続けると poll ごと止まり、「止まっている理由が出ないまま
// 盤面が沈黙する」という fail-closed より悪い状態になる(sandbox.ts の各 probe が
// CAPABILITY_PROBE_TIMEOUT_MS を持つのと同じ理由)。
it("応答しないリスナーは上限で打ち切って不成立にする", async () => {
  const hangs = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;

  const result = await checkHumanSurfaceRefusesAnonymous(URL, hangs);
  expect(result.available).toBe(false);
  expect(result.available === false && result.reason).toContain("could not probe");
}, 10_000);
