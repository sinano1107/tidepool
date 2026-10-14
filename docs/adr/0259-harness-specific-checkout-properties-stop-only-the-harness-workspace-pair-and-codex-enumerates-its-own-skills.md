# checkout の Harness 固有の性質は (Harness, workspace) の組で止め、Codex の skill は Codex 自身に列挙させる

2026-10-14 の grilling(issue #1948)で決定。Codex の封じ込め能力の preflight は、起動時に固定した既定の workspace でしか組まれて
いなかった。workspace の層を観測する probe(ADR 0206 決定3)は、その1つの checkout しか見ていない。一方で `skillConfig()` が閉じる
のは skill root の直下にある実ディレクトリだけで、Codex 0.147.0 の探索(深さ 6 までの再帰、ディレクトリの symlink を辿る、親
repo の root から cwd までの `.agents/skills`)と食い違っていた。既定以外の workspace に入れ子・symlink・祖先の skill があると、
それは worker に有効なまま載る(0.147.0 で実測)。逆向きの止めすぎもあった。`.claude/settings*.json` の quarantine は Claude worker
の起動時に workspace 資源へ立つので、同じ workspace の Codex の task まで止める。ADR 0037 は Codex worker(#453)より前の決定で、
ADR 0158 の退けた案が守った「Codex agent が担当なら動く workspace」と、ADR 0098 決定6 の「止められる最も狭い資源」の両方に
反していた。実測の表と経路の調査は #1948 のコメントに置く。

## 決定

1. **checkout の Harness 固有の性質は、(Harness, workspace) の組を資源にして止める。** 新しい Quarantine 資源の名前は Workspace
   containment(workspace の封じ込め)である。止まるのはその組の task だけで、同じ workspace の別の Harness の task も、別の
   workspace の同じ Harness の task も流れ続ける。`.claude/settings*.json` の契機(ADR 0037 / 0158)は workspace 資源からここへ移す。
   封じ込め能力はホストの性質だけを答える。
2. **Codex の skill を閉じるときの列挙は、Codex 自身の `skills/list`(`cwds` に task の workspace)に任せる。** 返った path を
   すべて `enabled=false` にする。readdir による列挙と system skill の固定リストは捨てる。探索の規則は版に従属するので、写すと版を
   上げるたびに写し直すことになる。実際に 0.162 では探索のモードが足され、`plugin-creator` が system skill から消えていた。
   `review-agent`(暗黙の呼び出しを許さない system skill)は固定リストから漏れていて、今の worker では有効のまま残っていた。
   ADR 0147 決定3 の「探索 root を全部覆う」は、この形で置き換える。
3. **workspace ごとの観測は、worker の起動時にその task の workspace で行う。** spawn の設定を当てた `skills/list` が報告する
   skill がすべて `enabled: false` であることを確かめ、そうでなければ組を不成立にする。止めた組は次の pickup から候補を外れる。
   prompt-input の一覧は観測に使わない。暗黙の呼び出しを許さない skill が載らないうえ、書式も版で変わる(0.162)。
4. **Harness 単位の preflight は、どの workspace の checkout も cwd にしない。** prompt-input と features list は空の cwd で走らせる。
   permission の canary は、盤面が使い捨てに作るディレクトリを workspace に見立てて走らせる。これで起動時に固定した既定の workspace
   は preflight から消え、「Codex の preflight 用の workspace が無い」という不成立も消える。
   ADR 0206 決定3 の「workspace を cwd にする preflight の probe は workspace の層を観測するのが仕事なので動かさない」は、この形に
   改める。workspace の層は決定3 の観測が受け持つ。
5. **組の question への回答は、その組の検査をもう一度走らせて成立したときだけ受理する。** 封じ込め能力・動力の認証・表の行と
   同じ門である。
6. **`skills/list` による列挙そのものの失敗は、組の不成立ではなく spawn_failed にする。** worker が1度も走らなかった pickup の族
   (ADR 0118)に入り、failure question(retry / abandon)が人間に届く。Claude の skill 列挙の失敗(ADR 0025 第6項)と同じ形で
   ある。一時的な失敗で、その組の task すべてに人間の回答を求めることはしない。

## 退けた案

- **workspace ごとに観測し、不成立なら workspace 資源の quarantine にする** —— settings の止めすぎを逆向きに作るだけである。
- **封じ込め能力の鍵を (Harness, workspace) に広げる** —— ホストの性質まで workspace ごとに綴ることになり、起動時の検査には
  答えるべき workspace が無い。
- **Harness 単位の観測のまま、`skillConfig()` を vendor の探索に合わせる** —— 写しが版に従属する(決定2)。既定以外の workspace
  では、構成がずれたときの安全網が無いままになる。
- **`skills.include_instructions=false`** —— 一覧の block を消すだけで探索は止まらず、観測も常に空になって意味を失う。
- **pickup の門で組を判定する** —— head ごとに app-server を起こすことになり、slot に入らない行の分まで撃つ。
