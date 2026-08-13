# 実環境動作確認(ADR 0052 の3段)

2026-08-08 に設計・着手。**第0段から第3段まで全段完了(2026-08-12)。**

原則は1つ — **1段につき新しい subsystem を1つだけ足す**。前の段が通っていない状態で次に進まない。

この文書は計画と実測を同じ場所に置いている。両者が別ファイルだと必ずドリフトするため。

---

## 環境(2026-08-08 の実測)

| | |
|---|---|
| Pi | `masaki@100.78.52.97`(tailnet)、`tidepool.service` |
| 公開 URL | `https://raspberrypi.tailc0084f.ts.net:8443` |
| ソース / 実行 | `/mnt/ssd/tidepool` → rsync → `/opt/tidepool` |
| registry clone | `/mnt/ssd/tidepool-registry` |
| sandbox workspace | `/mnt/ssd/tidepool-workspaces/sandbox`(remote 無し = purely-local。`path` 明示エントリ) |
| 規約導出の workspace 基点 | **`/mnt/workspaces`**(SSD 上の 20G ext4 ループバック、`TIDEPOOL_WORKSPACES_DIR`)—— 第3段で exFAT から移設 |
| claude CLI | 2.1.221 |
| デプロイ済みコミット | 第0段〜1-B は `a55154b`、**1-C は `556877f`**(#274 = ADR 0064 の ref スナップショット比較が入った後) |
| watchdog | work 90分 / review 45分、slot = 1 |
| 盤面ポインタ | `TIDEPOOL_WORKSPACE=sandbox` / `TIDEPOOL_AUDITOR=fugu` / `TIDEPOOL_AGENT` 未設定(= `tako`) |

---

## 第0段 — 完了

### 0-1. デプロイ

```bash
git log origin/main..HEAD --oneline          # 空であること(push 忘れの検出)
ssh masaki@100.78.52.97 "git -C /mnt/ssd/tidepool pull -q origin main"
ssh masaki@100.78.52.97 "sudo bash /mnt/ssd/tidepool/scripts/deploy-pi.sh"
bash .agents/skills/deploy-pi/scripts/verify-deploy.sh
```

`a55154b`(#209 / #210 / #211 入り)をデプロイ、`verify-deploy.sh` 全項目 pass。

### 0-2. registry のセットアップ

**当初計画からの訂正が2つある。**

**訂正1 — `tako.md` の本文は空のままが正。** 計画は「本文が空だと配線しか確認できない」として system prompt を書く前提だったが、**ADR 0017 が「専門性を持たない既定エージェントの正規の姿は本文が空」と決めている**(`src/claude-worker.ts` のコメントも「tako は意図的に空本文」と明示)。ワーカーの指示は `BOARD_DOCTRINE` + `WORKER_PROTOCOL` + authority の `guidance` として盤面が注入済み。本文を書くと実験は「今書いた散文の質」を測ることになり、本番の既定エージェントの姿とずれる。

**訂正2 — Auditor は `fugu` 🐡。役割名 `auditor` は profile と盤面ポインタ側に置く。** CONTEXT.md L72「『auditor』はエージェントの属性ではなく盤面が持つ役割の割当」。命名は ADR 0017 の「海の生き物のローマ字和名」に従う。

実際に入れた3件(WebUI の settings から。この操作自体が S2 の書き込み経路の検証を兼ねる):

1. **authority profile `auditor`** — `guidance` も `assignable_to` も `allowed_workspaces` も**全部空**。書こうとした内容はすべて別のところが既に運んでいた:

   | 書きかけた内容 | 実際の運び手 |
   |---|---|
   | read-only / 直さない | ADR 0013 追記の `reviewToolDenials` + ADR 0035 の `--permission-mode manual` |
   | 指摘は他の手の修理タスクになる | 盤面の review 意味論(task type 側) |
   | system への変更は人間承認へ | `REVIEWER_AUTHORITY_PROFILE.allowed_workspaces: []` |
   | Escalating is never wrong | `WORKER_PROTOCOL` の逐語重複 |

   review タスクでは `attributedAuthority`(`src/mcp.ts:230`)が常に `REVIEWER_AUTHORITY_PROFILE` を返すので、**registry 側の allowlist は review では効かない**。空にしておけば fugu が review 以外を持たされたときもフェイルクローズド。

2. **agent `fugu`** — authority `auditor` / advisor `opus` / icon 🐡 / skills `["@workspace"]`。本文は**観点だけ**(距離が価値、完了条件に対して判断する、読んだものを根拠に挙げる、検証できなかったことは埋めずにそう言う、何も無ければ無いと言う)。

3. **agent `tako` の編集** — `advisor: opus` を足すのみ。本文は空のまま。

**盤面ポインタ**: `/etc/default/tidepool` に `TIDEPOOL_AUDITOR=fugu` を追記 → `tidepool.service` 再起動。

**S2 の検証結果**(3件の編集後):

| 観測 | 結果 |
|---|---|
| GitHub main が進んだ | ✅ `d58c78f` → `dd9a350` → `b8fd445`、全て `tidepool` 名義 |
| checkout の HEAD | `c928365` の `main` に**据え置き**(3回書いても動かない) |
| 残留 worktree | 無し |

旧コードならここで checkout が動くか `RegistryCloneBusyError` が出ていた。

### 0-3. machine user の独立性

**計画の手順は動かない。** 計画は `git config --global --unset credential.https://github.com.helper` を使うが、Pi の helper は **2値登録**(空値 + gh の helper。`gh auth setup-git` の標準形)なので `--unset` は複数値キーに対して落ち、helper が残ったままテストが空虚になる。

**改訂: 再起動で測る。** `bootRefresh`(`src/server-options.ts:262`)と pickup 時の refresh(`:285`)は**同一の `refreshRegistry(registryDir, board.githubAuth)` 呼び出し**なので、測るものは変わらない。失敗が柔らかく(fail-open。board-wide 停止も standing question も出ない)、発火が決定的で、実験のサイクルを消費しない。

```bash
ssh masaki@100.78.52.97 'cp -p ~/.gitconfig ~/.gitconfig.bak03; \
  git config --global --unset-all credential.https://github.com.helper; \
  git -C /mnt/ssd/tidepool-registry fetch --quiet origin main >/dev/null 2>&1; \
  echo "[1] control fetch exit: $? (non-zero = OK)"; \
  sudo systemctl restart tidepool.service; sleep 6; \
  echo "[2] service: $(systemctl is-active tidepool.service)"; \
  echo "[3] registry lines:"; \
  sudo journalctl -u tidepool.service --since "-40s" --no-pager | grep -i registry || echo "  (none)"; \
  cp -p ~/.gitconfig.bak03 ~/.gitconfig; rm -f ~/.gitconfig.bak03; \
  git -C /mnt/ssd/tidepool-registry fetch --quiet origin main >/dev/null 2>&1; \
  echo "[4] post-restore fetch exit: $? (0 = restored)"'
```

**[1] の陰性対照が要**。これが無いと「通った」が「helper が残っていたから通った」を排除できない。両リポジトリとも private なので無認証 fetch は通らず、対照が成立する。

**実測(2026-08-08)— 4行とも合格:**

| | 観測 | 意味 |
|---|---|---|
| [1] | exit **128** | 人間の資格情報が本当に消えていた — 対照成立 |
| [2] | `active` | 盤面が起動 |
| [3] | **registry 行なし** | `bootRefresh` が黙った = machine user のトークンだけで fetch が通った |
| [4] | exit **0** | helper 復元 |

**人間の `gh` ログインは残す。** `deploy-pi.sh` の前段の `git pull` は人間の行為であり、人間の名義で通るのが正しい(ADR 0024)。確かめたいのは「盤面が人間の資格情報に**依存しない**」ことであって「ホストに人間の資格情報が**存在しない**」ことではない。

---

## 第1段 — `sandbox`(GitHub 非関与)

**workspace `sandbox` / agent `tako` / authority `standard`**

sandbox は remote を持たないので GitHub 経路が一切絡まない。失敗しても被害ゼロ。

### 1-A(完了 / 合格 5-6)

| field | value |
|---|---|
| title | `sandbox に JSON→Markdown 表の変換 CLI を追加する` |
| purpose | `後続タスクの土台として、依存ゼロで動く小さな道具を1つ置く。npm install を伴うライブラリ追加はしない(Pi 上でのネットワークとビルド時間を持ち込まない)。テストは Node 標準の node:test で書く。` |
| completion criteria | `node tools/json2md.js が stdin の JSON 配列を Markdown テーブルにして stdout へ出す / node --test が green / README にワンライナーの使用例` |
| assignee | **`tako`(明示)** |
| review flag | on |

| 判定 | |
|---|---|
| ✅ pickup → タスクブランチ → worker → 完了 | 88秒。成果物は依存ゼロ、エスケープと列の和集合まで正しい |
| ✅ handoff doc | 6セクション全部が実質を持つ |
| ❌ decision log に判断が流れている | **1本目はエントリ0件。**しかも handoff の「Key decision-log references」が存在しない決定を参照していた |
| ✅ 解放後 checkout が保護ブランチへ | `main` |
| ✅ 完了時レビュー → fugu → 修理 → 統合復帰 | fugu が実バグ(ヘッダ行の列キーが未エスケープ)を発見、修理子を生み、直りを見届けて完了 |
| ⏸ triage で異議 → 修理タスク | **実施不能**(#231) |

### 1-B(完了 / 合格 5-5)

計画には purpose しか書かれておらず(かつ `purpose` が `purple` と誤記されていた)、title と completion criteria は本番で補った。

| field | value |
|---|---|
| title | `tools/ のディレクトリ構成を再編する` |
| purpose | `tools/ 配下のディレクトリ構成を再編する。今は json2md だけだが、道具は今後増える前提で、増えたときに効く形にしたい。最終形は2案あり、どちらを採るかは人間の判断を仰いでから着手すること。案の具体化は任せるが、着手前に必ず確認を取ること。` |
| completion criteria | `人間が選んだ案のとおりに tools/ が再編されている / node --test が green / README の使用例が新しいパスに追随している` |
| assignee | **`tako`(明示)** |
| review flag | off(レビュー経路は 1-A で見たので、ここはエスカレーションだけを測る) |

**完了条件の1つ目を「人間が選んだ案のとおりに」にするのが要。** 「良い構成に再編されている」だと tako が自分で選んで進めても条件を満たせてしまい、エスカレーション経路が発火しない。

```
09:31:30  task_escalated                     question が立つ
09:33:48  question_answered  案A            recommendation_accepted: true
09:34:04  task_moved                         triage commit で先頭挿入
09:34:18  task_picked_up                     親が先頭復帰
09:38:48  task_completed                     統合復帰
```

**question の質が高い。** 2案とも具体的なパスまで、それぞれの帰結、CLI 呼び出しパスの変化、判断に影響しない点の打ち消し(「どちらも `node --test` はグロブで再帰的に拾えば動作する」)、推奨まで揃っていた。purpose に「案の具体化は任せる」と書いただけでここまで返ってきた。`standard` の guidance が言う "escalate with concrete options" が実際に効いている。

盤面が `recommendation_accepted: true` を機械記録しているのも良い観測。

### 1-C(完了 / 合格 8-8 / 2026-08-12)

**ADR 0053(#220 / #228 の決着)の回帰確認として実施。** 当初の見送り理由 ——「decompose の子はそれぞれ保護ブランチから切られ、統合すべきものが親のブランチに1つも無い」—— は ADR 0053 の実装(`lineageTaskBranch` / merge back / purely-local の着地 question)で消えた。

計画のお題は `json2md / md2json / json-diff の3つを tools/ に揃える` だったが、**1-B の成果(案A)が `task/53baaaf1` に載ったまま `main` へ着地していなかった**ため、先に人間が `git merge --ff-only` で着地させてから、足す2つに絞って登録した。旧コードには purely-local の着地経路が無く(#220)、決着済みタスクを盤面から再提示する機構も無いので、これは手作業でしか直せない。

| field | value |
|---|---|
| title | `tools/ に md2json と json-diff を足して3つ揃える` |
| purpose | `…足す2つは独立に作れるので、子タスクに分解して1つずつ仕上げること。既存の json2md と同じ作法に従う —— 依存ゼロ、テストは node:test、tools/<名前>/index.js の1ツール1ディレクトリ。最後に統合して、README を3つ揃った状態の1枚にまとめること。` |
| completion criteria | `…node --test が全部 green / README に3つそれぞれのワンライナー使用例がある / md2json が json2md の出力を読み戻せる(往復が通る)` |
| assignee | **`tako`(明示)** |
| review flag | off |

**purpose で decompose を明示指示したのは意図的。** 1-B は「エスカレーションするか」自体が被測定物だったので明示できなかったが、1-C の被測定物は分解**後**のブランチ機構であって「tako が自発的に分解するか」ではない。review flag を off にしたのも同じ理由 —— review 経路は Auditor が実欠陥を見つけたときだけ発火する非決定的な経路で、1回に両方詰めると発火しなかったとき測定が濁る。

| 判定(ADR 0053) | 結果 |
|---|---|
| 子の fork 元が `task/<親>` | ✅ 子2のブランチが親の当時の HEAD `d48be04` を含む(`main` は `0c22401`) |
| 子の完了で `task/<親>` へ merge back | ✅ 2本とも(`d48be04` → `ed5547c`) |
| 子の完了で PR も question も立たない | ✅ 2本とも。**#220 の偽 `PR promotion failed` は1本も立たなかった** |
| 2人目の子のツリーに1人目の成果 | ✅ `tools/md2json/` が見えている |
| 統合復帰時に子全員の成果 | ✅ 3ツール + 統合された README(`8f164f2`)。**#228 の本丸** |
| ルート完了で merge/hold question が1本 | ✅ ちょうど1本、`tidepool` 名義、options `merge`/`hold`、推奨 `merge` |
| 「merge」で `main` へ ff-only 着地 | ✅ `main` が `0c22401` → `8f164f2` |
| `workspace_state` の `needs_human` が 0 のまま | ✅ 全過程で quarantine に落ちなかった。**この行は「テーブルが空」ではない** —— #274(ADR 0064)以降 `ref_snapshot` 列が常に埋まるので、行の存在自体は正常である |

**判定1 は子1では判別できなかった。** 親が purpose を読んで即 decompose したため `task/<親>` にコミットが1つも無く、`main` と同じコミットを指していた。子2で初めて親と保護ブランチが別コミットになり、判別力が出た。**同じ形の測定を組むときは、親が独自コミットを持つまで fork 元は観測できないと見込んでおく。**

コストは decompose $0.33 / md2json $0.98 / json-diff $0.99 / 統合復帰 $0.80 = **$3.10**、実時間 約40分(throttle による停止を除く)。統合復帰の1本で cache_read が100万トークンを超えた。

**発見6件** —— #296 #297 #298 #299 #300 #301。うち #296 は 1-C を20分止めた直接の原因。

---

## 第2段 — `registry`(PR と人間 merge)/ **完了(2026-08-12)**

**前提だった #220 と #228 は ADR 0053 で決着し、1-C で実機の回帰確認も通った。解禁済みである。**

**workspace `registry` / agent `tako` / authority `standard`**

第2段に据える理由: `tidepool-bot` に既に write 権限がある(**GitHub 側の準備がゼロ**)/ `protected: true` なので merge ダイヤルの設定に関係なく**人間 merge の question が必ず立つ** / 削除対象の agent に未決着タスクは無い。

### 走る前に確かめた前提(2026-08-12、全て実測 or コードで裏取り済み)

| | |
|---|---|
| **workspace の登録操作は不要** | `registry` は `workspaces.yaml` に既に宣言済み(`path` / `repo` / `protected: true`)。1-C が走った事実が、`assertValidWorkspaces` を通ることの証明でもある(1エントリでも不正なら registry のロード全体が落ちる) |
| **remote 宣言は clone の実態と一致** | clone の `origin` は `https://github.com/sinano1107/tidepool-registry.git`。`assertRemoteDeclarationMatchesClone` を通る |
| **registry としての宣言と workspace としての宣言が一致** | 盤面は remote-backed、workspace 側も `repo` あり → `assertRegistryRoleAgrees`(issue #211)を通る。この検査は**まさにこの二重の役のために**存在する |
| **#274 が第2段を名指しで想定している** | `registryRebaseliner`(`src/server.ts`)は「registry clone が **workspace として登録されていれば**」その ref を外科的に撮り直す。スナップショットは pickup で初めて焼かれるので、**第2段がこの経路を実際に動かす初めての機会**である |
| **タスクブランチは最新の registry を載せる** | clone の local `main` は `c928365` と古いが、ルートタスクの fork 元は `refs/remotes/origin/<branch>` であり、`refreshWorkspace` が pickup で fetch する |
| **`allowed_workspaces` はルートタスクを止めない** | `standard.yaml` は `["sandbox"]` のままだが、強制は `decomposeTask`(`src/tasks.ts`)にしかない。人間が登録するルートタスクは通る。**ただし tako が decompose すると子は全部人間承認 question になる**(`workspaces.yaml` の notes / ADR 0013 layer 2) |
| **#235 はブロッカーではない** | `protected: true` なので merge ダイヤルの状態に関係なく人間 merge の question が立つ(ADR 0053 根拠3) |

**未解決の設計上の引っかかり: `standard` の guidance は「deleting data」を名指しで authority 外としている。**

> Anything irreversible or outward-facing is outside your authority: pushing to shared branches, publishing, **deleting data**, contacting external services with side effects, spending money.

第2段のお題はファイル削除そのものである。tako が「人間が削除対象を7件名指しで列挙した purpose」を authorization と読むか、guidance を字義どおり読んで escalate するかは**走らせてみないと分からない**。purpose に一文入れて前者へ寄せるが、**escalate したらそれ自体が観測である**(guidance がどれだけ字義的に読まれるかの測定)。

### お題

| field | value |
|---|---|
| title | `registry から検証用の残骸を削除する` |
| purpose | `registry には検証で作った残骸が残っている。agents/probe.md / agents/probe-2.md / authority/danger-assign.yaml / authority/danger-merge.yaml / authority/danger-ws.yaml / authority/reviewer-safe.yaml / authority/reviewer-safe-2.yaml の7件を削除する。README.md 末尾の e2e 由来の HTML コメント2行(issue #50 / #53)も同じ残骸なので一緒に消す。tako.md / fugu.md / standard.yaml / auditor.yaml / workspaces.yaml には触れないこと。この削除は人間が対象を名指しで指定した依頼であり、保護 workspace の人間 merge がその安全弁である。` |
| completion criteria | `上記7ファイルが削除されている / README.md の e2e コメント2行が消えている / tako.md・fugu.md・standard.yaml・auditor.yaml・workspaces.yaml が無変更である / README 本文が実態と整合している(README は agent を個別に列挙していないので変更不要のはず —— 確認した結果を decision log に残すこと)` |
| assignee | **`tako`(明示)** |
| workspace | **`registry`** |
| review flag | off |
| risk flag | off |

**お題を計画から書き換えた点:** 計画の「README の記述と整合させる」は**空振りする** —— registry の README は layout を説明するだけで、削除対象の agent / profile を個別に列挙していない。代わりに README 末尾に残っている e2e 由来の HTML コメント2行が同種の残骸なので、そちらを削除対象に足した。

### 結果(合格 6-6 / 2026-08-12)

```
04:28:31  task_registered   cf1396bf
04:28:34  task_moved        ← ↑ 1回で発火(キューが空 = 素の先頭だった)
04:29:05  task_picked_up
04:29:42  decision_logged
04:29:59  task_completed
04:30:05  pr_opened  #4  +  merge question 1f4539ec
04:30:08  worker_exited     exit 0 / $0.39
04:34:40  PR #4 merged      ← question に merge と答え、盤面が gh pr merge を撃った
```

| 判定 | 結果 |
|---|---|
| ルートタスクなので PR が開く | ✅ PR #4、`+0 −41`、8ファイル。過不足なし |
| decompose した場合の分岐 | — tako は1セッションで完了。分岐に入らず(未検証のまま残る) |
| 保護 workspace なので merge question が立つ | ✅ `1f4539ec`、options `merge`/`hold`、推奨 `merge` |
| 人間が merge する | ✅ 正確には**人間は question に答え、盤面が `gh pr merge` を撃った** |
| **merge した内容が盤面に効く(S1 の本丸)** | ✅ Register 画面から `probe` / `probe-2` が消えた |
| 編集後も WebUI から registry を編集できる(S2) | ✅ `fcdd268 update agent fugu via WebUI` が着地 |
| ADR 0064 の比較が誤検知を出さない | ✅ ただし**前提が揃っていることを発見した** —— #304 |

**tako は escalate しなかった。** `standard` の guidance が「deleting data」を authority 外と名指ししているにもかかわらず、purpose に置いた authorization の一文を読んで進めた。**guidance は字義的には読まれない**という測定が取れた。

### S2 で一番効いた証拠: 新しいコミットの親

```
fcdd268 parent=ad0846d  update agent fugu via WebUI
```

`refreshRegistryForWrite` が**書き込みの前に fetch した**直接証拠である(ADR 0052 決定2 の「入口の refresh 点」)。古い base の上に書いていたら、merge した削除が丸ごと巻き戻っていた。

### identity の3層が分かれて記録された

```
fcdd268  tidepool     <…tidepool-bot@users.noreply.github.com>  update agent fugu via WebUI
ad0846d  tidepool-bot <…>                                        Merge pull request #4
f83127c  tako         <tako@tidepool.invalid>                    chore: remove verification debris
```

盤面自身の書き込み / GitHub 上の merge(machine user)/ worker のコミットが、それぞれ別名義で残る。第0段の「全て tidepool 名義」の再確認になった。

### **merge は盤面の見え方を1ミリも変えない**

これが第2段で一番価値のある観測である。

```
ad0846d  GitHub で merge          → 盤面の見え方: 変化なし。probe はまだ候補に居る
fcdd268  fugu 編集 → 入口で fetch  → ここで初めて probe が消えた
```

**盤面は GitHub を読んでいない。** 読むのはローカル clone の `refs/remotes/origin/<branch>` であり、GitHub 上の merge はその remote-tracking ref を動かさない。動かすのは `fetch` だけである。

その証拠として、**削除したはずのファイルは今も Pi のディスク上に在る**:

```
盤面が読む ref (origin/main):   fugu.md  tako.md
checkout の実ファイル:          fugu.md  probe-2.md  probe.md  tako.md
```

`loadRegistry` が working tree を一切見ない(「never the working tree. Every content read and the provenance `commit` use the same ref, so they agree by construction」)ためである。**第0段の「WebUI から3回書いても checkout は動かない」がバグではなかったことも、ここで繋がる** —— checkout は盤面が読むものではない。

**運用上の含意: merge 直後に見て「効いていない」と結論してはならない。** 中間状態を1度見ておくことが、「merge が効かない」と「まだ fetch していない」の取り違えを塞ぐ。

### 発見

**#304 —— ADR 0064 の外科的再基準化が symbolic ref を取り残す。** `refs/remotes/origin/HEAD` は `origin/main` への symref で、`for-each-ref` が解決して出すため行の objectname が連動して動く。`rebaselineRef` は名指しした1行だけを直すので、連動した行が古いまま残る。**セッション実行中に人間が registry を編集すると、解放時の比較がこれを違反と読んで quarantine に落とす。**

今回踏まなかったのは、タスクの実行中に registry 編集が起きなかったからである。第1段が purely-local で `refs/remotes/*` を1本も持たなかったことも、1-C で出なかった理由である。**失敗ではなく、機構が残した痕跡(スナップショットと実 ref の1行の食い違い)から見つけた。**

### S1 に使った読み口(書き込みゼロ、セッション消費ゼロ)—— 次段でも流用できる

**Register 画面の assignee ドロップダウン**(`GET /api/registry/candidates`)。これは盤面自身の registry 読みそのものであり、しかも**リクエストごとに読み直す**:

```ts
// src/server-options.ts —— コメントが意図を明示している
// pass the provider itself, not a boot-time snapshot: the register screen's
// candidates must reflect agents/workspaces created live through settings
registryCandidates: () => registryCandidates(board),
// → loadBoardRegistry(board) → loadRegistry(dir, mode) → refs/remotes/origin/<branch>
assignees: [...Object.keys(registry.agents), "human"],
```

1. **開始前(陰性対照)**: Register 画面を開き、assignee 候補に **`probe` と `probe-2` が居ること**を確認する
2. 第2段のタスクを走らせ、PR を人間が merge する
3. **refresh を起こす**: 盤面の registry 読みは `refs/remotes/origin/<branch>` なので、GitHub 側で merge しただけでは clone に届かない。fetch が走るのは **boot / pickup / WebUI からの registry 書き込み(`refreshRegistryForWrite`)** の3経路
4. **Register 画面を開き直す** → **`probe` / `probe-2` が候補から消えているはず**

**手順3を飛ばして4を見ると失敗する。** それは「merge が効かない」ではなく「まだ fetch していない」の観測であり、両者を取り違えないこと。3の前後で同じ画面を2回見るのが、この判定の判別力の源である。

計画にあった「`probe` を assignee に指定したタスクが **agent quarantine** に落ちる」は誤り —— assignee の registry 解決は**登録の時点**で走る(CONTEXT.md「編集時に登録時と同じ検査 — registry 解決 — を再実行」)ので、quarantine まで行かず登録が `unknown agent: probe` で弾かれる。ただしそれも書き込みを伴うので、上のドロップダウン読みのほうが軽い。

**余談として観測できること: この候補一覧には `human` が常に含まれる。** つまり人間割当タスクは Register 画面から今日でも登録でき、#300(人間割当タスクが実行キューに出る)は仮定の話ではなく到達可能である。

---

## 第3段 — `tidepool` 自身 / **完了(2026-08-12)**

**前提3つ —— いずれも 2026-08-12 に確認済み。GitHub 側の手作業は collaborator 追加の1コマンドだけだった:**

1. **`tidepool-bot` を `sinano1107/tidepool` の collaborator に追加**(registry には既にいる)。

   **手順は変わった。#213 は closed で、ADR 0067(#288)が盤面側に飲み込ませた** —— `src/repo-access.ts` が `user/repository_invitations` を読み、**いま到達したい repo 宛ての招待1枚だけを検証して受諾する**。人間が `gh api -X PATCH user/repository_invitations/<id>` を手で撃つ旧手順はもう要らない。

   ```bash
   gh api -X PUT repos/sinano1107/tidepool/collaborators/tidepool-bot -f permission=push
   ```

   受諾は盤面が到達失敗時に1回だけ試みる(`repairRepoAccessAtPickup`)。加えて **`clone` モードの登録の門でも先に撃たれる**(下記)。

2. **`clone` モードで登録する。`register` モードは使わない。**(2026-08-12 に #284 / #285 の変更を読んで確定)

   計画は「パスは `/mnt/ssd/tidepool-workspaces/tidepool`。`/mnt/ssd/tidepool` は deploy の rsync 元なので絶対に登録しない」と**人間の注意**で塞いでいたが、**モードの選択で構造的に塞げる**。

   ```ts
   // clone モード: パスは規約から導かれ、エントリはパスを記録しない(ADR 0018)
   function cloneAndDescribe(name, repo, deps) {
     const dir = conventionCheckoutPath(name, deps.workspacesBaseDir);
   ```

   **`clone` モードはパスを受け取らない。** workspace 名 `tidepool` を与えれば `<base>/tidepool` に落ちるので、rsync 元を打ち間違える経路がそもそも無い。パスを明示的に書く唯一のモードが `register` であり、それが計画の危惧していた形である。

   **`clone` モードは登録の門で repo アクセスを先に検査する**(#284):

   ```ts
   if (input.mode === "clone") {
     await assertRepoAccess(input.repo, deps.github);   // ← ADR 0067 の招待受諾もここで走る
     return cloneAndDescribe(input.name, input.repo, deps);
   }
   ```

   権限が無ければ生の git エラーではなく `RepoAccessMissingError`(人間向けの案内つき)で落ち、招待が来ていれば `repairRepoAccess` がその場で受諾する。**前提1 の手作業が要らなくなったのはこの経路である。**

   なお **`register` モードには意図的にこの probe が無い**(ADR 0066 決定3 の非対称 —— 既存 checkout の登録に probe を足すと、登録の門が全モードでネットワークを要求することになる)。これも `register` を選ばない理由に加わる。

   `create` モードは #285 で GitHub に一切出なくなり(`git init -b main` + 初期コミット)、構造的に purely-local になる。第3段には使えない。

3. **`standard` に `merge: escalate` を足す。** ここで初めて merge ダイヤルが被測定物になるので、**workspace `tidepool` は `protected: true` にしない** —— 保護するとダイヤルに関係なく人間 merge の question が立ち(第2段がまさにそれ)、ダイヤルの検証にならない。

   **確認ダイアログは出ない。それが正しい。** `dangerousValues`(`src/profile-create.ts`)が扉を立てるのは `merge: auto_if_ci_green`(無人 merge)と2つのワイルドカードだけで、**`escalate` はダイヤルの中で最も安全な値**である —— 人間に必ず聞く側なので確認を求める理由がない。#266 が問題にしているのは「既に危険値を持つ profile を無関係な1文字修正で編集すると扉が再度出る」ケースであり、この観測と矛盾しない。

### 実際に走らせるまでに、ホスト側で2つ潰した

**どちらも計画に無く、実タスクを1本走らせて初めて出た。**

**(1) workspace が exFAT の上にあった。** `TIDEPOOL_WORKSPACES_DIR` を `/mnt/ssd/tidepool-workspaces` に置いたところ、`npm install` が完走しなかった。

```
exFAT で symlink:  ln: … 許可されていない操作です
exFAT で hardlink: ln: … 許可されていない操作です
ext4 で symlink:   OK

node_modules: 297MB で 45秒間まったく増えず、npm install は 77% CPU
```

`node_modules/.bin/*` は symlink なので、**exFAT では npm が原理的に完走できない**。`/mnt/ssd` は 1.9T の exFAT で、Pi の他のデータは全部そこにある —— だから選んだが、それが罠だった。**このホストで tidepool のテストを回す既定の手順が「ネイティブ fs の checkout を使う」だったのは、まさにこの理由である。**

対処: **SSD 上に ext4 のループバックイメージを作った**(20G)。`truncate` は exFAT で sparse にならず約 5.7 秒/GB、20G で約2分。clone は **13分で0バイト → 3.8秒**になった。

**ついでに `/mnt/ssd` 自体が fstab に無いことも見つかった。** `mnt-ssd.mount` は 7/2 の手動 mount のままで、**再起動すればソース・registry clone・workspace が全部消える**状態だった。両方 fstab に入れた(`nofail` 付き、ループバックには `x-systemd.requires-mounts-for=/mnt/ssd`)。

```
UUID=68A9-671B /mnt/ssd exfat defaults,nofail,uid=1000,gid=1000,fmask=0022,dmask=0022,iocharset=utf8,x-systemd.device-timeout=15 0 0
/mnt/ssd/tidepool-workspaces.img /mnt/workspaces ext4 loop,nofail,x-systemd.requires-mounts-for=/mnt/ssd 0 0
```

**(2) サンドボックスが外部ダウンロードを塞いでいた。** ext4 に移しても `npm install` は通らなかった。

```
サンドボックス内:  15回のフェッチ 全部 403、200 はゼロ
サンドボックス外:  GET registry.npmjs.org/npm → 200
```

対処: **`/opt/tidepool/node_modules`(363M)を workspace へコピーした**。`package-lock.json` の md5 が一致していたので正当。**symlink を持つツリーをコピーできるのは ext4 に移した後だけ**なので、(1) の解決が (2) の回避策を可能にしている。コピーは17秒。

**この2つで空振り2セッション・約 $4.3 を使った。** どちらも「止まっているのか遅いのか」が盤面からは見えず、`npm` のデバッグログと `for-each-ref` を人間が読んで初めて分かった。

### 結果(合格 5-5)

```
06:21:51  worker_spawned      3本目。node_modules 配置済みなので npm install を撃たず vitest へ直行
06:38:38  task_completed      単一コミット 646a54e
06:38:45  pr_opened  #308  +  merge question 53b5cd2b
06:41:48  PR #308 MERGED
06:41:50  issue #280 CLOSED / COMPLETED
06:46:35  task_picked_up      判定5 用の検証タスク
```

| 判定 | 結果 |
|---|---|
| issue-backed task として登録でき、内容が issue から展開される | ✅ DB は `title`/`purpose`/`completion_criteria` とも NULL、`github_issue_number` のみ。queue の行にも board のカードにもタイトルが出る |
| PR 本文に `Closes #280` が自動付与される | ✅ |
| merge ダイヤル(`escalate`)で merge question が立つ | ✅ **保護を付けていないので、立てたのはダイヤルそのもの** |
| merge が issue を閉じる | ✅ `CLOSED / COMPLETED` |
| **2本目のタスクが1本目の merge 済み成果の上から始まる(S3 の本丸)** | ✅ `task/244509a3` が **merge コミット `0815840` から切られ**、`src/api.ts` に `/triage/close` が1件・`/triage/commit` が0件 |

**判定5 の証拠は pickup の瞬間に確定する。** 完走を待つ必要がないので、**実 issue を消費せず読み取りのみの検証タスク**を1本立てて済ませた($0.28)。

### 成果物の質

エージェントは **`public/app.js` を `npm run build:webui` で再ビルド**している。エンドポイント改名で事前ビルド済みバンドル(ADR 0055)が置き去りになる、という事前に挙げていたリスクを自分で潰した。しかも handoff によれば **旧パスが残っていたのを advisor が指摘して発見**している。

無関係な既存失敗8件も、原因(サンドボックスの git identity)まで特定したうえで `Known issues` に分けて報告している。

### 発見(5件)

| issue | |
|---|---|
| **#309** | サンドボックスが外部ダウンロードを塞ぐ(npm registry / Playwright CDN)。**依存を持つリポジトリで実作業ができない。** ADR 0033 の封じ込めとの兼ね合いなのでバグと言い切れない |
| **#310** | サンドボックスの一時 shadow ファイル20件が `releaseTree` の `git add -A` と競合。**タイミング次第で PR に混ざる** |
| **#312** | worker の git identity が `tako` のため tidepool 自身のテストが8件落ちる。**第3段の前提そのものに効く** |
| **#313** | 差分ゼロで完了した work タスクが解決不能な PR 昇格失敗になる。しかも推奨が永久に失敗する `retry` |
| **#311** | issue-backed タスクが comments を取得して捨て、完了基準は「comments を見よ」と指示する |

加えて **#305**(規約導出モードが着地先を人間に見せない)は第3段の準備中に出たもので、(1) の exFAT 問題はその実害の1つである。

**お題は計画の #206 から #280 へ変更した。** #206 は `needs-triage` で「kit と本番実装の関係を決める」設計寄りの議題であり、#246 とも #300 / #301 とも重なる —— エージェントに投げる第3段のお題としては不向きだった。**#280(`/api/triage/commit` を `close` に改名し、Commit = close + cursor をクライアント合成として明示する)は `ready-for-agent`** で、ADR 0065 に決着済み・やることが列挙済み・前提の #279 も merge 済みだった。しかもテスト20箇所超に触るので、機械的だが空ではない。

---

## 運用の線(実測で得たもの)

1. **レビューを付けるタスクは assignee を明示する。** 未設定だと #217 により修理子が全部人間承認 question になる。

2. **pickup はタスク登録では発火しない。** スケジューラは1時間おき。即時発火するのは triage の auto-commit と `POST /api/tasks/:id/move`(先頭が変わる body、既に先頭のタスクへの `{"after": null}` も特例で発火)だけ。**queue 画面で ↑ を2回**押す(1回目は「reordered only」、2回目で「immediate poll fired」)。

   発火条件は「**素の** todo の先頭に居るタスクを、もう一度先頭へ動かしたとき」である。`queueHeadId` は pick 可能性を見ないので、**blocked な親・question・held・quarantine されたタスクが上に居座っていると1回目は必ず空振りする**(#299)。1-C では blocked な親が先頭に居たため、子への ↑ が毎回2回必要だった。

3. **triage セッションは pickup を止める。** Triage は既定タブで、未読があると入った瞬間にサーバ側でセッションが開き、**タブを離れても閉じない**。skim を最後まで終えて commit するか、30分の無活動タイムアウトを待つ(#225)。

4. ~~purely-local workspace では完了ごとに偽の `PR promotion failed` question が立つ~~ —— **#220 の修正で消えた**(1-C で確認、work 3本の完了で1本も立たなかった)。「abandon promotion」で流す運用はもう要らない。

5. **purely-local の着地は盤面の merge question を通る**(ADR 0053 決定3)。ルート完了で `merge` / `hold` の question が**分解ツリー1本につき1回**立ち、`merge` と答えると盤面が保護ブランチへ `merge --ff-only` する。以前の「人間が手で `git merge --ff-only` を撃つ」は不要になった —— ただし**ADR 0053 より前に決着したタスクの成果は再提示されない**ので、そこだけは今も手作業でしか着地させられない(1-C で 1-B の成果に対して実際にやった)。

6. **decision log の翻訳表示は切らなくてよい** —— #224 は ADR 0062 / 0063(#270 / #271)で決着し、流量制御・進行表示・キャンセルが入った。むしろ点けて挙動を見るほうがよい。

7. **ペースのオフセットを変えても、そのままでは効かない**(#296)。`throttle_state` は古い判定を `resets_at` まで保持し続けるので、盤面は最大1時間**変更前のオフセットの判定に縛られる**。`onQueueHeadChanged()` を撃つ操作(queue の ↑ / spend-down の入切 / pause 解除 / triage close)を1つやって再評価させること。

8. **再評価中は古い halt が「失敗」として見える**(#297)。↑ を押した直後の黄色い `moved to front — pickup blocked` は、再評価が終わる前の古い `throttle_state` を読んだものである。数秒待って queue を見直すこと。

9. **スロットルは ADR 0030 の pacing であって上限ではない。** `pace_offsets` と spend-down で開ける。**spend-down は対象ウィンドウのリセットまで自動失効しない**ので、実験を中断するときは手で解除する。**オフセットは 0〜100 の減算のみ**なので「盤面が線形ペースを X pt 先行してよい」というツマミは存在しない —— 0 が最も緩い設定であり、バースト形状の仕事は構造的に自分を止める。一気に流したいときは spend-down が唯一の逃し弁である。

10. **お題は15〜30分に収める。** watchdog は work 90分 / review 45分、slot は1本。

11. **workspace は ext4 に置く。exFAT では `npm install` が原理的に完走しない**(`node_modules/.bin/*` は symlink)。規約導出の基点は `/mnt/workspaces`(SSD 上の ext4 ループバック)。`path` を明示する既存エントリ(`sandbox` / `registry`)は exFAT のままだが、npm を撃たないので問題は出ていない。

12. **依存は、workspace の `allowed_domains` が閉じている場合はホスト側で用意する**(#309 / ADR 0072)。`cp -a /opt/tidepool/node_modules <workspace>/` で配る —— `package-lock.json` の md5 が一致していることを先に確認する。非空の `allowed_domains` はその workspace の worker だけに列挙ドメインへの egress を開く。許可外への取得は retry しない。

13. **実行中のタスクは UI からキャンセルできない**(`assertHumanEditableScope` が `in_progress` を除く)。止める手は2つ —— watchdog を待つ(work 90分)か、**Pi 上でプロセスを kill してからサービスを再起動する**。再起動が `failTask` を撃ち(ADR 0001)、retry / abandon の question が立って slot が解放される。**kill だけでは解放されない** —— `worker_exited` は記録されるが、タスクは `in_progress` のまま残る。

    再開したいなら **question を未回答のまま置く**とよい。未回答の question はタスクを `nextSlotTask` から外すので、その間にホスト側の手当てを済ませてから `retry` と答えられる。

14. **差分ゼロで完了したら `abandon promotion`**(#313)。推奨は `retry` だが**永久に失敗する** —— コミットが増える経路が無い。

15. **`pkill -f "<文字列>"` は自分の ssh セッションにマッチする。** コマンドライン中に同じ文字列が含まれるため。実測で2回踏んだ(1回は接続が切れ、1回は監視が偽陽性を出した)。PID を名指しするか、パターンを工夫する。

16. **push 忘れ。** Pi は GitHub から pull する。手元の `git status` の「up to date」は手元の remote-tracking ref に対してであって GitHub に対してではない。デプロイ前に `git log origin/main..HEAD` が空であることを必ず確認する。

---

## 発見(30件)

### 1-A / 1-B(14件、2026-08-08)—— **全件 closed**

| 束 | issue | |
|---|---|---|
| ブランチと着地 | #220 #228 | 第2段の前提だった。ADR 0053 で決着、1-C で回帰確認 |
| 未設定 assignee をどの読み口が解決するか | #217 #221 #223 | ADR 0054。1つの決定が3つを閉じた |
| レビューと異議の射程 | #218 #231 | |
| 盤面の状態と散文が人間に届くまで | #225 #227 #226 #230 | ADR 0058 |
| 盤面と human の見た目 | #222 | |
| registry の書き込み経路 | #229 | |
| Board call のコスト | #224 | ADR 0062 / 0063 |

**1-A の1本から9件**出た。

### 1-C(6件、2026-08-12)

| 束 | issue | |
|---|---|---|
| **throttle の再評価** | **#296 #297** | #296 が 1-C を20分止めた。#297 はその診断中に出た。#297 は #227 の直し残し |
| キューと人間の面 | #300 #301 | **表と裏。片方だけ直すと人間割当タスクがどこにも出なくなる** |
| pick 可能性の定義が複数箇所にある | #299 | #300 と根が同じ |
| エージェントの出力規律 | #298 | ADR 0015 の「正準は英語」がワーカーに届いていない |

### 第2段(2件、2026-08-12)

| issue | |
|---|---|
| **#304** | ADR 0064 の外科的再基準化が symbolic ref を取り残す。**セッション中の registry 編集 → 解放時に誤検知の quarantine**。第2段・第3段の通常の運用姿勢がそのまま条件になる |
| #303 | handoff doc は PR 昇格より前に書かれるので、着地の状態について構造的に古い。remote-backed なら毎回起きる |

加えて **#298 の見立てが崩れた**(コメントで追記)。第2段では handoff も `task_completed` の result も PR 本文も全部日本語で、1-C の分かれ方(成果について書くフィールドは英語)は再現しなかった。**安定した分かれ目は無く、周囲のペイロードの言語に合わせているだけ**である。射程に **PR 本文 = 盤面の外に出る面**が加わった。

### 第3段(8件、2026-08-12)

| issue | |
|---|---|
| **#309** | サンドボックスが外部ダウンロードを塞ぐ(npm registry / Playwright CDN)。**依存を持つリポジトリで実作業ができない。** ADR 0033 の封じ込めとの兼ね合いなのでバグと言い切れない |
| **#312** | worker の git identity が `tako` のため tidepool 自身のテストが8件落ちる。**「テストが green」を完了基準に書けない** |
| **#313** | 差分ゼロで完了した work タスクが解決不能な PR 昇格失敗になる。推奨が永久に失敗する `retry` |
| **#310** | サンドボックスの一時 shadow ファイル20件が `git add -A` と競合し、タイミング次第で PR に混ざる |
| **#311** | issue-backed タスクが comments を取得して捨て、完了基準は「comments を見よ」と指示する |
| **#305** | `clone` / `create` モードの登録がチェックアウト先を人間に見せない。**exFAT 事故の直接の原因** |
| **#306** | `claude` CLI の認証切れが人間に届かない。bare catch が診断そのものを捨てる |
| **#307** | worker セッションのトークン内訳が未測定。`cache_read` が output の150倍、接頭辞は約 35k |

**#309 / #312 / #313 の3件が重い。** どれも「**エージェントが tidepool 自身を開発する**」という v1 の目的地に直接効く —— 依存が入れられない、テストが素で緑にならない、成果ゼロの正当な完了が失敗として扱われる。

### 分布そのものが観測である

**30件のうち19件が「盤面の状態や、エージェント・盤面が書いたものが、人間に正直に届かない」系**である。実装の正しさではなく**面の正直さ**に寄っていて、コードレビューでは出ず、実環境で人間が1周操作して初めて出た。1-A/1-B で9/14、1-C で5/6、第2段で1/2、第3段で4/8 —— **同じ分布が4回続けて出た**。

**#298 は毛色が違う**(エージェント側の出力規律)。**#304 はさらに違う** —— これは**失敗が起きる前に、機構が残した痕跡から見つけた**唯一の発見である。`workspace_state.ref_snapshot` と実際の `for-each-ref` を突き合わせたら1行だけ食い違っていた、という形で出た。

**観測の一般則が2つ立った。**

1. **新しい経路を1本通すたびに、その経路が初めて生む記録の種類が新しい発見を連れてくる。** #298 は decompose が初めてエージェント作の title / purpose を生んだから、#303 / #304 は remote-backed が初めて PR と `refs/remotes/*` を生んだから出た。段を足すときは「何が新しく生まれるか」を先に列挙しておくと当たりが付けやすい。
2. **判定のために盤面の内部状態を読むと、判定に使わなかった行が発見になる。** #304 は S1 / S2 の判定のついでに撮ったスナップショットから出た。**判定に必要な最小限だけを見ない**ほうがよい。

3. **ホストの前提は、実タスクを1本走らせるまで検証されない。** 第3段は exFAT とサンドボックスの通信遮断で2セッション・$4.3 を空振りした。どちらも「設定を確かめる」段階では見えず、**`npm install` という1つの実作業が両方を同時に照らした**。段を足すときは、その段で初めて走る**実作業の種類**を先に列挙しておくとよい(ネットワークを使うか、依存を入れるか、ビルドするか、ブラウザを起動するか)。

4. **止まっているのか遅いのかは、盤面からは決して分からない。** 空振り2本とも、判定に使ったのは `npm` のデバッグログ・`for-each-ref`・`du` の時系列であって、盤面が出す情報ではなかった。**無人運用を名乗る以上、ここは埋まっているべき穴である**(#306 と同じ系)。
