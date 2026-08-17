import { afterEach, expect, it } from "vitest";
import type { CreateProfileInput, UpdateProfileInput } from "../src/profile-create.js";
import { InvalidAuthorityProfileNameError, UnknownAuthorityProfileError } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("POST /api/profiles は profile を createProfile へ渡し、201 を返す", async () => {
  const calls: CreateProfileInput[] = [];
  t = await bootTidepool({
    profileAdmin: {
      create: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/profiles", {
    name: "restricted",
    guidance: "Stay in your lane.",
    assignable_to: [],
    allowed_workspaces: [],
    merge: "escalate",
  });

  expect(res.status).toBe(201);
  expect(res.json).toEqual({});
  expect(calls).toEqual([
    {
      name: "restricted",
      guidance: "Stay in your lane.",
      assignable_to: [],
      allowed_workspaces: [],
      merge: "escalate",
    },
  ]);
});

it("GET /api/profiles は編集フォーム用に全フィールドを返す", async () => {
  t = await bootTidepool({
    profileAdmin: {
      list: () => [
        {
          name: "restricted",
          guidance: "Stay in your lane.",
          assignable_to: ["tako"],
          allowed_workspaces: ["tidepool"],
          merge: "escalate",
        },
      ],
    },
  });

  const res = await api(t.baseUrl, "GET", "/api/profiles");

  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    profiles: [
      {
        name: "restricted",
        guidance: "Stay in your lane.",
        assignable_to: ["tako"],
        allowed_workspaces: ["tidepool"],
        merge: "escalate",
      },
    ],
  });
});

it("GET /api/profiles は registry 未設定なら 503", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "GET", "/api/profiles")).status).toBe(503);
});

