import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgent,
  InvalidAgentIconError,
  listAgentViews,
  UnknownAuthorityProfileError,
} from "../src/agent-create.js";
import { InvalidAgentNameError, InvalidAgentProviderError, InvalidSkillAllowlistError, loadRegistry } from "../src/registry.js";
import { RegistryFetchFailedError, RegistryPushFailedError } from "../src/registry-write.js";
import { makeRegistry, makeRemoteBackedRegistry } from "./registry-fixture.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** registry クローンのブランチ名をホストの init.defaultBranch 設定に依存させ
 *  ない — ADR 0020 の「main はコード定数」に合わせ、fixture を main に正規化。 */
async function makeMainRegistry(): Promise<string> {
  const dir = await makeRegistry();
  git(dir, "branch", "-M", "main");
  return dir;
}

describe("createAgent: 正常系(issue #70)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("ambient な worker 名義があっても agents/<name>.md は Tidepool 名義でコミットされ、loadRegistry が全フィールドを返す(issue #312)", async () => {
    const registryDir = await makeMainRegistry();
    vi.stubEnv("GIT_AUTHOR_NAME", "tako");
    vi.stubEnv("GIT_AUTHOR_EMAIL", "tako@tidepool.invalid");
    vi.stubEnv("GIT_COMMITTER_NAME", "tako");
    vi.stubEnv("GIT_COMMITTER_EMAIL", "tako@tidepool.invalid");

    await createAgent(
      {
        name: "tako",
        authority: "standard",
        provider: "anthropic",
        description: "General work agent for the tidepool board",
        icon: "🐙",
        model: "claude-sonnet-5",
        effort: "high",
        advisor: "opus",
        skills: ["@workspace"],
        systemPrompt: "You are Tako, the tidepool board's general work agent.\nBe kind.",
      },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    const agent = loadRegistry(registryDir, "purely-local").agents.tako;
    expect(agent).toEqual({
      name: "tako",
      // 作成時の version は機械刻印 — 呼び出し側は渡せない(入力型に version がない)
      version: "1",
      authority: "standard",
      provider: "anthropic",
      description: "General work agent for the tidepool board",
      icon: "🐙",
      model: "claude-sonnet-5",
      effort: "high",
      advisor: "opus",
      skills: ["@workspace"],
      systemPrompt: "You are Tako, the tidepool board's general work agent.\nBe kind.",
    });
    // 手編集(帯域外)ではなくコミット済み — ADR 0020 の読み取り規律と両立する。
    // registryDir 自身の working tree は checkout ではなく着地先の ref だけを見る
    // (ADR 0052 決定6: clone の working tree は正本ではないので触れない)
    expect(git(registryDir, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(
      "tidepool <319381852+tidepool-board[bot]@users.noreply.github.com>|" +
        "tidepool <319381852+tidepool-board[bot]@users.noreply.github.com>",
    );
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe("create agent tako via WebUI");
  });

  it("icon/model/effort/advisor を省略すると frontmatter にキー自体が現れず、ラウンドトリップでも undefined のまま", async () => {
    const registryDir = await makeMainRegistry();

    await createAgent(
      {
        name: "hermit",
        authority: "standard",
        provider: "anthropic",
        description: "Minimal agent",
        skills: ["*"],
        systemPrompt: "You are Hermit.",
      },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    // ADR 0052 決定6: 書き込みは使い捨て worktree の中で起こる — registryDir 自身
    // の working tree ではなく着地先の ref から読む(loadRegistry と同じ規律)
    const raw = git(registryDir, "show", "main:agents/hermit.md");
    expect(raw).not.toContain("icon");
    expect(raw).not.toContain("model");
    expect(raw).not.toContain("effort");
    expect(raw).not.toContain("advisor");
    const agent = loadRegistry(registryDir, "purely-local").agents.hermit;
    expect(agent).toEqual({
      name: "hermit",
      version: "1",
      authority: "standard",
      provider: "anthropic",
      description: "Minimal agent",
      icon: undefined,
      model: undefined,
      effort: undefined,
      advisor: undefined,
      skills: ["*"],
      systemPrompt: "You are Hermit.",
    });
  });
});

describe("createAgent: name 検証(issue #70 — assertValidWorkspaceName と同型の入口ゲート)", () => {
  const base = {
    authority: "standard",
    provider: "anthropic",
    description: "d",
    skills: ["*"],
    systemPrompt: "p",
  };

  it.each(["../escape", "a/b", "", ".", ".."])(
    "charset 外・予約名 %j は InvalidAgentNameError で拒否され、コミットを積まない",
    async (name) => {
      const registryDir = await makeMainRegistry();
      const before = git(registryDir, "rev-parse", "HEAD");

      await expect(createAgent({ ...base, name }, { registry: { dir: registryDir, mode: "purely-local" } })).rejects.toThrow(
        InvalidAgentNameError,
      );
      expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    },
  );

  it("registry に既にあるエージェント名は拒否され、既存定義を上書きしない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      createAgent({ ...base, name: "deckhand" }, { registry: { dir: registryDir, mode: "purely-local" } }),
    ).rejects.toThrow(InvalidAgentNameError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    // fixture の deckhand はそのまま
    expect(loadRegistry(registryDir, "purely-local").agents.deckhand!.version).toBe("0.3.1");
  });
});

describe("createAgent: authority 検証(issue #70 — 既存プロファイルからの選択のみ)", () => {
  it("registry にないプロファイル名は UnknownAuthorityProfileError で拒否され、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      createAgent(
        { name: "tako", authority: "no-such-profile", provider: "anthropic", description: "d", skills: ["*"], systemPrompt: "p" },
        { registry: { dir: registryDir, mode: "purely-local" } },
      ),
    ).rejects.toThrow(UnknownAuthorityProfileError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("createAgent: checkout の位置に依存しない書き込み(ADR 0052 決定6 / issue #210)", () => {
  const input = { name: "tako", authority: "standard", provider: "anthropic", description: "d", skills: ["*"], systemPrompt: "p" };

  it("registry クローンが registry-edit タスクのブランチに居ても、リモート main へコミットが着地する", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");

    await createAgent(input, { registry: { dir: registryDir, mode: "remote-backed" } });

    // push がローカルの remote-tracking ref を更新する — 手で fetch しなくても
    // loadRegistry からそのまま見える(push 成功 = 効いた、の定義そのもの)
    expect(loadRegistry(registryDir, "remote-backed").agents.tako).toBeDefined();
    expect(git(registryDir, "log", "-1", "--format=%s", "refs/remotes/origin/main")).toBe(
      "create agent tako via WebUI",
    );
    // クローン自身の checkout はタスクブランチのまま動かない — worktree は書き込みの
    // ためだけの使い捨てで、盤面が読まないその他の状態には触れない
    expect(git(registryDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/registry-edit-1");
    expect(git(registryDir, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("push が失敗すると致命 — リモートにもローカルの追跡 ref にもコミットが残らず、worktree も残らない", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "remote", "set-url", "--push", "origin", "/no/such/remote");
    const before = git(registryDir, "rev-parse", "refs/remotes/origin/main");

    await expect(
      createAgent(input, { registry: { dir: registryDir, mode: "remote-backed" } }),
    ).rejects.toThrow(RegistryPushFailedError);

    expect(git(registryDir, "rev-parse", "refs/remotes/origin/main")).toBe(before);
    expect(loadRegistry(registryDir, "remote-backed").agents.tako).toBeUndefined();
    expect(git(registryDir, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("入口の fetch が失敗すると致命 — コミットを一切積まない(issue #210 レビュー — 決定4)", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "remote", "set-url", "origin", "/no/such/remote");

    await expect(
      createAgent(input, { registry: { dir: registryDir, mode: "remote-backed" } }),
    ).rejects.toThrow(RegistryFetchFailedError);

    expect(loadRegistry(registryDir, "remote-backed").agents.tako).toBeUndefined();
  });

  it("純ローカル registry(remote なし)でも、タスクブランチに居る状態から書き込みが通る", async () => {
    const registryDir = await makeMainRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");

    await createAgent(input, { registry: { dir: registryDir, mode: "purely-local" } });

    expect(loadRegistry(registryDir, "purely-local").agents.tako).toBeDefined();
    expect(git(registryDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/registry-edit-1");
  });

  it("純ローカル registry で HEAD が main のまま書き込んでも、クローン自身の checkout に中途半端な状態を残さない(/code-review 指摘)", async () => {
    const registryDir = await makeMainRegistry();
    // HEAD はデフォルトで main — このまま(task ブランチへ逃がさず)書き込む

    await createAgent(input, { registry: { dir: registryDir, mode: "purely-local" } });

    expect(loadRegistry(registryDir, "purely-local").agents.tako).toBeDefined();
    // update-ref はローカル `main` の位置だけを動かし working tree/index を
    // 素通りする — HEAD が main を指したままだと index が新しい tip を知らず、
    // 次にこの checkout で走る commit(release の WIP commit や手編集)が
    // 今回追加した agents/tako.md を静かに削除してしまう窓が開く
    expect(git(registryDir, "status", "--porcelain")).toBe("");
  });

  it("純ローカル registry で HEAD が main かつ dirty でも、書き込みと衝突しないローカルの未コミット変更は破壊されない(/code-review 再指摘 — reset --hard ではなく read-tree -m -u)", async () => {
    const registryDir = await makeMainRegistry();
    // 今回の書き込みが触らないファイルへの、コミットされていないローカル編集
    // (registry-edit タスクの途中経過や手編集を模す)
    writeFileSync(join(registryDir, "workspaces.yaml"), "tidepool:\n  path: /local/wip/edit\n");

    await createAgent(input, { registry: { dir: registryDir, mode: "purely-local" } });

    expect(loadRegistry(registryDir, "purely-local").agents.tako).toBeDefined();
    // ローカルの未コミット編集は消えていない(reset --hard なら失われていた)
    expect(readFileSync(join(registryDir, "workspaces.yaml"), "utf8")).toBe(
      "tidepool:\n  path: /local/wip/edit\n",
    );
    expect(git(registryDir, "status", "--porcelain", "--", "workspaces.yaml")).toContain("workspaces.yaml");
  });

  it("checkout の同期が衝突で失敗しても、書き込み自体は成功のまま報告される(ref の着地と同期のベストエフォートは別の失敗ドメイン)", async () => {
    const registryDir = await makeMainRegistry();
    // 今回書き込む agents/tako.md と同じパスに、untracked な別内容を置く —
    // read-tree -m -u が安全に諦める(working tree を書き換えない)条件を再現
    execFileSync("mkdir", ["-p", join(registryDir, "agents")]);
    writeFileSync(join(registryDir, "agents", "tako.md"), "untracked local draft, not tako's real body");

    // 例外を投げない = ref の着地(書き込みの成立)自体は失敗として報告されない
    await createAgent(input, { registry: { dir: registryDir, mode: "purely-local" } });

    // 盤面が読む内容(committed ref 経由)は正しく更新されている
    expect(loadRegistry(registryDir, "purely-local").agents.tako).toBeDefined();
    // 同期だけがベストエフォートで諦めた結果、untracked のローカル内容は
    // 上書きされずに残る(read-tree -m -u が working tree を変更しなかった証拠)
    expect(readFileSync(join(registryDir, "agents", "tako.md"), "utf8")).toBe(
      "untracked local draft, not tako's real body",
    );
  });

  it("入口の fetch が検証に効く — リモートで先に merge された同名エージェントを見逃さない(issue #210 レビュー — 決定4)", async () => {
    const { registryDir, publish } = await makeRemoteBackedRegistry();
    // 人間の merge を模す: ローカルの remote-tracking ref が知らないうちに
    // リモート main へ tako が着地している
    publish(
      "agents/tako.md",
      '---\nversion: "1"\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: published elsewhere\n---\nbody\n',
      "merge: add agent tako",
    );

    await expect(createAgent(input, { registry: { dir: registryDir, mode: "remote-backed" } })).rejects.toThrow(
      InvalidAgentNameError,
    );

    // 入口の fetch が無ければ、古い remote-tracking ref に対する検証は tako の
    // 存在を知らずに通り、worktree の書き込みが publish した内容を踏みつぶす
    expect(git(registryDir, "log", "-1", "--format=%s", "refs/remotes/origin/main")).toBe(
      "merge: add agent tako",
    );
  });

  it("入口の fetch が worktree の fork 元に効く — 先に merge された内容の上に1本のチェーンで積まれる(issue #210 レビュー — 決定4)", async () => {
    const { registryDir, publish } = await makeRemoteBackedRegistry();
    const publishedSha = publish(
      "agents/hermit.md",
      '---\nversion: "1"\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: published elsewhere\n---\nbody\n',
      "merge: add agent hermit",
    );

    await createAgent(input, { registry: { dir: registryDir, mode: "remote-backed" } });

    // fetch せずに古い base から worktree を切っていたら、この push は
    // non-fast-forward で RegistryPushFailedError になり、ここへ到達しない
    const shas = git(registryDir, "log", "--format=%H", "refs/remotes/origin/main").split("\n");
    expect(shas).toContain(publishedSha);
    expect(git(registryDir, "log", "-1", "--format=%s", "refs/remotes/origin/main")).toBe(
      "create agent tako via WebUI",
    );
    // publish した hermit も、自分が作った tako も両方リモートに残る — 1本の
    // チェーンに積まれた証拠
    const registry = loadRegistry(registryDir, "remote-backed");
    expect(registry.agents.hermit).toBeDefined();
    expect(registry.agents.tako).toBeDefined();
  });

  it("プロセス死で残った前回の worktree 管理情報を掃除してから書き込む(issue #210 やること4)", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    // 前回の書き込みがプロセス死で `git worktree remove` まで辿り着かなかった
    // 状態を模す: worktree を切ったまま、ディレクトリだけ帯域外で消す
    const orphan = `${registryDir}-orphan-wt`;
    git(registryDir, "worktree", "add", "--detach", orphan, "main");
    rmSync(orphan, { recursive: true, force: true });
    expect(git(registryDir, "worktree", "list").trim().split("\n")).toHaveLength(2);

    await createAgent(input, { registry: { dir: registryDir, mode: "remote-backed" } });

    expect(loadRegistry(registryDir, "remote-backed").agents.tako).toBeDefined();
    // 冒頭の `git worktree prune` が孤児の管理情報を消しており、自分の使い捨て
    // worktree も掃除済みなので、残るのは registryDir 自身の1行だけ
    expect(git(registryDir, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });
});

describe("createAgent: icon 検証(ADR 0026 — loadRegistry を壊す書き込みを入口で拒否)", () => {
  it.each(["ab", "🐙🐙", "🐙!"])(
    "単一 Twemoji グラフィムでない icon %j は拒否され、registry は読める状態のまま",
    async (icon) => {
      const registryDir = await makeMainRegistry();
      const before = git(registryDir, "rev-parse", "HEAD");

      await expect(
        createAgent(
          { name: "tako", authority: "standard", provider: "anthropic", description: "d", icon, skills: ["*"], systemPrompt: "p" },
          { registry: { dir: registryDir, mode: "purely-local" } },
        ),
      ).rejects.toThrow(InvalidAgentIconError);
      expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
      // 不正 icon が書き込まれていれば loadRegistry ごと落ちる — それが起きていない
      expect(loadRegistry(registryDir, "purely-local").agents.tako).toBeUndefined();
    },
  );
});

describe("createAgent: skills 検証(ADR 0025 — loadRegistry を壊す許可リストを入口で拒否)", () => {
  it.each([[["*", "code-review"]], [["@world"]], [["foo*"]]])(
    "文法違反の skills %j は InvalidSkillAllowlistError で拒否され、registry は読める状態のまま",
    async (skills) => {
      const registryDir = await makeMainRegistry();
      const before = git(registryDir, "rev-parse", "HEAD");

      await expect(
        createAgent(
          { name: "tako", authority: "standard", provider: "anthropic", description: "d", skills, systemPrompt: "p" },
          { registry: { dir: registryDir, mode: "purely-local" } },
        ),
      ).rejects.toThrow(InvalidSkillAllowlistError);
      expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
      // 不正 allowlist が書き込まれていれば loadRegistry ごと落ちる — それが起きていない
      expect(loadRegistry(registryDir, "purely-local").agents.tako).toBeUndefined();
    },
  );
});

describe("createAgent: provider 検証(ADR 0097 — 必須・列挙・advisor 組み合わせを入口で拒否)", () => {
  const base = {
    name: "tako",
    authority: "standard",
    provider: "anthropic",
    description: "d",
    skills: ["*"],
    systemPrompt: "p",
  };

  it("列挙(anthropic / moonshot)にない provider は InvalidAgentProviderError で拒否され、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      createAgent({ ...base, provider: "moonshto" }, { registry: { dir: registryDir, mode: "purely-local" } }),
    ).rejects.toThrow(InvalidAgentProviderError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    // 不正 provider が書き込まれていれば loadRegistry ごと落ちる — それが起きていない
    expect(loadRegistry(registryDir, "purely-local").agents.tako).toBeUndefined();
  });

  it("advisor を持つ定義に advisor を提供しない provider(moonshot)の組み合わせは拒否され、コミットを積まない(ADR 0097 決定3)", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      createAgent(
        { ...base, provider: "moonshot", advisor: "opus" },
        { registry: { dir: registryDir, mode: "purely-local" } },
      ),
    ).rejects.toThrow(InvalidAgentProviderError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").agents.tako).toBeUndefined();
  });

  it("OpenAI / Codex v1 に無い skill allowlist は登録時に拒否される(ADR 0098)", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      createAgent(
        { ...base, provider: "openai", skills: ["tdd"] },
        { registry: { dir: registryDir, mode: "purely-local" } },
      ),
    ).rejects.toThrow(InvalidAgentProviderError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("moonshot でも advisor を持たなければ通り、frontmatter に provider が書かれてラウンドトリップする", async () => {
    const registryDir = await makeMainRegistry();

    await createAgent(
      { ...base, provider: "moonshot" },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    expect(loadRegistry(registryDir, "purely-local").agents.tako!.provider).toBe("moonshot");
    expect(git(registryDir, "show", "main:agents/tako.md")).toContain("provider: moonshot");
  });

  it("空白だけの advisor は未設定と同じ — moonshot との組み合わせも拒否されない(normalizeAdvisor と同じ正規化で判定)", async () => {
    const registryDir = await makeMainRegistry();

    await createAgent(
      { ...base, provider: "moonshot", advisor: "  \t " },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    expect(loadRegistry(registryDir, "purely-local").agents.tako!.provider).toBe("moonshot");
  });
});

describe("listAgentViews: 編集フォーム用の一覧(issue #70)", () => {
  it("registry の全エージェントを systemPrompt 含む全フィールドで返す", async () => {
    const registryDir = await makeMainRegistry();
    await createAgent(
      { name: "tako", authority: "standard", provider: "anthropic", description: "General agent", icon: "🐙", skills: ["*"], systemPrompt: "You are Tako." },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    const views = listAgentViews({ registry: { dir: registryDir, mode: "purely-local" } });

    expect(views.map((v) => v.name).sort()).toEqual(["deckhand", "tako"]);
    expect(views.find((v) => v.name === "tako")).toEqual({
      name: "tako",
      version: "1",
      authority: "standard",
      provider: "anthropic",
      description: "General agent",
      icon: "🐙",
      model: undefined,
      effort: undefined,
      skills: ["*"],
      systemPrompt: "You are Tako.",
    });
  });
});
