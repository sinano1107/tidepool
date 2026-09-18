# Codex の login 証拠は account/read の account と rateLimits/read の 401 であり、requiresOpenaiAuth は provider の性質で login を語らない

2026-09-17 の grilling(issue #706)で決定。Codex の使用量 probe(`codex app-server` stdio、ADR 0098 / 0116)は
`requiresOpenaiAuth: true` を「ログインしていない」と読み、`account` と同時に立てば矛盾として観測不能に倒していた。
Lima VM の実測と `rust-v0.147.0` の app-server source で、この欄は `config.model_provider.requires_openai_auth`
—— **設定中の model provider が OpenAI 認証を要する provider か**という provider の性質 —— で、login の有無に
かかわらず ChatGPT 認証では常に `true` と分かった。導入 commit の pin も同じ 0.147.0 なので、vendor の drift ではなく
盤面の最初からの読み違いである。さらに、token が壊れた auth.json では `account/read` は file の account をそのまま
返し、`account/rateLimits/read` が HTTP 401 の JSON-RPC error を返す —— 失効の証拠は `id:3` にしか無く、盤面は
error 行を id を問わず throw していたので、ADR 0116 決定4 の「失効 → quarantine」分岐は到達不能だった。
併せて見つかった、stdin を即 EOF するせいで応答が返らない件は bug で、ここでは決めない。実測の逐語と `file:line`
は #706 のコメントに置く。

## 決定

1. **login 証拠は2つ: `account/read` の `account` が `null`、または `account/rateLimits/read` が HTTP 401 で拒否されたこと。**
   どちらかで `unauthorized`(quarantine)。`requiresOpenaiAuth` は login の判定に使わず、`false`(OpenAI 以外の
   provider が `CODEX_HOME` に設定されている)だけを観測不能の理由として読む —— 盤面は ChatGPT 認証を前提にしており、
   それ以外の構成は想定外として fail-closed に倒す。
2. **error 行は id ごとに読む。** `initialize` / `account/read` の error は観測不能、`account/rateLimits/read` の error は
   401 なら失効、それ以外(network 断など)は観測不能。401 は error message の文字列で見る —— vendor の error code は
   fetch 失敗をすべて `-32603` に畳むので他に手掛かりが無い。照合が外れる方向は観測不能(question 無し・pickup 除外)で、
   人間を呼ぶ側には倒れない(CONTEXT.md「識別基準の確度が、人間を呼び出す例外の広さを縛る」)。

## 退けた案

- **`account === null` だけを失効とする** —— 壊れた token でも account は返るので、失効を一度も捕まえない。
- **`rateLimits/read` の error をすべて失効とする** —— network 断で quarantine の question が立つ。
- **`requiresOpenaiAuth` を schema から外す** —— `false` は盤面の前提外の構成を示す唯一の信号なので、読む価値は残る。
