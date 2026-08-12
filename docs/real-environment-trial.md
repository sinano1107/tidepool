# 実環境動作確認(ADR 0052 の3段)

2026-08-08 に設計・着手。**第0段と第1段(1-A / 1-B / 1-C)まで完了。第2段は解禁済み・未実施。**

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
| sandbox workspace | `/mnt/ssd/tidepool-workspaces/sandbox`(remote 無し = purely-local) |
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

## 第2段 — `registry`(PR と人間 merge)/ 未実施(解禁済み)

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

### 合格の判定(ADR 0053 反映済み)

- [ ] **ルートタスクなので PR が開く。** ADR 0053 決定2 で「保護ブランチから切られたタスクだけが PR を開く」と条件が付いた —— ルートは保護ブランチから切られるので今日どおり
- [ ] **tako が decompose した場合、子は PR を開かず親へ merge back する。** かつ `registry` を名指しする子は**人間承認 question に変換される**(`allowed_workspaces` / ADR 0013 layer 2)。この経路に入ったら判定は分岐する
- [ ] 保護 workspace なので merge question が立つ
- [ ] 人間が merge する
- [ ] **merge した内容が盤面に効く**(= S1 の本丸)。判定手順は下記
- [ ] 編集後も WebUI から registry を編集できる(= S2)
- [ ] **`registryRebaseliner` が効いている**(= #274 の初実走)。セッション中に盤面が registry の ref を書いても、解放時に ADR 0064 の比較が誤検知の quarantine を出さないこと。`workspace_state` の `needs_human` が 0 のままであることで見る

**S1 の判定手順 —— 書き込みゼロ、セッション消費ゼロ:**

読み口は **Register 画面の assignee ドロップダウン**(`GET /api/registry/candidates`)を使う。これは盤面自身の registry 読みそのものであり、しかも**リクエストごとに読み直す**:

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

## 第3段 — `tidepool` 自身 / 未実施

**前提2つ:**

1. **`tidepool-bot` を `sinano1107/tidepool` の collaborator に追加**(registry には既にいる)。

   **手順は変わった。#213 は closed で、ADR 0067(#288)が盤面側に飲み込ませた** —— `src/repo-access.ts` が `user/repository_invitations` を読み、**いま到達したい repo 宛ての招待1枚だけを検証して受諾する**。人間が `gh api -X PATCH user/repository_invitations/<id>` を手で撃つ旧手順はもう要らない。

   ```bash
   gh api -X PUT repos/sinano1107/tidepool/collaborators/tidepool-bot -f permission=push
   ```

   受諾は盤面が到達失敗時に1回だけ試みる(`repairRepoAccessAtPickup`)。走らせる前に、`clone` モードの門が #284 / #285 でどう変わったかを `src/workspace-create.ts` で確認すること —— 下の記述はその変更より前のものである。

2. **workspace のパスは `/mnt/ssd/tidepool-workspaces/tidepool`。** `/mnt/ssd/tidepool` は deploy の rsync 元なので**絶対に登録しない** — ADR 0040 のガードはここに効かず、塞いでいるのは #167 の deploy スクリプト側の前提検査だけ。

ここで初めて `standard` に `merge: escalate` を足す。

**お題**: 既存の open issue から範囲が閉じたものを1つ。**#206** が向いている。

**合格の判定:**

- [ ] issue-backed task として登録でき、内容が issue から展開される
- [ ] PR 本文に `Closes #206` が自動付与される
- [ ] merge ダイヤル(`escalate`)で merge question が立つ
- [ ] merge が issue を閉じる
- [ ] **2本目のタスクが1本目の merge 済み成果の上から始まる**(= S3 の本丸)

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

11. **push 忘れ。** Pi は GitHub から pull する。手元の `git status` の「up to date」は手元の remote-tracking ref に対してであって GitHub に対してではない。デプロイ前に `git log origin/main..HEAD` が空であることを必ず確認する。

---

## 発見(20件)

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

### 分布そのものが観測である

**20件のうち14件が「盤面の状態や、エージェント・盤面が書いたものが、人間に正直に届かない」系**である。実装の正しさではなく**面の正直さ**に寄っていて、コードレビューでは出ず、実環境で人間が1周操作して初めて出た。1-C の6件も5件がこの系で、**同じ分布が2回続けて出た**。

**#298 だけ毛色が違う。** これは面ではなくエージェント側の出力規律の話で、**日本語ペイロードで decompose を伴う実タスクを走らせたのが 1-C が初めて**だったために出た。1-A / 1-B は decompose しなかったので、エージェントが書く title / purpose / 完了基準がそもそも生まれていない。

**観測の一般則: 新しい経路を1本通すたびに、その経路が初めて生む記録の種類が新しい発見を連れてくる。** 段を足すときは「何が新しく生まれるか」を先に列挙しておくと当たりが付けやすい。
