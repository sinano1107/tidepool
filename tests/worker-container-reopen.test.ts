import { expect, it } from "vitest";
import { WorkerContainers } from "../src/worker-container.js";
import { FakeContainerRuntime } from "./fakes.js";

/** 盤面側 supervisor が持つ帳簿の寿命(ADR 0099 決定2)。同じ session id での再 open は
 *  retry・上限到達による中断からの先頭復帰で実際に起きる(CONTEXT.md「Worker session」—
 *  タスクと session は多対1、pickup は task id を session id に使う)。 */

const SESSION = "task-1";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 1つ目の容器が回収済み観測まで進んだ盤面。「回収済み観測の後」とは
 *  `reclaimed` が解決した後のことであり、強制回収を送った直後の同期の点ではない
 *  (ADR 0109 決定4 — force は送達であって回収の完了ではない)。 */
async function reclaimedOnce() {
  const containers = new WorkerContainers(new FakeContainerRuntime());
  const first = containers.open(SESSION);
  containers.forceReclaim(SESSION);
  await containers.reclaimed(SESSION);
  return { containers, first };
}

it("回収済み観測の後に同じ session id で open すると、新しい容器が返る", async () => {
  const { containers, first } = await reclaimedOnce();

  expect(containers.open(SESSION)).not.toBe(first);
});

it("再 open した容器の回収済み観測は、その容器が空になるまで解決しない", async () => {
  const { containers } = await reclaimedOnce();
  containers.open(SESSION);

  let emptied = false;
  void containers.reclaimed(SESSION).then(() => {
    emptied = true;
  });
  await settle();
  expect(emptied).toBe(false);

  containers.forceReclaim(SESSION);
  await settle();
  expect(emptied).toBe(true);
});
