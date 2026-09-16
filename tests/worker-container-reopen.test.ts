import { expect, it } from "vitest";
import { fakeContainers } from "./fakes.js";

/** 盤面側 supervisor が持つ帳簿の寿命。session の終わりは回収済み観測である
 *  (ADR 0109 決定2)。同じ session id での再 open は retry・上限到達による中断からの
 *  先頭復帰で実際に起きる(CONTEXT.md「Worker session」)。 */

const SESSION = "task-1";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 1つ目の容器が回収済み観測まで進んだ盤面。帳簿から消えるのは `reclaimed` の解決より
 *  1 microtask 後なので、観測点は await の後ろに置く。 */
async function reclaimedOnce() {
  const containers = fakeContainers();
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
