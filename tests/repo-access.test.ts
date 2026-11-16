import { describe, expect, it } from "vitest";
import { parseGitHubRepo, repairRepoAccess, sameRepository } from "../src/repo-access.js";
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

  it.each([
    "https://github.com/Sinano1107/Tidepool/",
    "https://github.com/Sinano1107/Tidepool.git/",
    "https://git@github.com/Sinano1107/Tidepool.git",
  ])("Git が受ける URL の綴り %s を同じ owner/name に畳む(ADR 0378 決定4)", (url) => {
    expect(parseGitHubRepo(url)).toEqual({ owner: "sinano1107", name: "tidepool" });
  });

  it("github.com 以外は undefined —— 非 GitHub の remote では probe も受諾も発火しない", () => {
    expect(parseGitHubRepo("https://gitlab.com/sinano1107/tidepool")).toBeUndefined();
    expect(parseGitHubRepo("git@gitlab.com:sinano1107/tidepool.git")).toBeUndefined();
  });

  it("ローカルパスは undefined —— quarantine テストが差し替える /nonexistent/... で probe が撃たれない", () => {
    expect(parseGitHubRepo("/nonexistent/upstream.git")).toBeUndefined();
    expect(parseGitHubRepo("/var/folders/t/tidepool-upstream-abc123")).toBeUndefined();
    // GitHub の owner に `.` は入らない —— `..` / `.` から始まる相対 path を owner/name と読まない
    expect(parseGitHubRepo("../up.git")).toBeUndefined();
    expect(parseGitHubRepo("./up")).toBeUndefined();
  });
});

it("GitHub の照合では盤面の通信と同じく URL の前後の空白を除き、他の origin は文字列のまま比べる(ADR 0378 決定4)", () => {
  expect(sameRepository(" git@github.com:Sinano1107/Tidepool.git ", "https://github.com/sinano1107/tidepool")).toBe(true);
  expect(sameRepository(" /srv/git/tidepool.git ", "/srv/git/tidepool.git")).toBe(false);
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
