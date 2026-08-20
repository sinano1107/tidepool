import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { EventRow } from "../src/events.js";
import { projectEpisode } from "../src/precedent.js";

/** #386 が取った実物の worker session — 2.1.237 の CLI が書いた transcript と、
 *  その session を挟む盤面のイベント。Precedent の投影は決定論的なので、期待値は
 *  この2ファイルを人が読んで書き下した値である(コードから再計算しない)。 */
const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", `worker-session-2.1.237.${name}`), "utf8");
const transcriptLines = () => fixture("stream.jsonl").split("\n");
const fixtureEvents = () => JSON.parse(fixture("events.json")) as EventRow[];

const project = (over: Partial<Parameters<typeof projectEpisode>[0]> = {}) =>
  projectEpisode({
    transcriptLines: transcriptLines(),
    events: fixtureEvents(),
    workerSpawnedEventId: 5,
    extractorVersion: "test",
    ...over,
  });

it("worker session の transcript から、tool 呼び出し1回 = 1行の行動列を組む(ADR 0083 追記)", () => {
  const episode = project();

  expect(episode.actions.map((a) => [a.tool, a.args])).toEqual([
    ["mcp__tidepool__get_current_task", null],
    ["Write", "/srv/tidepool/workspaces/sandbox/notes.md"],
    ["mcp__tidepool__log_decision", null],
    ["Agent", "Count words in notes.md"],
    ["Bash", "wc -w /srv/tidepool/workspaces/sandbox/notes.md"],
    ["mcp__tidepool__log_decision", null],
    ["mcp__tidepool__log_decision", null],
    ["Bash", 'git add notes.md && git commit -m "Add tide pool notes fixture"'],
    ["mcp__tidepool__complete_task", null],
  ]);
  // 行動行は transcript 行への参照だけを持ち、本文は写さない(ADR 0083 追記)
  expect(episode.actions[1]!.transcriptUuid).toBe("4b57d6e1-77c8-4184-a5aa-6d9a00544e69");
});

it("subagent 由来の行動はフラグ付きで同じ列に並び、起動した行には task_notification の消費が合算外で付く(ADR 0083 追記 2)", () => {
  const episode = project();

  const [agentAction, subagentBash] = [episode.actions[3]!, episode.actions[4]!];
  expect(agentAction.subagent).toBe(false);
  expect(subagentBash.subagent).toBe(true);
  expect(episode.actions.filter((a) => a.subagent)).toHaveLength(1);
  // subagent 自身の消費は起動行の観測として添付される(session 合計には足さない)
  expect(agentAction.subagentUsage).toEqual({
    total_tokens: 26998,
    tool_uses: 1,
    duration_ms: 6256,
  });
  expect(subagentBash.subagentUsage).toBeNull();
  // 行動行はトークン欄を持たない — session 単位の消費は worker_exited.usage が正本
  expect(agentAction).not.toHaveProperty("tokens");
  expect(agentAction).not.toHaveProperty("usage");
});

it("失敗ビットは tool_result の is_error === true だけ — 欠落は成功(実測)", () => {
  const episode = project();
  expect(episode.actions.every((a) => a.failed)).toBe(false);
  expect(episode.actions.filter((a) => a.failed)).toEqual([]);
});

it("decision は行動列内の位置を持つマーカーで、結合は tool_result に写った event id の完全一致だけ — 同一文言でも取り違えない(ADR 0083 追記 2)", () => {
  const episode = project();

  // events 6 と 7 は文言が完全に同一で id だけ違う。文言や出現順ではなく
  // event id で結ぶので、それぞれ別の位置に着く
  expect(episode.markers.filter((m) => m.kind === "decision")).toEqual([
    { kind: "decision", position: 2, eventId: 6, missingReason: null, transcriptUuid: "54addb84-f178-4ba2-9325-e39536b05486" },
    { kind: "decision", position: 5, eventId: 7, missingReason: null, transcriptUuid: "dc081d87-500d-47df-a578-3cb7f8126225" },
    { kind: "decision", position: 6, eventId: 8, missingReason: null, transcriptUuid: "23678d55-b253-4ff5-811f-35861a0a6b53" },
  ]);
});

