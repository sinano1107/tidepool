# Codex の答えを取りに行く Board call は Harness の床まで閉じ、用途ごとの Provider は盤面設定の欄が名指し、翻訳は対象1つにつき1回にまとめる

2026-10-21 の grilling(issue #456)で決定。ADR 0098 決定8 は「将来の Board call は用途ごとに Provider を明示し、同じ正準経路を使う」と
置いたまま、答えを取りに行く8用途はすべて Claude CLI 固定だった(ADR 0111 追記4、ADR 0192 決定4)。pin 版 `codex-cli 0.147.0` の
一発呼び出しを VM で実測し(表と request 本体の捕捉は #456 のコメント)、Codex 版の呼び出しの形と、Provider の置き場、翻訳の撃ち方を決める。

## 決定

1. **Codex の「空のツール面」は、閉じられる面をすべて閉じた状態である。** Codex は feature を全部閉じ sandbox を read-only にしても、
   code mode の入口(`exec`)・待機・問い返し・サブエージェント系の道具を宣言に残し、その一覧は `--json` にも `debug prompt-input` にも
   現れない(request 本体の捕捉でしか見えない)。閉じ方は worker と同じ closed surface + skill の閉鎖 + `-s read-only` + code-mode host
   の無効化、MCP も hook も無し、cwd は空の中立ディレクトリ。残る道具は `exec` 経由でしか届かず、host が無効なら router が拒む ——
   書き込みもサブエージェントも起きないことを実測した(拒否は stderr にだけ出る)。閉じた feature は worker と同じ `features list` で
   観測し、残る床の一覧は版の事実として版上げの門(#1385)で request 本体を捕捉して測る。ADR 0062 決定1 の「観測できる」は Codex
   ではこの形で成り立つ。ADR 0098 決定7 の床は、触れる先を持たない呼び出しなので満たす。
2. **用途ごとの Provider は盤面設定の欄が名指す。** 下書き4用途の欄は盤面既定の段の隣、振り返り3用途の欄は判断の段の隣。種は
   `anthropic`、未設定という状態は持たない。worker の Provider 順位は読まない —— 好みの順位が盤面の呼び出しまで動かすのは、
   ADR 0098 決定8 が退けた暗黙の既定である。コード固定は Codex だけの盤面(#1010)が種で `openai` を入れる道を塞ぐ。欄の値は
   `anthropic` / `openai` —— moonshot は ADR 0096 のとおり Board call に向けない。編集面は段の欄と同じく settings タブと管理 MCP。
   ADR 0111 追記4 の「Provider は `anthropic` 固定」を置き換える。
3. **翻訳は盤面設定の翻訳の欄(Provider, model, effort の1組)で走る。** 種は `anthropic` の alias `haiku` / `low`。表の行ではないので
   alias を拒む理由(分類と学習器のセル、ADR 0182)は当たらず、openai は具体 id(`gpt-5.6-luna` は ChatGPT 認証で受理を実測)を
   書く。表から引かない(ADR 0192 決定4 / ADR 0200 決定9 の理由はそのまま)。コードの直書きは手入れ場所が分かれるので退ける。
   ADR 0192 決定4 の「alias のまま残し #456 で見直す」を置き換える。
4. **翻訳は表示の対象1つにつき Board call 1回にまとめる(両 Harness)。** cache に無い断片だけを id 付きで1回に載せ、id 付きの配列で
   受け取り、断片ごとに cache する。1回に載せる断片数は盤面の定数で上限を持ち、超えた分は呼び出し元が次の呼び出しにする ——
   1 HTTP リクエスト ≈ Board call 1回に収め、ADR 0063 決定1 の「流量を決めるのは呼び出し元」は保つ。同時2本の床と 30 秒の待ち
   (ADR 0063 決定2)はそのまま。10 断片を1回で訳す実測は両 Harness で件数・順序・markdown・code span・URL を保ち、1断片あたりの
   token は 1件1回の 1/3〜1/5 だった。id の欠け・重複・余計は検証で落とし、部分的には cache しない。pickup 時の Memory の query の
   英訳は断片1つのまとめ。ADR 0063 決定1 の「1件1回」を置き換える。
5. **翻訳の usage は呼び出し1回 = 1行の表に残す。** まとめると断片1行に usage は付かない —— 1行に全量・他に 0 を書くのは #534 で
   直した偽のゼロと同じ形。`translation_cache` から usage の列を外し、`translation_calls`(Provider, model, 断片数, token、費用は null 可)
   を新設する。費用の null は「測れない」(Codex は ChatGPT 認証で費用を返さない)で、0 にしない。settings の translation spend は
   この表を読み、null は「費用不明 n 回」として合計から外す。
6. **答えを取りに行く呼び出しは、Harness を問わず盤面の数行の system prompt で走る。** 用途の指示は user prompt に置き、7用途で
   Claude は `--system-prompt`、Codex は組み込み prompt の置換(`model_instructions_file`)がその層になる。道具を使わない呼び出しに
   Harness の動作規則は要らず、worker で置換を退けた理由(ADR 0124)は当たらない。Claude を既定のままにすると同じ用途の盤面の文面が
   Harness で違う形になる(ADR 0157 の線)。#275 はこれで決着する。翻訳は ADR 0062 決定3 の自前の文面のまま。
7. **Codex の呼び出しの門と失敗。** 撃つ前の門は Provider で一般化した同じ4つ —— 資格情報の不在は `auth.json` の存否(ADR 0116 決定4)で
   「撃てなかった」、失効・使用量・行の Quarantine は app-server probe の観測から。撃った後は `turn.failed` の文言を読まず「撃って失敗」
   として数えるだけ(認証失効と行の拒否は次の probe が拾う)。Harness の封じ込めの Quarantine は Claude と同じく Board call を
   止めない。出力は `--output-schema` で受け、検証は両 Harness とも zod の1本。

## 帰結

- **Codex の一発呼び出しには、使用量の窓とは別の短い上限がある。** Plus プラン・0.147.0 で、約1分に3回成功すると以後の呼び出しは
  間隔によらず 429(`exceeded retry limit`)になり、8分ほどで戻る。`account/rateLimits/read` にも CLI の出力にも現れない。1 commit で
  振り返り3用途が続けて撃つと4本目が当たりうる(1時間後の撃ち直しが拾う)。翻訳を openai にした盤面では1トグルが上限に当たりうる。
  形(回数かトークンか、プラン差)は未確定で、issue に置く。
- 残る道具の拒否は `--json` に出ず stderr にだけ出る。盤面は読まない —— 答えの正しさは変わらず、拒否されない構成を採っていない。
- 出荷順: 翻訳のまとめ撃ちと `translation_calls`(決定4・5)は表の形を変えるので門(#1879)の前、Claude だけで完結する。欄・Codex の
  client・Claude の system prompt の揃え(決定2・3・6・7)は需要が来るまで `low`。
- 0.147.0 の `turn.completed` は `cache_write_input_tokens` と `reasoning_output_tokens` を持つ。worker の正規化が
  `cache_creation_tokens: 0` を書いているのは別 issue。

## 退けた案

- **0.147.0 では Codex の生成系 Board call を作らない。** 道具は feature を閉じても残る作りで、ゼロにできる版を待つのは実質「作らない」。
- **翻訳の Provider / model を表の行(段)から引く。** 翻訳に合う model は worker の品質を満たさず表に入れない(ADR 0114 決定5)。
- **翻訳を #456 の範囲から外す(1件1回のまま)。** まとめ撃ちで Codex の上限に収まる形になり、Claude 側も安く速くなる。
