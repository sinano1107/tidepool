# worker のネットワーク到達は「操作 = 完全閉鎖 / 読取 = 監査つき受容」の二段で封じる

**Status: superseded by [ADR 0036](0036-human-surface-is-guarded-by-a-credential.md)(2026-07-29)。** 本 ADR が「実機実験で確定する変数」に挙げた3点を実測した結果、**主機構(サンドボックスのネットワークフィルタ)・極性((ii) 既定 deny → (i) deny-list のフォールバック)・二段構造(操作と読取の分割)のすべてが置き換わった** — macOS には loopback 宛の deny を表現する語彙が無く、Linux は netns により極性 (ii) を追加設定ゼロで既に満たしていた。執行は人間面の credential に移り、不変条件は一段(読取も閉鎖)に戻っている。以下の本文は**当時の決定のまま**で、今の設計ではない。読む価値が残るのは、宛先で不変条件を定義するという枠組みと、末尾の却下オプション一覧である。ただし**却下理由がそのまま生き残っているわけではない** — 特に「OS レイヤ(netns / pf / nftables)で塞ぐ」の却下理由「netns は macOS に無く dev/prod 乖離原則に正面衝突」は実測が逆を示した。Linux backend は `bwrap --unshare-net` の**本物の netns** であり、本番 Pi の不変条件を追加設定ゼロで支えているのはそれである(ADR 0036 の canary 節はこの事実に依存している)。生き残るのはより狭い主張だけ — **tidepool が自前で netns 層を足す手は採らない**(macOS に無く、ハーネスが既に与えている)。pf / nftables(ops コスト倍・同一 UID で主語を書き分けられない)と WebFetch 丸ごと deny(道具の性格に合わない)の却下理由は ADR 0036 の下でも有効である。

issue #140 の grilling(2026-07-28)で決定。管理MCP(ADR 0032)が別 issue に切り出した「worker が Bash で localhost の人間用 /api を叩ける柔らかい穴」の封じ方。post-v1 の hardening で、実装は #60(ADR 0033 の fs サンドボックス)の後続。

**不変条件は経路ではなく宛先で定義する** — 「worker セッションからは、ツール・経路を問わず人間面(WebUI / /api / 管理MCP)に到達できない」。issue が名指しした `curl 127.0.0.1:<human port>` は経路の一つにすぎず、同じ宛先への別経路が少なくとも二つある: tailnet 側アドレス経由(tailscale serve が人間面を tailnet に公開しているため、同一ホストの worker からも**別ホストの worker からも**届く — 開発機の worker → Pi 本番の人間面というクロスホスト版を含む)と、WebFetch ツール経由(Bash サンドボックスの外にあるハーネスのツール)。経路単位で塞ぐと残りが「次の柔らかい穴」として issue を増やし続けるため、宛先で切る。

**執行の主機構はハーネス内蔵サンドボックスのネットワークフィルタ**(ADR 0033 と同じ機構の別の面)。Bash 発の到達は loopback / tailnet を問わず単一のフィルタ点を通るため一様に塞げ、macOS(開発機)と Pi(本番)の両方で動く唯一の候補。netns は macOS に存在せず、pf + nftables の二本立ては ops コストが倍なうえ worker が board と同一 UID で走るためルールの主語を書き分けられない。人間面の unix socket 退避は tailnet 経由を塞げず単独では不変条件を満たせない(A 成立後の多層化としてなら将来可)。

**フィルタの極性: 目標は loopback 既定 deny + allowlist = Worker MCP ポートのみ**。列挙不能で最強だが、worker が自前のサーバーを loopback に立てて叩くのは正当な作業(npm test / webui-e2e が in-process でサーバーを起動する)なので、サンドボックスが worker に専用ネットワーク名前空間相当(sandbox 内 loopback がホストの loopback と別世界)を与えるプラットフォームでのみ成立する。取れないプラットフォームは狭い deny-list(自ホスト宛の各表記 × 人間ポート)にフォールバック。dev/prod は両方常時有効で強度のみの差を許容し、共通の底は e2e canary(人間ポートへの curl が両 OS で拒否されること)で張る — ADR 0033 の乖離原則が禁じるのは「片方だけ裸」。どちらの極性でも **tailscale CGNAT 帯 100.64.0.0/10 は全帯 deny** — worker の正当作業に tailnet 内の他ノードへの用は現状ひとつも無く(deploy は人間の skill 経由)、クロスホストの人間面も列挙なしで閉じる。将来 worker に tailnet 内の何かが必要になったら allowlist で個別に開ける(入口既定閉・opt-in、skill 許可リストと同じ意味論)。

