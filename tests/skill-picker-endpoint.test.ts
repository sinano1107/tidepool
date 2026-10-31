import { afterEach, expect, it, vi } from "vitest";
import { enumerateHostSkills } from "../src/claude-worker.js";
import { FakeContainerRuntime, recordingSpawn } from "./fakes.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

// GET /api/skills は skills ピッカーの候補源(issue #106 / ADR 0025 点4)。
// 中立 cwd の列挙結果は @host 集合そのものなので、そのまま返す(スコープ語
// "*"/@workspace/@host は UI 側が足す)。他の settings 系(agents/workspaces/
// profiles)が未配線で 503 なのと違い、ここは入力補助なので縮退させる:
// 失敗・未配線でも 200 + degraded を返し、ピッカーはスコープ語+自由入力で動く。
it("GET /api/skills は列挙された @host skill を degraded:false で返す(issue #106)", async () => {
  t = await bootTidepool({
    hostSkills: async () => ["deep-research", "plugin-a:foo", "plugin-a:bar"],
  });

  const res = await api(t.baseUrl, "GET", "/api/skills");

  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    skills: ["deep-research", "plugin-a:foo", "plugin-a:bar"],
    degraded: false,
  });
});

it("GET /api/skills は列挙失敗(null)を空候補+degraded:true に縮退する(issue #106)", async () => {
  t = await bootTidepool({ hostSkills: async () => null });

  const res = await api(t.baseUrl, "GET", "/api/skills");

  expect(res.status).toBe(200);
  expect(res.json).toEqual({ skills: [], degraded: true });
});

it("GET /api/skills は未配線でも 503 でなく空候補+degraded:true(issue #106)", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "GET", "/api/skills");

  expect(res.status).toBe(200);
  expect(res.json).toEqual({ skills: [], degraded: true });
});

// ADR 0335 決定2: 候補の出所は spawn の同梱集合と同じ1関数で、worker と同じ tier フラグで撃つ —— user 層の skill は候補に出ない
it("GET /api/skills の同梱集合の列挙は --setting-sources project で撃つ", async () => {
  const recorder = recordingSpawn();
  t = await bootTidepool({
    containerRuntime: new FakeContainerRuntime(recorder.spawn),
    hostSkills: enumerateHostSkills,
    harnessContainment: async () => ({ available: true }),
  });

  const pending = api(t.baseUrl, "GET", "/api/skills");
  await vi.waitFor(() => expect(recorder.calls).toHaveLength(1));
  recorder.emitExit(0, null);
  await pending;

  const { args } = recorder.calls[0]!;
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
});
