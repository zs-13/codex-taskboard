import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-collab-"));
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

test("collaboration extension closes the local squad workflow loop", async () => {
  const baseUrl = await startServer();

  const agent = await request(baseUrl, "/api/agents", {
    method: "POST",
    headers: { "idempotency-key": "agent-builder" },
    body: {
      id: "builder",
      name: "Builder",
      skills: ["frontend", "sqlite"],
      workspacePath: null,
    },
  });
  assert.equal(agent.response.status, 201);

  const replay = await request(baseUrl, "/api/agents", {
    method: "POST",
    headers: { "idempotency-key": "agent-builder" },
    body: {
      id: "builder",
      name: "Builder",
      skills: ["frontend", "sqlite"],
      workspacePath: null,
    },
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.agent.id, "builder");

  const dirtyReplay = await request(baseUrl, "/api/agents", {
    method: "POST",
    headers: { "idempotency-key": "agent-builder" },
    body: {
      id: "other-builder",
      name: "Other Builder",
      skills: ["frontend"],
      workspacePath: null,
    },
  });
  assert.equal(dirtyReplay.response.status, 409);
  assert.equal(dirtyReplay.body.error.code, "IDEMPOTENCY_CONFLICT");

  const squad = await request(baseUrl, "/api/squads", {
    method: "POST",
    body: {
      name: "Delivery Squad",
      leaderAgentId: "builder",
      memberAgentIds: [],
      skillTags: ["delivery"],
    },
  });
  assert.equal(squad.response.status, 201);

  const task = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: { "idempotency-key": "main-task" },
    body: {
      projectId: "local",
      title: "Build collaborative workflow",
      description: "Main task",
      status: "todo",
      priority: "high",
      labels: ["delivery"],
    },
  });
  assert.equal(task.response.status, 201);

  const assigned = await request(baseUrl, `/api/tasks/${task.body.task.id}/assign`, {
    method: "POST",
    body: {
      version: task.body.task.version,
      agentId: "builder",
      squadId: squad.body.squad.id,
    },
  });
  assert.equal(assigned.response.status, 200);
  assert.equal(assigned.body.task.assignedAgentId, "builder");
  assert.equal(assigned.body.task.squadId, squad.body.squad.id);

  const claimedTask = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "local",
      title: "Implement sqlite board",
      status: "todo",
      priority: "medium",
      labels: ["sqlite"],
    },
  });
  assert.equal(claimedTask.response.status, 201);

  const claim = await request(baseUrl, `/api/tasks/${claimedTask.body.task.id}/claim`, {
    method: "POST",
    body: { agentId: "builder", ownerSessionId: "session-a", ttlSeconds: 900 },
  });
  assert.equal(claim.response.status, 200);
  assert.equal(claim.body.task.assignedAgentId, "builder");
  assert.equal(claim.body.task.lockOwner, "builder");
  assert.equal(claim.body.task.status, "in_progress");

  const replayClaim = await request(baseUrl, `/api/tasks/${claimedTask.body.task.id}/claim`, {
    method: "POST",
    body: { agentId: null, ownerSessionId: "session-b", ttlSeconds: 900 },
  });
  assert.equal(replayClaim.response.status, 200);
  assert.equal(replayClaim.body.task.assignedAgentId, "builder");

  const mismatch = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "local",
      title: "Design finance model",
      status: "todo",
      priority: "medium",
      labels: ["finance"],
    },
  });
  assert.equal(mismatch.response.status, 201);
  const mismatchClaim = await request(baseUrl, `/api/tasks/${mismatch.body.task.id}/claim`, {
    method: "POST",
    body: { agentId: "builder" },
  });
  assert.equal(mismatchClaim.response.status, 409);
  assert.equal(mismatchClaim.body.error.code, "NO_SKILL_MATCH");

  const blocked = await request(baseUrl, `/api/tasks/${task.body.task.id}/block`, {
    method: "POST",
    body: {
      version: assigned.body.task.version,
      blocked: true,
      reason: "Need design decision",
    },
  });
  assert.equal(blocked.response.status, 200);
  assert.equal(blocked.body.task.status, "blocked");
  assert.equal(blocked.body.task.blocked, true);

  const dependency = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "local",
      title: "Finish prerequisite",
      status: "todo",
      priority: "medium",
      labels: [],
    },
  });
  assert.equal(dependency.response.status, 201);

  const relation = await request(baseUrl, `/api/tasks/${blocked.body.task.id}/dependencies`, {
    method: "POST",
    body: { dependsOnTaskId: dependency.body.task.id },
  });
  assert.equal(relation.response.status, 200);

  const completedDependency = await request(baseUrl, `/api/tasks/${dependency.body.task.id}/move`, {
    method: "POST",
    body: {
      version: dependency.body.task.version,
      status: "done",
    },
  });
  assert.equal(completedDependency.response.status, 200);

  const released = await request(baseUrl, `/api/tasks/${blocked.body.task.id}`);
  assert.equal(released.response.status, 200);
  assert.equal(released.body.task.status, "todo");
  assert.equal(released.body.task.blocked, false);

  const autonomous = await request(baseUrl, `/api/tasks/${released.body.task.id}/autonomous-step`, {
    method: "POST",
    body: {},
  });
  assert.equal(autonomous.response.status, 200);
  assert.equal(autonomous.body.task.status, "in_progress");

  const skill = await request(baseUrl, "/api/skills", {
    method: "POST",
    body: {
      name: "Delivery checklist",
      description: "Reusable flow",
      body: "Plan, execute, self-check, review.",
      skillTags: ["delivery"],
    },
  });
  assert.equal(skill.response.status, 201);

  const command = await request(baseUrl, "/api/task-command", {
    method: "POST",
    body: { command: "/task new Build a thing" },
  });
  assert.equal(command.response.status, 200);
  assert.equal(command.body.accepted, false);
  assert.match(command.body.recommendation, /侧边任务面板/);

  const activity = await request(baseUrl, "/api/activity-log");
  assert.equal(activity.response.status, 200);
  assert.ok(activity.body.activities.some((entry) => entry.eventType === "squad.autonomous_step"));
  assert.ok(activity.body.activities.some((entry) => entry.eventType === "agent.task_claimed"));
});
