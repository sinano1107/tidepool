import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let home: string | undefined;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function runSeed(cwdArg: string | undefined, options: { cwd?: string } = {}) {
  home = mkdtempSync(join(tmpdir(), "tidepool-seed-claude-trust-"));
  const args = ["scripts/seed-claude-trust.mjs", ...(cwdArg === undefined ? [] : [cwdArg])];
  const result = spawnSync("node", args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return { result, home, claudeJsonPath: join(home, ".claude.json") };
}

describe("node scripts/seed-claude-trust.mjs", () => {
  it("fails with a non-zero exit and an English stderr message when the cwd argument is missing", () => {
    const { result, claudeJsonPath } = runSeed(undefined);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/^Error: /);
    expect(existsSync(claudeJsonPath)).toBe(false);
  });

  it("creates ~/.claude.json with the project marked trusted when none exists yet", () => {
    const projectCwd = "/home/masaki/tidepool";
    const { result, claudeJsonPath } = runSeed(projectCwd);

    expect(result.status, result.stderr).toBe(0);
    const written = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    expect(written).toEqual({
      projects: { [projectCwd]: { hasTrustDialogAccepted: true } },
    });
  });

  it("preserves other top-level keys, other project entries, and other keys under the same project", () => {
    const projectCwd = "/home/masaki/tidepool";
    home = mkdtempSync(join(tmpdir(), "tidepool-seed-claude-trust-"));
    const claudeJsonPath = join(home, ".claude.json");
    const existing = {
      mcpServers: { example: { command: "example" } },
      hasCompletedOnboarding: true,
      projects: {
        "/home/masaki/other": { hasTrustDialogAccepted: true, lastSessionId: "abc" },
        [projectCwd]: { lastSessionId: "xyz" },
      },
    };
    writeFileSync(claudeJsonPath, JSON.stringify(existing, null, 2));

    const result = spawnSync(
      "node",
      ["scripts/seed-claude-trust.mjs", projectCwd],
      { cwd: ROOT, env: { ...process.env, HOME: home }, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    const written = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    expect(written).toEqual({
      mcpServers: { example: { command: "example" } },
      hasCompletedOnboarding: true,
      projects: {
        "/home/masaki/other": { hasTrustDialogAccepted: true, lastSessionId: "abc" },
        [projectCwd]: { lastSessionId: "xyz", hasTrustDialogAccepted: true },
      },
    });
  });

  it("leaves the file byte-for-byte unchanged on a second run", () => {
    const projectCwd = "/home/masaki/tidepool";
    const { result: first, claudeJsonPath, home: seededHome } = runSeed(projectCwd);
    expect(first.status, first.stderr).toBe(0);
    const afterFirst = readFileSync(claudeJsonPath, "utf8");

    const second = spawnSync("node", ["scripts/seed-claude-trust.mjs", projectCwd], {
      cwd: ROOT,
      env: { ...process.env, HOME: seededHome },
      encoding: "utf8",
    });

    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(claudeJsonPath, "utf8")).toBe(afterFirst);
  });

  it("resolves a relative cwd argument against the process's own working directory", () => {
    const { result, claudeJsonPath } = runSeed("some/relative/dir", { cwd: ROOT });

    expect(result.status, result.stderr).toBe(0);
    const written = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    expect(written).toEqual({
      projects: { [join(ROOT, "some/relative/dir")]: { hasTrustDialogAccepted: true } },
    });
  });

  it("fails and leaves the file untouched when ~/.claude.json is not valid JSON", () => {
    home = mkdtempSync(join(tmpdir(), "tidepool-seed-claude-trust-"));
    const claudeJsonPath = join(home, ".claude.json");
    writeFileSync(claudeJsonPath, "not json");

    const result = spawnSync("node", ["scripts/seed-claude-trust.mjs", "/home/masaki/tidepool"], {
      cwd: ROOT,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/^Error: /);
    expect(readFileSync(claudeJsonPath, "utf8")).toBe("not json");
  });
});
