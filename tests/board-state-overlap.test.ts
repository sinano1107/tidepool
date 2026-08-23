import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boardStateOverlap, boardStatePaths } from "../src/board-state.js";

/** 実 realpath を通す判定なので、テストも実ディレクトリを使う(macOS の
 *  /var → /private/var のように、tmp 自体が symlink であることも含めて
 *  意味論の一部)。 */
async function tempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `tidepool-${name}-`));
}

describe("boardStateOverlap: パス包含(ADR 0040)", () => {
  it("保護対象が workspace 配下にあれば重なりとして報告する", async () => {
    const ws = await tempDir("ws");
    const hit = boardStateOverlap(ws, [
      { label: "board database (TIDEPOOL_DB)", path: join(ws, "board.sqlite") },
    ]);
    expect(hit?.reason).toContain("overlaps the board's board database (TIDEPOOL_DB)");
  });

  it("workspace が保護対象の配下にあっても重なり(双方向 — worker-logs の中に workspace を掘る逆包含)", async () => {
    const logs = await tempDir("worker-logs");
    const hit = boardStateOverlap(join(logs, "nested-workspace"), [
      { label: "worker logs (TIDEPOOL_WORKER_LOGS)", path: logs },
    ]);
    expect(hit?.reason).toContain("overlaps the board's worker logs (TIDEPOOL_WORKER_LOGS)");
  });

  it("workspace と保護対象が同一パスなら重なり", async () => {
    const dir = await tempDir("cwd");
    const hit = boardStateOverlap(dir, [{ label: "the board's own checkout (cwd)", path: dir }]);
    expect(hit?.reason).toContain("overlaps");
  });

  it("交差しない兄弟ディレクトリは重なりではない", async () => {
    const ws = await tempDir("ws");
    const board = await tempDir("board");
    expect(boardStateOverlap(ws, [{ label: "board database", path: join(board, "board.sqlite") }])).toBeUndefined();
  });

  it("前置が一致するだけの兄弟(/opt/tidepool と /opt/tidepool-workspaces)は重なりではない", async () => {
    const parent = await tempDir("parent");
    const board = join(parent, "tidepool");
    const ws = join(parent, "tidepool-workspaces");
    await mkdir(board);
    await mkdir(ws);
    expect(boardStateOverlap(ws, [{ label: "the board's own checkout (cwd)", path: board }])).toBeUndefined();
  });

  it("symlink 越しの別綴りでも実体が同じなら重なり(比較の直前に realpath で正規化する)", async () => {
    const parent = await tempDir("parent");
    const real = join(parent, "real");
    const link = join(parent, "link");
    await mkdir(real);
    await symlink(real, link);
    const hit = boardStateOverlap(link, [
      { label: "board database (TIDEPOOL_DB)", path: join(real, "board.sqlite") },
    ]);
    expect(hit?.reason).toContain("overlaps");
  });
});

describe("boardStateOverlap: 解決できないパスは fail-closed(ADR 0040)", () => {
  /** ELOOP を作る: 互いを指す symlink は realpath で解決できない。 */
  async function makeUnresolvable(parent: string): Promise<string> {
    const a = join(parent, "a");
    const b = join(parent, "b");
    await symlink(b, a);
    await symlink(a, b);
    return a;
  }

  it("workspace パスが解決できなければ重なり扱いで止める(波及するのはその1 workspace だけで、文面もそう言う)", async () => {
    const parent = await tempDir("parent");
    const ws = await makeUnresolvable(parent);
    const hit = boardStateOverlap(ws, [{ label: "board database", path: join(parent, "board.sqlite") }]);
    // 波及するのはこの1 workspace だけ — 文面もそう言う
    expect(hit?.reason).toContain("workspace path");
    expect(hit?.reason).toContain("could not be resolved");
  });

  it("保護対象のパスが解決できなければ、どれが読めなかったかを文面で名指しする(全 workspace を巻き込む側なので診断が入れ替わってはいけない)", async () => {
    const parent = await tempDir("parent");
    const broken = await makeUnresolvable(parent);
    const ws = await tempDir("ws");
    const hit = boardStateOverlap(ws, [{ label: "GitHub token file (TIDEPOOL_GITHUB_TOKEN_FILE)", path: broken }]);
    // 全 workspace を巻き込む側なので、文面はどの保護対象が読めなかったかを名指しし、
    // 「重なった」とは言わない
    expect(hit?.reason).toContain("GitHub token file (TIDEPOOL_GITHUB_TOKEN_FILE)");
    expect(hit?.reason).toContain("could not be resolved");
    expect(hit?.reason).not.toContain("overlaps the board's");
  });
});

