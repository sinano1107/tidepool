import { describe, expect, it } from "vitest";
import { buildSandboxSettings, skillReadPaths } from "../src/sandbox.js";

/** ADR 0033: worker セッションの Bash はハーネス内蔵サンドボックス(macOS
 *  Seatbelt / Linux bubblewrap)で workspace に封じる。この純関数はその
 *  `--settings` JSON の組み立てだけを担う — 実際に OS が拒否することの確認は
 *  実機スモークの仕事(ADR 0027 の線)。
 *
 *  期待値はインストール済み CLI(2.1.220)で実挙動を確認して得た形を literal で
 *  置く(tdd スキル「期待値は独立した情報源から」): `sandbox.filesystem` の
 *  4キー、`~` 展開、そして「allowRead は denyRead に勝つが、allowWrite は
 *  denyWrite に勝たない」という非対称。 */
describe("buildSandboxSettings", () => {
  it("work プロファイル: workspace は読み書き可、ホーム配下の読みは deny、裸コマンドへの fail-open ハッチは閉じる", () => {
    expect(
      buildSandboxSettings({
        taskType: "work",
        workspacePath: "/home/pi/work/tidepool",
        permittedSkills: "all",
      }).sandbox,
    ).toMatchObject({
      enabled: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: ["~/"],
        allowWrite: ["/home/pi/work/tidepool"],
      },
    });
  });

  it("review プロファイル: allowWrite は空(ただし OS 強制の書き込み拒否ではない — 下のコメント参照)", () => {
    const { filesystem } = buildSandboxSettings({
      taskType: "review",
      workspacePath: "/home/pi/work/tidepool",
      permittedSkills: "all",
    }).sandbox;
    expect(filesystem.allowWrite).toEqual([]);
    // 読みは review でも workspace に開く(「書けないが読める」— ADR 0013)
    expect(filesystem.allowRead).toContain("/home/pi/work/tidepool");
  });

  // 意図的に「review は workspace に書けない」を主張しない。sandbox 既定は cwd を
  // 書き込み可のままにするので、これは allowWrite だけでは成立しない。それを成立
  // させる denyWrite は Linux(bwrap)backend でサンドボックス自体を起動不能に
  // するため採らなかった(ADR 0033 の追記 / buildSandboxSettings のコメント)。
  // review の書き込み床は issue #59 のツール層 deny のままである。
  it("どちらのプロファイルも denyWrite を持たない — 書き込み床はツール層(#59)にある", () => {
    for (const taskType of ["work", "review"] as const) {
      const { filesystem } = buildSandboxSettings({
        taskType,
        workspacePath: "/home/pi/work/tidepool",
        permittedSkills: "all",
      }).sandbox;
      expect(filesystem).not.toHaveProperty("denyWrite");
    }
  });

  it("サンドボックスが起動できなかったときも裸で走らせない(failIfUnavailable — ベンダー既定は fail-open)", () => {
    expect(
      buildSandboxSettings({
        taskType: "work",
        workspacePath: "/home/pi/work/tidepool",
        permittedSkills: "all",
      }).sandbox.failIfUnavailable,
    ).toBe(true);
  });
});

/** ADR 0033 の不変条件をコード側に置く部分: 「allowlist が運ぶのは skill 名で
 *  ありパスではない — 名前 → パスの写像・サニタイズ・skill ルート配下限定は
 *  コード側が持ち、registry をどう書いても到達面は skill ルートの外に出ない」。 */
describe("skillReadPaths", () => {
  it("有限の許可リストは許可された skill のディレクトリだけを開く(skill ルート全体は開かない)", () => {
    expect(skillReadPaths(["tdd", "code-review"], "/home/pi/work/tidepool")).toEqual([
      "/home/pi/work/tidepool/.claude/skills/tdd",
      "~/.claude/skills/tdd",
      "/home/pi/work/tidepool/.claude/skills/code-review",
      "~/.claude/skills/code-review",
    ]);
  });

  it("skill ルートそのものは有限リストでは開かない — 拒否 skill の本文が cat で読めてはならない(issue #132 の意味論)", () => {
    const paths = skillReadPaths(["tdd"], "/home/pi/work/tidepool");
    expect(paths).not.toContain("/home/pi/work/tidepool/.claude/skills");
    expect(paths).not.toContain("~/.claude/skills");
    expect(paths).not.toContain("~/.claude/plugins");
  });

  it("'*'(全許可)はルートを開く — 拒否される skill が存在しないので迂回路にならない", () => {
    expect(skillReadPaths("all", "/home/pi/work/tidepool")).toEqual([
      "/home/pi/work/tidepool/.claude/skills",
      "~/.claude/skills",
      "~/.claude/plugins",
    ]);
  });

  it("空の許可リスト(--disable-slash-commands の形)は何も開かない", () => {
    expect(skillReadPaths([], "/home/pi/work/tidepool")).toEqual([]);
  });

  it("パス脱出を狙う名前はサニタイズで落ちる — registry に何を書いても skill ルートの外へ出られない", () => {
    expect(
      skillReadPaths(
        ["../../../.ssh", "..", ".", "/etc/passwd", "a/b", ".hidden", "tdd"],
        "/home/pi/work/tidepool",
      ),
    ).toEqual(["/home/pi/work/tidepool/.claude/skills/tdd", "~/.claude/skills/tdd"]);
  });

  it("plugin 接頭辞つきの名前は写像されない(パスが名前から決まらない — 過小許可に倒す)", () => {
    expect(skillReadPaths(["myplugin:deploy"], "/home/pi/work/tidepool")).toEqual([]);
  });
});
