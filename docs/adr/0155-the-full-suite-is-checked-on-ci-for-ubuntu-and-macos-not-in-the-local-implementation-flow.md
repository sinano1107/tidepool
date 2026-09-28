# full suite の合否は CI(ubuntu と macOS)で確かめ、ローカルの実装の流れでは流さない

2026-09-26 の grilling(issue #842)で決定。git を多用するテストファイル群が、ローカルの full suite 中に 5000ms で
timeout することが続いていた(#842・#883・#967 ほか)。単独実行では通り、落ちるのは負荷が重なったときである。test lock
(`scripts/test-lock.ts`)は full suite 同士を直列化するが、負荷の出どころはそこではない。重なるのは、worktree を並べて
走らせる別の実装セッションそのものと、スイート自身がかける負荷(既定の worker 数で load average 約32、10コア)である。
一方 CI では、同じ3週間の 427 回のうち、このファイル群は一度も落ちていない。計測は #842 のコメントに置く。

## 決定

1. **「full suite が通った」は CI で確かめる。** CI の test ジョブは ubuntu と macOS の2本で、すべての PR で走り、
   どちらも必須とする。並列セッションの数はこちらで抑えられないので、ローカルで耐えられる設定を探すより、負荷から切り離された
   場所で確かめる。ローカルは1回が速くても lock で順番を待つので、branch ごとに並行して走る CI のほうが全体では速い。
2. **`/implement-tidepool` は段階ごとに full suite を流さない。** 段階の commit は単体テストと typecheck で進める。PR を開いたら
   CI の2本が通るまで待ち、落ちたら直して push し直してから人間に渡す。段階分けが守るのは各段階の変更をレビューし戻せることで、
   途中の commit が full suite を通ることまでは求めない。
3. **macOS は CI で拾う。** Linux の CI だけでは、macOS でしか出ない問題(#884 の autofs、node-pty の exec bit)が
   見えない。この Mac での任意実行に頼ると、流されない日には何も拾われない。
4. **ローカルの `npm test` と test lock は残す。** 人間が手元で流すための経路で、合否の場所ではない。

## Considered options

- **ローカルの full suite を合否の場所に残し、worker 数を絞るか `testTimeout` を上げる** — 並べる本数が増えるたびに目標が
  破れる。`testTimeout` を上げれば、本当の hang を見逃す幅も広がる。
- **CI は ubuntu だけにして、macOS はローカルの任意実行で拾う** — 上の決定3の理由で退けた。

## 追記(2026-09-28 のトリアージ、issue #1127)

**git fixture を組むテストには、CI の macOS runner の速さのばらつきに見合う個別の timeout を置く。全体の `testTimeout`
は変えない。** 決定3 のとおり macOS の CI が 5000ms timeout を拾った(9/26〜28 に4回、どれも macOS の shard、ubuntu は
0回)。原因は runner 機体の速さの差で、同じ shard の実行時間が約2.5倍振れる。スイートが自分でかける負荷ではない。
Considered options で `testTimeout` の引き上げを退けた理由(並べる本数が増えるたびに目標が破れる)はローカルの並走負荷の
話で、台数の固定された CI runner には当たらない。hang を見逃す懸念は残るが、範囲を実 git の fixture を使うテストに限り、
上限を有限に置けば hang は捕まる。計測は #1127 に置く。
