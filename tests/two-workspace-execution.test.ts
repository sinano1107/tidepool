import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConfig } from "../src/workspace.js";
import {
  api,
  bootTidepool,
  checkoutOf,
  commitWork,
  completeIntegrationReviews,
  defaultingTo,
  FULL_HANDOFF as fullHandoff,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  makeWorkspace,
  mcpClient,
  queueWork,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

describe("issue #26: 実行側の複数 workspace 対応", () => {
  it("異なる workspace の2タスクがそれぞれの checkout で実行され、片方の quarantine が他方の pickup を止めない", async () => {
    const sandbox = await makeWorkspace("sandbox");
    const prod = await makeWorkspace("prod");
    t = await bootTidepool({
      workspace: sandbox,
      resolveWorkspace: defaultingTo(sandbox, prod),
    });

    // AC1: workspace が異なる2つのタスクが、それぞれの registry workspace
    // の checkout で実行される
    const inSandbox = queueWork(t, "runs in sandbox");
    await t.clock.advance(HOUR);
    expect(t.worker.started.map((x) => x.id)).toEqual([inSandbox.id]);
    // ADR 0356 決定1: タスクブランチはその workspace の名前の場所の ref で、worker はそこから開いた task の checkout で走る
    // (旧: 名前の場所の HEAD がタスクブランチに乗った)
    expectRunsFrom(sandbox, inSandbox.id);

    const c1 = await mcpClient(t.mcpBaseUrl, inSandbox.id);
    await c1.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
    await c1.close();
    await completeIntegrationReviews(t, inSandbox.id);
    // prod のタスクは統合点レビューの後に置く —— 先に置くと、完了の後始末の poll(ADR 0119 決定3)が
    // レビューより先にそれを拾い、レビューを slot へ入れられない
    const inProd = queueWork(t, "runs in prod", "prod");

    await t.clock.advance(HOUR);
    expect(t.worker.started.filter((x) => x.type === "work").map((x) => x.id)).toEqual([inSandbox.id, inProd.id]);
    expectRunsFrom(prod, inProd.id);
    expect(() => git(sandbox.path, "rev-parse", "--verify", `task/${inProd.id}`)).toThrow();
    // sandbox's own checkout was left clean and untouched by prod's pickup
    expect(git(sandbox.path, "status", "--porcelain")).toBe("");

    // break prod's release so completing it quarantines only "prod": an out-of-band commit on prod's main moves a ref
    // the board did not write (ADR 0351). 旧: prod の .git を消した —— 完了の門が tip を引けず完了を拒むようになった(ADR 0356 決定3)
    commitWork(prod.path, "junk.txt", "out of band\n");
    const c2 = await mcpClient(t.mcpBaseUrl, inProd.id);
    await c2.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
    await c2.close();

    const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
    const quarantineQuestion = board.find(
      (x: any) => x.type === "question" && x.title.includes("prod"),
    );
    expect(quarantineQuestion).toBeDefined();

    // AC2: prod のタスクだけ pickup が止まり、sandbox のタスクは流れ続ける
    const stuckInProd = queueWork(t, "stuck", "prod");
    const runsInSandbox = queueWork(t, "keeps flowing", "sandbox");
    await t.clock.advance(HOUR);

    expect(t.worker.started.filter((x) => x.type === "work").map((x) => x.id)).toEqual([
      inSandbox.id,
      inProd.id,
      runsInSandbox.id,
    ]);
    expect(t.worker.started.map((x) => x.id)).not.toContain(stuckInProd.id);
    expectRunsFrom(sandbox, runsInSandbox.id);
  });
});

/** task の checkout がその名前の場所から開き(alternates がその objects を指す)タスクブランチに乗り、名前の場所の HEAD は main のまま。 */
function expectRunsFrom(named: WorkspaceConfig, taskId: string): void {
  const checkout = checkoutOf(t.db, taskId);
  expect(git(checkout, "symbolic-ref", "--short", "HEAD")).toBe(`task/${taskId}`);
  expect(readFileSync(join(checkout, ".git", "objects", "info", "alternates"), "utf8").trim()).toBe(realpathSync(join(named.path, ".git", "objects")));
  expect(git(named.path, "rev-parse", "--verify", `task/${taskId}`)).not.toBe("");
  expect(git(named.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
}
