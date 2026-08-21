import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tokenPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-secrets-"));
  dirs.push(dir);
  return join(dir, "github-token");
}

async function loggedIn(): Promise<boolean> {
  return (await api(t.baseUrl, "GET", "/api/settings/github")).json.loggedIn;
}

// ADR 0093 決定5: settings は状態表示だけを持つ(ログインの扉は端末にしか無い)。
// 読み直しは**毎回**である —— ログインは盤面の外で起きるので、起動時に解決した
// 身元を映すと「ログインしたのに未ログインのまま」が再起動まで続く(決定5 の
// 「再ログインに再起動は要らない」がここでも効く)。
it("GET /api/settings/github はログイン状態をファイルの実在から毎回読み直す", async () => {
  const file = await tokenPath();
  t = await bootTidepool({ githubTokenFile: file });

  expect(await loggedIn()).toBe(false);

  writeFileSync(file, "gho_user_token\n");
  chmodSync(file, 0o600);

  expect(await loggedIn()).toBe(true);
});

// fail-closed の線(issue #50)と同じ検査を共有する: mode が広いファイルは
// GitHub 機能そのものが off なので、settings も「ログイン済み」とは言わない。
it("mode 600 より広いトークンファイルは未ログインとして出る", async () => {
  const file = await tokenPath();
  writeFileSync(file, "gho_user_token\n");
  chmodSync(file, 0o644);
  t = await bootTidepool({ githubTokenFile: file });

  expect(await loggedIn()).toBe(false);
});

it("パス未設定の盤面は未ログイン", async () => {
  t = await bootTidepool();
  expect(await loggedIn()).toBe(false);
});
