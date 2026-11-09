import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerTask } from "../src/tasks.js";
import { quarantineWorkspace, UnknownWorkspaceError } from "../src/workspace.js";
import {
  addSubmodule,
  api,
  bootTidepool,
  callAsTask,
  checkoutOf,
  commitWork,
  FULL_HANDOFF as fullHandoff,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  HUMAN_WEBUI,
  makeWorkspace,
  mcpClient,
  questions,
  registerWork,
  submoduleSource,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

it("未コミットの変更を残したまま work タスクを完了しようとすると拒否され、commit を要求される", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "build the thing");
  await t.clock.advance(HOUR);

  writeFileSync(join(checkoutOf(t.db, task.id), "notes.txt"), "half-finished work\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });

  // ツール結果は agent 向けテキスト = 英語で、要求と本文の粒度が読める
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("uncommitted changes");
  expect(res.content[0].text).toContain("what changed and why");
  // 拒否ではタスクもツリーも動かない
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
  expect(after.status).toBe("in_progress");
  const checkout = checkoutOf(t.db, task.id);
  expect(git(checkout, "status", "--porcelain")).toContain("notes.txt");

  // slot もセッションも生きている: commit して呼び直せばそのまま完了する
  git(checkoutOf(t.db, task.id), "add", "-A");
  git(checkoutOf(t.db, task.id), "commit", "-m", "notes: capture the half-finished work");
  const retry: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(retry.isError ?? false).toBe(false);
  await client.close();
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
});

it("記録した tip の .claude が symlink なら完了を拒み、directory を commit し直すと同じ session で完了できる(ADR 0360 決定4)", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "update the project settings layout");
  await t.clock.advance(HOUR);
  const checkout = checkoutOf(t.db, task.id);
  const claudeDir = join(checkout, ".claude");
  mkdirSync(join(checkout, "project-config"));
  writeFileSync(join(checkout, "project-config", "settings.json"), "{}\n");
  symlinkSync("project-config", claudeDir);
  git(checkout, "add", "--", ".claude", "project-config");
  git(checkout, "commit", "-m", "link project settings directory");
  const rejectedTip = git(checkout, "rev-parse", "HEAD");

  // 作業ツリーだけを直しても、記録する tip には symlink が残っている。
  unlinkSync(claudeDir);
  mkdirSync(claudeDir);
  // ADR 0362 決定2: 直し方自身が fork 元に無い settings の entry を足せば次の門に当たる
  writeFileSync(join(claudeDir, "README.md"), "project notes\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);

  const result: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain(".claude as a symlink");
  expect(result.content[0].text).toContain("make .claude a directory");
  expect(result.content[0].text).toContain("commit the fix on the task branch, then call complete_task again");
  expect(git(ws.path, "rev-parse", `refs/heads/task/${task.id}`)).toBe(rejectedTip);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");

  git(checkout, "add", "--", ".claude");
  git(checkout, "commit", "-m", "use a project settings directory");
  const retry: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();

  expect(retry.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
});

it("名前の場所に replace ref があっても記録した commit の .claude が symlink なら完了を拒む(ADR 0360 決定4)", async () => {
  const ws = await makeWorkspace("sandbox");
  const protectedTip = git(ws.path, "rev-parse", "HEAD");
  const protectedBranch = git(ws.path, "branch", "--show-current");
  git(ws.path, "switch", "-c", "settings-layout");
  mkdirSync(join(ws.path, "project-config"));
  writeFileSync(join(ws.path, "project-config", "settings.json"), "{}\n");
  symlinkSync("project-config", join(ws.path, ".claude"));
  git(ws.path, "add", "--", ".claude", "project-config");
  git(ws.path, "commit", "-m", "link project settings directory");
  const rejectedTip = git(ws.path, "rev-parse", "HEAD");
  git(ws.path, "switch", protectedBranch);
  git(ws.path, "replace", rejectedTip, protectedTip);

  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "verify the project settings layout");
  await t.clock.advance(HOUR);
  git(checkoutOf(t.db, task.id), "reset", "--hard", rejectedTip);
  const client = await mcpClient(t.mcpBaseUrl, task.id);

  const result: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain(".claude as a symlink");
  expect(git(ws.path, "rev-parse", `refs/heads/task/${task.id}`)).toBe(rejectedTip);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");
});

