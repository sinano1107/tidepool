# 盤面の worker は `/implement` を使わない —— 実装は専門の agent が装備した skill で書き、レビューの観点は reviewer の定義が持つ

2026-11-28 の grilling(issue #4038 から #4034 へ)で決定。#1879 の見直しでは、門の1周を「worker が `/implement` で tidepool 自身の
issue を実装する」形で回すと決め、そのために checkout の subagent 定義 `ponytail-implementer` を worker に届ける形を ADR 0446 で
決めた。

決める途中で2つが見えた。

- **レビューが重なる。** `/implement` は人間の session の skill で、実装者を dispatch し、レビュアーを出して直させる段を session
  の中で回す。これは盤面の完了時レビュー(ADR 0111)と重なる。worker の中で直された後のものが完了時レビューに届くので、門の1周で
  観測したい「盤面の委任とレビューが何を捕まえたか」が歪む。
- **subagent 定義だけ守っても信頼の線は閉じない。** 届ける定義の信頼を守っても、その本文は worker が書き換えられる file(`SKILL.md`・
  `CODING_STANDARDS.md`)を読ませる(#4046)。

`/implement` の subagent は「実装を別の文脈・別の model と effort で書かせる」ための道具だが、盤面では worker の model と effort は
盤面が選ぶ(ADR 0110)ので、worker 自身が実装者になればその道具は要らない。

## 決定

1. **盤面の worker は `/implement` を使わない。** 人間の session の skill のまま残し、worker 用の双子は作らない。worker の側で
   `/implement` の段取りに当たるのは盤面そのもの(分解・完了時レビュー・着地)である。
2. **実装は、実装専門の registry の agent が、ponytail を装備して自分で書く。**
   - tako ではない。tako の本文は構造的に空(ADR 0117 決定3 —— generalist で、手順は skill に置く)。
   - ponytail は `disable-model-invocation` で、model が Skill tool から読み込まない(設計の手順の最中に読み込まれないための意図)。
     なので agent 定義が「装備する skill」を宣言し、盤面が spawn 時にその本文を注入する形を第1案にする。必ず読むものは注入する、の
     先例(ADR 0180 の memory の meta-review の材料)に倣う。ADR 0025 の帰結が「別機能」として残した装備にあたる。
   - 装備の機構と、注入する本文の出所(保護ブランチから読むか)は #4046 が決める。本文を registry に写す形と、Read させる形は、
     それぞれ重複と信頼の穴を持つ。
3. **レビューの観点は reviewer の定義が持つ。**
   - 完了時レビューの既定の受け皿 fugu は組み込み agent なので、registry の `agents/fugu.md` で差し替える(ADR 0117 決定2 の
     shadowing)。code は変えない。
   - その本文が、1つの review の中で `code-review`(Standards・Spec の2つの sub-agent)と `ponytail-review` の sub-agent を回させる。
   - 観点ごとの review task にはしない。`review_by` に3人を並べる形は、登録者が task ごとに書く手間が要り、既定の Auditor は1つの
     名前を指すポインタである。review が review の子を decompose する経路は無く(decompose の子は常に work —— ADR 0013 の
     「review の分解子は修理」)、作れば新しい仕組みになる。`code-review` 自体が sub-agent で観点を分ける作りなので、それをそのまま
     使う。
4. **分解は今のまま。** 1つの issue の実装には分ける説明責任が無いので、worker 自身が実装者になる。大きい issue だけ、今どおり盤面の
   decompose に乗る。
5. **門の1周は subagent 定義を使わない。** ADR 0446 は、subagent 定義を届けるときの決定として残り、門の後に回る(#4038)。

## 退けた形

- **worker が `/implement` を使い、subagent 定義 `ponytail-implementer` を届ける(ADR 0446、#4038)** —— 完了時レビューと
  重なり、門の1周の観測が歪む。
- **特定の agent で完了時レビューを外す** —— worker 本人の見直しは独立の目にならない(GLOSSARY の Subagent「成果は親タスクの
  完了時レビューに全部吸収される」)。無人 merge の前の内容の検査は完了時レビューと人間が merge する path が担い(ADR 0395 の
  Status 追記)、統合点のレビューは学習の「受理」のラベルでもある(ADR 0111 決定1)。
- **worker 用の `/implement` の双子を `.tidepool/` などに置く** —— 共有の中身(ponytail・tdd)は1つのままで足り、違うのは段取り
  だけで、その段取りは盤面にある。
- **reviewer が観点ごとの review の子を decompose する** —— 構造上その経路が無く、`review_by` の列と同じ記録を新しい仕組みで
  作ることになる。

## 派生

- Status 追記: ADR 0446(門の後)。
- #4034 が、この形の実装を持つ。その中身は、新しい実装専門の agent と `agents/fugu.md` の registry への作成(人間の操作)と、
  #4046 の装備の機構を待つことである。
- #1879 のコメント「門の1周は今の `/implement` で回す」は、この ADR で置き換わる。
- `/tdd` と `/implement` の seam の変更(#4039)は残す —— 新しい agent も headless で `/tdd` を使う。
- `/implement` がレビュー以外に持つ仕事(seam を PR に書く、run で見つけたことの起票、PR 本文、CI 待ち)の行き先は、#4034 が1つずつ
  決める。
