# provider 省略は宣言を満たす経路の全 Provider に展開され、資格情報の不在は quarantine ではなく pickup の除外である

2026-09-12 の grilling(issue #557)で決定。ADR 0110 決定1 は `provider` 省略を「盤面が資格情報を持つ全 Provider を床の構成で」と
定めたが、#544 の実装は「盤面が知る全 Provider」に展開している —— 盤面は「資格情報を持つ」を宣言として持たず、あるのは probe と
失敗後に効く認証 quarantine(ADR 0097 決定2)だけだったため。結果、鍵の無い moonshot が候補に入って spawn で落ち、`skills: ["*"]`
(配布される種の default-agent と同じ)や advisor を持つ agent は省略した瞬間に openai / moonshot entry で登録拒否される。
食い違いの根は、能力適合が**定義の静的な性質**(正準経路の能力表は定数)であるのに対し、資格情報は**盤面のその瞬間の性質**
(鍵ファイルは registry を触らずに置かれ、消える)であることを、決定1 の文言が1つに混ぜていたことにある。この ADR は ADR 0110
決定1 の省略の定義を置き換える。entry 単位の検査、pickup 時の決定論、「黙って落とさない」線(ADR 0097 決定3 / ADR 0098)は動かさない。
実装の測定と `file:line` は #557 のコメントに置く。

## 決定

1. **省略の展開は registry 側で完結する静的な集合。** 「盤面が知る Provider のうち、正準経路がこの agent の宣言(`skills`)を満たすもの」を
   advisor なしの床の構成で並べる。宣言された entry は従来どおり不適合なら登録拒否 —— 「黙って落とさない」が守るのは**宣言された意図**の
   劣化であり、省略は Provider について何も宣言していないので、適合で絞るのは意図の劣化ではなく省略の解決である(ADR 0114 決定3 が
   ティアの行の無い Provider を entry ごと除外したのと同じ線)。適合する Provider が0なら登録拒否(空の provider list と同じ扱い)。
   展開の出自(省略由来か書かれたか)は記録・表示で区別しない —— 展開は決定論で能力表から読めるので「隠れた既定が無い」は保たれる。
2. **advisor は entry の性質だけ。** トップレベルの `advisor` は `model` / `effort` と同じ退役フィールドとして登録拒否する(黙って
   無視しない)。省略は常に床(advisor なし)で、advisor が要る agent は entry を書く。単一文字列の綴り `provider: anthropic` は
   advisor なしの長さ1 entry として残る。
3. **資格情報は pickup 時の除外条件で、宣言 / 暗黙を問わず entry に当てる。** 「資格情報を持つ」は entry 集合の定義から外れ、ADR 0110
   決定3 の除外条件「Provider 認証」に帰属する。除外は Throttle と同じく entry の出自を見ない —— ゲート・skipped 表示・Pickable head を
   1つの式から導く線(#544)を崩さないため。全 entry 除外なら skipped で、spawn までは行かない。
4. **資格情報の不在(absent)は失効(unauthorized)と区別する。** 不在 = そもそも置かれていない(moonshot: 鍵ファイル無し、openai: Codex の
   login 未実施 —— codexHome 配下の `auth.json` の存否を同期に読み、無ければ probe を撃たない — 中身は読まない(ADR 0098 決定5 の線は無傷)。anthropic に不在は無い: 盤面自身の認証状態)。
   不在は確認 question を立てず、Provider usage の観測状態として poll ごとに読み直し、観測不能と同じ経路で pickup から外れて skipped に
   現れる。置かれれば次の poll で候補へ戻る。失効(置かれているが通らない)は従来どおり quarantine。quarantine は「期待していた資格情報が
   壊れた」ことを人間に届ける機構で、「設定していない」は届ける事象ではない —— 省略を書いたすべての盤面に未設定 Provider の Confirmation
   が湧くのは、省略が普通の綴りであることと衝突する。

## 退けた案

- **展開時に資格情報も畳む** —— registry を盤面状態の写しにし、鍵を置く / 消すたびに registry refresh が要る。
- **省略を「`skills: []` かつ advisor なし」の agent 専用の綴りと明記する** —— 決定1 の目玉(隠れた既定が無いので必須を撤回)を、
  いちばん普通の agent が使えない綴りにする。
- **codex 経路を「v1 の制約」として省略から外す** —— skills を持たない agent まで openai から外れ、codex が skills を得た日に展開が黙って変わる。
- **不在も quarantine(openai の今の挙動に moonshot を揃える)** —— 上記のとおり未設定 Provider の question が全盤面に立つ。
- **不在を観測せず spawn 失敗のままにする** —— #559 が文面を直しても、鍵の無い Provider が選ばれ続けること自体は直らない。
- **宣言 entry には不在を当てず spawn 失敗に任せる(「明示したのだから失敗を見せる」)** —— 運用者に伝えるべきは「鍵が無い」で、
  skipped の理由で足りる。spawn 失敗は環境の一過性の失敗の領分に残す。

## 帰結

- ADR 0110 決定1 と ADR 0097 の Status 追記が言う「盤面が資格情報を持つ全 Provider」は、この ADR の決定1 の文言で読む。
- skipped の行に理由が無い問題は主題が別で、既に ADR 0102(行の cause タグ)と #398(痛みの観測待ち)が持つ。不在は cause が1つ増えるだけで、
  着手条件は変えない。anthropic 認証の盤面全体停止の書き手が dead code である件は #565 に切り出した。
