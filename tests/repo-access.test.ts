import { describe, expect, it } from "vitest";
import { parseGitHubRepo, repairRepoAccess } from "../src/repo-access.js";
import { FakeGitHubClient } from "./fakes.js";

describe("parseGitHubRepo(ADR 0067 決定1: これは github.com か、の門)", () => {
  it("https / ssh / scp / bare の4つの綴りから同じ owner/name を取り出す", () => {
    const ref = { owner: "sinano1107", name: "tidepool" };
    expect(parseGitHubRepo("https://github.com/sinano1107/tidepool")).toEqual(ref);
    expect(parseGitHubRepo("https://github.com/sinano1107/tidepool.git")).toEqual(ref);
    expect(parseGitHubRepo("git@github.com:sinano1107/tidepool.git")).toEqual(ref);
    expect(parseGitHubRepo("ssh://git@github.com/sinano1107/tidepool")).toEqual(ref);
    expect(parseGitHubRepo("sinano1107/tidepool")).toEqual(ref);
  });

  it("github.com 以外は undefined —— 非 GitHub の remote では probe も受諾も発火しない", () => {
    expect(parseGitHubRepo("https://gitlab.com/sinano1107/tidepool")).toBeUndefined();
    expect(parseGitHubRepo("git@gitlab.com:sinano1107/tidepool.git")).toBeUndefined();
  });

  it("ローカルパスは undefined —— quarantine テストが差し替える /nonexistent/... で probe が撃たれない", () => {
    expect(parseGitHubRepo("/nonexistent/upstream.git")).toBeUndefined();
    expect(parseGitHubRepo("/var/folders/t/tidepool-upstream-abc123")).toBeUndefined();
  });
});

describe("repairRepoAccess(ADR 0093 決定8: 修復は「App を install する」)", () => {
  const ref = { owner: "sinano1107", name: "tidepool" };

  it("仲介が token を出せる repo は案内なしで通る", async () => {
    const github = new FakeGitHubClient();

    expect(await repairRepoAccess(github, ref)).toEqual({ guidance: null });
    expect(github.repoAccessCalls).toBe(1);
  });

  it("token が出せなければ install リンク・repo の名指し・区別できない2つの診断・仲介の理由を載せた案内を返す", async () => {
    const github = new FakeGitHubClient();
    github.scriptUnreachable("sinano1107/tidepool");

    const { guidance } = await repairRepoAccess(github, ref);

    expect(guidance).toContain("sinano1107/tidepool");
    expect(guidance).toContain("/installations/new");
    expect(guidance).toMatch(/not installed/i);
    expect(guidance).toMatch(/cannot push/i);
    expect(guidance).toContain("HTTP 404: repo_unreachable");
  });
});
