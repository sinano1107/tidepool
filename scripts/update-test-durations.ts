// scripts/test-durations.json を、main の直近の成功した CI の実測で書き直す。
// shard の偏りが目立ってきたら手で回して commit する(scripts/test-sequencer.ts)。
// 律速は macOS の runner なので、macOS の shard の報告だけを使う。
//   npx tsx scripts/update-test-durations.ts [run-id]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type Report = { testResults: { name: string; startTime: number; endTime: number }[] };

const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8" }).trim();

const runId =
  process.argv[2] ??
  gh(
    "run",
    "list",
    "--workflow",
    "ci.yml",
    "--branch",
    "main",
    "--event",
    "push",
    "--status",
    "success",
    "--limit",
    "1",
    "--json",
    "databaseId",
    "-q",
    ".[0].databaseId",
  );

const dir = mkdtempSync(path.join(tmpdir(), "test-durations-"));
try {
  gh("run", "download", runId, "--pattern", "vitest-report-macos-*", "--dir", dir);
  const durations: Record<string, number> = {};
  for (const artifact of readdirSync(dir)) {
    const report = JSON.parse(readFileSync(path.join(dir, artifact, "vitest-report.json"), "utf8")) as Report;
    for (const file of report.testResults) {
      // runner の checkout は .../work/<repo>/<repo>/ の下にある
      const relative = file.name.replace(/^.*\/work\/[^/]+\/[^/]+\//, "");
      durations[relative] = Math.round((file.endTime - file.startTime) / 100) / 10;
    }
  }
  const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => (a < b ? -1 : 1)));
  const out = path.join(import.meta.dirname, "test-durations.json");
  writeFileSync(out, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`run ${runId}: ${Object.keys(sorted).length} files -> ${path.relative(process.cwd(), out)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
