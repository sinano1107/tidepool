// 抜け道を機械で塞ぐ(ADR 0138 決定5)。lib.dom.d.ts の `Body.json(): Promise<any>` に
// 同名の interface を足し、宣言のマージで後から効くこの overload に `Promise<unknown>` を
// 効かせる —— 表を通らない生の `res.json()` / `(await fetch(...)).json()` の読み取りが
// 型検査で赤くなる。import/export を持たないグローバルスクリプトのまま —— webui/globals.d.ts と同じ形。
interface Body {
  json(): Promise<unknown>;
}
