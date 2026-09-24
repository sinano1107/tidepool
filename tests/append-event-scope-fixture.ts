// 型の負テスト(webui/wire-contract-fixture.ts と同じ形、issue #927)。`npm run typecheck` にだけ効き、
// `.test.ts` ではないので vitest は拾わない。宣言だけで値を持たず、DB には触れない。
import type { Db } from "../src/db.js";
import { appendEvent } from "../src/events.js";

declare const db: Db;
declare const at: Date;
{
  // 盤面スコープでない kind は taskId: null で書けない
  // @ts-expect-error
  appendEvent(db, { taskId: null, workerId: "w", origin: "board", payload: { kind: "task_picked_up" }, at });
  // 盤面スコープの kind は task に帰属させて書けない
  // @ts-expect-error
  appendEvent(db, { taskId: "t", workerId: "w", origin: "mcp", payload: { kind: "memory_settings_changed", injection_token_cap: 1 }, at });
}
