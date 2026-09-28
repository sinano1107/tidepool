# 第2回の帰責と起草を撃つのは poll の sweep だけで、扉は撃たず、束の欄は必須にする

2026-09-28 の grilling(issue #1097、ADR 0164 の派生)で決定。ADR 0115 / 0120 は第2回の帰責と Behavior candidate の起草を扉(RCA 子の
決着・triage close)からの fire-and-forget で撃ち、ADR 0164 が後から「結果の不在で拾って撃ち直す」sweep を poll に足した。二つの機構が
同じ結果を作るので、扉の配線を外してもテストは sweep が拾って緑のまま、扉の deps の束 `AttributionCallDeps` は4欄すべて optional で
扉の deps を丸ごと渡しても型検査が通る(実測は #1097 のコメント)。

## 決定

1. **撃つのは sweep だけ。** 第2回の帰責と起草は、pickup の poll が「あるべき結果が無い」帰責(ADR 0164 決定1)を見て撃つ。RCA 子の
   決着(worker の complete、人間の cancel / complete / abandon)と triage close は撃たない —— 初回の帰責だけは commit がその場で結果を
   使うので同期のまま(ADR 0168 決定1)。束を受け取るのは scheduler と triage close の2つになる。代償は遅れで、決着の直後に poll が
   来ない場合(親がまだ塞がれている、poll の実行中に `pollNow` が捨てられた)は最長で毎時の tick まで待つ。読み手は週次の meta-review と
   人間の面の cause 表示で、即時性が要ることを示す観測はまだ無い。要ると分かったら扉が Board call を撃つのではなく poll を促す形で戻す。
2. **「撃ち直し」の語は保つ。** sweep = 結果の不在で撃つ機構、撃ち直し = その2回目以降(失敗後の間隔と上限が掛かる側)。code の
   `refire*` と event の kind(`refire_retried` / `refire_dismissed`)は触らない —— 人間の面に出るのは撃って失敗し続けた行で、それは今も
   撃ち直しの話である。
3. **束の4欄は必須にして値に `undefined` を許す。** 合成 root が組む束は1つで、受け取る deps の欄も必須。optional のままだと
   `workspace` / `containers` を共有する扉の deps を丸ごと渡しても型検査が通り、client だけが黙って落ちる。

## 退けた案

- **扉を契約にし、sweep を回復に留める** —— 扉ごとに sweep 抜きで撃つことを言うテストを足し、型も塞ぐ。sweep は「撃てなかった」
  「再起動で消えた」まで拾う設計で扉より広く、扉が主という前提のほうが古い。二つの機構が同じ結果を作ると、片方がもう片方の欠落を隠す
  状態が残る。
- **扉を即時性の最適化として残し、テストは足さない** —— 保証の無い配線を production に残す。
- **`refire*` を `sweep*` に改名** —— ADR 0164 の語彙と DB に書かれた event の kind が code と食い違う側に倒れる。
- **triage close には `attributionClient` だけ渡す** —— #1072 が畳んだ平らな配線を1欄ぶん戻す。初回の帰責も同じ Board call である。
