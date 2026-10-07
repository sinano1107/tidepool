// public/app.js の先頭に bundle されたサーバーの規則(scripts/build-webui-bundle.mjs、ADR 0209)。
// import/export を持たないグローバルスクリプトのまま —— webui/globals.d.ts と同じ形。
declare const TidepoolRules: typeof import("../src/webui-rules");
