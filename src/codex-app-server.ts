import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const CODEX_APP_SERVER_VERSION = "codex-cli 0.147.0";

export interface CodexCliCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type CodexCliCommand = (
  executable: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    input?: string;
    /** 真になった時点で stdin を閉じる。省略時は input を書いたら即 EOF。 */
    until?: (stdout: string) => boolean;
  },
) => Promise<CodexCliCommandResult>;

export interface ProviderUsageWindow {
  name: string;
  model: string | null;
  usedPercent: number;
  durationMs: number;
  resetsAt: string;
}

export type CodexAppServerProbeResult =
  | {
      status: "observed";
      provider: "openai";
      cliVersion: string;
      plan: string;
      windows: ProviderUsageWindow[];
    }
  | {
      status: "unauthorized" | "unobservable";
      provider: "openai";
      cliVersion: string | null;
      reason: string;
    };

export type CodexAppServerProbe = (now: Date) => Promise<CodexAppServerProbeResult>;

const PLAN_VALUES = [
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
] as const;

const accountResponse = z.object({
  account: z.discriminatedUnion("type", [
    z.object({ type: z.literal("apiKey") }).strict(),
    z.object({ type: z.literal("chatgpt"), email: z.string().nullable(), planType: z.enum(PLAN_VALUES) }).strict(),
    z.object({ type: z.literal("amazonBedrock"), usesCodexManagedCredentials: z.boolean().optional() }).strict(),
  ]).nullable().optional(),
  requiresOpenaiAuth: z.boolean(),
});

const rateWindow = z.object({
  usedPercent: z.number().int().min(0).max(100),
  windowDurationMins: z.number().int().positive().nullable(),
  resetsAt: z.number().int().positive().nullable(),
});

const rateLimitSnapshot = z.object({
  credits: z.unknown().nullable().optional(),
  individualLimit: z.unknown().nullable().optional(),
  limitId: z.string(),
  limitName: z.string().nullable().optional(),
  planType: z.enum(PLAN_VALUES),
  primary: rateWindow.nullable().optional(),
  rateLimitReachedType: z.unknown().nullable().optional(),
  secondary: rateWindow.nullable().optional(),
  spendControlReached: z.boolean().nullable().optional(),
});

const rateLimitsResponse = z.object({
  rateLimitResetCredits: z.unknown().nullable().optional(),
  rateLimits: rateLimitSnapshot,
  rateLimitsByLimitId: z.record(z.string(), rateLimitSnapshot).nullable().optional(),
});

const initializeResponse = z.object({
  userAgent: z.string(),
  platformFamily: z.string(),
  platformOs: z.string(),
  codexHome: z.string(),
});

const defaultCommand: CodexCliCommand = (executable, args, options) =>
  new Promise((resolve) => {
    const child = spawn(executable, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    };
    const timeout = setTimeout(() => {
      stderr += "Codex command timed out";
      child.kill("SIGKILL");
      finish(null);
    }, 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (options.until && !child.stdin.writableEnded && options.until(stdout)) child.stdin.end();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => finish(null));
    child.on("exit", (code) => finish(code));
    // App Server は EOF で打ち切り、flush できた分しか返さない(#706)。述語を渡した呼び手だけ
    // 待ちたい応答が揃うまで stdin を開けたままにし、15 秒 SIGKILL は fallback に残す。
    if (options.until) child.stdin.write(options.input ?? "");
    else child.stdin.end(options.input);
  });

/** openai の資格情報の不在(ADR 0116 決定4): Codex の login 未実施 = codexHome 配下に
 *  `auth.json` が無い。存否だけを読み、中身は読まない(ADR 0098 決定5)。 */
export function codexLoginAbsence(codexHome: string): string | undefined {
  const path = join(codexHome, "auth.json");
  return existsSync(path) ? undefined : `no Codex login: ${path} is absent`;
}

