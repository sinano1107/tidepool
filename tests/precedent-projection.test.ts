import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { EventRow } from "../src/events.js";
import { entriesReadBefore, entriesSeenBefore, projectEpisode, skillsFollowed } from "../src/precedent.js";
import { QUIET_EXIT, skillCall, toolCall, WORKER_SPAWNED } from "./harness.js";

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
  expect(episode.actions[1]!.transcriptRef).toBe("4b57d6e1-77c8-4184-a5aa-6d9a00544e69");
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
    { kind: "decision", position: 2, eventId: 6, missingReason: null, transcriptRef: "54addb84-f178-4ba2-9325-e39536b05486" },
    { kind: "decision", position: 5, eventId: 7, missingReason: null, transcriptRef: "dc081d87-500d-47df-a578-3cb7f8126225" },
    { kind: "decision", position: 6, eventId: 8, missingReason: null, transcriptRef: "23678d55-b253-4ff5-811f-35861a0a6b53" },
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

it("advisor マーカーは助言が返った結果の行に置き、失敗した呼び出しには置かない(ADR 0214)", () => {
  const call = (id: string, uuid: string) =>
    `{"type":"assistant","uuid":"${uuid}","message":{"content":[{"type":"server_tool_use","id":"${id}","name":"advisor","input":{}}]}}`;
  const result = (id: string, uuid: string, content: string) =>
    `{"type":"assistant","uuid":"${uuid}","message":{"content":[{"type":"advisor_tool_result","tool_use_id":"${id}","content":${content}}]}}`;
  const episode = project({
    events: fixtureEvents().filter((e) => e.id === 5),
    transcriptLines: [
      '{"type":"system","subtype":"init","claude_code_version":"2.1.237"}',
      call("s1", "u1"),
      result("s1", "u2", '{"type":"advisor_tool_result_error","error_code":"too_many_requests"}'),
      '{"type":"assistant","uuid":"u3","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}',
      call("s2", "u4"),
      result("s2", "u5", '{"type":"advisor_redacted_result","encrypted_content":"x"}'),
    ],
  });

  expect(episode.markers).toEqual([
    { kind: "advisor", position: 1, eventId: null, missingReason: null, transcriptRef: "u5" },
  ]);
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
    { kind: "compaction", position: 1, eventId: null, missingReason: null, transcriptRef: "u2" },
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
      id: 12, task_id: task, actor_id: "tako", origin: "board", kind: "worker_spawned",
      payload: WORKER_SPAWNED,
      created_at: at,
    },
    {
      id: 13, task_id: task, actor_id: "tako", origin: "worker", kind: "decision_logged",
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
  expect(episode.cliVersion).toBe("2.1.237");
  // init 行の無い transcript は「観測できなかった」— 推測しない
  expect(project({ transcriptLines: [] }).cliVersion).toBeNull();
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

it("差し替えの行(system/model_refusal_fallback)は「知っていて捨てる行」で、未知に数えない(ADR 0215 決定5)", () => {
  // #1425 の VM 実測で見た2段目の行(`...` で省かれていた欄は足さない)
  const swap = JSON.stringify({
    type: "system",
    subtype: "model_refusal_fallback",
    trigger: "refusal",
    direction: "retry",
    scope: "session",
    original_model: "claude-fable-5-1",
    fallback_model: "claude-opus-4-8",
    api_refusal_category: "cyber",
  });
  expect(project({ transcriptLines: [...transcriptLines(), swap] }).lines).toMatchObject({ ignored: 7, unknown: 0 });
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
      id: 12, task_id: task, actor_id: "tako", origin: "board", kind: "worker_spawned",
      payload: WORKER_SPAWNED,
      created_at: at,
    },
    {
      id: 13, task_id: task, actor_id: "tako", origin: "worker", kind: "decision_logged",
      payload: { kind: "decision_logged", line: "2本目の session の判断" }, created_at: at,
    },
  ];

  const episode = project({ events });
  // 13 は次の session のもの — 窓を開けっぱなしにすると unmatched として湧く
  expect(episode.markers.filter((m) => m.kind === "decision").map((m) => m.eventId)).toEqual([6, 7, 8]);
  expect(episode.workerExitedEventId).toBeNull();
});

