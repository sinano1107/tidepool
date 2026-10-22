/** Codex CLI の版上げの適合試験(ADR 0186 決定7 / issue #1385)。このホストの `codex` の実物の出力を、盤面自身の
 *  Board call の口から取って盤面自身の読み取り関数で判定し、面ごとの合否を Markdown の表で出す(種の openai 行が
 *  走るかも、ADR 0187 決定4)。1つでも不合格なら exit 1。
 *
 *  サブスクリプションの認証が要るので CI では回さない。Lima VM で `Delegate=yes` の scope の中から走らせる
 *  (手順は docs/codex-cli-version-bump.md)。試すのはまだ固定していない版なので、口の版の門には常に一致を返す
 *  検査を渡し、互換性検査と preflight の版の照合には観測した版を渡して外す —— schema と他の面の照合は残る。
 *
 *  使い方: CODEX_HOME=~/.tidepool/codex systemd-run --user --scope -p Delegate=yes -- npx tsx scripts/codex-cli-conformance.ts */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { platform } from "node:process";
import { type BoardCallSpec, createBoardCalls, readOutput } from "../src/board-call.js";
import { containerRuntimeFor } from "../src/cgroup-container.js";
import { SystemClock } from "../src/clock.js";
import {
  CODEX_APP_SERVER_LIMIT_MS,
  type CodexAppServerProbeResult,
  callAppServer,
  codexCommandThrough,
  compatibilityCheck,
  createCodexAppServerProbe,
  probeEnv,
} from "../src/codex-app-server.js";
import {
  egressCurl,
  judgeConformance,
  judgeSeedRows,
  SKILL_CLOSURE_MARKERS,
  type SkillClosureObservation,
} from "../src/codex-cli-conformance.js";
import {
  closedSurfaceConfig,
  codexWorkspaceContainment,
  configArgs,
  createCodexCapabilityCheck,
  FORCED_LOGIN_METHOD,
  NETWORK_PROXY_CONFIG,
  permissionConfig,
  resolveCodexExecutable,
  WORKER_EXEC_FLAGS,
} from "../src/codex-worker.js";
import { ProcessContainers } from "../src/process-container.js";
import { RECLAIM_TIMEOUT } from "../src/watchdog.js";

const { executable, onPath } = resolveCodexExecutable();
if (!onPath) {
  console.error("codex is not on PATH");
  process.exit(1);
}
const containers = new ProcessContainers(containerRuntimeFor(platform));
const preflight = containers.preflight();
if (!preflight.available) {
  console.error(preflight.reason);
  process.exit(1);
}
const { call } = createBoardCalls({
  containers,
  clock: new SystemClock(),
  reclaimTimeout: RECLAIM_TIMEOUT,
  onReclaimTimeout: (reason) => console.warn(reason),
  checkCliVersion: async () => ({ available: true }),
  onCliVersionMismatch: () => {},
});
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".tidepool", "codex");
const env = probeEnv(codexHome);
const pinnedVersion = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
const command = codexCommandThrough(call, "conformance App Server", CODEX_APP_SERVER_LIMIT_MS);

/** 使い捨てのディレクトリの中で1回撃って消す。workspace は実物の checkout と同じく homedir() の下に置く(#712)。 */
async function inDisposable<T>(run: (dirs: { home: string; workspace: string; temp: string }) => Promise<T>): Promise<T> {
  const created = [
    mkdtempSync(join(tmpdir(), "tidepool-codex-conformance-home-")),
    mkdtempSync(join(homedir(), ".tidepool-codex-conformance-workspace-")),
    mkdtempSync(join(tmpdir(), "tidepool-codex-conformance-temp-")),
  ];
  try {
    const [home, workspace, temp] = created.map((dir) => realpathSync(dir)) as [string, string, string];
    mkdirSync(join(workspace, ".git"));
    return await run({ home, workspace, temp });
  } finally {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  }
}

