# worker のツール層の床は permission モードが持つ: `auto` は permission に背いていない — 残余の既定が「はい」だっただけ

issue #151 のグリリング(2026-08-03)で決定。ADR 0033 のサンドボックスが**届かない層** — ハーネス内 in-process のツール(Read / Write / Edit / Glob / Grep …) — に床を建てる決定であり、ADR 0035 が review について狭く述べたことの一般化である。

**この文書が塞ぐ穴**: work プロファイルの worker は、ツール層にサンドボックスの床が一切掛かっていなかった。ADR 0033 の line 11/12 が「Read は permission 層が cwd に閉じている」という前提で役割分担を書いたが、その前提は `--permission-mode auto` では成立しない。読みだけではない — #143 のグリリングが Write ツールも同じ層にいることを実測しており、**work worker はホスト上の読める物すべてを読め、書ける場所すべてに書けた**。

## 出発点の再定義: `auto` は permission ルールに従っている

issue #151 は「`auto` は permission を尊重しない」と読める書き方をしていたが、実測はそうではない。**本 ADR のグリリングで `permissions.deny` を発火させた測定はすべて `--permission-mode auto` のセッションである** — `Read(//**)` の deny は `auto` の下で決定的に拒否を返し、`..` でも symlink でも抜けられなかった(下表)。deny は分類器の**上**にいる。

`auto` に無いのは服従ではなく**既定値**である。ルールが何も言っていない操作に対して、

- `auto` の残余の答え = **分類器の自己承認**(既定「はい」)
- `acceptEdits` / `manual` の残余の答え = **承認要求**(headless では誰も承認できないので、既定「いいえ」)

したがって**床とは残余の既定である**。サンドボックスは Bash の残余を OS の拒否に倒す。permission モードはツール層の残余を「訊く = 拒む」に倒す。work が `auto` だった間、ツール層の残余だけが「はい」に倒れていた。ADR 0035 が review について書いた「訊くこと自体が拒否である」は、この一般則の1事例だったことになる。

## 実測が設計を規定する

macOS 2.1.220 / Seatbelt と本番 Pi 2.1.207 / bwrap。プロファイルはすべて `scripts/emit-sandbox-settings.ts` が盤面のコードから吐いたもので、手書きの profile は1つも使っていない。判定はファイルシステムの状態と逐語の拒否文言で行い、モデルの語りは判定に使っていない。全量は issue #151 のコメントにある。

### 1. deny だけでは default-deny が表現できない

| 測定 | 結果 |
|---|---|
| `deny: [Read(//**)]` + `allow: [Read(<ws>/**)]` で **cwd 外**を Read | 拒否 `File is in a directory that is denied by your permission settings.` |
| 同じ設定で **workspace 内**を Read | **拒否** |
| control(ルール無し)で cwd 外を Read | **読めた** — #151 の穴を盤面の実プロファイルで再現 |

**allow はパスルールでも deny に勝てない。** ADR 0033 実験2 の「deny は allow に常勝」が、パスルールについても成り立つことの初めての実測である(既存の実測は `Bash(rm*)` だけだった)。Read ツールの `file_path` は絶対パス必須なので「絶対を deny して相対で workspace を使う」という逃げ道も無い。**したがって候補1(`permissions.deny` の列挙で床を建てる)は、default-deny ではなく「守りたい資産の列挙」にしかならない** — ADR 0035 が書き込み側で失敗を記録したのと同じ形である。

### 2. deny は解決済みパスに照合される

deny を `Read(//<outside dir>/**)` 1本だけにした状態で:

| 経路 | 結果 |
|---|---|
| 素の絶対パス | 拒否(ルールを名指し) |
| `<ws>/../../…/<outside>/asset.txt` | **拒否** |
| workspace 内の symlink 経由 | 拒否。**deny を空にした control では同じ読みが成功** |

