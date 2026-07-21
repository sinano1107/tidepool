import { afterEach, expect, it } from "vitest";
import { FakeDraftClient } from "./fakes.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/settings/display-language は既定値 Japanese を返す", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "GET", "/api/settings/display-language");
  expect(res.json.language).toBe("Japanese");
});

it("POST /api/settings/display-language で設定を変更でき、GET に反映される", async () => {
  t = await bootTidepool();
  const post = await api(t.baseUrl, "POST", "/api/settings/display-language", {
    language: "English",
  });
  expect(post.status).toBe(200);
  expect(post.json).toEqual({ language: "English" });

  const res = await api(t.baseUrl, "GET", "/api/settings/display-language");
  expect(res.json.language).toBe("English");
});

it("language が空文字、または欠落は 400", async () => {
  t = await bootTidepool();
  const empty = await api(t.baseUrl, "POST", "/api/settings/display-language", { language: "" });
  expect(empty.status).toBe(400);

  const missing = await api(t.baseUrl, "POST", "/api/settings/display-language", {});
  expect(missing.status).toBe(400);

  const res = await api(t.baseUrl, "GET", "/api/settings/display-language");
  expect(res.json.language).toBe("Japanese");
});

it("サポート言語リストにない値(表記ゆれ含む)は 400 になり、既存値は変化しない(issue #115)", async () => {
  t = await bootTidepool();

  for (const invalid of ["japanese", "日本語", "French"]) {
    const res = await api(t.baseUrl, "POST", "/api/settings/display-language", {
      language: invalid,
    });
    expect(res.status).toBe(400);
  }

  const res = await api(t.baseUrl, "GET", "/api/settings/display-language");
  expect(res.json.language).toBe("Japanese");
});

it("サポート言語リストの正規値(Japanese/English)は 200 になる(issue #115)", async () => {
  t = await bootTidepool();

  const en = await api(t.baseUrl, "POST", "/api/settings/display-language", {
    language: "English",
  });
  expect(en.status).toBe(200);

  const ja = await api(t.baseUrl, "POST", "/api/settings/display-language", {
    language: "Japanese",
  });
  expect(ja.status).toBe(200);
});

it("GET はサポート言語一覧を options として返す(issue #115)", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "GET", "/api/settings/display-language");
  expect(res.json).toEqual({ language: "Japanese", options: ["Japanese", "English"] });
});

it("/api/tasks/draft は盤面の表示言語設定を DraftClient.draftTask に渡す(既定 Japanese、変更後は変更後の値)", async () => {
  const draftClient = new FakeDraftClient();
  t = await bootTidepool({ draftClient });

  await api(t.baseUrl, "POST", "/api/tasks/draft", { dump: "水やりのセンサーを設置する" });
  expect(draftClient.languages).toEqual(["Japanese"]);

  await api(t.baseUrl, "POST", "/api/settings/display-language", { language: "English" });
  await api(t.baseUrl, "POST", "/api/tasks/draft", { dump: "set up the sensor" });
  expect(draftClient.languages).toEqual(["Japanese", "English"]);
});

it("/api/tasks/:id/complete/draft は盤面の表示言語設定を DraftClient.draftHandoff に渡す", async () => {
  const draftClient = new FakeDraftClient();
  t = await bootTidepool({ draftClient });

  const task = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "water the tomatoes",
    purpose: "keep plants alive",
    completion_criteria: "soil moist to 5cm",
    assignee: "human",
  });

  await api(t.baseUrl, "POST", "/api/settings/display-language", { language: "English" });
  await api(t.baseUrl, "POST", `/api/tasks/${task.json.id}/complete/draft`, {
    dump: "watered the tomatoes",
  });
  expect(draftClient.handoffLanguages).toEqual(["English"]);
});