it("「ある decision までの行動」はマーカー位置での読み出し時スライスである(ADR 0083 追記)", () => {
  const episode = project();
  const second = episode.markers.find((m) => m.eventId === 7)!;

  expect(episode.actions.slice(0, second.position!).map((a) => a.tool)).toEqual([
    "mcp__tidepool__get_current_task",
    "Write",
    "mcp__tidepool__log_decision",
    "Agent",
    "Bash",
  ]);
});

it("構造マーカー(advisor 相談・commit)は行動列内の位置に並び、advisor は行動行にはならない(ADR 0083 追記 2 決定5)", () => {
  const episode = project();

  expect(episode.markers.map((m) => [m.kind, m.position])).toEqual([
    ["decision", 2],
    ["advisor", 5],
    ["decision", 5],
    ["decision", 6],
    ["commit", 8],
  ]);
  // advisor 相談はマーカーだけ — 結果は暗号化されていて抽出するものが無い
  expect(episode.actions.map((a) => a.tool)).not.toContain("advisor");
});

it("compaction 境界はマーカーになる(綴りは想定 — 実物が未観測でも黙って壊れない)", () => {
  const episode = project({
    events: fixtureEvents().filter((e) => e.id === 5),
    transcriptLines: [
      '{"type":"system","subtype":"init","claude_code_version":"2.1.237"}',
      '{"type":"assistant","uuid":"u1","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"system","subtype":"compact_boundary","uuid":"u2"}',
      '{"type":"assistant","uuid":"u3","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"pwd"}}]}}',
    ],
  });

  expect(episode.markers).toEqual([
    { kind: "compaction", position: 1, eventId: null, missingReason: null, transcriptUuid: "u2" },
  ]);
});

it("event id を写していない transcript の decision は no_event_id、写っているのに合わない decision は unmatched のマーカーとして残る(空にならない)", () => {
  const events = fixtureEvents();
  const noIds = project({
    // スライス A(#384)より前の盤面の応答形 — event id が写っていない
    transcriptLines: [
      '{"type":"assistant","uuid":"u1","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__tidepool__log_decision","input":{"line":"x"}}]}}',
      '{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"{\\"logged\\":true}"}]}]}}',
    ],
    events,
  });
  expect(noIds.markers.map((m) => [m.eventId, m.position, m.missingReason])).toEqual([
    [6, null, "no_event_id"],
    [7, null, "no_event_id"],
    [8, null, "no_event_id"],
  ]);

  // id は写っているが、この session の decision の id ではない
  const unmatched = project({
    transcriptLines: [
      '{"type":"assistant","uuid":"u1","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__tidepool__log_decision","input":{"line":"x"}}]}}',
      '{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"{\\"logged\\":true,\\"event_id\\":6}"}]}]}}',
    ],
    events,
  });
  expect(unmatched.markers.map((m) => [m.eventId, m.position, m.missingReason])).toEqual([
    [6, 0, null],
    [7, null, "unmatched"],
    [8, null, "unmatched"],
  ]);
});

it("同じタスクの別 worker session の decision は、この Episode のマーカーにならない(issue #379: 1タスクに複数 session)", () => {
  const task = "6b4c0b23-289e-4f9f-ade1-995fb27f3c0e";
  const at = "2026-08-20T06:30:00.000Z";
  const events: EventRow[] = [
    ...fixtureEvents(),
    // 2本目の session — retry / 統合復帰 / quarantine 復帰のいずれでも同じ形
    {
      id: 12, task_id: task, worker_id: "tako", origin: "board", kind: "worker_spawned",
      payload: { kind: "worker_spawned", registry_commit: "abc", definition_version: "0.1.1", advisor: null },
      created_at: at,
    },
    {
      id: 13, task_id: task, worker_id: "tako", origin: "worker", kind: "decision_logged",
      payload: { kind: "decision_logged", line: "2本目の session の判断" }, created_at: at,
    },
  ];

  // 1本目の Episode は 6/7/8 だけを見る — 13 は窓の外(worker_exited より後)
  expect(project({ events }).markers.filter((m) => m.kind === "decision").map((m) => m.eventId))
    .toEqual([6, 7, 8]);
  // 2本目の Episode は 13 だけを見る
  expect(
    project({ events, workerSpawnedEventId: 12, transcriptLines: [] }).markers.map((m) => [
      m.eventId,
      m.missingReason,
    ]),
  ).toEqual([[13, "no_event_id"]]);
});

