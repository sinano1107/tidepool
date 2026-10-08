import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("HTTP validation errors identify the invalid field and its reason (#1585)", async () => {
  t = await bootTidepool();
  expect(await api(t.baseUrl, "POST", "/api/settings/memory", { injection_token_cap: 0 })).toMatchObject({
    status: 400,
    json: { error: "injection_token_cap: Too small: expected number to be >0" },
  });
});

it("HTTP strict-schema errors have a reason without an empty path prefix (#1585)", async () => {
  t = await bootTidepool();
  expect(await api(t.baseUrl, "PATCH", "/api/tasks/unknown", { type: "work" })).toMatchObject({
    status: 400,
    json: { error: 'Unrecognized key: "type"' },
  });
});

it("HTTP validation errors join all reasons with dot-separated field paths (#1585)", async () => {
  t = await bootTidepool();
  expect(await api(t.baseUrl, "POST", "/api/tasks", { type: "work", title: 123, review_by: [""] })).toMatchObject({
    status: 400,
    json: { error: "title: Invalid input: expected string, received number; review_by.0: Too small: expected string to have >=1 characters" },
  });
});
