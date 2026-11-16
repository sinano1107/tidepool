# registry の床は宣言 `repo` で判定する —— 網の行き先と同じ値から決め、checkout の origin は読まない

2026-11-16 の grilling(#3279 / PR #3329 の実装レビュー、[引き継ぎ](https://github.com/sinano1107/tidepool/issues/3279#issuecomment-6917110985))で決定。
ADR 0377 決定6 は保護を「checkout の origin が registry clone の origin と同じ repo」で計算し、その1日後の ADR 0378 決定1 は workspace の網の
行き先を宣言 `repo` に移した。決定6 は前提の変化の後に評価し直されていない。宣言が registry を指す workspace で pickup の後に origin だけを
向け替えると、着地は registry へ push して PR を開くのに、保護の判定は保護なしと答え、`auto_if_ci_green` が ADR 0013 の「registry の変更は
常に人間 merge」を破る。spec #3273 はこの食い違いを「origin が宣言と別なら pickup が止める」で限界にしていたが、session 中の向け替えは
pickup を通らない。読んだコードと各場合の表は #3279 のコメントに置く。決定の形の盤面は走らせていない。

## 決定

1. **保護 = entry の `protected` が true、または宣言 `repo` が registry clone の origin と同じ repo。** checkout の origin は読まない。
   workspace が何の repo かの正本は宣言で、origin は宣言と照合される側(ADR 0378 決定3)にだけ使う。
2. **比べるのは盤面が実際に出る先どうしである。** 宣言は ADR 0378 決定1 の行き先の組み立てに通した値、registry 側は registry clone の網の
   行き先と同じ origin の読み方、比べ方は ADR 0378 決定4。生の `repo:` の綴りは比べない —— 相対 path や綴りの揺れで行き先と保護がずれる。
   これで保護と網の行き先は構造的に同じ値から決まる。宣言を registry に書き換えれば行き先も保護も registry になり、逆も同じ。
3. **判定は1つで、読み手の全部が使う。** 自動 merge の取り下げを含む着地、子登録の承認、保護剥奪の扉、一覧。着地だけで実宛先を見る形は
   採らない(退けた形)。
4. **origin が読めないことは保護の理由でなくなる。** spec #3273 の「origin が読めない checkout は保護」(fail closed)と拒否文 E3b を
   置き換える。判定が origin を読まないので守る対象が無い。registry clone の origin が読めない場合の保護は残る。
5. **ADR 0013 の「床をデータの状態に依存させない」との照合。** 床は registry の YAML の `repo:` を読むが、`repo:` を書くのは人間面だけで
   ある —— create(clone / register)・publish の扉と registry の YAML で、worker の道は registry-edit の PR(その workspace は保護される
   ので人間 merge)しかない。床が自分を外す diff を worker が着地させる道は無い。
6. **ADR 0013 の2つの門は、保護を読む時点が違うものとして定める。** merge の門は着地の行為の時点で毎回読み、registry の中身を守る
   不変条件はこちらが持つ。子登録の門は、登録時点で worker のその workspace での作業に人間が同意する門であり、後から保護が付いても
   登録済みの子に遡って承認を求めない(後から `protected` を立てた場合と同じ)。

## 退けた形

- **着地だけで、実宛先が registry なら人間 merge にする** —— 自動 merge は塞がるが、子登録・一覧・剥奪の扉は origin で判定し続け、
  「着地では保護、ほかの面では保護なし」の食い違いが規則として残る。読み手は1つの関数を通っているので、定義を直す方が箇所も少ない。
- **flag・宣言・origin の和** —— origin の項が効くのは origin が registry を指し宣言が別の repo を指す場合で、行き先は宣言なので registry は
  変わらず、pickup が Quarantine で止める。守るものが無く、保護と行き先が同じ値から決まる形を崩す。
- **pickup で保護を読み直し、承認を経ずに登録された子を spawn の前に止める** —— 守れるのは作業への事前の同意だけで、「承認を経たか」を
  記録する形がタスクの記録に要る。観測された痛みは無い。

## 帰結

- 偽になる文に `Status 追記` を置いた: ADR 0377 決定5・6 と限界、ADR 0013 の Status 追記(「origin と同じ repo を origin に持つ」)。
- 限界: 宣言の無い workspace の checkout の origin が registry を指す場合、子登録は承認 question にならない。その workspace は最初の
  pickup で Quarantine になり何も走らない。人間が `repo:` に registry を宣言して直せば保護が付き、承認を経ずに登録された子が registry に
  向けて走るが、merge は人間である(決定6)。
- registry clone 自身の origin を session 中に向け替えると、元の repo 宛ての PR が保護なしになる。この ADR の外で #3330 にした。
