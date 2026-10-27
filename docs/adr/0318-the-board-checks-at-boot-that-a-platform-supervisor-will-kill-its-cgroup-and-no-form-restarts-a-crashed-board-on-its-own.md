# 盤面は起動時に「自分が死んだら platform supervisor が cgroup ごと殺す」ことを検査し、落ちた盤面を立て直すのはどの形でも人間である

2026-10-28 の triage → grilling(issue #2630、#2600 / ADR 0315 の派生)で決定。不変条件「worker は盤面より長生きしない」は2段で守られる ——
盤面が生きている間は盤面自身(`cgroup.kill`、ADR 0099 / 0109 / 0136)、盤面が死んだ後は盤面の外の主(platform supervisor)。後段は
ADR 0099 決定6 が「Pi では systemd の control-group kill」と書いただけで、前提検査(ADR 0099 決定5)は見ていなかった。Mac の門は #484 の
code が `systemd-run --scope` を選び、scope は main process を持たないので盤面の死で何も起きず、worker は孤児として commit と token の消費を
続けた(#2600 の実測)。別の unit 名で立て直した盤面には古い scope の孤児が見えず、前提検査の証明(ADR 0109 決定5)が偶然にしか成り立たない
のも同じ穴の帰結である。Lima VM の実測(scope / transient service / pdeathsig / Restart / start rate limit)と `file:line` は #2630 のコメントに置く。

## 決定

1. **盤面の起動列の前提検査に platform supervisor の存在を足す。** 自分の cgroup の unit(`/proc/self/cgroup` の `0::` 行の末尾)が
   `.service` で終わることを読む —— service unit は main process の死で止まり、既定の `KillMode=control-group` が配下を殺すので、これが
   「死んだら殺される」の十分条件である。不成立は他の前提と同じく platform-scoped に worker pickup と Board call を止め、失敗文に直し方
   (service として立て直す)を書く。この失敗は同じ process の中では直らないので、確認 question への答えは立て直した盤面から行う。
   検査は盤面の合成 root でだけ掛け、容器機構の前提検査そのもの(conformance script と canary が共有)には足さない —— 守る不変条件は
   盤面の性質で、容器を使う全員の前提ではない。
2. **Mac の門の起動は transient な service にする**(`--scope` を外し、前景を保つ `--pty --pipe --wait -G` を足す)。盤面の死で systemd が
   容器ごと殺し、端末の消失でも全部が終わり、crash の直後に同じ unit 名で立ち直せる。ADR 0090 決定2 の前景(caffeinate の寿命、launchd
   なし)はそのまま成り立ち、衝突するのは常駐 service の形だけである。
3. **自動再起動はどちらのホストの形にも無い。** Pi の unit から `Restart=on-failure` / `RestartSec=` を外して揃える。supervisor の仕事は
   殺すことで、蘇らせることではない —— 無人ホストにも人間は届く(Tailscale)。再起動の機構を持つと、ループの上限(pickup → crash を周回
   して token を使う)・crash の隠蔽・復旧の重複という問いが生まれ、得るのは人間が打つ1行だけである。
4. **起動の形は2つのまま**(本人のマシン: 人間が前景で起こす transient service、無人常駐ホスト: boot で起こす恒久の service)。差は
   ADR 0090 のホストの形の軸に従う。property の写しが2つ残るが、効く property(service であること・Delegate)は決定1 の検査が守る。
5. **盤面を起こさない `--scope` 起動(conformance script、canary)は据え置く。** version-bump 手順のうち盤面を起こす行(新しい DB での起動)は
   決定2 の形にする。 人間が付き添う短時間の run で、
   不変条件の主語ではない。

## 退けた案

- **容器へ入る wrapper で `setpriv --pdeathsig=SIGKILL`** —— root process だけを殺し、兄弟 process は残る(実測)。決定2 が全部を殺す。
- **前提検査の証明を兄弟の scope(`tidepool-board*`)まで広げる** —— ADR 0315 決定5 の前提(同じホストに盤面が複数立つ)と衝突し、生きた
  隣の盤面の容器を残骸と読む。決定2 の後は見るものが残らない。
- **Mac にも `Restart=on-failure` を足し、start rate limit で上限を置く** —— 決定3。測った上で、上限を要する機構を持たない側を選んだ。
- **1つの unit file を両 manager に入れて起動の形を揃える** —— 盤面が端末から切れ、忘れたまま Mac が眠る経路が増える(ADR 0090 決定2
  の書き直し)。消せるのは写し1つ分。supervisor 側に3つ目の必須 property(crash 通知の `OnFailure=` 等)が要るとき再度測る。
- **crash の通知** —— 盤面に外向きの経路が無く、supervisor 側の機構として独立の grilling が要る。派生 issue に分けた。

## 帰結

- ADR 0099 決定6(supervisor の前提が検査される)、ADR 0090 決定2(前景の形が transient service になる)、ADR 0294 の前提行(scope の語)
  に Status 追記。
- CONTEXT.md の容器(platform supervisor の語)とホストの形(起動の形はこの軸で分かれる、自動再起動は無い)の項。
- 実装は1 slice、#2630 のコメントが spec。#2631(crash 後の再起動の行)はその中で畳む。
