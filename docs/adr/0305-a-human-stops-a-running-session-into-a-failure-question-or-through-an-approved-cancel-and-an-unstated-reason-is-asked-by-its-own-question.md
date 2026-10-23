# 人間は走っている session を止められる —— 止めて次を決める(failure question)か、承認付きの cancel で止めて捨てるかの2出口、理由が無ければ別の question で後から訊く

2026-10-23 の grilling(issue #2527 から派生)で決定。盤面には走行中の worker session を人間が止める手段が無く、止まるのは watchdog の cap
(work は 90 分)か worker 自身の最終 verb だけだった。不審な挙動の session、もう要らないのに token と時間を食っている session を止めるのは
当たり前の要望で、ADR 0304 の不変条件(走っている task は盤面が session を終わらせない限り cancelled にならない)の上では、祖先の cancel を
通すための前提でもある。Pause は盤面全体で新規 pickup だけを止め、走っているものには触れない(CONTEXT.md「Pause」)ので、別の操作になる。
機構の調査(cap の経路、人間の扉に届く deps、WebUI の面)は派生 issue のコメントに置く。

## 決定

1. **出口は2つ、機構は1本。** どちらも cap と同じ順で session を畳む —— 畳み込み停止 → 猶予 → 強制回収 → 回収済み観測 → 後始末 ——
   が、**status の決着と後始末の印は要求の transaction で先に置く**(cap の「記録を後始末より前に」と同じ、ADR 0113 / 0254)。以後の
   worker の verb は既存の後始末の門(session over)で拒まれ、ADR 0304 の床が二重に守る。
   - **人間の停止(Human stop)**: 止めて、次を後で決める。要求の transaction で task の下に failure question(retry / abandon)を立て、
     subtree は Held になる。cap と違い question は容器が空になるのを待たずに立つ —— 止めた人はすぐ答えたいし、挙動は本人が見ている。
   - **cancel の停止承認**: 決めてあるので止めて捨てる。ADR 0304 の門が走っている task X を名指して拒んだあと、人間が X の id に釘付けした
     承認を付けて cancel し直すと、cascade(X も cancelled、理由は cancel の reason)と X の session の後始末の印を1 transaction で行う。
     failure question は立たない —— それは人間の判断なしに盤面が session を殺したときに次を訊く器で、ここでは次は決まっている。承認は対象
     自身にも効く(走っている root の直接 cancel)。拒否と再試行の間に別の task が走り始めていれば承認は合わず、もう一度拒む。
2. **理由は止める時には任意。空なら、盤面が同じ transaction で自由記述の question「why did you stop X?」を盤面名義の root として立てる。**
   本当に危険なときは理由を書く余裕が無いが、理由は後の学習の材料なので一度は必ず訊く。failure question の answer の comment(ADR 0179 の
   操舵 channel)に理由を担わせない —— 別のもの。root なので X の cascade の範囲に入らず(abandon で消えない —— 捨てた task ほど理由が要る)、
   X の pickup も塞がない(retry の後いつ答えてもよい)。X との結びつきは question の種類(`stop_reason`、X の id を持つ —— quarantine の
   確認 question が資源を指すのと同型)と、停止の event が持つ question の id の両側で持つ。**出口を問わない**: 停止承認の cancel でも
   cancel の reason が無ければ同じ question を立てる —— 根拠は出口でなく「止めた瞬間に人だけが見た挙動は記録から再構成できない」こと。
   理由の有無は ADR 0212 の required-text の線で読む(欄の省略 = 無し、空白だけは入力面が拒む)。
   **理由は停止の事実の隣に読める。** 読み口は1つ: 停止の event の reason → 無ければ理由 question の答え → 未回答ならその旨。X の history を
   読むものすべて(次の session の briefing・`get_current_task`・meta-review・記憶・WebUI)がこの読み口で停止の行を描く。`task_cancelled` の
   `origin_question_id` を `cancelOrigin` が辿るのと同じ型で、question の行を読みに行く読み手を作らない。
3. **止められるのは人間だけ、対象は slot を握るどの session でも。** agent には開かない(Pause と同じ「自己停止の経路を開かない」の線)。
   型は問わない —— 受験者を止めれば受験者の failure question(ADR 0263 決定9)が立つ。slot が空、または既に後始末中なら DomainError で拒む。
4. **記録と面。** 停止の事実は event(`session_stopped_by_human`、理由があればそれを、無ければ理由 question の id を載せる)で両出口が共有する。失敗 question の題は
   `stopped by human: <title>`(cap の `watchdog killed task:` と並ぶ)。畳んでいる間は slot 行の後始末中の表示に「人間の停止」と理由を足し、
   新しい状態は作らない。

## 退けた形

- **停止 verb に「hold / cancel」の出口を持たせる**: cancel は abandon の回答と祖先の cancel で足りる。出口を2つ持つのは cancel の側(承認)。
- **理由を必須にする**: 緊急時に手を止めさせる。代わりに決定2 で後から訊く。
- **failure question の answer の comment を理由の代用にする(空なら必須化)**: 別の channel の統合。
- **停止理由を後から足す追記 event**: 既存の自由記述 question で足りる。
- **理由 question を X の子にして pickup を塞ぐ**: 親が待つ子は定義上 cancel を生き延びない(ADR 0271 決定3)ので、生き延びさせるには表に例外行が要る。
