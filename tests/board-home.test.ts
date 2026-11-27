import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readBoardHomeIdentifier, resolveBoardPlaces } from "../src/board-home.js";
import { resolveWorkspacesBaseDir } from "../src/workspace.js";
import { tempDir } from "./temp-dir.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 実 HOME の家には触れない —— TIDEPOOL_HOME は必ず使い捨ての場所を指す。 */
const runScript = (script: string, home: string) =>
  spawnSync("npm", ["run", "-s", script], { cwd: ROOT, env: { ...process.env, TIDEPOOL_HOME: home }, encoding: "utf8" });

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
});

// ADR 0436 決定5: 家は起動前の人間のコマンドが作り、識別子は作るときに乱数で生まれて家の中に残る
describe("npm run create-home: 盤面の家を作るコマンド", () => {
  it("家の dir と識別子を作り、盤面が読むのと同じ識別子を表示する", async () => {
    const home = join(await tempDir("tidepool-create-home-"), "board");

    const created = runScript("create-home", home);

    expect(created.status, created.stderr).toBe(0);
    const identifier = readBoardHomeIdentifier(home);
    expect(identifier).not.toBe("");
    expect(created.stdout).toContain(home);
    expect(created.stdout).toContain(identifier);
  });

  it("既にある家は作り直さず、同じ識別子を表示する", async () => {
    const home = join(await tempDir("tidepool-create-home-"), "board");
    runScript("create-home", home);
    const identifier = readBoardHomeIdentifier(home);
    writeFileSync(join(home, "kept.txt"), "the board's state\n");

    const again = runScript("create-home", home);

    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain(identifier);
    expect(readBoardHomeIdentifier(home)).toBe(identifier);
    expect(readFileSync(join(home, "kept.txt"), "utf8")).toBe("the board's state\n");
  });

  it("別の家は別の識別子を持つ", async () => {
    const [a, b] = [join(await tempDir("tidepool-create-home-"), "a"), join(await tempDir("tidepool-create-home-"), "b")];
    runScript("create-home", a);
    runScript("create-home", b);

    expect(readBoardHomeIdentifier(a)).not.toBe(readBoardHomeIdentifier(b));
  });
});
