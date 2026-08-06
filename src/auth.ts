import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Request, Response } from "express";
import { type RequestHandler, Router, urlencoded } from "express";

/** ADR 0036 / issue #153: 人間面(静的資産・`/api`・そこに mount される管理MCP)
 *  は単一の盤面秘密で守られる。worker からの到達をネットワーク層で塞ぐ設計が
 *  macOS で成立しなかったため、執行はアプリ層のこの1枚に移った — ホスト・
 *  プラットフォーム・経路(loopback / tailnet / WebFetch)のいずれも問わない。
 *
 *  **Worker MCP(`mcpApp`、別ポート)はここで守らない。** 掛けると全 worker が
 *  死ぬ。あちらのアクセス制御は `?task=` + slot + サーバー側 authority のまま。 */

/** ブラウザが持ち回る cookie の名前。道具は Authorization: Bearer で提示する。 */
export const AUTH_COOKIE = "tidepool_auth";

/** bootstrap(cookie を張ってボードへ送り出す)エンドポイント。無認証で通る
 *  唯一のパス — ここが閉じていると新しい端末が永久に入れない。 */
export const BOOTSTRAP_PATH = "/auth";

/** cookie の寿命。ブラウザ側の上限が 400 日なので、実質「切れない」の最大値。
 *  失効の主経路は期限ではなくローテーション(盤面のハッシュが変わる)。 */
const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 新しい盤面秘密。base64url なので URL クエリにそのまま載る(bootstrap URL は
 *  メッセージアプリを経由して端末に届く)。 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** ハッシュの置き場所。**盤面ディレクトリには置かない**(#149 の罠: デプロイの
 *  rsync や git 管理下に秘密が紛れ込む)。盤面と `npm run token` の両方がこの
 *  1つの解決関数を通る — HOME が違う実行(sudo 越し等)で別ファイルに書いて
 *  「ローテーションしたのに通らない」になるのを防ぐ。 */
export function resolveTokenFile(configured: string | undefined): string {
  return configured ?? join(homedir(), ".tidepool", "api-token");
}

/** 盤面が持つのはハッシュだけ(ADR 0036)。平文はここでも process.env にも
 *  ディスクにも残らない — 呼び出し側がその場で表示して捨てる。
 *  戻り値は新しい平文 token。 */
export function rotateToken(tokenFile: string): string {
  const token = generateToken();
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, `${hashToken(token)}\n`, { mode: 0o600 });
  // writeFileSync の mode は**新規作成時にしか効かない**。ローテーションは既存
  // ファイルへの上書きなので、緩いパーミッションのまま引き継がないよう明示する。
  chmodSync(tokenFile, 0o600);
  return token;
}

/** 認証が立たない盤面がどうなるかの一文。3箇所の運用者向けメッセージで同じ姿を
 *  言う — インシデント中に「どっちだったか」を読み解かせないため。 */
const UNAUTHENTICATED_POSTURE =
  "the human surface is open to anyone who can reach it (ADR 0036 fail-open), and worker " +
  "pickup is halted board-wide until it is repaired. Run `npm run token` to issue a new one, " +
  "open the printed bootstrap URL, then answer the board's standing question.";

/** 保存済みハッシュ。読めない・空・hex 64 桁でない → undefined。
 *  呼び出し側はこれを「認証が成立していない」として扱う — 人間面は fail-open で
 *  開き、対になる封じ込め能力ゲート(containment.ts)が worker を1枚も走らせない
 *  ことで釣り合う(ADR 0036 / issue #154)。 */
export function readTokenHash(tokenFile: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(tokenFile, "utf8");
  } catch {
    return undefined;
  }
  const hash = raw.trim();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : undefined;
}

/** 1オリジンぶんの bootstrap URL。cookie はオリジン単位なので端末は入口ごとに
 *  1回ここを通る必要があり、公開 URL は盤面が自力で導出できない(ADR 0036)ため
 *  設定として渡される。 */