/** 保護ブランチに tracked な .claude/settings.json を持つ workspace。 */
async function workspaceSharingSettings(name: string) {
  const ws = await makeWorkspace(name);
  mkdirSync(join(ws.path, ".claude"));
  writeFileSync(join(ws.path, ".claude", "settings.json"), "{}\n");
  git(ws.path, "add", "-f", "--", ".claude");
  git(ws.path, "commit", "-m", "share the project settings");
  return ws;
}

const writeBlob = (checkout: string, body: string) =>
  execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: checkout, input: body }).toString().trim();

/** Claude の worker が書き込み拒否(ADR 0037 機構2)の外で記録に乗せる経路: plumbing で index の blob を差し替えて commit する。 */
function commitBlob(checkout: string, path: string, blob: string): string {
  git(checkout, "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
  git(checkout, "commit", "-m", `set ${path}`);
  return git(checkout, "rev-parse", "HEAD");
}

/** 人間しか書けない path の拒否であることを確かめ、名指された path の行を返す。 */
function humanOnlyRefusal(result: any): string[] {
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("this path is written only by a human; take the change out of the task branch and commit, then call complete_task again");
  return result.content[0].text.split("\n").slice(1);
}

it("記録した tip が fork 元から .claude/settings.json の blob を変えていれば path を名指して拒み、元の blob に戻して commit すると同じ session で完了できる(ADR 0362 決定2)", async () => {
  const ws = await workspaceSharingSettings("settings-blob");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "tune the project settings");
  await t.clock.advance(HOUR);
  const checkout = checkoutOf(t.db, task.id);
  const original = git(checkout, "rev-parse", "HEAD:.claude/settings.json");
  const rejectedTip = commitBlob(checkout, ".claude/settings.json", writeBlob(checkout, '{"apiKeyHelper":"./steal"}\n'));
  const client = await mcpClient(t.mcpBaseUrl, task.id);

  const result: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });

  expect(humanOnlyRefusal(result)).toEqual(["- .claude/settings.json"]);
  expect(git(ws.path, "rev-parse", `refs/heads/task/${task.id}`)).toBe(rejectedTip);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");

  commitBlob(checkout, ".claude/settings.json", original);
  const retry: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();

  expect(retry.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
});

it("fork 元に無かった .claude/settings.local.json を plumbing で足した tip は拒む(ADR 0362 決定2)", async () => {
  const ws = await makeWorkspace("settings-local-added");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "add local settings");
  await t.clock.advance(HOUR);
  const checkout = checkoutOf(t.db, task.id);
  commitBlob(checkout, ".claude/settings.local.json", writeBlob(checkout, '{"permissions":{"allow":["Bash(*)"]}}\n'));

  const result = await callAsTask(t, task.id, "complete_task", { handoff: fullHandoff });

  expect(humanOnlyRefusal(result)).toEqual(["- .claude/settings.local.json"]);
});

it("fork の後に人間が名前の場所で保護ブランチの settings を進めても、settings に触れていない task は完了できる(ADR 0362 決定2)", async () => {
  const ws = await workspaceSharingSettings("settings-human-advance");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "write the notes");
  await t.clock.advance(HOUR);
  commitWork(ws.path, ".claude/settings.json", '{"env":{"HUMAN":"1"}}\n');
  commitWork(checkoutOf(t.db, task.id), "notes.txt", "the deliverable\n");

  const result = await callAsTask(t, task.id, "complete_task", { handoff: fullHandoff });

  expect(result.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
});

