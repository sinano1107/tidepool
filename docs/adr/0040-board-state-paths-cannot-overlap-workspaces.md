# 盤面の状態パスは workspace と交差できない: 重なりガードは pickup 時の workspace quarantine

issue #149 のグリリング(2026-08-04)で決定。盤面自身の状態ファイルの既定パスが cwd 相対で、盤面を checkout の中から走らせる運用と組み合わさると、その checkout を workspace 登録した瞬間に worker の書き込み半径(`allowWrite: [workspace.path]` — ADR 0033)の中に盤面の状態が入る。人間面に到達せずに盤面の状態を変えられる裏口であり(ADR 0034/0036 の不変条件の迂回)、worker-logs には stream-json の監査記録が入るため**監査対象が自分の監査記録を書き換えられる**形でもある。

## 保護対象は盤面プロセスに固定の5点

1. **盤面 DB**(`TIDEPOOL_DB`、SQLite のサイドカー `-wal`/`-shm` を含む — 判定は DB パス基準)
2. **worker-logs**(`TIDEPOOL_WORKER_LOGS` — stream-json 監査記録の置き場)
3. **API token ファイル**(`TIDEPOOL_API_TOKEN_FILE` — ハッシュのみだが、**書ければ**自分の知るハッシュへ差し替えて人間面 credential を偽造できる。書き込み半径からの保護が本体)
4. **GitHub token ファイル**(`TIDEPOOL_GITHUB_TOKEN_FILE` — **平文**。workspace 配下に入ると work プロファイルの `allowRead: [workspace.path]` で読める。「worker は GitHub credential を一切持たない」(ADR 0024)が静かに崩れるため、5点の中で最も強い保護理由)
5. **盤面の実行 checkout**(process cwd)— issue の原案(状態ファイル3点)への追加。盤面は `public/` の静的資産を**実行中の checkout から配信**するので、走っている checkout 自体が workspace になると worker が `public/index.html` を書き換えられ、次のリロードで人間のブラウザに届く — 人間面の改竄であり credential 窃取まで一直線。状態ファイルの置き場所をどう動かしてもこの穴は残るため、cwd そのものを保護対象にする

いずれも盤面プロセスに1つの singleton であり、workspace 毎に変わる保護対象は存在しない — 検査は「固定5点 × workspace パス(registry から live)」の総当たりである。

**registryDir は意図的に対象外**。registry clone は v1 唯一の保護 workspace としてむしろ設計上 workspace であり、「盤面はコミット済み main しか読まない」(ADR 0020)+ branch discipline + 保護 workspace マーカーが既にその重なりを受け止めている。

なお「tidepool のコードを agent に触らせたい」という欲求自体はこのガードで封じられない — **別の checkout** を workspace にすれば、worker は task ブランチ → PR → 人間 merge の正規経路を通り、稼働面には merge 済みのコードだけが届く。

## 執行: pickup 時の検査 → workspace quarantine、門は早い UX

罠は「盤面の状態パス(プロセスで固定)× workspace パス(registry から live、WebUI で実行時に新規登録可)」の交差であり、boot にも登録にも張り付かない。したがって:

- **床のガードは pickup/spawn 時** — タスクの workspace を解決した瞬間に重なりを検査し、重なれば spawn せず workspace を quarantine(needs-human + 確認 question)。ADR 0033 の `.claude/settings.json` ガードと同じ形・同じ場所。危険なのはその workspace で走る worker だけなので、資源単位停止の原則に合う
- **boot 時に登録済み全 workspace へ同じ検査を一斉実行**し、該当を最初から needs-human にする。起動自体は拒まない — 起動拒否は「人間面は開いたままが復旧経路」(ADR 0036 の fail-open)と衝突する。早く騒ぐだけで、床は pickup 側
- **登録の門(WebUI / 管理MCP の workspace 作成3モード)でも即拒否**。issue #121 で登録時強制を断ったのは「単射性は人間の規約で、検査が不正確」だったため — 今回はパス包含という正確な検査であり、床のガードなので門で弾いてよい。registry-edit PR 経由の登録は門を通らないが、pickup 側が必ず捕まえる
- **quarantine 解除の検証に重なり再検査を追加** — 既存の workspace 検証(「registry に存在し、ツリーがクリーン」)に重ねる