function probeEnv(codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

function commandFailure(result: CodexCliCommandResult): string | null {
  return result.exitCode === 0 ? null : result.stderr.trim() || `Codex exited ${result.exitCode}`;
}

function requestSchema(schema: any, method: string): any | undefined {
  return schema.oneOf?.find((entry: any) => entry?.properties?.method?.enum?.[0] === method);
}

function references(schema: any, name: string): boolean {
  return schema?.$ref === `#/definitions/${name}` ||
    schema?.allOf?.some((entry: any) => references(entry, name)) ||
    schema?.anyOf?.some((entry: any) => references(entry, name));
}

function schemasConform(requests: any, account: any, rateLimits: any): boolean {
  const accountRequest = requestSchema(requests, "account/read");
  const rateRequest = requestSchema(requests, "account/rateLimits/read");
  const chatgpt = account.definitions?.Account?.oneOf?.find(
    (entry: any) => entry?.properties?.type?.enum?.[0] === "chatgpt",
  );
  const snapshot = rateLimits.definitions?.RateLimitSnapshot;
  const window = rateLimits.definitions?.RateLimitWindow;
  return !!(
    accountRequest?.required?.includes("params") &&
    rateRequest?.properties?.params?.type === "null" &&
    account.title === "GetAccountResponse" &&
    account.required?.includes("requiresOpenaiAuth") &&
    account.properties?.requiresOpenaiAuth?.type === "boolean" &&
    chatgpt?.required?.includes("planType") &&
    JSON.stringify(account.definitions?.PlanType?.enum) === JSON.stringify(PLAN_VALUES) &&
    rateLimits.title === "GetAccountRateLimitsResponse" &&
    rateLimits.required?.includes("rateLimits") &&
    references(rateLimits.properties?.rateLimits, "RateLimitSnapshot") &&
    snapshot?.properties?.limitId?.type?.includes("string") &&
    snapshot?.properties?.planType !== undefined &&
    references(snapshot?.properties?.primary, "RateLimitWindow") &&
    references(snapshot?.properties?.secondary, "RateLimitWindow") &&
    window?.required?.includes("usedPercent") &&
    window?.properties?.usedPercent?.type === "integer" &&
    window?.properties?.windowDurationMins?.type?.includes("integer") &&
    window?.properties?.resetsAt?.type?.includes("integer")
  );
}

async function compatibilityCheck(
  executable: string,
  env: NodeJS.ProcessEnv,
  command: CodexCliCommand,
): Promise<{ ok: true; cliVersion: string } | { ok: false; cliVersion: string | null; reason: string }> {
  let versionResult: CodexCliCommandResult;
  try {
    versionResult = await command(executable, ["--version"], { env });
  } catch (error) {
    return { ok: false, cliVersion: null, reason: `version check failed: ${String(error)}` };
  }
  const version = versionResult.exitCode === 0 ? versionResult.stdout.trim() : null;
  if (version !== CODEX_APP_SERVER_VERSION) {
    return {
      ok: false,
      cliVersion: version,
      reason: `expected ${CODEX_APP_SERVER_VERSION}, observed ${version ?? "unavailable"}`,
    };
  }
  const schemaDir = mkdtempSync(join(tmpdir(), "tidepool-codex-schema-"));
  try {
    const generated = await command(
      executable,
      ["app-server", "generate-json-schema", "--out", schemaDir],
      { env },
    );
    const failed = commandFailure(generated);
    if (failed) return { ok: false, cliVersion: version, reason: `schema generation failed: ${failed}` };
    const requests = JSON.parse(readFileSync(join(schemaDir, "ClientRequest.json"), "utf8"));
    const account = JSON.parse(readFileSync(join(schemaDir, "v2", "GetAccountResponse.json"), "utf8"));
    const rateLimits = JSON.parse(
      readFileSync(join(schemaDir, "v2", "GetAccountRateLimitsResponse.json"), "utf8"),
    );
    if (
      !schemasConform(requests, account, rateLimits)
    ) {
      return { ok: false, cliVersion: version, reason: "required App Server method or response schema drifted" };
    }
    return { ok: true, cliVersion: version };
  } catch (error) {
    return { ok: false, cliVersion: version, reason: `could not inspect generated schema: ${String(error)}` };
  } finally {
    rmSync(schemaDir, { recursive: true, force: true });
  }
}

/** error 行は id ごとに保たれる —— どの要求が失敗したかで答えが変わる(ADR 0127 決定2)。 */
type JsonRpcOutcome = { result: unknown } | { error: string };

function parseResponses(stdout: string): Map<number, JsonRpcOutcome> {
  const responses = new Map<number, JsonRpcOutcome>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { message?: unknown } };
    if (typeof message.id !== "number") continue; // 通知(id の無い行)は読み飛ばす
    responses.set(
      message.id,
      message.error === undefined
        ? { result: message.result }
        : { error: typeof message.error.message === "string" ? message.error.message : JSON.stringify(message.error) },
    );
  }
  return responses;
}

