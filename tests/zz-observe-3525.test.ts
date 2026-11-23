import { expect, it } from "vitest";
import { createLanding } from "../src/landing.js";
import { afterCiRead, awaitWindow, FakeGitHubClient } from "./fakes.js";
import { makeLandingWorkspace, quarantineQuestion } from "./harness.js";
import { commitOutOfBand, completeThroughTaskCheckout, convergeOn, landingWork, openBoard, profile } from "./landing-fixture.js";

it("observe #3525: Quarantine time from the auto_merge tick's compare after readPullRequest await", async () => {
  const { workspace } = await makeLandingWorkspace("observe-3525");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, resolveAuthority: () => profile("auto_if_ci_green") });
  const work = await completeThroughTaskCheckout(db, clock, workspace, landingWork(db, clock), "feature.txt", "ready\n");
  console.log("converge:", JSON.stringify(await convergeOn(landing, work.id)));
  commitOutOfBand(workspace, `task/${work.id}`);
  const gate = awaitWindow();
  afterCiRead(github, gate.hold);

  const tickStart = clock.now().toISOString();
  const tick = landing.tick("auto_merge", clock.now());
  await gate.entered;
  await clock.advance(60_000);
  const afterAwait = clock.now().toISOString();
  gate.open();
  await tick;

  const q = quarantineQuestion(db, "workspace", workspace.name);
  console.log(JSON.stringify({ tickStart, afterAwait, quarantineCreatedAt: q?.created_at, purpose: q?.purpose?.slice(0, 200) }));
  expect(q?.created_at).toBe(afterAwait);
});