/** Board call を1回撃つ。口が答えを返さなければ投げる —— その面の不合格になる。 */
async function run(spec: Omit<BoardCallSpec, "harness" | "command">) {
  const result = await call({ ...spec, harness: "codex", command: executable }, readOutput);
  if (result === null) throw new Error(`the ${spec.kind} Board call did not complete (limit, spawn failure, or no container)`);
  return result;
}

// 到達の2行(ADR 0256 決定3): 盤面が worker に渡す permission profile をそのまま `codex sandbox` に渡す
const ALLOWED_DOMAIN = "registry.npmjs.org";
const egress = (host: string) =>
  inDisposable(async ({ workspace, temp }) => {
    const config = [...permissionConfig("work", workspace, temp, executable, [ALLOWED_DOMAIN]), NETWORK_PROXY_CONFIG];
    const result = await run({
      kind: "conformance egress",
      args: ["sandbox", "-P", "tidepool-work", "-C", workspace, ...config.flatMap((entry) => ["-c", entry]), ...egressCurl(host)],
      cwd: workspace,
      env: { ...env, TMPDIR: temp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      limitMs: 60_000,
    });
    return result.stdout + result.stderr;
  });

// skill の閉鎖の行(#1940): 盤面の列挙と観測で閉じ、同じ使い捨ての CODEX_HOME の exec の最初の request を偽の
// Responses endpoint で捕まえる。盤面の CODEX_HOME で撃つとログインの token が偽の endpoint に送られる。MCP と hook の行は
// 入れない —— `mcp_servers.tidepool.required=true` が届かない URL で exec を止める(それらの面は preflight の行が見る)
async function skillClosure(): Promise<SkillClosureObservation> {
  const { readable, prompt } = SKILL_CLOSURE_MARKERS;
  const bodies: string[] = [];
  let authorizationSent = false;
  const endpoint = createServer((request, response) => {
    if (request.headers.authorization !== undefined) authorizationSent = true;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      if (request.method === "POST") bodies.push(body);
      response.writeHead(400).end();
    });
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  try {
    // 祖先の skill は git の root(使い捨ての workspace)に置き、exec の workspace はその子 —— 実物の ~/.agents には触れない
    return await inDisposable(async ({ home, workspace: root }) => {
      const workspace = join(root, "ws");
      const skill = (dir: string, text: string) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), text);
      };
      const readableSkill = (dir: string, marker: string) =>
        skill(dir, `---\nname: ${basename(dir)}\ndescription: ${marker}\n---\n${marker}\n`);
      execFileSync("git", ["init", "-q", root], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      readableSkill(join(workspace, ".agents/skills/flat"), readable.flat);
      // root 自身の SKILL.md も Codex は skill として読む(#892)
      readableSkill(join(workspace, ".agents/skills"), readable.root);
      readableSkill(join(workspace, ".agents/skills/pack/inner"), readable.nested);
      readableSkill(join(workspace, "vendor/linked"), readable.linked);
      symlinkSync("../../vendor/linked", join(workspace, ".agents/skills/linked"));
      readableSkill(join(root, ".agents/skills/ancestor"), readable.ancestor);
      readableSkill(join(home, "skills/home-skill"), readable.codexHome);
      skill(join(workspace, ".agents/skills/nodesc"), "---\nname: nodesc\n---\nno description\n");
      skill(join(workspace, ".agents/skills/nofm"), "no frontmatter\n");

      const freshEnv = probeEnv(home);
      const loaded = [...closedSurfaceConfig(), FORCED_LOGIN_METHOD];
      const checked = await codexWorkspaceContainment({ call, executable, env: freshEnv, workspace, config: (skills) => [...loaded, skills] });
      const provider = "tidepool_conformance";
      const { port } = endpoint.address() as AddressInfo;
      // worker と同じ exec の flag(hook を付けないので --dangerously-bypass-hook-trust は要らない)
      const capture = async (config: string[]) => {
        bodies.length = 0;
        await run({
          kind: "conformance skill closure",
          args: [
            "--ask-for-approval", "never",
            "exec", "--json", ...WORKER_EXEC_FLAGS,
            "-C", workspace,
            ...configArgs([
              ...config,
              `model_provider="${provider}"`,
              `model_providers.${provider}.name="${provider}"`,
              `model_providers.${provider}.base_url="http://127.0.0.1:${port}/v1"`,
              `model_providers.${provider}.wire_api="responses"`,
            ]),
            prompt,
          ],
          cwd: workspace,
          env: freshEnv,
          limitMs: 60_000,
        });
        const [first] = bodies;
        if (first === undefined) throw new Error("codex exec sent no request to the fake Responses endpoint");
        return first;
      };
      return {
        capability: checked.capability,
        skillsList: checked.observed,
        // 対照: skills.config だけを外した同じ exec
        openRequest: await capture(loaded),
        closedRequest: await capture([...loaded, checked.skills]),
        unreadablePaths: ["nodesc", "nofm"].map((name) => join(workspace, ".agents/skills", name, "SKILL.md")),
        authorizationSent,
      };
    });
  } finally {
    endpoint.close();
  }
}