it("memory verb の tool 結果に写った memory_pulled の event id は、decision と同じ完全一致で位置つきの memory マーカーになり、D の前の pull が返した id は seen に入り、browse / search だけでは read に入らない(spec #586 D / issue #604)", () => {
  const task = "6b4c0b23-289e-4f9f-ade1-995fb27f3c0e";
  const at = "2026-08-20T06:30:00.000Z";
  const pulled = (id: number, verb: "search_memory" | "read_memory", returned_ids: number[]): EventRow => ({
    id, task_id: task, actor_id: "tako", origin: "worker", kind: "memory_pulled",
    payload: { kind: "memory_pulled", verb, input: {}, returned_ids, watermark: 3 }, created_at: at,
  });
  const events: EventRow[] = [
    ...fixtureEvents().filter((e) => e.id === 5),
    pulled(6, "search_memory", [1, 2]),
    { id: 7, task_id: task, actor_id: "tako", origin: "worker", kind: "decision_logged", payload: { kind: "decision_logged", line: "x" }, created_at: at },
    pulled(8, "read_memory", [2, 3]),
    // tool 結果に写っていない pull —— 位置を持たず、D の前の読み口は拾わない
    pulled(9, "read_memory", [4]),
  ];
  const episode = project({
    events,
    transcriptLines: [
      ...toolCall(1, "mcp__tidepool__search_memory", 6),
      // memory verb 以外の応答に写った id は memory マーカーにしない
      ...toolCall(2, "Bash", 9),
      ...toolCall(3, "mcp__tidepool__log_decision", 7),
      ...toolCall(4, "mcp__tidepool__read_memory", 8),
    ],
  });

  expect(episode.markers).toEqual([
    { kind: "memory", position: 0, eventId: 6, missingReason: null, transcriptRef: "r1" },
    { kind: "decision", position: 2, eventId: 7, missingReason: null, transcriptRef: "r3" },
    { kind: "memory", position: 3, eventId: 8, missingReason: null, transcriptRef: "r4" },
    { kind: "memory", position: null, eventId: 9, missingReason: "unmatched", transcriptRef: null },
  ]);
  expect(entriesReadBefore(episode, events, 7)).toEqual([]);
  expect(entriesSeenBefore(episode, events, 7)).toEqual([1, 2]);
  // D がこの Episode で位置を持たなければ、どちらも「何も見なかった」と混ぜない
  expect(entriesReadBefore(episode, events, 999)).toBeNull();
  expect(entriesSeenBefore(episode, events, 999)).toBeNull();
});

it("「D の前に読んだ記憶」(read)は read_memory が返した id だけで、seen はそれに その session(worker_spawned の event id で結ぶ)の memory_injected の entry を足す —— 別 session の注入は含まない(spec #586 C / issue #592 / issue #604)", () => {
  const task = "6b4c0b23-289e-4f9f-ade1-995fb27f3c0e";
  const at = "2026-08-20T06:30:00.000Z";
  const injected = (id: number, spawned: number, entryIds: number[]): EventRow => ({
    id, task_id: task, actor_id: "tako", origin: "board", kind: "memory_injected",
    payload: { kind: "memory_injected", worker_spawned_event_id: spawned, watermark: 3, entries: entryIds.map((e) => ({ id: e, version: e })), tokens: 10, index_depth: 1, index_max_depth: 1, omitted: 0, tokenizer: "gpt-tokenizer/o200k_base", tokenizer_version: "4.0.0" },
    created_at: at,
  });
  const events: EventRow[] = [
    ...fixtureEvents().filter((e) => e.id === 5),
    injected(6, 5, [3, 1]),
    injected(7, 99, [8]),
    { id: 8, task_id: task, actor_id: "tako", origin: "worker", kind: "memory_pulled", payload: { kind: "memory_pulled", verb: "read_memory", input: {}, returned_ids: [2, 3], watermark: 3 }, created_at: at },
    { id: 9, task_id: task, actor_id: "tako", origin: "worker", kind: "decision_logged", payload: { kind: "decision_logged", line: "x" }, created_at: at },
  ];
  const episode = project({
    events,
    transcriptLines: [...toolCall(1, "mcp__tidepool__read_memory", 8), ...toolCall(2, "mcp__tidepool__log_decision", 9)],
  });

  expect(entriesReadBefore(episode, events, 9)).toEqual([2, 3]);
  expect(entriesSeenBefore(episode, events, 9)).toEqual([1, 2, 3]);
});

