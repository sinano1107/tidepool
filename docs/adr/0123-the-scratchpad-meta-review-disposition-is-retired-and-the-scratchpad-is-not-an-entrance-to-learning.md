# scratchpad の meta-review 振り分けは廃止し、memory meta-review の入口は周期だけにする

2026-09-17 の grilling(issue #628)で決定。#618 は ADR 0120 決定2 の「scratchpad の `meta_review` 振り分けは主題 `memory`
の手動登録になる」を spec #615 D の「due 判定は通らない」のとおり実装し、未決着1本の門も通らず、行本文は捨てていた(#618
以前は行本文が review の title)。この振り分けは 2026-07-08(issue #6)に「苛立ちを instruction / authority の diff に蒸留する
review」として作られたもので、学習の入力を異議だけに置いた ADR 0083 決定7 より前の形である。現状の `file:line` は issue #628
のコメントに置く。

## 決定

1. **scratchpad の `meta_review` 振り分けを廃止し、振り分けは `task` / `register` / `discard` の3つにする。** ADR 0120 決定2
   の当該一文は撤回する。行本文が meta-review にできることは「candidate の繰り返しを判断する材料 / Knowledge・Definition
   修理の契機 / 据え置き」に限られ、行から記憶に落ちる経路は無い(approve は既存 candidate、consolidate は replaces ≥ 1、
   直接適用は Knowledge / Definition のみ)。振り分けが残ると学習の入口に見え、人間は「異議すればよかった」を後から知る。
   decision log を読んで学ばせたいことの扉は**その場の異議 + steering**(`preference` → Board call が起草、ADR 0115 決定3)で、
   事実は人間が直接書く Knowledge / Definition。scratchpad 自体(一本道の triage の途中で思いついたことを落とす面)は残る。
2. **memory meta-review の登録入口は周期だけ。** 「今すぐ走らせたい」は周期の日数を短くすることで満たし、即時実行の扉は痛みが
   観測されるまで足さない。root review の人間の入口は Register 直接登録(独立監査)の1つになる。
3. **未決着1本の門に手動の例外は作らない。** 廃止で対象は消えるが線として記す: approve op の pin は「candidate が未無効化」
   だけで、承認しても candidate は無効化されないため、同主題の meta-review が2本 open だと同じ candidate への提案 question が
   両方に立ち、片方を承認してももう片方は陳腐化しない(spec #615 story 20 の破れ)。将来 `routing` 等の主題に手動入口を
   足すときも、周期と材料の判定は飛ばしてよいが未決着の門は通す。

## 退けた案

- **「今すぐ走らせる」引き金として残し、行本文を purpose に原語で追記、未決着なら保留 note として次の登録に畳む** —— 成立は
  するが、届け先を設計しても行から記憶に落ちる経路は無く、入口が学習の扉に見える問題が残る。
- **同主題が open でも登録する(#618 の現状)** —— 上の story 20 の破れ。
- **open な meta-review の purpose に行を届ける** —— 盤面登録の task に人間の編集経路が無く、in_progress には扉が無い。
- **事例の無い規則を人間が直接 candidate として書く入口** —— 異議で表現できない唯一の種類だが、ADR 0083 が意図的に外した
  prompt engineering の形。未観測なので派生 issue(needs-info)に置き、本 ADR では決めない。