**`..` も symlink も抜けられない。** ゆえに deny の集合は紙の壁ではない — 候補1 が死ぬのは表現力の問題であって、執行力の問題ではない。

### 3. 読み側の綴りはベンダーが名指しする

`permissions.deny` に候補を並べて起動しただけのセッション(file 操作なし)で:

- `Fictional(//**)`(負の control)→ `matches no known tool — check for typos.`
- `Glob(//**)` → `is not matched by file permission checks — only Read(path) rules are. Use Read(//**) instead (Read rules cover all file-reading tools).`

負の control が発火するので、この警告は信号として信頼できる。**`Read(path)` が全 file-reading tool を覆う** — ADR 0037 が書き側で見つけた `Edit(path)` の鏡像である。ただしどちらも**ベンダーの主張**であり、tidepool 側で列挙できる規則ではない(canary の責務。ADR 0037 追記と同じ)。

### 4. `acceptEdits` は受け入れフィルタを全項目通す

サンドボックスは work プロファイルのまま — `autoAllowBashIfSandboxed` は既定 `true` なので、**Bash は今日と一切変わらない**(OS だけが縛る)。MCP は最小の stdio サーバーを立て、verb の実行をマーカーファイルで判定した。

| row | macOS 2.1.220 | Pi 2.1.207 / bwrap |
|---|---|---|
| Write / Edit / Bash(リダイレクト付き)を workspace 内で | PASS | PASS |
| workspace 内の Read | PASS | — |
| MCP verb(`--allowedTools mcp__tidepool` 無し) | **承認要求で死ぬ** | — |
| MCP verb(`--allowedTools mcp__tidepool` 付き) | PASS | PASS |
| **cwd 外の Read** | **拒否** | **拒否** |
| ↑ の `auto` control | 読めた | 読めた |
| **cwd 外の Write** | **拒否**(ファイル生成なし) | **拒否** |
| ↑ の `auto` control | 書けた | 書けた |
| サンドボックス起動 | — | 全行正常(bwrap エラーなし) |

拒否文言は両プラットフォームで同一:

```
Claude requested permissions to read from …, but you haven't granted it yet.
Claude requested permissions to write to …, but you haven't granted it yet.
```

**全セッションを通じて `Blocked by classifier.` は一度も出ていない。** 拒否の正体は分類器ではなく permission 層の承認要求であり、ADR 0035 が review の書き込み床に使ったのと同一の機構である。

`--allowedTools` が `acceptEdits` を strict に反転させないことも、本番の形(`acceptEdits` + `--setting-sources project` + `--allowedTools mcp__tidepool`)で Write / Edit / Bash / MCP の4つを同一セッションに通して確認した。ADR 0035 実測3 の `acceptEdits` 版である。

**Pi で測ったものの範囲**: Pi にデプロイ済みの盤面コードは #160 以前(吐かれた profile に `disableAllHooks` も `permissions` も無い)。したがって Pi が検証したのは**モードの cwd 境界と `failIfUnavailable` 下でのサンドボックス起動**であって、出荷される profile 全体ではない。

`Skill` ツールは `acceptEdits` で素通しする(skill 本文のトークンを報告させて確認)。承認要求に落ちていたら ADR 0025 の skill allowlist が work セッションで全滅していた。

### 5. 床は human の設定ファイルに依存していた

`--permission-mode` は flag tier だが、permission の**マージ**は tier をまたぐ。

| user tier(`~/.claude/settings.json`)に置いた鍵 | 結果 |
|---|---|
| `permissions.allow: ["Read(//<outside>/**)"]` | **境界が持ち上がった**(cwd 外が読めた) |
| `permissions.defaultMode: "bypassPermissions"` | 不活性(flag tier が勝つ) |

しかもこれは仮想の脅威ではなかった。**開発機の実物の `~/.claude/settings.json` には既に `Read(//tmp/**)` / `Read(//private/tmp/**)` / `WebSearch` / `WebFetch(domain:…)` が入っていた** — 人間が自分の対話用に溜めたものである。ADR 0037 の形(worker にそのファイルを書かせない)ではこれは解けない。**人間が既に書いたものが残る。**

