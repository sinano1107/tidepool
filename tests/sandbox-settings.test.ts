import { spawnSync } from "node:child_process";
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
  // させる denyWrite: [workspace] は Linux(bwrap)backend でサンドボックス自体を
  // 起動不能にするため採らなかった(ADR 0033 の追記 / buildSandboxSettings の
  // コメント)。review の書き込み床はその後 ADR 0035(#144)が permission 層
  // (`--permission-mode manual`)に建てた — #59 のツール層 deny は「床」ではなく
  // 「allow で開けられる範囲の上限」に役割が変わっている。
  //
  // かつてここには「どちらのプロファイルも denyWrite を持たない」があった。ADR
  // 0037(#143)がそれを置き換える: **ファイル単位**の denyWrite は上の「起動
  // 不能」とは別物で、実測(Pi 2.1.207 / bwrap)でサンドボックスは正常に起動する。
  // 主張が「denyWrite を持たない」から「持つ形が2エントリに限られる」に変わった
  // だけで、守っている backend 制約は同じ。
  it("denyWrite はファイル単位の settings 2本だけ — .claude ディレクトリを名指すと Linux(bwrap)でサンドボックスが起動しない", () => {
    for (const taskType of ["work", "review"] as const) {
      const { filesystem } = buildSandboxSettings({
        taskType,
        workspacePath: "/home/pi/work/tidepool",
        permittedSkills: "all",
      }).sandbox;
      // 期待値は独立した literal(実測 G 表でこの2本が両プラットフォームで
      // 堅牢だった形)。配列まるごと置くので、ディレクトリが1つ紛れ込めば落ちる。
      expect(filesystem.denyWrite).toEqual([
        "/home/pi/work/tidepool/.claude/settings.json",
        "/home/pi/work/tidepool/.claude/settings.local.json",
      ]);
      // `bwrap: Can't create file at .../.claude/commands: Read-only file
      // system` への回帰ガード — 親ディレクトリを足したくなったら、その前に
      // Linux 実機で起動することを測ること
      expect(filesystem.denyWrite).not.toContain("/home/pi/work/tidepool/.claude");
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

  // issue #378 でこの主張は**反転した**: かつては「無害化は disableAllHooks の
  // 仕事なので hooks は素通し」だったが、盤面自身の deny hook と disableAllHooks
  // は排他(実測)なので blanket は外れ、workspace hook の無害化はこの guard が
  // 引き受ける。hook はハーネス側=サンドボックスの外で走り、その本体
  // (`npx biome` の node_modules/.bin、`scripts/*.sh` 等)は worker が書ける —
  // 文面が人間author でも本体は信用できない、が quarantine の理由。
  // tidepool 自身の biome hook はこのために repo から settings.local.json
  // (gitignore 済み、fresh clone に付いてこない)へ退去した。
  it("hooks を持つ project settings は検出する — hook はサンドボックスの外で走り、その本体は worker が書ける(issue #378 / ADR 0037 改訂)", async () => {
    const dir = await workspaceWith({
      "settings.json": JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "npm run fmt" }] }],
        },
      }),
    });
    expect(floorOverridingSettings(dir)).toEqual(["settings.json"]);
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

  it("work プロファイルには載せない — work は acceptEdits で走り、Bash のリダイレクトは「編集」ではないので、切ると書き込みが全部承認待ちで headless では静かに死ぬ", () => {
    expect(
      buildSandboxSettings({
        taskType: "work",
        workspacePath: "/home/pi/work/tidepool",
        permittedSkills: "all",
      }).sandbox.autoAllowBashIfSandboxed,
    ).toBeUndefined();
  });
});

/** issue #378(ADR 0010 追記 / ADR 0037 改訂): subagent は親の MCP tool を
 *  継承するので、盤面 verb(`mcp__tidepool__*`)を subagent からも呼べてしまう —
 *  decision log は説明責任の面そのもので、親が読まない subagent が書けるのは
 *  説明責任分割の密輸。機械的に塞げる唯一の口は PreToolUse hook で、hook 入力の
 *  `agent_id` は subagent の呼び出しにだけ付く(実測 CLI 2.1.235: 親スレッドの
 *  呼び出しには無く、subagent の呼び出しには `agent_id`/`agent_type` が付く)。
 *
 *  この hook は ADR 0037 の `disableAllHooks: true` と排他だった(実測: 同じ
 *  flag tier の hook も巻き添えで死ぬ)。そこで blanket は外し、workspace 側
 *  hook の無害化は floorOverridingSettings の quarantine(下の describe)へ移る。
 *  hot-load 経路(worker が settings を書いて次の呼び出しで hook を効かせる)は
 *  ADR 0037 の書き込み2層(sandbox denyWrite + Edit() deny)が既に独立に閉じて
 *  いる。 */
