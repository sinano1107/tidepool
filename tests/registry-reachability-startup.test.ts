import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

// ADR 0052 決定4 の fail-open を `startServer` の側から見たもの。**起動時 refresh
// そのものは合成 root にある**(tests/server-options.test.ts が測る) —— ここが
// 見張るのは「registry の正本に届かない盤面でも人間面は開いたままである」という
// ADR 0036 の線で、pickup を止めるのはあくまで下のゲートだけ、という非対称である。
it("registry remote に到達できなくても、人間面は開いたまま起動する(ADR 0052 / ADR 0036)", async () => {
  t = await bootTidepool({
    registryReachability: async () => ({
      available: false,
      reason: "origin is unavailable",
    }),
  });

  const tasks = await api(t.baseUrl, "GET", "/api/tasks");

  // 起動を拒まない、かつ boot だけでは quarantine を立てない(床は pickup 側1枚)
  expect({
    status: tasks.status,
    questions: (tasks.json as any[]).filter((task) => task.type === "question"),
  }).toEqual({ status: 200, questions: [] });
});

// 一過性の失敗を恒久停止に昇格させないこと。この盤面は Pi の systemd で起動し、
// `After=network-online.target` は GitHub 到達性まで保証しないので、起動直後だけ
// 届かない状態は現実に起こる。そこで question を立てていたら、remote が数秒後に
// 復帰していても人間が答えるまで盤面は止まったままになる。
it("起動直後だけ届かず回復した registry は、question を1枚も残さず pickup が走る(ADR 0052)", async () => {
  let reachable = false;
  t = await bootTidepool({
    registryReachability: async () =>
      reachable ? { available: true } : { available: false, reason: "network was not up yet" },
  });
  reachable = true;
  const task = await registerWork(t, "work queued right after a cold boot");

  await t.clock.advance(HOUR);

  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  expect({
    started: t.worker.started.map((started) => started.id),
    questions: tasks.filter((candidate) => candidate.type === "question").map((q) => q.title),
  }).toEqual({ started: [task.id], questions: [] });
});
