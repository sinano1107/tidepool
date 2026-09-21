# Spend-down の対象は「Provider × ウィンドウ」で、Provider をまたいで写さない

2026-09-21 の grilling(issue #721)で決定。Codex usage probe の導入(commit 8910b92)以来、Claude の
Spend-down(session / week)が Codex の primary / secondary にも写されていたが、ADR 0030 / 0091 は対象を
Claude の窓として定義しただけで、Provider 間で共有するとは誰も決めていなかった。Claude の予算だけを燃やす
つもりで arm すると Codex の予約も外れ、逆に Codex の予算を使い切る入口は無い。現状の調査は #721 に置く。

## 決定

1. **Spend-down の対象は「Provider × ウィンドウ」の集合**(ADR 0091 を Provider の軸に広げる)。anthropic の
   session / week と openai の primary / secondary を独立に on/off し、各々が自分の窓のリセットで失効する。
   Provider をまたいでは何も写さない —— 指針「使い切ってよいのは、もうすぐ失効する予算だけ」は窓ごとの
   リセット時刻に立っており、別の時刻にリセットする他 Provider の窓について何も言わない。
2. **窓の名前は Provider 自身の語彙のまま**(pace offset・ADR 0128 と同じ)。session / week に正規化しない。
3. **fable の線は anthropic の week に従う**(ADR 0091 決定2 のまま)。独立の対象にしない。
4. **入口は Provider ごとの使用量の窓の行**。観測に現れている窓だけが arm でき、Idle(ADR 0128 決定2 で行が
   落ちる)や観測不能の窓には入口が無い —— arm の後に開いた窓には Spend-down が当たらないので、そこに
   ボタンを置いても効かない。独立した Spend-down の表示は畳む。人間専用・WebUI 専用は変えない。
5. **サーバの門は既知の組だけ**を検査し、最新の観測に窓があるかは見ない。効かない arm は失効の判定
   (窓の開始が arm より後)でそのまま無害に消える。
6. **実装は #801(#802 / #803)の後**。Spend-down の判定が Provider ごとの使用量の経路1本に集まってから、
   そこに Provider の軸を足す。

## 退けた案

- **共有を追認する**(1回の arm で両 Provider の対応窓を外す) —— 窓のリセット時刻がずれるので「この窓が
  もうすぐ失効する」という意思を1つのボタンで表せない。
- **Codex には持たせず写しだけ外す** —— Codex の Spend-down は結合した形で既に在り、切り離しは拡張ではなく
  既存の結合の修正。追加の費用は状態の provider 列と入口だけ(失効は窓ごとに既に成立している)。
- **Spend-down の表示に Provider の段を足し、4行を常時出す** —— 押しても効かない窓を並べ、判断に要る
  使用率と reset から入口を離す。
- **最新の観測に窓が無ければ arm を拒む** —— 守るものが無く、描画とクリックの間のリセットで拒否だけが増える。

## 帰結

- CONTEXT.md「Spend-down」は対象を「Provider × ウィンドウ」の集合として書き直した。
- #801 の user story 22 が守る「今と同じ」のうち、Codex への写しは本 ADR で撤回予定のもの。#801 では保ってよい。
