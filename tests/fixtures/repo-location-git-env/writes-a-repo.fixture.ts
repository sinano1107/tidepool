import { it } from "vitest";
import { git, initWorkspaceCheckout, tempDirSync } from "../../harness.js";

// #3334: the git a test spawns —— a bare init, then a fresh checkout with a commit. Under an inherited GIT_DIR both land in it.
it("spawns git that writes a repo", async () => {
  const bare = tempDirSync("tidepool-3334-bare-");
  git(bare, "init", "--quiet", "--bare", bare);
  await initWorkspaceCheckout(tempDirSync("tidepool-3334-checkout-"), "checkout");
});