同じ性質は **local tier**(`<ws>/.claude/settings.local.json`)にもある。ADR 0035 は「`manual` の床を持ち上げるのは local tier の `allow` **だけ**」と実測しており、`acceptEdits` の境界についても同じことを control 付きで測り直した:

| 条件(checkout の `settings.local.json` に `Read(//<outside>/**)` を仕込む) | 結果 |
|---|---|
| 既定の setting sources | **境界が持ち上がった**(cwd 外が読めた) |
| `--setting-sources project` | 拒否 ⇒ local tier は落ちた |

このファイルは **gitignore されるので人間の merge にも review にも掛からず、許可プロンプトの「今後は訊かない」で自動的に太る**。本 ADR のグリリング中に tidepool 自身の checkout にその実例(`Bash(strings *)`)が生えた。

### 6. `--setting-sources project` は user/local tier を落とし、道連れは限定的

ADR 0037 が測ったのは `--setting-sources user` と `""` で、どちらも workspace の skill と CLAUDE.md を道連れにした。逆側の選択は違う。

| 測定(`--setting-sources project`) | 結果 |
|---|---|
| user tier に allow を仕込んだ状態で cwd 外を Read | **拒否** ⇒ user tier は落ちた |
| local tier に allow を仕込んだ状態で cwd 外を Read | **拒否** ⇒ local tier も落ちた(control: 既定 sources では読めた) |
| workspace の CLAUDE.md | 届いた |
| workspace skill(CLI の `init` イベントの `skills` 配列) | 残った |
| `~/.claude/skills` の user skill / plugin skill | **消えた** |
| review プロファイル(`manual` + 本番フラグ)の workspace 読み・MCP verb・書き込み床 | 3つとも無傷 |

### 7. skill の補助ファイルは `permissions.allow` を必要としない

当初は `skillReadPaths`(ADR 0033)を `Read(...)` として `permissions.allow` にも流す計画だったが、2つの測定がそれを不要にした。

| 測定 | 結果 |
|---|---|
| skill を発火させてから自分の補助ファイルを Read | **拒否**(発火はディレクトリを開かない) |
| 同じファイルを発火させずに Read | 拒否 |
| **同梱 skill** を発火させて `references/*.md` を Read | **読めた**(`/private/tmp/claude-501/bundled-skills/<version>/<hash>/…`) |

同梱 skill はバイナリ埋め込みで、ハーネスが実行時に自分の temp 配下へ展開する。そこはハーネス自身の領域として読める。したがって `--setting-sources project` の下で work が到達しうる skill は **(a) workspace skill(cwd 内、元から読める)と (b) 同梱 skill(ハーネスが開ける)** の2種類だけであり、`skillReadPaths` が返す `~/.claude/skills/<name>` と `~/.claude/plugins` は**列挙されない = 開けても死んだパス**である。`src/sandbox.ts` は本 ADR では無変更。

### 8. 許可リストはコンテキストのレバーではない

| 条件 | プロンプト |
|---|---|
| 同梱16 skill すべて許可 | `cache_creation = 35069` |
| 同梱16 skill すべて `Skill(name)` で deny | `cache_read = 35069`(**キャッシュヒット**) |

キャッシュヒットはプロンプトが**バイト同一**だったことの証明である。`--disallowedTools Skill(name)` は注入量を1トークンも減らさない — 許可リストは入口の開閉であって、載る一覧を変えない。CONTEXT.md / issue #132 の「許可リストはその入口を開けておくかどうかだけを決める」の線どおりだが、「一覧も消えない」ことは本 ADR が初めて測った。

減らせるレバーは2つだけで、片方は本決定そのものである:

