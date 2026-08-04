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
    expect(hit?.kind).toBe("overlap");
    expect(hit?.target?.label).toBe("board database (TIDEPOOL_DB)");
    expect(hit?.reason).toContain("board database (TIDEPOOL_DB)");
  });

  it("workspace が保護対象の配下にあっても重なり(双方向 — worker-logs の中に workspace を掘る逆包含)", async () => {
    const logs = await tempDir("worker-logs");
    const hit = boardStateOverlap(join(logs, "nested-workspace"), [
      { label: "worker logs (TIDEPOOL_WORKER_LOGS)", path: logs },
    ]);
    expect(hit?.kind).toBe("overlap");
    expect(hit?.target?.label).toBe("worker logs (TIDEPOOL_WORKER_LOGS)");
  });

  it("workspace と保護対象が同一パスなら重なり", async () => {
    const dir = await tempDir("cwd");
    const hit = boardStateOverlap(dir, [{ label: "the board's own checkout (cwd)", path: dir }]);
    expect(hit?.kind).toBe("overlap");
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
    expect(hit?.kind).toBe("overlap");
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

  it("workspace パスが解決できなければ unresolved を返す(その1 workspace だけが止まる)", async () => {
    const parent = await tempDir("parent");
    const ws = await makeUnresolvable(parent);
    const hit = boardStateOverlap(ws, [{ label: "board database", path: join(parent, "board.sqlite") }]);
    expect(hit?.kind).toBe("unresolved");
    expect(hit?.target).toBeUndefined();
    expect(hit?.reason).toContain("workspace path");
  });

  it("保護対象のパスが解決できなければ、どの保護対象が読めなかったかを名指しして unresolved を返す", async () => {
    const parent = await tempDir("parent");
    const broken = await makeUnresolvable(parent);
    const ws = await tempDir("ws");
    const hit = boardStateOverlap(ws, [{ label: "GitHub token file (TIDEPOOL_GITHUB_TOKEN_FILE)", path: broken }]);
    expect(hit?.kind).toBe("unresolved");
    expect(hit?.target?.label).toBe("GitHub token file (TIDEPOOL_GITHUB_TOKEN_FILE)");
    // 全 workspace を巻き込む側なので、文面は「重なった」ではなく「読めなかった」と言う
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
    expect(hit?.kind).toBe("overlap");
  });

  it("linux は case-sensitive に比較する(綴りが違えば別のディレクトリ)", async () => {
    const { ws, protectedPath } = await makeCasePair();
    expect(boardStateOverlap(ws, [{ label: "board database", path: protectedPath }], "linux")).toBeUndefined();
  });
});

describe("boardStatePaths: 保護対象は盤面プロセスに固定の5点(ADR 0040)", () => {
  const INPUT = {
    dbPath: "/srv/tidepool/board.sqlite",
    workerLogDir: "/srv/tidepool/worker-logs",
    apiTokenFile: "/home/pi/.tidepool/api-token",
    githubTokenFile: "/home/pi/.tidepool/github-token",
    cwd: "/srv/tidepool",
  };

  it("DB・worker-logs・API token・GitHub token・盤面の実行 checkout の5点を並べる", () => {
    expect(boardStatePaths(INPUT).map((p) => p.path)).toEqual([
      "/srv/tidepool/board.sqlite",
      "/srv/tidepool/worker-logs",
      "/home/pi/.tidepool/api-token",
      "/home/pi/.tidepool/github-token",
      "/srv/tidepool",
    ]);
  });

  it("ラベルは人間が「どれを動かせばよいか」を読める綴りで、env 変数名を含む", () => {
    const labels = boardStatePaths(INPUT).map((p) => p.label);
    expect(labels).toContain("board database (TIDEPOOL_DB)");
    expect(labels).toContain("worker logs (TIDEPOOL_WORKER_LOGS)");
    expect(labels).toContain("human-surface token file (TIDEPOOL_API_TOKEN_FILE)");
    expect(labels).toContain("GitHub token file (TIDEPOOL_GITHUB_TOKEN_FILE)");
    expect(labels).toContain("the board's own checkout (process cwd)");
  });

  it("GitHub token ファイルは env 未設定なら守る対象そのものが無いので落ちる(ADR 0024 の fail-closed な不在)", () => {
    const paths = boardStatePaths({ ...INPUT, githubTokenFile: undefined });
    expect(paths).toHaveLength(4);
    expect(paths.some((p) => p.label.includes("GITHUB"))).toBe(false);
  });
});
