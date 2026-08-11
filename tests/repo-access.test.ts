import { describe, expect, it } from "vitest";
import { ensureRepoAccess, parseGitHubRepo, repoAccessGuidance } from "../src/repo-access.js";
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

describe("ensureRepoAccess(ADR 0067 決定1: いま到達したい repo 宛ての1枚だけを受諾する)", () => {
  const ref = { owner: "sinano1107", name: "tidepool" };

  it("WRITE 以上が既に見えていれば受信箱すら読まない —— 受諾は試みない", async () => {
    const github = new FakeGitHubClient();
    github.scriptRepositoryPermission("sinano1107/tidepool", "WRITE");

    expect(await ensureRepoAccess(github, ref)).toEqual({ permission: "WRITE", accepted: false });
    // permission の1回だけ: 受信箱も login も読んでいない
    expect(github.repoAccessCalls).toBe(1);
  });

  it("一致する招待だけ受諾して権限を撃ち直す —— 一致しない招待には触れない(辞退もしない)", async () => {
    const github = new FakeGitHubClient();
    github.scriptInvitation(111, "sinano1107/tidepool");
    github.scriptInvitation(222, "someone/else");

    expect(await ensureRepoAccess(github, ref)).toEqual({ permission: "WRITE", accepted: true });
    expect(github.acceptedInvitations).toEqual([111]);
  });

  it("full_name の大文字小文字は無視して一致させる", async () => {
    const github = new FakeGitHubClient();
    github.scriptInvitation(111, "Sinano1107/TidePool");

    expect(await ensureRepoAccess(github, ref)).toEqual({ permission: "WRITE", accepted: true });
  });

  it("read で招待されると受諾は成功するが WRITE 未満として返る(実測4: push だけが後から 403 になる形を門で捕まえる)", async () => {
    const github = new FakeGitHubClient();
    github.scriptInvitation(111, "sinano1107/tidepool", "read");

    expect(await ensureRepoAccess(github, ref)).toEqual({ permission: "READ", accepted: true });
  });

  it("一致する招待が無ければ受諾は起きず、見えないままの permission を返す", async () => {
    const github = new FakeGitHubClient();
    github.scriptInvitation(222, "someone/else");

    expect(await ensureRepoAccess(github, ref)).toEqual({ permission: null, accepted: false });
    expect(github.acceptedInvitations).toEqual([]);
  });
});

describe("repoAccessGuidance(ADR 0067 決定4: 3つを名指しする)", () => {
  const ref = { owner: "sinano1107", name: "tidepool" };

  it("見えないときは「存在しないか、この login に見えていない」の両方を名指しする(実測7: 区別できない)", () => {
    const guidance = repoAccessGuidance(ref, "tidepool-bot", null);

    expect(guidance).toContain("sinano1107/tidepool");
    expect(guidance).toContain("tidepool-bot");
    expect(guidance).toMatch(/does not exist/i);
    expect(guidance).toMatch(/not visible/i);
    expect(guidance).toContain("https://github.com/sinano1107/tidepool/settings/access");
    expect(guidance).toContain(
      "gh api -X PUT repos/sinano1107/tidepool/collaborators/tidepool-bot -f permission=push",
    );
  });

  it("WRITE 未満のときは今の権限名を出す —— 「見えているが書けない」は別の症状である", () => {
    const guidance = repoAccessGuidance(ref, "tidepool-bot", "READ");

    expect(guidance).toContain("READ");
    expect(guidance).not.toMatch(/does not exist/i);
    expect(guidance).toContain("https://github.com/sinano1107/tidepool/settings/access");
    expect(guidance).toContain(
      "gh api -X PUT repos/sinano1107/tidepool/collaborators/tidepool-bot -f permission=push",
    );
  });
});
