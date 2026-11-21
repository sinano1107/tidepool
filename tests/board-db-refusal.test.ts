import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";

const paths: string[] = [];
const connections: Db[] = [];

afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratchDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "tidepool-db-refusal-"));
  paths.push(dir);
  return join(dir, "board.sqlite");
}

function corruptPage(db: Db, page: number) {
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  const path = db.name;
  db.close();
  const file = openSync(path, "r+");
  try {
    writeSync(file, Buffer.from([0]), 0, 1, (page - 1) * pageSize);
  } finally {
    closeSync(file);
  }
}

function corruptProbePage(laterRow = false) {
  const path = scratchDbPath();
  const db = openDb(path);
  db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
  const insert = db.prepare("INSERT INTO probe (value) VALUES (?)");
  for (let i = 0; i < 4; i++) insert.run("x".repeat(3_000));
  const page = db.prepare(
    "SELECT pageno FROM dbstat WHERE name = 'probe' AND pagetype = 'leaf' ORDER BY path LIMIT 1 OFFSET ?",
  ).pluck().get(laterRow ? 1 : 0) as number;
  corruptPage(db, page);
  return path;
}

it.each(["get", "all"] as const)("reports a refusal from %s synchronously and rethrows the original error", (method) => {
  const terminate = vi.fn();
  const db = openDb(corruptProbePage(), { terminate });
  connections.push(db);
  const sql = "SELECT id FROM probe";

  const statement = db.prepare(sql);
  const read = vi.fn(() => statement[method]());
  expect(read).toThrow(expect.objectContaining({ code: "SQLITE_CORRUPT" }));
  expect(terminate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "SQLITE_CORRUPT" }), sql);
  expect(terminate.mock.calls[0]?.[0]).toBe(read.mock.results[0]?.value);
});

it("reports a refusal before prepare can return a statement", () => {
  const terminate = vi.fn();
  const db = openDb(":memory:", { terminate });
  connections.push(db);
  db.exec("CREATE TABLE probe (value TEXT)");
  db.unsafeMode();
  db.pragma("writable_schema = ON");
  db.exec("UPDATE sqlite_schema SET sql = 'CREATE TABLE probe (not_valid' WHERE name = 'probe'");
  db.pragma("writable_schema = RESET");

  const sql = "SELECT value FROM probe";
  const refusal = expect.objectContaining({ code: "SQLITE_CORRUPT" });
  expect(() => db.prepare(sql)).toThrow(refusal);
  expect(terminate).toHaveBeenCalledExactlyOnceWith(refusal, sql);
});

it("reports a refused prepared write with the SQL source only, across fluent statement methods", () => {
  const terminate = vi.fn();
  const db = openDb(":memory:", { terminate });
  connections.push(db);
  db.exec("CREATE TABLE probe (value TEXT UNIQUE)");
  db.pragma("query_only = ON");
  const sql = "INSERT INTO probe VALUES (?) RETURNING value";
  const statement = db.prepare(sql);
  const configured = statement.pluck().raw().expand().safeIntegers().bind("private value");

  expect(configured).toBe(statement);
  expect(configured.database).toBe(db);
  expect(() => configured.run()).toThrow(expect.objectContaining({ code: "SQLITE_READONLY" }));
  expect(terminate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "SQLITE_READONLY" }), sql);
});

it("keeps ordinary SQLite constraint errors and non-SQLite exceptions visible to the caller", () => {
  const terminate = vi.fn();
  const db = openDb(":memory:", { terminate });
  connections.push(db);
  db.exec("CREATE TABLE probe (value TEXT UNIQUE); INSERT INTO probe VALUES ('one')");
  const statement = db.prepare("INSERT INTO probe VALUES (?)");
  const other = Object.assign(new Error("program error"), { code: "SQLITE_FULL" });
  db.function("program_error", () => { throw other; });

  expect(() => statement.run("one")).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_UNIQUE" }));
  expect(() => db.prepare("SELECT program_error()").get()).toThrow(other);
  expect(terminate).not.toHaveBeenCalled();
});

it("reports a refusal from the constructor even when there is no SQL", () => {
  const terminate = vi.fn();
  const path = scratchDbPath();
  mkdirSync(path);
  const refusal = expect.objectContaining({ code: expect.stringMatching(/^SQLITE_CANTOPEN/) });

  expect(() => openDb(path, { terminate })).toThrow(refusal);
  expect(terminate).toHaveBeenCalledExactlyOnceWith(refusal, "");
});

