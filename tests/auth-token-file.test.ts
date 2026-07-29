import { statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  bootstrapNotice,
  hashToken,
  readTokenHash,
  resolveTokenFile,
  rotateToken,
} from "../src/auth.js";
import { startServer, type TidepoolServer } from "../src/server.js";
import { FakeClock, ScriptedWorker } from "./fakes.js";

let server: TidepoolServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await server?.stop();
  server = undefined;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-token-"));
  dirs.push(dir);
  return dir;
}

// #151: work プロファイルの worker は Read ツールで cwd 外の任意パスを読める。
// 平文はどこに置いても読まれるので、盤面側の複製は存在させない(ADR 0036)。
it("盤面はハッシュだけを保存し、平文はディスクに残さない(issue #153 / ADR 0036)", async () => {
  const dir = await tempDir();
  const tokenFile = join(dir, "api-token");
  const token = rotateToken(tokenFile);

  const stored = readTokenHash(tokenFile);
  expect(stored).toBe(hashToken(token));
  expect(stored).toMatch(/^[0-9a-f]{64}$/);
  // ファイルの中身に平文が現れないこと(ハッシュ以外は何も書かない)
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(tokenFile, "utf8")).not.toContain(token);
  // ハッシュとはいえ、書くのは 600 — group/other に読ませる理由がない
  expect(statSync(tokenFile).mode & 0o077).toBe(0);
});

it("ハッシュの既定の置き場所は盤面ディレクトリの外(issue #153 / #149)", () => {
  expect(resolveTokenFile(undefined)).toBe(join(homedir(), ".tidepool", "api-token"));
  expect(resolveTokenFile("/etc/tidepool/api-token")).toBe("/etc/tidepool/api-token");
});

it("壊れた/欠けたハッシュファイルは undefined(issue #153)", async () => {
  const dir = await tempDir();
  expect(readTokenHash(join(dir, "does-not-exist"))).toBeUndefined();

  const empty = join(dir, "empty");
  await writeFile(empty, "");
  expect(readTokenHash(empty)).toBeUndefined();

  // hex 64 桁でないものを「ハッシュ」として受けると、timingSafeEqual が長さ
  // 不一致で投げて全リクエストが 500 になる
  const garbage = join(dir, "garbage");
  await writeFile(garbage, "not a hash\n");
  expect(readTokenHash(garbage)).toBeUndefined();
});

// ローテーションは管理MCP の設定も壊す(issue #153 のコメント): token を得る唯一の
// 手段がローテーションになったので、そのたびに `~/.claude.json` に保存された bearer
// ヘッダが無効になり `claude mcp add --header` の再実行が要る。初回のローテーションで
// 人間がそれを発見する前に、出力で知らせる。
it("ローテーションの出力は管理MCP の bearer 再設定を促す(issue #153)", () => {
  const rotated = bootstrapNotice({
    token: "TOKEN-XYZ",
    tokenFile: "/home/masaki/.tidepool/api-token",
    origins: ["http://127.0.0.1:4589", "https://raspberrypi.tailc0084f.ts.net:8443"],
    rotated: true,
  });

  expect(rotated).toContain("TOKEN-XYZ");
  // 書いた先を必ず印字する — HOME の違う実行(sudo 越し)で別ファイルに書いて
  // 「ローテーションしたのに通らない」になったとき、これが唯一の手がかりになる
  expect(rotated).toContain("/home/masaki/.tidepool/api-token");
  // 盤面が知る全オリジンぶんの bootstrap URL(cookie はオリジン単位)
  expect(rotated).toContain("http://127.0.0.1:4589/auth?token=TOKEN-XYZ");
  expect(rotated).toContain("https://raspberrypi.tailc0084f.ts.net:8443/auth?token=TOKEN-XYZ");
  expect(rotated).toContain("claude mcp add");
  // 平文は二度と読めない = 保管を促す
  expect(rotated.toLowerCase()).toContain("cannot be shown again");

  // 初回起動の表示には管理MCP の再設定は要らない(まだ何も設定されていない)
  const first = bootstrapNotice({
    token: "TOKEN-XYZ",
    tokenFile: "/home/masaki/.tidepool/api-token",
    origins: ["http://127.0.0.1:4589"],
    rotated: false,
  });
  expect(first).not.toContain("claude mcp add");
});

/** 盤面を1台、ハッシュをファイルから毎回読み直す形で起こす。 */
async function bootWithTokenFile(tokenFile: string): Promise<TidepoolServer> {
  const dir = await tempDir();
  const clock = new FakeClock();
  return startServer({
    dbPath: join(dir, "board.sqlite"),
    port: 0,
    mcpPort: 0,
    clock,
    credential: { tokenHash: () => readTokenHash(tokenFile) },
    worker: () => new ScriptedWorker(clock),
  });
}

const board = (s: TidepoolServer, token: string) =>
  fetch(`http://127.0.0.1:${s.port}/api/tasks`, {
    headers: { authorization: `Bearer ${token}` },
  });

// `npm run token` は再表示ではなくローテーション(ADR 0036)。盤面を再起動せずに
// 効かなければ、ローテーション手順が「盤面を落として上げる」を含むことになる。
it("ローテーションは再起動なしに効き、古い token を失効させる(issue #153)", async () => {
  const dir = await tempDir();
  const tokenFile = join(dir, "api-token");
  const first = rotateToken(tokenFile);
  server = await bootWithTokenFile(tokenFile);

  expect((await board(server, first)).status).toBe(200);

  const second = rotateToken(tokenFile);
  expect((await board(server, second)).status).toBe(200);
  expect((await board(server, first)).status).toBe(401);
});

// #154(封じ込め能力ゲートの拡張)が入るまで、ADR 0036 の「人間面は fail-open」は
// 採らない — あれは pickup ゲートが worker を1枚も走らせないことと対になっており、
// 片方だけ実装すると裸の盤面になる。ハッシュを失った盤面は起動はするが全部 401。
it("ハッシュを持たない盤面は無認証で開かず、全部 401(issue #153)", async () => {
  const dir = await tempDir();
  server = await bootWithTokenFile(join(dir, "never-written"));
  expect((await board(server, "anything")).status).toBe(401);
  const page = await fetch(`http://127.0.0.1:${server.port}/`);
  await page.text();
  expect(page.status).toBe(401);
});
