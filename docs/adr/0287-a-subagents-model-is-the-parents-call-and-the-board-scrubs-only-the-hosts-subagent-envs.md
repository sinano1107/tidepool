# subagent の model / effort は親の采配で行の仕事に数え、盤面は host の subagent env だけを消す

2026-10-20 の grilling(issue #1887 —— ADR 0245 の帰結が残した経路)で決定。worker が Agent tool(Claude)/ `spawn_agent`(Codex)で
分けた仕事が、pin した行と別の model で走りうることが問われた。固定版の CLI(Claude Code 2.1.286 / Codex 0.147.0)を Lima VM で走らせて
測ると、別の model で走る経路は3種類に分かれた: **親(worker 自身)が選ぶもの**(Agent tool の `model` 引数、checkout の `.claude/agents/*.md`
の `model:` / `effort:`、`spawn_agent` の `model` / `reasoning_effort`)、**固定版の CLI の既定**(main が opus より上の系列のとき Explore だけ
opus に下がる上限)、**host の env**(`CLAUDE_CODE_SUBAGENT_MODEL` 等 —— 盤面の全 worker の subagent が黙って変わり、記録に出ない)。
実測の表と binary / source の読みは #1887 のコメントに置く。

## 決定

1. **subagent がどの model / effort で走るかは親の采配で、その仕事は親の行の実績に数える。本番も Interview も同じ。** 行の実績は
   「この model をこの固定版の Harness で pin したら何が得られるか」の記録であり、親が弱い model に仕事を投げて良い答案を出したなら、
   それは pin した model の采配込みの結果で、本番で同じ model を pin すれば同じ采配が起きる。費用は session 合計に出る。ADR 0215
   決定2 が subagent だけの差し替え(`scope: local`)を「session の model は変わらない」と読んで episode を数えているのと同じ線。
   ADR 0245 決定1 の「分けない」は decompose(説明責任の分割)の話で、Agent tool は ADR 0010 が労力の側に置いたものなので触れない。
2. **盤面は CLI の schema から `model` を消さず、Explore の上限も外さない。** どちらも固定版の CLI の既定で、本番と Interview に同じ
   spawn env で同じに掛かるので乖離は起きない。挙動が変わるのは pin を上げたときだけで、それは版上げの門(ADR 0135 決定5 の読み直し)が
   見る —— 新しい版の Agent tool には `effort` 引数もあるが、決定1 では親の選択なので対応は要らない。
3. **host の env 3つ —— `CLAUDE_CODE_SUBAGENT_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` / `CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP` ——
   は worker の spawn env から消す。** 理由は Interview と本番の乖離ではなく、host が盤面の決定を上書きしない線(ADR 0005 / ADR 0208 /
   ADR 0215 決定1)である。消す形は refusal の env 3つと同じで、盤面側の値を入れず「無い」を固定する。user tier の settings は
   `--setting-sources project` で既に読まれない。workspace の `.claude/settings.json` の `env` 欄と `.claude/agents/*.md` は人間が
   merge した workspace の中身(worker は書けない —— ADR 0037 機構2)で、決定1 の親の采配の側に置く。
4. **Codex は閉じるものが無い。** `spawn_agent` の上書きは親の選択で、`agents.default_subagent_model` は盤面の CODEX_HOME の外から
   届かない。
5. **記録は足さない。** 親の采配は行の仕事なので、subagent の model を読む読み手が盤面に無い。確かめ方は spawn env の宣言テスト1本。

## 退けた案(どれも VM で効くことを確かめた上で採らない)

- **`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` で schema から `model` を消し、全 subagent を親の model に揃える** —— 親の采配を奪い、測るものを
  「この model が1人で解く力」に変える。本番で pin したときに得られるものと違うものを測ることになる。
- **`CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP` で上限を外す** —— 固定版の既定であり、乖離を生まない。外せば Fable の session の Explore の
  費用だけが上がる。
- **Codex の `features.multi_agent_v2.expose_spawn_agent_model_overrides=false` で引数を消す** —— v2 でだけ効き、v1 は source で常に
  露出(選べない: 版は model の metadata が決め、その値は backend が実行時に置く —— ADR 0134 決定2 / ADR 0255)。決定1 では要らない。
- **hook で subagent の model を門にする** —— Codex の PreToolUse は `spawn_agent` を通らず、SubagentStart の `continue:false` は
  0.147.0 では subagent を止めなかった。
- **episode か `worker_exited` に subagent の model を足す** —— 決定5。

## 帰結

- Interview の受験者が subagent を弱い model で走らせても、答案はその対象の答案として採点される。それが「その対象を pin したときに
  得られるもの」である。
- `CLAUDE_CODE_EFFORT_LEVEL` など main の pin に効く host env が盤面に残っている疑いは別 issue で扱う(ADR 0005 の線)。
