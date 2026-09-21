# Codex preflight は spawn の設定を app-server に strict で読ませ、綴りの誤りで route を閉じる

2026-09-21 の grilling(issue #727)で決定。ADR 0129 決定4 は parse の fail-closed を `--strict-config` に預けたが、それは spawn の引数にしか無かった。preflight の probe が渡す設定は spawn の一部(閉じた面と skill)だけで、`codex features list` / `codex debug prompt-input` は `--strict-config` を受けない。盤面が spawn に渡す設定のキーを綴り誤ると、封じ込め能力は `available: true` を返し、spawn が task ごとに config error で落ちる。#731(ADR 0130 決定3)以降 preflight が呼んでいる `codex app-server` は `--strict-config` を受け、spawn の設定を全量渡しても起動し、未知キーは exec と同じ文面で拒否する。実測の逐語は issue #727 のコメントに置く。

## 決定

1. **parse の fail-closed を preflight でも効かせる。** 綴りの誤りは task ごとの失敗としてではなく、Codex route が理由付きで閉じる形で出る。照合者は pin した CLI の parser であり、盤面を盤面と照合するのではない —— ADR 0125 決定1 / ADR 0141 が消した declared-vs-declared には当たらない。
2. **probe が渡す設定は spawn と同じ1つの組み立てから作る。** task に固有の入力(developer instructions の文面、MCP URL、effort、`enabled_tools`)は引数にし、probe は形の正しい placeholder を渡す。問うのは parse(キーの綴りと値の型)であって値の意味ではない。写しで持つと、次に spawn へ足したキーで同じ隙間が開く。
3. **検査するのは work と review の2種別。** permission の設定はこの2つでキーの木が違う。memory meta-review は値が違うだけで parse の問いは work と同じ。
4. **既存の `hooks/list` の呼び出しが work 種別の spawn 設定を `--strict-config` で持ち、review 種別は initialize だけの呼び出しを1本足す。** preflight は pickup ごとに走るので、起動は1回だけ増やす。hook の登録も実際の spawn 設定の下で観測することになる。
5. **拒否は throw として `could not run` に倒し、表に行を足さない。** 受理か拒否かの1ビットで、宣言と観測を突き合わせない —— ADR 0141 決定1 の canary と同じ理由。理由文には CLI の stderr が載り、どのキーかを名指す。「could not run」の言い回しの粗さは #710 と同じ種類の問題として広げない。

## 退けた案

- **preflight は変えず、spawn 失敗後の task の行き先だけ直す** —— 綴り1つで pickup ごとに task が failure question に変わり続ける。行き先そのものの欠陥(時間制限まで待って偽の文面が立つ)は別の主語として #805 に切り出した。
- **`codex exec` の空走行を probe にする** —— 設定が正しければ推論リクエストまで進み、モデル呼び出し無しには成立しない。
- **probe に不足キーを列挙して足す** —— 決定2 の写しの問題そのもの。
- **mismatch 表に `config` 行を足す** —— 決定5。
