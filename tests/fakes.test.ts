import { expect, it } from "vitest";
import { recordingSpawn } from "./fakes.js";

/** `recordingSpawn()` が spawn のたびに新しい stdio を作ること(issue #846)。 */

const opts = { cwd: "/workspace", env: {} };

it("2本の process を起こすと、それぞれの stdin に書けて別々に読める(write after end にならない)", () => {
  const { spawn, processes } = recordingSpawn();

  spawn("claude", ["one"], { ...opts, stdin: "pipe" });
  processes[0]!.stdin.end("from first\n");

  spawn("claude", ["two"], { ...opts, stdin: "pipe" });
  // 共有 stdio のままなら1本目の end() の後なので write after end になる —— ここで
  // 拾って捨て、クラッシュではなく次の assert のズレとして red が見えるようにする。
  processes[1]!.stdin.on("error", () => {});
  processes[1]!.stdin.write("from second\n");

  expect(processes[0]!.stdin.read()?.toString()).toBe("from first\n");
  expect(processes[1]!.stdin.read()?.toString()).toBe("from second\n");
});

it("2本の process はそれぞれ別の stdout / stderr も持つ", () => {
  const { spawn, processes } = recordingSpawn();

  spawn("claude", ["one"], opts);
  spawn("claude", ["two"], opts);

  processes[0]!.stdout.write("stdout one");
  processes[1]!.stdout.write("stdout two");
  processes[0]!.stderr.write("stderr one");
  processes[1]!.stderr.write("stderr two");

  expect(processes[0]!.stdout.read()?.toString()).toBe("stdout one");
  expect(processes[1]!.stdout.read()?.toString()).toBe("stdout two");
  expect(processes[0]!.stderr.read()?.toString()).toBe("stderr one");
  expect(processes[1]!.stderr.read()?.toString()).toBe("stderr two");
});