/** 失敗した要求は理由ごと投げる —— どの id が無言だったかが reason から読めるようにする。 */
function resultOf(responses: Map<number, JsonRpcOutcome>, id: number, method: string): unknown {
  const outcome = responses.get(id);
  if (!outcome) throw new Error(`${method} returned no response`);
  if ("error" in outcome) throw new Error(`${method} failed: ${outcome.error}`);
  return outcome.result;
}

/** 待っている id の応答が出揃ったか。chunk 境界は JSON の途中に落ちるので、完結した行だけを読む。 */
function respondedToAll(stdout: string): boolean {
  try {
    const responses = parseResponses(stdout.slice(0, stdout.lastIndexOf("\n") + 1));
    return [1, 2, 3].every((id) => responses.has(id));
  } catch {
    return false;
  }
}

function normalizeWindow(
  name: string,
  model: string | null,
  value: z.infer<typeof rateWindow> | null | undefined,
  now: Date,
): ProviderUsageWindow {
  if (!value || value.windowDurationMins === null || value.resetsAt === null) {
    throw new Error(`${name} window is missing duration or reset`);
  }
  const resetsAt = new Date(value.resetsAt * 1000);
  if (resetsAt.getTime() <= now.getTime()) throw new Error(`${name} window reset is not in the future`);
  const durationMs = value.windowDurationMins * 60_000;
  if (resetsAt.getTime() - now.getTime() > durationMs) {
    throw new Error(`${name} window reset exceeds its duration`);
  }
  return {
    name,
    model,
    usedPercent: value.usedPercent,
    durationMs,
    resetsAt: resetsAt.toISOString(),
  };
}

/** Fixed Codex App Server stdio adapter. The first call pins version + generated
 * schema; each call then initializes one stdio process and reads structured
 * account/rate-limit results. No token file, WebSocket, experimentalApi, or API
 * key fallback is involved. */