it("read_memory_entries が返した id は、その session の memory_injected(指針の節)に載っていたものだけ read に入り、材料の節の id は seen にとどまる(ADR 0279 決定2)", () => {
  const task = "6b4c0b23-289e-4f9f-ade1-995fb27f3c0e";
  const at = "2026-08-20T06:30:00.000Z";
  const events: EventRow[] = [
    ...fixtureEvents().filter((e) => e.id === 5),
    {
      id: 6, task_id: task, actor_id: "tako", origin: "board", kind: "memory_injected",
      payload: { kind: "memory_injected", worker_spawned_event_id: 5, watermark: 3, entries: [{ id: 4, version: 4 }], tokens: 10, index_depth: 0, index_max_depth: 0, omitted: 0, tokenizer: "gpt-tokenizer/o200k_base", tokenizer_version: "4.0.0" },
      created_at: at,
    },
    {
      id: 7, task_id: task, actor_id: "tako", origin: "board", kind: "meta_review_material_injected",
      payload: { kind: "meta_review_material_injected", subject: "memory", worker_spawned_event_id: 5, previous_watermark: 0, material_watermark: 3, tokens: 10, tokenizer: "gpt-tokenizer/o200k_base", tokenizer_version: "4.0.0", changed_memory_entry_ids: [2], candidates: [], precedents: [], precedent_memory_entry_ids: [], stop_attributed_event_ids: [], proposals: [], proposal_memory_entry_ids: [], branch_definition_ids: [], items: [] },
      created_at: at,
    },
    { id: 8, task_id: task, actor_id: "tako", origin: "worker", kind: "memory_pulled", payload: { kind: "memory_pulled", verb: "read_memory_entries", input: {}, returned_ids: [2, 4], watermark: 3 }, created_at: at },
    { id: 9, task_id: task, actor_id: "tako", origin: "worker", kind: "decision_logged", payload: { kind: "decision_logged", line: "x" }, created_at: at },
  ];
  const episode = project({
    events,
    transcriptLines: [...toolCall(1, "mcp__tidepool__read_memory_entries", 8), ...toolCall(2, "mcp__tidepool__log_decision", 9)],
  });

  expect(entriesReadBefore(episode, events, 9)).toEqual([4]);
  expect(entriesSeenBefore(episode, events, 9)).toEqual([2, 4]);
});

/** run A(#1231 の測定): 盤面と同じ argv の `codex exec --json` が書いた stdout と、それを挟む合成の events。 */
const codexTranscriptLines = () =>
  readFileSync(join(import.meta.dirname, "fixtures", "worker-session-codex-0.147.0.stream.jsonl"), "utf8").split("\n");
const codexEvents = (): EventRow[] => {
  const task = "t1231";
  const at = "2026-10-09T00:00:00.000Z";
  return [
    { id: 400, task_id: task, actor_id: "codex-agent", origin: "board", kind: "worker_spawned", payload: { ...WORKER_SPAWNED, harness: "codex", cli_version: "codex-cli 0.147.0" }, created_at: at },
    { id: 500, task_id: task, actor_id: "codex-agent", origin: "worker", kind: "memory_pulled", payload: { kind: "memory_pulled", verb: "read_memory", input: {}, returned_ids: [7], watermark: 3 }, created_at: at },
    { id: 501, task_id: task, actor_id: "codex-agent", origin: "worker", kind: "decision_logged", payload: { kind: "decision_logged", line: "chose path A" }, created_at: at },
    { id: 502, task_id: task, actor_id: "codex-agent", origin: "board", kind: "worker_exited", payload: { kind: "worker_exited", advisor: null, model_swaps: [], refusals: [], ...QUIET_EXIT, worker_spawned_event_id: 400, output_closed: true, usage: null }, created_at: at },
  ];
};
const projectCodex = (transcriptLines = codexTranscriptLines()) =>
  projectEpisode({ transcriptLines, events: codexEvents(), workerSpawnedEventId: 400, extractorVersion: "test" });

