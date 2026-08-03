# workspace 自身の settings は worker の床を運べない: hooks を殺し、settings ファイルへの書き込みを二層で塞ぐ

issue #143 のグリリング(2026-08-02)で決定。#60 / ADR 0033 が per-task `--settings` でサンドボックス化する worker の Bash に対し、**workspace checkout 内の `.claude/settings.json` / `settings.local.json` はハーネス側(サンドボックスの外)に効く経路を2つ持つ** — hook の実行と、`sandbox` ブロックによる床の再定義。work セッションは自分の checkout に書けるので、両方とも worker 自身が仕込める。ADR 0033 の #60 追記が張った spawn 時ガード(`floorOverridingSettings`)は、この文書の実測で**紙の壁**だと判明した。

## 実測が設計を規定する(CLI 2.1.220 / macOS Seatbelt、本番 Pi 2.1.207 / bwrap。すべて control つき)

1. **project settings はセッション中にホットリロードされる。** セッション**開始後**に外部から置かれた `.claude/settings.json` の PostToolUse hook が、**同一セッション内で発火した**(headless、`acceptEdits`)。issue #143 が書いた「セッション N で仕込み N+1 で抜ける」2セッション経路は最短ではなく、**1セッションで完結する**。したがって「spawn 時に checkout を検査する」形の防御は原理的に届かない。

2. **`floorOverridingSettings` が守るはずの読み取り床も、同じホットリロードで広げられる。** 狭い床の Bash が `~/.config/…` を `Operation not permitted` で弾く(control)一方、その後外部から `.claude/settings.json` に `sandbox.filesystem.allowRead: ["~/"]` を置くと、**次の** Bash 呼び出しは同じファイルを読めた。同一 Bash コマンドの実行中は床が固定される(Seatbelt profile は起動時 compile)が、広がるのは次の spawn からである。これは #143(hook)より重い — `denyRead: ["~/"]` の主目的は認証情報(`~/.claude/.credentials.json`)の隠蔽(ADR 0033)であり、その床の突破は**認証情報の窃取**を意味する。

3. **hooks を殺す唯一の測定済み機構は `disableAllHooks: true`。** per-task `--settings` に置くと project hook の発火が止まり、workspace の skill(`@workspace` スコープ)と CLAUDE.md は残る。workspace 側の `disableAllHooks: false` による打ち消しは効かない(flag tier が勝つ)。ホットリロードで途中配置された hook も止まる(= 上記 1 の1セッション経路も塞ぐ)。偽キー `disableHooks` は素通り(negative control)なので、これは「未知キーの黙殺」ではなく実在キーである。代替の `--setting-sources user` / `""` も hooks を止めるが、workspace の skill と CLAUDE.md を**道連れにする**(canary skill が消え、CLAUDE.md も読めなくなった)ため採らない — ADR 0025 の skill allowlist `@workspace` スコープを壊す。

4. **hook を人間 merge 済みに限っても穴は残る(元要求の撤回)。** hook はハーネス側で走り、その実行対象は workspace の中身(`node_modules`、`package.json` の scripts)である。人間 merge 済みの hook `npm run --silent fmt` を生かした構成で、worker に**ごく普通のタスク**(「`fmt` スクリプトにビルドスタンプの `touch` を足して」)を投げたところ、hook が worker の書いたコマンドを**サンドボックス外で実行し、workspace の外にファイルが落ちた**。worker は `.claude/` に一切触れていない。「勝手に設定していない hook は機能させる」という当初の要求は、hook が**参照する先**が worker 可書きである限り届かない。したがって worker セッションでは hooks を一律に殺す。失うのは自動整形の利便性だけで、tidepool 自身の biome hook は CI(`npm run lint`)が受け止める。

5. **settings ファイルへの書き込み禁止は sandbox 側で `denyWrite` の形が割れる。** ディレクトリ単位 `denyWrite: [<ws>/.claude]` は Linux(bwrap)で**サンドボックスごと起動不能**にする(`bwrap: Can't create file at .../.claude/commands: Read-only file system` — ADR 0033 の review 書き込み床が bwrap で成立しなかったのと同じ backend 制約)。**ファイル単位** `denyWrite: [<ws>/.claude/settings.json, <ws>/.claude/settings.local.json]` は両プラットフォームで堅牢: 直接書き込みと新規作成を塞ぎ、`rm -rf .claude` → symlink 差し替え → 実名で書く escape も塞ぐ(Linux は bwrap が denyWrite パスに /dev/null stub を bind して親を削除不能にする — 保護ファイルの実在は不問。macOS も保護ファイルを含む親の `rm -rf` を拒否する)。

## 決定: 二機構を両方入れる(どちらも他方を代替しない)

**機構1 — hooks の無効化**: 両プロファイルの sandbox settings に `disableAllHooks: true` をコード定数で足す(床はデータの状態に依存しない — ADR 0013)。