export function createCodexAppServerProbe(options: {
  executable: string;
  codexHome: string;
  command?: CodexCliCommand;
}): CodexAppServerProbe {
  const command = options.command ?? defaultCommand;
  const env = probeEnv(options.codexHome);
  const compatibility = compatibilityCheck(options.executable, env, command);
  return async (now) => {
    const compatible = await compatibility;
    if (!compatible.ok) {
      return {
        status: "unobservable",
        provider: "openai",
        cliVersion: compatible.cliVersion,
        reason: compatible.reason,
      };
    }
    const input = [
      {
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "tidepool", version: "0.0.0" }, capabilities: {} },
      },
      { method: "initialized" },
      { id: 2, method: "account/read", params: { refreshToken: false } },
      { id: 3, method: "account/rateLimits/read", params: null },
    ].map((request) => JSON.stringify(request)).join("\n") + "\n";
    let observed: CodexCliCommandResult;
    try {
      observed = await command(options.executable, ["app-server"], { env, input, until: respondedToAll });
    } catch (error) {
      return {
        status: "unobservable",
        provider: "openai",
        cliVersion: compatible.cliVersion,
        reason: `App Server probe failed: ${String(error)}`,
      };
    }
    const failed = commandFailure(observed);
    if (failed) {
      return {
        status: "unobservable",
        provider: "openai",
        cliVersion: compatible.cliVersion,
        reason: `App Server probe failed: ${failed}`,
      };
    }
    try {
      const responses = parseResponses(observed.stdout);
      const unauthorized = (reason: string): CodexAppServerProbeResult =>
        ({ status: "unauthorized", provider: "openai", cliVersion: compatible.cliVersion, reason });

      initializeResponse.parse(resultOf(responses, 1, "initialize"));
      const account = accountResponse.parse(resultOf(responses, 2, "account/read"));
      // `requiresOpenaiAuth` は設定中の model provider の性質で login を語らない。読むのは
      // `false`(OpenAI 認証を使わない構成 = 盤面の前提外)のときだけ(ADR 0127 決定1)。
      // 前提外の構成では account の不在も login の証拠にならないので、先に観測不能へ倒す。
      if (!account.requiresOpenaiAuth) {
        throw new Error("configured model provider does not use OpenAI authentication");
      }
      // 不在(auth.json が無い)はここへ来ない —— probe の手前で pickup から外れる(ADR 0116 決定4)。
      // ここで account が無いのは、置いてあった資格情報が使えなくなったこと = 失効である。
      if (account.account === null) {
        return unauthorized("Codex credential is no longer usable: account/read reports no account");
      }

      const rateLimits = responses.get(3);
      if (rateLimits && "error" in rateLimits) {
        // vendor は fetch の失敗をすべて -32603 に畳むので、401 は message の文字列でしか見えない。
        // 照合は status line の綴りに絞る —— message には upstream の body がそのまま写るので、
        // 裸の 401 を拾うと 5xx の body 内の 401 で question が立つ。外れる方向は観測不能に、
        // 人間を呼ぶ側には倒さない(ADR 0127 決定2)。
        if (/\b401 Unauthorized\b/.test(rateLimits.error)) {
          return unauthorized(`Codex rejected the rate-limit read with HTTP 401: ${rateLimits.error}`);
        }
        throw new Error(`account/rateLimits/read failed: ${rateLimits.error}`);
      }
      if (account.account?.type !== "chatgpt" || account.account.planType === "unknown") {
        throw new Error("Codex account is not a known ChatGPT subscription plan");
      }
      const limits = rateLimitsResponse.parse(resultOf(responses, 3, "account/rateLimits/read"));
      if (limits.rateLimits.planType !== account.account.planType) {
        throw new Error("account and rate-limit plans contradict each other");
      }
      const buckets = Object.entries(limits.rateLimitsByLimitId ?? {});
      if (limits.rateLimits.limitId !== "codex") {
        throw new Error(`unexpected canonical rate-limit id ${limits.rateLimits.limitId}`);
      }
      if (buckets.some(([limitId]) => limitId !== "codex")) {
        throw new Error("unknown rate-limit id cannot be interpreted as a model");
      }
      const indexed = limits.rateLimitsByLimitId?.codex;
      if (
        indexed &&
        (
          indexed.limitId !== "codex" ||
          indexed.planType !== account.account.planType ||
          JSON.stringify(indexed.primary) !== JSON.stringify(limits.rateLimits.primary) ||
          JSON.stringify(indexed.secondary) !== JSON.stringify(limits.rateLimits.secondary)
        )
      ) {
        throw new Error("canonical indexed and backward-compatible rate limits contradict");
      }
      return {
        status: "observed",
        provider: "openai",
        cliVersion: compatible.cliVersion,
        plan: account.account.planType,
        windows: [
          normalizeWindow("primary", null, limits.rateLimits.primary, now),
          normalizeWindow("secondary", null, limits.rateLimits.secondary, now),
        ],
      };
    } catch (error) {
      return {
        status: "unobservable",
        provider: "openai",
        cliVersion: compatible.cliVersion,
        reason: `App Server response drift: ${String(error)}`,
      };
    }
  };
}
