# 本人の Mac 上の盤面は Linux VM の中で動き、ホストの形と platform は直交する

2026-08-25 の grilling(issue #473)で決定。#465 で macOS の worker 容器候補(process group)が contract suite を
通らず、ADR 0099 決定5 により macOS 上の盤面は worker pickup が止まったままになった。ADR 0090 と
`docs/mac-first-boot.md` は Mac 上で worker が走ることを前提にしており、友人テスト(#367)は各自の Mac が前提で
ある。実測の表と手順は issue #476 に置く。

## 決定

1. **ホストの形と platform は直交する。** ホストの形(本人のマシン / 無人常駐ホスト)は動力の認証の出どころを決める
   ADR 0090 の軸、platform(kernel)は worker 容器の機構前提を決める ADR 0099 決定5 の軸。0090 の「本人の Mac 上の
   盤面」は物理マシンの話であって macOS の話ではない — 0090 は「本人のマシン ⇒ macOS」を暗黙に前提していただけで、
   決定そのものは無傷。
2. **本人の Mac 上の盤面は、Mac 上の systemd を持つ Linux VM の中で動かす。** Linux の worker 容器(cgroup v2 +
   delegation)、fs サンドボックス(bubblewrap + socat、ADR 0033)、shutdown 時の回収(systemd の control-group kill、
   ADR 0099 決定6)を Pi と同じ形でそのまま使い、dev/prod parity はむしろ良くなる。ADR は機構の前提だけを決め、VM
   製品は手順書の側に置く — 前提が写っていれば製品は差し替え可能。最初の実測は Lima(OSS で、業務利用の license の
   問いが立たない)。
3. **VM 内の動力の認証は ambient 形のまま**(VM 内で本人が `/login`)。0090 決定1 の根拠「切れれば本人が次に CLI を
   使った瞬間に気づく」は、本人が日常使わない VM 内の CLI には成立しない。それでも setup-token を持ち込まないのは、
   cliAuth の検知(ADR 0077)が出どころを見ない 401 の機械判定で question を立てるため — 失効は CLI 経由ではなく盤面
   経由で本人に届く。同一アカウントで Mac 側 CLI と VM 側 CLI が並ぶことによる refresh 競合(#306 型)は実測項目。
4. **採用は実測が裁定者**(#465 と同じ形)。前提検査・contract suite・封じ込め能力・VM ネイティブディスク上の状態・
   refresh 競合・`caffeinate` の挙動を #476 で測り、通らなければ記録して止まる。fallback(友人ごとに Linux ホスト)
   はそのとき起票する — 今書いても測定結果で中身が変わる。
5. **ADR 0099 決定5 の contract suite の実行場所「macOS ローカル」は「Mac 上の VM」に写る。** platform ごとに一度 +
   CLI/OS 更新時という規則は不変で、再測定の契機に VM イメージ / VM 製品の更新が加わる。
6. **ネイティブ macOS の盤面は triage・Board call だけが動く盤面のまま。** 弱い回収を可視化つきで許す形は採らない
   (ADR 0099 決定5 / #465)。手順書は VM 版が着地するまで「現在の main では worker が走らない」と明記する。

## Considered options

- **Mac は worker を走らせない盤面として ADR 0090 を狭める** — 友人テストの目的(自分の Mac で初回タスク完走)が
  成立しない。実測が通らなかったときの姿ではあるが、選ぶ理由が無い。
- **Docker container の中で盤面を動かす** — systemd が無く、bubblewrap の user namespace も測った形から離れる。不可
  とは主張せず、推奨しない候補として #476 に並べる。
- **OrbStack を手順書の既定にする** — 個人利用のみ無料で業務利用は有償。友人は仕事仲間なので線を跨ぐ。
- **VM を無人ホスト扱いにして setup-token** — 決定3。1年で黙って切れる形を本人のマシンに持ち込むだけ。
