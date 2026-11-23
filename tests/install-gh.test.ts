import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { tempDir } from "./temp-dir.js";

/** VM の provision が撃つ gh の導入(ADR 0402 決定1): 公式リリースの tarball を `gh-cli-version` の sha256 で確かめてから、版に依らない
 *  1つのパスに置く。テストは配布元と置き場所だけを差し替え、手元で作った tarball を入れさせる。 */
const SCRIPT = join(import.meta.dirname, "..", "scripts", "install-gh.sh");
const VERSION = "9.9.9";

/** `gh version <version>` を答える gh を1つ持つ tarball を、両 arch の公式の名前で `releases/v<version>/` に置く。 */
async function fakeRelease(): Promise<{ base: string; sha256: string }> {
  const dir = await tempDir("tidepool-gh-release-");
  const top = `gh_${VERSION}_linux_arm64`;
  mkdirSync(join(dir, top, "bin"), { recursive: true });
  writeFileSync(join(dir, top, "bin", "gh"), `#!/bin/sh\necho "gh version ${VERSION} (2026-11-18)"\n`, { mode: 0o755 });
  const releases = join(dir, "releases", `v${VERSION}`);
  mkdirSync(releases, { recursive: true });
  const tarball = join(releases, `gh_${VERSION}_linux_arm64.tar.gz`);
  execFileSync("tar", ["-czf", tarball, "-C", dir, top]);
  copyFileSync(tarball, join(releases, `gh_${VERSION}_linux_amd64.tar.gz`));
  return { base: `file://${join(dir, "releases")}`, sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex") };
}

async function pinFile(sha256: string): Promise<string> {
  const file = join(await tempDir("tidepool-gh-pin-"), "gh-cli-version");
  writeFileSync(file, `version=${VERSION}\nlinux_arm64=${sha256}\nlinux_amd64=${sha256}\n`);
  return file;
}

const install = (pin: string, prefix: string, base: string) =>
  spawnSync("bash", [SCRIPT, pin], { encoding: "utf8", env: { ...process.env, GH_INSTALL_PREFIX: prefix, GH_DOWNLOAD_BASE: base } });

it("sha256 の合う tarball の gh を版に依らない <prefix>/bin/gh に置き、2回目は落とさずに何もしない", async () => {
  const { base, sha256 } = await fakeRelease();
  const pin = await pinFile(sha256);
  const prefix = await tempDir("tidepool-gh-prefix-");

  const first = install(pin, prefix, base);
  const second = install(pin, prefix, "file:///nowhere");

  expect(first.status).toBe(0);
  expect(execFileSync(join(prefix, "bin", "gh"), ["--version"], { encoding: "utf8" })).toBe(`gh version ${VERSION} (2026-11-18)\n`);
  expect(second.status).toBe(0);
});

it("入っている gh の版が違えば入れ直す", async () => {
  const { base, sha256 } = await fakeRelease();
  const prefix = await tempDir("tidepool-gh-prefix-");
  mkdirSync(join(prefix, "bin"));
  writeFileSync(join(prefix, "bin", "gh"), `#!/bin/sh\necho "gh version 2.46.0 (Ubuntu 2.46.0-4)"\n`, { mode: 0o755 });

  expect(install(await pinFile(sha256), prefix, base).status).toBe(0);
  expect(execFileSync(join(prefix, "bin", "gh"), ["--version"], { encoding: "utf8" })).toContain(`gh version ${VERSION} `);
});

it("sha256 が合わなければ失敗し、gh を置かない", async () => {
  const { base } = await fakeRelease();
  const prefix = await tempDir("tidepool-gh-prefix-");

  const result = install(await pinFile("0".repeat(64)), prefix, base);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`does not match the sha256 in`);
  expect(existsSync(join(prefix, "bin", "gh"))).toBe(false);
});