it("危険値 + confirmDangerous なしは 409 で理由コードを返し、保存しない", async () => {
  const calls: CreateProfileInput[] = [];
  t = await bootTidepool({
    profileAdmin: {
      create: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/profiles", {
    name: "powerful",
    guidance: "Merges on green.",
    assignable_to: [],
    allowed_workspaces: [],
    merge: "auto_if_ci_green",
  });

  expect(res.status).toBe(409);
  expect(res.json).toEqual({
    error: expect.any(String),
    confirm_required: true,
    dangerous_values: ["merge_auto_if_ci_green"],
  });
  // the contract is "cannot be saved", not just "returns 409": the domain verb
  // must never run
  expect(calls).toEqual([]);
});

it("assignable_to の wildcard も confirm なしは 409 で対応コードを返す", async () => {
  t = await bootTidepool({
    profileAdmin: { create: async () => {} },
  });

  const res = await api(t.baseUrl, "POST", "/api/profiles", {
    name: "broad",
    guidance: "Can delegate to anyone.",
    assignable_to: ["*"],
    allowed_workspaces: [],
    merge: "escalate",
  });

  expect(res.status).toBe(409);
  expect(res.json.dangerous_values).toEqual(["assignable_to_wildcard"]);
});

it("allowed_workspaces の wildcard も confirm なしは 409 で対応コードを返す", async () => {
  t = await bootTidepool({
    profileAdmin: { create: async () => {} },
  });

  const res = await api(t.baseUrl, "POST", "/api/profiles", {
    name: "roaming",
    guidance: "Any workspace.",
    assignable_to: [],
    allowed_workspaces: ["*"],
    merge: "escalate",
  });

  expect(res.status).toBe(409);
  expect(res.json.dangerous_values).toEqual(["allowed_workspaces_wildcard"]);
});

it("危険値 + confirmDangerous: true は保存が通り、フラグは domain に渡さない", async () => {
  const calls: CreateProfileInput[] = [];
  t = await bootTidepool({
    profileAdmin: {
      create: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/profiles", {
    name: "powerful",
    guidance: "Merges on green.",
    assignable_to: [],
    allowed_workspaces: [],
    merge: "auto_if_ci_green",
    confirmDangerous: true,
  });

  expect(res.status).toBe(201);
  expect(res.json).toEqual({});
  expect(calls).toEqual([
    {
      name: "powerful",
      guidance: "Merges on green.",
      assignable_to: [],
      allowed_workspaces: [],
      merge: "auto_if_ci_green",
    },
  ]);
});

it("PATCH /api/profiles/:name は URL の名前と body を updateProfile へ渡し、200 を返す", async () => {
  const calls: UpdateProfileInput[] = [];
  t = await bootTidepool({
    profileAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/profiles/restricted", {
    guidance: "Updated guidance.",
    assignable_to: ["tako"],
    allowed_workspaces: ["tidepool"],
    merge: "escalate",
  });

  expect(res.status).toBe(200);
  expect(res.json).toEqual({});
  expect(calls).toEqual([
    {
      name: "restricted",
      guidance: "Updated guidance.",
      assignable_to: ["tako"],
      allowed_workspaces: ["tidepool"],
      merge: "escalate",
    },
  ]);
});

it("編集でも危険値 + confirm なしは 409 で拒否し、保存しない", async () => {
  const calls: UpdateProfileInput[] = [];
  t = await bootTidepool({
    profileAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/profiles/roaming", {
    guidance: "Now roams everywhere.",
    assignable_to: [],
    allowed_workspaces: ["*"],
    merge: "escalate",
  });

  expect(res.status).toBe(409);
  expect(res.json.dangerous_values).toEqual(["allowed_workspaces_wildcard"]);
  expect(calls).toEqual([]);
});

it("編集でも confirmDangerous: true なら保存が通る", async () => {
  const calls: UpdateProfileInput[] = [];
  t = await bootTidepool({
    profileAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/profiles/roaming", {
    guidance: "Now roams everywhere.",
    assignable_to: [],
    allowed_workspaces: ["*"],
    merge: "escalate",
    confirmDangerous: true,
  });

  expect(res.status).toBe(200);
  expect(calls).toEqual([
    {
      name: "roaming",
      guidance: "Now roams everywhere.",
      assignable_to: [],
      allowed_workspaces: ["*"],
      merge: "escalate",
    },
  ]);
});

it("編集対象の未知 name(UnknownAuthorityProfileError)は 404", async () => {
  t = await bootTidepool({
    profileAdmin: {
      update: async () => {
        throw new UnknownAuthorityProfileError("ghost");
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/profiles/ghost", {
    guidance: "g",
    assignable_to: [],
    allowed_workspaces: [],
    merge: "escalate",
  });

  expect(res.status).toBe(404);
});

it("不正入力は 400(POST/PATCH とも zod で拒否)", async () => {
  t = await bootTidepool({
    profileAdmin: {
      create: async () => {},
      update: async () => {},
    },
  });

  // name 欠落
  expect(
    (await api(t.baseUrl, "POST", "/api/profiles", { guidance: "g", assignable_to: [], allowed_workspaces: [], merge: "escalate" })).status,
  ).toBe(400);
  // 未知キー(strictObject を extend しても strict が残る)
  expect(
    (
      await api(t.baseUrl, "PATCH", "/api/profiles/x", {
        guidance: "g",
        assignable_to: [],
        allowed_workspaces: [],
        merge: "escalate",
        bogus: 1,
      })
    ).status,
  ).toBe(400);
});

it("registry の push 失敗(RegistryPushFailedError)は致命 — 502(ADR 0052 決定1)", async () => {
  t = await bootTidepool({
    profileAdmin: {
      create: async () => {
        throw new RegistryPushFailedError("non-fast-forward");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/profiles", {
    name: "restricted",
    guidance: "g",
    assignable_to: [],
    allowed_workspaces: [],
    merge: "escalate",
  });

  expect(res.status).toBe(502);
});

it("POST/PATCH は profileAdmin 未設定なら 503", async () => {
  t = await bootTidepool();
  expect(
    (await api(t.baseUrl, "POST", "/api/profiles", { name: "x", guidance: "g", assignable_to: [], allowed_workspaces: [], merge: "escalate" })).status,
  ).toBe(503);
  expect(
    (await api(t.baseUrl, "PATCH", "/api/profiles/x", { guidance: "g", assignable_to: [], allowed_workspaces: [], merge: "escalate" })).status,
  ).toBe(503);
});

it("不正な profile 名(InvalidAuthorityProfileNameError)は 400", async () => {
  t = await bootTidepool({
    profileAdmin: {
      create: async () => {
        throw new InvalidAuthorityProfileNameError("bad name", "invalid charset");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/profiles", {
    name: "bad name",
    guidance: "g",
    assignable_to: [],
    allowed_workspaces: [],
    merge: "escalate",
  });

  expect(res.status).toBe(400);
});

it("その他の外部失敗は 502", async () => {
  t = await bootTidepool({
    profileAdmin: {
      create: async () => {
        throw new Error("git push exited 128");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/profiles", {
    name: "restricted",
    guidance: "g",
    assignable_to: [],
    allowed_workspaces: [],
    merge: "escalate",
  });

  expect(res.status).toBe(502);
});

// --- 部分パッチ(issue #266 / ADR 0086) ---

/** 部分パッチ系のテストが共有する形: update だけ配線し、届いた入力を集める。 */
async function bootUpdateOnly(calls: UpdateProfileInput[]): Promise<Tidepool> {
  return bootTidepool({
    profileAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });
}

it("PATCH は触っていないフィールドを載せない — guidance だけのパッチは 409 にならず、そのまま届く", async () => {
  const calls: UpdateProfileInput[] = [];
  t = await bootUpdateOnly(calls);

  const res = await api(t.baseUrl, "PATCH", "/api/profiles/roamer", { guidance: "Reworded." });

  expect(res.status).toBe(200);
  expect(calls).toEqual([{ name: "roamer", guidance: "Reworded." }]);
});

it("PATCH で危険な値を書いたら confirmDangerous なしは 409 + 理由コード", async () => {
  const calls: UpdateProfileInput[] = [];
  t = await bootUpdateOnly(calls);

  const res = await api(t.baseUrl, "PATCH", "/api/profiles/roamer", { merge: "auto_if_ci_green" });

  expect(res.status).toBe(409);
  expect(res.json.confirm_required).toBe(true);
  expect(res.json.dangerous_values).toEqual(["merge_auto_if_ci_green"]);
  expect(calls).toEqual([]);
});

it("PATCH の危険な値も confirmDangerous: true なら通り、フラグは domain へ渡らない", async () => {
  const calls: UpdateProfileInput[] = [];
  t = await bootUpdateOnly(calls);

  const res = await api(t.baseUrl, "PATCH", "/api/profiles/roamer", {
    assignable_to: ["*"],
    confirmDangerous: true,
  });

  expect(res.status).toBe(200);
  expect(calls).toEqual([{ name: "roamer", assignable_to: ["*"] }]);
});

it("PATCH の空配列は安全側 — 確認なしで通る", async () => {
  const calls: UpdateProfileInput[] = [];
  t = await bootUpdateOnly(calls);

  const res = await api(t.baseUrl, "PATCH", "/api/profiles/roamer", {
    assignable_to: [],
    allowed_workspaces: [],
  });

  expect(res.status).toBe(200);
  expect(calls).toEqual([{ name: "roamer", assignable_to: [], allowed_workspaces: [] }]);
});

it("空パッチ {} は 200 — no-change の扱いは domain 側(コミットなしの成功)", async () => {
  const calls: UpdateProfileInput[] = [];
  t = await bootUpdateOnly(calls);

  const res = await api(t.baseUrl, "PATCH", "/api/profiles/roamer", {});

  expect(res.status).toBe(200);
  expect(calls).toEqual([{ name: "roamer" }]);
});

it("部分パッチでも未知キーは 400 — strict は緩めない", async () => {
  const calls: UpdateProfileInput[] = [];
  t = await bootUpdateOnly(calls);

  expect((await api(t.baseUrl, "PATCH", "/api/profiles/roamer", { bogus: 1 })).status).toBe(400);
  expect(calls).toEqual([]);
});
