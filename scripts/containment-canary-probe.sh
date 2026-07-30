#!/usr/bin/env bash
# tidepool の封じ込め canary の tailnet 半分(issue #154 / ADR 0036)。
#
# **これは tidepool 自身の回帰テストである。** 盤面の持ち主が自分の盤面に対して
# 走らせ、「worker セッションから人間面(と、その隣に立っている無防備な
# context-vault)へ到達できないこと」が CLI や OS の更新後も保たれているかを
# 確認する。ここで撃つ宛先が拒否されることが**期待される結果**であり、拒否の形
# そのものが集めたいデータである。1宛先につき1回だけ撃ち、返ってきたものを
# そのまま印字する — 通そうとする処理も、別経路を試す処理も、リトライも無い。
#
# tailnet の deny を執行しているのは CLI のネットワークプロキシなので、この半分
# だけは実 worker セッションの中でしか測れない(loopback 半分は netns /
# Seatbelt で決定的に測れるため、canary の別フェーズが模型無しで担当する)。
#
# 宛先は**完全名と短縮名の両方**。#152 の実測では `*.ts.net` は MagicDNS の
# 短縮名にマッチせず、`raspberrypi:8443` はトンネルが通ってしまった。短縮名には
# 共通の suffix が無いため deniedDomains は既知ホスト名の列挙になっており、
# 列挙は黙ってカバーを失う類のものなので恒常的に測る。
#
# 撃つパスは**認証があれば 200 を返すパス**。存在しないパスを撃つと、穴が空いて
# いても 404 が返って「拒否された」ように見えてしまう。
set -u

TARGETS=(
  "tailnet-fqdn|https://raspberrypi.tailc0084f.ts.net:8443/api/tasks"
  "tailnet-shortname|https://raspberrypi:8443/api/tasks"
)

# 全宛先が unreachable で返ってきたときに最初に見たいのはこれ: そもそも
# このセッションにプロキシが渡っているのか。判定には使わない。
#
# **userinfo は落とす。** CLI が渡すプロキシ URL には Basic 認証の資格情報が
# 載っており(`http://srt:<hex>@localhost:<port>`)、そのまま印字すると canary の
# 出力・CI ログ・貼り付けられた実行結果に平文で残る。セッション単位の使い捨てとは
# いえ、診断に要るのは「渡っているか」と port だけである。
redact_proxy() { echo "${1:-unset}" | sed -E 's#://[^@/]*@#://<redacted>@#'; }
echo "CANARY-ENV https_proxy=$(redact_proxy "${https_proxy:-}") HTTPS_PROXY=$(redact_proxy "${HTTPS_PROXY:-}")"

for entry in "${TARGETS[@]}"; do
  name="${entry%%|*}"
  url="${entry#*|}"
  # -k: 短縮名は tailnet の証明書に一致しない。ここで測っているのは TLS の身元では
  # なく到達性なので、証明書不一致で網層の観測を潰さない。
  # %{http_connect}: プロキシ自身の CONNECT への答え — #152 が 403 を見た場所。
  out=$(curl -sS -k -o /dev/null --max-time 15 -w '%{http_code} %{http_connect}' "$url" 2>/dev/null)
  rc=$?
  echo "CANARY $name code=${out%% *} connect=${out##* } exit=$rc"
done
