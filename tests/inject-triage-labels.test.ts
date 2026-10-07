import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LABELS = readFileSync(join(ROOT, "docs/agents/triage-labels.md"), "utf8");

const run = (command: string) =>
  spawnSync("node", [join(ROOT, "scripts/inject-triage-labels.mjs")], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });

describe("inject-triage-labels hook", () => {
  it.each([
    "gh issue create --title t --body-file b.md",
    "gh issue create --title t --body-file b.md --label needs-info",
    "gh issue edit 1540 --add-label verify:production",
    "gh issue edit 1416 --remove-label needs-triage",
    "gh pr create --title t --label ready-for-human",
    "cd /repo && gh issue edit 1 --add-label x",
  ])("起票・ラベル操作では triage-labels.md の全文を止めずに注入する: %s", (command) => {
    const result = run(command);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.additionalContext).toContain(LABELS);
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it.each(["gh issue view 1538", "gh issue comment 1538 --body-file c.md", "gh pr create --title t", "git status"])(
    "それ以外のコマンドでは何も出さない: %s",
    (command) => {
      const result = run(command);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    },
  );
});
