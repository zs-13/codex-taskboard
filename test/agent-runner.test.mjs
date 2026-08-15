import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  const app = createTaskboardServer({ dataDirectory: directory });
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

test("agent runner automatically claims a matching todo task", async () => {
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

  const updated = await request(baseUrl, `/api/tasks/${task.body.task.id}`);
  assert.equal(updated.body.task.status, "in_progress");
  assert.equal(updated.body.task.assignedAgentId, "builder");
  assert.equal(updated.body.task.lockOwner, "builder");

  const comments = await request(baseUrl, `/api/tasks/${task.body.task.id}/comments`);
  assert.ok(comments.body.comments.some((comment) => comment.body.includes("自动认领成功")));
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
  assert.equal(updated.body.task.status, "in_progress");
  assert.equal(updated.body.task.assignedAgentId, "builder");
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
  assert.equal(updated.body.task.status, "in_progress");
  assert.equal(updated.body.task.assignedAgentId, "cli-claude");
});
