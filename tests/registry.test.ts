import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertValidWorkspaceName,
  InvalidWorkspaceNameError,
  loadRegistry,
  type Registry,
  refreshRegistry,
} from "../src/registry.js";
import { makeRegistry, makeRemoteBackedRegistry } from "./registry-fixture.js";

function makeMinimalRegistry(workspaceNames: string[]): Registry {
  return {
    commit: "0".repeat(40),
    agents: {},
    authority: {},
    workspaces: Object.fromEntries(workspaceNames.map((name) => [name, { path: `/tmp/${name}` }])),
  };
}

describe("assertValidWorkspaceName", () => {
  it("英数字・-・_・. のみからなる未使用の名前は通す(例外を投げない)", () => {
    const registry = makeMinimalRegistry(["sandbox"]);
    expect(() => assertValidWorkspaceName(registry, "my-new_workspace.v2")).not.toThrow();
  });

  it("registry に既存の名前と衝突する名前は拒否する", () => {
    const registry = makeMinimalRegistry(["sandbox"]);
    expect(() => assertValidWorkspaceName(registry, "sandbox")).toThrow(InvalidWorkspaceNameError);
  });

  it("Object.prototype 由来の名前(toString など)は実際に登録されていなければ通す", () => {
    const registry = makeMinimalRegistry([]);
    expect(() => assertValidWorkspaceName(registry, "toString")).not.toThrow();
    expect(() => assertValidWorkspaceName(registry, "constructor")).not.toThrow();
  });

  it("英数字・-・_・. 以外の文字を含む名前は拒否する", () => {
    const registry = makeMinimalRegistry([]);
    expect(() => assertValidWorkspaceName(registry, "my workspace")).toThrow(
      InvalidWorkspaceNameError,
    );
    expect(() => assertValidWorkspaceName(registry, "my/workspace")).toThrow(
      InvalidWorkspaceNameError,
    );
  });

  it(". と .. はディレクトリ名として特別な意味を持つため予約名として拒否する", () => {
    const registry = makeMinimalRegistry([]);
    expect(() => assertValidWorkspaceName(registry, ".")).toThrow(InvalidWorkspaceNameError);
    expect(() => assertValidWorkspaceName(registry, "..")).toThrow(InvalidWorkspaceNameError);
  });
});

