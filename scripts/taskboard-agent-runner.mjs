#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_RUNTIME_FILE = process.env.CODEX_TASKBOARD_RUNTIME_FILE || ".data/launcher-runtime.json";
const DEFAULT_OWNER_SESSION = `taskboard-agent-runner-${process.pid}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function readRuntimeUrl(runtimeFile) {
  try {
    const descriptor = JSON.parse(await readFile(runtimeFile, "utf8"));
    return typeof descriptor.url === "string" ? descriptor.url : null;
  } catch {
    return null;
  }
}

export async function resolveRunnerBaseUrl(options = {}) {
  const explicit = normalizeBaseUrl(options.baseUrl || process.env.CODEX_TASKBOARD_URL);
  if (explicit) return explicit;

  const runtimeUrl = await readRuntimeUrl(options.runtimeFile || DEFAULT_RUNTIME_FILE);
  if (runtimeUrl) return normalizeBaseUrl(runtimeUrl);

  const port = process.env.PORT || process.env.CODEX_TASKBOARD_PORT || "47823";
  const token = process.env.CODEX_TASKBOARD_INSTANCE_TOKEN;
  const tokenPath = token ? `/${encodeURIComponent(token)}` : "";
  return `http://127.0.0.1:${port}${tokenPath}`;
}

async function api(baseUrl, pathname, options = {}) {
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
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const code = body?.error?.code || response.status;
    const message = body?.error?.message || response.statusText;
    const error = new Error(`${code}: ${message}`);
    error.status = response.status;
    error.code = body?.error?.code;
    error.body = body;
    throw error;
  }
  return body;
}

function isClaimable(task) {
  return task
    && task.status === "todo"
    && task.archivedAt == null
    && task.blocked !== true
    && !task.lockOwner
    && task.controlStatus !== "paused"
    && task.controlStatus !== "terminated";
}

async function listOpenTasks(baseUrl) {
  const { projects } = await api(baseUrl, "/api/projects");
  const allTasks = [];
  for (const project of projects) {
    const params = new URLSearchParams({ projectId: project.id, archived: "false" });
    const { tasks } = await api(baseUrl, `/api/tasks?${params}`);
    allTasks.push(...tasks);
  }
  return allTasks;
}

async function comment(baseUrl, taskId, body) {
  return api(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}/comments`, {
    method: "POST",
    body: { body },
  });
}

async function claim(baseUrl, task, agentId, ownerSessionId, ttlSeconds) {
  return api(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}/claim`, {
    method: "POST",
    body: { agentId, ownerSessionId, ttlSeconds },
  });
}

async function runSquadStep(baseUrl, task) {
  return api(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}/autonomous-step`, {
    method: "POST",
    body: {},
  });
}

export async function runAgentRunnerOnce(options = {}) {
  const baseUrl = await resolveRunnerBaseUrl(options);
  const ownerSessionId = options.ownerSessionId || process.env.CODEX_TASKBOARD_AGENT_RUNNER_SESSION || DEFAULT_OWNER_SESSION;
  const ttlSeconds = Number(options.ttlSeconds || process.env.CODEX_TASKBOARD_AGENT_LOCK_TTL || 900);
  const maxClaims = Number(options.maxClaims || process.env.CODEX_TASKBOARD_AGENT_MAX_CLAIMS || 3);
  const reportSkips = options.reportSkips ?? true;
  const actions = [];
  let claimedCount = 0;

  const { agents } = await api(baseUrl, "/api/agents");
  if (!Array.isArray(agents) || agents.length === 0) {
    return { baseUrl, actions, skipped: "no-agents" };
  }

  const tasks = (await listOpenTasks(baseUrl)).filter(isClaimable);
  for (const task of tasks) {
    if (claimedCount >= maxClaims) break;
    try {
      if (task.squadId && !task.assignedAgentId) {
        const { task: updated } = await runSquadStep(baseUrl, task);
        await comment(
          baseUrl,
          updated.id,
          "小队自动执行器已接管：队长开始拆解任务、分配成员，并持续推进到可审核状态。",
        );
        actions.push({ type: "squad-step", taskId: updated.id, identifier: updated.identifier, squadId: updated.squadId });
        claimedCount += 1;
        continue;
      }

      const { task: claimed } = await claim(baseUrl, task, task.assignedAgentId ?? null, ownerSessionId, ttlSeconds);
      const autoExecute = claimed.autoExecute ?? (process.env.CODEX_TASKBOARD_AUTO_EXECUTE ?? "1") !== "0";
      await comment(
        baseUrl,
        claimed.id,
        autoExecute
          ? `@${claimed.assignedAgentId} 自动认领成功：已自动开始执行，进度评论会实时出现在这里。`
          : `@${claimed.assignedAgentId} 自动认领成功：已进入待执行状态，可在「在对话中打开」手动开始。`,
      );
      actions.push({
        type: "agent-claimed",
        taskId: claimed.id,
        identifier: claimed.identifier,
        agentId: claimed.assignedAgentId,
        autoExecute,
      });
      claimedCount += 1;
    } catch (error) {
      if (["NO_SKILL_MATCH", "DEPENDENCY_PENDING", "TASK_LOCKED", "TASK_ALREADY_ASSIGNED"].includes(error.code)) {
        if (reportSkips) {
          actions.push({ type: "skipped", taskId: task.id, identifier: task.identifier, reason: error.code });
        }
        continue;
      }
      throw error;
    }
  }

  return { baseUrl, actions };
}

async function main() {
  const watch = process.argv.includes("--watch");
  const intervalArg = process.argv.find((arg) => arg.startsWith("--interval-ms="));
  const intervalMs = intervalArg ? Number(intervalArg.split("=", 2)[1]) : DEFAULT_INTERVAL_MS;
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });

  do {
    try {
      const result = await runAgentRunnerOnce({ reportSkips: !watch });
      if (result.actions.length > 0 || !watch) {
        console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        at: new Date().toISOString(),
        error: error.message,
        code: error.code || null,
      }));
    }
    if (watch && !stopping) await sleep(Number.isFinite(intervalMs) && intervalMs >= 1000 ? intervalMs : DEFAULT_INTERVAL_MS);
  } while (watch && !stopping);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
