import { expect, it } from "vitest";
import { recordingSpawn } from "./fakes.js";

/** `recordingSpawn()` が spawn のたびに新しい stdio を作ること(issue #846)。 */

const opts = { cwd: "/workspace", env: {} };

it("2本の process を起こすと、それぞれの stdin に書けて別々に読める(write after end にならない)", () => {
  const { spawn, processes } = recordingSpawn();

  spawn("claude", ["one"], { ...opts, stdin: "pipe" });
  processes[0]!.stdin.end("from first\n");

  spawn("claude", ["two"], { ...opts, stdin: "pipe" });
  // 共有 stdio のままなら1本目の end() の後の write after end で ERR_STREAM_WRITE_AFTER_END
  // が非同期に飛ぶ。ここで拾って捨て、失敗時も次の assert のズレだけが見えるようにする。
  processes[1]!.stdin.on("error", () => {});
  processes[1]!.stdin.write("from second\n");

  expect(processes[0]!.stdin.read()?.toString()).toBe("from first\n");
  expect(processes[1]!.stdin.read()?.toString()).toBe("from second\n");
});
