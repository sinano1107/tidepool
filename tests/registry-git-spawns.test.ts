import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { loadRegistry } from "../src/registry.js";
import { makeRegistry } from "./registry-fixture.js";

// 素通しの spy で git の起動回数だけを数える。mock がほかのテストへ漏れない
// よう、このファイルに隔離する(issue #983)。
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

function gitSpawnsOfOneLoad(dir: string): number {
  vi.mocked(execFileSync).mockClear();
  loadRegistry(dir, "purely-local");
  return vi.mocked(execFileSync).mock.calls.filter(([file]) => file === "git").length;
}

describe("loadRegistry の git 起動回数", () => {
  it("agent・profile の本数に依らず一定(ファイルごとに git を起動しない — issue #983)", async () => {
    const agent = (name: string) =>
      `---\nname: ${name}\ndescription: extra\nversion: 1.0.0\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\n---\nYou are ${name}.\n`;
    const profile = `guidance: extra\nassignable_to: []\nallowed_workspaces: []\nmerge: external\n`;
    const small = await makeRegistry();
    const large = await makeRegistry({
      "agents/bosun.md": agent("bosun"),
      "agents/purser.md": agent("purser"),
      "agents/lookout.md": agent("lookout"),
      "authority/strict.yaml": profile,
      "authority/loose.yaml": profile,
    });

    expect(gitSpawnsOfOneLoad(large)).toBe(gitSpawnsOfOneLoad(small));
  });
});
