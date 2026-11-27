import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BoardHomeMissingError, createBoardHome, openBoardHome, resolveBoardPlaces } from "../src/board-home.js";
import { resolveWorkspacesBaseDir } from "../src/workspace.js";
import { tempDir } from "./temp-dir.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const inside = (home: string, path: string) => !relative(home, path).startsWith("..") && relative(home, path) !== "";

// ADR 0436 決定1・5: 盤面が書く置き場は家から導く。家の既定は HOME の下の固定の場所、workspaces の基点だけは家の外(ADR 0082)
describe("resolveBoardPlaces: env から盤面の家を解決し、家から置き場を導く", () => {
  it("env を何も設定しなければ、家は HOME の下の ~/.tidepool/board で、workspaces の基点は既定の基点", () => {
    const places = resolveBoardPlaces({});

    expect(places.home).toBe(join(homedir(), ".tidepool", "board"));
    expect(places.workspacesDir).toBe(resolveWorkspacesBaseDir(undefined));
    expect(places.workspacesDirSource).toBe("default");
  });

  it("TIDEPOOL_HOME が指す家の中に、db・worker logs・Codex home・人間面の token file・registry clone がそれぞれ別の場所として導かれる", () => {
    const places = resolveBoardPlaces({ TIDEPOOL_HOME: "/srv/boards/scratch" });
    const derived = [places.dbPath, places.logDir, places.codexHome, places.apiTokenFile, places.registryDir];

    expect(places.home).toBe("/srv/boards/scratch");
    for (const path of derived) expect(inside(places.home, path), path).toBe(true);
    expect(new Set(derived).size).toBe(derived.length);
  });

  it("TIDEPOOL_WORKSPACES_DIR は家と別に workspaces の基点を上書きする", () => {
    const places = resolveBoardPlaces({ TIDEPOOL_HOME: "/srv/boards/scratch", TIDEPOOL_WORKSPACES_DIR: "/mnt/ssd/workspaces" });

    expect(places.workspacesDir).toBe("/mnt/ssd/workspaces");
    expect(places.workspacesDirSource).toBe("configured");
  });

  it("空の TIDEPOOL_HOME は cwd にも既定の家にも倒さず、空であることを言って拒む", () => {
    expect(() => resolveBoardPlaces({ TIDEPOOL_HOME: "" })).toThrow(BoardHomeMissingError);
    expect(() => resolveBoardPlaces({ TIDEPOOL_HOME: "" })).toThrow("TIDEPOOL_HOME is empty");
  });
});

// ADR 0436 決定5: 家は起動前の人間のコマンドが作り、識別子は作るときに乱数で生まれて家の中に残る
describe("createBoardHome: 盤面の家を作る", () => {
  it("家の dir と識別子を作る", async () => {
    const home = join(await tempDir("tidepool-create-home-"), "board");

    const created = createBoardHome(home);

    expect(created).toEqual({ identifier: expect.any(String), created: true });
    expect(created.identifier).not.toBe("");
    expect(existsSync(home)).toBe(true);
  });

  it("既にある家は作り直さず、同じ識別子を返す", async () => {
    const home = join(await tempDir("tidepool-create-home-"), "board");
    const { identifier } = createBoardHome(home);
    writeFileSync(join(home, "kept.txt"), "the board's state\n");

    expect(createBoardHome(home)).toEqual({ identifier, created: false });
    expect(readFileSync(join(home, "kept.txt"), "utf8")).toBe("the board's state\n");
  });

  it("別の家は別の識別子を持つ", async () => {
    const a = createBoardHome(join(await tempDir("tidepool-create-home-"), "a"));
    const b = createBoardHome(join(await tempDir("tidepool-create-home-"), "b"));

    expect(a.identifier).not.toBe(b.identifier);
  });
});

it("npm run create-home は家のパスと識別子を表示する", async () => {
  const home = join(await tempDir("tidepool-create-home-"), "board");

  // 実 HOME の家には触れない —— TIDEPOOL_HOME は必ず使い捨ての場所を指す
  const result = spawnSync("npm", ["run", "-s", "create-home"], { cwd: ROOT, env: { ...process.env, TIDEPOOL_HOME: home }, encoding: "utf8" });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(home);
  expect(result.stdout).toContain(createBoardHome(home).identifier);
});

// ADR 0436 決定5: 盤面は家を自分で作らない
describe("openBoardHome: 家を開く口は家を作らない", () => {
  it("盤面の家が無ければ BoardHomeMissingError で拒み、家を作らない", async () => {
    const home = join(await tempDir("tidepool-no-home-"), "board");

    expect(() => openBoardHome(home)).toThrow(BoardHomeMissingError);
    expect(existsSync(home)).toBe(false);
  });

  it("識別子の無い dir は盤面の家ではなく、BoardHomeMissingError で拒む", async () => {
    const notAHome = await tempDir("tidepool-not-a-home-");

    expect(() => openBoardHome(notAHome)).toThrow(BoardHomeMissingError);
    expect(readdirSync(notAHome)).toEqual([]);
  });
});
