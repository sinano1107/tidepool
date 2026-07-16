import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadRegistry } from "../src/registry.js";
import { makeRegistry } from "./registry-fixture.js";

describe("loadRegistry", () => {
  it("agent 定義を読み込む: frontmatter の version と authority 参照、本文がシステムプロンプト", async () => {
    const dir = await makeRegistry();
    const registry = loadRegistry(dir);
    const agent = registry.agents.deckhand!;
    expect(agent.version).toBe("0.3.1");
    expect(agent.authority).toBe("standard");
    expect(agent.systemPrompt).toContain("You are Deckhand");
    // frontmatter is metadata, not prompt text
    expect(agent.systemPrompt).not.toContain("version:");
  });

  it("frontmatter の model は optional: あれば読み、なければ undefined", async () => {
    const withModel = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\ndescription: General work agent for the tidepool board\nmodel: opus\n---\nYou are Deckhand.\n`,
    });
    expect(loadRegistry(withModel).agents.deckhand!.model).toBe("opus");
    const without = await makeRegistry();
    expect(loadRegistry(without).agents.deckhand!.model).toBeUndefined();
  });

  it("frontmatter の description は必須: 欠落は登録時にエラーになる(roster の1行を担う散文 — issue #43 / ADR 0014)", async () => {
    const dir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\n---\nYou are Deckhand.\n`,
    });
    expect(() => loadRegistry(dir)).toThrow(/description/i);
  });

  it("agent 定義の description を読み込む: roster の1行に載る散文(issue #43)", async () => {
    const dir = await makeRegistry();
    const registry = loadRegistry(dir);
    expect(registry.agents.deckhand!.description).toBe(
      "General work agent for the tidepool board",
    );
  });

  it("frontmatter の effort は optional: あれば読み、なければ undefined", async () => {
    const withEffort = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\ndescription: General work agent for the tidepool board\neffort: high\n---\nYou are Deckhand.\n`,
    });
    expect(loadRegistry(withEffort).agents.deckhand!.effort).toBe("high");
    const without = await makeRegistry();
    expect(loadRegistry(without).agents.deckhand!.effort).toBeUndefined();
  });

  it("authority プロファイルを読み込む: guidance の prose が取れる", async () => {
    const dir = await makeRegistry();
    const registry = loadRegistry(dir);
    expect(registry.authority.standard!.guidance).toContain("Prefer reversible actions");
  });

  it("assignable_to を省略した authority profile は registry ロード時にエラーになる(issue #41: 省略=無制限のフットガンを潰す)", async () => {
    const dir = await makeRegistry({
      "authority/standard.yaml": `guidance: be careful\nallowed_workspaces:\n  - "*"\n`,
    });
    expect(() => loadRegistry(dir)).toThrow(/assignable_to/i);
  });

  it("allowed_workspaces を省略した authority profile は registry ロード時にエラーになる(issue #41: 省略=無制限のフットガンを潰す)", async () => {
    const dir = await makeRegistry({
      "authority/standard.yaml": `guidance: be careful\nassignable_to:\n  - "*"\n`,
    });
    expect(() => loadRegistry(dir)).toThrow(/allowed_workspaces/i);
  });

  it("エスカレーション権らしきフィールドを持つプロファイルは読み込み自体を拒否する", async () => {
    // the safety valve: upward escalation is never restricted, so the schema
    // is closed — a profile cannot even express such a field by mistake
    const dir = await makeRegistry({
      "authority/standard.yaml": `guidance: be careful\nescalation: forbidden\n`,
    });
    expect(() => loadRegistry(dir)).toThrow(/escalation|unrecognized/i);
  });

  it("workspaces.yaml を読み込む: 名前 → パス・repo URL・セットアップメモ", async () => {
    const dir = await makeRegistry();
    const registry = loadRegistry(dir);
    const ws = registry.workspaces.tidepool!;
    expect(ws.path).toBe("/home/pi/work/tidepool");
    expect(ws.repo).toBe("https://github.com/sinano1107/tidepool.git");
    expect(ws.notes).toContain("npm install");
  });

  it("workspaces.yaml の protected は optional: あれば読み、省略時は undefined", async () => {
    const withProtected = await makeRegistry({
      "workspaces.yaml": `tidepool:\n  path: /home/pi/work/tidepool\n  protected: true\n`,
    });
    expect(loadRegistry(withProtected).workspaces.tidepool!.protected).toBe(true);
    const without = await makeRegistry();
    expect(loadRegistry(without).workspaces.tidepool!.protected).toBeUndefined();
  });

  it("workspaces.yaml の branch は optional: あれば読み、省略時は undefined(issue #27)", async () => {
    const withBranch = await makeRegistry({
      "workspaces.yaml": `tidepool:\n  path: /home/pi/work/tidepool\n  branch: master\n`,
    });
    expect(loadRegistry(withBranch).workspaces.tidepool!.branch).toBe("master");
    const without = await makeRegistry();
    expect(loadRegistry(without).workspaces.tidepool!.branch).toBeUndefined();
  });

  it("workspaces.yaml の path は optional: 省略しても読み込みエラーにならず undefined になる(ADR 0018)", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `sandbox:\n  notes: created by the board\n`,
    });
    const registry = loadRegistry(dir);
    expect(registry.workspaces.sandbox!.path).toBeUndefined();
  });

  it("使用中の clone の HEAD commit hash を持つ(どのバージョンの判断か、の来歴)", async () => {
    const dir = await makeRegistry();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
    const registry = loadRegistry(dir);
    expect(registry.commit).toBe(head);
    expect(registry.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
