import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { type Db, openDb } from "./db.js";
import type { TidepoolServer } from "./server.js";
import { resolveWorkspacesBaseDir, type WorkspacesBaseDirSource, workspacesBaseDirSource } from "./workspace.js";

/** 盤面の家の中に導く置き場(ADR 0436 決定1)。並びはここだけが持ち、ほかは名前で読む。 */
export interface BoardHomePlaces {
  home: string;
  dbPath: string;
  /** worker logs —— transcript、`/usage` の settings、task ごとの MCP / sandbox の設定。 */
  logDir: string;
  codexHome: string;
  /** 人間面の token file(ハッシュだけ、ADR 0036)。 */
  apiTokenFile: string;
  /** registry clone の固定のパス。dir が無い家は registry を持たない盤面(ADR 0140)。 */
  registryDir: string;
}

export interface BoardPlaces extends BoardHomePlaces {
  /** workspaces の基点は家の外に残る(ADR 0082)。 */
  workspacesDir: string;
  workspacesDirSource: WorkspacesBaseDirSource;
}

export function boardHomePlaces(home: string): BoardHomePlaces {
  const at = resolve(home);
  return {
    home: at,
    dbPath: join(at, "board.sqlite"),
    logDir: join(at, "worker-logs"),
    codexHome: join(at, "codex"),
    apiTokenFile: join(at, "api-token"),
    registryDir: join(at, "registry"),
  };
}

/** 盤面・`npm run token`・registry の初期化が同じ家を解決する1つの口(ADR 0436 決定1・5)。 */
export function resolveBoardPlaces(env: NodeJS.ProcessEnv): BoardPlaces {
  return {
    ...boardHomePlaces(env.TIDEPOOL_HOME ?? join(homedir(), ".tidepool", "board")),
    workspacesDir: resolveWorkspacesBaseDir(env.TIDEPOOL_WORKSPACES_DIR),
    workspacesDirSource: workspacesBaseDirSource(env.TIDEPOOL_WORKSPACES_DIR),
  };
}

const identifierFile = (home: string) => join(home, "home-id");

/** ADR 0436 決定5: 家が無いか識別子が読めない。盤面は家を自分で作らず起動を拒む。 */
export class BoardHomeMissingError extends Error {
  constructor(
    public readonly home: string,
    cause: string,
  ) {
    super(`no board home at ${home} (${cause}) — create it with \`npm run create-home\` before starting the board`);
    this.name = "BoardHomeMissingError";
  }
}

/** 家の識別子。家が無いか識別子が読めなければ `BoardHomeMissingError`。 */
export function readBoardHomeIdentifier(home: string): string {
  let identifier: string;
  try {
    identifier = readFileSync(identifierFile(resolve(home)), "utf8").trim();
  } catch (err) {
    throw new BoardHomeMissingError(resolve(home), err instanceof Error ? err.message : String(err));
  }
  if (!identifier) throw new BoardHomeMissingError(resolve(home), "the home's identifier is empty");
  return identifier;
}

/** 家を作るコマンドの本体(ADR 0436 決定5)。識別子を持つ家は作り直さず、その識別子を返す。 */
export function createBoardHome(home: string): { identifier: string; created: boolean } {
  const at = resolve(home);
  mkdirSync(at, { recursive: true, mode: 0o700 });
  try {
    // flag "wx": 既にある識別子は上書きしない
    const identifier = randomUUID();
    writeFileSync(identifierFile(at), `${identifier}\n`, { flag: "wx", mode: 0o600 });
    return { identifier, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return { identifier: readBoardHomeIdentifier(at), created: false };
  }
}

/** ADR 0436 決定2: 家の lock が取れない —— 別の盤面がこの家を使っている。待たずに起動を拒む。 */
export class BoardHomeLockedError extends Error {
  constructor(public readonly home: string) {
    super(`another board is using the board home at ${home} — stop that board, or start this one on a different home (TIDEPOOL_HOME)`);
    this.name = "BoardHomeLockedError";
  }
}

/** 家の中の lock file を SQLite の排他 lock で持つ(ADR 0436 決定2)。process の死では OS が外す。返すのは外す手。 */
function takeHomeLock(home: string): () => void {
  // timeout 0: 待たない(better-sqlite3 の既定は 5 秒待つ)
  const lock = new Database(join(home, "lock"), { timeout: 0 });
  try {
    lock.pragma("locking_mode = EXCLUSIVE");
    lock.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    lock.close();
    if (err instanceof Database.SqliteError && err.code === "SQLITE_BUSY") throw new BoardHomeLockedError(home);
    throw err;
  }
  return () => lock.close();
}

export interface OpenedBoardHome {
  places: BoardHomePlaces;
  identifier: string;
  /** 盤面の唯一の接続。`openDb` 自体は lock を掛けない —— テストと人間の `sqlite3` は db を直接開ける。 */
  db: Db;
  /** 家の lock を外す。盤面の停止と起動の途中の失敗は `startBoardOnHome` が撃つ。 */
  release: () => void;
}

/** 家を開く1つの口(ADR 0436 決定2・5): 家と識別子を確かめ、最初の書き込み(`openDb` の DDL と seed)より前に lock を取る。 */
export function openBoardHome(home: string, dbOptions?: Parameters<typeof openDb>[1]): OpenedBoardHome {
  const places = boardHomePlaces(home);
  const identifier = readBoardHomeIdentifier(places.home);
  const release = takeHomeLock(places.home);
  try {
    return { places, identifier, db: openDb(places.dbPath, dbOptions), release };
  } catch (err) {
    release();
    throw err;
  }
}

/** 盤面を家の上で起動する。起動が途中で失敗すれば lock を外して投げ直し、盤面の停止(db を閉じる時点)の後にも外す。 */
export async function startBoardOnHome(opened: OpenedBoardHome, start: () => Promise<TidepoolServer>): Promise<TidepoolServer> {
  let server: TidepoolServer;
  try {
    server = await start();
  } catch (err) {
    opened.release();
    throw err;
  }
  return { ...server, stop: () => server.stop().finally(opened.release) };
}
