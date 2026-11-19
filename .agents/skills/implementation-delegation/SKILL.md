---
name: implementation-delegation
description: 実装の委任先とレビューの強度を選ぶ。「Codexに逃す」「どのモデルや effort でやらせるか」「Sonnetで足りるか」の判断に使う。
argument-hint: "[issue] [codex|claude]"
---

# 実装委任の選定

`$ARGUMENTS` の issue を対象にする。末尾に `codex` / `claude` があればその提供元だけ、なければ両方を提示する。

## 出力

提供元ごとに「実装」と「レビュー（`/code-review` と `ponytail-review`）」を1行ずつ、`モデル / effort` で示す。実装が既定の主力 `medium` と異なるときは選定理由、レビューを強めるときは見逃しやすい失敗を、それぞれ該当行に添える。`max` には明示指定または先行する `xhigh` の失敗を記す。選定保留なら、不足している仕様を1行で示す。

## 1. 選定

完了条件・変更範囲・不変条件が判断できるかを確認し、失敗コストと残る判断で選ぶ。

| 失敗コスト・作業の性質 | 仕様が明確 | 仕様が曖昧・探索的 |
|---|---|---|
| **高い**（挙動不変リファクタ、権限・封じ込め・ブランチ規律、不変条件の執行） | 主力 / `high` | 選定を保留 |
| **通常** | 主力 / `medium` | 主力 / `high` |
| **定型・機械的** | 廉価 / `medium`（§3） | 通常の行で判断 |

選定を進められる場合、既存テストが変更対象の旧挙動を保証しているときや、スキーマ変更の判断が残るときは主力の `high` を起点にする。

**上位モデルは `high` から。** 仕様が明確で、複数の境界をまたぐ状態遷移と復旧順序など、相互に影響する制約を一緒に検証する必要があるときに選ぶ。上位が使えない場合や、同じモデルで検証を深める場合は `medium → high → xhigh` の順で上げる。

### 再試行と `max`

自動選定の初回上限は `xhigh`。同じ完了条件・範囲で `xhigh` を完走し、テスト・レビュー・外部正本が局所修正では解消できない推論上の失敗を示した場合、主力からは上位の `high` を先に試す。すでに上位の `xhigh` を試した場合や上位モデルが使えない場合は、`xhigh` を試したモデルの `max` を選べる。人間が `max` を明示指定した場合も使える。情報不足、ツールや実行環境の障害、利用上限で中断した場合は、原因を解消して同じ設定で再開する。

## 2. レビュー強度

実装と同じ提供元・設定を既定とする。記録の汚染や挙動不変のはずの逸脱など、テストが緑でも見逃せる失敗を具体的に示せる場合は、`xhigh` までの範囲で effort を1段上げる。主力で実装した場合は §1 の条件に該当すれば上位の `high` を選べる。Terra で実装した場合は effort の引き上げに代えて Sol の `medium` 以上を選ぶ。確認点が1つで、検証すれば失敗が明らかになる場合は effort を下げてもよい。

## 3. モデル（2026-11-19 確認）

| 役割 | Codex のモデル ID | Claude Code のモデル（エイリアス） |
|---|---|---|
| 上位 | `gpt-6.2-astra` | Fable 5.2（`fable`） |
| 主力 | `gpt-6.2-sol` | Opus 5.5（`opus`） |
| 廉価。仕様・範囲・検証方法が明確で、既存パターンを踏襲する小修正 | `gpt-6.1-terra` | Sonnet 5.5（`sonnet`） |
| 廉価。rename、機械的置換、大量読み取り | `gpt-6-luna` | Haiku 5.5（`haiku`） |

選定前に、実行環境で使えるモデルと effort を確認する。Codex の出力と委任にはモデル ID を使う。Claude Code の Agent 呼び出しにはエイリアスを使い、解決されるバージョンを確認する。Claude Code v2.1.321 以降の通常セッションでは `fable` が 5.2 を指す。Claude apps gateway の `/model` では `claude-fable-5-2` を使う。

[OpenAI のモデル選定ガイド](https://developers.openai.com/api/docs/guides/model-selection?site_locale=en) · [Claude Code のモデル設定](https://code.claude.com/docs/en/model-config) · [Claude Code のサブエージェント設定](https://code.claude.com/docs/en/sub-agents#choose-a-model)
