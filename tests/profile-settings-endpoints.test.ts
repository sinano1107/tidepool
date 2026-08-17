import { afterEach, expect, it } from "vitest";
import type { CreateProfileInput, UpdateProfileInput } from "../src/profile-create.js";
import { ProfileConfirmationRequiredError } from "../src/profile-create.js";
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

// 危険な値の判定と拒否はドメイン側に1つだけ置く(ADR 0061 決定1)。扉に残る
// 責務は2つ:確認フラグをそのまま domain へ運ぶことと、拒否を 409 の本文に写す
// こと。判定そのものは create-profile / update-profile のテストが見る。
it("POST は ProfileConfirmationRequiredError を 409 + confirm_required + 理由コードに写す", async () => {
  t = await bootTidepool({
    profileAdmin: {
      create: async () => {
        throw new ProfileConfirmationRequiredError("powerful", ["merge_auto_if_ci_green"]);
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
});

it("POST は confirmDangerous をそのまま createProfile へ運ぶ", async () => {
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
  expect(calls).toEqual([
    {
      name: "powerful",
      guidance: "Merges on green.",
      assignable_to: [],
      allowed_workspaces: [],
      merge: "auto_if_ci_green",
      confirmDangerous: true,
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

it("PATCH も同じ拒否を 409 に写す", async () => {
  t = await bootTidepool({
    profileAdmin: {
      update: async () => {
        throw new ProfileConfirmationRequiredError("roaming", ["allowed_workspaces_wildcard"]);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/profiles/roaming", { allowed_workspaces: ["*"] });

  expect(res.status).toBe(409);
  expect(res.json).toEqual({
    error: expect.any(String),
    confirm_required: true,
    dangerous_values: ["allowed_workspaces_wildcard"],
  });
});

it("PATCH も confirmDangerous をそのまま updateProfile へ運ぶ", async () => {
  const calls: UpdateProfileInput[] = [];
  t = await bootTidepool({
    profileAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/profiles/roaming", {
    allowed_workspaces: ["*"],
    confirmDangerous: true,
  });

  expect(res.status).toBe(200);
  expect(calls).toEqual([{ name: "roaming", allowed_workspaces: ["*"], confirmDangerous: true }]);
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
