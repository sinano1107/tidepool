# Worker MCP の呼び出しが worker のものであるのは、その spawn の合札を持つときだけで、合札は worker の道具に届かない

2026-11-27 の triage と grilling(issue #3978、元は #3974)で決定。

ADR 0036 は、Worker MCP の守りを「`?task=` が slot の現在タスクと一致すること」とした。理由は、concurrency = 1 なら有効な id は1つしか無く、
殺された古い process の迷い込みを弾ければ足りたからである。ADR 0437 で、出所 `worker` は「worker の判断」の唯一の判定になり、
帰責・学習器・Precedent に入るようになった。門に求められるものは、迷い込みを弾くことから書き手の証明に上がったが、門は変わっていない。
task id は秘密ではない —— failure question の本文・WebUI・events に出る。slot を握っていても worker の process が無い時間がある
(spawn の前、exit から決定まで、停止の梯子の間)。macOS では sandbox の内からも外からも loopback に届く。窓の一覧と CLI の欄の実測は
#3978 に置く。決定はコードと固定版の CLI の読みに依り、worker を走らせたものは無い。

## 決定

1. **Worker MCP が呼び出しを worker のものと認める根拠は、spawn ごとに盤面が発行する合札だけ。** ADR 0036 の「`?task=` + slot」の節を覆す。
   呼び出しの task は合札から盤面が引き、URL の `?task=` は消す。task id と合札を両方受けても、2つ目の主張を照合する仕事が増えるだけで、
   何も守らない。
2. **合札の寿命は spawn の直前から。** 後始末に入った時点で「終わった」に移り、verb には ADR 0109 決定6 の session の終わりの文を返す。
   worker の exit を観測した時点で消える。合札は盤面の記憶にだけ置き、盤面の再起動ですべて失効する。合札が無い、知らない、または消えた
   要求は、initialize も含めて 404 で拒む(403 は Claude CLI がその server 名を needs-auth として記録する)。exit から観測までの窓は、
   盤面がそれより早く知りえないので許容する。
3. **合札が閉じるのは、たまたま task id を知った host 上の process。** 盤面が書く面(events・transcript の prompt・log・WebUI・起動引数・
   MCP 設定の file)には合札を出さない。同じ user が worker の process の env や file を意図して読みに来る経路は扱わない —— GitHub token
   (ADR 0024)と同じ線である。
4. **合札は spawn の env に1つ入れ、両方の CLI に `Authorization: Bearer` で送らせる。** reachability probe(ADR 0331 決定8)も、probe の id を
   同じ経路で送る。probe が成り立つことが、その CLI で合札が届くことの検査になる。
5. **合札は CLI 本体の MCP client にだけ届け、CLI が起こす道具の process(subagent のものを含む)は読めない。** 読めれば、Bash から
   Worker MCP を直接呼んで、subagent の verb を拒む床(#378)と付与された tool の面を迂回できる。この穴は `?task=` の下でも同じ形で
   あった。塞ぎ方は spec が実測で決める。
6. **合札を道具から隠せない Harness は、封じ込め能力の検査が不成立になり、pickup が止まる。** ただし Claude か Codex で隠せないと
   分かったら、止めずに決定5・6 を grilling で問い直す。両方とも支えることが前提だからである。
7. **代理 MCP の呼び出しを task と spawn に帰属させる(ADR 0327 決定5)のも合札である。**
8. **行に spawn の欄は足さない。** session に spawn は1回で、行の task と時刻から導ける。ADR 0437 の判定(出所の1語)は変えない。

## 退けた案

- **task id のまま、窓を個別に塞ぐ**(spawn の前は拒む、exit の観測で門を閉じる)—— 窓の内で書く host 上の client が残る。
- **ADR 0437 の側で、出所 `worker` の意味を「slot の主の名で書かれた行」に弱める** —— 帰責と学習器が、名前の一致を worker の判断として
  読み続ける。
- **合札を MCP 設定の file に直接書く** —— file は記録の器に残り、決定3 を破る。
- **失効を回収済み観測まで遅らせる** —— worker が残した背景 process に門を開けたままにする。