it("Codex 経路の session は stdout の item.completed から行動列を組み、mcp_tool_call の tool 名は mcp__<server>__<tool> になり、失敗は status failed だけ(ADR 0083 追記10)", () => {
  const episode = projectCodex();

  expect(episode.actions.map((a) => [a.tool, a.args, a.failed])).toEqual([
    ["mcp__tidepool__get_current_task", null, false],
    ["mcp__tidepool__read_memory", null, false],
    ["mcp__tidepool__log_decision", null, false],
    ["mcp__tidepool__read_memory", null, true],
    ["mcp__tidepool__search_memory", null, true],
    ["command_execution", "/bin/bash -lc 'ls -a'", false],
    ["file_change", "/home/choumasaki.guest/ws1231/note.txt", false],
    ["mcp__tidepool__complete_task", null, false],
  ]);
  // 行の参照は item の id
  expect(episode.actions[1]).toMatchObject({ transcriptRef: "item_7", toolUseId: "item_7" });
});

it("Codex 経路でも memory_pulled / decision_logged は tool 結果の event id の完全一致で位置を持ち、D の前の read_memory が返した id が read になる(ADR 0083 追記10)", () => {
  const episode = projectCodex();

  expect(episode.markers).toEqual([
    { kind: "memory", position: 1, eventId: 500, missingReason: null, transcriptRef: "item_7" },
    { kind: "decision", position: 2, eventId: 501, missingReason: null, transcriptRef: "item_8" },
  ]);
  expect(entriesReadBefore(episode, codexEvents(), 501)).toEqual([7]);
});

it("Codex の Episode は構造マーカーを持たず、run A の行はすべて解釈か既知で、CLI の版は worker_spawned の固定版、subagent は全行 false(ADR 0083 追記10)", () => {
  const episode = projectCodex();

  expect(episode.markers.filter((m) => m.kind !== "memory" && m.kind !== "decision")).toEqual([]);
  // 26 行: mcp_tool_call 6 + command_execution 1 + file_change 1 = 8 を解釈。thread.started 1・turn.started 1・
  // turn.completed 1・item.started 8・item.completed の error 5 と agent_message 2 = 18 を既知として捨てる
  expect(episode.lines).toEqual({ total: 26, interpreted: 8, ignored: 18, unknown: 0, unknownKinds: {} });
  expect(episode.unrecognizedFormat).toBe(false);
  expect(episode.cliVersion).toBe("codex-cli 0.147.0");
  expect(episode.actions.every((a) => !a.subagent)).toBe(true);
});

it("stdout で未観測の Codex の行(item.updated、reasoning の item)は未知に数える(ADR 0083 追記10)", () => {
  const episode = projectCodex([
    ...codexTranscriptLines(),
    '{"type":"item.updated","item":{"id":"item_15","type":"todo_list","items":[]}}',
    '{"type":"item.completed","item":{"id":"item_16","type":"reasoning","text":"…"}}',
  ]);

  expect(episode.lines).toMatchObject({
    total: 28,
    unknown: 2,
    unknownKinds: { "item.updated/todo_list": 1, "item.completed/reasoning": 1 },
  });
});

// skill の呼び出し(ADR 0325 決定2・3 / #2691)。固定版 2.1.286 の stream(Lima VM で採取): workspace skill wsbar と同梱 skill dataviz を
// 1回ずつ呼び、subagent に wsbar を呼ばせ、最後に1つの message で wsbar と dataviz を並べて呼び直した session。
const skillSession = () => readFileSync(join(import.meta.dirname, "fixtures", "skill-session-2.1.286.stream.jsonl"), "utf8").split("\n");
const skillEvents = (): EventRow[] => [
  { id: 1, task_id: "t2691", actor_id: "tako", origin: "board", kind: "worker_spawned", payload: WORKER_SPAWNED, created_at: "2026-10-29T00:00:00.000Z" },
];
const projectSkills = (transcriptLines = skillSession()) =>
  projectEpisode({ transcriptLines, events: skillEvents(), workerSpawnedEventId: 1, extractorVersion: "test" });

it("skill の呼び出しは Skill の行動行ごとに名前・位置・本文の合成行の参照・subagent の印の1行になり、Skill の args は skill の名前(ADR 0325 決定3)", () => {
  const episode = projectSkills();

  expect(episode.actions.map((a) => [a.tool, a.args, a.subagent])).toEqual([
    ["Skill", "wsbar", false],
    ["Skill", "dataviz", false],
    ["Agent", "Invoke wsbar skill", false],
    ["Skill", "wsbar", true],
    ["Skill", "wsbar", false],
    ["Skill", "dataviz", false],
  ]);
  // subagent の呼び出しの結果は commandName を持たず、本文の合成行も親の stream に出ない(固定版の実測)
  expect(episode.skillCalls).toEqual([
    { position: 0, name: "wsbar", transcriptRef: "4445234f-1964-4b14-9132-bde0a466ac7f", subagent: false },
    { position: 1, name: "dataviz", transcriptRef: "56fae6c4-4974-43ce-9fb3-33d95f251269", subagent: false },
    { position: 3, name: "wsbar", transcriptRef: null, subagent: true },
    { position: 4, name: "wsbar", transcriptRef: "84eb1696-45a2-4d45-aee9-cb3925baaf61", subagent: false },
    { position: 5, name: "dataviz", transcriptRef: "69f8a696-0eac-43ee-b75d-7c8cddf3cb15", subagent: false },
  ]);
});

