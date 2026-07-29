import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSandboxSettings, floorOverridingSettings, skillReadPaths } from "../src/sandbox.js";

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

  it("ツールチェーンの動作基盤は封じない: git の global config が allowRead に載る(無いと git が一切動かない)", () => {
    // 期待値は独立した情報源から: ADR 0033 追記が名指しする2パスをそのまま literal で置く
    const { allowRead } = buildSandboxSettings({
      taskType: "work",
      workspacePath: "/home/pi/work/tidepool",
      permittedSkills: "all",
    }).sandbox.filesystem;
    expect(allowRead).toContain("~/.gitconfig");
    expect(allowRead).toContain("~/.config/git");
    // credential は開かない(ADR 0024: worker は GitHub credential を持たない)
    expect(allowRead).not.toContain("~/.config/gh");
    expect(allowRead).not.toContain("~/.ssh");
    expect(allowRead).not.toContain("~/.netrc");
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

/** 床を定義する2キーのガード。CLI は per-task の `--settings` とは別に
 *  workspace 側の `.claude/settings.json` / `settings.local.json` も読んで
 *  **merge** するため、checkout がそこに床を書けば効いてしまう。
 *
 *  issue #60 の実測(`sandbox`): `enabled: false` は `--settings` 側が勝つが、
 *  `filesystem.allowRead` はマージされて効いてしまい(canary が読めた)、
 *  `--setting-sources user` でも `--setting-sources ""` でも止まらなかった。
 *  issue #144 の実測(`permissions`): local tier の `permissions.allow` が
 *  `manual` の書き込み床を持ち上げた(`sh -c '… > f'` が通った)。
 *
 *  work セッションは workspace に書けるので、放置するとどちらも「自分で床を
 *  広げて次の spawn で抜ける」経路が残る。 */
describe("floorOverridingSettings", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function workspaceWith(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "tidepool-sbx-ws-"));
    dirs.push(dir);
    if (Object.keys(files).length > 0) await mkdir(join(dir, ".claude"), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, ".claude", name), body);
    }
    return dir;
  }

  it("sandbox ブロックを持たない project settings は素通しする(hooks 等の通常利用を壊さない)", async () => {
    const dir = await workspaceWith({
      "settings.json": JSON.stringify({ hooks: { PostToolUse: [] } }),
    });
    expect(floorOverridingSettings(dir)).toEqual([]);
  });

  it(".claude が無い workspace は素通しする", async () => {
    expect(floorOverridingSettings(await workspaceWith({}))).toEqual([]);
  });

  it("settings.json が sandbox ブロックを持てば検出する", async () => {
    const dir = await workspaceWith({
      "settings.json": JSON.stringify({ sandbox: { filesystem: { allowRead: ["/"] } } }),
    });
    expect(floorOverridingSettings(dir)).toEqual(["settings.json"]);
  });

  it("settings.local.json も同じく検出する(git 管理外でもディスク上にあれば CLI は読む)", async () => {
    const dir = await workspaceWith({
      "settings.local.json": JSON.stringify({ sandbox: { enabled: false } }),
    });
    expect(floorOverridingSettings(dir)).toEqual(["settings.local.json"]);
  });

  it("読めない/壊れた settings は fail-closed に倒す — こちらの parser と CLI の解釈が食い違う余地を残さない", async () => {
    const dir = await workspaceWith({ "settings.json": "{ not json" });
    expect(floorOverridingSettings(dir)).toEqual(["settings.json"]);
  });

  it("permissions ブロックも検出する(ADR 0035): local tier の permissions.allow は manual の床を持ち上げる", async () => {
    // #60 が allowRead で塞いだのと同じ二段階エスカレーション経路の1階上。
    // 実測(2.1.220)で settings.local.json の permissions.allow を置くと
    // `sh -c '… > f'` が通った。work セッションは自分の checkout に書けるので、
    // review が封じ込めるはずの当の行為者が床を外せることになる。
    const dir = await workspaceWith({
      "settings.local.json": JSON.stringify({ permissions: { allow: ["Bash(sh -c:*)"] } }),
    });
    expect(floorOverridingSettings(dir)).toEqual(["settings.local.json"]);
  });
});

/** ADR 0035(issue #144): review の書き込み床は permission 層が担うが、CLI の
 *  `sandbox.autoAllowBashIfSandboxed`(既定 true)が「サンドボックス内の Bash は
 *  承認不要」を意味するため、これを切らないと `--permission-mode manual` の床は
 *  そもそも存在しない。実測(macOS 2.1.220 / Pi 2.1.207 の両方)で、既定では
 *  `echo x > f` が通り、false では `Output redirection … was blocked.` になる。 */
describe("buildSandboxSettings の autoAllowBashIfSandboxed(ADR 0035)", () => {
  it("review プロファイルはサンドボックスの Bash 自動承認を切る — これが manual 床の成立条件", () => {
    expect(
      buildSandboxSettings({
        taskType: "review",
        workspacePath: "/home/pi/work/tidepool",
        permittedSkills: "all",
      }).sandbox.autoAllowBashIfSandboxed,
    ).toBe(false);
  });

  it("work プロファイルには載せない — work は auto で走り、切ると書き込みが全部承認待ちで headless では静かに死ぬ", () => {
    expect(
      buildSandboxSettings({
        taskType: "work",
        workspacePath: "/home/pi/work/tidepool",
        permittedSkills: "all",
      }).sandbox.autoAllowBashIfSandboxed,
    ).toBeUndefined();
  });
});

/** ADR 0033 追記(issue #146): サンドボックスのネットワーク既定は loopback への
 *  **listen** を拒否する。ADR 0033 本文の「ネットワークは現状のまま開放」は bind
 *  に関して実態と食い違っていた。実測(macOS 2.1.220)では `app.listen(0,
 *  "127.0.0.1")` が拒否されて `listener.address()` が null を返し、
 *  `bootTidepool` を呼ぶテストファイルが 93 file 落ちる — このキー1つで 152
 *  file / 858 tests が全 green になった。
 *
 *  ADR 0034 は「worker が自前のサーバーを loopback に立てて叩くのは正当な作業
 *  (npm test / webui-e2e)」と既に明言しており、これはその線をコード定数にした
 *  ものである。宛先(人間面)で塞ぐのは #140 / ADR 0034 の領分で、「bind は許すが
 *  人間ポート宛は塞ぐ」は両立する。 */
describe("buildSandboxSettings の network(ADR 0033 追記 / issue #146)", () => {
  // 期待値は独立した literal — ブロックまるごと置くので、キーが増えれば落ちる
  // (ベンダー既定の意味論に依存する床なので、黙って広がってはならない)。
  it("どちらのプロファイルも loopback への listen を開ける — サンドボックス下の worker がテストを回せる条件", () => {
    for (const taskType of ["work", "review"] as const) {
      expect(
        buildSandboxSettings({
          taskType,
          workspacePath: "/home/pi/work/tidepool",
          permittedSkills: "all",
        }).sandbox.network,
      ).toEqual({ allowLocalBinding: true });
    }
  });
});
