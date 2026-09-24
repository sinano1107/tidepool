# 人間は Behavior の文言を question の中でも設定からも書け、人間が書いた文言は書いた時点で approved になる

2026-09-24 の grilling(issue #915)で決定。ADR 0150 決定2 は routing の提案に修正値を開いたが、memory の提案は
修正の対象が Behavior の**文言**で、承認された本文が candidate と異なりうる。加えて人間が Behavior を書く扉が無く、
文言を直す手段が reject → 次周期の再提案しか無かった。ADR 0120 決定3・4、ADR 0015、ADR 0122 を前提にする。
現状の実装の調査は issue #915 のコメントに置く。

## 決定

1. **承認の線は「人間が文言を保証したか」で引く。** 承認 question は AI が起草した文言を人間が保証するためにある。
   人間が自分で書いた文言には保証すべき他人の文言が無いので、人間が書いた Behavior は書いた時点で approved になる。
   CONTEXT.md の「人間の明示指示は1回で候補化してよいが承認 question は経由する」は、Board call が steering から
   **起草する**経路の話に限られる。

2. **memory の提案 question の approve に修正値を添えられる(ADR 0150 決定2 の memory 側)。** 修正できる欄は
   `title` / `text` / `addressee`。`path` / `scope` は置き場なので、meta-review の構造検査と決定3 の扉に任せる。
   `approve` は candidate を、`consolidate` は統合後の新 candidate を直し、`replaces` の `superseded` はそのまま行う。
   `invalidate` は文言を承認しないので修正値を持たない。修正つき approve は推奨受理率で推奨どおりに数えない。

3. **人間は settings と管理MCP から Behavior を新規に書け、approved の Behavior を編集できる。** 宛先と scope は人間が
   選ぶ。candidate は直接編集できない —— candidate を直す口は決定2 の修正値だけで、question の外で直すと承認の口が
   2つになる。管理MCP の書き込みも人間名義(ADR 0032 の義手モデル)で、提案 question の MCP 回答と同じ位置にある。

4. **修正と編集は、人間名義の新しい approved エントリを作り元を後継つき `superseded` にする、の1つの形。** candidate
   の文言を上書きすると meta-review が起草した文言が記録から消え、`author` が嘘になる。修正つき approve の承認 event は
   question と元の candidate を指し、pin の照合は元の前提のまま行う。出所は自身の作成 event(ADR 0083 追記5)。
   直接編集で pin が崩れた提案 question は、既存の陳腐化 hook が observed で決着させる。

5. **入力は Knowledge の扉と同じ2欄。** 英語正文が必須、原文は任意、人間は逆翻訳を見て英語を確かめる(ADR 0015)。
   question の画面の修正値も同じ形。

## 退けた案

- **修正値を開かず、reject のコメント → 次周期の再提案に任せる** —— 1語違うだけで最短1周期の往復になる。
- **修正値を開かず、直接扉だけを作る** —— ADR 0150 が routing で退けた「画面をまたぐ UX」と同じ。
- **人間が書く Behavior も candidate にして承認 question を通す** —— 人間が自分の文言を自分で承認するだけの手続き。
- **candidate の文言を上書きして approved にする** —— 決定4。