it("従った skill の本文は Base directory の見出しを除いた合成行の文で、読み込み済みの skill の呼び直しは harness の注記のまま、本文の行の無い subagent の呼び出しは null(ADR 0325 決定3)", () => {
  const followed = skillsFollowed(projectSkills(), skillSession(), { id: 0, kind: "task_completed" });

  expect(followed.map((s) => [s.name, s.position, s.text?.split("\n", 1)[0] ?? null])).toEqual([
    ["wsbar", 0, "When this skill is invoked, reply with the single word BARBAR and nothing else."],
    ["dataviz", 1, "# Data Visualization"],
    ["wsbar", 3, null],
    ["wsbar", 4, "Skill /wsbar is already loaded above; instructions unchanged."],
    ["dataviz", 5, "Skill /dataviz is already loaded above; instructions unchanged."],
  ]);
});

it("Claude の worker が見た skill の集合は init 行の skills(ADR 0325 決定2)", () => {
  expect(projectSkills().skillsSeen).toEqual([
    "wsbar", "deep-research", "design", "design-sync", "dataviz", "update-config", "verify", "debug", "code-review", "simplify",
    "batch", "fewer-permission-prompts", "doctor", "loop", "schedule", "claude-api", "workflow-authoring", "run", "run-skill-generator", "plugin-authoring",
  ]);
});

// #2689 の実測(Codex 0.163.0、2026-11-01)の行の形: worker は許した SKILL.md を `command_execution` の `cat` で絶対 path のまま読み、
// 本文は `item.completed` の `aggregated_output` に逐語で残る。同じ path を開いた後の `python3` の行(exit 0)も完了行で、ADR 0337
// 決定4 の照合はこれも数える。`.system` の read 行が無い run の `cat` は failed / exit 1、`find … -path '*/x/SKILL.md'` は path の全体を
// 含まない。`$名前` の mention は stdout に何も残さない(#2813)ので行が無い。
const CODEX_WS_SKILL = "/home/u/ws2817/.agents/skills/secret-word/SKILL.md";
const CODEX_SYSTEM_SKILL = "/home/u/.tidepool/codex/skills/.system/skill-creator/SKILL.md";
const SECRET_WORD_BODY = "---\nname: secret-word\ndescription: d\n---\nThe answer is PINEAPPLE-2689.\n";
const commandRow = (type: "item.started" | "item.completed", id: string, command: string, aggregated_output: string, exit_code: number | null, status: string) =>
  JSON.stringify({ type, item: { id, type: "command_execution", command, aggregated_output, exit_code, status } });
const codexSkillSession = () => [
  '{"type":"thread.started","thread_id":"th"}',
  '{"type":"turn.started"}',
  commandRow("item.started", "item_1", `/bin/bash -lc 'cat ${CODEX_WS_SKILL}'`, "", null, "in_progress"),
  commandRow("item.completed", "item_1", `/bin/bash -lc 'cat ${CODEX_WS_SKILL}'`, SECRET_WORD_BODY, 0, "completed"),
  commandRow("item.completed", "item_3", `/bin/bash -lc "python3 -c 'print(open(\\"${CODEX_WS_SKILL}\\").read()[:9])'"`, "---\nname:", 0, "completed"),
  commandRow("item.completed", "item_4", `/bin/bash -lc 'cat ${CODEX_SYSTEM_SKILL}'`, "cat: No such file or directory", 1, "failed"),
  commandRow("item.completed", "item_5", "/bin/bash -lc \"find / -path '*/skill-creator/SKILL.md'\"", "", 0, "completed"),
  '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}',
];
const codexSkillEvents = (skills: Extract<EventRow["payload"], { kind: "worker_spawned" }>["skills"]): EventRow[] => [
  { id: 1, task_id: "t2817", actor_id: "codex-agent", origin: "board", kind: "worker_spawned", payload: { ...WORKER_SPAWNED, harness: "codex", cli_version: "codex-cli 0.163.0", skills }, created_at: "2026-11-01T00:00:00.000Z" },
];
const CODEX_SKILLS = {
  workspace: ["secret-word"],
  host: ["skill-creator"],
  permitted: ["secret-word", "skill-creator"],
  paths: { "secret-word": CODEX_WS_SKILL, "skill-creator": CODEX_SYSTEM_SKILL },
};

