import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  CODEX_APP_SERVER_VERSION,
  type CodexCliCommand,
  createCodexAppServerProbe,
} from "../src/codex-app-server.js";

afterEach(() => vi.unstubAllEnvs());

function writeCompatibleSchemas(out: string): void {
  mkdirSync(join(out, "v2"), { recursive: true });
  writeFileSync(
    join(out, "ClientRequest.json"),
    JSON.stringify({
      oneOf: [
        {
          required: ["id", "method", "params"],
          properties: { method: { enum: ["account/read"] }, params: { type: "object" } },
        },
        {
          required: ["id", "method"],
          properties: { method: { enum: ["account/rateLimits/read"] }, params: { type: "null" } },
        },
      ],
    }),
  );
  writeFileSync(
    join(out, "v2", "GetAccountResponse.json"),
    JSON.stringify({
      required: ["requiresOpenaiAuth"],
      title: "GetAccountResponse",
      properties: { requiresOpenaiAuth: { type: "boolean" } },
      definitions: {
        Account: {
          oneOf: [
            {
              required: ["email", "planType", "type"],
              properties: { type: { enum: ["chatgpt"] } },
            },
          ],
        },
        PlanType: {
          enum: [
            "free", "go", "plus", "pro", "prolite", "team",
            "self_serve_business_prolite", "self_serve_business_usage_based", "business", "ent26",
            "enterprise_cbp_automation", "enterprise_cbp_usage_based", "enterprise", "edu", "unknown",
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(out, "v2", "GetAccountRateLimitsResponse.json"),
    JSON.stringify({
      required: ["rateLimits"],
      title: "GetAccountRateLimitsResponse",
      properties: { rateLimits: { allOf: [{ $ref: "#/definitions/RateLimitSnapshot" }] } },
      definitions: {
        RateLimitSnapshot: {
          properties: {
            primary: { anyOf: [{ $ref: "#/definitions/RateLimitWindow" }, { type: "null" }] },
            secondary: { anyOf: [{ $ref: "#/definitions/RateLimitWindow" }, { type: "null" }] },
          },
        },
        RateLimitWindow: {
          required: ["usedPercent"],
          properties: {
            usedPercent: { type: "integer" },
            windowDurationMins: { type: ["integer", "null"] },
            resetsAt: { type: ["integer", "null"] },
          },
        },
      },
    }),
  );
}

it("fixed Codex app-server stdio returns authenticated, normalized primary and secondary windows", async () => {
  vi.stubEnv("OPENAI_API_KEY", "must-not-reach-codex");
  vi.stubEnv("CODEX_API_KEY", "must-not-reach-codex");
  const root = await mkdtemp(join(tmpdir(), "tidepool-codex-probe-"));
  const calls: Array<{ args: string[]; input?: string; env: NodeJS.ProcessEnv }> = [];
  const command: CodexCliCommand = async (_executable, args, options) => {
    calls.push({ args, input: options.input, env: options.env });
    if (args[0] === "--version") {
      return { exitCode: 0, stdout: `${CODEX_APP_SERVER_VERSION}\n`, stderr: "" };
    }
    if (args[0] === "app-server" && args[1] === "generate-json-schema") {
      const out = args[args.indexOf("--out") + 1]!;
      writeCompatibleSchemas(out);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout: [
        { id: 1, result: { userAgent: "codex_cli_rs/0.147.0", platformFamily: "unix", platformOs: "macos", codexHome: root } },
        {
          id: 2,
          result: {
            account: { type: "chatgpt", email: "worker@example.invalid", planType: "plus" },
            requiresOpenaiAuth: false,
          },
        },
        {
          id: 3,
          result: {
            rateLimits: {
              planType: "plus",
              primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 18_001 },
              secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 604_801 },
            },
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n"),
    };
  };

  const result = await createCodexAppServerProbe({
    executable: "/opt/tidepool/bin/codex",
    codexHome: root,
    command,
  })(new Date(1_000));

  expect(result).toEqual({
    status: "observed",
    provider: "openai",
    cliVersion: CODEX_APP_SERVER_VERSION,
    plan: "plus",
    windows: [
      {
        name: "primary",
        model: null,
        usedPercent: 25,
        durationMs: 18_000_000,
        resetsAt: "1970-01-01T05:00:01.000Z",
      },
      {
        name: "secondary",
        model: null,
        usedPercent: 40,
        durationMs: 604_800_000,
        resetsAt: "1970-01-08T00:00:01.000Z",
      },
    ],
  });
  expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
    ["--version"],
    ["app-server", "generate-json-schema"],
    ["app-server"],
  ]);
  expect(calls[2]!.env).toMatchObject({ CODEX_HOME: root });
  expect(calls[2]!.env.OPENAI_API_KEY).toBeUndefined();
  expect(calls[2]!.env.CODEX_API_KEY).toBeUndefined();
  const requests = calls[2]!.input!.trim().split("\n").map((line) => JSON.parse(line));
  expect(requests).toEqual([
    {
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "tidepool", version: "0.0.0" }, capabilities: {} },
    },
    { method: "initialized" },
    { id: 2, method: "account/read", params: { refreshToken: false } },
    { id: 3, method: "account/rateLimits/read", params: null },
  ]);
});

it("version or generated response-schema drift fails closed before App Server usage is trusted", async () => {
  for (const drift of ["version", "schema"] as const) {
    const root = await mkdtemp(join(tmpdir(), "tidepool-codex-probe-"));
    let appServerCalls = 0;
    const command: CodexCliCommand = async (_executable, args) => {
      if (args[0] === "--version") {
        return {
          exitCode: 0,
          stdout: `${drift === "version" ? "codex-cli 0.148.0" : CODEX_APP_SERVER_VERSION}\n`,
          stderr: "",
        };
      }
      if (args[1] === "generate-json-schema") {
        const out = args[args.indexOf("--out") + 1]!;
        writeCompatibleSchemas(out);
        writeFileSync(
          join(out, "v2", "GetAccountResponse.json"),
          JSON.stringify({
            title: "GetAccountResponse",
            required: ["requiresOpenaiAuth"],
            properties: { requiresOpenaiAuth: { type: "string" } },
          }),
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      appServerCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await createCodexAppServerProbe({
      executable: "/opt/tidepool/bin/codex",
      codexHome: root,
      command,
    })(new Date(1_000));

    expect(result).toMatchObject({ status: "unobservable", provider: "openai" });
    expect(appServerCalls).toBe(0);
  }
});

it("structured account/read requires authentication is classified as OpenAI unauthorized", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidepool-codex-probe-"));
  const command: CodexCliCommand = async (_executable, args) => {
    if (args[0] === "--version") {
      return { exitCode: 0, stdout: `${CODEX_APP_SERVER_VERSION}\n`, stderr: "" };
    }
    if (args[1] === "generate-json-schema") {
      writeCompatibleSchemas(args[args.indexOf("--out") + 1]!);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout: [
        { id: 1, result: { userAgent: "codex_cli_rs/0.147.0", platformFamily: "unix", platformOs: "macos", codexHome: root } },
        { id: 2, result: { account: null, requiresOpenaiAuth: true } },
      ].map((line) => JSON.stringify(line)).join("\n"),
    };
  };

  await expect(
    createCodexAppServerProbe({
      executable: "/opt/tidepool/bin/codex",
      codexHome: root,
      command,
    })(new Date(1_000)),
  ).resolves.toEqual({
    status: "unauthorized",
    provider: "openai",
    cliVersion: CODEX_APP_SERVER_VERSION,
    reason: "Codex reports that OpenAI authentication is required",
  });
});

it.each([
  ["unknown plan", "unknown", "unknown", true, true],
  ["missing primary", "plus", "plus", false, true],
  ["contradictory plan", "plus", "pro", true, true],
])("unknown, missing, or contradictory structured plan/rate data fails closed: %s", async (
  _case,
  accountPlan,
  ratePlan,
  primary,
  secondary,
) => {
  const root = await mkdtemp(join(tmpdir(), "tidepool-codex-probe-"));
  const command: CodexCliCommand = async (_executable, args) => {
    if (args[0] === "--version") {
      return { exitCode: 0, stdout: `${CODEX_APP_SERVER_VERSION}\n`, stderr: "" };
    }
    if (args[1] === "generate-json-schema") {
      writeCompatibleSchemas(args[args.indexOf("--out") + 1]!);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const window = { usedPercent: 10, windowDurationMins: 300, resetsAt: 18_001 };
    return {
      exitCode: 0,
      stderr: "",
      stdout: [
        { id: 1, result: { userAgent: "codex_cli_rs/0.147.0", platformFamily: "unix", platformOs: "macos", codexHome: root } },
        { id: 2, result: { account: { type: "chatgpt", email: null, planType: accountPlan }, requiresOpenaiAuth: false } },
        {
          id: 3,
          result: {
            rateLimits: {
              planType: ratePlan,
              ...(primary && { primary: window }),
              ...(secondary && { secondary: window }),
            },
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n"),
    };
  };

  const result = await createCodexAppServerProbe({
    executable: "/opt/tidepool/bin/codex",
    codexHome: root,
    command,
  })(new Date(1_000));
  expect(result.status).toBe("unobservable");
});

it("normalizes model-specific rate-limit buckets without duplicating the all-model bucket", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidepool-codex-probe-"));
  const command: CodexCliCommand = async (_executable, args) => {
    if (args[0] === "--version") {
      return { exitCode: 0, stdout: `${CODEX_APP_SERVER_VERSION}\n`, stderr: "" };
    }
    if (args[1] === "generate-json-schema") {
      writeCompatibleSchemas(args[args.indexOf("--out") + 1]!);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout: [
        { id: 1, result: { userAgent: "codex_cli_rs/0.147.0", platformFamily: "unix", platformOs: "macos", codexHome: root } },
        { id: 2, result: { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: false } },
        {
          id: 3,
          result: {
            rateLimits: {
              limitId: "codex",
              planType: "plus",
              primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 18_001 },
              secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 604_801 },
            },
            rateLimitsByLimitId: {
              codex: {
                limitId: "codex",
                planType: "plus",
                primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 18_001 },
                secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 604_801 },
              },
              "gpt-5.4-mini": {
                limitId: "gpt-5.4-mini",
                limitName: "GPT-5.4 mini",
                planType: "plus",
                primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 18_001 },
                secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 604_801 },
              },
            },
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n"),
    };
  };

  const result = await createCodexAppServerProbe({
    executable: "/opt/tidepool/bin/codex",
    codexHome: root,
    command,
  })(new Date(1_000));

  expect(result.status === "observed" && result.windows.map(({ name, model, usedPercent }) => ({
    name,
    model,
    usedPercent,
  }))).toEqual([
    { name: "primary", model: null, usedPercent: 10 },
    { name: "secondary", model: null, usedPercent: 20 },
    { name: "primary", model: "gpt-5.4-mini", usedPercent: 30 },
    { name: "secondary", model: "gpt-5.4-mini", usedPercent: 40 },
  ]);
});

it("contradictory structured account state fails closed instead of guessing an auth verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidepool-codex-probe-"));
  const command: CodexCliCommand = async (_executable, args) => {
    if (args[0] === "--version") {
      return { exitCode: 0, stdout: `${CODEX_APP_SERVER_VERSION}\n`, stderr: "" };
    }
    if (args[1] === "generate-json-schema") {
      writeCompatibleSchemas(args[args.indexOf("--out") + 1]!);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout: [
        { id: 1, result: { userAgent: "codex_cli_rs/0.147.0", platformFamily: "unix", platformOs: "macos", codexHome: root } },
        {
          id: 2,
          result: {
            account: { type: "chatgpt", email: null, planType: "plus" },
            requiresOpenaiAuth: true,
          },
        },
        { id: 3, result: { rateLimits: {} } },
      ].map((line) => JSON.stringify(line)).join("\n"),
    };
  };

  const result = await createCodexAppServerProbe({
    executable: "/opt/tidepool/bin/codex",
    codexHome: root,
    command,
  })(new Date(1_000));

  expect(result).toMatchObject({
    status: "unobservable",
    provider: "openai",
    cliVersion: CODEX_APP_SERVER_VERSION,
  });
});
