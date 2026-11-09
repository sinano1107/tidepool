# workspace の Claude settings は記録の中で人間しか書けない path であり、完了の門は fork 元と entry が違う tip を harness に依らず拒む

**Status 追記: 決定3 の列は2 path ではなく形で決まる —— 人間の Claude CLI(2.1.319)は cwd を基点に読む。人間しか書けない形は、basename が `.claude/settings.json` / `.claude/settings.local.json` / `.mcp.json` の path(深さを問わない)と、tree でない `.claude` entry(深さを問わない —— symlink の `.claude` は先の `settings.json` を読ませ、先の path は basename に当たらない)。完了の門は決定2 の比較をこの集合で行い、集合は1つの関数が持つ。`.mcp.json` が軸に乗る理由: `-p` は trust も承認も問わず project server を起動し、対話の承認は server の名前で`settings.local.json` の `enabledMcpjsonServers` に記録されるので、承認済みの名前の command を変えると問わずに起動する。`settings*.json` は cwd の `.claude` だけが読まれ、root のものは subdir の cwd では読まれない。射程の境界に1行足す: 人間が以前に commit した symlink の先の中身を worker が変える形は path の比較に見えず、`scripts/*` と同じ線で review の仕事。盤面の pin(2.1.286)と git root より上の祖先は未測定。実測の表は #3107 のコメント(2026-11-09、issue #3107)。**

2026-11-09 の grilling(issue #3078、ADR 0360 の派生)で決定。worker が task branch の `.claude/settings.json` / `settings.local.json` を変えると、
盤面はそれをどの process にも読ませない(worker は sparse で隠し、Board call は neutral cwd、面接室も隠す)まま merge back → PR → 無人 merge で
保護ブランチへ運び、読むのは pull した人間の Claude CLI だけである —— `apiKeyHelper` / `env` / hooks は起動時に人間の資格情報で効く
(ADR 0346 の実測と同じ読み口)。同じ事象が Harness で割れていた: Claude worker は書けない(ADR 0037 機構2 —— 理由は自分の session の
hot reload)が plumbing で記録に乗せられ、Codex worker は普通に書けて test が「view が見る」を釘にしていた。Codex が書いてよいと決めた ADR は無く、
ADR 0037 の「書けても検出する」は ADR 0346 で退役している。既存の決定(0346 / 0354 / 0360)は全部「checkout から worker に何が届くか」の
持ち主で、「記録の中で人間しか書けない path はどれか」は持ち主が居なかった。実測の表と `file:line` は #3078 のコメントに置く。

## 決定

1. **worker は workspace の Claude settings の書き手になれない。** 記録の中で `.claude/settings.json` と `.claude/settings.local.json` は
   人間しか書けない path であり、これは記録の軸の決定で Harness に依らない。読み側の「盤面はこの file を1鍵も届けない」(ADR 0346 決定1)と対。
   ADR 0037 機構2 は worker 自身の session を守る理由だけになる(Status 追記)。
2. **完了の門は、tip の2 path の entry(mode と blob、在る↔無いを含む)が fork 元との merge-base と違えば path を名指して拒む**
   (ADR 0360 決定4 と同じ「直して commit し直せ」の型)。fork 元はタスクブランチを切った sha と同じ出所 —— 子は親の work branch、根は保護
   ブランチ、受験者は出題の head(ADR 0276 決定1)。出所は1つの関数が持ち、作成と門が同じものを読む。各段は自分の delta にだけ答え、
   親が仕込んだ変更は親自身の門が見る。spawn 時の停止(ADR 0360 決定3 の形)は足さない ——
   内容は子に隠れていて届かない。
3. **人間しか書けない path はこの2つだけ。** 軸は「人間が repo を使わなくても、CLI を起動した時点で実行される」。`.claude/agents/*.md`
   (trust 済み checkout で frontmatter `hooks:` が host で走る、#2936)・skills・commands・CLAUDE.md は人間の model が選んだときに効く
   repo 内容で、tidepool 自身の task が正当に編集する(帰責が skill に落ちた修理子を含む)ので review の主題のまま。列挙は Claude CLI の
   読みで、`.mcp.json` の人間側と、人間の Codex が tracked な `.codex/` を読むかは未測定で派生 issue。

## 退けた形

- **保護ブランチと比べる**(triage の推奨)—— 親が commit した変更で子が拒まれ、子には直せない。
- **Codex の sandbox に書き込み拒否を写す** —— 床は門が持つ。nested `read` が存在しない file に効くかは未測定で、測る派生 issue。
- **landing で人間に見せる** —— `auto_if_ci_green` は人間の目を通さない(ADR 0037 退けた形 (b))。
- **#3078 を review の主題として閉じる** —— 読み側だけ決まり書き側が空いた非対称を残す。

## 射程の境界

人間の tracked hooks が参照する先(tidepool 自身なら `scripts/*`)を worker が普通の code として書く経路は塞がない。ADR 0037 測定4 と同じ線
で、塞ぐなら repo 内容全部になる —— それは review と merge ダイヤル(人間が選んだ「worker の code が人間の目を通らず着地する」範囲)の仕事。

## 派生

- Status 追記: ADR 0037(機構2 の理由)、ADR 0360(派生の行)。GLOSSARY.md: 完了の門、task の checkout。
- 派生 issue: Codex の nested `read` の実測(#3106、low)、`.mcp.json` の人間側の承認の実測(#3107)と人間の Codex の `.codex/` の読みの実測(#3108)—— どちらも疑いのまま high。
- 実装は1 slice、#3078 のコメントが spec。
