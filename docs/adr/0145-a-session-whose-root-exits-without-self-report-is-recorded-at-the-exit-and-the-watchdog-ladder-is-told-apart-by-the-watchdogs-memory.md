# self-report なしに root が exit した session は exit の瞬間に失敗を記録し、梯子の中かどうかは watchdog の記憶で見分ける

2026-09-22 の grilling(issue #805)で決定。worker の root process が最終 verb を着地させずに exit すると、adapter は `worker_exited` を書いて強制回収を撃つだけで、task は `in_progress` のまま slot を握り、種別の時間制限いっぱい待った末に watchdog の梯子の底で「時間制限に達し容器を回収した」という偽の failure question が立っていた。実測は issue #724(1ターンを完走して exit 0、verb は全部 cancel)。現状調査と `file:line` は issue #805 のコメントに置く。

## 決定

1. **対象は「root process の exit を観測した時点で、まだ後始末に入っていない session」であり、走っていた時間では切らない。** 最終 verb も上限到達による中断も後始末の印を exit より先に置くので、この条件は正常な終了を拾わない。#724 は1ターンを完走して exit 0 で終わっており、「起動直後」というしきい値はこれを拾えないうえ、値に根拠が無い。

2. **これは「self-report なき終了」の3つ目の観測点であり、ADR 0118 の族ではない。** 再起動中断(boot 時)と watchdog kill(梯子の底)は既に同じ failure question を立てている —— 走って、報告なしに終わり、workspace に途中の変更が残りうる task を retry するか abandon するか、という人間の判断が同一だからである。ADR 0118 の question が断言する「1度も走らなかった」「retry が無駄にするトークンは無い」はこの対象には偽になる。

3. **記録を先に立てて行を `todo` にしてから後始末へ入る。** `in_progress` のまま後始末に入った session は上限到達による中断として読まれる(ADR 0113 決定3)。強制回収は exit の時点で送達済み(ADR 0109 決定4)なので、あとは回収済み観測 → tree rule・slot 解放である。再起動中断が `failTask` 直呼びで済むのは boot 時に slot が空だからで、走行中は slot を握っているので後始末の型を通す。証拠は既存の `worker_exited` で足り、event 種別は足さない。

4. **watchdog の梯子に入った session の exit は、watchdog の in-memory の送達記録で見分けて除外する。** 梯子は畳み込み停止から回収済み観測まで後始末の印を置かないので、見分けなければ stop に従った exit が「報告なき exit」の question を先に立て、watchdog の question と2枚になる。記憶は再起動を越えないが、越える必要が無い —— 再起動後は boot 時の再起動中断の記録が受ける。

5. **tool surface drift の強制回収・動力の認証の失効(401)・Codex の上限到達による exit は除外しない。** drift と 401 では quarantine の確認 question とこの failure question の2枚が立つが、主語が別である(ホスト / provider の資源と、task の retry 判断)。Codex の上限到達の形は未観測で(ADR 0104)、観測されるまではここに落ちる。

6. **question が断言するのは3つだけ** —— どの task の worker が・最終報告(完了・分解・エスカレーション)なしに exit した・exit code / signal。stderr 末尾は空でなければ添える。時間制限にも容器の回収にも原因の推測にも触れない。retry / abandon、推奨 retry。

## 退けた案

- **起動からの時間で対象を切る** —— 決定1。
- **ADR 0118 の族に編入する** —— 決定2。
- **梯子に入った印を行の列に持つ** —— 再起動を越える必要が無い(決定4)。stop の前に後始末の印を置く案は ADR 0113 決定3 と衝突する。
- **見分けず、stop 後の exit もこの経路で決着させて梯子を短絡する** —— 「時間制限で止めた」という事実が文面から消える。
- **401 を上限到達による中断と同じ環境事象として question なしで queue 先頭へ戻す** —— ADR 0104 の経路を広げる別の主語で、今回は決めない。retry と答えても行は quarantine で skipped のまま待つだけで害は無い。
