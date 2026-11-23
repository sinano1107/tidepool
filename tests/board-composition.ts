import type { BoardComposition } from "../src/server-options.js";
import { FakeClock, FakeTranslationClient } from "./fakes.js";
import { TEST_CREDENTIAL } from "./harness.js";

/** 盤面1台ぶんの合成の入力(`buildServerOptions` に渡す)。registry は無く、どのパスも存在しない場所を指す。 */
export function composition(): BoardComposition {
  const clock = new FakeClock();
  return {
    port: 0,
    mcpPort: 0,
    credential: TEST_CREDENTIAL,
    clock,
    registryDir: undefined,
    registryMode: "purely-local",
    logDir: "/nonexistent/worker-logs",
    workspaceName: "sandbox",
    workspacesDir: "/nonexistent/workspaces",
    workspacesDirSource: "configured",
    defaultAgentName: "tako",
    auditorName: "shako",
    interviewerName: "suzumedai",
    boardState: [],
    moonshotApiKeyFile: "/nonexistent/moonshot-api-key",
    codexHome: "/nonexistent/codex-home",
    codexExecutable: "/nonexistent/bin/codex",
    codexOnPath: false,
    githubAuth: undefined,
    githubTokenFile: undefined,
    vapid: undefined,
    translationClient: () => new FakeTranslationClient(),
    cliAuthExpiresAt: undefined,
  };
}
