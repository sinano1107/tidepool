import { spawnSync } from "node:child_process";
import net from "node:net";

const expectedNodeMajor = 22;
const actualNodeMajor = Number(process.versions.node.split(".")[0]);

if (actualNodeMajor !== expectedNodeMajor) {
  console.error(
    `Tidepool tests require Node ${expectedNodeMajor}.x; found ${process.version}. ` +
      "Run `nvm use` in the repository (see .nvmrc) before running npm test.",
  );
  process.exit(1);
}

async function loadBetterSqlite3() {
  try {
    await import("better-sqlite3");
    return true;
  } catch (error) {
    if (!String(error).includes("NODE_MODULE_VERSION")) throw error;
    return false;
  }
}

if (!(await loadBetterSqlite3())) {
  console.warn("better-sqlite3 was built for a different Node ABI; rebuilding it for the active Node.");
  const npm = process.env.npm_execpath;
  const rebuild = spawnSync(npm ? process.execPath : "npm", npm ? [npm, "rebuild", "better-sqlite3"] : ["rebuild", "better-sqlite3"], {
    stdio: "inherit",
  });
  if (rebuild.status !== 0) process.exit(rebuild.status ?? 1);
  if (!(await loadBetterSqlite3())) {
    console.error("better-sqlite3 still cannot load after rebuilding.");
    process.exit(1);
  }
}

await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", (error) => {
    if (error.code === "EPERM") {
      reject(
        new Error(
          "Tidepool tests need permission to bind localhost. " +
            "Run `npm test` with the sandbox/network permission enabled.",
        ),
      );
    } else {
      reject(error);
    }
  });
  server.listen(0, "127.0.0.1", () => server.close(resolve));
});
