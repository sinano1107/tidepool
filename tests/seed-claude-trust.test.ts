import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

function fakeHome() {
  home = mkdtempSync(join(tmpdir(), "tidepool-seed-claude-trust-"));
  return home;
}

function execSeed(
  homeDir: string | undefined,
  cwdArg: string | undefined,
  options: { cwd?: string } = {},
) {
  const args = ["scripts/seed-claude-trust.mjs", ...(cwdArg === undefined ? [] : [cwdArg])];
  const { HOME: _ignored, ...envWithoutHome } = process.env;
  return spawnSync("node", args, {
    cwd: options.cwd ?? ROOT,
    env: homeDir === undefined ? envWithoutHome : { ...envWithoutHome, HOME: homeDir },
    encoding: "utf8",
  });
}

function runSeed(cwdArg: string | undefined, options: { cwd?: string } = {}) {
  const homeDir = fakeHome();
  const result = execSeed(homeDir, cwdArg, options);
  return { result, home: homeDir, claudeJsonPath: join(homeDir, ".claude.json") };
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
    const claudeJsonPath = join(fakeHome(), ".claude.json");
    const existing = {
      mcpServers: { example: { command: "example" } },
      hasCompletedOnboarding: true,
      projects: {
        "/home/masaki/other": { hasTrustDialogAccepted: true, lastSessionId: "abc" },
        [projectCwd]: { lastSessionId: "xyz" },
      },
    };
    writeFileSync(claudeJsonPath, JSON.stringify(existing, null, 2));

    const result = execSeed(home, projectCwd);

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

    const second = execSeed(seededHome, projectCwd);

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
    const claudeJsonPath = join(fakeHome(), ".claude.json");
    writeFileSync(claudeJsonPath, "not json");

    const result = execSeed(home, "/home/masaki/tidepool");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/^Error: /);
    expect(readFileSync(claudeJsonPath, "utf8")).toBe("not json");
  });

  it("keeps the file's mode when rewriting it", () => {
    const claudeJsonPath = join(fakeHome(), ".claude.json");
    writeFileSync(claudeJsonPath, "{}");
    chmodSync(claudeJsonPath, 0o600);

    const result = execSeed(home, "/home/masaki/tidepool");

    expect(result.status, result.stderr).toBe(0);
    expect(statSync(claudeJsonPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(home as string)).toEqual([".claude.json"]);
  });

  it("writes through a symlinked ~/.claude.json instead of replacing the link", () => {
    const homeDir = fakeHome();
    const realPath = join(homeDir, "real.json");
    writeFileSync(realPath, "{}");
    symlinkSync(realPath, join(homeDir, ".claude.json"));

    const result = execSeed(homeDir, "/home/masaki/tidepool");

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(realPath, "utf8")).projects["/home/masaki/tidepool"]).toEqual({
      hasTrustDialogAccepted: true,
    });
    expect(lstatSync(join(homeDir, ".claude.json")).isSymbolicLink()).toBe(true);
  });

  it.each([
    ["a non-object root", "[1, 2, 3]"],
    ["a non-object projects value", '{"projects": "oops"}'],
  ])("fails and leaves the file untouched when ~/.claude.json has %s", (_label, content) => {
    const claudeJsonPath = join(fakeHome(), ".claude.json");
    writeFileSync(claudeJsonPath, content);

    const result = execSeed(home, "/home/masaki/tidepool");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/^Error: /);
    expect(readFileSync(claudeJsonPath, "utf8")).toBe(content);
  });

  it("fails with an English stderr message when HOME is not set", () => {
    const result = execSeed(undefined, "/home/masaki/tidepool");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/^Error: /);
  });

  it("fails with an English stderr message and no leftover temp file when the write fails", () => {
    const homeDir = fakeHome();
    chmodSync(homeDir, 0o500);

    const result = execSeed(homeDir, "/home/masaki/tidepool");

    chmodSync(homeDir, 0o700);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/^Error: /);
    expect(readdirSync(homeDir)).toEqual([]);
  });
});