it("Episode は3つの版(registry_commit / 投影器 / transcript を書いた CLI)を刻む(ADR 0083 追記 2 決定7)", () => {
  const episode = project();

  expect(episode.registryCommit).toBe("85c5bbb987ce03e6bce0b46f64ac6c511e3e69e2");
  expect(episode.definitionVersion).toBe("0.1.1");
  expect(episode.extractorVersion).toBe("test");
  expect(episode.claudeCodeVersion).toBe("2.1.237");
  // init 行の無い transcript は「観測できなかった」— 推測しない
  expect(project({ transcriptLines: [] }).claudeCodeVersion).toBeNull();
});

it("session 単位の outcome は完了・exit・消費の正本への参照で、トークンは写さない(ADR 0083 追記 2)", () => {
  const episode = project();

  expect(episode.taskId).toBe("6b4c0b23-289e-4f9f-ade1-995fb27f3c0e");
  expect(episode.completed).toEqual({
    result:
      "Created notes.md with 3 bullets on tide pools; logged 3 decisions (2 identical); used 1 subagent and 1 advisor consult.",
    handoffPresent: true,
  });
  expect(episode.exitCode).toBe(0);
  expect(episode.signal).toBeNull();
  // 消費そのものではなく、正本(worker_exited.usage)への参照を持つ
  expect(episode.workerExitedEventId).toBe(11);
  expect(episode).not.toHaveProperty("usage");
});

it("欠測統計は3値 — 解釈した / 既知だが解釈しない / 未知(ADR 0083 追記 2 決定6)", () => {
  const episode = project();

  // 35 行。rate_limit_event 1 + thinking_tokens 2 + task_started/progress/updated 3 = 6 が
  // 「知っていて捨てる」行で、残り 29 行を解釈する。未知は無い
  expect(episode.lines).toEqual({
    total: 35,
    interpreted: 29,
    ignored: 6,
    unknown: 0,
    unknownKinds: {},
  });
  expect(episode.unrecognizedFormat).toBe(false);
});

it("未知の行だけの transcript は tool 呼び出し 0 件 + unrecognized_format になる(黙って空にならない)", () => {
  const episode = project({
    events: fixtureEvents().filter((e) => e.id === 5),
    transcriptLines: [
      '{"type":"quantum_flux","subtype":"entangled"}',
      '{"type":"quantum_flux","subtype":"entangled"}',
      '{"type":"telepathy"}',
      "{ not json",
    ],
  });

  expect(episode.actions).toEqual([]);
  expect(episode.unrecognizedFormat).toBe(true);
  expect(episode.lines).toEqual({
    total: 4,
    interpreted: 0,
    ignored: 0,
    unknown: 4,
    unknownKinds: { "quantum_flux/entangled": 2, telepathy: 1, unparseable: 1 },
  });
});

it("worker_exited が無いまま終わった session の窓は、次の worker_spawned で閉じる(backfill 経路)", () => {
  const task = "6b4c0b23-289e-4f9f-ade1-995fb27f3c0e";
  const at = "2026-08-20T06:30:00.000Z";
  // 盤面が落ちて exit を書けなかった session — worker_exited だけを落とす
  const events: EventRow[] = [
    ...fixtureEvents().filter((e) => e.kind !== "worker_exited"),
    {
      id: 12, task_id: task, worker_id: "tako", origin: "board", kind: "worker_spawned",
      payload: { kind: "worker_spawned", registry_commit: "abc", definition_version: "0.1.1", advisor: null },
      created_at: at,
    },
    {
      id: 13, task_id: task, worker_id: "tako", origin: "worker", kind: "decision_logged",
      payload: { kind: "decision_logged", line: "2本目の session の判断" }, created_at: at,
    },
  ];

  const episode = project({ events });
  // 13 は次の session のもの — 窓を開けっぱなしにすると unmatched として湧く
  expect(episode.markers.filter((m) => m.kind === "decision").map((m) => m.eventId)).toEqual([6, 7, 8]);
  expect(episode.workerExitedEventId).toBeNull();
});
