# 従った skill の行は worker に届いた文とその出所の行動を持ち、skill の文面との一致は主張しない

2026-11-01 の grilling(issue #2818、#2817 の実装の実測の派生)で決定。ADR 0325 決定3・4 は「従った skill の文面は transcript に逐語で残る
注入の行」「版が上がって skill が消えても当時の文面は記録から読める」とし、ADR 0337 決定4 はそれを Codex に延ばして「本文はその行の
`aggregated_output`(worker が実際に読んだ文面)」とした。どちらも **transcript の行が skill の文面の刻印である**ことを前提にしているが、
それは CLI が注入する行だけの性質である。Codex では worker が自分で読むので記録に「skill の文面」という対象は無く、あるのは「許した path を
名指した command とその出力」だけで、実測では同じ SKILL.md を `cat`(全文)→ `python3` で加工(222 字)の順に読んだ2行が両方とも従った skill に
数えられた。Claude にも同じ類の行がある —— 同じ skill の2度目の呼び出しの注入文は `Skill /x is already loaded above; instructions unchanged.`
で、CLI が供した文ではあるが skill の文面ではない(固定版 2.1.286 の実測)。判事と self RCA はこれらを「skill の文面」として受け取っていた。
判事が誤帰責した観測は無い。判事の入力面の記述が事実と違う構造の欠陥で、観測を待たない。実測・`file:line`・読み手の表は #2818 のコメントに置く。

## 決定

1. **従った skill の行の `text` は「その呼び出しで worker に届いた文」であり、skill の文面であるとは記録は主張しない。** Claude では CLI が
   注入した文(2度目以降は CLI の短い通知)、Codex では worker の command の出力(全文・部分・加工・`wc` の数値のいずれでもありうる)。
   ADR 0325 決定3 の「従った文面」と ADR 0337 決定4 の「worker が実際に読んだ文面」はこの意味に読み替える。
2. **各行は出所の行動(`tool` と `args`)を両 Harness で添える。** Claude は `Skill` と skill 名、Codex は `command_execution` と command。
   欄名は行動列(`actions.calls`)と同じで、Harness 専用の欄(Codex だけの `command`、Claude は null)は置かない。届いた文が skill の文面か、
   一部か、加工かは判事がこの出所から判じる。読み手は4つ —— 異議の判事・停止の判事・Behavior 起草(欄を継承)・self RCA —— で、同じ
   出所で渡す。停止の判事には `actions.calls[position]` の写しになるが、他の3つは行動列を持たない。
3. **帰責の規則は足さない。** ADR 0325 決定3 の「文面どおりに従った外れは持ち主、読み違えは `capability`」のまま、判事の prompt には
   「`text` は届いた文で、skill の文面とは限らない」と事実だけ言う。「加工した出力だけに従った外れは `capability`」の規則は、`sed -n` で
   逐語の節を切り出した読みを読み違えと誤分類するので置かない。
4. **述語は変えない。** Codex の従った skill は ADR 0337 決定4 のまま「許した path を `command` に含む完了・exit 0 の `command_execution`」
   を全部数える。
5. **ADR 0325 決定4 の「当時の文面は記録から読める」は、Codex では worker が全文を読んだ行があるときだけ成り立つ。** 記録はそれ以上を
   持たず、持たせない(退けた形 (γ))。skill の文面そのものを修理する側は checkout の git と vendor の版から読む。
6. **transcript の単位への参照の欄は Harness 中立の名 `transcript_ref` にする(#2821)。** Claude は行の uuid、Codex は item id。
   `episode_actions` / `episode_skill_calls` / `episode_markers` の3表とも同じ意味なので3表いっしょに改め、リリース前なので DDL を直接
   書き換える。
7. **self RCA の節は `[name, text]` で畳んだまま、出所の行動を見出しの下に列挙する。** 同じ skill を `cat` で2度読んだ session で全文を
   2度載せず、文が違う行(部分読み・加工・CLI の通知)は別の見出しのまま、どの読みから来たかを行動で見せる。

## 決めないこと

- Claude の worker が `Skill` を呼ばず SKILL.md を `Read` / `cat` で読んで従った場合を従った skill に数えるか(#2838)。Codex では読みが
  従った skill だが Claude では呼び出しだけで、揃えるには workspace skill の path の記録と Claude の `Read` の綴りの実測が要る。

## 退けた形

- **(γ) 盤面が skill の当時版を別の出所(checkout の spawn 時 head の git、固定版の `.system` dir)から判事に渡す** —— `worker_spawned`
  は checkout の head を持たず新しい記録が要り、worker が session 中に SKILL.md を書き換える経路も閉じられない。判事の判定は worker が
  見た文で足り、見ていない文面を渡すと「文面どおり」の判定が見た範囲の外へ広がる。
- **`cat` の行だけを数える** —— command 名の denylist で、`sed -n` / `head` の逐語読みを落とす。
- **path ごとに最初の完了行だけを数える** —— `head` → `cat` の順で読んだ session で部分読みを本文にする。
- **行の出力と SKILL.md の実体を比べて逐語の行だけ本文にする** —— 盤面は本文を持たず(ADR 0325 決定4)、(γ) と同じ記録が要る。
- **Codex だけ `command: string | null` を添える** —— Harness 専用の欄名で、#2821 が指した「Claude の形を写した名前」を1つ増やす。
