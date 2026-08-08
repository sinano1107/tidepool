# 実環境動作確認(ADR 0052 の3段)

2026-08-08 に設計・着手。**第0段と第1段(1-A / 1-B)まで完了。第2段以降は未実施。**

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

### 1-C(未実施 — 見送り)

計画のお題: `json2md / md2json / json-diff の3つを tools/ に揃える`。

**#228 が決まるまで意味のある測定にならない。** decompose の子はそれぞれ保護ブランチから切られ、親も自分のブランチに戻るので、**統合すべきものが親のブランチに1つも無い**。走らせて分かるのは decompose の意味論ではなく #228 の影響範囲で、それは `src/workspace.ts:195` の読みで既に確定している。#228 の修正後に回帰確認として走らせるのが筋。

---

## 第2段 — `registry`(PR と人間 merge)/ 未実施

**前提: #220 と #228 の決着。** この2つは第2段・第3段が通る経路そのものを支配しており、決めずに進むと観測が「S1〜S3 の挙動」なのか「未決の欠陥」なのか切り分けられなくなる。

**workspace `registry` / agent `tako` / authority `standard`**

お題:

> `registry から検証用の残骸を削除する: agents/probe.md, agents/probe-2.md, authority/danger-assign.yaml, danger-merge.yaml, danger-ws.yaml, reviewer-safe.yaml, reviewer-safe-2.yaml。README の記述と整合させる。tako / fugu / standard / auditor には触れない。`

第2段に据える理由: `tidepool-bot` に既に write 権限がある(**GitHub 側の準備がゼロ**)/ `protected: true` なので merge ダイヤルの設定に関係なく**人間 merge の question が必ず立つ** / 削除対象の agent に未決着タスクは無い。

**合格の判定:**

- [ ] タスクブランチ → PR が開く
- [ ] 保護 workspace なので merge question が立つ
- [ ] 人間が merge する
- [ ] **merge した内容が次の pickup で盤面に効く**(= S1 の本丸)。`probe` を assignee に指定したタスクが agent quarantine に落ちるようになっていれば、merge が届いた証拠
- [ ] 編集後も WebUI から registry を編集できる(= S2)

---

## 第3段 — `tidepool` 自身 / 未実施

**前提2つ:**

1. **`tidepool-bot` を `sinano1107/tidepool` の collaborator に追加**(registry には既にいる)。

   **workspace を登録する前に済ませること。** `clone` モードは登録の門でその場に `authedGit(... "clone" ...)` を撃つので(`src/workspace-create.ts:266`)、権限が無ければ PR を作る段階ではなく**登録の時点で**落ちる。

   ```bash
   gh api -X PUT repos/sinano1107/tidepool/collaborators/tidepool-bot -f permission=push
   # 受諾(個人アカウントの repo への追加は招待。盤面のトークンで受ける)
   ssh masaki@100.78.52.97 'set -a; . /etc/default/tidepool; set +a; \
     GH_TOKEN=$(cat "$TIDEPOOL_GITHUB_TOKEN_FILE") gh api user/repository_invitations \
       --jq ".[] | {id, repo: .repository.full_name}"'
   ssh masaki@100.78.52.97 'set -a; . /etc/default/tidepool; set +a; \
     GH_TOKEN=$(cat "$TIDEPOOL_GITHUB_TOKEN_FILE") gh api -X PATCH user/repository_invitations/<id>'
   ```

   一覧が空なら直接付与されている。付与の確認は bot のトークンで読めるかを見る。この手順を盤面側に飲み込ませるのが #213。

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

3. **triage セッションは pickup を止める。** Triage は既定タブで、未読があると入った瞬間にサーバ側でセッションが開き、**タブを離れても閉じない**。skim を最後まで終えて commit するか、30分の無活動タイムアウトを待つ(#225)。

4. **purely-local workspace では完了ごとに偽の `PR promotion failed` question が立つ**(#220)。「abandon promotion」で流す。

5. **purely-local workspace には着地経路が無い。** 完了作業が保護ブランチへ到達する手段が1つも無いので、後続タスクが前の成果を要るなら人間が `git merge --ff-only` を手で撃つ(#220 のコメント)。

6. **実験中は decision log の翻訳表示を切る。** 1件あたり入力18.6k / 出力4.5k / $0.03〜0.05 を盤面と同じ予算から食う(#224)。

7. **スロットルは ADR 0030 の pacing であって上限ではない。** `pace_offsets` と spend-down で開ける。**spend-down は対象ウィンドウのリセットまで自動失効しない**ので、実験を中断するときは手で解除する。

8. **お題は15〜30分に収める。** watchdog は work 90分 / review 45分、slot は1本。

9. **push 忘れ。** Pi は GitHub から pull する。手元の `git status` の「up to date」は手元の remote-tracking ref に対してであって GitHub に対してではない。デプロイ前に `git log origin/main..HEAD` が空であることを必ず確認する。

---

## 発見(14件、全て grilling 待ち)

第1段だけで14件。**1-A の1本から9件**出た。

| 束 | issue | |
|---|---|---|
| **ブランチと着地** | **#220 #228** | **最優先。第2段の前提。**片方だけ実装すると他方を固定する |
| 未設定 assignee をどの読み口が解決するか | #217 #221 #223 | 1つの決定が3つを閉じる。#223 は監査証跡に出る |
| レビューと異議の射程 | #218 #231 | |
| 盤面の状態と散文が人間に届くまで | #225 #227 #226 #230 | #226 #230 はほぼ機械的 |
| 盤面と human の見た目 | #222 | |
| registry の書き込み経路 | #229 | 「WebUI の registry 書き込みが main 直コミットでよいか」を含む |
| Board call のコスト | #224 | 測定が先 |

grilling の順序は **ブランチと着地 → assignee の解決 → レビューと異議の射程**。1本目が決まらないと第2段に進めない。

**この分布自体が観測である。** 14件のうち9件は「盤面の状態や、エージェントが書いたものが、人間に届かない」系であり、実装の正しさではなく**面の正直さ**に寄っている。コードレビューでは出ない類で、実環境で人間が1周操作して初めて出た。
