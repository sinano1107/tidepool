import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..");

const template = parse(readFileSync(join(ROOT, "lima/tidepool.yaml"), "utf8")) as {
  base?: string | string[];
  provision?: Array<{ mode?: string; script?: string }>;
};

const guide = readFileSync(join(ROOT, "docs/mac-first-boot.md"), "utf8");

describe("Lima テンプレート", () => {
  it("既定テンプレートを継承する(image / CPU / mount の写しを持たない)", () => {
    const base = Array.isArray(template.base) ? template.base : [template.base];
    expect(base).toContain("template:default");
  });

  it("system / user 両方の provision を持つ", () => {
    const modes = (template.provision ?? []).map((entry) => entry.mode);
    expect(modes).toContain("system");
    expect(modes).toContain("user");
  });

  // ADR 0101 決定4: provision は VM 起動のたびに走るので、ここに git pull を置くと
  // 壊れた main が VM 起動を道連れにする。更新は手順書の一行(人の判断)。
  it("provision で git pull しない", () => {
    for (const entry of template.provision ?? []) {
      expect(entry.script ?? "").not.toContain("git pull");
    }
  });
});

describe("Mac の初回起動手順書", () => {
  it.each([
    [
      "Mac で打つ 1 コマンド",
      "curl -fsSL https://raw.githubusercontent.com/sinano1107/tidepool/main/scripts/mac-install.sh | bash",
    ],
    ["起動の一行", "caffeinate -i -s limactl shell tidepool -- ~/tidepool/scripts/vm-board.sh"],
    [
      "更新の一行",
      "limactl shell tidepool --workdir ~/tidepool -- bash -lc 'git pull && npm install'",
    ],
  ])("%s を書いている", (_name, line) => {
    expect(guide).toContain(line);
  });
});
