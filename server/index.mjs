import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTaskboardServer, resolveHost, resolvePort } from "./app.mjs";

export { createTaskboardServer, resolveHost, resolvePort, resolveServerOptions } from "./app.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The web panel bundle (`dist/web`) is gitignored and not shipped in a fresh
// clone, so a brand-new install would otherwise 404 on the panel page. Build it
// once on startup when it is missing; after that the build exists and this is a
// no-op. Covers every launch path (start-taskboard, plugin injector, npm start).
//
// The build is NON-BLOCKING on purpose: the injector starts this server and
// waits a short window for /health, so blocking on a cold vite build here would
// make it time out and tear the whole stack down. Listening immediately keeps
// the service reachable; the panel appears once the background build finishes.
function ensureWebAssets() {
  const indexHtml = path.join(projectRoot, "dist", "web", "index.html");
  if (existsSync(indexHtml)) return;
  const viteBin = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    console.warn("Web panel bundle missing and vite is not installed; run 'npm install' then 'npm run build:web'.");
    return;
  }
  console.log("Web panel bundle not found - building it in the background (npm run build:web) ...");
  const build = spawn(
    process.execPath,
    [viteBin, "build", "--config", "web/vite.config.ts"],
    { cwd: projectRoot, stdio: "inherit", windowsHide: true },
  );
  build.once("error", (error) => {
    console.warn(`Web panel build failed to start: ${error.message}`);
  });
  build.once("exit", (code) => {
    if (code !== 0) {
      console.warn(`Web panel build failed (status ${code}); the panel page may 404. Run 'npm run build:web' manually.`);
    }
  });
}

async function main() {
  const app = createTaskboardServer();
  ensureWebAssets();
  const host = resolveHost();
  const listenFd = process.env.CODEX_TASKBOARD_LISTEN_FD === undefined
    ? null
    : Number(process.env.CODEX_TASKBOARD_LISTEN_FD);
  const address = await app.listen({ host, port: resolvePort(), fd: listenFd });
  console.log(`Codex Taskboard listening on http://127.0.0.1:${address.port}`);
  if (host === "0.0.0.0") {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    for (const lanAddress of [...new Set(addresses)]) {
      console.log(`Codex Taskboard available on LAN at http://${lanAddress}:${address.port}`);
    }
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => close().then(() => process.exit(0)));
  process.once("SIGTERM", () => close().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
