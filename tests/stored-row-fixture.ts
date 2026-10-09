// 型の負テスト(append-event-scope-fixture.ts と同じ形、ADR 0220 / issue #1224)。`npm run typecheck` にだけ効き、
// `.test.ts` ではないので vitest は拾わない。宣言だけで値を持たず、DB にも HTTP にも触れない。
import type { Response } from "express";
import type { Db } from "../src/db.js";
import { domainResult, readBudgeted } from "../src/management-mcp.js";
import { type McpDeps, runVerb, toolResult } from "../src/mcp.js";
import { packItems, type ReadPosition } from "../src/response-budget.js";
import { sendJson } from "../src/send-json.js";
import { getTask, listBoard, presentTask, type Task, type TaskRow } from "../src/tasks.js";
import type { WireContract } from "../src/wire-contract.js";

declare const db: Db;
declare const deps: McpDeps;
declare const res: Response;
declare const read: ReadPosition<unknown>;
declare const task: Task;
declare const row: TaskRow;
declare const events: { id: number }[];
declare const x: unknown;
{
  // 保存された行は、そのまま・配列・入れ子・キャスト・spread のどれでも出口で拒まれる
  // @ts-expect-error
  toolResult(task);
  // @ts-expect-error
  toolResult([task]);
  // @ts-expect-error
  toolResult({ task });
  // @ts-expect-error
  toolResult(x as Task);
  // #1221 の形
  // @ts-expect-error
  toolResult([{ ...task, blocking: null, accepted: false }]);
  // #1215 の形 —— WireContract は WebUI が読む欄だけを約束するので満たしてしまう
  // @ts-expect-error
  sendJson(res, task satisfies WireContract["POST /api/tasks"]);
  // SQLite の行も解決の手前
  // @ts-expect-error
  toolResult(row);
  // @ts-expect-error
  sendJson(res, row);
}
{
  // 型を消していた包み
  // @ts-expect-error
  runVerb(deps, null, (task) => task);
  // @ts-expect-error
  domainResult(() => getTask(db, "t"));
  // @ts-expect-error
  readBudgeted("get_task", {}, () => task);
  // @ts-expect-error
  readBudgeted("get_task", {}, () => row);
  // @ts-expect-error
  readBudgeted("get_task", {}, () => ({ ...task, envelope: {} }));
  // @ts-expect-error
  readBudgeted("list_board", {}, () => [task]);
  // @ts-expect-error
  readBudgeted("get_task", {}, () => ({ task }));
  // @ts-expect-error
  packItems(read, "events", events, { ...task });
  // @ts-expect-error
  packItems(read, "items", [task]);
}
{
  // 解決を通った値と、欄を選び出した値は通る
  toolResult(presentTask(db, task));
  toolResult({ ...presentTask(db, task), annotation: 1 });
  toolResult(listBoard(db));
  sendJson(res, listBoard(db));
  toolResult({ id: task.id, type: task.type });
  runVerb(deps, null, (task) => presentTask(db, task));
  domainResult(() => presentTask(db, task));
  readBudgeted("get_task", {}, () => presentTask(db, task));
  readBudgeted("list_board", {}, (read) => packItems(read, "tasks", listBoard(db)));
  packItems(read, "tasks", listBoard(db), { task: presentTask(db, task) });
}
