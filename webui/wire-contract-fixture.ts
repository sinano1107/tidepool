// 型の負テスト(ADR 0138 決定5)。tsconfig.webui.json の型検査にだけ入り、
// scripts/build-webui-bundle.mjs の SOURCES には足さない —— 出荷されない。
// 連結方式のグローバルに名前を漏らさないよう、ブロックに閉じる。
{
  // 表に無いキーは、生のパスの形(`/` 始まり)にも当たらず型エラーになる
  // @ts-expect-error
  void api('GET /api/no-such-route');
  // エラー応答の行は表にあっても取得先ではない
  // @ts-expect-error
  void api('POST /api/tasks 422');
  // 動的セグメントを持つキーは params を省けない
  // @ts-expect-error
  void api('GET /api/tasks/:id');
  // エラーの本文を開けるのはエラー応答の行だけ
  // @ts-expect-error
  void apiErrorDetail(null, 'GET /api/workspaces');
}
