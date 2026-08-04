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

/** 重なりで quarantine された盤面を起こす。workspace の解決は registry 相当の
 *  可変ポインタ越しに行い、「人間が registry を直して別の checkout を指させた」を
 *  テストの中で再現できるようにする(ADR 0009: 解決は毎回 fresh)。 */
async function bootWithOverlap(): Promise<{ live: { path: string }; questionId: string }> {
  const overlapping = await makeWorkspace(dirs, "self");
  const live = { path: overlapping.path };
  const resolve = (name: string | null): WorkspaceConfig => ({
    name: name ?? "self",
    path: live.path,
  });
  t = await bootTidepool({
    resolveWorkspace: resolve,
    boardState: {
      paths: [{ label: "board database (TIDEPOOL_DB)", path: join(overlapping.path, "board.sqlite") }],
      listWorkspaces: () => [{ name: "self", path: live.path }],
    },
  });
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "question",
  );
  expect(question).toBeDefined();
  return { live, questionId: question.id };
}

it("重なりが残ったままの「直した」回答は拒否され、question は open のまま(ADR 0040)", async () => {
  const { questionId } = await bootWithOverlap();

  // ツリーは初めからクリーン — 既存の検証(registry に存在し、ツリーがクリーン)は
  // 通るが、重なりの再検査が通さない
  const res = await api(t.baseUrl, "POST", `/api/tasks/${questionId}/answer`, {
    answers: ["repaired by hand"],
  });

  expect(res.status).toBe(409);
  expect(res.json.error).toContain("board database (TIDEPOOL_DB)");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${questionId}`)).json.status).toBe("todo");
});

it("workspace を交差しない checkout へ指し直せば回答は受理される", async () => {
  const { live, questionId } = await bootWithOverlap();
  const elsewhere = await makeWorkspace(dirs, "elsewhere");
  // 人間の修理: registry のエントリを別の checkout へ向け直した
  live.path = elsewhere.path;

  const res = await api(t.baseUrl, "POST", `/api/tasks/${questionId}/answer`, {
    answers: ["repaired by hand"],
  });

  expect(res.status).toBe(200);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${questionId}`)).json.status).toBe("done");
});
