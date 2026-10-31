import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { onTestFinished } from "vitest";

/** A separate process keeps HTTP moving while the board runs synchronous git (ADR 0334). */
export async function startGitHttpRemote(
  remote: string,
  mode: "stall-info" | "stall-push" | "slow-clone",
): Promise<string> {
  execFileSync("git", ["config", "http.receivepack", "true"], { cwd: remote });
  const hookPid = join(remote, "hook.pid");
  if (mode === "stall-push") {
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(hook, `#!/bin/sh\necho $$ > "${hookPid}"\nexec sleep 10\n`);
    chmodSync(hook, 0o755);
  }
  const server = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from 'node:http';
    import { spawn } from 'node:child_process';
    const [root, name, mode] = process.argv.slice(1);
    const children = new Set();
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      // Also bounds a broken implementation during the red test.
      const watchdog = mode === 'slow-clone' ? undefined : setTimeout(() => res.destroy(), 8000);
      res.on('close', () => clearTimeout(watchdog));
      if (mode === 'stall-info' && url.pathname.endsWith('/info/refs')) return;
      const child = spawn('git', ['http-backend'], {
        env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname, REQUEST_METHOD: req.method,
          QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '' },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      children.add(child);
      child.on('exit', () => children.delete(child));
      child.stdin.on('error', () => {});
      req.pipe(child.stdin);
      let pending = Buffer.alloc(0);
      let headersSent = false;
      const slow = mode === 'slow-clone' && url.pathname.endsWith('/git-upload-pack');
      const chunks = [];
      child.stdout.on('data', (chunk) => {
        if (!headersSent) {
          pending = Buffer.concat([pending, chunk]);
          const boundary = pending.indexOf('\\r\\n\\r\\n');
          if (boundary < 0) return;
          const headers = {};
          let status = 200;
          for (const line of pending.subarray(0, boundary).toString().split('\\r\\n')) {
            const colon = line.indexOf(':');
            const key = line.slice(0, colon).toLowerCase();
            const value = line.slice(colon + 1).trim();
            if (key === 'status') status = Number(value.split(' ')[0]);
            else headers[key] = value;
          }
          res.writeHead(status, headers);
          headersSent = true;
          chunk = pending.subarray(boundary + 4);
          pending = Buffer.alloc(0);
        }
        if (slow) chunks.push(chunk);
        else res.write(chunk);
      });
      child.stdout.on('end', () => {
        if (!slow) return res.end();
        const body = Buffer.concat(chunks);
        let offset = 0;
        const timer = setInterval(() => {
          res.write(body.subarray(offset, offset + 5000));
          offset += 5000;
          if (offset >= body.length) { clearInterval(timer); res.end(); }
        }, 100);
        res.on('close', () => clearInterval(timer));
      });
    });
    process.on('SIGTERM', () => {
      for (const child of children) child.kill('SIGKILL');
      server.closeAllConnections();
      server.close(() => process.exit(0));
    });
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write('http://127.0.0.1:' + server.address().port + '/' + name + '\\n');
    });
  `, dirname(remote), basename(remote), mode], { stdio: ["ignore", "pipe", "pipe"] });
  onTestFinished(async () => {
    if (existsSync(hookPid)) {
      try { process.kill(Number(readFileSync(hookPid, "utf8")), "SIGKILL"); } catch { /* Hook already exited. */ }
    }
    if (server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
    server.kill();
    await exited;
  });
  return new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`git HTTP remote exited before listening: ${code}`)));
    server.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString().trim()));
  });
}
