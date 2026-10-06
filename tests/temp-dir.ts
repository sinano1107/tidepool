import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/** A fresh temp dir under the given `prefix`, self-cleaning at the end of the
 *  calling test via vitest's `onTestFinished` (issue #703) — no `dirs` array,
 *  no `afterEach`. Calling this outside a test (`beforeAll`, module top
 *  level) throws, by `onTestFinished`'s own contract; that is accepted as
 *  misuse detection rather than guarded against here. */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