**機構2 — settings ファイルへの書き込み禁止(二層)**:
- **Bash 経路**(sandbox は Bash のみを縛る): `denyWrite` に**ファイル単位**で `<ws>/.claude/settings.json` と `<ws>/.claude/settings.local.json` を足す。ディレクトリ単位は Linux で不可。
- **ツール経路**(`auto` の分類器をすり抜ける Write/Edit): `permissions.deny` に `Write` / `Edit` / `MultiEdit` × 両ファイルの6エントリ。`NotebookEdit` は ipynb 専用で JSON settings に効かないため除外。deny は literal path で判定されるので、worker が `.claude` を symlink 化してもツールの `file_path` 引数は `.claude/settings.json` のままで効く。

**両方が要る理由**: 機構1だけでは読み取り床のホットリロード(実測 2、認証情報窃取)が残る。機構2だけでは正当 hook 経由の非サンドボックス実行(実測 4)が残る。機構2は副産物としてスコープの族(`hooks` / `env` / `apiKeyHelper` / `statusLine` 等、ハーネス側実行・構成変更を運ぶ全キー)を**根元で閉じる** — settings ファイルを書けない worker はどのキーも仕込めないので、キーを1つずつ列挙・追従する必要がない。

**`floorOverridingSettings` の `FLOOR_DEFINING_KEYS` に `hooks` は足さない。** 機構1が hooks を無害化する以上、hooks を持つだけの workspace を quarantine するのは過剰であり、biome hook を持つ tidepool 自身を永久 quarantine にしてしまう。既存の `sandbox` / `permissions` ガードは残す — それらは機構2で書き込み経路が塞がれた後も、万一の書き込みに対する深層防御として意味を持つ(ホットリロードで判明したとおり、spawn 時ガードは単独では床にならないが、書き込み禁止と重ねれば「書けもしないし、書けても検出する」の二枚になる)。

## fail-closed と canary は ADR 0033 に相乗りする

hooks / settings 書き込みの封じ込めは ADR 0033 の封じ込め能力ゲートには**新しい停止条件を足さない** — 床がコード定数として常に入るため、成立/不成立の分岐が無い(サンドボックスに入れるか、という既存の問いに吸収される)。ただし CLI 更新で `disableAllHooks` の意味論やベンダー既定が静かに変わるのは検出しないと分からない(`-p` 下では検証に失敗した `--settings` が黙って無視される — ADR 0033)。したがって deploy-pi のサンドボックス e2e スモークに canary を1本足す: **workspace に「発火してはならない hook」+ 対照(セッションが実際に走ったことの印)を置き、hook が発火しないこと**を主張する。偽キーの negative control(実在キーと黙殺の区別)も同居させる — ADR 0033 の「設定ファイルが黙って捨てられていないことの control」と同じ形。per-pickup の能力検査には足さない(フル CLI spawn は高価)— deploy 時の一度きりが既存の線。

## Considered options

- **option (a) registry で workspace ごとに hooks 可否を宣言** — tidepool 自身の repo は biome hook を正当に使い、かつ worker が最も多く走る場所。そこに「hooks 可」を宣言した瞬間、まさに塞ぎたい場所で穴が開き直る。ADR 0013(床はデータの状態に依存しない)とも正面衝突する。
- **option (b) 保護ブランチ上の hooks だけ信頼し、タスクブランチの変更を spawn 時に検出して quarantine** — 実測 1(ホットリロード)で spawn 時検出が原理的に届かず、実測 4(正当 hook でも参照先が worker 可書き)で「保護ブランチ = 信頼できる」の前提自体が崩れた。加えて v1 には auto-merge(`auto_if_ci_green`)が実在し、low-risk タスクの hook 変更 PR は CI green なら人間の目を通らず保護ブランチへ着地する。
- **option (c) `--setting-sources` で project settings を落とす** — hooks には効くが workspace skill と CLAUDE.md を道連れにする(実測 3)。ADR 0033 の実測では `sandbox` ブロックには効かなかった(層ごとに vendor 挙動が不整合)ので、床の防御としては信頼できない。
- **hook コマンドの許可リスト(絶対パス・workspace 非参照のみ)** — 元要求「正当な hook を生かす」の唯一の生存変種だが、tidepool の唯一の正当な hook である `npx biome check --write .` が定義上これを満たせない(参照先が workspace)。仕組みだけ増えて何も救えない。

## 追記: 実装時に `permissions.deny` の綴りが実測で割れた(2026-08-03、issue #160)

機構1(`disableAllHooks: true`)と機構2の Bash 経路(**ファイル単位**の `denyWrite` 2本)は設計どおりに入り、macOS 2.1.220 と本番 Pi 2.1.207 / bwrap の両方で設計どおりに測れた。ディレクトリ単位を避けた判断も裏が取れている — ファイル単位の `denyWrite` を載せたプロファイルで Pi のセッションは正常に起動し、仕事をして終了した(`failIfUnavailable: true` の下では、走ったこと自体がサンドボックスが立ったことの証拠になる)。

**割れたのは機構2のツール経路の綴りだけ。** 本 ADR は `Write` / `Edit` / `MultiEdit` × 2ファイルの6エントリを書いたが、実装時に測り直すと**そのうち4本は何も enforce していなかった**。CLI 2.1.220 は起動時にそれを名指しで言う:

