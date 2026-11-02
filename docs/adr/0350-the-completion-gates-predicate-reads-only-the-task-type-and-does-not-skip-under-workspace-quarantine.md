# 完了の門の述語は task の種別だけを読み、workspace の Quarantine では門をスキップしない

2026-11-02 の grilling(issue #2910、#2889 の実装で見えた形)で決定。完了の門(ADR 0084)と完了経路の後始末の検査(ADR 0109 決定3)は
`completionTreeGateApplies` = 「work タスクかつ workspace が needs-human でない」を共有していた。ADR 0109 決定3 の「同じ述語」は
**範囲**の話だが、同じ関数を verb の時点と後始末の時点で読み直すと、`needs-human`(今 workspace の question が開いているか)は時間で
変わるので別の**事実**を読む。verb と後始末の間に question が開くと —— 1度目の後始末自身が立てた question の後の再実行でも、
別の書き手(merge 回答の帯域外書き込みなど、解決できる名前に question を立てるもの)が立てた question でも —— 後始末は検査でなく退避に落ち、報告の後に書かれた内容が
WIP commit として親のタスクブランチへ merge back された(実測、#2910)。`needs-human` の項の出所は ADR 0084 決定2 が「workspace が無い /
解決できない / quarantine 中」を1行に束ねたことにあり(issue #240 は quarantine を解決不能の一種として括った)、quarantine 固有の
理由はどこにも無い。Quarantine 中の workspace は解決でき、tree も観測できる。実測と site は #2910 のコメントに置く。

## 決定

1. **完了の門の述語は `task.type === "work"` だけである。** verb の門(ADR 0084)と後始末の検査(ADR 0109 決定3)の両方が、この
   時間に依らない述語を読む。workspace の Quarantine 中でも門は掛かる —— Quarantine は pickup を止めるもので、走行中の worker が
   自分のタスクブランチへ commit して呼び直す能力を奪わない。ツリーを観測できない git の素通し(ADR 0084 決定2)は変えない ——
   そこは後始末の検査が「usable git repository でない」という事実どおりの理由で止める。ADR 0084 決定2 の「quarantine 中のタスク —
   門をスキップ」はこの決定で覆る。
2. **後始末が「門が掛かっていたか」を知る方法は述語の再読みのままでよい。** 述語が時間に依らないので、verb の時点の事実を
   event の順序や印から復元する機構は足さない(ADR 0345 決定1 の「印は足さない」と同じ線)。
3. **ADR 0345 決定4 の「Quarantine に落ちて返った tree rule の再実行は同じ観測の再発火」は、述語が再実行で変わらないことに乗る。**
   その前提の持ち主は本決定である。

## 退けた形

- **verb の時点の門を、question の event と `task_completed` の順序から導く**(triage の推奨)—— 時間に依る項を残したまま過去を
  復元する。verb より前に開き後始末までに回答された形は `question_answered` の閉じも読む必要があり、未検証の形が残る。
- **後始末だけ needs-human を読まない** —— verb の前から question が開き未 commit のまま完了した形を「報告の後に書かれた」と
  事実でない理由で止める。門を全 work 完了に掛ければこの形は生まれない。
- **1度目の後始末自身が立てた question だけを数えない**(#2910 本文の案)—— 別の書き手が verb と後始末の間に立てた question の
  経路が残る。

## 派生

- Status 追記: ADR 0084 決定2、ADR 0109 決定3、ADR 0345 決定4。
- GLOSSARY.md の Slot-release tree rule の項。
- 実装は1 slice、#2910 のコメントが spec。
