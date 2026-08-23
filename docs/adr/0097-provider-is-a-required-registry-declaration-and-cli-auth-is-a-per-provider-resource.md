# Provider は harness と独立した registry 必須の宣言 —— 動力の認証は provider 単位の資源に細分化する

2026-08-23 の grilling(Kimi 対応、ADR 0096)で決定。CONTEXT.md は従来「ハーネス(Claude Code 等)」の語しか持たず、動力の認証(ADR 0070)は「あらゆる AI 発話が同じ1つの資格情報で行われる」を根拠に盤面全体停止の3つ目の資源だった。第2の推論提供元が入るとこの前提が壊れるため、概念を分離し、資源の粒度を引き直す。

## 決定

1. **Provider(推論の向き先・課金元)を harness(起動する CLI)と独立した概念として CONTEXT.md に起こす。** 同じ harness が複数の provider を喋りうる(Claude Code harness が Anthropic 本家と Moonshot Platform を使い分ける)。provider はエージェント単位で registry が宣言し、`AgentDefinition` に**必須フィールド**として追加する —— 「省略 = 既定 provider」という暗黙の既定は、書き忘れと意図の区別がつかないため作らない。エンドポイント URL・env 名などのベンダー知識は ADR 0005 通りアダプタに閉じ込め、registry に書かせない。変更は template(`templates/registry/agents/*.md`)のみで、運用中の個人 registry は開発用の仮のため移行を提供しない。
2. **動力の認証の資源は provider 単位とする。** ある provider の認証の失効は、その provider を喋る agent の pickup を止める資源単位の quarantine に留まる。ただし **board call と使用量の読み取りが依存する provider の失効は、board call の全滅と Throttle の fail-closed を通じて実質的に盤面全体を止める** —— 「止められるより狭い資源が存在しない」という元の理路(ADR 0070)は、その provider に限りそのまま効く。Quarantine・盤面全体の停止・動力の認証の CONTEXT.md 3項目はこの線で書き換え済み。
3. **advisor は provider が提供する能力とみなし、提供しない provider を喋る agent が advisor を持つ定義は不正な組み合わせとして registry 登録と pickup の検査で拒否する。** これは kill switch(ADR 0043)とも盤面側オーバーライドとも違う第3の状態 —— 無効化ではなく定義が成立しない —— であり、「有効・無効の正本は registry と kill switch のみ」「実効構成を濁さない」の線は無傷。
4. **資格情報は provider ごとに分離し、spawn env の資格情報と向き先は provider ごとに明示構築する。** 構築の形は allowlist ではなく**双方向 scrub(denylist)**とする —— provider ごとの注入一式を定数として持ち、相手 provider の spawn(および、その provider を喋るすべての呼び出し経路)からその一式をすべて除去する。注入一覧と除去一覧は同じ定数から導き、対称性を規律ではなく構造にする(#445 の人間レビューで確定 —— 当初は資格情報の2変数のみの除去だったが、「注入する一式 = 相手から除去する一式」のほうが単純でドリフトしない)。allowlist 型の全面明示構築は PATH・proxy・git identity 等の運用 env まで列挙を強いる脆弱な設計であり、かつ「anthropic の env/argv は導入前と一致」という回帰要件と衝突するため採らない(当初この項目は「継承ではなく明示構築」と書かれていたが、実装に照らして文言を明確化した)。Kimi 向きのキーは盤面の env に置かず `~/.tidepool/` 配下のファイルに置き、アダプタが spawn 時に読んで Kimi 担当にだけ注入する(human-surface-credential の「平文は process.env に乗せない —— worker spawn が継承するから」と同じ doctrine)。scrub は双方向: Kimi 担当 spawn から `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` を除き(Moonshot 公式も `ANTHROPIC_API_KEY` 残留との衝突を警告している)、Claude 担当 spawn と board call から Moonshot 注入一式(向き先・トークン・モデル)を除く。現行の `workerSpawnEnv` が `process.env` を丸ごと継承する実装のままでは、キーを盤面 env に置いた瞬間に全 Claude worker が黙って従量課金・Kimi 向き先に切り替わりうる。

## Considered options

- **どれか1つの provider の認証が死んだら盤面全体停止のままにする** —— Moonshot が死んでも Claude 担当 worker と board call は動くのに全域を止める過剰。「止められるより狭い資源が存在するか」という既存の判定基準に自分で反する。
- **第2 provider を認証検査の対象外にする** —— 401 の機械判定(ADR 0077)が既にあるのに、盤面が死んだ資格情報で agent を黙って失敗させ続ける状態を許す。
- **provider を任意フィールドにし、省略を Anthropic 既定と読む** —— 書き忘れと意図した既定を区別できない。skill 許可リストの「省略は不正 —— 省略 = 無制限という footgun を作らない」と同じ理屈で必須にする。
- **advisor を黙ってマスクして spawn し、イベントに記録する** —— 「正本は registry」と「実際に提供される能力」の矛盾を静かに解消する振る舞いは、kill switch にだけ例外的に許した「実効構成を濁さない」性質を侵す。矛盾は定義の書き方として人間の目に触れさせる。
