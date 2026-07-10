import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { BOARD_WORKER_ID } from "../src/tasks.js";
import { quarantineWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
let wsPath: string | undefined;
afterEach(async () => {
  await t?.stop();
  if (wsPath) await rm(wsPath, { recursive: true, force: true });
  wsPath = undefined;
});

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir },
  )
    .toString()
    .trim();
}

async function makeWorkspace(): Promise<WorkspaceConfig> {
  const path = await mkdtemp(join(tmpdir(), "tidepool-ws-"));
  wsPath = path;
  git(path, "init", "-b", "main");
  writeFileSync(join(path, "README.md"), "workspace\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "initial");
  return { name: "sandbox", path };
}

async function registerWork(t: Tidepool, title: string) {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
  });
  return res.json;
}

const fullHandoff = {
  outcome: "done as specified",
  deliverables: "n/a",
  decision_refs: "n/a",
  dead_ends: "n/a",
  resume_context: "n/a",
  known_issues: "n/a",
};

/** Breaks the tree rule the same way tree-rule.test.ts does: destroy .git so
 *  the WIP commit fails and quarantine kicks in. */
async function triggerQuarantine(t: Tidepool, ws: WorkspaceConfig, title: string) {
  const task = await registerWork(t, title);
  await t.clock.advance(HOUR);
  writeFileSync(join(ws.path, `${title.replace(/\s/g, "-")}.txt`), "uncommittable\n");
  await rm(join(ws.path, ".git"), { recursive: true, force: true });
  const client = await mcpClient(t.baseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();
  return task;
}

it("tree rule 失敗時の question は1択の確認型(repaired by hand)である", async () => {
  const ws = await makeWorkspace();
  t = await bootTidepool({ workspace: ws });
  await triggerQuarantine(t, ws, "doomed work");

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = list.find((x: any) => x.type === "question");
  expect(question.question_options).toEqual(["repaired by hand"]);
  expect(question.question_recommendation).toBe("repaired by hand");
});

// v1 has one board workspace and slot concurrency 1 (CONTEXT.md), so a
// second tree-rule failure on an already-quarantined workspace can never
// arise through the ordinary scheduler/HTTP/MCP path — the pickup gate
// (workspaceNeedsHuman) already keeps any second task out of the slot. The
// dedup guard exists for #26's future per-workspace execution, so it's driven
// directly against the running board's own sqlite file, same as
// worker-failure.test.ts drops to the scheduler/tasks seam when the full
// stack can't reach the scenario. Git itself is still real, never faked.
it("同一 workspace への2度目の quarantine は question を増やさず、既存 question に再発火の cause イベントを追記する(needs_human は1のまま)", async () => {
  const ws = await makeWorkspace();
  t = await bootTidepool({ workspace: ws });
  await triggerQuarantine(t, ws, "doomed work");

  const before = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = before.find((x: any) => x.type === "question");

  const db = openDb(join(t.dir, "board.sqlite"));
  quarantineWorkspace(db, ws.name, new Error("second, unrelated tree-rule failure"), t.clock.now());
  db.close();

  const after = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(after.filter((x: any) => x.type === "question")).toHaveLength(1);
  expect(after.find((x: any) => x.id === question.id).status).toBe("todo");

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  expect(
    events.some((e: any) => e.payload.cause?.includes("second, unrelated tree-rule failure")),
  ).toBe(true);
});

it("quarantine question への回答はツリーが汚れたままだと拒否され、question は open のまま・needs_human も1のまま残る", async () => {
  const ws = await makeWorkspace();
  t = await bootTidepool({ workspace: ws });
  await triggerQuarantine(t, ws, "doomed work");

  const before = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = before.find((x: any) => x.type === "question");

  // 何も直さず「直した」と答える — .git はまだ壊れたまま
  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answer: "repaired by hand",
  });
  expect(res.status).toBe(409);

  const after = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(after.status).toBe("todo");

  // needs-human は解除されておらず、この workspace の他タスクも止まったまま
  await registerWork(t, "still stalled");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x: any) => x.title)).toEqual(["doomed work"]);
});

it("ツリーがクリーンだと確認されれば needs_human が解除され、question が done になり、pickup が即時再開する。自由記述の回答は question_answer に残る", async () => {
  const ws = await makeWorkspace();
  t = await bootTidepool({ workspace: ws });
  await triggerQuarantine(t, ws, "doomed work");

  // needs-human の間に登録された別タスクは止まったまま
  await registerWork(t, "stalled work");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x: any) => x.title)).toEqual(["doomed work"]);

  const before = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = before.find((x: any) => x.type === "question");

  // 実際に手で直す: git を作り直し、ツリーをクリーンにする
  git(ws.path, "init", "-b", "main");
  git(ws.path, "add", "-A");
  git(ws.path, "commit", "-m", "manual repair");

  const answerText = "repaired: reinitialized git and committed the WIP by hand";
  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answer: answerText,
  });
  expect(res.status).toBe(200);
  expect(res.json.status).toBe("done");
  expect(res.json.question_answer).toBe(answerText);

  // pickup が即時再開し、止まっていたタスクが動く(clock を進めなくても良い)
  expect(t.worker.started.map((x: any) => x.title)).toEqual(["doomed work", "stalled work"]);
});

// code-review 指摘: 1択緩和を workerId === BOARD_WORKER_ID で判定すると、
// worker id はオペレータ設定値であり BOARD_WORKER_ID ("tidepool") と偶然
// 衝突しうる — その場合、衝突した worker が担当する普通のタスクからの
// MCP escalate が1択の question を人間の確認なしにすり抜けてしまう
// (盤面名義の形式的確認で人間を呼ぶ道を開かないという設計合意②に反する)。
// 判定を quarantine_workspace の有無(MCP/JSON API からは絶対に設定でき
// ない system-internal フィールド)に変えたことで、この衝突が実害を持た
// ないことを直接確認する。衝突は worker id の設定次第で起こるため、
// tests/worker-failure.test.ts と同様に db を直接いじってシミュレートする。
it("worker id が BOARD_WORKER_ID(\"tidepool\")と衝突しても、MCP 経由の escalate は1択を拒否する", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "ordinary work");
  await t.clock.advance(HOUR); // picked up — assignee はワーカー自身の id

  // ワーカー id が盤面名義と衝突してしまった状態をシミュレート
  const db = openDb(join(t.dir, "board.sqlite"));
  db.prepare("UPDATE tasks SET assignee = ? WHERE id = ?").run(BOARD_WORKER_ID, task.id);
  db.close();

  const client = await mcpClient(t.baseUrl, task.id);
  const res: any = await client.callTool({
    name: "escalate",
    arguments: {
      title: "one-option escalate attempt",
      context: "a plain agent question, not a quarantine confirmation",
      options: ["only"],
      recommendation: "only",
    },
  });
  await client.close();

  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("2 to 4 options");
});