export function bootstrapUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}${BOOTSTRAP_PATH}?token=${encodeURIComponent(token)}`;
}

/** 平文の token を人間に見せる唯一の面(初回起動とローテーション)。盤面は
 *  ハッシュしか持たないので再表示はできない。 */
export function bootstrapNotice(input: {
  token: string;
  tokenFile: string;
  origins: string[];
  /** 既存の token を置き換えたか。初回起動 → false。 */
  rotated: boolean;
}): string {
  const lines = [
    "",
    input.rotated
      ? "tidepool: a new board token was issued — the previous one is now invalid."
      : "tidepool: a board token was issued for this board (issue #153 / ADR 0036).",
    "",
    `  token: ${input.token}`,
    `  hash stored in: ${input.tokenFile}`,
    "",
    "  The board stores only the hash, so this token cannot be shown again.",
    "",
    // cookie はオリジン単位・端末単位。全オリジンぶん出さないと、tailnet から
    // 開いた端末が入れないことに人間はデプロイ後まで気づかない
    "  Open one of these per origin, per device (each sets the cookie):",
    ...input.origins.map((origin) => `    ${bootstrapUrl(origin, input.token)}`),
  ];
  if (input.rotated) {
    lines.push(
      "",
      // 管理MCP は bearer ヘッダで認証するので、ローテーションはその設定を壊す
      "  The management MCP authenticates with this token as a bearer header, so",
      "  rotating it breaks the saved configuration. Re-register it:",
      "    claude mcp add --transport http tidepool <url> \\",
      `      --header "Authorization: Bearer ${input.token}"`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** 設定文字列(カンマ区切り)から公開オリジンを読む。既定の loopback は常に
 *  先頭に入る — Pi では tailnet オリジンと loopback の両方で bootstrap が要る。 */
export function resolvePublicOrigins(configured: string | undefined, port: number): string[] {
  const extra = (configured ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  return [`http://127.0.0.1:${port}`, ...extra];
}

export interface HumanCredential {
  /** **毎リクエスト読み直す。** `npm run token` のローテーションが盤面の再起動
   *  なしに効く(github-auth.ts の `token()` と同じ posture)。undefined →
   *  認証が成立していない。 */
  tokenHash: () => string | undefined;
}

/** 起動時の credential 解決。composition root(main.ts)がそのまま乗る形にして
 *  あるのは、「初回起動なら発行する / 壊れていたら発行しない」という分岐が
 *  main.ts に散ると誰にもテストされないため。印字は呼び出し側が行う。
 *
 *  **「無い」と「壊れている」は別の事故である。** 無い = 初回起動なので発行する
 *  が、これは既存の cookie と bearer を全部黙って殺す道でもある — ハッシュを
 *  失った盤面は、次の再起動の瞬間に全端末をログアウトさせる。壊れている側で
 *  発行し直さないのはそのため(読めないだけかもしれないファイルの上書きは、
 *  同じ結果を事故として起こす)。2026-07-30 の本番ドリルで実測: ファイルを退避
 *  して再起動すると fail-open のまま留まらず、新しい token が発行される。 */
export function openHumanCredential(input: { tokenFile: string; origins: string[] }): {
  credential: HumanCredential;
  messages: { level: "log" | "error"; text: string }[];
} {
  const { tokenFile, origins } = input;
  const messages: { level: "log" | "error"; text: string }[] = [];
  if (!existsSync(tokenFile)) {
    // 初回起動: その場で発行して表示する。以後、平文を得る手段はローテーション
    // (`npm run token`)だけになる。
    try {
      const token = rotateToken(tokenFile);
      messages.push({ level: "log", text: bootstrapNotice({ token, tokenFile, origins, rotated: false }) });
    } catch (err) {
      // 書けないなら認証は立たない。ただし**起動そのものは拒まない** — Pi で
      // 起動を拒むと ssh するしかなくなる(ADR 0036)。直したら `npm run token`。
      messages.push({
        level: "error",
        text: `[auth] could not issue a board token at ${tokenFile} (${String(err)}) — ${UNAUTHENTICATED_POSTURE}`,
      });
    }
  } else if (readTokenHash(tokenFile) === undefined) {
    // **発行し直さない。** 読めないだけかもしれないファイルを上書きすると、
    // 生きている端末の cookie を黙って捨てることになる。
    messages.push({
      level: "error",
      text: `[auth] the token hash at ${tokenFile} is unusable — ${UNAUTHENTICATED_POSTURE}`,
    });
  }
  let warned = false;
  return {
    credential: {
      tokenHash: () => {
        const hash = readTokenHash(tokenFile);
        if (hash === undefined && !warned) {
          console.error(`[auth] no usable token hash at ${tokenFile} — ${UNAUTHENTICATED_POSTURE}`);
          warned = true;
        }
        if (hash !== undefined) warned = false;
        return hash;
      },
    },
    messages,
  };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== "") jar[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return jar;
}

/** 提示された credential の候補。ブラウザ(cookie)と道具(bearer)の両方を
 *  受ける — 静的資産まで守る以上、ヘッダ一本は選べない(ブラウザのトップレベル
 *  遷移にヘッダは付けられない)。 */