**封じ込め能力(盤面全体停止)には束ねない**。これは特定 workspace の性質であって「ホストと盤面自身の性質」ではなく、「止められるより狭い資源が存在しない」という封じ込め能力の例外条件を満たさない。workspace quarantine という狭い資源がある以上、全体停止は過剰。

## 既定パスは cwd 相対のまま残す

cwd 全体が保護対象になったことで、DB と worker-logs が cwd 配下にあっても罠の表面積は増えない — 「cwd を登録」も「cwd 内の DB を含むパスを登録」も同じガードに当たる。既定を `~/.tidepool/` 等へ移すのは Pi の migration(systemd unit・rsync 除外リストの整合)と開発体験の変更を払って「ガードが既に fail-closed で検出する罠を確率的に起きにくくする」だけであり、床が立った後の保険としては割に合わない。API token が既に `~/.tidepool/` にあるのは「rsync や git に秘密が紛れる」という別の理由(issue #140)で、DB を追いかけて動かす前例ではない。

## 重なり判定の意味論

- 判定直前に**両辺を realpath で正規化**し、パス区切りを尊重した包含判定(`path.relative` が `..` で始まらない形)で比較する — 文字列前置比較は symlink に嘘をつかれ(`/opt/tidepool` vs `/opt/tidepool-workspaces` の)前置境界で誤検知する
- **双方向** — 「保護パスが workspace 配下」も「workspace が保護パス配下」も重なり(worker-logs の中に workspace を掘る逆包含も同じ交差)
- **解決できないパスは fail-closed** — 「判定できなかった」を「問題なし」と読まない(ADR 0033 の settings ガードのパース不能と同じ線)。ただし登録の門の clone / 新規作成モードはディレクトリ未存在が正常なので、親ディレクトリの realpath + 字句結合で判定する
- darwin は **case-insensitive 比較**(APFS 既定。realpath が実在パスの表記へ正規化する保証がないため比較側で吸収)
- workspace **内部**の symlink(worker が作って外を指す)は守備範囲外 — サンドボックスの床は書き込み時に実パスで解決して拒否する。ガードが正規化するのは registry に登録されたパスそのものだけ

## 残穴と隣接判断

- **Pi の deploy 元は盤面ガードの守備範囲外** — ガードが守る実行 checkout は rsync **先**(`/opt/tidepool`)であり、rsync **元**が workspace 登録されると worker の変更が次の人間デプロイで PR レビューを素通りして本番に着地する。盤面は「そのパスが deploy 元だ」と知りようがないため、deploy スクリプト側の前提検査(main 上・クリーン・origin/main 一致、パスはスクリプト自身の居場所から導出)で塞ぐ — **issue #167**
- **tidepoolignore(workspace 内の per-project 除外リスト)は見送り** — workspace は worker の書き込み半径の定義そのものであり、触られたくない物の置き場は workspace の外(本ガードはその線の執行)。機構的にも読み側は表現不能(`allowRead` は `denyRead` に勝つ — ADR 0033)。**issue #166** に記録
- 「別 checkout の dev DB を注入して push → 本番へ」は既に二層で塞がっている — `board.sqlite*` / `worker-logs/` は .gitignore 済み、deploy-pi の rsync は runtime state を明示除外

Considered options:

- **boot 時のみのガードで盤面全体を fail-closed(issue の原案)** — workspace は WebUI から実行時に登録できるため boot 一点では取りこぼす。起動拒否は ADR 0036 の fail-open(人間面が復旧経路)と衝突する。
- **封じ込め能力に束ねて盤面全体停止** — 特定 workspace の性質であり、資源単位の原則に反する過剰停止。「止められるより狭い資源が存在しない」という例外条件を満たさない。
- **既定パスを cwd の外へ移す** — cwd 自体が保護対象になった後は罠の表面積を縮めず、Pi の migration と開発体験の変更だけが残る。
- **tidepoolignore で workspace 内に除外を彫る** — ドメインの線と逆向き・読み側が機構的に表現不能・git 管理下のファイルには効かない(issue #166)。
