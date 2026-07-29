/** `npm run token` — 盤面の credential をローテーションする(ADR 0036 / issue #153)。
 *
 *  盤面はハッシュしか持たないので「再表示」は原理的にできない。したがってこの
 *  スクリプトの意味は再表示ではなく**ローテーション**であり、走らせるたびに
 *  既存の cookie と bearer(管理MCP の設定を含む)がすべて無効になる。
 *  盤面の再起動は要らない — ハッシュはリクエストごとに読み直される。
 *
 *  盤面と同じ `resolveTokenFile` / `resolvePublicOrigins` を通るので、書き先も
 *  出力する bootstrap URL も盤面が読む先とずれない(HOME の違う実行で別ファイルに
 *  書く事故を防ぐため、書いた絶対パスも必ず印字する)。 */
import { bootstrapNotice, resolvePublicOrigins, resolveTokenFile, rotateToken } from "../src/auth.js";

const port = Number(process.env.PORT ?? 4589);
const tokenFile = resolveTokenFile(process.env.TIDEPOOL_API_TOKEN_FILE);
const origins = resolvePublicOrigins(process.env.TIDEPOOL_PUBLIC_ORIGINS, port);

console.log(bootstrapNotice({ token: rotateToken(tokenFile), tokenFile, origins, rotated: true }));
