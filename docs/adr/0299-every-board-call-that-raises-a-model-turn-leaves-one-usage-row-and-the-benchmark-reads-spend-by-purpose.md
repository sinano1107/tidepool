# 盤面が model turn を立てる Board call は呼び出し1回 = 1行で usage を残し、ベンチマークの費用は支出の目的で分けて読む

2026-10-22 の triage → grilling(issue #2447)で決定。ベンチマークの走行の記録(spec #2439 / ADR 0298)は課題の費用を
`worker_exited.usage` から積むが、盤面自身の Board call の usage は翻訳(`translation_calls`、ADR 0296 決定5)を除いてどこにも残らず、
runner が受け取った usage を client が捨てていた。判断の段の行だけを替えた2走行は、振り返りの model が替わるのに費用の列が同じになる。
呼び手と書き先の `file:line`、使用量の TUI の実測は #2447 のコメントに置く。

## 決定

1. **盤面が model turn を立てる Board call は、種類を問わず呼び出し1回 = 1行で usage を残す。** 答えを取りに行く8用途(翻訳・下書き4・
   振り返り3)と、model turn を立てる probe(認証の検査と model probe、Claude と Moonshot)。`-p /usage` の ping は model turn を立てない
   (cost 0 / num_turns 0)ので行を持たない。probe を外す案は退ける —— 1回の上限は回数を抑えず、認証 probe は使用量を読めないまま候補の
   ある poll のたびに撃ち、Moonshot は従量課金である。揃えて壊れるものは無い。
2. **置き場は1つの表 `board_calls` で、`translation_calls` を畳む。** 行は用途・Provider / model / effort・token 4欄・費用(null は
   測れない)・作成時刻を持ち、断片数は翻訳の行だけが持つ。task は持たない(決定5)。ADR 0296 決定5 の「記録は cache ではない」はそのまま。
3. **答えが返った呼び出しは、受け取れたかを問わず1行。** schema に合わない答えも消費は起きており、受け取れない率は model で変わる ——
   構成の比較が測る差そのもの。答えが返らなかった呼び出し(行の拒否・401・時間切れ・spawn の失敗)は usage を持たず、観測できない
   消費として記録の外にある。行は成否を持たない(振り返りの失敗は `*_failed` の event が持つ)。
4. **envelope に usage が無い答えは呼び出しの失敗にする。** 版を固定して形を門で確かめている以上、欄の欠けは壊れた答えであって記録の
   劣化ではない。判定だけ受け取ると消費が黙って抜け、0 で書くと ADR 0296 決定5 が避けた偽のゼロになる。判定は runner の1箇所で全用途に効かせる。
5. **ベンチマークの費用は支出の目的で分けて読み、どの task に付いたかでは分けない。** 課題の列は仕事(work・review・分解の子・work の
   修理子)の worker の費用だけ。最適化(振り返り Board call・meta-review・RCA・記憶と routing の修理子)、人間面(下書き・翻訳)、観測
   (probe)の費用は走行の節に用途と task の種別ごとに置く。Board call を課題の木に紐づける案は退ける —— 課題の木を足す今の算出は
   Board call を考えずに作られた形で、README の人間の手順(異議)の数で増減する学びの支出を対処の費用に混ぜる。同じ理由で RCA と修理子の
   session も課題の列から外す。所要時間は分けない —— 着地は付帯子を待つ(ADR 0092)ので、RCA の時間は実運用でも対処の時間に入る。
6. **行を書くのは Provider に依らない呼び手で、client は usage を返すだけ。** Codex の client(#2417)は費用 null で同じ表に乗る。

## 帰結

- 使用量の読み取りの TUI は起動のたびに quota の確かめ(`max_tokens: 1` の `messages.create`、haiku)を1回撃つが、usage をどこにも
  報告しないので行にできない(2.1.300 / 2.1.308 で実測、固定版 2.1.286 は未測)。headless の `-p "/usage"` は model を呼ばないので、
  #2010 の置き換えでこの欠けごと消える。
- ベンチマークの記録は「答えが返らなかった呼び出しと、使用量の読み取りの quota の確かめは含まない」と書く。
- settings の translation spend は用途が翻訳の行だけを読む。Board call 全体の費用の面は足さない —— 読み手がいない。
- meta-review の worker の費用は、決定5 の走行の節で初めて記録に載る(課題の木の外にあり、どこにも足されていなかった)。

## 退けた案

- **ベンチマークの記録に「Board call の消費は含まない」と書くだけにする** —— 判断の段の行だけを替えた比較が差ゼロになる。
- **結果の event の payload に usage を足す** —— 5種類以上の event に散り、下書きは event を持たず、起草の成功の event は task を持たない。
- **翻訳の表の隣に別の表を置く** —— 同じ形の表を読み手が2本足す。
