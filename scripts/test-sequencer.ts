import { readFileSync } from "node:fs";
import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// vitest の既定の shard はパスの sha1 順にファイル数で均等に切るだけで、所要時間を見ない。
// 重いファイルが1つの shard に寄ると、その shard だけが CI の壁時計を決める。
// CI で測ったファイルごとの所要秒(scripts/test-durations.json)で、重い順に一番軽い shard へ詰める。
// 記録に無いファイルは中央値として扱う。記録が古くなっても偏りが戻るだけで、テストの合否には効かない。

const DURATIONS_PATH = path.join(import.meta.dirname, "test-durations.json");

/** 各 shard に入れるファイルを返す(添字 0 が shard 1)。同じ入力なら全 job で同じ割り当てになる。 */
export function assignShards(files: string[], durations: Record<string, number>, count: number): string[][] {
  const known = files.map((f) => durations[f]).filter((d): d is number => d !== undefined);
  known.sort((a, b) => a - b);
  const fallback = known.length > 0 ? (known[Math.floor(known.length / 2)] ?? 1) : 1;
  const weighted = files.map((file) => ({ file, weight: durations[file] ?? fallback }));
  weighted.sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ load: 0, files: [] as string[] }));
  for (const { file, weight } of weighted) {
    let lightest = shards[0]!;
    for (const shard of shards) if (shard.load < lightest.load) lightest = shard;
    lightest.files.push(file);
    lightest.load += weight;
  }
  return shards.map((s) => s.files);
}

function readDurations(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(DURATIONS_PATH, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

export class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const key = (spec: TestSpecification) => path.relative(root, spec.moduleId).split(path.sep).join("/");
    const mine = new Set(assignShards(files.map(key), readDurations(), shard.count)[shard.index - 1]);
    return files.filter((spec) => mine.has(key(spec)));
  }
}
