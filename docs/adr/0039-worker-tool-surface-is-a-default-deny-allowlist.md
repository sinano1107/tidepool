# worker のツール面は既定拒否の allowlist: 残余の既定が届かない層には、向きを反転させた別の機構が要る

issue #145 のグリリング(2026-08-03)で決定。ADR 0038 の**延長**である — 「床とは残余の既定である」はハーネス内 in-process のツール**全部**を覆っているように読めるが、実測はそうではない。ファイル操作でないツールは permission の subject ですらなく、モードの残余に落ちる対象に入っていない。

**この文書が塞ぐ穴**: `--permission-mode acceptEdits` + 本番フラグ一式の下で、worker は `CronCreate` を承認要求なしに実行できた。同じ面には `RemoteTrigger`(claude.ai の API に**人間のアカウント名義の OAuth token をプロセス内で自動付与**して routine を作成・実行する)、`PushNotification`(Quiet hours と Digest を素通りして人間の端末へ直接プッシュ)、`EnterWorktree`(セッションの cwd を `.claude/worktrees/` へ切り替える — branch discipline の外)が並んでいた。WORKER_PROTOCOL の「Invent no side channels」は**散文でしか**これらを塞いでいない。

## issue #145 の前提は実測で消えた

#145 は「worker の tool から question は外すべきかも(MCP に question ツールがあるので重複する)」だった。実測すると、**headless セッションの面に `AskUserQuestion` は現れない**(下表 1)。#145 自身の但し書き「headless だと自動的に消えているかも」が正しかった。

用語としても重複ではない。`AskUserQuestion` は**今そこにいる対話相手に同期的に訊く**ツールで、MCP の `escalate`(verb 名は `question` ではない)は**question タスクを登録して親を blocked にし、盤面の外で人間に答えてもらう** verb である。worker session に対話相手はいないので、前者は同じ場所への2本目の道ではなく**原理的に成立しない道**である(CONTEXT.md の Escalation に反映)。

外す対象は存在しなかった。しかし同じ probe が、その一層上に本物の穴を出した。

## 実測が設計を規定する

macOS 2.1.220。盤面が実際に吐くフラグ形(`--permission-mode acceptEdits --setting-sources project --disallowedTools Workflow --allowedTools mcp__tidepool --mcp-config … --strict-mcp-config --settings …`)で、サンドボックスプロファイルは `scripts/emit-sandbox-settings.ts work <ws>` が盤面のコードから吐いたもの。手書きの profile は使っていない。判定は init イベントの `tools` 配列とツール実行結果の逐語で行い、モデルの語りは判定に使っていない。**Pi では未実測**(実装時に確認する)。

### 1. headless の面に `AskUserQuestion` は無い

```
Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree,
ExitWorktree, Monitor, NotebookEdit, PushNotification, Read, RemoteTrigger,
ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskCreate, TaskGet,
TaskList, TaskOutput, TaskStop, TaskUpdate, ToolSearch, WebFetch, WebSearch, Write
```

`Workflow` がこのリストから消えていることが重要な control である — **この配列は deny 後の姿**であり、「元から無い」と「deny で消えた」を取り違えていない。

### 2. ADR 0038 の床は非ファイル系ツールに届いていない

| 測定 | 結果 |
|---|---|
| `acceptEdits` + 本番フラグ一式で `CronCreate` を呼ぶ | **SUCCESS** — `"Scheduled one-shot task 7978aca8 (7 4 1 1 *)"` |

承認要求に落ちず素通しで実行された。control は不要である — 「settings が黙殺された」と紛れるのは**拒否された**ときだけで、通った事実はどちらの settings 状態とも両立する。

この族が permission の subject でないことは、ADR 0038 の枠組みの中では**穴ではなく空白**である。残余の既定は「ルールが何も言っていない操作」に効くが、そもそも permission 層を通らない操作には効きようがない。

### 3. 列挙 deny はこの族に効く — が、向きが逆である

