# Codex preflight の probe は盤面所有の user config を読む面を観測し、塞ぐのは判定を緩める向きのずれだけ

2026-09-22 の grilling(issue #698)で決定。ADR 0098 決定4 の照合は「worker が走る面を観測する」ことを前提にしているが、worker の spawn(`codex exec`)が渡す `--ignore-user-config` / `--ignore-rules` を、probe の `codex debug prompt-input` / `codex features list` / `codex app-server` は受けない(pin した 0.147.0 の実物で確認)。probe は盤面所有 `$CODEX_HOME/config.toml` と rules が効いた面を観測し、worker はそれらを剥がした面で走る。この config.toml は盤面が書かなくても Codex 自身が project trust を書き込むので、空に保つ不変条件は置けない。実測表と vendor source の `file:line` は issue #698 のコメントに置く。

## 決定

1. **完全一致は目指さない。ずれは fail-closed の向きなら許し、fail-open の向きだけを塞ぐ。** preflight の仕事は「封じられているつもりで裸」を防ぐことで、probe が worker より厳しく見る分には route が閉じるだけである。
2. **塞ぎ方は `-c` の列挙であり、probe と spawn は同じ組み立てを使う。** `-c` で pin したキーは user 層に勝つので、ずれが入るのは `-c` が触らないキーだけになる。
3. **skill 軸の列挙は、Codex が探索するすべての root を覆う。** `skills.config` の規則は user 層と `-c` 層を置き換えずに混ぜて適用するので、列挙から漏れた skill を config.toml が無効化すると、probe には見えず worker には見える —— 今日ただ1つの fail-open 経路だった。`$CODEX_HOME/skills` と system config のディレクトリの `skills` を列挙に加える。探索 root の読み直しは、ADR 0135 の feature と同じく pin を上げるときの仕事に含める。
4. **許すずれ(いずれも照合の値を動かさないか、route を閉じる向き):** trust による `sandbox_mode` の文面、rules による承認済み prefix の文面、config.toml の `[features]` が開けた feature を倒すこと、app-server の strict parse が config.toml の未知キーで倒れること(ADR 0142)、trusted な workspace の `.codex/config.toml` が probe にだけ効くこと。
5. **Quarantine の理由文は変えない。** vendor が config.toml に書く経路で観測されたのは trust だけで、全 feature のずれに「config.toml を疑え」を付けると本物の版ずれを読み違わせる。

worker は trust を user 層から読むので、`--ignore-user-config` の下では workspace の project config を無効な層として扱い、その値は worker に効かない。封じ込めにとって好ましい向きの事実として記録する。

## 退けた案

- **probe を worker が読むものだけを並べた専用の `CODEX_HOME` で走らせる** —— auth、`.system` の skill、`$CODEX_HOME/AGENTS.md`(#697)、盤面の hook を複製することになり、複製と本物のずれという同じ種類の問題を作り直す。
- **盤面所有 codexHome に config.toml を置かないことを不変条件にする** —— Codex 自身が書く。
- **probe が config.toml の `skills.config` を読んで打ち消す / 盤面が config.toml から削る** —— 盤面が vendor のファイルを解釈または書き換えることになる。