describe("boardStateOverlap: 大文字小文字の扱いはプラットフォーム依存(ADR 0040)", () => {
  /** 末尾セグメントの綴りだけが違う2つのパス。 */
  async function makeCasePair(): Promise<{ ws: string; protectedPath: string }> {
    const parent = await tempDir("parent");
    const ws = join(parent, "Board");
    await mkdir(ws);
    return { ws, protectedPath: join(parent, "board", "board.sqlite") };
  }

  it("darwin は case-insensitive に比較する(APFS 既定 — realpath は表記を直さない)", async () => {
    const { ws, protectedPath } = await makeCasePair();
    const hit = boardStateOverlap(ws, [{ label: "board database", path: protectedPath }], "darwin");
    expect(hit?.reason).toContain("overlaps");
  });

  it("linux は case-sensitive に比較する(綴りが違えば別のディレクトリ)", async () => {
    const { ws, protectedPath } = await makeCasePair();
    expect(boardStateOverlap(ws, [{ label: "board database", path: protectedPath }], "linux")).toBeUndefined();
  });
});

describe("boardStatePaths: 保護対象は盤面プロセスに固定(ADR 0040 の5点)", () => {
  const INPUT = {
    dbPath: "/srv/tidepool/board.sqlite",
    workerLogDir: "/srv/tidepool/worker-logs",
    apiTokenFile: "/home/pi/.tidepool/api-token",
    githubTokenFile: "/home/pi/.tidepool/github-token",
    moonshotApiKeyFile: "/home/pi/.tidepool/moonshot-api-key",
    cwd: "/srv/tidepool",
    servedRoot: "/srv/tidepool",
  };

  it("DB・worker-logs・API token・GitHub token・Moonshot キー・盤面の実行 checkout をこの順に並べる", () => {
    expect(boardStatePaths(INPUT).map((p) => p.path)).toEqual([
      "/srv/tidepool/board.sqlite",
      "/srv/tidepool/worker-logs",
      "/home/pi/.tidepool/api-token",
      "/home/pi/.tidepool/github-token",
      "/home/pi/.tidepool/moonshot-api-key",
      "/srv/tidepool",
    ]);
  });

  it("ラベルは人間が「どれを動かせばよいか」を読める綴りで、env 変数名を含む", () => {
    const labels = boardStatePaths(INPUT).map((p) => p.label);
    expect(labels).toContain("board database (TIDEPOOL_DB)");
    expect(labels).toContain("worker logs (TIDEPOOL_WORKER_LOGS)");
    expect(labels).toContain("human-surface token file (TIDEPOOL_API_TOKEN_FILE)");
    expect(labels).toContain("GitHub token file (TIDEPOOL_GITHUB_TOKEN_FILE)");
    expect(labels).toContain("Moonshot API key file (TIDEPOOL_MOONSHOT_API_KEY_FILE)");
    expect(labels).toContain("the board's own working directory (process cwd)");
  });

  it("配信元の checkout が cwd と違うなら(リポジトリ外から起動した盤面)両方を守る", () => {
    // public/ を配信するのは server.ts がモジュール位置から導く checkout であって
    // cwd ではない — cwd だけ守ると配信元が無防備になる
    const paths = boardStatePaths({ ...INPUT, cwd: "/var/run/board", servedRoot: "/srv/tidepool" });
    expect(paths.map((p) => p.path)).toContain("/var/run/board");
    expect(paths.map((p) => p.path)).toContain("/srv/tidepool");
  });

  it("cwd と配信元が同じ(通常の運用)なら同じパスを2度並べない", () => {
    const checkouts = boardStatePaths(INPUT).filter((p) => p.path === "/srv/tidepool");
    expect(checkouts).toHaveLength(1);
  });

  it("GitHub token ファイルは env 未設定なら守る対象そのものが無いので落ちる(ADR 0024 の fail-closed な不在)", () => {
    const paths = boardStatePaths({ ...INPUT, githubTokenFile: undefined });
    expect(paths).toHaveLength(5);
    expect(paths.some((p) => p.label.includes("GITHUB"))).toBe(false);
  });
});
