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
