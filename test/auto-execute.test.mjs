import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

async function createServerFixture(options = {}) {
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
    if (process.env.FAKE_CODEX_FAIL) {
      process.stdout.write('{"type":"turn.failed","error":{"message":"fixture forced failure"}}\\n');
      return;
    }
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
    processEnv: {
      ...process.env,
      ...(options.failCodex ? { FAKE_CODEX_FAIL: "1" } : {}),
    },
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

test("claiming a claimed task auto-executes via a headless AiChat turn", async () => {
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
    assert.equal(claimed.body.task.status, "in_progress");
    assert.equal(claimed.body.task.executionState, "claimed");

    const executing = await waitForTask(fixture.baseUrl, taskId, (task) => task.executionState === "running");
    assert.equal(executing.executionState, "running");

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

test("the execute action starts a headless turn and reports completion state", async () => {
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
    await request(fixture.baseUrl, `/api/tasks/${taskId}/claim`, {
      method: "POST",
      body: { agentId: "builder", ownerSessionId: "auto-execute-test", ttlSeconds: 900 },
    });

    const executed = await request(fixture.baseUrl, `/api/tasks/${taskId}/execute`, {
      method: "POST",
      body: {},
    });
    assert.equal(executed.response.status, 200);
    assert.equal(executed.body.started, true);

    const finished = await waitForTask(fixture.baseUrl, taskId, (task) => (
      task.executionState === "completed" || task.executionState === "failed"
    ));
    assert.equal(finished.executionState, "completed");
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

    const executing = await waitForTask(fixture.baseUrl, taskId, (task) => task.executionState === "running");
    assert.equal(executing.executionState, "running");
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
    await request(fixture.baseUrl, `/api/tasks/${taskId}/claim`, {
      method: "POST",
      body: { agentId: "builder", ownerSessionId: "auto-execute-test", ttlSeconds: 900 },
    });
    await waitForTask(fixture.baseUrl, taskId, (task) => task.executionState === "running");
    await waitForTask(fixture.baseUrl, taskId, (task) => task.executionState === "completed" || task.executionState === "failed");

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
    await waitForTask(fixture.baseUrl, taskId, (task) => task.executionState === "running");

    const afterThreads = await request(fixture.baseUrl, "/api/local/ai/threads");
    const afterTaskThreads = afterThreads.body.threads.filter((thread) => thread.origin.issueId === taskId);
    const runningNow = afterTaskThreads.filter((thread) => thread.status === "running" && thread.currentRun);
    assert.equal(runningNow.length, 1, "exactly one running thread after re-execution");
    assert.equal(runningNow[0].id, taskThreads[0].id, "re-execution must reuse the existing thread");
  } finally {
    await fixture.close();
  }
});

test("auto-execute failure posts a failure comment and stops retrying after the cap", async () => {
  const fixture = await createServerFixture({ failCodex: true });
  try {
    await request(fixture.baseUrl, "/api/agents", {
      method: "POST",
      body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
    });
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: { projectId: "local", title: "Failing task", status: "todo", labels: ["frontend"] },
    });
    const taskId = created.body.task.id;

    async function waitForFailureComments(minimum, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      let failure = [];
      while (Date.now() < deadline) {
        const comments = await request(fixture.baseUrl, `/api/tasks/${taskId}/comments`);
        failure = comments.body.comments.filter((comment) => comment.body.includes("自动执行失败"));
        if (failure.length >= minimum) return failure;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return failure;
    }

    // First claim starts a headless turn that fails; the failure reason is
    // posted on the task instead of the board silently looking stalled.
    await request(fixture.baseUrl, `/api/tasks/${taskId}/claim`, {
      method: "POST",
      body: { agentId: "builder", ownerSessionId: "auto-execute-fail", ttlSeconds: 900 },
    });
    let failureComments = await waitForFailureComments(1);
    assert.ok(failureComments.length >= 1, "a failure comment should be posted");
    assert.match(failureComments[0].body, /fixture forced failure/);
    const afterFirst = await request(fixture.baseUrl, `/api/tasks/${taskId}`);
    assert.equal(afterFirst.body.task.executionState, "failed");

    // Second trigger is still under the retry cap: a fresh turn is started.
    const second = await request(fixture.baseUrl, `/api/tasks/${taskId}/execute`, {
      method: "POST",
      body: {},
    });
    assert.equal(second.body.started, true);
    failureComments = await waitForFailureComments(2);
    assert.ok(failureComments.length >= 2, "a second failure comment should be posted");

    // Third trigger exceeds the cap: auto-execute is stopped and the task is
    // left for manual execution instead of re-triggering forever.
    const third = await request(fixture.baseUrl, `/api/tasks/${taskId}/execute`, {
      method: "POST",
      body: {},
    });
    assert.equal(third.body.started, false);
    assert.equal(third.body.reason, "auto-execute-stopped");
  } finally {
    await fixture.close();
  }
});
