# 宣言の repo は資格情報を持たない —— 1つの判定を registry の読み込みと各扉の最初の副作用の手前に置く

2026-11-23 の triage → grilling(issue #3572)で決定。publish が `https://user:token@github.com/…` を入力のまま `repo:` に書き、
registry に commit する穴の報告から始まった。調べると clone(入力)と register(origin の観測)も同じ形で、手編集の yaml も
読み込みで止まらない。根は `repo` / `head_repo` の値の域がどこにも定められていないことである。GitHub 以外の repo では綴りが
そのまま網に出る行き先(ADR 0378 決定1)と task の記録(ADR 0399 決定1)になり、token が registry の履歴を越えて網と DB へ広がる。
扉ごとの実装の読みは #3572 のコメントに置く。

## 決定

1. **宣言の repo(`repo` / `head_repo`)は資格情報を持たない。** 網に出る資格情報は盤面が注入する身元だけである(ADR 0339)。
   GitHub の repo では行き先を宣言の repo key から組むので URL の token は元から使われず、GitHub 以外の repo は匿名で撃つ
   (ADR 0339 決定2)。拒んで失う使い方は無い。
2. **判定は1つで、2か所で使う。** registry の schema(読み込み)と、publish・clone・register の各扉の**最初の副作用の
   手前**である。扉の手前にも置くのは、push や clone の後に schema で落ちると checkout の `.git/config` に token が残るからである。
   出元 repo の扉は値を `owner/name` に直して保存する(ADR 0395 決定2)ので、schema の側だけで足りる。
3. **秘密とみなすもの**: どの scheme でも password・query・fragment(scheme の無い scp 形では `@` の前の `:` を password と読む)。user 部分は ssh 以外の scheme で拒む —— GitHub は
   `https://<token>@github.com/…` を user 部分だけで token として受ける。ssh のログイン名(`ssh://git@…`、`git@host:path`)は通す。
4. **既にある値・手編集の値は registry の読み込みの失敗として止まり、止め方は ADR 0403 決定5 の読み込みの1点が持つ**(盤面全体の
   `registryUnreadable` Quarantine)。この ADR は止め方を作らない。決定5 の実装(#3681・#3682)の後に入る —— 扉の読みを1点へ
   付け替える変更と、判定を差し込む位置が同じだからである。それまでの間も、読み込みの失敗は poll・起動・扉の失敗として fail-closed に
   止まる。
5. **保存する形は変えない。** `repo:` を `owner/name` に直して保存する案は秘密の問いとは別で、GitHub 以外の repo に効かない。

## 退けた形

- **扉ごとに拒む点修正** —— 手編集の値・既にある値・4つ目の扉を塞がない。
- **秘密を剥がして保存する** —— 貼った token を失効させるべきことが人間に届かない。register では剥がした宣言と origin の綴りが
  食い違い、GitHub 以外の repo は ADR 0378 決定3 の Quarantine に落ちる。
- **workspace 単位の Quarantine** —— 読み込みに「この workspace だけ外す」経路を新設することになる。

## 帰結

- 既に registry の履歴に入った token は消せない。失効させるのは人間で、この ADR の外である。
- 宣言でない checkout の origin が扉の拒否文にそのまま出る2箇所も、同じ実装で `repositoryLabel` を通す(表示の線は既存)。
- 実装は #3572 のコメントの spec。
