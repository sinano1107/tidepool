import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  options: { env: NodeJS.ProcessEnv; input?: string },
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
}).strict();

const rateWindow = z.object({
  usedPercent: z.number().int().min(0).max(100),
  windowDurationMins: z.number().int().positive().nullable(),
  resetsAt: z.number().int().positive().nullable(),
}).strict();

const rateLimitSnapshot = z.object({
  credits: z.unknown().nullable().optional(),
  individualLimit: z.unknown().nullable().optional(),
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  planType: z.enum(PLAN_VALUES).nullable().optional(),
  primary: rateWindow.nullable().optional(),
  rateLimitReachedType: z.unknown().nullable().optional(),
  secondary: rateWindow.nullable().optional(),
  spendControlReached: z.boolean().nullable().optional(),
}).strict();

const rateLimitsResponse = z.object({
  rateLimitResetCredits: z.unknown().nullable().optional(),
  rateLimits: rateLimitSnapshot,
  rateLimitsByLimitId: z.record(z.string(), rateLimitSnapshot).nullable().optional(),
}).strict();

const initializeResponse = z.object({
  userAgent: z.string(),
  platformFamily: z.string(),
  platformOs: z.string(),
  codexHome: z.string(),
}).strict();

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
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => finish(null));
    child.on("exit", (code) => finish(code));
    child.stdin.end(options.input);
  });

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

function parseResponses(stdout: string): Map<number, unknown> {
  const responses = new Map<number, unknown>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof message.id === "number") {
      if (message.error !== undefined) throw new Error(`JSON-RPC request ${message.id} failed`);
      responses.set(message.id, message.result);
    }
  }
  return responses;
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
      observed = await command(options.executable, ["app-server"], { env, input });
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
      initializeResponse.parse(responses.get(1));
      const account = accountResponse.parse(responses.get(2));
      if (account.requiresOpenaiAuth) {
        if (account.account) throw new Error("Codex simultaneously reports an account and required authentication");
        return {
          status: "unauthorized",
          provider: "openai",
          cliVersion: compatible.cliVersion,
          reason: "Codex reports that OpenAI authentication is required",
        };
      }
      if (account.account?.type !== "chatgpt" || account.account.planType === "unknown") {
        throw new Error("Codex account is not a known ChatGPT subscription plan");
      }
      const limits = rateLimitsResponse.parse(responses.get(3));
      if (limits.rateLimits.planType !== account.account.planType) {
        throw new Error("account and rate-limit plans contradict each other");
      }
      const modelWindows: ProviderUsageWindow[] = [];
      const buckets = Object.entries(limits.rateLimitsByLimitId ?? {});
      if (buckets.length > 0 && !limits.rateLimits.limitId) {
        throw new Error("multi-bucket rate limits are missing the canonical limit id");
      }
      for (const [model, bucket] of buckets) {
        if (bucket.limitId !== model || bucket.planType !== account.account.planType) {
          throw new Error(`model rate-limit bucket ${model} contradicts its id or plan`);
        }
        if (model === limits.rateLimits.limitId) {
          if (
            JSON.stringify(bucket.primary) !== JSON.stringify(limits.rateLimits.primary) ||
            JSON.stringify(bucket.secondary) !== JSON.stringify(limits.rateLimits.secondary)
          ) {
            throw new Error("canonical multi-bucket and backward-compatible rate limits contradict");
          }
          continue;
        }
        modelWindows.push(
          normalizeWindow("primary", model, bucket.primary, now),
          normalizeWindow("secondary", model, bucket.secondary, now),
        );
      }
      return {
        status: "observed",
        provider: "openai",
        cliVersion: compatible.cliVersion,
        plan: account.account.planType,
        windows: [
          normalizeWindow("primary", null, limits.rateLimits.primary, now),
          normalizeWindow("secondary", null, limits.rateLimits.secondary, now),
          ...modelWindows,
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