it("Codex の Episode の見た集合は spawn 記録の permitted で、従った skill は許した path を command に含む command_execution の完了・exit 0 の行 —— item.started・失敗行・path の一部だけの行は数えない(ADR 0337 決定4)", () => {
  const lines = codexSkillSession();
  const episode = projectEpisode({ transcriptLines: lines, events: codexSkillEvents(CODEX_SKILLS), workerSpawnedEventId: 1, extractorVersion: "test" });

  expect(episode.skillsSeen).toEqual(["secret-word", "skill-creator"]);
  expect(episode.skillCalls).toEqual([
    { position: 0, name: "secret-word", transcriptRef: "item_1", subagent: false },
    { position: 1, name: "secret-word", transcriptRef: "item_3", subagent: false },
  ]);
  // 本文は写さず行の参照を持ち、判事の skills_followed はその行の aggregated_output を逐語で読む
  expect(skillsFollowed(episode, lines, { id: 0, kind: "task_completed" })).toEqual([
    { name: "secret-word", position: 0, text: SECRET_WORD_BODY },
    { name: "secret-word", position: 1, text: "---\nname:" },
  ]);
});

it("paths を持たない Codex の spawn 記録(Codex の翻訳より前の記録)は表を空として読み、従った skill を結ばない(ADR 0337 決定2)", () => {
  const { paths: _, ...old } = CODEX_SKILLS;
  const episode = projectEpisode({ transcriptLines: codexSkillSession(), events: codexSkillEvents(old), workerSpawnedEventId: 1, extractorVersion: "test" });

  expect(episode).toMatchObject({ skillsSeen: ["secret-word", "skill-creator"], skillCalls: [] });
});

it("Skill の結果と組まない合成行(compaction の後の要約)と失敗した Skill は呼び出しに数えない(ADR 0325 決定3)", () => {
  // 固定版で compaction を起こした実測の形: compact_boundary の後に isSynthetic の要約行が1つ来て、skill の本文は入れ直されない
  const episode = projectSkills([
    '{"type":"system","subtype":"init","skills":["wsbar"],"claude_code_version":"2.1.286"}',
    '{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"t1","name":"Skill","input":{"skill":"wsbar"}}]}}',
    '{"type":"user","uuid":"r1","tool_use_result":{"success":true,"commandName":"wsbar"},"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Launching skill: wsbar"}]}}',
    '{"type":"user","uuid":"s1","isSynthetic":true,"message":{"content":[{"type":"text","text":"Base directory for this skill: /w/.claude/skills/wsbar\\n\\nSay BARBAR."}]}}',
    '{"type":"system","subtype":"compact_boundary","uuid":"c1"}',
    '{"type":"user","uuid":"s2","isSynthetic":true,"message":{"content":[{"type":"text","text":"This session is being continued from a previous conversation."}]}}',
    '{"type":"assistant","uuid":"a2","message":{"content":[{"type":"tool_use","id":"t2","name":"Skill","input":{"skill":"nope"}}]}}',
    '{"type":"user","uuid":"r2","message":{"content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":"Unknown skill: nope"}]}}',
  ]);

  expect(episode.skillCalls).toEqual([{ position: 0, name: "wsbar", transcriptRef: "s1", subagent: false }]);
});

it("本文の合成行は結果の行の直後に来たときだけその呼び出しに結ぶ —— 本文の行が来なかった呼び出しは null で、後の呼び出しの本文を取らない(ADR 0325 決定3)", () => {
  const [a1, r1] = skillCall(1, "wsbar", "unused");
  const episode = projectSkills([a1!, r1!, ...skillCall(2, "dataviz", "Chart it.")]);

  expect(episode.skillCalls.map((c) => [c.name, c.transcriptRef])).toEqual([
    ["wsbar", null],
    ["dataviz", "s2"],
  ]);
});