function presentedTokens(headers: {
  authorization?: string;
  cookie?: string;
}): string[] {
  const tokens: string[] = [];
  const authorization = headers.authorization;
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    tokens.push(authorization.slice("bearer ".length).trim());
  }
  const fromCookie = parseCookies(headers.cookie)[AUTH_COOKIE];
  if (fromCookie !== undefined) tokens.push(fromCookie);
  return tokens;
}

/** ハッシュどうしの定数時間比較。長さ不一致で `timingSafeEqual` が投げるので、
 *  両方 sha256 の hex(常に同じ長さ)であることを先に確かめる。 */
function matches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isAuthorized(
  headers: { authorization?: string; cookie?: string },
  credential: HumanCredential,
): boolean {
  const expected = credential.tokenHash();
  // ADR 0036 の fail-open(issue #154 でゲートと対になって初めて成立した): 使える
  // ハッシュを1つも持たない盤面は人間面を**開ける**。**人間面は fail-open、
  // pickup ゲートは fail-closed** — この非対称は意図的であり、「揃える」ために
  // どちらかを反転させてはいけない。認証が立たない盤面では封じ込め能力の自己検査
  // (containment.ts)が不成立になって worker が1枚も走らないので、開いた面に
  // 対する敵が存在せず、開いていること自体が「question を読んで直す」という人間の
  // 復旧経路になる。Pi で起動ごと拒むと ssh するしか手が無くなる。
  if (expected === undefined) return true;
  return presentedTokens(headers).some((token) => matches(token, expected));
}

/** インストール済み PWA にはアドレスバーが無く、「この URL を開いてください」
 *  では端末が復旧できない(ADR 0036)。だから 401 の HTML は token 入力欄を持つ。
 *  このページは盤面の状態を一切持たないので無認証で返してよい。
 *  **完全自己完結**にする — `/styles.css` も `/_ds_bundle.js` も守る対象なので、
 *  外部参照すると全部 401 して無スタイルのページになる。 */
