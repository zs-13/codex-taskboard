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
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-collab-"));
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

  const activity = await request(baseUrl, "/api/activity-log");
  assert.equal(activity.response.status, 200);
  assert.ok(activity.body.activities.some((entry) => entry.eventType === "squad.autonomous_step"));
  assert.ok(activity.body.activities.some((entry) => entry.eventType === "agent.task_claimed"));
});

test("terminal task states release the execution lock", async () => {
  const baseUrl = await startServer();
  const agent = await request(baseUrl, "/api/agents", {
    method: "POST",
    body: { id: "builder", name: "Builder", skills: ["frontend", "sqlite"], workspacePath: null },
  });
  assert.equal(agent.response.status, 201);

  async function claimAndLock(title) {
    const task = await request(baseUrl, "/api/tasks", {
      method: "POST",
      body: { projectId: "local", title, status: "todo", priority: "medium", labels: ["frontend"] },
    });
    const claim = await request(baseUrl, `/api/tasks/${task.body.task.id}/claim`, {
      method: "POST",
      body: { agentId: "builder", ownerSessionId: "session-lock", ttlSeconds: 900 },
    });
    assert.equal(claim.response.status, 200);
    assert.equal(claim.body.task.lockOwner, "builder");
    // Return the task id and its post-claim version.
    return { id: task.body.task.id, version: claim.body.task.version };
  }

  // Move to done -> lock released.
  const done = await claimAndLock("Lock release on done");
  const doneMove = await request(baseUrl, `/api/tasks/${done.id}/move`, {
    method: "POST",
    body: { status: "done", version: done.version },
  });
  assert.equal(doneMove.response.status, 200);
  assert.equal(doneMove.body.task.status, "done");
  assert.equal(doneMove.body.task.lockOwner, null);
  const doneTask = await request(baseUrl, `/api/tasks/${done.id}`);
  assert.equal(doneTask.body.task.lockOwner, null);

  // Canceled -> lock released.
  const canceled = await claimAndLock("Lock release on cancel");
  await request(baseUrl, `/api/tasks/${canceled.id}/move`, {
    method: "POST",
    body: { status: "canceled", version: canceled.version },
  });
  const canceledTask = await request(baseUrl, `/api/tasks/${canceled.id}`);
  assert.equal(canceledTask.body.task.status, "canceled");
  assert.equal(canceledTask.body.task.lockOwner, null);

  // Archived -> lock released.
  const archived = await claimAndLock("Lock release on archive");
  const archivedResp = await request(baseUrl, `/api/tasks/${archived.id}/archive`, {
    method: "POST",
    body: { version: archived.version },
  });
  assert.equal(archivedResp.response.status, 200);
  const archivedTask = await request(baseUrl, `/api/tasks/${archived.id}`);
  assert.ok(archivedTask.body.task.archivedAt !== null);
  assert.equal(archivedTask.body.task.lockOwner, null);

  // A still-active in-progress task keeps its lock.
  const active = await claimAndLock("Lock stays while active");
  const activeTask = await request(baseUrl, `/api/tasks/${active.id}`);
  assert.equal(activeTask.body.task.status, "in_progress");
  assert.equal(activeTask.body.task.lockOwner, "builder");
});

test("createSquad auto-registers a known CLI tool member", async () => {
  // Use a deterministic fake CLI tool instead of relying on a real one like
  // git being found on the runner PATH (Windows CI PATH can be unreliable;
  // on windows-2025 it has been observed to rearrange between steps). The
  // scan finds the fake executable on both POSIX and Windows (no extension),
  // so the auto-registration path is exercised without host dependence.
  const fakeDir = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-fakebin-"));
  temporaryDirectories.push(fakeDir);
  await writeFile(path.join(fakeDir, "fakecli"), "#!/bin/sh\necho fake-cli 1.2.3\n", "utf8");

  const baseUrl = await startServer({ cliToolNames: ["fakecli"], cliToolPath: fakeDir });
  // A leader that exists.
  await request(baseUrl, "/api/agents", {
    method: "POST",
    body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
  });
  // Seed a known CLI tool (unauthorized, no cli-* agent row yet).
  const seed = await request(baseUrl, "/api/cli-tools", { method: "GET" });
  assert.equal(seed.response.status, 200);
  const seededFake = seed.body.tools.find((tool) => tool.name === "fakecli");
  assert.ok(seededFake, "fakecli should be scanned");
  assert.equal(seededFake.installed, true, "fakecli should be detected as installed");

  // createSquad with a cli-<tool> member that has no agent row: the backend
  // auto-registers it (known installed CLI tool) instead of 404.
  const squad = await request(baseUrl, "/api/squads", {
    method: "POST",
    body: {
      name: "CLI Tool Squad",
      leaderAgentId: "builder",
      memberAgentIds: ["cli-fakecli"],
      skillTags: [],
    },
  });
  assert.equal(squad.response.status, 201);
  assert.ok(squad.body.squad.members.some((m) => m.agentId === "cli-fakecli"));

  const agents = await request(baseUrl, "/api/agents");
  const cliAgent = agents.body.agents.find((a) => a.id === "cli-fakecli");
  assert.ok(cliAgent, "cli-fakecli agent should be auto-registered");
  assert.equal(cliAgent.source, "cli");

  // DELETE endpoint removes the squad.
  const del = await request(baseUrl, `/api/squads/${squad.body.squad.id}`, { method: "DELETE" });
  assert.equal(del.response.status, 204);
  const after = await request(baseUrl, "/api/squads");
  assert.ok(!after.body.squads.some((s) => s.id === squad.body.squad.id));
});

test("createSquad with a known-but-not-installed CLI tool member returns CLI_TOOL_NOT_INSTALLED", async () => {
  // A tool name that is scanned (so it is known to the cli_tools table) but
  // has no executable anywhere: the readable error must come back, not a bare
  // AGENT_NOT_FOUND.
  const baseUrl = await startServer({ cliToolNames: ["definitely-not-a-real-cli"] });
  await request(baseUrl, "/api/agents", {
    method: "POST",
    body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
  });
  const seed = await request(baseUrl, "/api/cli-tools", { method: "GET" });
  assert.equal(seed.response.status, 200);

  const squad = await request(baseUrl, "/api/squads", {
    method: "POST",
    body: {
      name: "Missing Tool Squad",
      leaderAgentId: "builder",
      memberAgentIds: ["cli-definitely-not-a-real-cli"],
      skillTags: [],
    },
  });
  assert.equal(squad.response.status, 409);
  assert.equal(squad.body.error.code, "CLI_TOOL_NOT_INSTALLED");
});