- `Write(path)` — 「is not matched by file permission checks — only `Edit(path)` rules are. Use `Edit(path)` instead (Edit rules cover all file-editing tools).」
- `MultiEdit(...)` — 「matches no known tool — check for typos.」

警告文だけを根拠にはせず、同一の中立ペイロード(`{"env":{"BUILD_STAMP":"1"}}` — C2 が分類器をすり抜けたのと同じ「ごく普通の依頼」の形)で測り直した:

| `permissions.deny` | Write ツールの結果 |
|---|---|
| `Edit` 2本のみ | **拒否**。`File is in a directory that is denied by your permission settings.` 既存の上書きも、存在しない `settings.local.json` の新規作成も成立しない |
| `Write` + `MultiEdit` 4本(`Edit` 抜き) | deny ルールは**沈黙**。止めたのは auto モードの分類器(`Blocked by classifier.`)= モデル判断であり、ADR 0033 が床として当てにしないと決めているもの |
| 空(control) | 上書きも新規作成も**通る** |

したがって**綴りは `Edit(path)` の2本**にした。これは決定の変更ではない — 6本のうち4本は床を 1mm も運んでおらず、載せ続けても得るものが無い一方で、毎 worker セッションのログに6行の警告を出し、しかもその文面が読者に「Edit に直せ」と指示する。本 ADR の「実測が設計を規定する」に従った結果である。

**そのぶん canary の責務が増えた。** 「`Edit(path)` は全 file-editing tool を覆う」はベンダーの主張であって、tidepool 側で列挙できる規則ではない。CLI は**照合されないルールは警告するが、覆いが狭まったことは警告しない** — 将来 `Write` が `Edit` の傘から外れれば、床は音もなく消える。よって deploy-pi の canary は hook の不活性だけでなく、**deny ルール自身の文面による拒否**も毎回測る(`hook-canary.sh` の `deny` 行)。分類器が断っただけの回を合格にしないのが要点で、それを許すと deny が効かなくなった日に緑のまま出荷される。

`FLOOR_DEFINING_KEYS` は本文どおり触っていない(`hooks` は足していない)。

### 追記の追記: deny の**広さ**は測らないと分からない(同日)

拒否文言は `File is in a **directory** that is denied by your permission settings.` である。「ディレクトリが deny されている」と読める文面なので、`Edit(.claude/settings.json)` が `.claude/` 配下まるごとの ban として解決されている可能性が残る。そうなっていれば ADR 0025 の `@workspace` skill スコープが消え、worker が最も多く走る tidepool 自身の repo が日常タスクで踏む — **しかも emit される配列は変わらないので、盤面のテストは何も言わない**。

実測(macOS 2.1.220 / Pi 2.1.207、いずれも Edit 2本が効いている状態):`.claude/skills/**` も `.claude/commands/**` も**書けた**。ban はファイル単位で、文言が紛らわしいだけである。これを canary の `deny/scope` 行として固定した。

**その過程で、canary 自身の設計欠陥を2つ踏んだ(記録に値する)。**

1. **1セッションに両方の `.claude` 書き込みを入れると、分類器が汚染する。** Pi で「skills を書け」と「settings を書け」を同一セッションで頼むと、**skills の方まで**拒否された。同じ skills 書き込みを単独セッションで撃つと同じプロファイルで**2回とも成功**する。決定論的なルールにこの挙動はできない — 分類器が要求全体を circumvention と読み、隣まで巻き込んだ。よって scope の control は control セッション側(`permissions.deny` は同一)へ分けた。
2. **拒否文字列を出力全体に grep すると誤帰属する。** 上記の汚染回では、`deny` 行が **skills の拒否文字列**を拾って PASS を出していた。2つを別セッションに分けたことで、`.claude` 書き込みが1セッションに1つしか無くなり、構造的に解消した。

拒否の綴りも版で割れる。2.1.220 は file-permission check の `File is in a directory that is denied…`、2.1.207 は分類器がルールを引用する形(`… circumvents the configured Edit(.claude/settings.local.json) deny rule`)。どちらも**設定されたルールを名指しする**ので両方を合格とし、何も名指さない `Blocked by classifier.` は合格にしない — そこを緩めると、deny が効かなくなった日に分類器の気分で緑が出る。

### 射程の境界(#151 との分担)

本 ADR が塞いだのは **workspace 由来の床上書き**であって、ホスト全域の封じ込めではない。「worker はもう床を書き換えられない」と読んではならない。

二層目の `permissions.deny` はパスを名指しする形なので、覆っているのは checkout 内の2ファイルだけである。**`~/.claude/settings.json`(user tier)への Write は本 ADR の射程外**で、そこは #151(work プロファイルのツール層にサンドボックスの床が掛かっていない)の領分になる。

ただしその迂回路は #151 自身に**劣後する** — 床を広げてから Bash で読むより、Read ツールで `~/.claude/.credentials.json` を直接読むほうが早い。したがって user tier をここで列挙して追いかけるより、#151 を対処候補2(work も `--permission-mode manual`)で解く方が筋がよい。そちらが入れば、この射程外だった経路も同時に閉じる。