it("親が settings を変えて分解しても子は完了でき、親自身の完了が拒まれ、親が戻すと完了できる(ADR 0362 決定2)", async () => {
  const ws = await workspaceSharingSettings("settings-parent");
  t = await bootTidepool({ workspace: ws });
  const parent = await registerWork(t, "retune the settings, then split");
  await t.clock.advance(HOUR);
  const forkSource = git(ws.path, "rev-parse", "main");
  // 分解の WIP 退避は作業ツリーから取るので、plumbing でなく作業ツリーに書いて commit する
  commitWork(checkoutOf(t.db, parent.id), ".claude/settings.json", '{"env":{"PARENT":"1"}}\n');
  const decomposed = await callAsTask(t, parent.id, "decompose", {
    reason: "the slice is independent",
    children: [{ title: "write the notes", purpose: "finish one part", completion_criteria: "the notes exist" }],
  });
  expect(decomposed.isError ?? false).toBe(false);
  await t.clock.advance(HOUR);
  const child = t.worker.started.at(-1)!;
  expect(child.parent_id).toBe(parent.id);
  commitWork(checkoutOf(t.db, child.id), "notes.txt", "the deliverable\n");

  const childResult = await callAsTask(t, child.id, "complete_task", { handoff: fullHandoff });

  expect(childResult.isError ?? false).toBe(false);
  await t.clock.advance(HOUR);
  const parentCheckout = checkoutOf(t.db, parent.id);
  const rejected = await callAsTask(t, parent.id, "complete_task", { handoff: fullHandoff });
  expect(humanOnlyRefusal(rejected)).toEqual(["- .claude/settings.json"]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("in_progress");

  git(parentCheckout, "checkout", forkSource, "--", ".claude/settings.json");
  git(parentCheckout, "commit", "-m", "restore the project settings");
  const retry = await callAsTask(t, parent.id, "complete_task", { handoff: fullHandoff });

  expect(retry.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("done");
});

const GITLINK_REFUSAL =
  "the task branch tip adds or advances a submodule (gitlink) from its fork source; the record carries only this repository and " +
  "cannot hold a submodule's commits — reset the gitlink to the fork source's value or remove the submodule, and commit, then call complete_task again";

it("記録した tip が fork 元に無い gitlink を足していれば path を名指して拒む(ADR 0365 決定2)", async () => {
  const ws = await makeWorkspace("gitlink-added");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "vendor the library");
  await t.clock.advance(HOUR);
  const checkout = checkoutOf(t.db, task.id);
  addSubmodule(checkout, await submoduleSource("gitlink-added-source"));
  git(checkout, "commit", "-m", "add the library as a submodule");

  const result = await callAsTask(t, task.id, "complete_task", { handoff: fullHandoff });

  expect(result.isError).toBe(true);
  expect(result.content[0].text.split("\n")).toEqual([GITLINK_REFUSAL, "- mod"]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");
});

// 門の順(人間しか書けない path → gitlink)は #3052 の spec コメントの決定
it("同じ tip が人間しか書けない path と gitlink の両方を変えていれば、人間しか書けない path の拒否が先に出る(#3052)", async () => {
  const ws = await makeWorkspace("gitlink-and-settings");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "vendor the library with settings");
  await t.clock.advance(HOUR);
  const checkout = checkoutOf(t.db, task.id);
  addSubmodule(checkout, await submoduleSource("gitlink-and-settings-source"));
  const tip = commitBlob(checkout, ".claude/settings.local.json", writeBlob(checkout, "{}\n"));
  expect(git(checkout, "ls-tree", tip, "--", "mod")).toMatch(/^160000 commit /);

  const result = await callAsTask(t, task.id, "complete_task", { handoff: fullHandoff });

  expect(humanOnlyRefusal(result)).toEqual(["- .claude/settings.local.json"]);
});

it("親の work branch が gitlink を進めていても、子の tip が触っていなければ子は完了できる(ADR 0365 決定2)", async () => {
  const ws = await makeWorkspace("gitlink-parent");
  const source = await submoduleSource("gitlink-parent-source");
  addSubmodule(ws.path, source);
  git(ws.path, "commit", "-m", "add the library as a submodule");
  t = await bootTidepool({ workspace: ws });
  const parent = await registerWork(t, "bump the library, then split");
  await t.clock.advance(HOUR);
  commitWork(source, "lib.txt", "v2\n");
  const advanced = git(source, "rev-parse", "HEAD");
  const parentCheckout = checkoutOf(t.db, parent.id);
  git(parentCheckout, "update-index", "--cacheinfo", `160000,${advanced},mod`);
  git(parentCheckout, "commit", "-m", "bump the library");
  const decomposed = await callAsTask(t, parent.id, "decompose", {
    reason: "the slice is independent",
    children: [{ title: "write the notes", purpose: "finish one part", completion_criteria: "the notes exist" }],
  });
  expect(decomposed.isError ?? false).toBe(false);
  await t.clock.advance(HOUR);
  const child = t.worker.started.at(-1)!;
  expect(child.parent_id).toBe(parent.id);
  const childCheckout = checkoutOf(t.db, child.id);
  expect(git(childCheckout, "rev-parse", "HEAD:mod")).toBe(advanced);
  commitWork(childCheckout, "notes.txt", "the deliverable\n");

  const result = await callAsTask(t, child.id, "complete_task", { handoff: fullHandoff });

  expect(result.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${child.id}`)).json.status).toBe("done");
});

it("記録した tip と fork 元の merge-base が取れなければ、確かめられないとして完了を拒む(ADR 0362 決定2)", async () => {
  const ws = await makeWorkspace("settings-no-merge-base");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "rewrite the history");
  await t.clock.advance(HOUR);
  const checkout = checkoutOf(t.db, task.id);
  // 保護ブランチと履歴を共有しない tip
  git(checkout, "reset", "--hard", git(checkout, "commit-tree", git(checkout, "rev-parse", "HEAD^{tree}"), "-m", "orphan"));

  const result = await callAsTask(t, task.id, "complete_task", { handoff: fullHandoff });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("could not verify");
  expect(result.content[0].text).toContain("Retry complete_task or escalate");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");
});

it("workspace が Quarantine 中でも dirty な work の完了は拒み、commit 後の呼び直しは通る(ADR 0350 決定1)", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "finish while the workspace is quarantined");
  await t.clock.advance(HOUR);
  quarantineWorkspace(t.db, ws.name, new Error("unrelated workspace failure"), t.clock.now());
  writeFileSync(join(checkoutOf(t.db, task.id), "notes.txt"), "the deliverable\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);

  const result: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("uncommitted changes");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");

  git(checkoutOf(t.db, task.id), "add", "-A");
  git(checkoutOf(t.db, task.id), "commit", "-m", "notes: record the deliverable");
  const retry: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();

  expect(retry.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
});

/** 名前を後から registry から消せる(drift)盤面で、worker が task の checkout に commit した走行中の work。 */
async function committedThenDrifted(title: string) {
  const ws = await makeWorkspace("sandbox");
  const registry = { drifted: false };
  t = await bootTidepool({
    workspace: ws,
    resolveWorkspace: (name) => {
      if (registry.drifted) throw new UnknownWorkspaceError(name ?? ws.name);
      return ws;
    },
  });
  const task = await registerWork(t, title);
  await t.clock.advance(HOUR);
  const checkout = checkoutOf(t.db, task.id);
  commitWork(checkout, "feature.txt", "the deliverable\n");
  registry.drifted = true;
  return { ws, task, checkout, client: await mcpClient(t.mcpBaseUrl, task.id) };
}

const quarantineQuestions = async () => (await questions(t)).filter((q: any) => q.question_quarantine_kind !== null);

it("実行中に名前が registry から消えた(drift)work の complete_task は done にせず、名前・escalate・残る task の checkout の在り処を言って拒み、呼び直しても Quarantine を立てない(ADR 0363 決定1・2・4)", async () => {
  const { ws, task, checkout, client } = await committedThenDrifted("finish after the registry lost the workspace");

  const first: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  const again: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();

  for (const refused of [first, again]) {
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain(`"${ws.name}" is not in the workspace registry`);
    expect(refused.content[0].text).toContain("escalate");
    expect(refused.content[0].text).toContain(checkout);
  }
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");
  expect(await quarantineQuestions()).toEqual([]);
});

it("issue #3094 の再現: drift の後の完了は拒まれ、escalate の後始末が Quarantine を1枚立てて残した checkout を名指し、worker の commit は checkout にだけ残って記録の task branch に入らない(ADR 0363 決定1・4)", async () => {
  const { ws, task, checkout, client } = await committedThenDrifted("ship while the registry loses the workspace");
  const tip = git(checkout, "rev-parse", "HEAD");

  const refused: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  const escalated: any = await client.callTool({
    name: "escalate",
    arguments: { context: "the workspace left the registry", questions: [{ title: "where now?", options: ["restore it", "drop it"], recommendation: "restore it" }] },
  });
  await client.close();

  expect(refused.isError).toBe(true);
  expect(escalated.isError ?? false).toBe(false);
  await vi.waitFor(async () => expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined());
  const [quarantine, ...others] = await quarantineQuestions();
  expect(others).toEqual([]);
  expect(quarantine).toMatchObject({ question_quarantine_kind: "workspace", question_quarantine_value: ws.name });
  expect(quarantine.purpose).toContain(`The board kept the task checkout at ${checkout}`);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${quarantine.id}/events`)).json.map((e: any) => e.kind)).not.toContain("quarantine_refired");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).not.toBe("done");
  expect(git(checkout, "rev-parse", "HEAD")).toBe(tip);
  expect(git(ws.path, "rev-parse", `task/${task.id}`)).not.toBe(tip);
});

