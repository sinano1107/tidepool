# 提案から立つ Interview の root の workspace は、meta-review が根拠の episode から名指し、人間は approve で差し替えられる

2026-10-14 の triage / grilling(issue #921)で決定。meta-review の提案 question(種別 Interview)を approve すると盤面が人間名義の
root review を登録する(ADR 0150 決定6)が、その root の workspace を誰が決めるかはどの ADR にも無かった。workspace は飾りでは
ない —— pin の子は root の workspace を継ぎ(ADR 0253 決定1)、probe はその checkout の上で解かれ、結果は学習器でその workspace
の層と盤面全体の層に数えられる(ADR 0110 決定4 / ADR 0210 決定2)。読み口と経路の照合は #921 のコメントに置く。

## 決定

1. **提案が workspace を持ち、meta-review が名指す。** verb は、登録済みの名前で、かつ根拠の episode のどれかの task の
   workspace であることを検査する。根拠が複数の workspace にまたがれば meta-review がその中から選ぶ。疑いが出た code の上で
   probe が書かれ、結果が疑いの出た層に入る。meta-review の選択を根拠に立たせるのは、提案は根拠の episode から出るという
   線(ADR 0199 決定5)と同じである。
2. **人間は approve の修正値で workspace を差し替えられる。** 行き先は登録済みのどの workspace でもよく、根拠の workspace に
   縛らない。修正値は purpose・対象の effort / tier・workspace になる(ADR 0150 追記2 に足す)。provider / model が動かせないのは
   根拠の行で pin の一部だからだが、workspace は pin の外にある。人間は直接の登録でどの workspace でも選べるので、approve で
   だけ縛る理由が無い。
3. **meta-review は根拠の id を拾う読み口の同じ行で workspace を見る。** 今の読み口はどれも workspace を出さないので、
   決定1 の欄を埋められない。呼び出しを増やさない形にする。
4. **workspace が消えても pin には入れない。** approve の時点で名前を確かめ、registry に無ければ回答ごと拒否し、拒否の文は
   「修正値で差し替えるか reject するか」を示す。question は開いたまま残る。pin は提案の前提(根拠の行、対象が表に無いこと)
   が崩れたことを表し、測る場所が無くなっても「この対象を測るか」の問いは残る。

人間が直接登録する Interview は変わらない —— 根拠を持たず、workspace は登録の扉で人間が選び、空なら pickup で既定が入る
(ADR 0233)。根拠の無い meta-review の提案は今までどおり verb が拒む(ADR 0199 決定5)。

## 退けた案

- **workspace を持たせず null にし、pickup で既定に任せる(meta-review 自身と同じ)** —— probe も学習器の層も疑いと無関係な
  場所に落ちる。
- **根拠が1つの workspace に揃わない提案を拒み、盤面がその workspace を入れる** —— workspace をまたぐ正当な根拠を出せなくなる。
- **workspace を修正値にしない(別の場所で測るなら reject して直接登録)** —— 「提案 question の修正は question の中で」
  (ADR 0150)が破れる。memory の `scope` が修正できない(ADR 0152 決定2)のは置き場が entry の正体だからで、Interview の
  workspace は測る場所であって置き場ではない。
- **workspace の削除で question を observed で決着させる / 開いた提案が名指す workspace の削除を拒む** —— 前者は人間が
  question の中で直せる提案を捨て、後者は approve で直せるのに提案に削除を止める力を持たせる。
