import { afterEach, expect, it } from "vitest";
import { bootPreview } from "./preview.js";

let preview: Awaited<ReturnType<typeof bootPreview>>;

afterEach(async () => {
  await preview?.stop();
});

it("bootPreview は bootstrap 済み URL で設定画面を返す(issue #202)", async () => {
  preview = await bootPreview();

  const bootstrap = await fetch(preview.url, { redirect: "manual" });
  const [cookie] = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1);
  if (!cookie) throw new Error("preview bootstrap did not set a cookie");

  expect((await fetch(new URL("/", preview.url), { headers: { cookie } })).status).toBe(200);
});
