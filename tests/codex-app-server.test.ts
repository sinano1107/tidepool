import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
            limitId: { type: ["string", "null"] },
            planType: { $ref: "#/definitions/PlanType" },
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
            requiresOpenaiAuth: true,
          },
        },
        {
          id: 3,
          result: {
            rateLimits: {
              limitId: "codex",
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

/** app-server の応答行だけを差し替える fake。`--version` と生成 schema は常に適合する。 */
function fakeCodex(rows: unknown[]): CodexCliCommand {
  return async (_executable, args) => {
    if (args[0] === "--version") {
      return { exitCode: 0, stdout: `${CODEX_APP_SERVER_VERSION}\n`, stderr: "" };
    }
    if (args[1] === "generate-json-schema") {
      writeCompatibleSchemas(args[args.indexOf("--out") + 1]!);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stderr: "", stdout: rows.map((row) => JSON.stringify(row)).join("\n") };
  };
}

const INITIALIZED = {
  id: 1,
  result: { userAgent: "codex_cli_rs/0.147.0", platformFamily: "unix", platformOs: "macos", codexHome: "/tmp/codex" },
};
const SIGNED_IN = {
  id: 2,
  result: { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true },
};

const probe = (rows: unknown[]) =>
  createCodexAppServerProbe({
    executable: "/opt/tidepool/bin/codex",
    codexHome: "/tmp/codex",
    command: fakeCodex(rows),
  })(new Date(1_000));

it.each([
  [
    "account/read が account を持たない",
    [INITIALIZED, { id: 2, result: { account: null, requiresOpenaiAuth: true } }],
    "account/read reports no account",
  ],
  [
    "account はあるが rateLimits/read が HTTP 401 で拒否される(token の失効)",
    [
      INITIALIZED,
      SIGNED_IN,
      {
        id: 3,
        error: {
          code: -32603,
          message:
            "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: " +
            '401 Unauthorized; content-type=text/plain; body={ "code": "unauthorized_unknown" }',
        },
      },
    ],
    "HTTP 401",
  ],
])("Codex の失効の証拠は2つあり、どちらも openai の unauthorized になる: %s", async (_case, rows, evidence) => {
  expect(await probe(rows)).toMatchObject({
    status: "unauthorized",
    provider: "openai",
    cliVersion: CODEX_APP_SERVER_VERSION,
    reason: expect.stringContaining(evidence),
  });
});

const RATE_LIMITS = {
  id: 3,
  result: {
    rateLimits: {
      limitId: "codex",
      planType: "plus",
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 18_001 },
      secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 604_801 },
    },
  },
};

it.each([
  [
    // どの id が無言だったかを reason が名指しする —— zod の invalid_type は id:1 と id:2 で同一文面で、
    // 保存された reason から区別できなかった(#706)。
    "initialize の応答が欠落",
    [SIGNED_IN, RATE_LIMITS],
    "initialize returned no response",
  ],
  [
    "initialize が error",
    [{ id: 1, error: { code: -32603, message: "session already initialized" } }, SIGNED_IN, RATE_LIMITS],
    "initialize failed",
  ],
  [
    "account/read が error",
    [INITIALIZED, { id: 2, error: { code: -32603, message: "auth manager unavailable" } }, RATE_LIMITS],
    "account/read failed",
  ],
  [
    "rateLimits/read が 401 以外の error(network 断)",
    [
      INITIALIZED,
      SIGNED_IN,
      { id: 3, error: { code: -32603, message: "failed to fetch codex rate limits: connection refused" } },
    ],
    "connection refused",
  ],
  [
    // message には upstream の body がそのまま写る —— 裸の 401 を拾うと、失効していないのに
    // 確認 question が立つ。照合が外れる方向は観測不能でなければならない(ADR 0127 決定2)。
    "rateLimits/read が 5xx で、その body の中に 401 が写っている",
    [
      INITIALIZED,
      SIGNED_IN,
      {
        id: 3,
        error: {
          code: -32603,
          message:
            "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: " +
            '500 Internal Server Error; content-type=application/json; body={ "upstream": { "status": 401 } }',
        },
      },
    ],
    "500 Internal Server Error",
  ],
  [
    // 他は observed の形そのもの —— 観測不能にしているのは requiresOpenaiAuth: false だけ。
    "OpenAI 認証を使わない provider 構成(requiresOpenaiAuth: false)",
    [
      INITIALIZED,
      { id: 2, result: { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: false } },
      RATE_LIMITS,
    ],
    "does not use OpenAI authentication",
  ],
  [
    // account の不在と requiresOpenaiAuth: false が同時に立つ唯一の組 —— 読む順が逆だと
    // unauthorized になり、設定の事実で quarantine の question が立つ。
    "前提外の provider 構成で account も無い(requiresOpenaiAuth: false かつ account: null)",
    [INITIALIZED, { id: 2, result: { account: null, requiresOpenaiAuth: false } }, RATE_LIMITS],
    "does not use OpenAI authentication",
  ],
])("失効と言い切れない観測は確認 question を立てず観測不能に留まる: %s", async (_case, rows, cause) => {
  expect(await probe(rows)).toMatchObject({
    status: "unobservable",
    provider: "openai",
    reason: expect.stringContaining(cause),
  });
});

// 各行が名前どおりの条件で落ちていることを reason で留める —— 揃って "unobservable" に
// なるだけの assert では、分類を取り違えても行は緑のまま残る(#706)。
it.each([
  ["unknown plan", "unknown", "unknown", true, true, "not a known ChatGPT subscription plan"],
  ["missing primary", "plus", "plus", false, true, "primary window is missing duration or reset"],
  ["contradictory plan", "plus", "pro", true, true, "account and rate-limit plans contradict each other"],
])("unknown, missing, or contradictory structured plan/rate data fails closed: %s", async (
  _case,
  accountPlan,
  ratePlan,
  primary,
  secondary,
  cause,
) => {
  const window = { usedPercent: 10, windowDurationMins: 300, resetsAt: 18_001 };
  const result = await probe([
    INITIALIZED,
    { id: 2, result: { account: { type: "chatgpt", email: null, planType: accountPlan }, requiresOpenaiAuth: true } },
    {
      id: 3,
      result: {
        rateLimits: {
          limitId: "codex",
          planType: ratePlan,
          ...(primary && { primary: window }),
          ...(secondary && { secondary: window }),
        },
      },
    },
  ]);

  expect(result).toMatchObject({ status: "unobservable", reason: expect.stringContaining(cause) });
});

// idle の窓は backend が自分の時計で「今 + 窓幅」を返すので、reset は probe の往復と秒への丸めの
// ぶん必ず pickup 時刻 + 窓幅を超える。窓幅以内という上限は vendor の契約ではない(ADR 0128 決定3)。
it("reset が pickup 時刻 + 窓幅を往復ぶん超えていても観測として通る", async () => {
  const result = await probe([
    INITIALIZED,
    SIGNED_IN,
    {
      id: 3,
      result: {
        rateLimits: {
          limitId: "codex",
          planType: "plus",
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 18_003 },
          secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 604_803 },
        },
      },
    },
  ]);

  // Idle の除外は scheduler 側なので、窓は observed の結果に残る。
  expect(result).toMatchObject({
    status: "observed",
    windows: [
      { name: "primary", usedPercent: 0, durationMs: 18_000_000, resetsAt: "1970-01-01T05:00:03.000Z" },
      { name: "secondary", usedPercent: 0, durationMs: 604_800_000, resetsAt: "1970-01-08T00:00:03.000Z" },
    ],
  });
});

