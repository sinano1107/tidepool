# 盤面が読む正本はリモートの保護ブランチであり、ホスト上の clone はキャッシュである

issue #209 / #210 のグリリング(2026-08-08)で決定。実環境での初回動作確認の段取りを組む過程で、
`src/` 全体に `git fetch` / `git pull` の呼び出しが**1つも存在しない**ことが判明した(`push` は
`src/github.ts:136` と `src/registry-write.ts:43` の2箇所のみ。`scripts/deploy-pi.sh:69` の fetch は
盤面自身の checkout 用で無関係)。

その結果、2つの不変条件が実際には成立していなかった。

**1. CONTEXT.md の Registry が主張する線の逆が成立していた。** 用語集は「人間の merge を通っていない
内容が spawn に効く経路は構造的に存在しない」と書くが、`loadRegistry`(`src/registry.ts:561`)は
`git show main:...` で**ローカルの** `main` を読む。merge は GitHub 上の出来事なので、ローカルの
`main` は merge を一切追従しない。実際に成立していたのは「**人間の merge を通った内容が spawn に効く
経路が構造的に存在しない**」だった。

**2. 2本の正規経路が互いを壊していた。** PR が merge された後に WebUI から registry を編集すると、
ローカル `main` に載ったコミットの push が non-fast-forward で失敗し、しかも `pushRegistry` の失敗は
**非致命**(issue #57)なので黙って、ローカルと GitHub が恒久的に分岐する。以後 GitHub 側は死に
リポジトリになる。

同じ穴は registry 以外の workspace にもある。`ensureTaskBranch`(`src/workspace.ts:148`)は
`git branch <task> <protectedBranch>` でローカルの保護ブランチから切るので、タスク1の PR が merge
された後、タスク2は**タスク1の成果が見えない地点**から始まる。

## 決定

### 1. 正本はリモートの保護ブランチ

盤面が読むのは `refs/remotes/origin/<protected>` であり、ローカルの同名ブランチではない。ホスト上の
clone は正本ではなく読み取りキャッシュに格下げされる。

この帰結として **push 成功が「効いた」の定義になる**。`git push` は成功時にローカルの
remote-tracking ref を更新するので、「push が通った」と「盤面に効いた」が**同じ1つの事実**になり、
2つの状態がずれる余地が消える。issue #57 が push 失敗を非致命とした根拠 —「盤面はローカル clone を
読むのだから、エントリは既に効いている」— はその前提ごと消えるため、**push 失敗は致命に反転する**
(フローは冪等なので人間はリトライできる)。

### 2. refresh は3点、タイマーは置かない

`git fetch` は「古いままだと困る瞬間」にだけ撃つ。`loadRegistry` は registry を読むたびに呼ばれる
(`src/server-options.ts` の resolver 群はリクエストごと・解決ごとに走るクロージャ)ので、その中には
決して置かない。

- **pickup ゲート** — `nextSlotTask` が head を返した後、`issuePickupGate`(`src/scheduler.ts:210`)の
  隣。`pollNow` はイベント駆動で頻発するので、キューが空の poll では撃たない。この位置を選ぶのは
  `issuePickupGate` が既に「GitHub 依存の pickup 直前ゲート」という同じ文法で立っているため。
- **registry 書き込みの入口**
- **起動時** — 騒ぐだけ(下記4を参照)

タイマーを置かないのは、「どの commit で spawn したか」を競走にしないためである。pickup 直前の
refresh なら、その spawn が読む版と ADR 0020 が刻む hash が構造的に一致する — 観測点と refresh 点は
同じでなければならない。

### 3. remote 正本の有無は宣言する。clone を覗いて推測しない

- **registry の正本としての役** — 合成 root(`src/server-options.ts`)で `remote-backed` /
  `purely-local` を1回解決する(ADR 0041 の「不在は宣言される」)。workspaces.yaml から取ることは
  できない — registry を読むために registry を読むことになる。
- **workspace としての役** — `workspaces.yaml` の `repo` を機械が読むフィールドへ**昇格**させる。
  `repo` あり = remote 正本を持つ。`register` モード(既存 checkout の登録)は今日 `{ path }` しか
  書かないので(`src/workspace-create.ts:244`)、盤面が checkout の `origin` URL を読んで焼く。

宣言と実態のずれ(宣言はあるのに remote が無い、逆も同様)は quarantine。registry clone は上の2つの
役を**両方**持つため2つの宣言を持ち、その食い違いも `resolvesToRegistryClone`(`src/workspace.ts:276`)
で pickup 時に突き合わせて quarantine する。

推測(remote の有無を毎回覗いて切り替える)を採らないのは、それが**この ADR が直している壊れ方へ
静かに戻る道**だからである。remote が失われた瞬間、盤面は merge を追従しなくなり、どこも赤くならない。
ADR 0020 が名指しで拒否した「quietly reads a stale/wrong value」そのものであり、フォールバックの形を
している分だけ質が悪い。

### 4. fetch 失敗は3点で扱いが違う

- **registry 書き込みの入口 → 致命。** fetch できないなら push もできず、push 成功が「効いた」の
  定義である以上、その編集は最初から成立していない。
- **pickup → fail-closed**(下記5)。
- **起動時 → fail-open。** 起動は拒まず、大きく警告するだけ。起動拒否は ADR 0036 の
  「人間面そのものは開いたままが復旧経路」と衝突する。ADR 0040 が重なりガードで採ったのと同じ形 —
  「早く騒ぐだけで、床は pickup 側」。

### 5. レジストリ到達性は封じ込め能力の兄弟であり、盤面全体を止める

registry の refresh 失敗は、環境事象(Throttle・issue 参照の一時的失敗)の静かな skip では扱わない。
封じ込め能力と同じ形を取る — pickup ごとに再検査、Tidepool 名義の確認型 question は最大1枚、回答
受理時に検査を再走させて**検証つき解除**。CONTEXT.md の「『資源単位』の原則が適用できない**唯一**の
資源」は2つの列挙へ改訂される(原則そのものは無傷)。

一方、**一般 workspace の fetch 失敗は既存の workspace quarantine に乗る** — その workspace の
タスクだけが止まればよく、資源単位の原則がそのまま適用できる。狭められないのは registry の側だけで
ある(あらゆる spawn の入力だから)。

### 6. registry の書き込みは checkout から切り離す

使い捨て worktree(`git worktree add --detach <tmp> <origin ref>`)に書いて commit し、
`push HEAD:<protected>`。ローカル `main` の位置も HEAD の位置も書き込みに関係しなくなる。

結果 `assertRegistryCloneReady`(`src/registry-write.ts:18`)は**用済みになり削除される** — 書き込みが
HEAD に依存せず、読み取りがワーキングツリーを見ない以上、守るものが無い。

副作用として、**registry タスクの実行中でも人間が registry を編集できるようになる**。今日その編集を
塞いでいるのは `assertRegistryCloneReady` の clean 検査の副作用であって設計ではない。走っている worker は
spawn 時に読んだ版で動いており(hash も刻まれている)、人間の編集はリモートに載るだけでその worker には
届かないので、矛盾は生じない。むしろ「長いタスクが走っている間、人間が registry を直せない」ほうが
ADR 0036 の線に逆行する。

### 7. slot 解放の「クリーンに戻す」に休止位置を含める

`releaseTree` のあと、checkout を保護ブランチへ戻す。remote 正本を持つ workspace では、ローカルの
保護ブランチをリモートへ追従(fast-forward)させてから戻す。ff できない = 帯域外の手作業でローカルが
分岐している場合は quarantine。

## 根拠

**1. 「コミット済み main」という語がローカルとリモートで二重化していた。** ADR 0020 はワーキング
ツリーを読まないことを決めたが、`main` がどちらの `main` かは決めていない。ドメインの文はリモートを
指し、コードはローカルを指していた。B は片方を選ぶ決定であって新しい概念の追加ではない。

**2. ADR 0020 part 2 が既に半分書いていた。** `guardRegistryDefaultBranch`(`src/workspace.ts:307`)は
`refs/remotes/origin/HEAD` を読み、「`main` は盤面が読むコード定数だが、リポジトリの真の default
branch でなければならない」と主張している。盤面が読む `main` はリモートの `main` である、はその判断の
自然な延長である。

**3. 読み取りは既に checkout 非依存だった。書き込みだけが依存していた。** `loadRegistry` は
`git show <ref>:...` / `git ls-tree` で読む。`commitAgentFile`(`src/agent-create.ts:233`)だけが
ワーキングツリーに書いて `git add` → `git commit` する。#210 が報告した「registry タスクを1本流すと
WebUI の registry 編集が止まる」は、この非対称の症状にすぎない。決定6は症状ではなく非対称を直す。

**4. 到達性の検査を盤面全体の停止に昇格させてよいのは、そこに至る時点でネットワーク全断が除外されて
いるからである。** pickup の手前には `checkThrottle`(`src/scheduler.ts:268`)があり、実 worker の
`checkUsage()` は `claude` の TUI を読む(ADR 0028)ためネットワークを要求する。失敗すると snapshot が
全 null になり `src/usage.ts:253` の `if (!session || !week) return { throttled: true, ... }` が
fail-closed に倒す。**回線が落ちれば盤面は既に止まっている。** したがって fetch のゲートまで到達して
失敗するのは「盤面は生きているが registry の正本にだけ届かない」場合 — credential の失効、権限の剥奪、
ホスティング側の障害 — であり、いずれも時間で自己回復しない。throttle の skip が人間を呼ばずに済むのは
再開見込み時刻があるからで、自己回復しない故障にその形を流用すると、恒久的な停止がキューの `skipped`
表示だけを頼りに放置される。

**5. 移行コストがゼロであることを実測した。** Pi の registry clone は
`main` == `origin/main` == GitHub `main` == `c928365` の3点一致、HEAD は `main`。`workspaces.yaml` の
`registry` エントリは `repo` を持ち clone に remote があり、`sandbox` はどちらも無い。**書き換える行が
1つも無い。** 決定3の宣言は、既存データが偶然ではなく既に正しく述べている事実を機械に読ませるだけである。

**6. 一般 workspace の痛みは投機ではなく予定されている。** 今日 remote を持つ workspace は registry
だけだが、tidepool 自身を workspace 登録する計画(ADR 0040 が「別の checkout を workspace にすれば
正規経路を通る」と明示的に祝福した道)は、2本目のタスクでこの穴を踏む。「observed pain over
speculation」の線に照らしても、これは speculation ではない。

## Considered options

- **ローカル `main` を正本のまま、merge を取り込む fetch + ff を足す** — push 失敗の非致命(#57)を
  維持できるが、「push が通った」と「効いた」が別の事実であり続けるため、両者がずれた状態(ローカル
  だけに存在し、誰も merge していない registry 内容が spawn に効く)を機構として残す。
- **agent 発の registry-edit タスクという経路自体を撤回し、registry の変更を WebUI 一本にする** —
  穴は消えるが、CONTEXT.md の Review が設計した「改善提案は registry-edit タスクの decompose として
  現れ、人間への承認 question に変換される」という Condensation の主要経路を失う。
- **remote の有無を毎回覗いて読み取り ref を切り替える(フォールバック)** — 根拠3の推測。remote が
  消えた瞬間に壊れた旧挙動へ静かに戻る。
- **remote を必須にし、テスト fixture 全部に一時 bare repo の origin を足す** — `makeRegistry`
  (`tests/registry-fixture.ts:131`)に依存する14ファイルが bare repo の生成コストを払ううえ、
  `guardRegistryDefaultBranch` の doc comment が明示的に認めた「純ローカル盤面」という正当な構成を
  消す。#202 の preview board が一時 bare repo を持つのは push 先の**封じ込め**が理由であって、
  読み取りの要件ではない。
- **fetch 失敗を throttle 型の環境事象 skip として扱う** — 実装は最も薄いが、token 失効のような
  恒久故障がキュービューの `skipped` 表示だけを頼りに静かに止まり続ける。registry の古さは全タスクに
  効く(資源単位で狭められない)ため、放置の被害が他の環境事象より広い。
- **fetch 失敗を issue 展開型の二分(一時的 = skip / 確定的 = question)で扱う** —
  `issuePickupGate` の判別は GitHub API の型付きエラー(`IssueGoneError`)だが、`git fetch` には相当物が
  無く stderr の文字列判別になる。ベンダーの文言変更で黙って壊れる側。
- **レジストリ到達性を封じ込め能力に4つ目の問いとして束ねる** — 「盤面全体を止める資源はただ1つ」と
  いう記述を維持できるが、「worker の封じ込めが成立しているか」という束の名前が事実でなくなる。
  この用語集は名前が事実であることを重んじており、数の少なさのために名前の正しさを捨てる取引には
  見えない。
- **#210 を「Q6 により症状が消えた」として何もせず閉じる** — branch discipline 上の害は無いが、
  盤面がもう読まない checkout を**人間は読む**。最後に走ったタスクのブランチが居座った clone は、
  覗いた人間に嘘をつく(このグリリング中、実際に一度その誤読が起きた)。
