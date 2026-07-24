import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

async function registerRoot(t: Tidepool, title: string, riskFlag: boolean): Promise<any> {
  return (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title,
      purpose: `purpose of ${title}`,
      completion_criteria: `criteria of ${title}`,
      risk_flag: riskFlag,
    })
  ).json;
}

async function addChild(t: Tidepool, parentId: string, title: string, riskFlag: boolean): Promise<any> {
  return (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title,
      purpose: "p",
      completion_criteria: "c",
      parent_id: parentId,
      risk_flag: riskFlag,
    })
  ).json;
}

it("risk あり親から risk なしへの降格編集は、未決着の risk ありの子がある間 拒否される", async () => {
  t = await bootTidepool();
  const parent = await registerRoot(t, "risky parent", true);
  const child = await addChild(t, parent.id, "risky child", true);
  // parent has risk, so a risk child registers directly (no escalation) —
  // an unsettled, approved risk-bearing child
  expect(child.risk_flag).toBe(1);

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${parent.id}`, { risk_flag: false });

  expect(res.status).toBe(400);
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json;
  expect(after.risk_flag).toBe(1);
});

it("risk あり親の risk ありの子が決着すれば、親を risk なしへ降格できる", async () => {
  t = await bootTidepool();
  const parent = await registerRoot(t, "risky parent", true);
  const risky = await addChild(t, parent.id, "risky child", true);
  // a second, non-risk child keeps the parent blocked after the risk child
  // settles, so it isn't auto-picked-up (which would make it uneditable)
  await addChild(t, parent.id, "plain child", false);

  // cancel the risk child directly (settles it) — the invariant no longer binds
  await api(t.baseUrl, "POST", `/api/tasks/${risky.id}/cancel`, {});

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${parent.id}`, { risk_flag: false });
  expect(res.status).toBe(200);
  expect(res.json.risk_flag).toBe(0);
});

it("子を risk ありへ昇格する編集は許可される(仕様が機械拒否と名指すのは降格のみ — 宣言 risk は注意配分の副次入力)", async () => {
  t = await bootTidepool();
  const parent = await registerRoot(t, "plain parent", false);
  const child = await addChild(t, parent.id, "plain child", false);
  expect(child.risk_flag).toBe(0);

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${child.id}`, { risk_flag: true });

  expect(res.status).toBe(200);
  expect(res.json.risk_flag).toBe(1);
});

it("不変条件を壊さない risk 編集は許可され、旧値がイベントに残る", async () => {
  t = await bootTidepool();
  const root = await registerRoot(t, "lonely root", false);

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${root.id}`, { risk_flag: true });
  expect(res.status).toBe(200);
  expect(res.json.risk_flag).toBe(1);

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${root.id}/events`)).json;
  const edit = events.find((e: any) => e.kind === "task_edited" && e.payload.field === "risk_flag");
  expect(edit.payload.from).toBe("false");
  expect(edit.payload.to).toBe("true");
});
