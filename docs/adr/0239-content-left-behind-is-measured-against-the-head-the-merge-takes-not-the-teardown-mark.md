# 積み残しは後始末の印ではなく、merge される head と内容で比べて測る

2026-10-11 の grilling(issue #1777、発端は #1769 / ADR 0231)で決定。ADR 0231 決定2 は積み残しの merge back 前の
区間を「分解ツリーに後始末が未了のタスクがある」で測り、後始末の印で読んでいた。merge back が conflict すると、
workspace は quarantine に落ち、後始末はそのまま閉じて印を消す。修理の内容は修理のブランチにしか無く、着地する
タスクのブランチは origin 側と同じなので、積み残しの2区間はどちらも偽になり、CI が緑なら修理を欠いた PR が無人
merge される。quarantine を受理しても merge back はやり直されない。再現は #1777 に置く。

## 決定

1. **積み残しは、分解ツリーの done の work それぞれを merge される head と比べて測る。** 対象は着地するタスク自身と
   done の work の子孫で、着地するタスクとの間に cancelled の祖先を持つものは除く(abandon で捨てられた判断の内側に
   残った内容は、運ぶ相手がいない)。比べるのは ADR 0105 の内容の述語で、candidate は merge される head(PR では
   盤面が読む origin 側のタスクブランチ)、source はそれぞれのタスクブランチである。どれか1つでも candidate を
   変えるなら積み残しとする。ブランチが無ければ運ぶ内容も無く、比べられなければ積み残しとする(fail-closed)。
   比べる向きは ADR 0231 決定2 と同じで、盤面の外の push で先へ進んだ側を積み残しと読まない。ADR 0231 決定2 の
   2区間(merge back 前・push 前)は、この1つの比較にまとまる。
2. **後始末の印は読まない。** 完了の門(ADR 0084)が done の時点で commit を揃えるので、印が立っている区間の事実は
   内容の比較に映る。印は merge back が失敗しても後始末が閉じれば消える代理であり、事実が閉じる前に消える —— ADR
   0231 が push 前の区間を内容で測ったのと同じ理由である。

## Considered options

- **印を残し、無人 merge と人間の merge 回答も workspace の quarantine を読む** — quarantine の question が開いて
  いる間しか塞がらず、受理の後は修理を欠いた PR が素通りする。
- **merge back 前と push 前を別々の比較で並べる**(子孫は着地するタスクのローカルのブランチと、そのブランチは origin
  側と比べる) — merge される head に既に載っている内容(盤面の外の push)を積み残しと読む。測りたいのは merge される
  head に載っているかである。
- **quarantine の受理を、merge back が届いていない done の work がある間は拒む** — 修理を捨てたいとき、workspace が
  永久に開かない。
- **「この修理は運ばない」と答える扉を足す** — 捨てる判断は観測されておらず、git の側で表せる(帰結)。

## 帰結

- merge back が失敗した修理は、quarantine の受理の後も積み残しとして止まり続け、自動では運ばれない。運ぶ再発火は
  #1766 が決める —— merge back は後始末の中にあり、着地をやり直すだけでは走らない。
- 人間が修理を捨てるなら、workspace で着地するタスクのブランチへ修理のブランチを `git merge -s ours` で記録し、
  そのブランチを push する(merge される head が修理の履歴を含めば、運ぶ内容は無い)か、盤面の外で merge する
  (ADR 0229 の観測が決裁を引退させる)。
- 回答時と merge 時に、対象の work の数だけ比較が走る。merge back と push が済んだ work は履歴が収束しているので、
  `rev-list` 1回で答えが出る。
