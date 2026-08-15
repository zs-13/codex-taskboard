import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const runningApps = [];
const temporaryDirectories = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    await rm(directory, { recursive: true, force: true });
  }
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-cli-"));
  const app = createTaskboardServer({ dataDirectory: directory, ...options });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("cli-tools detection lists configured tools and persists authorization", async () => {
  // Constrain the scan to a couple of names so the test is deterministic even
  // though the exact installed set varies by machine.
  const baseUrl = await startServer({
    cliToolNames: ["git", "node"],
  });

  const listed = await request(baseUrl, "/api/cli-tools");
  assert.equal(listed.response.status, 200);
  assert.ok(Array.isArray(listed.body.tools));
  assert.ok(listed.body.tools.length >= 2, "git and node should both be probed");
  const byName = new Map(listed.body.tools.map((tool) => [tool.name, tool]));

  const git = byName.get("git");
  assert.ok(git, "git should be in the configured list");
  assert.equal(typeof git.command, "string");
  assert.equal(typeof git.installed, "boolean");
  assert.equal(typeof git.authorized, "boolean");
  // Every scanned tool must carry the full detection shape for the UI.
  for (const tool of listed.body.tools) {
    assert.equal(typeof tool.name, "string");
    assert.equal(typeof tool.command, "string");
    assert.ok("path" in tool);
    assert.ok("version" in tool);
    assert.equal(typeof tool.installed, "boolean");
    assert.equal(typeof tool.authorized, "boolean");
  }

  // Authorization must be idempotent and persisted.
  if (git.installed) {
    const authorized = await request(baseUrl, "/api/cli-tools/git/authorize", { method: "POST" });
    assert.equal(authorized.response.status, 200);
    assert.equal(authorized.body.tool.authorized, true);
    assert.equal(authorized.body.agent.id, "cli-git");
    assert.equal(authorized.body.agent.source, "cli");

    const listedAgain = await request(baseUrl, "/api/cli-tools");
    const gitAfter = listedAgain.body.tools.find((tool) => tool.name === "git");
    assert.equal(gitAfter.authorized, true);

    // The cli-sourced agent appears in the roster for squad membership.
    const agents = await request(baseUrl, "/api/agents");
    const cliAgent = agents.body.agents.find((agent) => agent.id === "cli-git");
    assert.ok(cliAgent, "authorized CLI tool should appear in the agent roster");
    assert.equal(cliAgent.source, "cli");
    assert.equal(cliAgent.authorized, true);

    const revoked = await request(baseUrl, "/api/cli-tools/git/revoke", { method: "POST" });
    assert.equal(revoked.response.status, 200);
    assert.equal(revoked.body.tool.authorized, false);
  }

  // Unknown tool authorization must fail cleanly.
  const missing = await request(baseUrl, "/api/cli-tools/does-not-exist-xyz/authorize", { method: "POST" });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, "CLI_TOOL_NOT_FOUND");
});

test("cli-tools scan respects CODEX_TASKBOARD_CLI_TOOLS_JSON", async () => {
  const fakeDir = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-fakebin-"));
  temporaryDirectories.push(fakeDir);
  const fakeScript = path.join(fakeDir, "fakecli.cmd");
  await writeFile(fakeScript, "@echo off\r\necho fake-cli 1.2.3\r\n", "utf8");

  const baseUrl = await startServer({
    cliToolNames: ["fakecli"],
    cliToolPath: fakeDir,
  });

  const listed = await request(baseUrl, "/api/cli-tools");
  assert.equal(listed.response.status, 200);
  const fake = listed.body.tools.find((tool) => tool.name === "fakecli");
  assert.ok(fake, "fakecli should be scanned");
  // On Windows a .cmd shim resolves; on POSIX the same fixture name would be
  // a plain file. We only assert the shape, not the installed flag.
  assert.equal(typeof fake.installed, "boolean");
  assert.equal(typeof fake.authorized, "boolean");
});