// 門は tree rule と同じ基準で dirty を数える(ADR 0069 の3条件)。`.claude/agents` は
// 丸ごと untracked なディレクトリの下にいるので、porcelain の既定の畳み込みでは
// `?? .claude/` としか見えない —— そこで残骸の除外が効かなくなる形が回帰の本体である
it("sandbox の shadow 残骸だけが残っていても完了の門は通る", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "verify without changing anything");
  await t.clock.advance(HOUR);

  writeFileSync(join(checkoutOf(t.db, task.id), ".zshrc"), "");
  mkdirSync(join(checkoutOf(t.db, task.id), ".claude"), { recursive: true });
  writeFileSync(join(checkoutOf(t.db, task.id), ".claude/agents"), "");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  await client.close();

  expect(res.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
});

// review は読むだけで書けない —— 完了の門は掛からず、残っていたものは現行どおり
// WIP に退避される
it("review タスクの完了は dirty でも拒否されない", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "review the deliverable",
      purpose: "check it against the criteria",
      completion_criteria: "findings are recorded",
    })
  ).json;
  await t.clock.advance(HOUR);

  writeFileSync(join(checkoutOf(t.db, task.id), "scratch.txt"), "reviewer leavings\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({ name: "complete_task", arguments: { handoff: { outcome: "no findings" } } });
  await client.close();

  expect(res.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
  expect(git(ws.path, "log", "--format=%s", `task/${task.id}`)).toContain(`WIP: task ${task.id}`);
});

