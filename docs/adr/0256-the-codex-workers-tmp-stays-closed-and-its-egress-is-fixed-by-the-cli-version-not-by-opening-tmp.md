# Codex worker の /tmp は閉じたまま、外への到達は CLI の版で直す —— 0.151.0 未満では両立しない

2026-10-14 の grilling(issue #794)で決定。ADR 0072 決定6 は tidepool の workspace に `registry.npmjs.org` を開け、#763 はそれを
Codex worker の permission profile に渡した。ところが Lima VM で実測すると、codex 0.147.0 の Codex worker は許可ドメインを含めて
外へ一切つながらなかった。profile の `:slash_tmp` の deny が `/tmp` を空の tmpfs で覆い、CLI が `/tmp` の下に置く proxy の中継
socket まで隠すので、どの宛先もリセットされる。封じ込めは閉じる向きにだけ崩れていた。上流は 0.151.0 で中継をファイルを使わない
形に替えていて、0.151.0〜0.162.1 では deny のまま許可ドメインが届き、リスト外は 403、`/tmp` は拒否のまま、と測れた。計測の表・
版ごとの二分探索・vendor source の読みは #794 のコメントに置く。

## 決定

1. **`:slash_tmp` の deny は残す。** この行の理由はこれまで記録が無かった(#195 の spike が挙げた最小形の名残)。ここで記録する
   理由は、並走するすべての Codex worker の task temp が `/tmp` の下にあり、profile が開け直すのは自分の task temp だけだという
   ことである。`/tmp` を読み(や書き)に開けると、worker は他の task の作業物、つまり別の workspace の内容を読める(や書ける)。
   ADR 0072 決定3 が持ち出しの受容を workspace 単位に置いた以上、別の workspace の内容が届く経路は開けない。
2. **外への到達は CLI の版で直す。Codex の pin の下限は 0.151.0。** 版上げは手順書と適合試験(#1385)を通し、#696 で行う。
   それまで Codex の経路は外へ出られない。門 #1879 は Codex worker を門の時点から走らせるので、この版上げを待つ。
3. **Codex の版上げの適合試験に、到達の2行を置く。** 許可ドメインへ届くことと、リスト外が 403 `blocked-by-allowlist` で閉じる
   ことで、ADR 0072 決定5 が Claude 側に置いた許可ドメインの canary と、その control(設定が黙って捨てられていないこと)
   と同じ形である。今回の全滅は版で起きて版で直った。封じ込めの preflight は
   到達を測らない(#1945)ので、今の preflight の行では見えない。dot 無しのホスト名とワイルドカードは #794 で一度測り終えたので、
   行にしない。

## 退けた案

- **0.147.0 のまま `:slash_tmp` を外す、または read にする** —— 決定1 が守るものを手放す。preflight の canary(`/tmp` が読めたら
  quarantine)と、その固定のテストも一緒に崩すことになる。
- **0.147.0 のまま、短い `TMPDIR`(17 バイト以下)で中継 socket を `/tmp` の外へ逃がす** —— 0.151.0 で上流ごと消えた内部の分岐に
  頼る。worker の `TMPDIR` は task temp(長い)なので、worker の環境まで替えることになる。版を上げた時点で意味がなくなる。

Claude worker の側は `/tmp` の読みを閉じておらず、決定1 と食い違っていた(#1950 で実測)。読みの範囲ごと既定拒否に揃えた(ADR 0257)。
