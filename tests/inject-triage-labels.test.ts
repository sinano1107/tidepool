import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LABELS = readFileSync(join(ROOT, "docs/agents/triage-labels.md"), "utf8");

const hook = (event: object) =>
  spawnSync("node", [join(ROOT, "scripts/inject-triage-labels.mjs")], { input: JSON.stringify(event), encoding: "utf8" });
const run = (command: string, session_id?: string) =>
  hook({ hook_event_name: "PreToolUse", session_id, tool_name: "Bash", tool_input: { command } });
const LABEL_COMMAND = "gh issue edit 1 --add-label x";
const injected = (result: { stdout: string }): string => JSON.parse(result.stdout).hookSpecificOutput.additionalContext;

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

  it("同じ session の2回目以降は何も出さず、別の session には出す", () => {
    const session = randomUUID();
    expect(injected(run(LABEL_COMMAND, session))).toContain(LABELS);
    expect(run(LABEL_COMMAND, session).stdout).toBe("");
    expect(injected(run(LABEL_COMMAND, randomUUID()))).toContain(LABELS);
  });

  it("SessionStart(compact / clear)の後は同じ session にもう一度出す", () => {
    const session = randomUUID();
    run(LABEL_COMMAND, session);
    expect(hook({ hook_event_name: "SessionStart", session_id: session, source: "compact" }).stdout).toBe("");
    expect(injected(run(LABEL_COMMAND, session))).toContain(LABELS);
  });

  const denied = (result: { stdout: string }) => JSON.parse(result.stdout).hookSpecificOutput;

  it.each([
    "gh issue create --title t --body-file b.md --label needs-info",
    "gh issue create --title t --body-file b.md --label bug,needs-info",
    "gh issue create --title t --body-file b.md --label=needs-info",
    "gh issue edit 1596 --add-label 'needs-info'",
  ])("verify:* の無い needs-info は、実行前に1度だけ拒否し、同じコマンドの再実行は通す: %s", (command) => {
    const session = randomUUID();
    const first = denied(run(command, session));
    expect(first.permissionDecision).toBe("deny");
    expect(first.permissionDecisionReason).toContain("verify:production");
    expect(injected(run(command, session))).toContain(LABELS);
  });

  it.each([
    "gh issue create --title t --body-file b.md --label needs-info,verify:production",
    "gh issue create --title t --body-file b.md --label needs-info --label verify:production",
    "gh issue edit 1 --add-label needs-info --add-label verify:production",
    "gh issue edit 1 --remove-label needs-info",
    "gh pr create --title t --label needs-info",
  ])("verify:* を伴うか、needs-info を足さないなら拒否しない: %s", (command) => {
    expect(denied(run(command, randomUUID())).permissionDecision).toBeUndefined();
  });
});