| 条件 | プロンプト | skill 数 |
|---|---|---|
| 今日(全 setting source) | 38,029 | 22 |
| **本決定**(`--setting-sources project`) | **35,395** | 16 |
| さらに `skills: []`(= `--disable-slash-commands`、ADR 0025 点5) | 32,576 | 0 |

本決定は副産物として注入量を約 2,600 トークン減らす。

## 決定

**1. work の `--permission-mode` を `auto` から `acceptEdits` へ。** review は `manual` のまま(ADR 0035)。これで**盤面から `auto` が消え、分類器はどの worker セッションの床にも関与しなくなる**。

**2. `--setting-sources project` を両プロファイルに。** 床はどちらの worker が走っているかを問わない(ADR 0013)。user tier と local tier は worker に何も買わない — 盤面は必要なものを全部 flag tier(`--settings`)で渡す — 一方でどちらも床を持ち上げられることが実測で立っている。`project` を残すのは workspace の skill と CLAUDE.md がそこに乗るためで、`""` は ADR 0037 が測ったとおりそれらを道連れにする。

**3. `--allowedTools` に `mcp__tidepool` を両プロファイルで。** `auto` を離れると MCP verb が全部承認待ちになり、盤面への唯一の channel が詰まってセッションが仕事にならない(ADR 0035 実測2 が review について測ったのと同じことが work にも起きる)。verb の権限は盤面側(authority profile / MCP router)が縛るので、CLI 側で開けても権限モデルは緩まない。`review_allowed_commands` は review 専用のまま。

**4. `src/sandbox.ts` は無変更**(上記7)。

## 層の分担(ADR 0035 の「層の分担」の一般化)

- **OS サンドボックス(ADR 0033)** — Bash の読み視界・ネットワーク・書き込み半径。**ツール層には届かない**、というのが本 ADR の出発点。
- **permission モード(flag tier)** — ツール層の残余の既定。work は `acceptEdits`(編集は通す、cwd 外は訊く)、review は `manual`(副作用は全部訊く)。
- **`permissions.deny`(flag tier)** — モードの上に立つ決定的な拒否。ADR 0037 の settings 2ファイルがここに乗る。deny は allow にも分類器にもモードにも勝つ。
- **`--setting-sources`** — 上の3層に対して、**誰が permission を書き足せるか**を絞る。人間の user tier も、gitignore された local tier も、worker の床には触れない。
- **slot-release tree rule** — 残余の汚れの機械的回収。

## 失うもの

**ホストが持ち込む skill のうち、`~/.claude/skills` の user skill と plugin skill は worker に届かなくなる。** CLI 同梱の skill は届く(補助ファイル込みで完全に機能することを実測)。CONTEXT.md の Skill allowlist の `@host` は「ホスト環境が持ち込む skill 全部 — 盤面が管理しない物」から **「CLI 同梱の skill」** に定義を絞る — スコープ語自体は非空の集合に解決され続けるので残す。registry の現行 agent 定義は `@host` も user skill 名も使っていないので、今日の実損はゼロである。

この線は ADR 0033 の「守る資産の定義」と整合する: 盤面が管理しない物を worker のセッションに持ち込まない。

## `floorOverridingSettings` の前提が動いたことについて

このガード(`src/sandbox.ts`)は checkout の `settings.json` / `settings.local.json` が `sandbox` / `permissions` キーを持つときに workspace を quarantine する。本決定の後、**`settings.local.json` はもうセッションにマージされない**ので、そこに `permissions` を持つ workspace は「セッションに影響しえないファイル」を理由に quarantine されることになる。

これは不具合ではなく、意図して残す。理由は ADR 0037 の判断と同じ — spawn 時ガードは単独では床にならないが、書き込み禁止と重ねれば「書けもしないし、書けても検出する」の二枚になる。加えて `--setting-sources` はフラグであり、フラグの綴りが将来変わる・落ちるといった事故に対して、このガードは source 選択とは独立に働く。**ただし将来の読者が前提のずれで躓かないよう、ここに明記する。**

