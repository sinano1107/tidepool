import { expect, it } from "vitest";
import { assignShards } from "../scripts/test-sequencer.js";

it("重いファイルを別々の shard に分け、所要の合計を均す", () => {
  const durations = { "a.ts": 300, "b.ts": 290, "c.ts": 10, "d.ts": 10, "e.ts": 5 };
  const shards = assignShards(Object.keys(durations), durations, 2);
  expect(shards).toEqual([
    ["a.ts", "d.ts"],
    ["b.ts", "c.ts", "e.ts"],
  ]);
});

it("全ファイルがちょうど1つの shard に入り、入力の順に依らず同じ割り当てになる", () => {
  const files = Array.from({ length: 50 }, (_, i) => `t${i}.ts`);
  const durations = Object.fromEntries(files.map((f, i) => [f, (i * 37) % 11]));
  const shards = assignShards(files, durations, 4);
  expect(shards.flat().sort()).toEqual([...files].sort());
  expect(assignShards([...files].reverse(), durations, 4)).toEqual(shards);
});

it("記録に無いファイルは記録済みの中央値として扱う", () => {
  const durations = { "a.ts": 100, "b.ts": 10, "c.ts": 20, "d.ts": 30 };
  // 記録に無い x.ts は中央値 30 として、同じ重さの d.ts と名前順で並ぶ
  const shards = assignShards(["a.ts", "b.ts", "c.ts", "d.ts", "x.ts"], durations, 2);
  expect(shards).toEqual([["a.ts"], ["d.ts", "x.ts", "c.ts", "b.ts"]]);
});