function loginPage(message?: string): string {
  const notice =
    message === undefined
      ? ""
      : `<p class="notice">${message.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</p>`;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>tidepool</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; min-height: 100vh; background: #f4f9f7; color: #2b3a37;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  main { width: 100%; max-width: 360px; }
  h1 { font-family: Georgia, "Times New Roman", serif; font-style: italic; font-weight: 400;
       color: #14504d; font-size: 32px; margin: 0 0 8px; }
  p { font-size: 14px; line-height: 1.6; margin: 0 0 20px; color: #4a5c58; }
  p.notice { color: #a4453a; }
  form { display: flex; flex-direction: column; gap: 12px; }
  input {
    font: inherit; font-size: 16px; padding: 12px 14px; border-radius: 10px;
    border: 1px solid #cadedb; background: #fff; color: inherit;
  }
  input:focus { outline: none; box-shadow: 0 0 0 3px rgba(29,106,102,0.35); }
  button {
    font: inherit; font-size: 15px; padding: 12px 14px; border: 0; border-radius: 999px;
    background: #1d6a66; color: #fff; box-shadow: 0 2px 8px rgba(29,106,102,0.3);
  }
  button:active { background: #14504d; }
</style>
</head><body>
<main>
  <h1>tidepool</h1>
  ${notice}
  <p>This board needs a token. Run <code>npm run token</code> on the board to issue one.</p>
  <form method="POST" action="${BOOTSTRAP_PATH}">
    <input type="password" name="token" autocomplete="off" autocapitalize="off"
           autocorrect="off" spellcheck="false" placeholder="token" autofocus>
    <button type="submit">Open board</button>
  </form>
</main>
</body></html>
`;
}

/** Machine-readable members of the Human surface return JSON authentication
 * errors and require JSON request bodies for mutating methods. Match complete
 * path segments so lookalikes such as `/apiary` do not enter this trust path. */
function isMachineReadableHumanSurfacePath(path: string): boolean {
  return (
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/admin-mcp" ||
    path.startsWith("/admin-mcp/")
  );
}

/** ログインページを要る相手か。トップレベル遷移(ブラウザのアドレスバー・PWA の
 *  起動・push の deep link)だけがそれを必要とする。`/api` の fetch や管理MCP の
 *  POST には素の 401 JSON を返す — `/api` はブラウザで直接開く面ではないので、
 *  Accept に text/html が載っていてもデータの面として扱う。 */
function wantsLoginPage(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (isMachineReadableHumanSurfacePath(req.path)) return false;
  return (req.headers.accept ?? "").includes("text/html");
}

function sendLoginPage(res: Response, message?: string): void {
  res.status(401).type("html").send(loginPage(message));
}

function denyUnauthenticated(req: Request, res: Response, message?: string): void {
  if (wantsLoginPage(req)) {
    sendLoginPage(res, message);
    return;
  }
  // `{ error }` の形は WebUI の api() が読む形に揃える
  res.status(401).json({ error: message ?? "this board requires a credential" });
}

function setAuthCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    // Strict は不可: スマホでメッセージアプリから bootstrap URL を開くという
    // クロスサイト起点のトップレベル遷移で cookie が送られず導線が壊れる。
    // CSRF は Lax(クロスサイト POST には付かない)と /api の JSON
    // content-type 要求の二重で閉じる(ADR 0036)。
    sameSite: "lax",
    // Secure は付けない: loopback は http で、tailnet 側は tailscale が TLS を
    // 終端している。付けると loopback の導線が丸ごと死ぬ。
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

export interface HumanSurfaceAuth {
  /** 無認証で通る bootstrap ルーター。`require` より**先に** mount する。 */
  bootstrap: Router;
  /** 人間面の全リクエストが通る credential 検査。 */
  require: RequestHandler;
  /** CSRF の二枚目: `/api` の変更系は JSON content-type を要求する
   *  (クロスオリジン fetch に preflight を強制し CORS で落ちる)。
   *  **`require` より後に置く** — 無認証リクエストは 415 ではなく 401 で
   *  落ちなければならない。
   *
   *  **fail-open 中はこれが CSRF の唯一の壁になる。** 一枚目の `SameSite=Lax` は
   *  cookie の属性なので、cookie を1枚も使わない盤面では何も守っていない
   *  (ADR 0036 / issue #154)。「認証を掛けているのだから content-type 検査は
   *  冗長」という理由でここを畳まないこと — 認証が立っていない盤面こそが、この
   *  検査が単独で立つ盤面である。 */
  requireJsonContentType: RequestHandler;
}

export function createHumanSurfaceAuth(credential: HumanCredential): HumanSurfaceAuth {
  /** 提示された token が通れば cookie を張って `/` へ 302 し、true を返す。
   *  GET(URL を開く)と POST(401 ページのフォーム)で違うのは token の
   *  取り出し方と拒否時の見せ方だけなので、受理側はここ1つ。 */
  const grant = (res: Response, token: string): boolean => {
    const expected = credential.tokenHash();
    if (expected === undefined) {
      // fail-open 中の盤面には bootstrap する対象が無い。**cookie は張らない** —
      // 検証できない token を焼き付けると、`npm run token` で盤面が閉じた瞬間に
      // その端末だけが「以前は入れたのに」と黙って締め出される。素通しで送り出す。
      res.redirect(302, "/");
      return true;
    }
    if (token === "" || !matches(token, expected)) return false;
    setAuthCookie(res, token);
    res.redirect(302, "/");
    return true;
  };
  const bootstrap = Router();
  // `…/auth?token=…` を開くと cookie を張って `/` へ 302。オリジンごと・端末
  // ごとに1回通る導線(cookie はオリジン単位)。
  bootstrap.get(BOOTSTRAP_PATH, (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!grant(res, token)) denyUnauthenticated(req, res, "that token was not accepted");
  });
  // 401 ページのフォームからの POST。urlencoded はこのルートにだけ効かせる
  // (/api は JSON content-type を要求するので、この解析を広げてはいけない)。
  bootstrap.post(BOOTSTRAP_PATH, urlencoded({ extended: false }), (req, res) => {
    const submitted = (req.body as { token?: unknown } | undefined)?.token;
    const token = typeof submitted === "string" ? submitted.trim() : "";
    // このフォームを出すのはログインページだけなので、拒否も必ずそのページで返す
    if (!grant(res, token)) sendLoginPage(res, "that token was not accepted");
  });

  const require: RequestHandler = (req, res, next) => {
    if (isAuthorized(req.headers, credential)) {
      next();
      return;
    }
    denyUnauthenticated(req, res);
  };

  const requireJsonContentType: RequestHandler = (req, res, next) => {
    if (!MUTATING_METHODS.has(req.method) || !isMachineReadableHumanSurfacePath(req.path)) {
      next();
      return;
    }
    const contentType = ((req.headers["content-type"] ?? "").split(";")[0] ?? "")
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      res.status(415).json({ error: "this endpoint requires content-type: application/json" });
      return;
    }
    next();
  };

  return { bootstrap, require, requireJsonContentType };
}
