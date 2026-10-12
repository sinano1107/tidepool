# 積み残しは、merge の門では GitHub が報告した head と、収束では盤面が最後に push した head と比べる

2026-10-13 の grilling(issue #1837、発端は #1766 の grilling)で決定。ADR 0239 決定1 は candidate を「merge される
head」とし、実装はそれを盤面の手元の remote-tracking ref(写し)で読んでいた。写しは盤面自身の push と同じ checkout の
fetch でしか動かないので、別の clone からの force-push(#1831)や refspec を絞った checkout(#1778)のたびに判定を誤る。
一方、merge を固定する head は GitHub から読んでいる。比べる相手と固定する相手が別物であることが根である。読む場所の
一覧と git の実測は #1837 に置く。

## 決定

1. **merge の門(無人 merge の tick・人間の merge 回答)は、GitHub が報告した PR の head と比べる。** CI を読む1回の
   読み取り(ADR 0231 決定1)が返す head を candidate に置き、その commit が手元に無ければ sha で fetch する。読む・
   比べる・固定するが1つの sha になる。人間の merge 回答は head を先に読み、同じ head で積み残し・CI・merge を通す。
2. **収束(push の判定と push 後の読み直し、ADR 0241 決定7)は、盤面が最後に push した head と比べる。** 収束が
   答えるのは「盤面はこの内容をもう押したか」であり、その一次の綴りは盤面自身の記録(`pr_opened` / `pr_branch_pushed`)
   である。GitHub も写しも読まない。
3. **「ブランチが無い」は、無いと確かめられたときだけである。** それ以外の git の失敗、head の fetch の失敗、PR が
   読めないことは、どれも「比べられない = 積み残し」(fail-closed)。
4. **盤面の外の push が内容を落とした head は、キューを外して推奨 hold の merge question に倒す。** 最後に push した
   head には全部載っているのに GitHub の head に無いとき、盤面には運ぶ手が無い。question は届いていない子孫のブランチを
   名指しし、直す手段を2つ書く(内容をブランチに戻す / 捨てるなら `merge -s ours` を記録して push する — ADR 0239
   帰結)。「merge」の回答は積み残しが残る間は拒まれたまま(CI 赤と同じ形)で、拒否文は「盤面がまだ運んでいる」でなく
   外の push の事実を言う。両方の head に無ければ盤面がまだ運んでいるので、キューに残す(ADR 0231 決定3 のまま)。

## Considered options

- **refspec を明示して写しを fetch し直し、GitHub の head と一致するときだけ比べる** — fetch と読みの間に head が動く
  窓が残り、写しという ref を1本余計に書く(ADR 0064 の再基準化も要る)。sha の fetch は `refs/` に何も書かない。
- **写しのまま更新の契機を足す** — 契機を足すたびに別の issue が出る、今の形そのもの。
- **merge の門でも盤面が最後に push した head と比べる**(#1778 の triage 案) — 記録した head は修理を持っているので、
  外の force-push が修理を落とした head を「積み残し無し」と読む(#1831 を塞がない)。
- **外の push が落とした head を失敗 question に倒す** — retry は収束を走らせるが、収束は「push 済み」と答えて何も
  変えず、question だけ閉じる。

## 帰結

- 盤面自身が push した head は手元にあるので、通常の tick で fetch は走らない。走るのは盤面の外の push のときだけ。
- 積み残しを読む場所は4つ(tick・merge 回答・収束の push 判定・push 後)で、測り方は2つになる。CONTEXT.md「積み残し」
  をそのように改め、ADR 0239 決定1 と ADR 0231 決定3 に Status を追記した。