// escalate / decompose は「作業が終わっていない」解放なので門を掛けない
it("escalate は dirty でも拒否されず、WIP コミットの subject にタスクの title が載る", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "wire up the sensor");
  await t.clock.advance(HOUR);

  writeFileSync(join(checkoutOf(t.db, task.id), "notes.txt"), "half-finished work\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "escalate",
    arguments: {
      context: "the sensor pinout is ambiguous",
      questions: [
        {
          title: "which pinout?",
          options: ["datasheet rev A", "datasheet rev B"],
          recommendation: "datasheet rev A",
        },
      ],
    },
  });
  await client.close();

  expect(res.isError ?? false).toBe(false);
  expect(git(ws.path, "log", "-1", "--format=%s", `task/${task.id}`)).toBe(
    `WIP: task ${task.id} — wire up the sensor`,
  );
});

// issue-backed の stored title は `#N` プレースホルダのまま —— 退避は同期の機械処理で
// GitHub を叩かないので、subject は素の形に落ちる
it("issue参照タスクの WIP コミット subject はプレースホルダを載せず素の形になる", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = registerTask(
    t.db,
    { type: "work", workspace: ws.name, github_issue_number: 240 },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );
  t.github.scriptIssue(240, { title: "workerは必ずcommitメッセージを考えてほしい", body: "", comments: [] });
  await t.clock.advance(HOUR);

  writeFileSync(join(checkoutOf(t.db, task.id), "notes.txt"), "half-finished work\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({
    name: "escalate",
    arguments: {
      context: "the issue is ambiguous",
      questions: [
        { title: "which reading?", options: ["a", "b"], recommendation: "a" },
      ],
    },
  });
  await client.close();

  expect(git(ws.path, "log", "-1", "--format=%s", `task/${task.id}`)).toBe(`WIP: task ${task.id}`);
});

it("decompose は dirty でも拒否されず、WIP がタスクブランチへ退避される", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "split the work");
  await t.clock.advance(HOUR);

  writeFileSync(join(checkoutOf(t.db, task.id), "notes.txt"), "half-finished work\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "the remaining slice is independent",
      children: [
        {
          title: "implement the slice",
          purpose: "finish one part",
          completion_criteria: "the artifact exists",
        },
      ],
    },
  });
  await client.close();

  expect(res.isError ?? false).toBe(false);
  expect(git(ws.path, "show", `task/${task.id}:notes.txt`)).toBe("half-finished work");
});