## ADR 0037 の記述の訂正(結論は無傷)

ADR 0037 は `SETTINGS_TOOL_DENY` について「deny はツール呼び出しの**リテラルな** `file_path` 引数に照合されるので、worker が `.claude` を symlink で差し替えても `.claude/settings.json` を提出するから refuse される」と書いた。**読み側の実測(上記2)はリテラル照合ではなく解決済みパス照合を示している。**

同 ADR の**結論は保たれる** — ルール側の `Edit(.claude/settings.json)` も引数側の `.claude/settings.json` も、同じ cwd と同じ symlink を通して解決されるので、両者は一致し続ける。訂正が要るのは理由の記述だけであり、#160 の再審議は不要である。

## canary

`acceptEdits` の cwd 境界は**設定キーではなくベンダーの既定挙動**である。CLI 更新で黙って変わりうる上に、**CLI は「覆いが狭まった」ことを警告しない**(照合されないルールは名指しするが、それは別の話 — ADR 0037 追記)。盤面のテストも何も言えない(ADR 0027: 自動テストはサーバー境界で止まる。emit される配列は変わらない)。

したがって deploy-pi に **3本目の canary(`tool-floor-canary.sh`)** を足す:

- **`read_floor` / `write_floor`** — 盤面が吐く work プロファイル + 本番フラグで、cwd 外の Read と Write が拒否されること。
- **それぞれの `auto` control** — 同じ操作が `auto` では通ること。これが無いと「拒否された」と「`--settings` が黙って捨てられた」が区別できない(`-p` 下で検証に失敗した settings は黙殺される — ADR 0033)。
- **分類器の拒否は合格にしない。** `Blocked by classifier.` はモデルの判断であり、ADR 0033 が床として数えないと決めているもの。

既存 canary と同居させないのは、この canary の control が**別フラグの別セッション**だからである(hook-canary の control は「キー名を偽物に差し替えた同一形」で、構造が違う)。

**同時に `hook-canary.sh` を本番の形へ揃える。** あれは今 `--permission-mode auto` でセッションを回しており、本決定の後それは盤面が吐かない形になる。`acceptEdits` + `--setting-sources project` + `--allowedTools mcp__tidepool` へ移す。その形で ADR 0037 の deny 行がまだ発火することは実測済み(`File is in a directory that is denied by your permission settings.`、分類器は沈黙)。

封じ込め能力ゲート(CONTEXT.md)には新しい停止条件を足さない — 床がフラグとして常に入るため、成立/不成立の分岐が無い。ADR 0037 と同じ整理である。

## 追記(2026-08-03、#162 の実装中に実測): `acceptEdits` は cwd 内の `.claude/` への書き込みも承認要求に落とす

hook-canary を本番の形へ移した最初の実走で、`deny/scope` 行 —— control セッションが `<ws>/.claude/skills/tp-canary-probe/SKILL.md` を**書けること**を確かめる行 —— が VACUOUS になった。拒否文言は deny ルールのものではなく**モードのもの**だった:

```
Claude requested permissions to write to <ws>/.claude/skills/tp-canary-probe/SKILL.md,
but you haven't granted it yet.
```

同じセッションの `notes.txt`(cwd 直下の新規ファイル、ディレクトリ作成なし)は書けている。つまり `acceptEdits` の「編集は通す」は cwd 内でも一律ではない。**何がこの2つを分けたかは測っていない** — `.claude/` 配下だからなのか、途中の2階層を新規作成する書き込みだからなのか、他の要因かは未測である。

**決定への影響は無い。** ADR 0025 の `@workspace` skill はセッションが skill を**読む**話であり、worker がその workspace に skill を**書く**能力を盤面は必要としていない。#160 が塞いだ `settings.json` / `settings.local.json` への書き込みは、この上にさらに `permissions.deny` が乗っている(deny はモードに勝つ)。

