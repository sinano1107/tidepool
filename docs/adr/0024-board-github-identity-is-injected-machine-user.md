# 盤面の GitHub 身元は明示注入された machine user — GitHub 名義は執行者を表す

**Status 追記: 身元の形は [ADR 0093](0093-the-boards-github-identity-is-one-app-and-a-token-broker-mints-per-repo-tokens.md) で machine user の PAT から単一 GitHub App の installation token に変わった(2026-08-21)。** 決定1 の seam(身元は盤面の設定から注入される)・決定2 の「名義 = 執行者」・決定3 の worker ゼロ credential はそのまま。決定4 の「アカウント」は App を指す。

2026-07-15 の grilling(issue #50)で決定。v1 の GitHub 書き込み(PR 作成・CI 確認・merge)は host の `gh auth`、つまり人間本人の ambient 認証にただ乗りしており、worker も盤面プロセスの env をまるごと継承するため同じ認証が worker セッションにも漏れていた。「PR 昇格は worker に託さず盤面だけが行う」(issue #19 の seam)が credential 層では成立していなかった。

決定は4点:

1. **tidepool 専用の machine user を作り、トークンを明示注入する。** 本質は machine user か GitHub App かの選択ではなく、**「身元は host の ambient 認証ではなく盤面の設定から注入される」という seam** — これさえあれば注入物が PAT でも App の installation token でも `GhCliClient` は同じ。配布モデルは両にらみ(self-hosted では今の配線がそのまま BYO credential になり、ホスト型 SaaS に踏み出す時点で GitHub App 層を足す — Claude/Codex/Copilot の hosted 連携はすべて App であり、machine user はその退化ケース)。
2. **範囲は盤面が執行する GitHub 操作の全部**(git push・PR 作成・CI 確認・merge・issue 展開・サジェストコメント)。人間の判断による操作(merge 承認・サジェスト承認)も machine user 名義で執行される — **GitHub 上の名義 = 執行者、判断の帰属 = 盤面の記録**(question 回答・decision log)、と線を一本で引く。現状の「人間名義に見える merge」の方が嘘(人間は `gh pr merge` を打っていない)。判断者ごとに credential を切り替える案は ambient 依存を残し seam を崩す。
3. **worker は GitHub credential ゼロ。** トークンは mode 600 のローカル secrets ファイルに置き、`GhCliClient` が読んで `execFileSync` の env に都度注入する。盤面プロセスの env に置かない(worker は env を継承するため、置くと剥がし忘れ1箇所で漏れる)。registry にも置かない(git repo に secret を入れると「commit hash = 版」が汚点になる)。`git push` も同じ経路で認証する。今後増える盤面発の git/gh 操作(issue #54 の registry push 等)もすべて同じ注入モジュールを通す — **credential が効く場所は1箇所だけ**を不変条件とする。
4. **アカウントは盤面(Tidepool)そのものを表す**(既定エージェントではない)。全エージェントの仕事が単一名義で出るのは 2 の線の帰結であり、Default agent が差し替え可能なポインタである設計とも整合する。issue #53 の「Tidepool 名義」コミットの author email にはこの machine user の GitHub noreply アドレスを使う(#50 がアカウントを作り、#53 が email を消費する)。

帰結:

- registry repo では branch protection の bypass にこの machine user を登録する(ADR 0020 の既決事項の実行)。一般 workspace には collaborator(write)として招待し、アクセスの事前検査は workspace 作成フロー(issue #57)が担う — 実行時の事後検知(quarantine 化)は v1 ではやらない。
- secrets ファイル不在時は GitHub client 不在として扱う(既存の optional `deps.github` の fail-closed を継承)。
- PAT の種別(classic `repo` スコープ / fine-grained)は、collaborator repo への fine-grained 対応状況を実装時に実物で確認して決める。

Considered options:

- **GitHub App で作る** — `tidepool[bot]` バッジ・短寿命トークン・installation 単位の権限は魅力だが、JWT 署名 → token 交換の自前実装が要り、自宅 Tailscale 内の単一ホスト(ADR 0001)には過剰。App の短寿命トークンが守る脅威(漏洩後の悪用窓)への投資は、ホスト型提供に踏み出す時点で行う。
- **merge など人間の判断による書き込みだけ人間名義に残す** — 「承認の出所」は一見立つが、執行者/判断者の線が二重になり、host の ambient 認証への依存が残る。判断の帰属は盤面の記録が既に正典。
- **既定エージェント名(tako 等)のアカウントにする** — tako 以外のエージェントの仕事も tako 名義に見え、Default agent = 差し替え可能なポインタの設計と齟齬。
