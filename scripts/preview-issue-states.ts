/** issue参照タスクの各表示状態(issue #49)をブラウザで見るためのプレビューサーバ。
 *  FakeGitHubClient/FakeDraftClientで本物のGitHubに触れずに以下を再現する:
 *   - issue_live_state: live / stale / unavailable (盤面のタイトル表示)
 *   - 登録ゲート(422)の拒否画面(サジェストコメント付き)
 *
 *  使い方: npm run preview:issue-states
 *  出たURLをブラウザで開く。Ctrl-Cで終了(一時DBも併せて削除される)。 */
import { openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";
import { FakeDraftClient } from "../tests/fakes.js";
import { bootTidepool } from "../tests/harness.js";

async function main() {
  const draft = new FakeDraftClient();
  const t = await bootTidepool({
    workspace: { name: "demo", path: "/tmp/tidepool-preview-workspace" },
    draftClient: draft,
    registryCandidates: { assignees: [], workspaces: ["demo"] },
  });
  process.on("SIGINT", async () => {
    await t.stop();
    process.exit(0);
  });

  const db = openDb(`${t.dir}/board.sqlite`);

  // 1) live: issue #101 は普通に取得できる
  registerTask(db, { type: "work", workspace: "demo", github_issue_number: 101 }, t.clock.now());
  t.github.scriptIssue(101, {
    title: "ログイン画面のバグ",
    body: "再現手順: ログイン画面でパスワードを間違えるとクラッシュする",
    comments: ["優先度高です"],
  });

  // 2) stale: 一度成功した後、GitHubが落ちている状態
  registerTask(db, { type: "work", workspace: "demo", github_issue_number: 102 }, t.clock.now());
  t.github.scriptIssue(102, {
    title: "検索結果のソート順がおかしい",
    body: "作成日時の降順になっていない",
    comments: [],
  });

  db.close();

  // stale化: 一旦GETで取得成功させてキャッシュを温めてから、失敗させてTTLを進める
  await fetch(`${t.baseUrl}/api/tasks`);
  t.github.scriptIssueFailure(new Error("GitHub is down (simulated)"));
  await t.clock.advance(30_000);

  // 3) unavailable: 一度も取得成功していない issue #103
  // (#103 も getIssue が常に失敗するよう↑のscriptIssueFailureが効いている)
  const db2 = openDb(`${t.dir}/board.sqlite`);
  registerTask(db2, { type: "work", workspace: "demo", github_issue_number: 103 }, t.clock.now());
  db2.close();

  // 登録ゲート拒否(422)を再現するため、次の登録は拒否されるようscriptしておく。
  // ブラウザの登録画面で workspace=demo, issue番号=104 を入力して登録を試すと
  // このサジェスト付き拒否画面が見られる(issue #104 は getIssue 成功させておく)。
  t.github.scriptIssue(104, {
    title: "improve perf",
    body: "",
    comments: [],
  });
  draft.scriptInspection({
    ok: false,
    missing: "title / purpose / completion_criteria をこのissueの本文・コメントから起こせません",
    suggested_comment:
      "@here このissueをtidepoolのタスクとして登録するには、次の情報を本文かコメントに追記してください:\n" +
      "- 目的(なぜやるか)\n- 完了条件(何をもって完了とするか)",
  });

  console.log("---");
  console.log(`Preview server: ${t.baseUrl}`);
  console.log("live       : issue #101 (通常表示)");
  console.log("stale      : issue #102 (out of sync 表示)");
  console.log("unavailable: issue #103 (#103 プレースホルダー表示)");
  console.log("登録ゲート拒否(422): 登録画面で workspace=demo, issue番号=104 を入力して登録を試す");
  console.log("---");
  console.log("Ctrl-C で終了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
