import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

async function createServerFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-auto-execute-"));
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
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

async function waitForTaskThread(baseUrl, taskId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request(baseUrl, "/api/local/ai/threads");
    const bound = result.body.threads.filter((thread) => thread.origin.issueId === taskId);
    if (bound.length > 0) return bound;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return [];
}

test("claiming a claimable task auto-executes via a headless AiChat turn without pre-claiming", async () => {
  const fixture = await createServerFixture();
  try {
    await request(fixture.baseUrl, "/api/agents", {
      method: "POST",
      body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
    });
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Auto execute task",
        status: "todo",
        priority: "medium",
        labels: ["frontend"],
      },
    });
    assert.equal(created.response.status, 201);
    const taskId = created.body.task.id;

    const claimed = await request(fixture.baseUrl, `/api/tasks/${taskId}/claim`, {
      method: "POST",
      body: { agentId: "builder", ownerSessionId: "auto-execute-test", ttlSeconds: 900 },
    });
    assert.equal(claimed.response.status, 200);
    // Auto-execution must leave the task claimable so the headless turn claims
    // it with its own conversation binding (pre-claiming caused fake execution).
    assert.equal(claimed.body.task.status, "todo");
    assert.equal(claimed.body.task.assignedAgentId, "builder");
    assert.equal(claimed.body.task.lockOwner, null);
    // The claim awaits the turn start, so by the time it returns the headless
    // turn is already running (or at least claimed and about to run).
    assert.ok(
      ["claimed", "running"].includes(claimed.body.task.executionState),
      `expected claimed/running, got ${claimed.body.task.executionState}`,
    );

    const progressed = await waitForTask(fixture.baseUrl, taskId, (task) => task.executionState !== "claimed");
    assert.notEqual(progressed.executionState, "claimed", "the headless turn should start and progress");

    const threads = await request(fixture.baseUrl, "/api/local/ai/threads");
    const taskThreads = threads.body.threads.filter((thread) => thread.origin.issueId === taskId);
    assert.ok(taskThreads.length > 0, "an AiChat thread should be bound to the task");
  } finally {
    await fixture.close();
  }
});

test("auto-execute respects the per-task autoExecute toggle", async () => {
  const fixture = await createServerFixture();
  try {
    await request(fixture.baseUrl, "/api/agents", {
      method: "POST",
      body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
    });
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Manual execute task",
        status: "todo",
        priority: "medium",
        labels: ["frontend"],
        autoExecute: false,
      },
    });
    const taskId = created.body.task.id;

    const claimed = await request(fixture.baseUrl, `/api/tasks/${taskId}/claim`, {
      method: "POST",
      body: { agentId: "builder", ownerSessionId: "auto-execute-test", ttlSeconds: 900 },
    });
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.body.task.executionState, "claimed");

    const stillClaimed = await waitForTask(
      fixture.baseUrl,
      taskId,
      (task) => task.executionState !== "claimed",
      /* timeoutMs */ 300,
    );
    assert.equal(stillClaimed.executionState, "claimed", "autoExecute=false must not start execution");

    const threads = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(threads.body.threads.filter((thread) => thread.origin.issueId === taskId).length, 0);
  } finally {
    await fixture.close();
  }
});

test("the execute action does not duplicate an already-running auto-execution", async () => {
  const fixture = await createServerFixture();
  try {
    await request(fixture.baseUrl, "/api/agents", {
      method: "POST",
      body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
    });
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Explicit execute task",
        status: "todo",
        priority: "medium",
        labels: ["frontend"],
      },
    });
    const taskId = created.body.task.id;
    // Claiming auto-starts the headless turn (and awaits it), so a subsequent
    // execute action must not spawn a second turn.
    await request(fixture.baseUrl, `/api/tasks/${taskId}/claim`, {
      method: "POST",
      body: { agentId: "builder", ownerSessionId: "auto-execute-test", ttlSeconds: 900 },
    });

    const executed = await request(fixture.baseUrl, `/api/tasks/${taskId}/execute`, {
      method: "POST",
      body: {},
    });
    assert.equal(executed.response.status, 200);
    assert.equal(executed.body.started, false);
    assert.equal(executed.body.reason, "already-running");

    const settled = await waitForTask(fixture.baseUrl, taskId, (task) => (
      task.executionState !== "claimed" && task.executionState !== "running"
    ));
    assert.ok(["idle", "completed", "failed", "interrupted"].includes(settled.executionState));
  } finally {
    await fixture.close();
  }
});