describe("buildSandboxSettings の hooks(issue #378: 盤面 verb は親スレッド専用)", () => {
  it("disableAllHooks はもう置かない — 盤面自身の deny hook と排他だった(実測: flag tier の hook も殺す)", () => {
    for (const taskType of ["work", "review"] as const) {
      expect(
        "disableAllHooks" in
          buildSandboxSettings({
            taskType,
            workspacePath: "/home/pi/work/tidepool",
            permittedSkills: "all",
          }),
      ).toBe(false);
    }
  });

  it("どちらのプロファイルも盤面 verb への PreToolUse deny hook を運ぶ — matcher は盤面 verb だけを見る(subagent の非盤面 tool は issue #378 のやらないこと)", () => {
    for (const taskType of ["work", "review"] as const) {
      const { hooks } = buildSandboxSettings({
        taskType,
        workspacePath: "/home/pi/work/tidepool",
        permittedSkills: "all",
      });
      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.PreToolUse[0]?.matcher).toBe("mcp__tidepool__.*");
      expect(hooks.PreToolUse[0]?.hooks).toHaveLength(1);
      const hook = hooks.PreToolUse[0]?.hooks[0];
      expect(hook?.type).toBe("command");
      // コマンドは自己完結(node -e)— ファイル配備もパス解決も持ち込まない。
      // 文言は英語(worker 向けテキストは英語統一)。挙動そのものは下の
      // describe が実行して確かめるので、ここでは床の骨格だけを固定する。
      expect(hook?.command).toContain("node -e");
      expect(hook?.command).toContain("agent_id");
      expect(hook?.command).toContain('permissionDecision:"deny"');
    }
  });
});

/** ADR 0037 の二層目。サンドボックスは **Bash しか縛らない** — 実測(C 表)で
 *  `denyWrite` が Bash からの書き込みと symlink 差し替えを拒否する一方、**Write
 *  ツールからは書けた(BREACH)**。ツール経路は permission 層で塞ぐしかない。
 *
 *  deny は tool 呼び出しの literal な `file_path` で判定されるので、エントリは
 *  workspace 相対のまま。`denyWrite`(絶対パス)と綴りが違うのは意図で、揃える
 *  のは未測定の形になる。
 *
 *  **綴りは `Edit(path)` だけ**(2026-08-03、実装時に測り直して判明。ADR 0037 の
 *  追記を参照)。CLI 2.1.220 は `Write(path)` を
 *  「is not matched by file permission checks — only Edit(path) rules are」と
 *  名指しで警告し、`MultiEdit` は「matches no known tool」と言う。中立ペイロード
 *  での実測:
 *
 *  - `Edit` 2本のみ → Write ツールが `File is in a directory that is denied by
 *    your permission settings.` で拒否され、新規作成も成立しない
 *  - `Write`/`MultiEdit` 4本のみ(Edit 抜き)→ deny ルールは沈黙し、止めたのは
 *    auto モードの**分類器**(`Blocked by classifier.`)。ADR 0033 が床として
 *    当てにしないと決めているモデル判断であり、床ではない
 *  - deny 空(control)→ 上書きも新規作成も**通る**
 */
describe("buildSandboxSettings の permissions.deny(ADR 0037)", () => {
  it("綴りは Edit(path) だけ — Write(path) は照合されず MultiEdit はツールとして存在しない(2.1.220 が名指しで警告する)", () => {
    // 期待値は独立した literal(上の実測で決定論的に拒否された唯一の形)。配列
    // まるごと置くので、効かない綴りを親切心で足せば落ちる。
    expect(
      buildSandboxSettings({
        taskType: "work",
        workspacePath: "/home/pi/work/tidepool",
        permittedSkills: "all",
      }).permissions,
    ).toEqual({
      deny: ["Edit(.claude/settings.json)", "Edit(.claude/settings.local.json)"],
    });
  });

  it("エントリは workspace 相対 — deny は literal path で判定されるので、workspace が変わっても同じ配列になる", () => {
    const at = (workspacePath: string) =>
      buildSandboxSettings({ taskType: "review", workspacePath, permittedSkills: "all" })
        .permissions.deny;
    expect(at("/home/pi/work/tidepool")).toEqual(at("/some/other/checkout"));
  });
});

