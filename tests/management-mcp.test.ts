import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { InvalidAllowedDomainError, InvalidWorkspaceNameError } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import { RepoAccessMissingError } from "../src/repo-access.js";
import { registerTask } from "../src/tasks.js";
import {
  BoardStateOverlapError,
  GitHubIdentityMissingError,
  type PublishWorkspaceInput,
  type UpdateWorkspaceInput,
  WorkspaceAlreadyPublishedError,
  WorkspaceConfirmationRequiredError,
} from "../src/workspace-create.js";
import { FakeDraftClient } from "./fakes.js";
import {
  api,
  bootTidepool,
  managementMcpClient,
  registerQuestion,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const readToolNames = [
  "get_task",
  "list_board",
  "list_queue",
  "list_your_tasks",
  "read_decision_log",
];

function readToolPayload(result: any): unknown {
  return JSON.parse(result.content[0].text);
}

function dumpDb(dbPath: string): unknown {
  const db = openDb(dbPath);
  try {
    const snapshot: Record<string, unknown> = {};
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>) {
      snapshot[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    }
    return snapshot;
  } finally {
    db.close();
  }
}

it("管理MCP 自身は無認証リクエストを 401 で拒否する(issue #191 / ADR 0036)", async () => {
  t = await bootTidepool();
  const res = await fetch(`${t.baseUrl}/admin-mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(401);
});

it("管理MCP の initialize は人間面の義手モデル instructions を返す(issue #191)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    expect(client.getInstructions()).toContain("You are connected to the Management MCP");
    expect(client.getInstructions()).toContain("question task, which only a human may");
  } finally {
    await client.close();
  }
});

it("update_workspace は review_allowed_commands を受け取り、確認要求は理由コードごと tool error になる(issue #264)", async () => {
  const calls: UpdateWorkspaceInput[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      update: async (input) => {
        calls.push(input);
        if (input.confirm !== true) {
          throw new WorkspaceConfirmationRequiredError(input.name, ["review_allowed_commands_set"]);
        }
      },
    },
  });
  const client = await managementMcpClient(t.baseUrl);
  try {
    const confirmed: any = await client.callTool({
      name: "update_workspace",
      arguments: { name: "lagoon", review_allowed_commands: ["npm test"], confirm: true },
    });
    expect(confirmed.isError).toBeFalsy();
    expect(calls).toEqual([
      { name: "lagoon", review_allowed_commands: ["npm test"], confirm: true },
    ]);

    const unconfirmed: any = await client.callTool({
      name: "update_workspace",
      arguments: { name: "lagoon", review_allowed_commands: ["npm test"] },
    });
    expect(unconfirmed.isError).toBe(true);
    expect(unconfirmed.content[0].text).toContain("review_allowed_commands_set");
  } finally {
    await client.close();
  }
});

it("update_workspace は allowed_domains を confirm ごと人間面へ渡す(issue #321)", async () => {
  const calls: UpdateWorkspaceInput[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "update_workspace",
      arguments: {
        name: "lagoon",
        allowed_domains: ["registry.npmjs.org"],
        confirm: true,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      { name: "lagoon", allowed_domains: ["registry.npmjs.org"], confirm: true },
    ]);
  } finally {
    await client.close();
  }
});

it("update_workspace の不正 allowed_domains は registry 文法エラーとして返す(issue #321)", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      update: async () => {
        throw new InvalidAllowedDomainError("100.100.100.100", "IP literals are not allowed");
      },
    },
  });
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "update_workspace",
      arguments: {
        name: "lagoon",
        allowed_domains: ["100.100.100.100"],
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'invalid allowed_domains entry "100.100.100.100": IP literals are not allowed',
    );
  } finally {
    await client.close();
  }
});

// ADR 0066 決定8 / issue #285: 扉は3枚すべて —— workspace 系の動詞だけを
// 非対称にする根拠がない(義手モデルの下では帰属はどちらも人間である)。
it("publish_workspace は宛先ごとオーケストレーションへ渡り、拒否は tool error になる", async () => {
  const published = vi.fn(async (input: PublishWorkspaceInput) => {
    if (input.repo === "https://github.com/sinano1107/taken.git") {
      throw new WorkspaceAlreadyPublishedError(input.name, input.repo);
    }
    return [];
  });
  t = await bootTidepool({ workspaceAdmin: { publish: published } });
  const client = await managementMcpClient(t.baseUrl);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["publish_workspace"]));

    const ok: any = await client.callTool({
      name: "publish_workspace",
      arguments: { name: "sandbox", repo: "https://github.com/sinano1107/sandbox.git" },
    });
    expect(ok.isError ?? false).toBe(false);
    expect(published).toHaveBeenCalledWith({
      name: "sandbox",
      repo: "https://github.com/sinano1107/sandbox.git",
    });

    const refused: any = await client.callTool({
      name: "publish_workspace",
      arguments: { name: "sandbox", repo: "https://github.com/sinano1107/taken.git" },
    });
    expect(refused.isError).toBe(true);
    // 拒否は呼び出し側の状態の問題であって盤面の故障ではない —— 「registry upstream
    // error」に混ぜず、案内そのものを読ませる(create の扉と同じ族分け)
    expect(refused.content[0].text).toBe(
      'workspace "sandbox" already declares a remote source of truth (repo: https://github.com/sinano1107/taken.git)',
    );
  } finally {
    await client.close();
  }
});

// ADR 0068 が直す実害の本体: トリアージ中に list_queue を読んだエージェントに
// 「キューは流れている」と見えていた。MCP にはバナーの補完チャネルが無いので、
// 停止理由は同じ1読みの envelope に載るしかない。
it("list_queue の envelope は盤面全体の停止を1回で答え、行は todo のまま(ADR 0068)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "waits for the triage session to close");
  await api(t.baseUrl, "POST", "/api/triage/start");

  const client = await managementMcpClient(t.baseUrl);
  try {
    const queue: any = readToolPayload(await client.callTool({ name: "list_queue", arguments: {} }));
    expect(queue.halts).toEqual([{ kind: "triage" }]);
    expect(queue.tasks.find((x: any) => x.id === task.id).status).toBe("todo");
  } finally {
    await client.close();
  }
});

it("管理MCP は5つの純読取 board tool を発見する(issue #191)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const { tools } = await client.listTools();
    expect(tools.filter((tool) => readToolNames.includes(tool.name)).map((tool) => tool.name).sort()).toEqual(
      readToolNames,
    );
  } finally {
    await client.close();
  }
});

it("workspaceAdmin の create / list / update を管理MCP から利用できる(issue #193)", async () => {
  const created = vi.fn(async () => "/mnt/workspaces/harbor");
  const updated = vi.fn(async () => {});
  t = await bootTidepool({
    workspaceAdmin: {
      create: created,
      list: () => ({
        workspaces: [
          { name: "tidepool", path: "/work/tidepool", repo: "owner/tidepool", branch: "main", registrySelf: false },
        ],
        workspacesBaseDir: { path: "/mnt/workspaces", source: "configured" as const },
      }),
      update: updated,
    },
  });
  const client = await managementMcpClient(t.baseUrl);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["create_workspace", "list_workspaces", "update_workspace"]),
    );

    const create: any = await client.callTool({
      name: "create_workspace",
      arguments: { name: "harbor", mode: "register", path: "/work/harbor" },
    });
    expect(create.isError ?? false).toBe(false);
    // ADR 0082 決定1: MCP は「見せてから決める」形を持てない —— 着地したパスを
    // 結果で返すことがその代わりである
    expect(readToolPayload(create)).toEqual({ path: "/mnt/workspaces/harbor" });
    expect(created).toHaveBeenCalledWith({
      name: "harbor",
      mode: "register",
      path: "/work/harbor",
    });

    const list: any = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(readToolPayload(list)).toEqual({
      workspaces: [
        { name: "tidepool", path: "/work/tidepool", repo: "owner/tidepool", branch: "main", registrySelf: false },
      ],
      workspacesBaseDir: { path: "/mnt/workspaces", source: "configured" },
    });

    const update: any = await client.callTool({
      name: "update_workspace",
      arguments: { name: "tidepool", notes: "production board", protected: true },
    });
    expect(update.isError ?? false).toBe(false);
    expect(readToolPayload(update)).toEqual({});
    expect(updated).toHaveBeenCalledWith({ name: "tidepool", notes: "production board", protected: true });
  } finally {
    await client.close();
  }
});

it("agentAdmin と profileAdmin の操作を管理MCP から利用できる(issue #193)", async () => {
  const createAgent = vi.fn(async () => {});
  const updateAgent = vi.fn(async () => {});
  const createProfile = vi.fn(async () => {});
  const updateProfile = vi.fn(async () => {});
  t = await bootTidepool({
    agentAdmin: {
      create: createAgent,
      list: () => [],
      update: updateAgent,
      authorityProfiles: () => ["standard"],
    },
    profileAdmin: { create: createProfile, list: () => [], update: updateProfile },
  });
  const client = await managementMcpClient(t.baseUrl);
  const agent = {
    name: "navigator",
    authority: "standard",
    description: "plans navigational work",
    skills: ["@workspace"],
    system_prompt: "Follow the charts.",
  };
  const { system_prompt, ...agentFields } = agent;
  const profile = {
    name: "cautious",
    guidance: "Ask before broad changes.",
    assignable_to: ["navigator"],
    allowed_workspaces: ["tidepool"],
    merge: "escalate",
  };
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "create_agent",
        "list_agents",
        "update_agent",
        "create_profile",
        "list_profiles",
        "update_profile",
      ]),
    );

    expect(readToolPayload(await client.callTool({ name: "create_agent", arguments: agent }))).toEqual({});
    expect(createAgent).toHaveBeenCalledWith({ ...agentFields, systemPrompt: system_prompt });
    expect(readToolPayload(await client.callTool({ name: "list_agents", arguments: {} }))).toEqual({
      agents: [],
      authority_profiles: ["standard"],
    });
    expect(readToolPayload(await client.callTool({ name: "update_agent", arguments: agent }))).toEqual({});
    expect(updateAgent).toHaveBeenCalledWith({ ...agentFields, systemPrompt: system_prompt });

    expect(readToolPayload(await client.callTool({ name: "create_profile", arguments: profile }))).toEqual({});
    expect(createProfile).toHaveBeenCalledWith(profile);
    expect(readToolPayload(await client.callTool({ name: "list_profiles", arguments: {} }))).toEqual({ profiles: [] });
    expect(readToolPayload(await client.callTool({ name: "update_profile", arguments: profile }))).toEqual({});
    expect(updateProfile).toHaveBeenCalledWith(profile);
  } finally {
    await client.close();
  }
});

it("管理MCP は人間の明示確認なしに危険な profile を保存しない(issue #193)", async () => {
  const create = vi.fn(async () => {});
  t = await bootTidepool({ profileAdmin: { create } });
  const client = await managementMcpClient(t.baseUrl);
  const dangerous = {
    name: "unrestricted",
    guidance: "operate broadly",
    assignable_to: ["*"],
    allowed_workspaces: ["tidepool"],
    merge: "escalate",
  };
  try {
    const denied: any = await client.callTool({ name: "create_profile", arguments: dangerous });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("human confirmation is required");
    expect(create).not.toHaveBeenCalled();

    const confirmed: any = await client.callTool({
      name: "create_profile",
      arguments: { ...dangerous, confirm_dangerous: true },
    });
    expect(confirmed.isError ?? false).toBe(false);
    expect(create).toHaveBeenCalledWith(dangerous);

    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "create_profile")?.description).toContain("human's explicit confirmation");
    expect((tools.find((tool) => tool.name === "create_profile") as any).inputSchema.properties.confirm_dangerous.default).toBe(
      false,
    );
  } finally {
    await client.close();
  }
});

it("管理MCP はWebUIと同じregistry失敗をtool errorへ変換する(issue #193)", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      create: async (input) => {
        if (input.name === "push-failed") throw new RegistryPushFailedError("non-fast-forward");
        if (input.name === "invalid") throw new InvalidWorkspaceNameError(input.name, "bad characters");
        if (input.name === "overlap") throw new BoardStateOverlapError("workspace overlaps board state");
        if (input.name === "missing-identity") throw new GitHubIdentityMissingError();
        if (input.name === "no-repo-access") throw new RepoAccessMissingError("grant it with: gh api -X PUT ...");
        throw new Error("registry remote unavailable");
      },
      update: async () => {
        throw new WorkspaceConfirmationRequiredError("production", ["unprotect"]);
      },
      list: () => {
        throw new Error("registry read failed");
      },
    },
    agentAdmin: {
      list: () => {
        throw new Error("registry read failed");
      },
    },
    profileAdmin: {
      list: () => {
        throw new Error("registry read failed");
      },
    },
  });
  const client = await managementMcpClient(t.baseUrl);
  try {
    // registry の push 失敗(ADR 0052 決定1)は他の「registry upstream error」と
    // 同じ扱いに畳む — busy という状態自体が worktree 化で消えた(issue #210)
    const pushFailed: any = await client.callTool({
      name: "create_workspace",
      arguments: { name: "push-failed", mode: "register", path: "/work/harbor" },
    });
    expect(pushFailed.isError).toBe(true);
    expect(pushFailed.content[0].text).toContain("registry upstream error");

    const invalid: any = await client.callTool({
      name: "create_workspace",
      arguments: { name: "invalid", mode: "register", path: "/work/invalid" },
    });
    expect(invalid.content[0].text).toContain('invalid workspace name "invalid"');

    const overlap: any = await client.callTool({
      name: "create_workspace",
      arguments: { name: "overlap", mode: "register", path: "/work/overlap" },
    });
    expect(overlap.content[0].text).toContain("workspace overlaps board state");

    const missingIdentity: any = await client.callTool({
      name: "create_workspace",
      arguments: { name: "missing-identity", mode: "register", path: "/work/missing-identity" },
    });
    expect(missingIdentity.content[0].text).toContain("registry configuration missing");

    // ADR 0067: repo アクセス不足の案内は、盤面の故障(registry upstream error)に
    // 畳まれずそのまま届く —— 人間が読んで実行する一行だからである
    const noRepoAccess: any = await client.callTool({
      name: "create_workspace",
      arguments: { name: "no-repo-access", mode: "register", path: "/work/no-repo-access" },
    });
    expect(noRepoAccess.content[0].text).toContain("gh api -X PUT");

    const upstream: any = await client.callTool({
      name: "create_workspace",
      arguments: { name: "upstream", mode: "register", path: "/work/upstream" },
    });
    expect(upstream.content[0].text).toContain("registry upstream error");

    const protectedWorkspace: any = await client.callTool({
      name: "update_workspace",
      arguments: { name: "production", protected: false },
    });
    expect(protectedWorkspace.isError).toBe(true);
    expect(protectedWorkspace.content[0].text).toContain("unprotect");

    for (const name of ["list_workspaces", "list_agents", "list_profiles"]) {
      const result: any = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("registry upstream error");
    }
  } finally {
    await client.close();
  }
});

it("管理MCP の読取 tool は盤面データを返して DB を変えない(issue #191)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "management MCP read fixture");
  const client = await managementMcpClient(t.baseUrl);
  try {
    const before = dumpDb(join(t.dir, "board.sqlite"));
    const { tools } = await client.listTools();
    const results = await Promise.all(
      tools.filter((tool) => readToolNames.includes(tool.name)).map((tool) =>
        client.callTool({
          name: tool.name,
          arguments: tool.name === "get_task" ? { task_id: task.id } : {},
        }),
      ),
    );
    const after = dumpDb(join(t.dir, "board.sqlite"));

    expect(after).toEqual(before);
    const resultByName = new Map(tools.map((tool, index) => [tool.name, results[index]]));
    expect(readToolPayload(resultByName.get("list_board"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: task.id, title: task.title })]),
    );
    expect(readToolPayload(resultByName.get("get_task"))).toEqual(
      expect.objectContaining({ id: task.id, events: expect.any(Array) }),
    );
    expect(readToolPayload(resultByName.get("read_decision_log"))).toEqual(
      expect.objectContaining({ entries: expect.any(Array), cursor: expect.any(Number) }),
    );
  } finally {
    await client.close();
  }
});

it("管理MCP は issue-backed content を保存済みプレースホルダーのまま返す(issue #191)", async () => {
  t = await bootTidepool();
  const db = openDb(join(t.dir, "board.sqlite"));
  let issueTask;
  try {
    issueTask = registerTask(
      db,
      { type: "work", workspace: "tidepool", github_issue_number: 49 },
      t.clock.now(),
    );
  } finally {
    db.close();
  }
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({ name: "list_board", arguments: {} });
    expect(readToolPayload(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: issueTask.id,
          title: "#49",
          github_issue_number: 49,
        }),
      ]),
    );
  } finally {
    await client.close();
  }
});

it("register_task は人間名義かつ mcp origin で work task を登録する(issue #192)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "register_task",
      arguments: {
        type: "work",
        title: "index the tide charts",
        purpose: "make historical tides searchable",
        completion_criteria: "a query returns chart rows",
      },
    });

    expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
    const task = readToolPayload(result) as { id: string };
    const events = (await client.callTool({ name: "get_task", arguments: { task_id: task.id } })) as any;
    expect(readToolPayload(events)).toEqual(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ kind: "task_registered", worker_id: "human", origin: "mcp" }),
        ]),
      }),
    );
  } finally {
    await client.close();
  }
});

it("answer_question は人間名義かつ mcp origin で question を回答する(issue #192)", async () => {
  t = await bootTidepool();
  const question = registerQuestion(t, {
    title: "which tide gauge?",
    purpose: "choose the data source",
    completion_criteria: "one source is selected",
    question: [{ title: "source", options: ["NOAA", "JMA"], recommendation: "JMA" }],
  });
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "answer_question",
      arguments: { task_id: question.id, answers: ["JMA"] },
    });

    expect(result.isError ?? false).toBe(false);
    expect(readToolPayload(result)).toEqual(expect.objectContaining({ id: question.id, status: "done" }));
    const events = (await client.callTool({ name: "get_task", arguments: { task_id: question.id } })) as any;
    expect(readToolPayload(events)).toEqual(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ kind: "question_answered", worker_id: "human", origin: "mcp" }),
        ]),
      }),
    );
  } finally {
    await client.close();
  }
});

it("cancel_task は人間名義かつ mcp origin で human task を cancel する(issue #192)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "retire the old tide gauge");
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "cancel_task",
      arguments: { task_id: task.id, reason: "the upstream data source closed" },
    });

    expect(result.isError ?? false).toBe(false);
    expect(readToolPayload(result)).toEqual(expect.objectContaining({ id: task.id, status: "cancelled" }));
    const events = (await client.callTool({ name: "get_task", arguments: { task_id: task.id } })) as any;
    expect(readToolPayload(events)).toEqual(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ kind: "task_cancelled_directly", worker_id: "human", origin: "mcp" }),
        ]),
      }),
    );
  } finally {
    await client.close();
  }
});

it("edit_task は人間名義かつ mcp origin で未消費フィールドを更新する(issue #192)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index tide charts");
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "edit_task",
      arguments: { task_id: task.id, title: "index historic tide charts" },
    });

    expect(result.isError ?? false).toBe(false);
    expect(readToolPayload(result)).toEqual(
      expect.objectContaining({ id: task.id, title: "index historic tide charts" }),
    );
    const events = (await client.callTool({ name: "get_task", arguments: { task_id: task.id } })) as any;
    expect(readToolPayload(events)).toEqual(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ kind: "task_edited", worker_id: "human", origin: "mcp" }),
        ]),
      }),
    );
  } finally {
    await client.close();
  }
});

it("decompose_task は人間名義かつ mcp origin で子を一括登録する(issue #192)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "modernize tide data");
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "decompose_task",
      arguments: {
        task_id: parent.id,
        reason: "the migration has two independently deployable parts",
        children: [
          {
            title: "import observations",
            purpose: "bring historic measurements into the new store",
            completion_criteria: "one month of data is queryable",
          },
          {
            title: "migrate query endpoint",
            purpose: "serve the imported observations",
            completion_criteria: "the endpoint returns the new records",
          },
        ],
      },
    });

    expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
    const payload = readToolPayload(result) as { child_ids: string[]; parent_status: string };
    expect(payload.child_ids).toHaveLength(2);
    expect(payload.parent_status).toBe("blocked");
    const child = (await client.callTool({ name: "get_task", arguments: { task_id: payload.child_ids[0] } })) as any;
    expect(readToolPayload(child)).toEqual(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ kind: "task_registered", worker_id: "human", origin: "mcp" }),
        ]),
      }),
    );
  } finally {
    await client.close();
  }
});

it("decompose_task は空の reason を protocol error ではなく domain tool error で拒否する(issue #192)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "modernize tide data");
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "decompose_task",
      arguments: {
        task_id: parent.id,
        reason: "",
        children: [{ title: "import observations", purpose: "import data", completion_criteria: "data is queryable" }],
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("a decomposition requires a reason");
  } finally {
    await client.close();
  }
});

it("register_task は空の content を protocol error ではなく domain tool error で拒否する(issue #192)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "register_task",
      arguments: {
        type: "work",
        title: "",
        purpose: "make historical tides searchable",
        completion_criteria: "a query returns chart rows",
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual(
      expect.objectContaining({
        kind: "invalid",
        error: "a task requires title, purpose, and completion_criteria unless it is issue-backed",
      }),
    );
  } finally {
    await client.close();
  }
});

it("complete_task は human assignee の task だけを mcp origin で完了する(issue #192)", async () => {
  t = await bootTidepool();
  const humanTask = await registerWork(t, "confirm the tide gauge licence", undefined, undefined, "human");
  const db = openDb(join(t.dir, "board.sqlite"));
  let agentTask!: ReturnType<typeof registerTask>;
  try {
    agentTask = registerTask(
      db,
      {
        type: "work",
        title: "agent-owned task",
        purpose: "exercise the completion gate",
        completion_criteria: "the management MCP refuses it",
        assignee: "fake-worker",
      },
      t.clock.now(),
      "fake-worker",
    );
  } finally {
    db.close();
  }
  const client = await managementMcpClient(t.baseUrl);
  try {
    const done: any = await client.callTool({ name: "complete_task", arguments: { task_id: humanTask.id } });
    expect(done.isError ?? false).toBe(false);
    expect(readToolPayload(done)).toEqual(expect.objectContaining({ id: humanTask.id, status: "done" }));

    const rejected: any = await client.callTool({ name: "complete_task", arguments: { task_id: agentTask.id } });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("only a human-assignee task can be completed here");

    const events = (await client.callTool({ name: "get_task", arguments: { task_id: humanTask.id } })) as any;
    expect(readToolPayload(events)).toEqual(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ kind: "task_completed", worker_id: "human", origin: "mcp" }),
        ]),
      }),
    );
  } finally {
    await client.close();
  }
});

it("add_issue_comment は解決した workspace の GitHub issue にコメントを追記する(issue #192)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "add_issue_comment",
      arguments: {
        workspace: "tidepool",
        github_issue_number: 192,
        body: "## Completion criteria\n- the management API accepts task writes",
      },
    });

    expect(result.isError ?? false).toBe(false);
    expect(t.github.issueComments).toEqual([
      {
        ref: { path: "/fake/path", number: 192 },
        body: "## Completion criteria\n- the management API accepts task writes",
      },
    ]);
  } finally {
    await client.close();
  }
});

it("register_task は LLM 登録ゲートの suggested_comment を tool error に含める(issue #192)", async () => {
  const draftClient = new FakeDraftClient();
  draftClient.scriptInspection({
    ok: false,
    missing: "completion criteria are absent",
    suggested_comment: "## Completion criteria\n- the tide charts are searchable",
  });
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" }, draftClient });
  t.github.scriptIssue(192, { title: "vague tide work", body: "improve it", comments: [] });
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "register_task",
      arguments: { type: "work", workspace: "tidepool", github_issue_number: 192 },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual(
      expect.objectContaining({
        kind: "issue_rejected",
        suggested_comment: "## Completion criteria\n- the tide charts are searchable",
      }),
    );
  } finally {
    await client.close();
  }
});

it("cancel_task は open failure question を迂回できない(issue #192)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "failed tide migration");
  registerQuestion(t, {
    title: "failure",
    purpose: "the migration failed",
    completion_criteria: "a human answers",
    parent_id: task.id,
    question: [{ title: "retry or abandon?", options: ["retry", "abandon"], recommendation: "retry" }],
    cancel_option: "abandon",
  });
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({ name: "cancel_task", arguments: { task_id: task.id } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("open failure question");
  } finally {
    await client.close();
  }
});

it("register_task は同じ issue reference の未決着二重登録を拒否する(issue #192)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });
  t.github.scriptIssue(192, { title: "tide task", body: "do it", comments: [] });
  const client = await managementMcpClient(t.baseUrl);
  const input = { type: "work", workspace: "tidepool", github_issue_number: 192 };
  try {
    const first: any = await client.callTool({ name: "register_task", arguments: input });
    expect(first.isError ?? false).toBe(false);
    const duplicate: any = await client.callTool({ name: "register_task", arguments: input });
    expect(duplicate.isError).toBe(true);
    expect(JSON.parse(duplicate.content[0].text)).toEqual(
      expect.objectContaining({ kind: "invalid", error: expect.stringContaining("already referenced") }),
    );
  } finally {
    await client.close();
  }
});

it("管理MCP の update_profile は部分パッチ(issue #266 / ADR 0086)", async () => {
  const update = vi.fn(async () => {});
  t = await bootTidepool({ profileAdmin: { update } });
  const client = await managementMcpClient(t.baseUrl);
  try {
    // guidance だけのパッチ: 危険判定に現れるフィールドがないので確認は不要
    expect(
      readToolPayload(
        await client.callTool({ name: "update_profile", arguments: { name: "roamer", guidance: "Reworded." } }),
      ),
    ).toEqual({});
    expect(update).toHaveBeenCalledWith({ name: "roamer", guidance: "Reworded." });

    // 危険な値を書いたパッチは confirm_dangerous を要求する
    update.mockClear();
    const denied: any = await client.callTool({
      name: "update_profile",
      arguments: { name: "roamer", merge: "auto_if_ci_green" },
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("merge_auto_if_ci_green");
    expect(update).not.toHaveBeenCalled();

    const confirmed: any = await client.callTool({
      name: "update_profile",
      arguments: { name: "roamer", merge: "auto_if_ci_green", confirm_dangerous: true },
    });
    expect(confirmed.isError ?? false).toBe(false);
    expect(update).toHaveBeenCalledWith({ name: "roamer", merge: "auto_if_ci_green" });

    // 空配列は安全側 — 確認なしで通る
    update.mockClear();
    expect(
      readToolPayload(
        await client.callTool({ name: "update_profile", arguments: { name: "roamer", assignable_to: [] } }),
      ),
    ).toEqual({});
    expect(update).toHaveBeenCalledWith({ name: "roamer", assignable_to: [] });

    // 省略の意味が tool description に書かれている(エージェントはこれだけを読む)
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "update_profile")?.description).toContain("left unchanged");
  } finally {
    await client.close();
  }
});
