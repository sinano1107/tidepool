import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { WorkspaceConfig } from "../src/workspace.js";
import { api, bootTidepool, makeWorkspace, type Tidepool } from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function questions(t: Tidepool): Promise<any[]> {
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  return list.filter((x: any) => x.type === "question");
}

it("boot 時に登録済み全 workspace を検査し、盤面の状態パスと重なるものを needs-human にする(ADR 0040)", async () => {
  const clean = await makeWorkspace(dirs, "sandbox");
  const overlapping = await makeWorkspace(dirs, "tidepool-self");
  t = await bootTidepool({
    workspace: clean,
    boardState: {
      // 盤面 DB が overlapping の checkout の中にある形
      paths: [{ label: "board database (TIDEPOOL_DB)", path: join(overlapping.path, "board.sqlite") }],
      listWorkspaces: () => [clean, overlapping],
    },
  });

  const list = await questions(t);
  expect(list).toHaveLength(1);
  expect(list[0].title).toContain("tidepool-self");
  expect(list[0].purpose).toContain("board database (TIDEPOOL_DB)");
});

it("起動そのものは拒まない — 早く騒ぐだけで、床は pickup 側(ADR 0036 の fail-open)", async () => {
  const overlapping = await makeWorkspace(dirs, "tidepool-self");
  t = await bootTidepool({
    workspace: overlapping,
    boardState: {
      paths: [{ label: "the board's own checkout (process cwd)", path: overlapping.path }],
      listWorkspaces: () => [overlapping],
    },
  });

  // 人間面は開いたまま(復旧経路)
  expect((await api(t.baseUrl, "GET", "/api/tasks")).status).toBe(200);
});

it("重なったまま再起動しても question は増えない(1資源につき確認は最大1枚 — CONTEXT.md)", async () => {
  const overlapping = await makeWorkspace(dirs, "self");
  const boardState = {
    paths: [{ label: "board database (TIDEPOOL_DB)", path: join(overlapping.path, "board.sqlite") }],
    listWorkspaces: () => [overlapping],
  };
  t = await bootTidepool({ workspace: overlapping, boardState });
  expect(await questions(t)).toHaveLength(1);

  // 直さないまま再起動 — 一斉検査はもう一度撃たれる
  await t.stopServer();
  t = await bootTidepool({ dir: t.dir, workspace: overlapping, boardState });

  expect(await questions(t)).toHaveLength(1);
});

it("workspace の列挙自体が失敗しても起動は続く(registry が壊れていても人間面は開く)", async () => {
  const clean = await makeWorkspace(dirs, "sandbox");
  const listWorkspaces = (): WorkspaceConfig[] => {
    throw new Error("registry clone is unreadable");
  };
  t = await bootTidepool({
    workspace: clean,
    boardState: { paths: [{ label: "board database (TIDEPOOL_DB)", path: "/nowhere/board.sqlite" }], listWorkspaces },
  });

  expect((await api(t.baseUrl, "GET", "/api/tasks")).status).toBe(200);
  expect(await questions(t)).toEqual([]);
});
