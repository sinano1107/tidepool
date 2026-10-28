# 盤面が散文で名指す id は同じ応答の構造欄が持ち、history の行は自分の event id を名乗る

2026-10-28 の triage → grilling(issue #2672、#2663 の再確認で出た族の根)で決定。盤面が worker と判事に出す散文 —— RCA の purpose
の「stop 123: …」「entry 3: …」、定義の証拠節の「stop #123」「entries #3, #5」、判断ログの行の「repair <task id>」「deliverable <task id>」——
は event id / task id で対象を名指すのに、同じ応答の構造の側はその id を持たなかった: `parent.history` の行に event id が無く(行の id は
paging の鍵にだけ使う)、子の context は受験者以外 task id を持たず、停止 RCA の `actions` は停止 id を持たず、`complete_rca` は材料の id
を purpose の散文から読ませていた。判事の `decision_log` と `rca_findings` も `string[]` で、self / auditor の出所すら読めない(#2667)。
読み手は順番と文面で突き合わせる。code の読みと `file:line`、既存テストの一覧は #2672 のコメントに置く。

## 決定

1. **盤面が散文で id を名指すなら、同じ応答のその対象の構造欄が同じ id を持つ。** ADR 0321 決定5(散文の「issue #N」でなく兄弟の
   構造欄)の線を history・RCA の envelope・判事の入力へ延長する。反対側の決定は無い: ADR 0047 退けた案1 が退けたのは生の
   EventRow を出して **worker に join させる** 形で、行が自分を名乗ることではない。伏せた handoff(ADR 0111 決定6 / ADR 0253 決定4)が
   伏せるのは **agent / model** で、id ではない(`src/tasks.ts` の「ADR 0199」の引用は誤り)。
2. **history の行は `id`(その行の event id)を名乗り、子の context は全ての子が `id`(task id)を持つ。** 判断の行は `decision_logged`、
   完了は `task_completed`、停止は停止 event、retry は `interview_retried` の id で、`joinHistory` で畳んだ判断の行も判断の id を保つ。
   `read_evidence_history`(ADR 0273 決定9)も同じ行の形。受験者だけが `id` を持つ特例は消える。判断の行に構造の `judgment` は写さない ——
   散文の id が隣の行・子の `id` に解ければ足り、`judgment` を機械で読む worker は無く、memory / routing の `judgment` は大きい。
3. **`memory_written` の行も history の行になる。** 判断ログの人間向けの行のうちこれだけ history に無かった(ADR 0047 は記憶の直接書き込み
   の行(ADR 0252)より前)。記憶の書き込みの行への異議 RCA が、材料の行とその前後の判断を同じ列で読むため。文は skim と同じ1行。
4. **RCA 子の envelope は `material`(登録 event の材料 id の列、`complete_rca` の引数と同名)を持つ。** verb が返させる id を盤面が構造で
   渡していないのが、この族の最も直接の現れ。停止 RCA の `actions` は据え置く —— 材料は停止1つ(ADR 0310 決定4)で、`material` が
   在れば `actions` はその session のものと決まる。
5. **判事は worker と同じ `{ id, line }` の行を読む。** 異議・停止の `decision_log` は `{ id, line }[]`、第2回の `rca_findings` は RCA ごと
   `{ review: "self" | "auditor", task_id, entries: [{ id, line }] }`(#2667 を畳む)。`actions.decisions[]` は marker が持つ `eventId` を `id` として
   運ぶ(worker・判事とも)。判事が解く id は材料の entry id なので `judgment` は載せない(決定2 と同じ線)。
6. **散文の id は名詞 + 裸の番号で、`#` は GitHub の issue / PR だけ。** `entry 3` / `stop 123` / `memory entry 33` / task は UUID のまま。`#N` は
   GitHub の記法で盤面の散文でも GitHub が最多であり、同じ `#` を3つの id 空間に使うと名詞だけが空間を分ける。今回直すのは定義の
   証拠節の `stop #123` / `entries #3`。記憶の書き込みの行と提案 question の `#33` は #2668 の側で扱う。

## 退けた形

- **判断の行に `judgment` を写す** —— 決定2。
- **`actions` を `parent` の下へ動かす / `stop_event_id` を添える** —— 決定4。停止が2つある RCA は ADR 0310 が作らない。
- **`#` を記憶の entry に残し、判断ログの行・停止だけ外す**(初案)—— `#` は GitHub の id と読まれる。記憶だけに残す理由が無い。
- **`memory_written` の行を足さず、記憶の entry id で足りるとする** —— memory_repair 子はそれで動くが、異議 RCA は材料の行を列の中で読む。

## 帰結

- `premise_breached` も異議の対象の種別だが、history には子の context の `premise_breach` 欄としてしか出ず、行の id を持たない。決定1 の
  規則は当たるが本 grilling では決めず、派生 issue に置く。
- `briefing_as_spawned[].for`(ADR 0321 決定2)は材料 id の列のままで、決定4 の `material` と同じ id を文面ごとに束ねて持つ。名前は変えない。
- 既存テストで history 全体を `toEqual` で釘付けしている箇所は `id` が加わる分だけ fixture を更新し、釘は変えない。