it("reports unreadable contents during initialization", () => {
  const path = scratchDbPath();
  writeFileSync(path, "This file is not a database");
  const terminate = vi.fn();
  expect(() => openDb(path, { terminate })).toThrow(expect.objectContaining({ code: "SQLITE_NOTADB" }));
  expect(terminate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "SQLITE_NOTADB" }), "journal_mode = WAL");
});

it("reports corrupt board contents encountered by the initialization SQL", () => {
  const path = scratchDbPath();
  const db = openDb(path);
  const page = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'memory_index_version'").pluck().get() as number;
  corruptPage(db, page);
  const terminate = vi.fn();
  const refusal = expect.objectContaining({ code: "SQLITE_CORRUPT" });

  expect(() => openDb(path, { terminate })).toThrow(refusal);
  expect(terminate).toHaveBeenCalledExactlyOnceWith(refusal, expect.stringContaining("INSERT OR IGNORE INTO memory_index_version"));
});

it.each(["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_FULLX"])("does not treat %s as a refusal", (code) => {
  const terminate = vi.fn();
  const db = openDb(":memory:", { terminate });
  connections.push(db);
  const error = new Database.SqliteError("other SQLite error", code);
  db.function("other_error", () => { throw error; });

  expect(() => db.prepare("SELECT other_error()").get()).toThrow(error);
  expect(terminate).not.toHaveBeenCalled();
});

it("reports SQLITE_FULL through the board handle", () => {
  const terminate = vi.fn();
  const db = openDb(":memory:", { terminate });
  connections.push(db);
  db.exec("CREATE TABLE probe (value TEXT)");
  const usedPages = db.pragma("page_count", { simple: true }) as number;
  db.pragma(`max_page_count = ${usedPages}`);
  const sql = "INSERT INTO probe VALUES (zeroblob(8192))";
  const refusal = expect.objectContaining({ code: "SQLITE_FULL" });

  expect(() => db.prepare(sql).run()).toThrow(refusal);
  expect(terminate).toHaveBeenCalledExactlyOnceWith(refusal, sql);
});

it("reports refused exec calls and keeps successful exec chains on the board handle", () => {
  const terminate = vi.fn();
  const db = openDb(":memory:", { terminate });
  connections.push(db);
  const chained = db.exec("CREATE TABLE probe (value TEXT)");
  expect(chained).toBe(db);
  db.pragma("query_only = ON");
  const sql = "INSERT INTO probe VALUES ('one')";

  expect(() => chained.exec(sql)).toThrow(expect.objectContaining({ code: "SQLITE_READONLY" }));
  expect(terminate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "SQLITE_READONLY" }), sql);
});

it("reports a refused row during lazy iteration after an earlier row succeeds", () => {
  const terminate = vi.fn();
  const db = openDb(corruptProbePage(true), { terminate });
  connections.push(db);
  const sql = "SELECT id FROM probe";
  const rows = db.prepare(sql).pluck().iterate();
  expect(rows[Symbol.iterator]()).toBe(rows);
  expect(rows.next()).toEqual({ value: 1, done: false });
  expect(terminate).not.toHaveBeenCalled();

  expect(() => rows.next()).toThrow(expect.objectContaining({ code: "SQLITE_CORRUPT" }));
  expect(terminate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "SQLITE_CORRUPT" }), sql);
});

it.each(["call", "default", "deferred", "immediate", "exclusive"] as const)(
  "reports a refused commit from the transaction's %s entry point",
  (entry) => {
    const terminate = vi.fn();
    const path = scratchDbPath();
    const db = openDb(path, { terminate });
    connections.push(db);
    db.pragma("journal_mode = DELETE");
    db.exec("CREATE TABLE probe (value TEXT)");

    let bodyCompleted = false;
    const transaction = db.transaction(() => {
      db.prepare("INSERT INTO probe VALUES ('one')").run();
      // The write succeeded. SQLite cannot unlink the journal when committing.
      renameSync(`${path}-journal`, `${path}-journal.preserved`);
      mkdirSync(`${path}-journal`);
      bodyCompleted = true;
    });
    const commit = entry === "call" ? transaction : transaction[entry];

    expect(commit).toThrow(expect.objectContaining({ code: "SQLITE_IOERR_DELETE" }));
    expect(bodyCompleted).toBe(true);
    expect(terminate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "SQLITE_IOERR_DELETE" }), "COMMIT");
  },
);

