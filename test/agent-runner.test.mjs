import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { runAgentRunnerOnce } from "../scripts/taskboard-agent-runner.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-agent-runner-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  const codexExecutable = path.join(directory, "fake-codex.mjs");
  await writeFile(codexExecutable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "debug") {
  process.stdout.write('{"models":[{"slug":"gpt-real","display_name":"GPT Real","description":"","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}],"service_tiers":[]}]}');
} else if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8"); let buffer="";
  process.stdin.on("data", chunk => { buffer += chunk; let i;
    while ((i=buffer.indexOf("\\n"))>=0) { const line=buffer.slice(0,i); buffer=buffer.slice(i+1);
      if (!line.trim()) continue; const message=JSON.parse(line);
      if (message.id===1) process.stdout.write('{"id":1,"result":{}}\\n');
      if (message.id===2) process.stdout.write('{"id":2,"result":{"data":[{"skills":[{"name":"real-skill","enabled":true,"scope":"repo","interface":null}]}]}}\\n');
    }
  });
} else {
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write('{"type":"thread.started","thread_id":"session-1"}\\n');
    process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"auto-executed ok"}}\\n');
    process.stdout.write('{"type":"turn.completed"}\\n');
  });
}
`);
  await chmod(codexExecutable, 0o755);
  const codexStatePath = path.join(directory, "codex-state.json");
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": { local: { rootPaths: [workspace] } },
  }));
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable,
    codexStatePath,
    skillPath: "/fixture/manage-taskboard/SKILL.md",
  });
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

async function waitForTask(baseUrl, taskId, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let task;
  while (Date.now() < deadline) {
    const result = await request(baseUrl, `/api/tasks/${taskId}`);
    task = result.body.task;
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return task;
}

test("agent runner assigns a matching todo task and starts auto-execution without pre-claiming", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/agents", {
    method: "POST",
    body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
  });
  const task = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "local",
      title: "Build visible panel",
      status: "todo",
      priority: "medium",
      labels: ["frontend"],
    },
  });

  const result = await runAgentRunnerOnce({ baseUrl, ownerSessionId: "test-runner", maxClaims: 1 });
  assert.deepEqual(result.actions.map((action) => action.type), ["agent-claimed"]);

  // The task stays claimable and unlocked: the headless turn claims it with its
  // own conversation binding instead of the runner pre-claiming it.
  const updated = await request(baseUrl, `/api/tasks/${task.body.task.id}`);
  assert.equal(updated.body.task.status, "todo");
  assert.equal(updated.body.task.assignedAgentId, "builder");
  assert.equal(updated.body.task.lockOwner, null);

  const comments = await request(baseUrl, `/api/tasks/${task.body.task.id}/comments`);
  assert.ok(comments.body.comments.some((comment) => comment.body.includes("自动认领成功")));

  const threads = await request(baseUrl, "/api/local/ai/threads");
  assert.ok(
    threads.body.threads.some((thread) => thread.origin.issueId === task.body.task.id),
    "a headless turn should be bound to the task",
  );
});

test("agent runner records the autoExecute toggle and does not pre-lock the task", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/agents", {
    method: "POST",
    body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
  });
  const task = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "local",
      title: "Toggle task",
      status: "todo",
      priority: "medium",
      labels: ["frontend"],
    },
  });

  const result = await runAgentRunnerOnce({ baseUrl, ownerSessionId: "test-runner", maxClaims: 1 });
  assert.equal(result.actions[0].type, "agent-claimed");
  assert.equal(result.actions[0].autoExecute, true);

  const updated = await request(baseUrl, `/api/tasks/${task.body.task.id}`);
  assert.equal(updated.body.task.assignedAgentId, "builder");
  assert.equal(updated.body.task.lockOwner, null);
  assert.ok(
    ["claimed", "running", "idle"].includes(updated.body.task.executionState),
    `unexpected execution state ${updated.body.task.executionState}`,
  );
});

test("agent runner skips unmatched skills instead of stealing work", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/agents", {
    method: "POST",
    body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
  });
  const task = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "local",
      title: "Prepare finance model",
      status: "todo",
      priority: "medium",
      labels: ["finance"],
    },
  });

  const result = await runAgentRunnerOnce({ baseUrl, ownerSessionId: "test-runner", maxClaims: 1 });
  assert.deepEqual(result.actions.map((action) => action.reason), ["NO_SKILL_MATCH"]);

  const unchanged = await request(baseUrl, `/api/tasks/${task.body.task.id}`);
  assert.equal(unchanged.body.task.status, "todo");
  assert.equal(unchanged.body.task.assignedAgentId, null);
});

test("agent runner lets assigned squad subtasks be claimed instead of recursively split", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/agents", {
    method: "POST",
    body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
  });
  const squad = await request(baseUrl, "/api/squads", {
    method: "POST",
    body: {
      name: "Delivery Squad",
      leaderAgentId: "builder",
      memberAgentIds: [],
      skillTags: ["delivery"],
    },
  });
  const task = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "local",
      title: "Assigned squad child",
      description: "Autonomous squad subtask generated from LOCAL-1.",
      status: "todo",
      priority: "medium",
      labels: ["squad"],
    },
  });
  const assigned = await request(baseUrl, `/api/tasks/${task.body.task.id}/assign`, {
    method: "POST",
    body: {
      version: task.body.task.version,
      agentId: "builder",
      squadId: squad.body.squad.id,
    },
  });
  assert.equal(assigned.response.status, 200);

  const result = await runAgentRunnerOnce({ baseUrl, ownerSessionId: "test-runner", maxClaims: 1 });
  assert.deepEqual(result.actions.map((action) => action.type), ["agent-claimed"]);

  const updated = await request(baseUrl, `/api/tasks/${task.body.task.id}`);
  assert.equal(updated.body.task.assignedAgentId, "builder");
  // Not recursively split, and not pre-claimed by the runner: the headless turn
  // claims it.
  assert.equal(updated.body.task.status, "todo");
});

test("agent runner prefers a real CLI agent over a stale test agent", async () => {
  const baseUrl = await startServer();
  // A stale test agent that would otherwise win the alphabetical tie-break.
  await request(baseUrl, "/api/agents", {
    method: "POST",
    body: { id: "assigned-mismatch-1786768591017", name: "Assigned Mismatch", skills: ["frontend"], workspacePath: null },
  });
  // A real, authorized, signed-in CLI agent.
  await request(baseUrl, "/api/agents", {
    method: "POST",
    body: { id: "cli-claude", name: "claude", skills: ["cli"], source: "cli", authorized: true, workspacePath: null },
  });

  const task = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "local", title: "Unlabeled demo task", status: "todo", priority: "medium", labels: [] },
  });
  assert.equal(task.response.status, 201);

  const result = await runAgentRunnerOnce({ baseUrl, ownerSessionId: "test-runner", maxClaims: 1 });
  assert.deepEqual(result.actions.map((action) => action.type), ["agent-claimed"]);

  const updated = await request(baseUrl, `/api/tasks/${task.body.task.id}`);
  assert.equal(updated.body.task.assignedAgentId, "cli-claude");
  assert.equal(updated.body.task.status, "todo");
});