`--settings` の `permissions.deny` に `["CronCreate","PushNotification","RemoteTrigger","EnterWorktree","DesignSync","Bogus"]` を足すと、init の `tools` から該当5本が消えた(`Bogus` は無害に不活性、警告なし)。

**執行力はある。表現力の向きが違う。** 列挙 deny は閉世界の仮定であり、CLI 2.1.230 が `SendEmail` を足せば**開いたまま入ってくる**。ADR 0037 が「覆いが狭まったことを CLI は警告しない」と書いた痛みそのものである。しかも ADR 0037 の追記(#160)は、`Write(path)` / `MultiEdit(...)` という deny の綴りが**実は何も enforce していなかった**ことを実測している — この層は**黙って**効かなくなりうる。

### 4. `--tools` は既定拒否として効く

`--help`(2.1.220): 「Specify the list of available tools from the built-in set. Use `""` to disable all tools, `"default"` to use all tools, or specify tool names」

| `--tools` | 観測された組み込みツール |
|---|---|
| 指定なし | 上記28本 |
| `Bash,Read,Edit,Write,NotebookEdit,Skill,Task` | `Task, Bash, Edit, NotebookEdit, Read, Skill, Write` のみ |
| `Read,Glob,Grep` | `Glob, Grep, Read` のみ |

ADR 0038 が**パスに対しては存在しないと実測した default-deny が、組み込みツール面には存在する**。

### 5. MCP verb と skill は `--tools` を生き残る

最小の stdio MCP サーバー(`tidepool` / `get_current_task`)を立てて `--tools "Bash,Read,Edit,Write,NotebookEdit,Skill,Task"`:

```
TOOLS: ['Task','Bash','Edit','NotebookEdit','Read','Skill','Write','mcp__tidepool__get_current_task']
MCP:   [{'name':'tidepool','status':'connected'}]
```

skill も16本のまま。`--tools` は組み込みツール面**だけ**を閉じ、ADR 0025 の機構と盤面への channel には触れない。この事実がなければ本決定は成立しない。

### 6. allowlist は漏れない — `ToolSearch` もサブエージェントも境界の内側

| 測定 | 結果 |
|---|---|
| `--tools` に `ToolSearch` を足し、`ToolSearch("select:CronCreate")` → `CronCreate` | `No matching deferred tools found` |
| `--tools` に `Task` を足し、サブエージェントに自分のツール一覧と `CronCreate` を報告させる | allowlist そのものを列挙。`"no CronCreate tool is available to me"` |

ハーネスのツール検索経路もサブエージェントも `--tools` の内側にいる。

### 7. `Glob` / `Grep` は既定の面に無いが、名指しすれば現れる

`--tools` は削るだけの機構ではない。2.1.220 の既定の面に `Glob` / `Grep` は出ていないが、名指しすると現れる(測定4)。**work セッションに本物の検索ツールを与えられるのは、この allowlist を書くからである。**

### 8. 実在しない名前は警告なく不活性になる

`--tools "Read,Glob,Grep,TodoWrite,WebFetch,WebSearch,Bogus"` → 観測は `Glob, Grep, Read, WebFetch, WebSearch`。`TodoWrite` と `Bogus` は**何の警告もなく**消えた。

**綴りミスは黙って能力を1本削る。** ずれは双方向であり、どちらの向きも検知対象である(下記「検知」)。

### 9. ツールはコンテキストのレバーである(skill と逆)

同一プロンプト・同一モデルで `--tools` だけを変えた入力トークン合計:

| `--tools` | 面のツール数 | 入力トークン合計 |
|---|---|---|
| 既定 | 30 | 26,180 |
| 本決定の work リスト | 18 | 23,734(**−2,446 / −9.3%**) |
| `Read` のみ | 2 | 7,845(−70%) |

(ツール数は init の `tools` 配列の要素数なので、MCP verb 1本を含む — work リストの17本 + 1)

ADR 0038 は「skill 許可リストはコンテキストのレバーではない(16 skill 全許可 vs 全 deny でプロンプトがバイト同一)」と実測した。**ツールは削れば定義ごと消える。** ただし本決定の採用理由は床であって節約ではない — 9% は副産物である。

## 決定

### 1. `--tools` による既定拒否を両プロファイルに置く

- **work(17)**: `Bash, Read, Write, Edit, NotebookEdit, Glob, Grep, Skill, Task, WebFetch, WebSearch, TaskCreate, TaskGet, TaskList, TaskUpdate, TaskOutput, TaskStop`
- **review(14)**: 上記から `Write` / `Edit` / `NotebookEdit` を除いたもの

リストは**盤面のコード定数**であり、registry データではない(ADR 0013: 床はデータの状態に依存しない)。agent には依らず、task type にのみ依る。

載せた理由のうち自明でないもの:

- **`Task`(Agent)** — BOARD_DOCTRINE が意図的に開いている既決事項(ADR 0010 追記)。ここで黙って閉じるのは別の決定の密輸になる
- **`TaskOutput` / `TaskStop`** — todo リストの仲間ではなく `Bash` の `run_in_background` の受け口。落とすとバックグラウンド実行が使えない
- **`WebFetch` / `WebSearch`** — 人間面への到達は ADR 0036 の credential が既に執行しており(CONTEXT.md の人間面が「経路(loopback・tailnet・WebFetch)を問わず」と名指し済み)、この面の判断は再演しない

落とした理由のうち自明でないもの:

- **`RemoteTrigger`** — claude.ai の API に routine を作成・実行する。「the OAuth token is added automatically in-process」= **人間のアカウント名義の credential が worker のプロセス内で自動付与される**。ADR 0024 の「worker はいかなる GitHub credential も持たない」と同じ線が Anthropic 側にも引かれる
- **`PushNotification`** — Quiet hours と Digest を素通りして人間の注意を直接奪う
- **`Cron*` / `ScheduleWakeup`** — セッション内限定でありセッションを跨がない(ツール定義本文で確認)ので ADR 0010 の線には抵触しないが、タイマーは盤面の scheduler の領分であって worker のものではない
- **`EnterWorktree` / `ExitWorktree`** — セッションの cwd を切り替える。slot-release tree rule は「自分のブランチを離れていたらコミットを拒否して quarantine」と受け止めはするが、それは**壊れた資源**としての扱いである
- **`DesignSync`** — 書き込み系は permission prompt を要求するので ADR 0038 の床が届くが、読み取り系は人間の claude.ai login で素通りする。落とす理由は権限ではなく**必要性**: tidepool の Design System のローカルミラー(`styles.css` / `tokens/` / `_ds_bundle.js` / `ui_kits/`)は既に repo の中にあり、DS の同期は人間の作業であって worker のタスクではない
- **`Monitor`** — 「1回だけ知らせてほしい」は `run_in_background` + `TaskOutput` で足り、headless で通知を受け取るのはセッション自身である。加えて `ws` ソースは Bash を経由しない in-process の WebSocket であり、サンドボックスの `network.deniedDomains` の外に出る可能性がある(**未実測** — 落とすことで moot になる)
- **`ToolSearch`** — 測定6 のとおり `--tools` の外は引けないので、必要なものを全部名指ししてある以上は無用

### 2. review の編集系除去は深層防御であって床の移設ではない

review の書き込み床は ADR 0035 が置いた場所(`--permission-mode manual` + `autoAllowBashIfSandboxed: false`)に**そのまま残る**。`reviewToolDenials` の `Edit` / `Write` / `NotebookEdit` も残す — ADR 0038 が `floorOverridingSettings` について取ったのと同じ姿勢である。

2層にする理由は冗長性ではなく**性質の違い**である。deny 層は ADR 0037 追記が実測したとおり**黙って**効かなくなりうるのに対し、`--tools` による除去は init イベントの `tools` 配列を読めば**観測できる**。黙って失敗する層の下に、観測できる層を敷く。副次的に、review の書き込み床が「実際に書こうとしてみる」副作用つき probe なしで検査できるようになる。

`REVIEW_BASH_WRITE_DENIALS` は移せない — Bash は1ツールなので `--tools` の粒度では表現できない。

### 3. ずれの検知は封じ込め能力の3つ目の問いにする

ツール面のドリフトは **workspace の性質でも agent の性質でもなく、ホストの性質**である — このホストの CLI が盤面の宣言を honor しなくなった、という事実。CONTEXT.md の Containment capability は「止められるより狭い資源が存在しない唯一の資源」として定義されており、ツール面はその定義にそのまま当てはまる。不成立なら盤面全体の pickup が止まり、Tidepool 名義の確認 question が立つ。

検知は**双方向**である:

- **観測 ⊃ 期待** — 盤面の宣言が honor されなくなった / 新ツールが素通りしてきた
- **観測 ⊂ 期待** — 挙げた名前が改名・廃止されて黙って不活性化した(測定8)。この向きは worker が能力を1つ失ったまま走り続けるので、タスクが詰まって初めて分かる

したがって照合は**集合の一致**である。ただし `mcp__` で始まるエントリは比較対象から外す — MCP サーバーが繋がらなかったセッションでは verb が丸ごと消えるので、含めると「盤面の MCP が落ちている」が封じ込め能力の不成立に化ける。それは別の障害であり別の扱いを受けるべきである。

正本は **`/usage` ping**(起動時 / pickup ごと / quarantine の回答受理時)。既存の skill 列挙 ping(`defaultEnumerateSkills` / `parseInitSkills`)が**すでに init イベントを取って返す機構そのもの**なので、`tools` も見るだけの小改造で済む。ping が `--tools` を反映することは実測済み — work リスト + 本番フラグ一式の `/usage` ping の init が `tools` 18本(組み込み17 + MCP verb 1)、`skills` 16本を返した。オンデマンドに走らせられることが必須である — 解除は「能力検査を回答時にもう一度走らせて成立する」ことで検証されるため、再実行できない検査は確認 question を受理できない。

worker 自身の init 行の照合も**深層防御として重ねる**。追加コストは実質ゼロ(盤面は既に worker の stdout を1行ずつパースしている)で、実セッションそのものを測れる。比較関数と期待集合は1つのコード定数を共有する。

### 4. deploy 時 canary は作らない

既存の canary 3本が deploy 時にあるのは、ファイル床の成否が**盤面から観測できない**からである(ADR 0027 の線)。この性質は違う — 盤面自身が毎 spawn・全ホストで実測できる。しかも **CLI の自動更新は deploy と deploy の間に起きる**ので、deploy 時のスナップショットではそこで生じたドリフトを捕まえられない。決定3が決定4を包含する。

## 却下した選択肢

- **`permissions.deny` / `--disallowedTools` による列挙 deny** — 執行力はある(測定3)が閉世界の仮定であり、ベンダーが増やしたツールは**開いたまま**入ってくる。ADR 0038 が Bash について「列挙で塞ぐ試みは失敗した」と書いたのとは失敗理由が違う(ラッパの無限性ではなく、集合が未来に開いていること)が、結論は同じ方向を向く
- **何もしない(WORKER_PROTOCOL の散文に任せる)** — 現状であり、測定2 がその不十分さそのものである

## 帰結

- ハーネスが新しい組み込みツールを増やしても、盤面がリストに書き足すまで worker には届かない。**便利な新機能が黙って使えるようになることはない** — 意図した非対称である
- 2.1.220 で `Glob` / `Grep` が既定の面から外れていたように、ベンダーは既存ツールを deferred 側へ移すことがある。allowlist に名前がある限り面に現れるが(測定7)、**改名されれば黙って消える**(測定8)。これを捕まえるのが決定3である
- リストの保守は人間の merge が門になる — コード定数なので registry データのように agent が書き換える経路は無い
