import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type PromptRecord, TranscriptStore } from "../src/transcript-store.js";
import { tempDir } from "./temp-dir.js";

const PROMPT: PromptRecord = { harness: "claude-code", board: [{ part: "authority", text: "\n\n## Authority\n\nBe careful.", source: "reviewer" }], task: "go", placement: { board: "system" } };

it("readPrompt は open が書いた prompt をそのまま返し、無い・parse できない記録は null(ADR 0314 決定2)", async () => {
  const store = new TranscriptStore(await tempDir("tidepool-transcripts-"));
  const { stream, stderr } = store.open("t-1", 7, PROMPT);
  stream.destroy();
  stderr.destroy();
  writeFileSync(join(store.dir, "t-1.8.prompt.json"), '{"harness":"claude-code","system":[{"part":"defin');

  expect([store.readPrompt("t-1", 7), store.readPrompt("t-1", 8), store.readPrompt("t-1", 9)]).toEqual([PROMPT, null, null]);
});
