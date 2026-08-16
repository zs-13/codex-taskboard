import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { runAgentRunnerOnce } from "../scripts/taskboard-agent-runner.mjs";

const FAKE_CODEX = `#!/usr/bin/env node
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
`;

async function createServerFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-recover-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  const codexExecutable = path.join(directory, "fake-codex.mjs");
  await writeFile(codexExecutable, FAKE_CODEX);
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
    directory,
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

async function createAgentAndTask(baseUrl, overrides = {}) {
  await request(baseUrl, "/api/agents", {
    method: "POST",
    body: { id: "builder", name: "Builder", skills: ["frontend"], workspacePath: null },
  });
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "local",
      title: "Stuck task",
      status: "todo",
      priority: "medium",
      labels: ["frontend"],
      ...overrides,
    },
  });
  return created.body.task;
}

// Force an execution state on a task directly (default: the old fake-execution
// state — pre-claimed in_progress, marked completed, lock expired, no active
// turn).
function forceTaskState(directory, taskId, overrides = {}) {
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const fields = {
    status: "in_progress",
    lock_owner: "builder",
    lock_expires_at: past,
    execution_state: "completed",
    thread_id: null,
    ...overrides,
  };
  database.database.prepare(`
    UPDATE tasks
    SET status = ?, lock_owner = ?, lock_expires_at = ?,
      execution_state = ?, thread_id = ?, version = version + 1, updated_at = ?
    WHERE id = ?
  `).run(
    fields.status,
    fields.lock_owner,
    fields.lock_expires_at,
    fields.execution_state,
    fields.thread_id,
    past,
    taskId,
  );
  database.close();
}

test("recover resets a fake-executed stuck task back to the claimable pool", async () => {
  const fixture = await createServerFixture();
  try {
    const task = await createAgentAndTask(fixture.baseUrl);
    forceTaskState(fixture.directory, task.id);

    const recovered = await request(fixture.baseUrl, `/api/tasks/${task.id}/recover`, {
      method: "POST",
      body: {},
    });
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.body.recovered, true);
    assert.equal(recovered.body.task.status, "todo");
    assert.equal(recovered.body.task.lockOwner, null);
    assert.equal(recovered.body.task.executionState, "idle");
  } finally {
    await fixture.close();
  }
});

test("recover refuses a task with a live execution state", async () => {
  const fixture = await createServerFixture();
  try {
    const task = await createAgentAndTask(fixture.baseUrl);
    // A task being executed right now: running execution state, no thread yet.
    forceTaskState(fixture.directory, task.id, {
      execution_state: "running",
      lock_owner: null,
    });

    const recovered = await request(fixture.baseUrl, `/api/tasks/${task.id}/recover`, {
      method: "POST",
      body: {},
    });
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.body.recovered, false);
    assert.equal(recovered.body.reason, "not-stuck");
  } finally {
    await fixture.close();
  }
});

test("recover refuses a task that still holds a valid lock", async () => {
  const fixture = await createServerFixture();
  try {
    const task = await createAgentAndTask(fixture.baseUrl);
    // Completed execution state but the pre-claim lock is still valid: the
    // executor may still be finishing up; do not reset.
    forceTaskState(fixture.directory, task.id, {
      lock_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const recovered = await request(fixture.baseUrl, `/api/tasks/${task.id}/recover`, {
      method: "POST",
      body: {},
    });
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.body.recovered, false);
    assert.equal(recovered.body.reason, "valid-lock");
    assert.equal(recovered.body.task.status, "in_progress");
  } finally {
    await fixture.close();
  }
});

test("recover refuses a task that is bound to a conversation", async () => {
  const fixture = await createServerFixture();
  try {
    const task = await createAgentAndTask(fixture.baseUrl);
    // Completed execution with a conversation binding: a headless turn claimed
    // it via taskctl move (which does not take a lock). It executed — keep it.
    forceTaskState(fixture.directory, task.id, {
      lock_owner: null,
      thread_id: "codex-thread-1",
    });

    const recovered = await request(fixture.baseUrl, `/api/tasks/${task.id}/recover`, {
      method: "POST",
      body: {},
    });
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.body.recovered, false);
    assert.equal(recovered.body.reason, "bound");
    assert.equal(recovered.body.task.status, "in_progress");
  } finally {
    await fixture.close();
  }
});

test("the agent runner recovers a stuck task and re-triggers execution in the same pass", async () => {
  const fixture = await createServerFixture();
  try {
    const task = await createAgentAndTask(fixture.baseUrl);
    forceTaskState(fixture.directory, task.id);

    const result = await runAgentRunnerOnce({ baseUrl: fixture.baseUrl, ownerSessionId: "test-runner", maxClaims: 2 });
    const types = result.actions.map((action) => action.type);
    assert.ok(types.includes("recovered"), `expected a recovered action, got ${types.join(", ")}`);
    assert.ok(types.includes("agent-claimed"), `expected the recovered task to be re-triggered, got ${types.join(", ")}`);

    const updated = await request(fixture.baseUrl, `/api/tasks/${task.id}`);
    assert.equal(updated.body.task.status, "todo", "the headless turn claims the task itself; the runner must not pre-claim it");
    assert.equal(updated.body.task.lockOwner, null);
    assert.equal(updated.body.task.assignedAgentId, "builder");
  } finally {
    await fixture.close();
  }
});
