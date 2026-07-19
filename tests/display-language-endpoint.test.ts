import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/settings/display-language は既定値 Japanese を返す", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "GET", "/api/settings/display-language");
  expect(res.json).toEqual({ language: "Japanese" });
});

it("POST /api/settings/display-language で設定を変更でき、GET に反映される", async () => {
  t = await bootTidepool();
  const post = await api(t.baseUrl, "POST", "/api/settings/display-language", {
    language: "English",
  });
  expect(post.status).toBe(200);
  expect(post.json).toEqual({ language: "English" });

  const res = await api(t.baseUrl, "GET", "/api/settings/display-language");
  expect(res.json).toEqual({ language: "English" });
});

it("language が空文字、または欠落は 400", async () => {
  t = await bootTidepool();
  const empty = await api(t.baseUrl, "POST", "/api/settings/display-language", { language: "" });
  expect(empty.status).toBe(400);

  const missing = await api(t.baseUrl, "POST", "/api/settings/display-language", {});
  expect(missing.status).toBe(400);

  const res = await api(t.baseUrl, "GET", "/api/settings/display-language");
  expect(res.json).toEqual({ language: "Japanese" });
});
