# `read_memory` は本文が同じ後継(path_moved・復元の複製)だけを読み手の視界の内側でたどり、残りは落とした理由と後継を返す

2026-09-28 の triage(issue #1048、#1038 後の記憶機構の見直し)で決定。`read_memory` は見えない id を黙って落とし(approved・未無効化・
scope・宛先のフィルタ)、落とした理由は結果にも event にも残らなかった。注入は spawn 時の snapshot なので、session の途中で entry が
移される・畳まれると、worker は注入の目次で見た id を `read_memory` しても空を受け取り、Episode には「読まなかった」と残る —— read の
観測が汚れる。ADR 0122 決定1 は後継の検査を「置換の連鎖が注入に届く側で止まらないため」と置き、ADR 0162 決定6 は提案 question に
`path_moved` をたどらせたが、届く側の worker に連鎖をたどる者がいなかった。

## 決定

1. **`read_memory` は本文が同じ後継だけをたどる —— `path_moved` の鎖と、復元の複製(`restored_from` が旧を指す生きた複製)。**
   末尾の本文を返し、返す entry に `requested_id`(求めた旧 id)を添える(たどったときだけ)。複数の旧 id から同じ複製に着いても
   entry は1件で、`requested_id` は最初に求めた id。ADR 0162 決定6 と同じ線 —— 本文が同じならたどる、変わったならたどらない。
   復元は人間が「有効に戻した」と判断済みで置き場も本文も同じ、1つの本文から生きた行は常に1本(ADR 0163 追記)なので鎖は一意。
2. **本文が変わった・無くなった無効化(`superseded`・理由コードでの無効化)はたどらず、結果に `dropped: [{ id, reason, successor }]`
   を返して worker に選ばせる。** 理由コードはそのまま(`capability` = 誤っていた、`environment` / `requirement_change` = 陳腐化した、
   の差は代わりに何を探すかを変える)。`path_moved` の鎖の末尾が無効化されていれば、末尾の理由と後継を返す。
3. **見える範囲の線は動かさない。** `dropped` に載るのは「無効化される前なら読み手に見えていた」行 —— scope(task の workspace or
   盤面全体)と宛先が一致する approved —— だけで、scope / 宛先 / state で見えない id は今どおり黙って落とす。後継も同じ門: 読み手に
   見えない後継は `successor` に載せず、鎖のたどりもそこで止まる(ADR 0122 決定1 は後継が別 scope でよいとしている)。
4. **pull の event に `dropped` を残す(`search_memory` の `candidates` と同じ形)。** 「旧 id を求めた」は `input.ids`、「複製を読んだ」は
   `returned_ids`(たどった先の id)、「たどれずに落ちた」は `dropped` —— Episode の read の観測が3つとも今の列で揃い、`entries_read`
   の定義(`read_memory` が返した id)は変えない。
5. **`search_memory` は触らない。** hit の段階では worker が id を持っておらず、案内する先が無い。FTS が無効化行を索引していることは
   issue #1052 / #1056 の主題。

## 退けた案

- **`superseded` もたどって後継の本文を返す** —— worker が求めていない本文を「読んだ」と記録する。
- **たどらず、落とした事実と後継 id だけ返す** —— 同じ本文を取りに1往復増え、`path_moved` の「本文は同じ」を盤面が保証している
  意味が使われない。
- **理由を `superseded` / `invalidated` の2値に潰す** —— 誤っていたのか陳腐化したのかで、worker が次に探すものが変わる。
- **見えない後継も `successor` に載せる** —— 「そこに何かがある」を視界の外に見せる。今の `Ids you cannot see are omitted` の線を破る。