**canary の設計には影響した。** `deny/scope` 行の判定材料を「書けたこと」から「**どの層が拒否したか**」へ移した。この行が問うのは ban が2ファイルから `.claude/` まるごとへ広がっていないかであり、deny はモードの上に立つ(本 ADR の層の分担)ので、広がった ban なら**先に**ルール自身の文言で拒否する。ルールが黙ったまま(モードが拒否した)なら ban は広がっていない。書き込みが成立しなくなった以上、こちらの方が測れる形である。

## Considered options

- **`permissions.deny` の列挙(issue #151 の候補1)** — 上記1のとおり `allow` が `deny` に勝てないので default-deny が表現できず、「守りたい資産の列挙」に格下げされる。守る対象は「ホスト上の読める物すべて」で有限集合ではなく、追従漏れが静かに床の穴になる。ADR 0035 が書き込み側で記録した失敗の再演である。
- **補集合の機械計算** — workspace の祖先チェーンを spawn 時に辿り、各階層で経路上の1つ以外の全兄弟を deny する。意味論としては default-deny と**等価**(近似ではない)で、上記2により執行力もある。それでも採らない: (i) 床がファイルシステムの状態に依存し、ADR 0013 の「床はデータの状態に依存しない」に斜めに当たる。(ii) TOCTOU の穴が残る — 同時に走る別 slot が新しい workspace を checkout すると、それは deny 集合に載っていない(workspace は互いに兄弟である)。(iii) canary が「網羅性」という新種の主張を検査することになる。`acceptEdits` が同じ結果を維持コストゼロ・穴なしで出すので、これらを背負う理由が無い。
- **work も `manual`(issue #151 の候補2)** — work は書けなければならず、`manual` は編集も承認要求に落とす。`acceptEdits` はちょうど一段緩い解であり、失うのは cwd 外だけである。
- **ベンダーのサンドボックスをツール層にも掛ける(issue #151 の候補3)** — 2.1.220 のバンドルから `sandbox` の zod スキーマを引いて確認した。存在しない。`filesystem.disabled` の説明文がベンダー自身の言葉でスコープを名指ししている:「**Sandboxed commands** get unrestricted read/write access to the host filesystem」。`filesystem` ブロックは終始 "sandboxed commands" の語彙で書かれている。(副産物として `filesystem.allowManagedReadPathsOnly`、`filesystem.disabled`、`sandbox.credentials`(`files`/`envVars` を `mode: "deny"` で名指しし、サンドボックス内には sentinel を置いて proxy で実値を注入する機構)が見つかった。いずれもサンドボックス内スコープなので本 ADR の穴は塞がない。)
- **user tier への `Edit` deny を足すだけ** — 上記5のとおり、worker に書かせない対処では**人間が既に書いた** allow が残る。実測で否定された。
- **`--setting-sources ""` / `user`** — ADR 0037 が測ったとおり workspace の skill と CLAUDE.md を道連れにする。ADR 0025 の `@workspace` スコープを壊す。
- **`--setting-sources project,local`(local を残す)** — user tier だけを落とす形。local tier は #160 の `Edit(.claude/settings.local.json)` deny が守ってはいるが、その deny は「`Edit(path)` が全 file-editing tool を覆う」というベンダーの主張に依存している。source ごと落とすのは構造的で、ベンダーの主張に依存しない。加えて local tier は worker に何も買わない。
- **`@host` をスコープ語ごと削除** — 実測(上記7)のとおり `@host` は空にならず、CLI 同梱 skill という補助ファイル込みで完全に機能する集合に解決される。かつ `@host` と「名前を1つだけ書く」の間にコンテキスト差はゼロ(上記8)なので、非空の能力を捨てる理由が無い。実装3箇所(`registry.ts` の文法、`claude-worker.ts` の補集合判定、`api.ts` の settings 画面ピッカー)と WebUI の affordance も失う。
