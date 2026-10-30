import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { moonshotKeyAbsence } from "../src/claude-worker.js";
import { tempDir } from "./temp-dir.js";

it("an empty or whitespace-only Moonshot key is absent, with its path in the reason", async () => {
  const keyFile = join(await tempDir("tidepool-moonshot-key-"), "moonshot-api-key");
  for (const content of ["", " \t\n"]) {
    writeFileSync(keyFile, content);
    expect(moonshotKeyAbsence(keyFile)).toBe(`no readable, non-empty Moonshot API key at ${keyFile}`);
  }
});

it("an unreadable Moonshot key is absent, with its path in the reason", async () => {
  // Reading a directory fails on both supported platforms, including privileged runners.
  const keyFile = await tempDir("tidepool-moonshot-key-");
  expect(moonshotKeyAbsence(keyFile)).toBe(`no readable, non-empty Moonshot API key at ${keyFile}`);
});

it("a readable Moonshot key passes the gate without returning its contents", async () => {
  const keyFile = join(await tempDir("tidepool-moonshot-key-"), "moonshot-api-key");
  writeFileSync(keyFile, " sk-private-key-for-gate-test\n");
  expect(moonshotKeyAbsence(keyFile)).toBeUndefined();
});

