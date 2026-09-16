import { rm, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
  FAILED_TEARDOWN_QUESTION_TITLE,
  quarantineFailedTeardown,
} from "../src/failed-teardown.js";
import { markTeardown } from "../src/teardown.js";
import { FakeContainerRuntime } from "./fakes.js";
import {
  api,
  bootTidepool,
  commitWork,
  completeIntegrationReviews,
  completeViaMcp,
  FULL_HANDOFF,
  git,
  HOUR,
  makeWorkspace,
  mcpClient,
  questions,
  registerWork,
  type Tidepool,
} from "./harness.js";

/** ADR 0109(issue #531)。通常完了の解放も**回収済み観測**を門とし、後始末は
 *  worker session の最後の局面である —— タスクが決着しても、その session の後始末が
 *  終わるまで枠は空かない(CONTEXT.md「後始末」/「Slot」)。
 *
 *  容器を `hold` した盤面が、この ADR がずっと語っている状況そのものである: 最終 verb は
 *  着地したのに、その session の process はまだホストに残っている。 */

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** 後始末は回収済み観測の後ろ = microtask の先にある。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const started = () => t.worker.started.map((task) => task.id);

const payload = (result: any) => JSON.parse(result.content[0].text);

it.each([false, true])("restart recovers cap teardown without a failure question (failed preflight first: %s)", async (failPreflight) => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "interrupted by cap");
  await registerWork(t, "next");
  await t.clock.advance(HOUR);
  await writeFile(`${ws.path}/wip.txt`, "unfinished work\n");
  // Setup the durable state at the instant the adapter observed a 429 exit.
  markTeardown(t.db, task.id, t.clock.now());
  // 上限到達による中断の経路: 行は `in_progress` のまま残る(ADR 0113 決定2)
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown.settlement).toBe("interrupted");
  await t.stopServer();
  if (failPreflight) {
    const runtime = new FakeContainerRuntime();
    runtime.scriptPreflight("previous session may still be alive");
    t = await bootTidepool({ dir: t.dir, workspace: ws, containerRuntime: runtime });
    expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");
    expect((await questions(t)).some((q: any) => q.title.includes("interrupted task"))).toBe(false);
    expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown.taskId).toBe(task.id);
    expect(git(ws.path, "status", "--porcelain")).toContain("wip.txt");
    await t.stopServer();
  }

  t = await bootTidepool({ dir: t.dir, workspace: ws });
  await settle();
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queue.teardown).toBeUndefined();
  expect((await questions(t)).some((q: any) => q.title.includes("interrupted task"))).toBe(false);
  expect(git(ws.path, "show", `task/${task.id}:wip.txt`)).toBe("unfinished work");
  if (failPreflight) {
    // 前提検査が一度落ちた盤面では、その Containment quarantine の確認 question が pickup を止めている
    expect(started()).toEqual([]);
    expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("todo");
    expect(queue.tasks.filter((row: any) => row.type === "work")[0].id).toBe(task.id);
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  } else {
    // ADR 0119 決定4: 復旧の完走で todo に戻ったタスクは、tick を進めずに起動完了の poll で拾われる
    expect(started()).toEqual([task.id]);
  }
});

