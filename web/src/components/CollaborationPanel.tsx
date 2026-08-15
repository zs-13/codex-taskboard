import { useEffect, useMemo, useState } from "react";
import {
  addTaskDependency,
  assignTask,
  claimTask,
  controlTask,
  createSkillTemplate,
  createSquad,
  listAgents,
  listGlobalActivities,
  listSkillTemplates,
  listSquads,
  runAutonomousSquadStep,
  saveAgent,
  setTaskBlocked,
  submitTaskCommand,
} from "../api";
import type { AgentProfile, GlobalActivity, SkillTemplate, Squad, Task } from "../types";
import { useTaskboardI18n } from "../i18n";
import { LinearIcon } from "./LinearIcon";

interface CollaborationPanelProps {
  projectId: string;
  tasks: Task[];
  onCreateTask: () => void;
  onRefresh: () => Promise<void>;
  onError: (message: string | readonly [string, string] | null) => void;
}

function tags(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function fieldDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function CollaborationPanel({
  projectId,
  tasks,
  onCreateTask,
  onRefresh,
  onError,
}: CollaborationPanelProps) {
  const { text } = useTaskboardI18n();
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [squads, setSquads] = useState<Squad[]>([]);
  const [skills, setSkills] = useState<SkillTemplate[]>([]);
  const [activities, setActivities] = useState<GlobalActivity[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("Codex Builder");
  const [agentTags, setAgentTags] = useState("frontend, backend, sqlite");
  const [agentWorkspace, setAgentWorkspace] = useState("");
  const [squadName, setSquadName] = useState("Delivery Squad");
  const [squadTags, setSquadTags] = useState("planning, implementation, review");
  const [skillName, setSkillName] = useState("Delivery checklist");
  const [skillBody, setSkillBody] = useState("Break down the task, assign owners, report progress, self-check, then move to review.");
  const [taskId, setTaskId] = useState("");
  const [dependencyId, setDependencyId] = useState("");
  const [blockReason, setBlockReason] = useState("Waiting on external input");
  const [command, setCommand] = useState("/task new");

  const selectableTasks = useMemo(
    () => tasks.filter((task) => task.projectId === projectId && task.archivedAt === null),
    [projectId, tasks],
  );
  const selectedTask = selectableTasks.find((task) => task.id === taskId) ?? selectableTasks[0] ?? null;
  const selectedAgent = agents[0] ?? null;
  const selectedSquad = squads[0] ?? null;

  async function reload(signal?: AbortSignal) {
    const [nextAgents, nextSquads, nextSkills, nextActivities] = await Promise.all([
      listAgents(signal),
      listSquads(signal),
      listSkillTemplates(signal),
      listGlobalActivities(signal),
    ]);
    setAgents(nextAgents);
    setSquads(nextSquads);
    setSkills(nextSkills);
    setActivities(nextActivities);
  }

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void reload(controller.signal).catch((error) => {
      if ((error as Error).name !== "AbortError") onError(error instanceof Error ? error.message : "Could not load collaboration data.");
    });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (selectedTask && !taskId) setTaskId(selectedTask.id);
  }, [selectedTask, taskId]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    onError(null);
    try {
      await action();
      await Promise.all([reload(), onRefresh()]);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={`collab-panel${open ? " is-open" : ""}`} aria-label={text("小队协作", "Squad collaboration")}>
      <div className="collab-panel-bar">
        <button className="button primary collab-new-task" type="button" onClick={onCreateTask} title={text("新建任务", "Create task")}>
          <LinearIcon name="plus" />
          <span>{text("+ 新建任务", "+ New task")}</span>
        </button>
        <button className="button secondary" type="button" onClick={() => setOpen((current) => !current)}>
          <LinearIcon name="myIssues" />
          <span>{open ? text("收起协作", "Hide collaboration") : text("小队 / Agent", "Squads / Agents")}</span>
        </button>
        <button
          className="button secondary"
          type="button"
          onClick={() => void run("command", async () => {
            const result = await submitTaskCommand(command);
            onError(result.recommendation);
          })}
        >
          <LinearIcon name="write" />
          <span>{text("/task new", "/task new")}</span>
        </button>
        <input value={command} onChange={(event) => setCommand(event.target.value)} aria-label="Task command" />
      </div>

      {open && (
        <div className="collab-panel-body">
          <div className="collab-section">
            <h2>{text("Agent 档案", "Agent profiles")}</h2>
            <label>
              <span>{text("名称", "Name")}</span>
              <input value={agentName} onChange={(event) => setAgentName(event.target.value)} />
            </label>
            <label>
              <span>{text("技能标签", "Skill tags")}</span>
              <input value={agentTags} onChange={(event) => setAgentTags(event.target.value)} />
            </label>
            <label>
              <span>{text("工作目录", "Workspace")}</span>
              <input value={agentWorkspace} onChange={(event) => setAgentWorkspace(event.target.value)} />
            </label>
            <button
              className="button primary"
              type="button"
              disabled={busy !== null || !agentName.trim()}
              onClick={() => void run("agent", async () => {
                await saveAgent({
                  id: agentName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || undefined,
                  name: agentName,
                  skills: tags(agentTags),
                  workspacePath: agentWorkspace || null,
                });
              })}
            >
              {busy === "agent" ? text("保存中...", "Saving...") : text("保存 Agent", "Save agent")}
            </button>
          </div>

          <div className="collab-section">
            <h2>{text("小队管理", "Squads")}</h2>
            <label>
              <span>{text("小队名称", "Squad name")}</span>
              <input value={squadName} onChange={(event) => setSquadName(event.target.value)} />
            </label>
            <label>
              <span>{text("路由标签", "Routing tags")}</span>
              <input value={squadTags} onChange={(event) => setSquadTags(event.target.value)} />
            </label>
            <button
              className="button primary"
              type="button"
              disabled={busy !== null || agents.length === 0 || !squadName.trim()}
              onClick={() => void run("squad", async () => {
                const leader = agents[0];
                await createSquad({
                  name: squadName,
                  leaderAgentId: leader.id,
                  memberAgentIds: agents.slice(1).map((agent) => agent.id),
                  skillTags: tags(squadTags),
                });
              })}
            >
              {busy === "squad" ? text("创建中...", "Creating...") : text("创建小队", "Create squad")}
            </button>
            <p>{text(`当前 ${agents.length} 个 Agent / ${squads.length} 个小队`, `${agents.length} agents / ${squads.length} squads`)}</p>
          </div>

          <div className="collab-section">
            <h2>{text("任务管控", "Task control")}</h2>
            <label>
              <span>{text("任务", "Task")}</span>
              <select value={selectedTask?.id ?? ""} onChange={(event) => setTaskId(event.target.value)}>
                {selectableTasks.map((task) => (
                  <option value={task.id} key={task.id}>{task.identifier} - {task.title}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{text("前置依赖", "Dependency")}</span>
              <select value={dependencyId} onChange={(event) => setDependencyId(event.target.value)}>
                <option value="">{text("未选择", "None")}</option>
                {selectableTasks.filter((task) => task.id !== selectedTask?.id).map((task) => (
                  <option value={task.id} key={task.id}>{task.identifier} - {task.title}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{text("阻塞原因", "Block reason")}</span>
              <input value={blockReason} onChange={(event) => setBlockReason(event.target.value)} />
            </label>
            <div className="collab-actions">
              <button className="button secondary" type="button" disabled={!selectedTask || !selectedAgent || busy !== null} onClick={() => void run("assign", async () => {
                await assignTask(selectedTask!, { agentId: selectedAgent!.id, squadId: selectedSquad?.id ?? null });
              })}>{text("指派", "Assign")}</button>
              <button className="button primary" type="button" disabled={!selectedTask || busy !== null} onClick={() => void run("claim", async () => {
                await claimTask(selectedTask!, selectedAgent?.id ?? null);
              })}>{text("Agent 认领执行", "Agent claim")}</button>
              <button className="button secondary" type="button" disabled={!selectedTask || !dependencyId || busy !== null} onClick={() => void run("dependency", async () => {
                await addTaskDependency(selectedTask!, dependencyId);
              })}>{text("添加依赖", "Add dependency")}</button>
              <button className="button secondary" type="button" disabled={!selectedTask || busy !== null} onClick={() => void run("block", async () => {
                await setTaskBlocked(selectedTask!, true, blockReason);
              })}>{text("标记阻塞", "Block")}</button>
              <button className="button secondary" type="button" disabled={!selectedTask || busy !== null} onClick={() => void run("active", async () => {
                await setTaskBlocked(selectedTask!, false, "");
              })}>{text("解除阻塞", "Unblock")}</button>
              <button className="button secondary" type="button" disabled={!selectedTask || busy !== null} onClick={() => void run("pause", async () => {
                await controlTask(selectedTask!, "paused");
              })}>{text("暂停", "Pause")}</button>
              <button className="button danger" type="button" disabled={!selectedTask || busy !== null} onClick={() => void run("terminate", async () => {
                await controlTask(selectedTask!, "terminated");
              })}>{text("终止", "Terminate")}</button>
              <button className="button primary" type="button" disabled={!selectedTask || !selectedSquad || busy !== null} onClick={() => void run("autonomous", async () => {
                await runAutonomousSquadStep(selectedTask!);
              })}>{text("小队自主推进", "Run squad")}</button>
            </div>
          </div>

          <div className="collab-section">
            <h2>{text("技能模板", "Skill templates")}</h2>
            <label>
              <span>{text("模板名称", "Template name")}</span>
              <input value={skillName} onChange={(event) => setSkillName(event.target.value)} />
            </label>
            <textarea rows={3} value={skillBody} onChange={(event) => setSkillBody(event.target.value)} />
            <button className="button primary" type="button" disabled={busy !== null || !skillName.trim()} onClick={() => void run("skill", async () => {
              await createSkillTemplate({
                name: skillName,
                description: "Reusable autonomous workflow",
                body: skillBody,
                skillTags: tags(squadTags),
              });
            })}>{text("保存为技能模板", "Save skill template")}</button>
            <p>{text(`已保存 ${skills.length} 个模板`, `${skills.length} templates saved`)}</p>
          </div>

          <div className="collab-section collab-timeline">
            <h2>{text("全局活动时间线", "Activity timeline")}</h2>
            <ol>
              {activities.slice(0, 8).map((activity) => (
                <li key={activity.id}>
                  <span>{fieldDate(activity.createdAt)}</span>
                  <strong>{activity.eventType}</strong>
                  <p>{activity.message}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}