**WebFetch は封じず、不変条件の方を二段に割る**。WebFetch はどの agent もタスク次第で第一級に必要になる道具(リサーチ用途)であり、丸ごと deny も agent 単位 opt-in も道具の性格に合わない。ドメインパターン deny は loopback /8 の別アドレス・10進 IP 表記・公開 URL からの 302 リダイレクト(古典的 SSRF)で迂回でき、issue #59 で整理した「列挙漏れの最後の砦が OS」がここでは**砦なし**になるため、防御に数えない(気休めに足すのは可、勘定はゼロ)。代わりに:

- **操作(状態変更)への到達は完全閉鎖** — Bash 経由はフィルタ点で塞ぎ、WebFetch 経由は GET-only という構造で不可能。issue の本丸(人間名義の question 回答・cancel・registry 直接コミット)はここで守り切る。
- **読取への到達は監査つき受容** — WebFetch で人間面を GET できる残余は「到達しうるが stream-json 監査に残る」という v1 と同じ線。前提として**人間面の GET エンドポイントは無変異**をコードの不変条件に格上げする。2026-07-28 時点で全 GET ルートは純読取(未読カーソル前進は POST /log/cursor、Displayed 発行は POST /triage/displayed に分離済み — ADR 0032 の「観測は WebUI だけが記録できる」設計が変異を POST に寄せる形で既に守っている)ことを確認済み。実装時にテストで釘を打つ。

**運用の生涯は ADR 0033 に全部相乗りする**: 対象は全 worker セッション(work / review 両プロファイル、self RCA 含む — fs と違いネットワークの deny 内容にプロファイル差をつける理由が無い)、fail-closed(フィルタ不成立なら pickup 停止 + Tidepool 名義の確認型 question、検証つき解除)、起動時 + pickup 時の能力検査とデプロイ / CLI 更新時の e2e canary に項目を足すだけで、新しい生涯管理は作らない。この相乗りにより実装順序が確定する: **#60 が先、本 issue はその器に乗る後続**。

実機実験で確定する変数(ADR 0033 と同じ進め方): サンドボックスのネットワークフィルタが宛先 host:port 単位の deny を表現できるか、netns 相当の意味論が取れるか(極性 (ii) → (i) フォールバックの分岐)、WebFetch が private / loopback アドレスや 302 リダイレクトを自前で拒否するか。WebFetch が自前拒否するなら読取残余ごと消え、canary に1本足すだけになる。

Considered options:

- **不変条件を経路(localhost curl)で定義する** — tailnet 経由と WebFetch 経由が「次の柔らかい穴」として残り、issue を経路の数だけ切り続けることになる。
- **WebFetch を worker から丸ごと deny / agent 単位 opt-in** — リサーチ用途でどの agent にも第一級に必要な道具であり、道具の性格に合わない。
- **WebFetch のドメインパターン deny を防御の主柱にする** — 列挙迂回(loopback /8、10進 IP 表記、302 リダイレクト)に対して OS の砦なしで立つことになり、#59 の教訓に反する。
- **OS レイヤ(netns / pf / nftables)で塞ぐ** — netns は macOS に無く dev/prod 乖離原則に正面衝突。ファイアウォール二本立ては ops コスト倍 + 同一 UID で主語を書き分けられない。
- **人間面の unix socket / 別インターフェース退避** — tailnet 経由の到達を塞げず単独では不変条件を満たせない。tailscale serve の proxy 先制約の検証も必要。多層化としてなら将来候補。
- **自ホスト宛だけ deny(tailnet 帯は開けたまま)** — 開発機の worker → Pi 本番の人間面というクロスホスト穴が残る。全帯 deny で失う正当作業は現状無い。
