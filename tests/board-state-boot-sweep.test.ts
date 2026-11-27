import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { openDb } from "../src/db.js";
import { sweepBoardStateOverlap, type WorkspaceConfig } from "../src/workspace.js";
import { api, bootTidepool, GIT_FIXTURE_TEST_TIMEOUT, makeWorkspace, quarantineQuestion, type Tidepool } from "./harness.js";
import { makeRegistry, registryCloneOverlap, registryFixedPoints } from "./registry-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

async function questions(t: Tidepool): Promise<any[]> {
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  return list.filter((x: any) => x.type === "question");
}

it("boot 時に登録済み全 workspace を検査し、盤面の状態パスと重なるものを needs-human にする(ADR 0040)", async () => {
  const clean = await makeWorkspace("sandbox");
  const overlapping = await makeWorkspace("tidepool-self");
  t = await bootTidepool({
    workspace: clean,
    boardState: {
      // 盤面 DB が overlapping の checkout の中にある形
      paths: [{ label: "board home (TIDEPOOL_HOME)", path: join(overlapping.path, "board.sqlite") }],
      listWorkspaces: () => [clean, overlapping],
    },
  });

  const list = await questions(t);
  expect(list).toHaveLength(1);
  expect(list[0].title).toContain("tidepool-self");
  expect(list[0].purpose).toContain("board home (TIDEPOOL_HOME)");
});

it("起動そのものは拒まない — 早く騒ぐだけで、床は pickup 側(ADR 0036 の fail-open)", async () => {
  const overlapping = await makeWorkspace("tidepool-self");
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

it("重なったまま再起動しても question は増えない(1資源につき確認は最大1枚 — GLOSSARY.md)", async () => {
  const overlapping = await makeWorkspace("self");
  const boardState = {
    paths: [{ label: "board home (TIDEPOOL_HOME)", path: join(overlapping.path, "board.sqlite") }],
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
  const clean = await makeWorkspace("sandbox");
  const listWorkspaces = (): WorkspaceConfig[] => {
    throw new Error("registry clone is unreadable");
  };
  t = await bootTidepool({
    workspace: clean,
    boardState: { paths: [{ label: "board home (TIDEPOOL_HOME)", path: "/nowhere/board.sqlite" }], listWorkspaces },
  });

  expect((await api(t.baseUrl, "GET", "/api/tasks")).status).toBe(200);
  expect(await questions(t)).toEqual([]);
});

// ADR 0377 決定3: 手で足した registry clone の entry は boot の一斉検査が spec #3273 text E1 で Quarantine する
it("registry clone に重なる entry は boot の一斉検査で spec #3273 text E1 の Quarantine になる", async () => {
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const clean = await makeWorkspace("sandbox");
  const registryDir = await makeRegistry();
  const paths = registryFixedPoints(registryDir);

  sweepBoardStateOverlap(db, paths, () => [clean, { name: "registry", path: registryDir }], new Date());

  expect(quarantineQuestion(db, "workspace", "registry")?.purpose).toContain(registryCloneOverlap(registryDir, registryDir));
  expect(quarantineQuestion(db, "workspace", "sandbox")).toBeUndefined();
});
