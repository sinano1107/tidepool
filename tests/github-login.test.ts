import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  githubLoginMain,
  runGitHubDeviceFlow,
  writeGitHubTokenFile,
} from "../src/github-login.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function json(body: object): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function deviceCode(interval = 1): Response {
  return json({
    device_code: "device-code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://github.com/login/device",
    interval,
  });
}

describe("runGitHubDeviceFlow", () => {
  it("shows the device code and URL, polls at GitHub's interval, and writes the approved token", async () => {
    const responses = [
      deviceCode(2),
      json({ error: "authorization_pending" }),
      json({ access_token: "github-user-token", token_type: "bearer", scope: "" }),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      responses.shift() ?? json({ error: "unexpected_request" }),
    );
    const waits: number[] = [];
    const output: string[] = [];
    const written: string[] = [];

    await runGitHubDeviceFlow({
      clientId: "test-client-id",
      fetch,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      output: (line) => output.push(line),
      writeToken: async (token) => {
        written.push(token);
      },
    });

    expect(output).toEqual([
      "User code: ABCD-EFGH",
      "Verification URL: https://github.com/login/device",
    ]);
    expect(waits).toEqual([2_000, 2_000]);
    expect(written).toEqual(["github-user-token"]);

    const [deviceUrl, deviceInit] = fetch.mock.calls[0] ?? [];
    expect(deviceUrl).toBe("https://github.com/login/device/code");
    expect(deviceInit?.method).toBe("POST");
    expect(new Headers(deviceInit?.headers).get("accept")).toBe("application/json");
    expect(new URLSearchParams(String(deviceInit?.body))).toEqual(
      new URLSearchParams({ client_id: "test-client-id" }),
    );

    for (const [tokenUrl, tokenInit] of fetch.mock.calls.slice(1)) {
      expect(tokenUrl).toBe("https://github.com/login/oauth/access_token");
      expect(tokenInit?.method).toBe("POST");
      expect(new Headers(tokenInit?.headers).get("accept")).toBe("application/json");
      expect(new URLSearchParams(String(tokenInit?.body))).toEqual(
        new URLSearchParams({
          client_id: "test-client-id",
          device_code: "device-code",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      );
    }
  });

  it("adds five seconds after slow_down unless GitHub returns a replacement interval", async () => {
    const responses = [
      deviceCode(),
      json({ error: "slow_down" }),
      json({ error: "slow_down", interval: 12 }),
      json({ access_token: "github-user-token", token_type: "bearer", scope: "" }),
    ];
    const waits: number[] = [];

    await runGitHubDeviceFlow({
      clientId: "test-client-id",
      fetch: async () => responses.shift() ?? json({ error: "unexpected_request" }),
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      output: () => {},
      writeToken: async () => {},
    });

    expect(waits).toEqual([1_000, 6_000, 12_000]);
  });

  it.each([
    ["access_denied", "GitHub login was denied"],
    ["expired_token", "GitHub device code expired"],
  ])("fails without writing a token for %s", async (error, message) => {
    const responses = [deviceCode(), json({ error })];
    const writeToken = vi.fn(async () => {});

    await expect(
      runGitHubDeviceFlow({
        clientId: "test-client-id",
        fetch: async () => responses.shift() ?? json({ error: "unexpected_request" }),
        wait: async () => {},
        output: () => {},
        writeToken,
      }),
    ).rejects.toThrow(message);
    expect(writeToken).not.toHaveBeenCalled();
  });
});

describe("writeGitHubTokenFile", () => {
  it("creates the parent and writes the token with final mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "tidepool-github-login-"));
    const tokenFile = join(root, "secrets", "github-token");
    try {
      await writeGitHubTokenFile(tokenFile, "github-user-token");

      expect(await readFile(tokenFile, "utf8")).toBe("github-user-token\n");
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces an existing token and leaves the replacement at mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "tidepool-github-login-"));
    const tokenFile = join(root, "secrets", "github-token");
    try {
      await mkdir(join(root, "secrets"));
      await writeFile(tokenFile, "old-token\n", { mode: 0o644 });

      await writeGitHubTokenFile(tokenFile, "new-token");

      expect(await readFile(tokenFile, "utf8")).toBe("new-token\n");
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically renames the replacement over the old token file", async () => {
    const root = await mkdtemp(join(tmpdir(), "tidepool-github-login-"));
    const tokenFile = join(root, "github-token");
    await writeFile(tokenFile, "old-token\n", { mode: 0o600 });
    const oldFile = await open(tokenFile, "r");
    try {
      const oldInode = (await oldFile.stat()).ino;

      await writeGitHubTokenFile(tokenFile, "new-token");

      expect(await readFile(tokenFile, "utf8")).toBe("new-token\n");
      expect(await oldFile.readFile("utf8")).toBe("old-token\n");
      expect((await stat(tokenFile)).ino).not.toBe(oldInode);
    } finally {
      await oldFile.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the existing token when preparing its replacement fails", async () => {
    if (process.getuid?.() === 0) return;
    const root = await mkdtemp(join(tmpdir(), "tidepool-github-login-"));
    const parent = join(root, "secrets");
    const tokenFile = join(parent, "github-token");
    await mkdir(parent);
    await writeFile(tokenFile, "old-token\n", { mode: 0o600 });
    await chmod(parent, 0o500);
    try {
      await expect(writeGitHubTokenFile(tokenFile, "new-token")).rejects.toThrow();
      expect(await readFile(tokenFile, "utf8")).toBe("old-token\n");
    } finally {
      await chmod(parent, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("npm run github-login", () => {
  it("exits nonzero before writing when TIDEPOOL_GITHUB_TOKEN_FILE is unset", async () => {
    const home = await mkdtemp(join(tmpdir(), "tidepool-github-login-home-"));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.TIDEPOOL_GITHUB_TOKEN_FILE;
    try {
      const result = spawnSync("npm", ["run", "github-login"], {
        cwd: ROOT,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toBe("Error: TIDEPOOL_GITHUB_TOKEN_FILE is required\n");
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        json({ error: "unexpected_request" }),
      );
      const writeTokenFile = vi.fn(async () => {});
      expect(
        await githubLoginMain({ env: {}, fetch, writeTokenFile, errorOutput: () => {} }),
      ).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(writeTokenFile).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["access_denied", "GitHub login was denied"],
    ["expired_token", "GitHub device code expired"],
  ])("returns nonzero through the production main path for %s", async (error, message) => {
    const responses = [deviceCode(), json({ error })];
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      responses.shift() ?? json({ error: "unexpected_request" }),
    );
    const errors: string[] = [];
    const writeTokenFile = vi.fn(async () => {});

    const status = await githubLoginMain({
      env: {
        TIDEPOOL_GITHUB_TOKEN_FILE: "/unused/github-token",
        TIDEPOOL_GITHUB_CLIENT_ID: "test-client-id",
      },
      fetch,
      wait: async () => {},
      output: () => {},
      errorOutput: (line) => errors.push(line),
      writeTokenFile,
    });

    expect(status).toBe(1);
    expect(errors).toEqual([`Error: ${message}`]);
    expect(writeTokenFile).not.toHaveBeenCalled();
    expect(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).get("client_id")).toBe(
      "test-client-id",
    );
  });
});