test("assigning a task to an agent triggers auto-execution when enabled", async () => {
  const fixture = await createServerFixture();
  try {
    await request(fixture.baseUrl, "/api/agents", {
      method: "POST",
      body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
    });
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Assign triggers execution",
        status: "todo",
        priority: "medium",
        labels: ["frontend"],
      },
    });
    const taskId = created.body.task.id;

    const assigned = await request(fixture.baseUrl, `/api/tasks/${taskId}/assign`, {
      method: "POST",
      body: {
        version: created.body.task.version,
        agentId: "builder",
      },
    });
    assert.equal(assigned.response.status, 200);
    assert.equal(assigned.body.task.assignedAgentId, "builder");

    // The assignment auto-starts a headless turn on a thread bound to the task.
    const boundThreads = await waitForTaskThread(fixture.baseUrl, taskId);
    assert.ok(boundThreads.length > 0, "an AiChat thread should be bound to the task after assignment");
  } finally {
    await fixture.close();
  }
});
test("auto-execute reuses a healthy completed thread and does not duplicate threads", async () => {
  const fixture = await createServerFixture();
  try {
    await request(fixture.baseUrl, "/api/agents", {
      method: "POST",
      body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
    });
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Reuse healthy thread",
        status: "todo",
        priority: "medium",
        labels: ["frontend"],
      },
    });
    const taskId = created.body.task.id;

    // First claim auto-executes and completes (fixture codex always completes).
    // The fixture codex never claims the task, so once its turn ends the task
    // returns to the claimable pool (execution state back to idle).
    await request(fixture.baseUrl, `/api/tasks/${taskId}/claim`, {
      method: "POST",
      body: { agentId: "builder", ownerSessionId: "auto-execute-test", ttlSeconds: 900 },
    });
    await waitForTask(fixture.baseUrl, taskId, (task) => task.executionState === "running");
    await waitForTask(fixture.baseUrl, taskId, (task) => task.executionState === "idle");

    const threads = await request(fixture.baseUrl, "/api/local/ai/threads");
    const taskThreads = threads.body.threads.filter((thread) => thread.origin.issueId === taskId);
    assert.ok(taskThreads.length > 0, "a thread should exist after the first execution");

    // Re-claim and auto-execute again: must reuse the existing thread (no new one).
    const before = await request(fixture.baseUrl, `/api/tasks/${taskId}`);
    await request(fixture.baseUrl, `/api/tasks/${taskId}`, {
      method: "PATCH",
      body: { version: before.body.task.version, status: "todo" },
    });
    await request(fixture.baseUrl, `/api/tasks/${taskId}/claim`, {
      method: "POST",
      body: { agentId: "builder", ownerSessionId: "auto-execute-retry", ttlSeconds: 900 },
    });

    // The claim awaits the turn start on the reused thread. The fixture codex
    // completes instantly, so poll the thread until its run starts or finishes;
    // either way the same thread must have been used (no duplicate created).
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const snapshot = await request(fixture.baseUrl, `/api/local/ai/threads/${taskThreads[0].id}`);
      if (snapshot.body.thread.currentRun || snapshot.body.thread.status === "idle") break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    const afterThreads = await request(fixture.baseUrl, "/api/local/ai/threads");
    const afterTaskThreads = afterThreads.body.threads.filter((thread) => thread.origin.issueId === taskId);
    assert.ok(afterTaskThreads.some((thread) => thread.id === taskThreads[0].id), "re-execution must reuse the existing thread");
    assert.equal(afterTaskThreads.length, 1, "exactly one thread after re-execution");
  } finally {
    await fixture.close();
  }
});
