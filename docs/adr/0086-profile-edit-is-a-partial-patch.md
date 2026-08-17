# profile 編集は部分パッチ —— 触っていない値の確認は出さない

issue #266 のグリリング(2026-08-17)で決定。ADR 0061 決定2 の議論中に見つかった摩擦 —— authority profile の
編集扉が**全フィールドを再送し**(`updateProfileSchema = createProfileSchema.omit({ name: true })`)、危険判定が
**ペイロードの純関数**であるため、`merge: auto_if_ci_green` を持つ profile は `guidance` の1文字修正でも毎回
無人 merge の確認ダイアログを出す —— への回答。

## 決定

profile の編集扉(`PATCH /api/profiles/:name` と管理MCP の `update_profile`)を、workspace の編集扉と同じ
**部分パッチ**にする。危険判定は純関数のまま —— 送られなかったフィールドは判定に現れないので、確認は人間が
実際に危険な値を書いて保存した瞬間にだけ出る。ADR 0061 決定2 を profile 扉へ拡張したものであり、差分ベース
判定(編集前の値を読む)は ADR 0061 が却下した理由のまま採らない。

1. **absent は「触らない」、空は値。** `guidance` の `""` は空文字として保存、`assignable_to` /
   `allowed_workspaces` の `[]` は「誰にも / どこにも」(安全側、確認なし)、`merge` は値ありなら enum どおり。
   absent は**パッチ語彙の中だけ**の概念で、保存される registry ファイルは常に4キー揃う(issue #41 /
   ADR 0079 決定1 の「省略禁止」は不変)。workspace 側で空配列がキー削除に着地するのとは、この点で形が違う。
2. **両扉を同じ一手で部分化する。** WebUI 経由の `/api` と管理MCP の片方だけ部分化すると2扉で契約が割れる。
   MCP の tool description には「省略したフィールドは変更しない」を1文足す。
3. **作成扉は据え置き。** `POST /api/profiles` / `create_profile` は全フィールド必須のまま(ADR 0061 決定3 と
   同じ線)。
4. **WebUI は変わったフィールドだけ線に載せる**(workspace edit card の `protected` と同じ)。空パッチはコミット
   なしの成功(既存の no-change 編集と同じ)。

## Considered options

- **差分ベースの判定** —— ADR 0061 の Considered options で却下済み(編集前のエントリを読む必要があり、
  「今そこに何が開いているか」が人間の目を通らないまま編集が積み重なる)。再議論しない。
- **フォーム側だけで解く(変わったフィールドだけ送る、サーバ契約は無傷)** —— issue の記述に反して成立しない。
  `authorityProfileSchema` は全フィールド必須の strictObject で、`updateProfileSchema` と MCP の
  `profileFieldsSchema` がそのまま使うため、欠けたフィールドは 400。契約を触らずに済む唯一の客側案は
  クライアント側の事前確認だが、それは ADR 0061 決定1 が workspace で撤去した形(危険判定の単一源はサーバ)。

## 実装

`src/api.ts` の `updateProfileSchema` と PATCH ルート、`src/profile-create.ts`(`dangerousValues` の引数を
optional 化、`updateProfile` は既存エントリとマージしてから `sameEffectiveFields`)、`src/management-mcp.ts` の
`update_profile`、`webui/app.jsx` の profile edit card。issue #266。
