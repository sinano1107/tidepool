# 長期 token の盤面では Claude の使用量を観測不能のままにし、門の盤面は VM 内 `/login` を保つ

2026-10-15 の triage / grilling(issue #2003)で決定。長期 token(`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`)の
盤面では、Claude の使用量が毎回観測不能になり、Claude の task が流れない。長期 token は `user:inference` しか持たない
(CLI の debug log が明記し、profile 権限を要る呼び出しは 403 で飛ばされる)。`/usage` は保存値(seed)を描いてから
refresh し、その後で窓の行を消す。通常ログインの CLI は同じ画面のために `GET /api/oauth/usage` を呼んで 200 を得るが、
長期 token では呼び出しの記録自体が無く、403 で断られるのか CLI が呼ばないのかは見ていない。OS にも CLI の版
(2.1.286 / 2.1.300)にもよらない。
ADR 0070 の実測「有効な setup-token でも % パネルは出る」(2.1.228)は、今は成り立たない。実測は #2003 にある。

## 決定

1. **門の盤面(#1879)の認証は ADR 0100 決定3 のまま、VM 内 `/login` とする。** sweep の複製元ではない、別名の VM で動かす
   —— clone した VM ではログインが切れ続けた(2026-10-09)。clone が refresh token を共有するためと見ている(未実測、
   docs/agents/machine-setup.md)。`/login` の期限と、無人の端末でログインし直させられる報告は残る。それでも、失効は 401 の機械判定で question として届く(ADR 0077)。
2. **長期 token の盤面では、anthropic の使用量は観測不能(fail-closed)のまま、読み取りの手段を足さない。** 該当するのは Pi と
   テスト用の VM で、どちらも門の外にある。足すときの手段は、最小の `claude -p` が stream に流す `rate_limit_event` の窓
   (`unifiedWindows`)を読む probe である。長期 token でも session / week の使用率と reset 時刻が返ることは確かめてある。
   必要になる場面(VM を増やす並列、分散した複数の盤面)が来たら足す。
3. **門の盤面の VM を作ったら、最初の pickup で使用量が読めるかを確かめる。** 読めなければ、置き換えではなく使用量の記録の欠陥として扱う。

## 退けた案

- **消える前の seed を読む** —— ADR 0078 が退けた「端末ローカルの保存値を真値の顔で読む」そのもの。
- **盤面が `/api/oauth/usage` や `/v1/messages` を直接叩く** —— 前者は長期 token では使えない見込み(通常ログインの CLI だけが呼び、200 を得ている)。後者はサブスクの token を CLI の外のクライアントで使い、vendor の `quota_check` を写す。
- **profile 権限つきの refresh token を env で渡す**(`CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES`)
  —— refresh token の取得手段が文書に無い。交換すると元のログインの token が回転し、結局は回転するログインと同じものになる。
- **門の盤面も長期 token にし、決定2 の probe を足す** —— 1回あたり約390トークン(年に約500万トークン、worker の約0.3%)を
  払い続ける。ログインなら使用量は0トークンで読める(`claude -p "/usage"` は model を呼ばない、#2010)。トークンの消費を避けることを選んだ。
- **worker の stream に流れる `rate_limit_event` を使い回す** —— session の頭で1〜2回しか流れず、worker 自身の消費を含まない。

## 帰結

- ADR 0028 の退けた案「`-p /usage` は % を含まない」は、今の CLI(ログイン時)では成り立たない。置き換えは #2010 で扱う。
- 長期 token の盤面で Claude の task が流れないのは、仕様である。CONTEXT.md の資格情報の出どころの項に記す。
