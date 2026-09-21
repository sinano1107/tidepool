# ペース線の評価器は Provider を問わず1本、Provider 固有の事情は観測への変換層に置く

2026-09-22 の grilling(issue #851)で決定。ADR 0143 決定6 は Spend-down の判定が Provider ごとの使用量の経路
1本に集まることを前提にしたが、#801 / #803 の後も anthropic の窓は `/usage` 専用の評価器で、openai の窓は
Provider ごとの使用量の評価器で、同じ ADR 0030 のペース線を別々に計算していた。下流(pickup の門・
Spend-down の失効)はすでに Provider ごとの観測1本だけを読んでおり、2本なのは評価器だけだった。
2本の差の調査は #851 に置く。

## 決定

1. **ペース線の評価器は1本**。anthropic も Provider ごとの使用量の評価を通る。100%キャップ・Spend-down の
   差し替え・catch-up の算出はこの1本だけが持つ。
2. **Provider 固有の事情は観測への変換層に置く**。Claude Code の `/usage` の session / week が読めないときの
   fail-closed(観測不能)と Idle の判別は、`/usage` を Provider ごとの使用量の観測(状態と窓の列)へ変換する
   層が決め、評価器は渡された状態と窓だけを見る。fable の線が Spend-down(week) に従うこと(ADR 0091 決定2)は
   既に Spend-down の述語が持っており、評価器の論点ではない。
3. **逆算の不整合(今が「リセット時刻 − 窓幅」より前)は窓の種類で分ける**。Provider 全体の窓なら、その
   Provider の観測を観測不能(理由付きの fail-closed)にする。model 固有の窓なら、その窓を観測から落とす
   (観測なし)。model 固有の窓は不在がプランの正常な姿でありうるので、そこで fail-closed に倒すと恒久 skip を
   製造しうる —— anthropic の fable で既に採っていた線を Provider に依らない規則にした。
4. **盤面全体の throttle の答えは評価器と一緒に消える**(ADR 0140 決定1 の残り)。#844 はこれに吸収する。

## 退けた案

- **不整合はどの窓も throttled として catch-up まで絞る**(openai の従来の挙動) —— 止まる理由が表示に出ず、
  壊れた観測を正常なペース超過の顔で見せる。
- **不整合はどの窓も観測不能にする** —— model 固有の窓が1本壊れただけで Provider 全体が止まる。