describe("loadRegistry", () => {
  it("remote-backed はローカル main ではなく更新済み origin/main を読む(ADR 0052)", async () => {
    const { registryDir, publish } = await makeRemoteBackedRegistry();
    publish(
      "agents/deckhand.md",
      `---\nname: deckhand\ndescription: Merged registry definition\nversion: 0.4.0\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\n---\nYou are the merged Deckhand.\n`,
      "merged registry change",
    );
    await refreshRegistry(registryDir, undefined);

    expect({
      remote: loadRegistry(registryDir, "remote-backed").agents.deckhand!.version,
      // 同じ clone をローカル main として読めば fixture のままである —— 差が出て
      // いなければ、上の 0.4.0 は ref の選択ではなく別の理由で通ったことになる
      local: loadRegistry(registryDir, "purely-local").agents.deckhand!.version,
    }).toEqual({ remote: "0.4.0", local: "0.3.1" });
  });

  it("agent 定義を読み込む: frontmatter の version と authority 参照、本文がシステムプロンプト", async () => {
    const dir = await makeRegistry();
    const registry = loadRegistry(dir, "purely-local");
    const agent = registry.agents.deckhand!;
    expect(agent.version).toBe("0.3.1");
    expect(agent.authority).toBe("standard");
    expect(agent.systemPrompt).toContain("You are Deckhand");
    // frontmatter is metadata, not prompt text
    expect(agent.systemPrompt).not.toContain("version:");
  });

  it("本文が空の agent 定義(frontmatter のみ)を許容し、systemPrompt が空文字になる(ADR 0017: 既定エージェントの正規形は本文が空 — issue #51)", async () => {
    // the canonical default agent (tako) carries no specialty prose; the
    // worker protocol is injected code-side. The closing `---` needs a
    // trailing newline for parseAgentFile's frontmatter regex to match — an
    // empty body is `---\n` with nothing after it.
    const dir = await makeRegistry({
      "agents/tako.md": `---\nname: tako\ndescription: General work agent for the tidepool board\nversion: 0.1.0\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\nicon: \u{1F419}\n---\n`,
    });
    const registry = loadRegistry(dir, "purely-local");
    expect(registry.agents.tako!.systemPrompt).toBe("");
    expect(registry.agents.tako!.icon).toBe("\u{1F419}");
  });

  it("frontmatter の model は optional: あれば読み、なければ undefined", async () => {
    const withModel = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: General work agent for the tidepool board\nmodel: opus\n---\nYou are Deckhand.\n`,
    });
    expect(loadRegistry(withModel, "purely-local").agents.deckhand!.model).toBe("opus");
    const without = await makeRegistry();
    expect(loadRegistry(without, "purely-local").agents.deckhand!.model).toBeUndefined();
  });

  it("frontmatter の description は必須: 欠落は登録時にエラーになる(roster の1行を担う散文 — issue #43 / ADR 0014)", async () => {
    const dir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\n---\nYou are Deckhand.\n`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/description/i);
  });

  it("agent 定義の description を読み込む: roster の1行に載る散文(issue #43)", async () => {
    const dir = await makeRegistry();
    const registry = loadRegistry(dir, "purely-local");
    expect(registry.agents.deckhand!.description).toBe(
      "General work agent for the tidepool board",
    );
  });

  it("frontmatter の effort は optional: あれば読み、なければ undefined", async () => {
    const withEffort = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: General work agent for the tidepool board\neffort: high\n---\nYou are Deckhand.\n`,
    });
    expect(loadRegistry(withEffort, "purely-local").agents.deckhand!.effort).toBe("high");
    const without = await makeRegistry();
    expect(loadRegistry(without, "purely-local").agents.deckhand!.effort).toBeUndefined();
  });

  // issue #33 / 判断4: `model` と同じ**開いた集合**なので、値の妥当性はここで
  // 検査しない(ADR 0042)。エイリアスも具体 id も同じ自由文字列として通す。
  it("frontmatter の advisor は optional: あれば読み、なければ undefined", async () => {
    const withAdvisor = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: General work agent for the tidepool board\nadvisor: opus\n---\nYou are Deckhand.\n`,
    });
    expect(loadRegistry(withAdvisor, "purely-local").agents.deckhand!.advisor).toBe("opus");
    const without = await makeRegistry();
    expect(loadRegistry(without, "purely-local").agents.deckhand!.advisor).toBeUndefined();
  });

  // ADR 0042: 具体 id も同じ口を通る。「エイリアスだけ」と読める形にしない —
  // ホストの CLI 版でエイリアスの解決先が動く以上、具体 id を書くのは正当な選択。
  it("frontmatter の advisor は具体モデル id も同じ自由文字列として通す(ADR 0042)", async () => {
    const dir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: General work agent for the tidepool board\nadvisor: claude-opus-5\n---\nYou are Deckhand.\n`,
    });
    expect(loadRegistry(dir, "purely-local").agents.deckhand!.advisor).toBe("claude-opus-5");
  });

  it("frontmatter の provider を読み込む(ADR 0097 決定1: 推論の向き先・課金元の宣言 — harness とは独立した概念)", async () => {
    const dir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nskills:\n  - "*"\ndescription: General work agent for the tidepool board\nprovider: anthropic\n---\nYou are Deckhand.\n`,
    });
    expect(loadRegistry(dir, "purely-local").agents.deckhand!.provider).toBe("anthropic");
  });

  it("frontmatter の provider は必須: 欠落は登録時にエラーになる(ADR 0097 決定1 — 「省略 = 既定 provider」という暗黙は書き忘れと意図の区別がつかない)", async () => {
    const dir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nskills:\n  - "*"\ndescription: General work agent for the tidepool board\n---\nYou are Deckhand.\n`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/provider/i);
  });

  it("provider の値の列挙・advisor 組み合わせの検査は読み込みではなく登録と pickup の門(ADR 0097 決定3): 未知の値も読み込め、違反はその agent 名の quarantine に留まり registry 読み取り全体を倒さない", async () => {
    const dir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nskills:\n  - "*"\ndescription: General work agent for the tidepool board\nprovider: moonshto\nadvisor: opus\n---\nYou are Deckhand.\n`,
    });
    const agent = loadRegistry(dir, "purely-local").agents.deckhand!;
    expect(agent.provider).toBe("moonshto");
    expect(agent.advisor).toBe("opus");
  });

  it("frontmatter の icon は optional: あれば読み、なければ undefined", async () => {
    const withIcon = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: General work agent for the tidepool board\nicon: \u{1F419}\n---\nYou are Deckhand.\n`,
    });
    expect(loadRegistry(withIcon, "purely-local").agents.deckhand!.icon).toBe("\u{1F419}");
    const without = await makeRegistry();
    expect(loadRegistry(without, "purely-local").agents.deckhand!.icon).toBeUndefined();
  });

  it("frontmatter の icon が複数文字(絵文字2つ)の場合は登録時にエラーになる(ADR 0026: 単一グラフェム制約)", async () => {
    const dir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: General work agent for the tidepool board\nicon: \u{1F419}\u{1F980}\n---\nYou are Deckhand.\n`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/icon/i);
  });

  it("frontmatter の icon が絵文字以外の文字の場合は登録時にエラーになる", async () => {
    const dir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: General work agent for the tidepool board\nicon: a\n---\nYou are Deckhand.\n`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/icon/i);
  });

  it("frontmatter の icon が Twemoji 収録範囲外の絵文字の場合は登録時にエラーになる(ADR 0026)", async () => {
    // U+1FADD (radish, Unicode 16.0) — not yet in @twemoji/parser's coverage
    // as of the pinned version; tracks the dependency's coverage table by
    // design (ADR 0026: validation must reject what the renderer can't show).
    const dir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: General work agent for the tidepool board\nicon: \u{1FADD}\n---\nYou are Deckhand.\n`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/icon/i);
  });

  it("frontmatter の skills 許可リストを読み込む(CONTEXT.md: エージェント = ベース AI + skills + ...・issue #56 / ADR 0025)", async () => {
    const dir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\ndescription: General work agent for the tidepool board\nskills:\n  - "@workspace"\n---\nYou are Deckhand.\n`,
    });
    expect(loadRegistry(dir, "purely-local").agents.deckhand!.skills).toEqual(["@workspace"]);
  });

  it("frontmatter の skills は必須: 欠落は登録時にエラーになる(省略=無制限のフットガンを作らない・issue #41 の線 / ADR 0025)", async () => {
    const dir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\ndescription: General work agent for the tidepool board\n---\nYou are Deckhand.\n`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/skills/i);
  });

  /** A deckhand definition whose `skills` frontmatter is the given YAML block —
   *  keeps the grammar tests to their one varying part. */
  const withSkills = (skillsYaml: string) =>
    makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\ndescription: General work agent for the tidepool board\nskills:\n${skillsYaml}---\nYou are Deckhand.\n`,
    });

  it("skills の '*' は単独時のみ有効: 他の語と併記されるとエラー(glob は '*' 単独と '名前:*' の2形だけ・ADR 0025)", async () => {
    const dir = await withSkills(`  - "*"\n  - code-review\n`);
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/skill/i);
  });

  it("skills の @ スコープ語は {@workspace, @host} の閉集合: 実在しないスコープ語はエラー(語の typo を検出する・ADR 0025)", async () => {
    const good = await withSkills(`  - "@workspace"\n  - "@host"\n`);
    expect(loadRegistry(good, "purely-local").agents.deckhand!.skills).toEqual(["@workspace", "@host"]);
    const typo = await withSkills(`  - "@wrokspace"\n`);
    expect(() => loadRegistry(typo, "purely-local")).toThrow(/skill/i);
  });

  it("skills の glob は '名前:*' の形のみ: 'foo*' や '*bar' のような部分 glob はエラー(ADR 0025)", async () => {
    const pluginGlob = await withSkills(`  - "myplugin:*"\n`);
    expect(loadRegistry(pluginGlob, "purely-local").agents.deckhand!.skills).toEqual(["myplugin:*"]);
    for (const bad of ["foo*", "*bar", "pre*fix"]) {
      const dir = await withSkills(`  - "${bad}"\n`);
      expect(() => loadRegistry(dir, "purely-local")).toThrow(/skill/i);
    }
  });

  it("skills の個別名・plugin:skill・実在しない参照は在庫非依存で通る(許可リストは参照であって在庫の主張ではない・ADR 0023 の線)", async () => {
    const dir = await withSkills(`  - code-review\n  - "myplugin:deploy"\n  - does-not-exist-anywhere\n`);
    expect(loadRegistry(dir, "purely-local").agents.deckhand!.skills).toEqual([
      "code-review",
      "myplugin:deploy",
      "does-not-exist-anywhere",
    ]);
  });

  it("skills の空リストは全禁止として有効(ADR 0025: 全禁止は空リストで綴る)", async () => {
    const dir = await withSkills(`  []\n`);
    expect(loadRegistry(dir, "purely-local").agents.deckhand!.skills).toEqual([]);
  });

  it("authority プロファイルを読み込む: guidance の prose が取れる", async () => {
    const dir = await makeRegistry();
    const registry = loadRegistry(dir, "purely-local");
    expect(registry.authority.standard!.guidance).toContain("Prefer reversible actions");
  });

  it("assignable_to を省略した authority profile は registry ロード時にエラーになる(issue #41: 省略=無制限のフットガンを潰す)", async () => {
    const dir = await makeRegistry({
      "authority/standard.yaml": `guidance: be careful\nallowed_workspaces:\n  - "*"\nmerge: external\n`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/assignable_to/i);
  });

  it("allowed_workspaces を省略した authority profile は registry ロード時にエラーになる(issue #41: 省略=無制限のフットガンを潰す)", async () => {
    const dir = await makeRegistry({
      "authority/standard.yaml": `guidance: be careful\nassignable_to:\n  - "*"\nmerge: external\n`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/allowed_workspaces/i);
  });

  it("merge を省略した authority profile は registry ロード時にエラーになる(ADR 0079 決定1: ダイヤルは必須の3値)", async () => {
    const dir = await makeRegistry({
      "authority/standard.yaml": `guidance: be careful\nassignable_to:\n  - "*"\nallowed_workspaces:\n  - "*"\n`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/merge/i);
  });

  it("merge: external を宣言した authority profile は読み込める(ADR 0079: 盤面の外の merge 面の宣言)", async () => {
    const dir = await makeRegistry({
      "authority/standard.yaml": `guidance: be careful\nassignable_to:\n  - "*"\nallowed_workspaces:\n  - "*"\nmerge: external\n`,
    });
    expect(loadRegistry(dir, "purely-local").authority.standard!.merge).toBe("external");
  });

  it("エスカレーション権らしきフィールドを持つプロファイルは読み込み自体を拒否する", async () => {
    // the safety valve: upward escalation is never restricted, so the schema
    // is closed — a profile cannot even express such a field by mistake
    const dir = await makeRegistry({
      "authority/standard.yaml": `guidance: be careful\nescalation: forbidden\n`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/escalation|unrecognized/i);
  });

  it("workspaces.yaml を読み込む: 名前 → パス・repo URL・セットアップメモ", async () => {
    const dir = await makeRegistry();
    const registry = loadRegistry(dir, "purely-local");
    const ws = registry.workspaces.tidepool!;
    expect(ws.path).toBe("/home/pi/work/tidepool");
    expect(ws.repo).toBe("https://github.com/sinano1107/tidepool.git");
    expect(ws.notes).toContain("npm install");
  });

  it("workspaces.yaml の protected は optional: あれば読み、省略時は undefined", async () => {
    const withProtected = await makeRegistry({
      "workspaces.yaml": `tidepool:\n  path: /home/pi/work/tidepool\n  protected: true\n`,
    });
    expect(loadRegistry(withProtected, "purely-local").workspaces.tidepool!.protected).toBe(true);
    const without = await makeRegistry();
    expect(loadRegistry(without, "purely-local").workspaces.tidepool!.protected).toBeUndefined();
  });

  it("workspaces.yaml の branch は optional: あれば読み、省略時は undefined(issue #27)", async () => {
    const withBranch = await makeRegistry({
      "workspaces.yaml": `tidepool:\n  path: /home/pi/work/tidepool\n  branch: master\n`,
    });
    expect(loadRegistry(withBranch, "purely-local").workspaces.tidepool!.branch).toBe("master");
    const without = await makeRegistry();
    expect(loadRegistry(without, "purely-local").workspaces.tidepool!.branch).toBeUndefined();
  });

  it("workspaces.yaml の path は optional: 省略しても読み込みエラーにならず undefined になる(ADR 0018)", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `sandbox:\n  notes: created by the board\n`,
    });
    const registry = loadRegistry(dir, "purely-local");
    expect(registry.workspaces.sandbox!.path).toBeUndefined();
  });

  it("使用中の clone の HEAD commit hash を持つ(どのバージョンの判断か、の来歴)", async () => {
    const dir = await makeRegistry();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
    const registry = loadRegistry(dir, "purely-local");
    expect(registry.commit).toBe(head);
    expect(registry.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("ワーキングツリーではなくコミット済み main を読む: タスクブランチ上の未 merge 変更は spawn に効かない(ADR 0020)", async () => {
    const dir = await makeRegistry();
    const mainCommit = execFileSync("git", ["rev-parse", "main"], { cwd: dir }).toString().trim();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd: dir });
    // branch discipline moves HEAD onto a registry-edit task branch, and the
    // working tree carries an edit that never went through a human merge —
    // the loophole ADR 0020 closes
    git("checkout", "-b", "task/registry-edit");
    await writeFile(
      join(dir, "agents", "deckhand.md"),
      `---\nname: deckhand\ndescription: HIJACKED\nversion: 9.9.9\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\n---\nYou are compromised.\n`,
    );
    git("add", "-A");
    git("commit", "-m", "unmerged edit on a task branch");
    const registry = loadRegistry(dir, "purely-local");
    // main's version and prose, never the task branch's
    expect(registry.agents.deckhand!.version).toBe("0.3.1");
    expect(registry.agents.deckhand!.description).toBe("General work agent for the tidepool board");
    expect(registry.agents.deckhand!.systemPrompt).toContain("You are Deckhand");
    // the recorded provenance hash is main's, not the task-branch HEAD
    expect(registry.commit).toBe(mainCommit);
  });

  it("ワーキングツリーが dirty(未コミットの編集)でも main の内容を読む(ADR 0020)", async () => {
    const dir = await makeRegistry();
    // an out-of-band hand edit that was never committed is structurally inert
    await writeFile(
      join(dir, "workspaces.yaml"),
      `tidepool:\n  path: /tmp/hijacked\n  branch: attacker\n`,
    );
    const registry = loadRegistry(dir, "purely-local");
    expect(registry.workspaces.tidepool!.path).toBe("/home/pi/work/tidepool");
    expect(registry.workspaces.tidepool!.branch).toBeUndefined();
  });
});
