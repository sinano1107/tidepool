import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { promisify } from "node:util";
import { bootPreview } from "../tests/preview.js";

const execFileAsync = promisify(execFile);

async function buildDesignSystemBundle(): Promise<void> {
  const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/build-ds-bundle.mjs"]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}

async function main(): Promise<void> {
  await buildDesignSystemBundle();
  const preview = await bootPreview();
  console.log(`Settings preview: ${preview.url}`);

  let rebuilding = false;
  let rebuildQueued = false;
  const rebuild = async () => {
    if (rebuilding) {
      rebuildQueued = true;
      return;
    }
    rebuilding = true;
    try {
      await buildDesignSystemBundle();
    } catch (error) {
      console.error("[preview:settings] design-system bundle rebuild failed:", error);
    } finally {
      rebuilding = false;
      if (rebuildQueued) {
        rebuildQueued = false;
        void rebuild();
      }
    }
  };
  const watcher = watch("components", { recursive: true }, () => void rebuild());

  let stopping = false;
  process.once("SIGINT", () => {
    if (stopping) return;
    stopping = true;
    watcher.close();
    void preview.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
