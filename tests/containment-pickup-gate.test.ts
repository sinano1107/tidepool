import { afterEach, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth.js";
import {
  api,
  bootTidepool,
  HOUR,
  registerWork,
  TEST_TOKEN,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** 使えるハッシュを1つも持たない盤面 = 認証が成立していない = 人間面は fail-open で
 *  開く(ADR 0036)。封じ込め能力の自己検査が測るのはまさにこの状態である。 */
const NO_CREDENTIAL = { tokenHash: () => undefined };

const HARNESS_OPTIONS = {
  resolveHarness: () => "claude-code" as const,
  agentsUsingHarnesses: (harnesses: readonly string[]) =>
    harnesses.includes("claude-code") ? ["fake-worker"] : [],
  harnessContainment: async () => ({ available: true }) as const,
};

const questions = async (t: Tidepool) =>
  ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((x) => x.type === "question");

/** 自己検査は自分の人間ポートへ実際に HTTP を1回撃つ(「token が読めた」ではなく
 *  組み上がった実物を測る — ADR 0036)。実 I/O なので FakeClock の
 *  `advance`(setImmediate 1回)では終わらない。 */
const openQuestion = async (t: Tidepool) =>
  await vi.waitFor(async () => {
    const open = await questions(t);
    expect(open).toHaveLength(2);
    const claude = open.find((item) => item.question_quarantine_harness === "claude-code");
    expect(claude).toBeDefined();
    return claude;
  });

it("認証が外れた盤面は封じ込め能力が不成立 — pickup が止まる(issue #154 / ADR 0036)", async () => {
  t = await bootTidepool({ ...HARNESS_OPTIONS, credential: NO_CREDENTIAL });
  await registerWork(t, "work that must not run beside a bare human surface");

  const question = await openQuestion(t);
  await t.clock.advance(HOUR);
  // 裸の人間面の隣で走らせない: 子プロセスは1つも起動しない
  expect(t.worker.started).toEqual([]);

  // fs サンドボックスと同じ1択の確認型 — 停止機構は Harness quarantine のまま
  expect(question.question_items[0].options).toEqual(["repaired by hand"]);
  // 「token ファイルが読めなかった」ではなく、**観測された実際の形**が残る
  expect(question.purpose).toContain("200");
  expect(question.purpose).toContain("human surface");
});

it("自己検査は listen 後に走る — 起動時点で各 Harness の question が立っている(issue #154)", async () => {
  // `sandboxPickupBlocked` は `app.listen` より前に呼ばれていた。自己検査は自分の
  // ポートを撃つので、そのままでは測る相手がいない。
  t = await bootTidepool({ ...HARNESS_OPTIONS, credential: NO_CREDENTIAL });

  expect((await questions(t)).map((item) => item.question_quarantine_harness).sort()).toEqual([
    "claude-code",
    "codex",
  ]);
});

it("止まっている間に何度 poll しても question は増えない(1 Harness につき1枚)", async () => {
  t = await bootTidepool({ ...HARNESS_OPTIONS, credential: NO_CREDENTIAL });
  await registerWork(t, "work that must not run beside a bare human surface");
  await openQuestion(t);

  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  expect(await questions(t)).toHaveLength(2);
  expect(t.worker.started).toEqual([]);
});

/** 途中で認証を立て直せる credential — ハッシュファイルを失った盤面に
 *  `npm run token` を打つ、という運用の1手をそのまま表す。直った先を
 *  `TEST_TOKEN` のハッシュにしてあるのは、**道具側もローテーション後の token を
 *  提示し直さなければ入れない**という現実をそのまま写すため(`api()` が提示するのは
 *  `TEST_TOKEN`)。この順序は question の本文にも書いてある。 */
function repairableCredential() {
  let current: string | undefined;
  return {
    credential: { tokenHash: () => current },
    repair: () => {
      current = hashToken(TEST_TOKEN);
    },
  };
}

it("認証が壊れたままの回答は受理されない — question は open のまま(検証つき解除)", async () => {
  t = await bootTidepool({
    ...HARNESS_OPTIONS,
    credential: repairableCredential().credential,
  });
  const question = await openQuestion(t);

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  // workspace quarantine の tree 検証拒否と同じ 409(DomainError)
  expect(res.status).toBe(409);
  expect(res.json.error).toContain("claude-code Harness containment is still not established");
  expect((await questions(t)).find((item) => item.id === question.id)?.status).toBe("todo");
});

it("認証を直せば回答が受理され、pickup が再開する(issue #154 の完了条件)", async () => {
  const cred = repairableCredential();
  t = await bootTidepool({ ...HARNESS_OPTIONS, credential: cred.credential });
  const task = await registerWork(t, "work that waited for a repaired human surface");
  const question = await openQuestion(t);
  expect(t.worker.started).toEqual([]);

  cred.repair();
  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(res.status).toBe(200);
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([task.id]));
});

it("直っただけでは再開しない — 人間の確認回答が解除の唯一の門(quarantine と同じ)", async () => {
  const cred = repairableCredential();
  t = await bootTidepool({ ...HARNESS_OPTIONS, credential: cred.credential });
  await registerWork(t, "work that waited for a repaired human surface");
  const question = await openQuestion(t);

  cred.repair();
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
  expect((await questions(t)).find((item) => item.id === question.id)?.status).toBe("todo");
});

it("認証が効いている盤面は素通り — 自己検査が 401 を観測すれば pickup は進む", async () => {
  t = await bootTidepool(HARNESS_OPTIONS);
  const task = await registerWork(t, "work on a board whose human surface answers 401");

  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([task.id]));
  expect(await questions(t)).toEqual([]);
});
