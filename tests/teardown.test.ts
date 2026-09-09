import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FakeContainerRuntime } from "./fakes.js";
import {
  api,
  bootTidepool,
  commitWork,
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

const quarantineQuestion = async () =>
  (await questions(t)).find((q: any) => q.title.includes("needs human attention"));

const payload = (result: any) => JSON.parse(result.content[0].text);

const MIN = 60 * 1000;

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

it("完了の報告の後に書かれたものは成果ではない —— WIP も merge-back も無く workspace が quarantine に落ちる", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "work");
  await t.clock.advance(HOUR);
  commitWork(ws.path, "deliverable.txt", "the real work\n");
  const mainBefore = git(ws.path, "rev-parse", "main");
  t.containers.hold(task.id);

  await completeViaMcp(t, task.id);
  // 決着を報告した後に、まだ生きていた process が書く
  writeFileSync(join(ws.path, "after-the-report.txt"), "written by a process that outlived\n");
  t.containers.fireEmpty(task.id);
  await settle();

  expect((await quarantineQuestion())?.purpose).toContain("after task");
  // 退避されていない: WIP コミットは無く、汚れはそのまま人間の修理材料として残る
  expect(git(ws.path, "log", "--oneline", `task/${task.id}`)).not.toContain("WIP");
  expect(git(ws.path, "status", "--porcelain")).not.toBe("");
  // merge-back も走っていない —— 報告後の書き込みが祖先ブランチへ運ばれることはない
  expect(git(ws.path, "rev-parse", "main")).toBe(mainBefore);
});

it("汚れが shadow 残骸の3条件だけを満たすなら、削除された上で通常どおり完了する", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "work");
  await t.clock.advance(HOUR);
  commitWork(ws.path, "deliverable.txt", "the real work\n");
  t.containers.hold(task.id);

  await completeViaMcp(t, task.id);
  // ADR 0069 の3条件(既知パス・untracked・0バイト)—— サンドボックスの影であって
  // セッションの遺物ではない
  mkdirSync(join(ws.path, ".claude"), { recursive: true });
  writeFileSync(join(ws.path, ".claude", "agents"), "");
  t.containers.fireEmpty(task.id);
  await settle();

  expect(await quarantineQuestion()).toBeUndefined();
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

it("escalate の後始末では、着地後の書き込みが従来どおり WIP としてタスクブランチに退避される", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "work");
  await t.clock.advance(HOUR);
  t.containers.hold(task.id);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({
    name: "escalate",
    arguments: {
      context: "a decision outside my authority",
      questions: [{ title: "which way?", options: ["a", "b"], recommendation: "a" }],
    },
  });
  await client.close();

  writeFileSync(join(ws.path, "half-done.txt"), "work in flight\n");
  t.containers.fireEmpty(task.id);
  await settle();

  expect(await quarantineQuestion()).toBeUndefined();
  expect(git(ws.path, "log", "--oneline", `task/${task.id}`)).toContain("WIP");
  expect(git(ws.path, "show", `task/${task.id}:half-done.txt`)).toBe("work in flight");
});

it("review の完了でも退避する —— 完了の門を持たない解放の WIP はタスクブランチに留まる", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "review the deliverable",
      purpose: "check it against the criteria",
      completion_criteria: "findings are recorded",
    })
  ).json;
  await t.clock.advance(HOUR);
  t.containers.hold(task.id);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: {} });
  await client.close();

  writeFileSync(join(ws.path, "reviewer-leavings.txt"), "notes\n");
  t.containers.fireEmpty(task.id);
  await settle();

  expect(await quarantineQuestion()).toBeUndefined();
  expect(git(ws.path, "show", `task/${task.id}:reviewer-leavings.txt`)).toBe("notes");
});

it("最終 verb 着地後に root が exit しないまま時限を超えると既存の梯子に乗る —— failure question は立たず task は done のまま", async () => {
  t = await bootTidepool({
    watchdog: { timeLimits: { work: 90 * MIN }, grace: 30 * MIN, reclaimTimeout: 5 * MIN },
  });
  const task = await registerWork(t, "one");
  await t.clock.advance(HOUR);
  t.containers.hold(task.id);
  await completeViaMcp(t, task.id);

  // backstop(既定は回収 timeout と同じ尺度)まではまだ何も起きない
  await t.clock.advance(4 * MIN);
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.halts).toEqual([]);

  await t.clock.advance(2 * MIN); // backstop 超過 → 強制回収
  await t.clock.advance(5 * MIN); // 回収 timeout → Containment quarantine

  const containment = (await questions(t)).find((q: any) => q.title.includes("containment"));
  expect(containment.purpose).toContain("finished its work and reported it");
  // タスクの決着は host 側の事情で覆らない
  expect((await questions(t)).some((q: any) => q.title.includes("watchdog killed"))).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.halts).toEqual([{ kind: "containment" }]);
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

  // in-memory の callback は盤面の crash を越えない
  await t.stopServer();
  t = await bootTidepool({ dir: t.dir, workspace: ws });
  await settle();

  // tree rule / merge-back / 休止位置 / slot 解放が完走している
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(ws.path, "show", `task/${task.id}:deliverable.txt`)).toBe("the real work");
  // 着地も後始末の中で走る —— purely-local な workspace なので人間への merge question
  expect((await questions(t)).some((q: any) => q.title.startsWith("land completed task"))).toBe(
    true,
  );
  const next = await registerWork(t, "two");
  await t.clock.advance(HOUR);
  expect(started()).toEqual([next.id]);
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
