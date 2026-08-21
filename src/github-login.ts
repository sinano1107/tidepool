import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

interface GitHubDeviceFlowDependencies {
  clientId: string;
  fetch: typeof globalThis.fetch;
  wait: (milliseconds: number) => Promise<void>;
  output: (line: string) => void;
  writeToken: (token: string) => Promise<void>;
}

interface GitHubLoginMainDependencies {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  wait?: (milliseconds: number) => Promise<void>;
  output?: (line: string) => void;
  errorOutput?: (line: string) => void;
  writeTokenFile?: (path: string, token: string) => Promise<void>;
}

const DEFAULT_GITHUB_CLIENT_ID = "registration-pending-issue-424";

/** App の slug(ADR 0093 決定8 の install リンク `https://github.com/apps/<slug>/
 *  installations/new` が要る)。client id と同じく #424 の App 登録で実物が決まる
 *  —— それまではリンク自体が 404 になる、という設計どおりの症状で立つ。 */
export const GITHUB_APP_SLUG =
  process.env.TIDEPOOL_GITHUB_APP_SLUG ?? "registration-pending-issue-424";

export async function githubLoginMain({
  env = process.env,
  fetch: fetchGitHub = globalThis.fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  output = (line) => process.stdout.write(`${line}\n`),
  errorOutput = (line) => process.stderr.write(`${line}\n`),
  writeTokenFile = writeGitHubTokenFile,
}: GitHubLoginMainDependencies = {}): Promise<number> {
  const tokenFile = env.TIDEPOOL_GITHUB_TOKEN_FILE;
  if (!tokenFile) {
    errorOutput("Error: TIDEPOOL_GITHUB_TOKEN_FILE is required");
    return 1;
  }
  try {
    await runGitHubDeviceFlow({
      clientId: env.TIDEPOOL_GITHUB_CLIENT_ID ?? DEFAULT_GITHUB_CLIENT_ID,
      fetch: fetchGitHub,
      wait,
      output,
      writeToken: (token) => writeTokenFile(tokenFile, token),
    });
    return 0;
  } catch (error) {
    errorOutput(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function writeGitHubTokenFile(path: string, token: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${token}\n`, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function postForm(
  fetch: typeof globalThis.fetch,
  url: string,
  values: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
  });
  if (!response.ok) throw new Error(`GitHub device flow request failed (${response.status})`);
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("GitHub device flow returned an invalid response");
  }
  return body as Record<string, unknown>;
}

export async function runGitHubDeviceFlow({
  clientId,
  fetch,
  wait,
  output,
  writeToken,
}: GitHubDeviceFlowDependencies): Promise<void> {
  const device = await postForm(fetch, "https://github.com/login/device/code", {
    client_id: clientId,
  });
  if (
    typeof device.device_code !== "string" ||
    typeof device.user_code !== "string" ||
    typeof device.verification_uri !== "string"
  ) {
    throw new Error("GitHub device flow returned an invalid device code response");
  }

  output(`User code: ${device.user_code}`);
  output(`Verification URL: ${device.verification_uri}`);
  let intervalSeconds =
    typeof device.interval === "number" && Number.isFinite(device.interval) && device.interval >= 0
      ? device.interval
      : 5;

  for (;;) {
    await wait(intervalSeconds * 1_000);
    const token = await postForm(fetch, "https://github.com/login/oauth/access_token", {
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (typeof token.access_token === "string") {
      await writeToken(token.access_token);
      return;
    }
    if (token.error === "slow_down") {
      intervalSeconds =
        typeof token.interval === "number" && Number.isFinite(token.interval) && token.interval >= 0
          ? token.interval
          : intervalSeconds + 5;
      continue;
    }
    if (token.error === "access_denied") {
      throw new Error("GitHub login was denied");
    }
    if (token.error === "expired_token") {
      throw new Error("GitHub device code expired");
    }
    if (token.error !== "authorization_pending") {
      throw new Error("GitHub device flow failed");
    }
  }
}
