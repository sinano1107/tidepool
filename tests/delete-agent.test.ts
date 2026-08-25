import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { deleteAgent } from "../src/agent-create.js";
import { agentBodyAtCommit, loadRegistry } from "../src/registry.js";
import { DeletionConfirmationRequiredError } from "../src/registry-write.js";
import { makeRegistry } from "./registry-fixture.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

async function makeMainRegistry(): Promise<string> {
  const dir = await makeRegistry();
  git(dir, "branch", "-M", "main");
  return dir;
}

/** 参照ゼロ・既定でもない盤面の事実 —— 拒否の門を跨がない既定の refs。 */
const NO_REFERENCES = { unsettledTaskCount: 0 };

describe("deleteAgent: 正常系(issue #205 / ADR 0087 決定1)", () => {
  it("agents/<name>.md を committed main から除去するコミットが着地し、loadRegistry から消える", async () => {
    const registryDir = await makeMainRegistry();

    await deleteAgent(
      { name: "deckhand", confirm: true },
      { registry: { dir: registryDir, mode: "purely-local" }, ...NO_REFERENCES },
    );

    expect(loadRegistry(registryDir, "purely-local").agents.deckhand).toBeUndefined();
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe("delete agent deckhand via WebUI");
  });
});

describe("deleteAgent: 確認の門(issue #205 / ADR 0087)", () => {
  it("confirm なしの削除要求は拒まれ、エントリは残る", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      deleteAgent(
        { name: "deckhand" },
        { registry: { dir: registryDir, mode: "purely-local" }, ...NO_REFERENCES },
      ),
    ).rejects.toThrow(DeletionConfirmationRequiredError);

    expect(loadRegistry(registryDir, "purely-local").agents.deckhand).toBeDefined();
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("deleteAgent: 確認で買えない拒否(ADR 0087 決定2/3)", () => {
  it("未決着タスクが assignee として参照していると confirm があっても消せず、件数が理由に載る", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      deleteAgent(
        { name: "deckhand", confirm: true },
        { registry: { dir: registryDir, mode: "purely-local" }, unsettledTaskCount: 2 },
      ),
    ).rejects.toMatchObject({
      name: "DeletionBlockedError",
      reasons: [{ code: "unsettled_tasks", count: 2 }],
    });

    expect(loadRegistry(registryDir, "purely-local").agents.deckhand).toBeDefined();
  });

  it("盤面の既定 agent は confirm があっても消せない", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      deleteAgent(
        { name: "deckhand", confirm: true },
        {
          registry: { dir: registryDir, mode: "purely-local" },
          ...NO_REFERENCES,
          defaultAgentName: "deckhand",
        },
      ),
    ).rejects.toMatchObject({
      name: "DeletionBlockedError",
      reasons: [{ code: "board_default" }],
    });
  });

  it("盤面の Auditor は confirm があっても消せない(ADR 0087 決定3 訂正 / issue #376)", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      deleteAgent(
        { name: "deckhand", confirm: true },
        {
          registry: { dir: registryDir, mode: "purely-local" },
          ...NO_REFERENCES,
          auditorName: "deckhand",
        },
      ),
    ).rejects.toMatchObject({
      name: "DeletionBlockedError",
      reasons: [{ code: "board_auditor" }],
    });
  });

  it("既定 agent と Auditor が同名のときは両方の理由が積まれる(issue #376)", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      deleteAgent(
        { name: "deckhand", confirm: true },
        {
          registry: { dir: registryDir, mode: "purely-local" },
          ...NO_REFERENCES,
          defaultAgentName: "deckhand",
          auditorName: "deckhand",
        },
      ),
    ).rejects.toMatchObject({
      name: "DeletionBlockedError",
      reasons: [{ code: "board_default" }, { code: "board_auditor" }],
    });
  });

  it("profile の assignable_to に列挙されているだけの agent は消せる(ADR 0087 決定2)", async () => {
    const registryDir = await makeRegistry({
      "authority/standard.yaml":
        "guidance: pointed at by nobody's authority\nassignable_to:\n  - deckhand\nallowed_workspaces: []\nmerge: escalate\n",
      // standard を authority に持つ agent が居ると参照で弾かれるので、fixture の
      // deckhand は別 profile を指す
      "authority/solo.yaml": "guidance: solo\nassignable_to: []\nallowed_workspaces: []\nmerge: escalate\n",
      "agents/deckhand.md":
        '---\nversion: "1"\nauthority: solo\ndescription: General work agent\nprovider: anthropic\nskills: []\n---\nYou are Deckhand.\n',
    });
    git(registryDir, "branch", "-M", "main");

    await deleteAgent(
      { name: "deckhand", confirm: true },
      { registry: { dir: registryDir, mode: "purely-local" }, ...NO_REFERENCES },
    );

    expect(loadRegistry(registryDir, "purely-local").agents.deckhand).toBeUndefined();
    // 掃除は不要 —— 許可先が1つ消えるだけで無害である
    expect(loadRegistry(registryDir, "purely-local").authority.standard?.assignable_to).toEqual([
      "deckhand",
    ]);
  });
});

describe("deleteAgent: 記録は git が保つ(ADR 0087 決定1)", () => {
  it("削除後も、削除前のコミットを指定した agent 本文の読み出しは通る", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await deleteAgent(
      { name: "deckhand", confirm: true },
      { registry: { dir: registryDir, mode: "purely-local" }, ...NO_REFERENCES },
    );

    // 過去タスクの自己 RCA が読む経路(ADR 0020 / claude-worker.ts)
    expect(agentBodyAtCommit(registryDir, before, "deckhand")).toContain("You are Deckhand");
    expect(agentBodyAtCommit(registryDir, "HEAD", "deckhand")).toBeUndefined();
  });
});