it("accepts the validated codex indexed view but does not guess that unknown limit ids are models", async () => {
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
        { id: 2, result: { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true } },
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
  ]);

  const unknownLimit: CodexCliCommand = async (executable, args, options) => {
    const base = await command(executable, args, options);
    if (args[0] !== "app-server" || args[1] === "generate-json-schema") return base;
    const messages = base.stdout.split("\n").map((line) => JSON.parse(line));
    messages[2].result.rateLimitsByLimitId["gpt-5.4-mini"] = {
      limitId: "gpt-5.4-mini",
      planType: "plus",
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 18_001 },
      secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 604_801 },
    };
    return { ...base, stdout: messages.map((message) => JSON.stringify(message)).join("\n") };
  };
  await expect(
    createCodexAppServerProbe({
      executable: "/opt/tidepool/bin/codex",
      codexHome: root,
      command: unknownLimit,
    })(new Date(1_000)),
  ).resolves.toMatchObject({ status: "unobservable", provider: "openai" });
});

/** `--version` / `generate-json-schema` / `app-server` を argv で分ける使い捨ての codex。
 *  app-server は実物と同じく EOF で打ち切る —— 応答は次の tick 以降に書き、EOF を受けたら
 *  書き残しを捨ててその場で exit する。stdin を即閉じると1行も返らない(#706 の実測)。 */
function writeFakeCodex(root: string): string {
  const schemas = join(root, "schemas");
  writeCompatibleSchemas(schemas);
  const responses = {
    1: { userAgent: "codex_cli_rs/0.147.0", platformFamily: "unix", platformOs: "macos", codexHome: root },
    2: { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true },
    3: {
      rateLimits: {
        limitId: "codex",
        planType: "plus",
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 18_001 },
        secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 604_801 },
      },
    },
  };
  const executable = join(root, "codex.cjs");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { cpSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(${JSON.stringify(`${CODEX_APP_SERVER_VERSION}\n`)});
} else if (args[1] === "generate-json-schema") {
  cpSync(${JSON.stringify(schemas)}, args[args.indexOf("--out") + 1], { recursive: true });
} else {
  const responses = ${JSON.stringify(responses)};
  let buffered = "";
  process.stdin.setEncoding("utf8").on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\\n");
    buffered = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const { id } = JSON.parse(line);
      if (typeof id !== "number") continue;
      setTimeout(() => process.stdout.write(JSON.stringify({ id, result: responses[id] }) + "\\n"), 10);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

it("app-server の stdin は応答が揃うまで開いたままで、15 秒の SIGKILL を待たずに observed を返す", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidepool-codex-probe-"));
  const startedAt = Date.now();

  const result = await createCodexAppServerProbe({
    executable: writeFakeCodex(root),
    codexHome: root,
  })(new Date(1_000));

  expect(result).toMatchObject({ status: "observed", provider: "openai", plan: "plus" });
  expect(Date.now() - startedAt).toBeLessThan(10_000);
}, 20_000);