/** issue #378 の deny hook の挙動そのもの。テストは組み立てた settings から
 *  コマンドを取り出して**実行**する(literal の写しではなく、盤面が実際に spawn
 *  へ渡す文字列が動くことを確かめる)。判定の情報源は hook 入力の `agent_id` —
 *  実測(CLI 2.1.235)で subagent の tool 呼び出しにだけ付き、親スレッドの
 *  呼び出しには付かないことを確認済み。 */
describe("盤面 verb deny hook の挙動(issue #378)", () => {
  const command = () =>
    buildSandboxSettings({
      taskType: "work",
      workspacePath: "/home/pi/work/tidepool",
      permittedSkills: "all",
    }).hooks.PreToolUse[0].hooks[0].command;

  const runHook = (stdin: string) => {
    const result = spawnSync("sh", ["-c", command()], { input: stdin, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    return result.stdout;
  };

  it("subagent(agent_id あり)からの盤面 verb は deny — 理由は英語で親スレッドへ誘導する", () => {
    const out = runHook(
      JSON.stringify({
        agent_id: "a310473ecb0af5373",
        agent_type: "general-purpose",
        tool_name: "mcp__tidepool__log_decision",
        tool_input: {},
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("main-thread only");
  });

  it("親スレッド(agent_id なし)からの盤面 verb は素通し — hook は何も言わない", () => {
    expect(
      runHook(JSON.stringify({ tool_name: "mcp__tidepool__log_decision", tool_input: {} })),
    ).toBe("");
  });

  it("読めない hook 入力は deny に倒す — 「親スレッドだと確認できた」ときだけ通す(fail-closed)", () => {
    // matcher が盤面 verb に絞っているので、この fail-closed の爆風半径は盤面
    // verb だけ — vendor が入力形式を変えた日に、subagent を黙って通すのではなく
    // 盤面呼び出しが音を立てて落ちる側に倒れる。
    const parsed = JSON.parse(runHook("{ not json"));
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("subagent でも盤面 verb 以外は deny しない — vendor の matcher 意味論が広がっても非盤面 tool の制限(やらないこと)に染み出さない", () => {
    expect(
      runHook(
        JSON.stringify({ agent_id: "a310473ecb0af5373", tool_name: "Read", tool_input: {} }),
      ),
    ).toBe("");
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
 *  人間ポート宛は塞ぐ」は両立する。
 *
 *  ADR 0036 / issue #152: tailnet の名前パターン deny は多層の一枚としてここに
 *  同居する。*.ts.net の完全名は実測で塞げたが、MagicDNS の短縮名
 *  (`raspberrypi`)は塞げず(2026-07-29 実測、プロキシが CONNECT を 200 で通す)、
 *  短縮名も列挙している。 */
describe("buildSandboxSettings の network(ADR 0033 追記 / issue #146, ADR 0036 / issue #152)", () => {
  // 期待値は独立した literal — ブロックまるごと置くので、キーが増えれば落ちる
  // (ベンダー既定の意味論に依存する床なので、黙って広がってはならない)。
  it("どちらのプロファイルも未許可 egress を閉じ、loopback listen と tailnet deny を共有する", () => {
    for (const taskType of ["work", "review"] as const) {
      expect(
        buildSandboxSettings({
          taskType,
          workspacePath: "/home/pi/work/tidepool",
          permittedSkills: "all",
        }).sandbox.network,
      ).toEqual({
        allowLocalBinding: true,
        strictAllowlist: true,
        deniedDomains: ["*.ts.net", "raspberrypi"],
      });
    }
  });

  it("workspace の許可ドメインを両プロファイルへ渡し、未許可 host は決定的に拒否する(ADR 0072)", () => {
    for (const taskType of ["work", "review"] as const) {
      expect(
        buildSandboxSettings({
          taskType,
          workspacePath: "/home/pi/work/tidepool",
          permittedSkills: "all",
          allowedDomains: ["registry.npmjs.org"],
        }).sandbox.network,
      ).toEqual({
        allowLocalBinding: true,
        strictAllowlist: true,
        allowedDomains: ["registry.npmjs.org"],
        deniedDomains: ["*.ts.net", "raspberrypi"],
      });
    }
  });
});