it("reports the original failing statement once as its error unwinds nested transactions", () => {
  const terminate = vi.fn();
  const db = openDb(":memory:", { terminate });
  connections.push(db);
  db.exec("CREATE TABLE probe (value TEXT)");
  db.pragma("query_only = ON");
  const sql = "INSERT INTO probe VALUES (?)";
  const write = db.transaction(() => db.prepare(sql).run("one"));
  const outer = db.transaction(() => write());

  expect(outer).toThrow(expect.objectContaining({ code: "SQLITE_READONLY" }));
  expect(terminate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "SQLITE_READONLY" }), sql);
});

it("passes the receiver and arguments to a nested transaction callback with its own apply property", () => {
  const db = openDb(":memory:");
  connections.push(db);
  const body = Object.assign(function (this: { base: number }, increment: number) {
    return this.base + increment;
  }, { apply: undefined });
  const nested = db.transaction(body);
  const outer = db.transaction(() => nested.immediate.call({ base: 40 }, 2));

  expect(outer()).toBe(42);
});

it("exits with one stderr line before a caller can catch a corrupt read", () => {
  const path = corruptProbePage();
  const sql = `SELECT id FROM probe WHERE ? IS NOT NULL\n-- ${"1".repeat(80)}`;
  const child = spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    `import { openDb } from "./src/db.ts";
     const [, path, sql] = process.argv;
     const db = openDb(path);
     try { db.prepare(sql).get("private value"); }
     catch { process.stdout.write("caught"); }`,
    path, sql,
  ], { encoding: "utf8", timeout: 5_000 });

  expect(child.error).toBeUndefined();
  expect(child.status).toBe(74);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe(
    `tidepool: board db refused an operation | SQLITE_CORRUPT | sql=SELECT id FROM probe WHERE ? IS NOT NULL -- ${"1".repeat(36)} | database disk image is malformed\n`,
  );
});

function expectGuardCoverage(handle: object, wrapped: string[], excluded: Record<PropertyKey, string>): void {
  const prototype: object = Object.getPrototypeOf(handle);
  const methods = Reflect.ownKeys(prototype)
    .filter((key) => typeof Reflect.getOwnPropertyDescriptor(prototype, key)?.value === "function");
  expect(new Set(methods)).toEqual(new Set([...wrapped, ...Reflect.ownKeys(excluded)]));
  for (const method of wrapped) {
    const operation = Reflect.get(handle, method);
    expect(operation, method).toBeTypeOf("function");
    expect(operation, method).not.toBe(Reflect.get(prototype, method));
  }
}

it("accounts for each better-sqlite3 Database and Statement method", () => {
  const db = openDb(":memory:");
  connections.push(db);
  expectGuardCoverage(db, ["prepare", "transaction", "exec", "pragma"], {
    constructor: "construction is separately guarded by openDb",
    backup: "asynchronous copy that can fail on source or destination; unused by the board and outside the synchronous boundary",
    serialize: "the native method returns bytes or throws a plain Error",
    function: "registers a callback on the connection",
    aggregate: "registers an aggregate on the connection",
    table: "registers a virtual table module on the connection",
    loadExtension: "loads a shared library and reports loader errors",
    close: "releases the native handles without propagating SQLite status codes",
    defaultSafeIntegers: "sets a JS value conversion flag",
    unsafeMode: "sets a connection flag",
    [inspect.custom]: "formats connection properties for inspection",
  });
  expectGuardCoverage(db.prepare("SELECT 1"), ["run", "get", "all", "iterate"], {
    constructor: "SQLite constructs statements internally; prepare is guarded",
    bind: "binds arguments in memory and keeps the same guarded statement",
    pluck: "sets the row shape flag and keeps the same guarded statement",
    expand: "sets the row shape flag and keeps the same guarded statement",
    raw: "sets the row shape flag and keeps the same guarded statement",
    safeIntegers: "sets an integer conversion flag and keeps the same guarded statement",
    columns: "reads column metadata from the prepared statement",
  });
});
