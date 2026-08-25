# Mac の初回起動は 1 コマンドのインストーラと Lima テンプレートで行い、provision スクリプトが手順の正本

2026-08-25 の grilling(issue #482)で決定。ADR 0100 で Mac 上の盤面は Lima の Linux VM の中に置かれたが、
その手順書は約 19 ステップ・VM シェル内の手打ち約 15 回で、友人テスト(#367)の相手に踏ませるには重い。
「Node 環境の要求を無くせないか」も同じ動機から出た。実測と手順の詳細は issue #482 のコメントに置く。

## 決定

1. **Mac 側で人が打つのは 1 コマンド。** `curl | bash` の薄いインストーラが Lima の有無を見て、リポジトリに置いた
   Lima テンプレートを URL から起動し、VM 内の対話段(`gh auth login`、`claude auth login`)を TTY 越しに順に
   進め、ログイン後の段(git identity、registry の作成、種まき ADR 0089)まで済ませて起動コマンドを印字する。
   人が VM シェルに入る回数は 0、ブラウザは 2 回のログイン + bootstrap URL が残余。途中で止まっても再実行で
   続きから進む(各段が状態を見て skip)。
2. **手順の正本は手順書ではなく provision スクリプト。** テンプレートは `base: template:default` を継承し、
   apt / Node / `claude` / AppArmor / clone / `npm install` / env ファイルを provision で行う。手順書と script の
   二重管理はしない — 手順書は読み手(友人)の操作だけを書き、実測の表は issue に残す。
3. **「Node をなくす」は利用者が Node を見ないことであって、tidepool を Node 不要にすることではない。** VM が
   Node を隠すので、単一バイナリ化の利得は今は小さい。障壁の棚卸しは issue #483 に置き、研究は始めない。
4. **更新は自動ではなく手動の一行。** Lima の provision は VM 起動のたびに走るので毎起動 `git pull` もできるが、
   採らない — 友人が踏んだ不具合を固定版で再現できず、壊れた `main` が VM 起動を道連れにする。provision は
   「無ければ clone」だけ。clone する ref は `main`(version / tag は #439 のまま独立)。
5. **Mac 側に新しい CLI は作らない。** 起動の一行は VM 側の repo に置く `scripts/vm-board.sh` で短縮し、
   ADR 0090 決定2(foreground + `caffeinate`、launchd なし)は不変。対話の案内はインストーラの印字で足りる
   (#366 と同じく、規模に見合う最小手段)。
6. **trust seed(#442)を前提にする。** ログインが `claude auth login` で TUI 不要になった以上、trust ダイアログ
   を消す手段は seed だけ。deploy-pi と共用の seed をインストーラが呼ぶ。

## Considered options

- **全部焼き込んだ自前 VM イメージを配布** — 1 GB 超のホスティングとリリースごとの再ビルドを背負う。VM イメージ
  の 941 MB と所要時間は減らさないと決めた。
- **Homebrew formula / cask** — 中身が結局インストーラと同じで、面が一つ増えるだけ。
- **Node SEA / bun 等で単一バイナリ** — native addon 2 つ・`__dirname` 相対の資産 7 箇所・ビルド工程ゼロという
  現状からは別建ての研究になり、しかも ADR 0100 決定6 により Mac ネイティブでは worker が走らないので、
  Mac 向けの成果物は「VM に入れる Linux バイナリ」にしかならない(#483)。
- **VM そのものを再審理** — ADR 0100 は今日の決定で、決定6(ネイティブ macOS は worker を拾わない、#465)は
  実測の帰結。VM を隠す方向に全振りする。
