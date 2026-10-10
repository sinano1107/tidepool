# 空の check の集計は緑ではなく、盤面自身の push から猶予を過ぎても空なら観測不能として扱う

2026-10-09 の grilling(issue #1626、#1687 を併せて決める。発端は #1392 の grilling / ADR 0217)で決定。PR の check の
集計(rollup)が空のとき、盤面はそれを緑と読んでいた(#427 は取得失敗を pending に倒したが、空を緑と読むことは残した)。
CI の無い repo では `auto_if_ci_green` の PR がキュー投入の次の tick で無条件に無人 merge され、CI のある repo でも push の
直後で check がまだ報告されていない窓では、check の前に merge されうる。空の集計からは「CI が無い」と「まだ報告されて
いない」を区別できない。実測(PR を開いてから最初の check run まで)と経路は #1626 に置く。

## 決定

1. **空の集計は緑でも pending でもない第4の値(checks 未報告)として読む。** ADR 0053 決定3 が purely-local に引いた
   「観測不能を緑と読まない」を、remote-backed で check の無い PR にも当てる。
2. **未報告は、盤面がその head を知った時点から5分の猶予の間、pending と同じに扱う。** 盤面が head を知るのは、自分で
   push したとき(PR を開くときと、開いている PR へ修理を push するときの2つ。後者も盤面名義の外向きの行為として event に
   記録する)と、盤面の外で push された head を初めて読んだときである。どちらも event に記録し、起点は記録から取る。
   起点の無い head は無い — 知らない head を読んだら、その時点を起点として記録する(fail-closed。issue #1625 /
   ADR 0231)。猶予は head ごとであり、無人 merge と人間の merge 回答の両方の経路が同じ起点を読む — 猶予の間、無人
   merge は待ち、人間の「merge」回答は CI 未報告として拒否され question は開いたまま残る。
3. **猶予を過ぎても未報告なら、無人 merge は理由を本文に書いた merge question に倒れ、人間の回答は通る。** 無人 merge は
   CI 赤と同じ形でキューを外れて question を立てる。立てる直前に門と着地の面を読み直すのも同じで(ADR 0217)、`external`
   へ取り下げられていれば question は立たない。人間の回答を通すのは、merge するかを判断する人間が回答の中にいるから
   である — 拒めば CI の無い repo では `escalate` と保護の PR が盤面から merge できなくなる。
4. **CI の有無を別の経路で推測しない。** workflow の有無、check suite の有無、workflow run の有無は、どれも「この PR の
   head に check が付くか」を外しうる(トリガーの絞り込み、Actions 以外の CI、run を持たない app の suite)。当たっても
   得るのは CI の無い repo での猶予の短縮だけで、外れれば決定2が塞いだ人間の経路の穴が開き直る。推測でない唯一の信号は
   repo の required status checks だが、宣言していれば GitHub 自身が緑まで merge を拒むので、盤面が読む必要は無い。

## 残る穴

決定2で塞げないものが1つあり、両経路に同じ形で残る — 猶予より遅れて報告される CI である。これを塞ぎたい repo は
required status checks を宣言すれば GitHub がネイティブに塞ぐ(盤面の GitHub 身元が bypass を持たない限り)。

## Considered options

- **空を pending にする** — CI の無い repo では無人 merge のキューが黙って止まり続け、人間の回答も永久に通らない。
- **猶予なしで未報告を question に倒す** — CI のある repo で、60秒周期の tick が push 直後の窓に当たった無人 merge が
  人間の question に格下げされる。猶予が長すぎて失うのは、CI の無い repo で fail-closed の question が遅れることだけである。
- **緑のまま、危険な値の確認(ADR 0088)に「CI の無い repo では無条件の無人 merge」と書く** — ダイヤルが CI の観測を
  根拠にしているのに、観測が無いまま merge する。push 直後の窓も残る。
- **猶予の起点を無人 merge キューの行に持つ** — `escalate` の PR にはキューの行が無く、人間の経路の窓が塞がらない。
