import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { tempDir } from "./temp-dir.js";

/** 運んだ後に名前の場所で object を照合する手だけを止める。 */
export async function stallCarriedVerification(repo: "carried" | "loose" = "carried"): Promise<void> {
  const bin = await tempDir("tidepool-git-slow-verification-");
  const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nif [ "$1" = pack-objects ]; then case "$3" in */${repo}/read) sleep 5; exit 0;; esac; fi\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
}
