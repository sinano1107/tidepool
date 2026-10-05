import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readLines, readStderrTail, settleOnOutputClose } from "../src/child-stream.js";
import { FakeClock, recordingSpawn } from "./fakes.js";

/** 子プロセスの出力を「bytes → 行」にする vendor 中立の層(issue #1299)。 */
describe("readLines", () => {
  it("マルチバイト文字の途中で割れた chunk 列から、化けていない行が得られる(#1298)", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    readLines(stream, (line) => lines.push(line));
    // 「認証」の「証」のバイト列の途中(13バイト目)で割る
    const bytes = Buffer.from('{"result":"認証エラー"}\n');
    stream.write(bytes.subarray(0, 13));
    stream.write(bytes.subarray(13));
    expect(lines).toEqual(['{"result":"認証エラー"}']);
  });

  it("未終端の最終行は flush で渡る", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const flush = readLines(stream, (line) => lines.push(line));
    stream.write("first\nlast");
    expect(lines).toEqual(["first"]);
    flush();
    expect(lines).toEqual(["first", "last"]);
  });
});

/** worker_exited の stderr_tail(issue #125)。保持は chunk ごとに末尾だけ、全量は .stderr.log 側。 */
describe("readStderrTail", () => {
  const tailOf = (...chunks: Array<string | Buffer>) => {
    const stream = new PassThrough();
    const finish = readStderrTail(stream);
    for (const chunk of chunks) stream.write(chunk);
    return finish();
  };

  it("25行を流すと 6〜25 行目が残る", () => {
    const chunks = Array.from({ length: 25 }, (_, i) => `stderr line ${i + 1}\n`);
    expect(tailOf(...chunks)).toBe(
      "stderr line 6\nstderr line 7\nstderr line 8\nstderr line 9\nstderr line 10\n" +
        "stderr line 11\nstderr line 12\nstderr line 13\nstderr line 14\nstderr line 15\n" +
        "stderr line 16\nstderr line 17\nstderr line 18\nstderr line 19\nstderr line 20\n" +
        "stderr line 21\nstderr line 22\nstderr line 23\nstderr line 24\nstderr line 25",
    );
  });

  it("改行だけなら null", () => {
    expect(tailOf("\n")).toBeNull();
    expect(tailOf()).toBeNull();
  });

  it("末尾の改行で空行が増えず、先頭の空白は削らない", () => {
    expect(tailOf("  indented\n")).toBe("  indented");
  });

  it("マルチバイト文字が chunk 境界で割れても化けない", () => {
    const bytes = Buffer.from("認証エラー: トークン期限切れ\n");
    expect(tailOf(bytes.subarray(0, 4), bytes.subarray(4))).toBe("認証エラー: トークン期限切れ");
  });
});

/** ADR 0201: root の exit は強制回収の契機、記録の確定点は root の出力の読み切り(close)。 */
describe("settleOnOutputClose", () => {
  const LIMIT = 1000;
  const setup = () => {
    const clock = new FakeClock();
    const process = recordingSpawn();
    const child = process.spawn("root", [], { cwd: "/", env: {} });
    const order: string[] = [];
    const settled: Array<[number | null, NodeJS.Signals | null, boolean]> = [];
    settleOnOutputClose(
      child,
      clock,
      LIMIT,
      () => order.push("exit"),
      (...args) => {
        order.push("settle");
        settled.push(args);
      },
    );
    return { clock, process, order, settled };
  };

  it("exit で onExit を撃ち、確定は読み切りまで待つ", () => {
    const t = setup();

    t.process.emitExitOnlyAt(0, 1, "SIGTERM");
    expect(t.order).toEqual(["exit"]);
    t.process.emitCloseAt(0, 1, "SIGTERM");

    expect(t.order).toEqual(["exit", "settle"]);
    expect(t.settled).toEqual([[1, "SIGTERM", true]]);
  });

  it("読み切りが上限までに来なければ、exit の code で outputClosed: false として確定し、遅れた読み切りは無視する", async () => {
    const t = setup();

    t.process.emitExitOnlyAt(0, 0, null);
    await t.clock.advance(LIMIT - 1);
    expect(t.settled).toEqual([]);
    await t.clock.advance(1);
    t.process.emitCloseAt(0, 0, null);

    expect(t.settled).toEqual([[0, null, false]]);
  });

  it("exit を見ないまま来た close(spawn の失敗で Node が error のあとに撃つ)では確定しない", async () => {
    const t = setup();

    t.process.emitCloseAt(0, -2, null);
    await t.clock.advance(LIMIT);

    expect(t.order).toEqual([]);
  });
});
