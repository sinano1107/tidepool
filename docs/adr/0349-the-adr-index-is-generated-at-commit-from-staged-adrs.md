# ADR 索引は commit 時に stage 済み ADR から生成する

ADR 0080 の手動生成とテストによる検出は索引の不整合を検出できるが、再生成漏れのたびに CI の待ち直しと AI の再対応が発生した(issue #2940)。生成規則と CI の検査は維持し、生成の契機を pre-commit hook に移す。ADR 0080 決定1 の手動実行・hook 不採用を置き換える。

**決定1: commit に入る内容を正典にして索引を自動更新する。** ADR の追加・変更・削除・改名が stage された commit では、Git index の ADR 全体から索引を生成し、索引もその commit に含める。未 stage の ADR を読まず、ADR や他のファイルの stage 範囲を変えない。索引自体に未 stage の変更があれば、上書きせず理由を示して commit を止める。生成できない場合も commit を止める。通常 commit と `git commit -a` を対象とし、索引更新が必要なパス指定 commit は書き換え前に止め、stage 後の通常 commit を案内する。一時 index への追加だけでは通常 index に古い索引が残るため、その修復処理は持たせない。hook は Node と Git だけで動き、人間・AI・盤面の WIP commit に同じ規則を適用する。

**決定2: 導入は自動化し、既存設定と保護された環境を尊重する。** Git 共有された `.githooks` を相対パスの `core.hooksPath` で使い、各 worktree 自身の hook を動かす。`npm install` / `npm ci` の `prepare` で設定し、設定済みなら書き込まない。Git checkout でない配備先は対象外とし、設定できない環境や既存の別の hook 設定(既定ディレクトリにある有効な hook を含む)は説明して自動設定を見送る。設定対象はこの package 自身の checkout に限る。インストール自体は失敗させない。

**決定3: CI の検査は残す。** hook 未導入・迂回時にも stale な索引を検出する。WebUI / Design System など別の生成物の自動更新、および盤面が一般の Git hook を許す範囲(issue #2819)は変更しない。