it("容器が生きている間は次の task が pickup されない —— 進めるのは回収済み観測である", async () => {
  t = await bootTidepool();
  const first = await registerWork(t, "first");
  const second = await registerWork(t, "second");
  await t.clock.advance(HOUR);
  // 行儀よく exit しない子孫を持つ session: root が終わっても容器は空にならない
  t.containers.hold(first.id);

  const result: any = await completeViaMcp(t, first.id);

  // verb は着地し、**response は容器の生存を待たない**(循環待ちが無い)
  expect(result.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${first.id}`)).json.status).toBe("done");
  // root の exit は観測され、強制回収が送達されている —— それでも門は開かない
  expect(t.worker.exits).toEqual([first.id]);
  expect(t.containers.forceReclaims).toEqual([first.id]);
  await t.clock.advance(HOUR);
  expect(started()).toEqual([first.id]);

  t.containers.fireEmpty(first.id);
  await t.clock.advance(HOUR);
  expect(started()).toEqual([first.id, second.id]);
});

it("decompose と escalate も同じ —— 枠を握っているのは task ではなく session である", async () => {
  for (const verb of ["decompose", "escalate"] as const) {
    t = await bootTidepool();
    const first = await registerWork(t, "first");
    const second = await registerWork(t, "second");
    await t.clock.advance(HOUR);
    t.containers.hold(first.id);
    const client = await mcpClient(t.mcpBaseUrl, first.id);
    const result: any = await client.callTool({
      name: verb,
      arguments:
        verb === "decompose"
          ? {
              reason: "split it",
              children: [{ title: "child", purpose: "why", completion_criteria: "done" }],
            }
          : {
              context: "a decision outside my authority",
              questions: [{ title: "which way?", options: ["a", "b"], recommendation: "a" }],
            },
    });
    expect(result.isError ?? false).toBe(false);
    await client.close();
    // エスカレーション・分解の経路: タスクは queue へ戻り、行は `todo` である
    expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown.settlement).toBe("released");

    await t.clock.advance(HOUR);
    expect(started()).toEqual([first.id]);
    t.containers.fireEmpty(first.id);
    await t.clock.advance(HOUR);
    expect(started()).toEqual([first.id, second.id]);
    await t.stop();
  }
});

it("最終 verb の着地後、同じ session の呼び出しは読取も含めて拒まれる —— 最初の解放系 verb 自身は拒まれない", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "one");
  await t.clock.advance(HOUR);
  t.containers.hold(task.id);
  const client = await mcpClient(t.mcpBaseUrl, task.id);

  const landed: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: FULL_HANDOFF },
  });
  expect(landed.isError ?? false).toBe(false);

  for (const call of [
    { name: "get_current_task", arguments: {} },
    { name: "log_decision", arguments: { line: "one more thought" } },
    { name: "complete_task", arguments: { handoff: FULL_HANDOFF } },
  ]) {
    const refused: any = await client.callTool(call);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("this session is over");
  }
  await client.close();

  // slot も workspace も動かない
  await t.clock.advance(HOUR);
  expect(started()).toEqual([task.id]);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
});

it("解放系 verb 3つの返り値に終了の指示が入る", async () => {
  const cases = [
    { name: "complete_task", arguments: { handoff: FULL_HANDOFF } },
    {
      name: "decompose",
      arguments: {
        reason: "split it",
        children: [{ title: "child", purpose: "why", completion_criteria: "done" }],
      },
    },
    {
      name: "escalate",
      arguments: {
        context: "a decision outside my authority",
        questions: [{ title: "which way?", options: ["a", "b"], recommendation: "a" }],
      },
    },
  ];
  for (const call of cases) {
    t = await bootTidepool();
    const task = await registerWork(t, call.name);
    await t.clock.advance(HOUR);
    const client = await mcpClient(t.mcpBaseUrl, task.id);
    const result: any = await client.callTool(call);
    await client.close();
    expect(payload(result).session_over).toContain("Session over. End your turn now");
    await t.stop();
  }
});

it("「今なぜ pickup が起きないか」の読み口が後始末を報せる —— 停止の列挙そのものは増えない", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "one");
  await t.clock.advance(HOUR);
  t.containers.hold(task.id);
  await completeViaMcp(t, task.id);

  const pause = (await api(t.baseUrl, "GET", "/api/pause")).json;
  expect(pause.halts).toEqual([]);
  expect(pause.teardown.taskId).toBe(task.id);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown.settlement).toBe("completed");
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown.taskId).toBe(task.id);

  t.containers.fireEmpty(task.id);
  await settle();
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.teardown).toBeUndefined();
});

it("後始末の途中で盤面を再起動しても、前提検査が通れば完走する", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "one");
  await t.clock.advance(HOUR);
  commitWork(ws.path, "deliverable.txt", "the real work\n");
  t.containers.hold(task.id);
  await completeViaMcp(t, task.id);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);

  // in-memory の callback は盤面の crash を越えない。起動完了の poll(ADR 0119 決定4)が
  // 空いた checkout を動かす前の休止位置を見るため、pickup を止めておく(Pause は再起動を跨ぐ)
  await api(t.baseUrl, "POST", "/api/pause", { paused: true });
  await t.stopServer();
  t = await bootTidepool({ dir: t.dir, workspace: ws });
  await settle();

  // tree rule / merge-back / 休止位置 / slot 解放が完走している
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(ws.path, "show", `task/${task.id}:deliverable.txt`)).toBe("the real work");
  // Pause の解除で、空いた枠に統合点レビューが入る
  await api(t.baseUrl, "POST", "/api/pause", { paused: false });
  expect(t.worker.started.map((x) => [x.type, x.parent_id])).toEqual([["review", task.id]]);
  // 統合点レビューを終えると着地が再発火する。
  await completeIntegrationReviews(t, task.id);
  expect((await questions(t)).some((q: any) => q.title.startsWith("land completed task"))).toBe(
    true,
  );
  const next = await registerWork(t, "two");
  await t.clock.advance(HOUR);
  expect(t.worker.started.filter((task) => task.type === "work").map((task) => task.id)).toEqual([next.id]);
});

it("前提検査が通らなければ後始末は走らず、pickup は止まったままになる", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "one");
  await t.clock.advance(HOUR);
  commitWork(ws.path, "deliverable.txt", "the real work\n");
  t.containers.hold(task.id);
  await completeViaMcp(t, task.id);
  await t.stopServer();

  const runtime = new FakeContainerRuntime();
  runtime.scriptPreflight("this host has no container runtime");
  t = await bootTidepool({ dir: t.dir, workspace: ws, containerRuntime: runtime });
  await settle();

  // 証明の前に進めば、生き残った process の居る workspace を盤面が書く
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  await registerWork(t, "two");
  await t.clock.advance(HOUR);
  expect(started()).toEqual([]);
});

it("落ちた後始末の question を残したまま再起動しても、起動時復旧は撃ち直さず偽の Containment question も刷られない", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "one");
  await t.clock.advance(HOUR);
  commitWork(ws.path, "deliverable.txt", "the real work\n");
  t.containers.hold(task.id);
  await completeViaMcp(t, task.id);
  // 盤面自身のコードが投げた瞬間の durable な状態(ADR 0112)。門は行に持つので再起動を越える
  quarantineFailedTeardown(t.db, task.id, new Error("resolve exploded"), t.clock.now());
  await t.stopServer();

  t = await bootTidepool({ dir: t.dir, workspace: ws });
  await settle();
  await t.clock.advance(HOUR);

  // 撃ち直していない —— 撃てば同じ所で落ちて無言に戻る
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  const raised = (await questions(t)).map((q: any) => q.title);
  expect(raised).toContain(FAILED_TEARDOWN_QUESTION_TITLE);
  expect(raised.some((title: string) => title.includes("containment"))).toBe(false);
  // 停止の列挙が「なぜ pickup が起きないか」に1回で答える
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.halts).toEqual([
    { kind: "failedTeardown" },
  ]);
  await registerWork(t, "two");
  await t.clock.advance(HOUR);
  expect(started()).toEqual([]);
});
