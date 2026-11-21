# 出元 repo からの PR は、盤面にログインした人間の user token で開き、それ以外の PR の操作は宣言の repo の installation token で行う

2026-11-21 の grilling(issue #3569)で決定。ADR 0395 は PR の操作を宣言の repo 用の token で組み、ADR 0093 は盤面の GitHub 上の名義を `tidepool-board[bot]` に置いた。実測(#3558・#3569 のコメント)で、宣言の repo が private のとき、この2つは両立しないと分かった。宣言の repo 用の installation token は private の fork を読めず、作成は 422 `not all refs are readable` で拒まれる。出元 repo 用の token は宣言の repo を読めない。2つの repo は必ず所有者が違うので(同じ所有者の中には fork できない)、両方に効く installation token は作れない。GitHub の資料にも、installation を跨ぐ token、`[bot]` を collaborator にする道、private の fork の visibility の変更、PR の作者の変更は無かった。作れたのは盤面が既に持つ user token(ADR 0093 決定3)だけである。user token で作った fork の PR にも、fork の PR としての扱い(`GITHUB_TOKEN` は read、secrets は渡らない)は効いた。陽性対照つきで測り、扱いを分けるのは head の repo が fork かどうかで、PR を作った token の種類ではなかった。

## 決定

1. **PR の作成だけを、盤面にログインした人間の user token で行う。** PR の作者はその人間になる。宣言の repo が public でも private でも同じにする。public なら `maintainer_can_modify: false` を渡せば bot の名義で作れるが、visibility で道を分けない。分けても、作者が人間になる代償は private では消えないからである。
2. **作成の後の操作(PR の読み・CI の読み・head に固定した merge)は、宣言の repo 用の installation token のままにする。** merge が bot の名義であることは、盤面が自分の merge と外の merge を見分ける拠り所なので、user token へ移さない。
3. **user token で撃つのは PR の作成の1つだけにする。** 盤面が GitHub を直接撃ち、broker に動詞は足さない(broker も bot の名義では作れない)。user token は盤面の中で使い、`gh` や git の子プロセスの env には入れない(ADR 0093 決定4)。user token は App の権限とその人間の権限が重なる範囲に届き、1 repo に絞った token より広いので、ほかの操作に使う扉にしない。
4. **作成には `maintainer_can_modify: false` を渡す。** 宣言の repo の maintainer に、PR の head への push を開かない(ADR 0395 決定5)。
5. **PR の本文に `Opened by the tidepool board.` を入れる。** 作者が人間で、App の名義も表示されないので(`performed_via_github_app` は null)、人間が手で開いた PR と見分ける手がかりがほかに無い。

## 帰結

- GitHub 上で、PR を開いた名義は人間になる。commit の author と merge の名義は bot のままである。
- ログインした人間は、出元 repo を読めなければならない。installer は出元 repo の所有者なので満たす。作成が失敗すれば(出元 repo を読めない、user token の失効)、その根の着地の失敗に落ちる。user token が失効しても broker が先に落ちるとは限らない —— installation token は期限までキャッシュされ、push は通りうる。
- ひとりで運用する maintainer は、自分が作者の PR を承認できない。宣言の repo が「承認を必須」や「CODEOWNERS の承認を必須」にしていると、盤面の PR はそれを満たせない。
- 自分の PR の探索は作者で絞らない。head の repo で照合する(issue #3561)。

## 検討した選択肢

- **private の宣言の repo では着地しない** —— maintainer の registry の repo が private なので、registry を編集する workspace が着地できなくなる。
- **public だけ bot の名義で作る** —— 見た目は綺麗だが、visibility で道が分かれる。作者が人間になる代償は private では残る(決定1)。
- **broker に PR の作成の動詞を足す** —— broker も bot の名義では作れず、ADR 0093 決定2 の「API は1本」を崩すだけである。