const appServerOptions = { executable, codexHome, command, pinnedVersion };
const probe = createCodexAppServerProbe(appServerOptions);
let appServer: Promise<CodexAppServerProbeResult> | undefined;

const { rows } = await judgeConformance({
  compatibility: () => compatibilityCheck(appServerOptions),
  // 使用量・認証・model/list は同じ1回の probe を読む
  appServer: () => (appServer ??= probe(new Date())),
  preflight: createCodexCapabilityCheck({ executable, onPath, codexHome, call, pinnedVersion }),
  visibleModels: async () =>
    (await callAppServer(command, executable, env, [], [{ method: "model/list", params: { includeHidden: false } }]))[0],
  allowedDomain: () => egress(ALLOWED_DOMAIN),
  unlistedDomain: () => egress("example.org"),
  // マーカーは使い捨ての CODEX_HOME に置き、盤面の CODEX_HOME には何も残さない
  promptInput: () =>
    inDisposable(async ({ home, workspace }) => {
      writeFileSync(join(home, "AGENTS.md"), "TIDEPOOL_CONFORMANCE_GLOBAL_AGENTS_MARKER\n");
      writeFileSync(join(workspace, "AGENTS.md"), "TIDEPOOL_CONFORMANCE_WORKSPACE_AGENTS_MARKER\n");
      const result = await run({
        kind: "conformance prompt-input",
        args: ["debug", "prompt-input", "-c", "project_doc_max_bytes=0", "conformance"],
        cwd: workspace,
        env: { ...env, CODEX_HOME: home },
        limitMs: CODEX_APP_SERVER_LIMIT_MS,
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `codex exited ${result.exitCode}`);
      return result.stdout;
    }),
  skillClosure,
});

// 種の openai 行は、1ターンの `exec --json` を worker の出力の読み取りで読む(ADR 0187 決定4)。
// approval は worker と同じく global の `--ask-for-approval never` で閉じる
const seedTurn = codexCommandThrough(call, "conformance seed row", 5 * 60_000);
const seedRows = await judgeSeedRows(async ({ model, effort }) => {
  const result = await seedTurn(
    executable,
    [
      "--ask-for-approval", "never",
      "exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only",
      "-m", model,
      ...(effort === null ? [] : ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`]),
      "Reply with the single word OK.",
    ],
    { env },
  );
  if (!result.stdout.trim()) throw new Error(result.stderr.trim() || `codex exited ${result.exitCode}`);
  return result.stdout;
});

const table = [...rows, ...seedRows];
console.log("| surface | result | detail |\n|---|---|---|");
for (const row of table) console.log(`| ${row.surface} | ${row.pass ? "合格" : "不合格"} | ${row.detail.replaceAll("|", "\\|")} |`);
process.exit(table.every((row) => row.pass) ? 0 : 1);
