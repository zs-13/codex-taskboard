import { useEffect, useMemo, useRef, useState } from "react";
import {
  addTaskDependency,
  assignTask,
  authorizeCliTool,
  claimTask,
  controlTask,
  createSkillTemplate,
  createSquad,
  listAgents,
  listCliTools,
  listGlobalActivities,
  listSkillTemplates,
  listSquads,
  revokeCliTool,
  runAutonomousSquadStep,
  saveAgent,
  setTaskBlocked,
  submitTaskCommand,
  updateSquad,
  type CliTool,
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

type DeckZone = "agents" | "squads" | "tasks";
type SquadWizardStep = 1 | 2 | 3;

interface ToolCandidate {
  id: string;
  name: string;
  kind: "cli" | "manual";
  authorized: boolean;
  installed: boolean;
  signedIn: boolean | null;
  skills: string[];
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

function agentInitial(agent: AgentProfile): string {
  return (agent.name.trim()[0] ?? "?").toUpperCase();
}

function taskCountForSquad(squads: Squad[], tasks: Task[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const squad of squads) {
    counts[squad.id] = tasks.filter((task) => task.squadId === squad.id).length;
  }
  return counts;
}

function toolName(agent: AgentProfile): string {
  return agent.name.trim();
}

const ZONE_ORDER: Array<{ id: DeckZone; labelZh: string; labelEn: string; icon: "terminal" | "branch" | "play" }> = [
  { id: "agents", labelZh: "我的工具", labelEn: "My tools", icon: "terminal" },
  { id: "squads", labelZh: "小组", labelEn: "Teams", icon: "branch" },
  { id: "tasks", labelZh: "派活", labelEn: "Assign", icon: "play" },
];

export function CollaborationPanel({
  projectId,
  tasks,
  onCreateTask,
  onRefresh,
  onError,
}: CollaborationPanelProps) {
  const { text } = useTaskboardI18n();
  const [zone, setZone] = useState<DeckZone>("agents");
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [cliTools, setCliTools] = useState<CliTool[]>([]);
  const [cliScanning, setCliScanning] = useState(false);
  const [cliScanUnavailable, setCliScanUnavailable] = useState(false);
  const [squads, setSquads] = useState<Squad[]>([]);
  const [skills, setSkills] = useState<SkillTemplate[]>([]);
  const [activities, setActivities] = useState<GlobalActivity[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentTags, setAgentTags] = useState("");
  const [agentWorkspace, setAgentWorkspace] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<SquadWizardStep>(1);
  const [squadName, setSquadName] = useState("");
  const [squadTags, setSquadTags] = useState("");
  const [squadLeaderId, setSquadLeaderId] = useState("");
  const [squadMemberIds, setSquadMemberIds] = useState<string[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pendingAuthorizeTool, setPendingAuthorizeTool] = useState<CliTool | null>(null);
  const [managingSquadId, setManagingSquadId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState("");
  const [dependencyId, setDependencyId] = useState("");
  const [blockReason, setBlockReason] = useState("");
  const [blockModalTaskId, setBlockModalTaskId] = useState<string | null>(null);
  const [assignModalTaskId, setAssignModalTaskId] = useState<string | null>(null);
  const [assignAgentId, setAssignAgentId] = useState("");
  const [assignSquadId, setAssignSquadId] = useState("");
  const [command, setCommand] = useState("/task new");
  const activityListRef = useRef<HTMLOListElement>(null);
  const toastTimerRef = useRef<number | null>(null);

  const selectableTasks = useMemo(
    () => tasks.filter((task) => task.projectId === projectId && task.archivedAt === null),
    [projectId, tasks],
  );
  const selectedTask = selectableTasks.find((task) => task.id === taskId) ?? selectableTasks[0] ?? null;
  const managingSquad = squads.find((squad) => squad.id === managingSquadId) ?? null;
  const assignTaskTarget = selectableTasks.find((task) => task.id === assignModalTaskId) ?? selectedTask ?? null;
  const blockTaskTarget = selectableTasks.find((task) => task.id === blockModalTaskId) ?? selectedTask ?? null;
  const squadCounts = taskCountForSquad(squads, selectableTasks);

  // Merge registered agents and detected CLI tools into one member-picker list.
  const toolCandidates: ToolCandidate[] = useMemo(() => {
    const manual: ToolCandidate[] = agents.map((agent) => ({
      id: agent.id,
      name: toolName(agent),
      kind: "manual" as const,
      authorized: true,
      installed: true,
      signedIn: true,
      skills: agent.skills,
    }));
    const manualIds = new Set(agents.map((agent) => agent.id));
    const cli: ToolCandidate[] = cliTools
      .filter((tool) => !manualIds.has(tool.name))
      .map((tool) => ({
        id: tool.name,
        name: tool.name,
        kind: "cli" as const,
        authorized: tool.authorized,
        installed: tool.installed,
        signedIn: tool.signedIn,
        skills: [],
      }));
    return [...cli, ...manual];
  }, [agents, cliTools]);

  const cliCandidates = toolCandidates.filter((candidate) => candidate.kind === "cli");
  const manualCandidates = toolCandidates.filter((candidate) => candidate.kind === "manual");

  function showToast(message: string) {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
  }

  async function loadCliTools(signal?: AbortSignal) {
    setCliScanning(true);
    try {
      const tools = await listCliTools(signal);
      setCliTools(tools);
      setCliScanUnavailable(false);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setCliTools([]);
        setCliScanUnavailable(true);
      }
    } finally {
      if (!signal?.aborted) setCliScanning(false);
    }
  }

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
    const controller = new AbortController();
    void reload(controller.signal).catch((error) => {
      if ((error as Error).name !== "AbortError") onError(error instanceof Error ? error.message : "Could not load collaboration data.");
    });
    void loadCliTools(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (selectedTask && !taskId) setTaskId(selectedTask.id);
  }, [selectedTask, taskId]);

  // Auto-scroll the activity feed to the newest entry.
  useEffect(() => {
    const list = activityListRef.current;
    if (list && zone === "tasks") list.scrollTop = list.scrollHeight;
  }, [activities, zone]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  async function run(label: string, action: () => Promise<void>, successToast?: string) {
    setBusy(label);
    onError(null);
    try {
      await action();
      await Promise.all([reload(), onRefresh()]);
      if (successToast) showToast(successToast);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Action failed.";
      if (error instanceof Error && error.name === "ApiError") {
        onError(message);
      } else {
        showToast(message);
      }
    } finally {
      setBusy(null);
    }
  }

  function startWizard() {
    setSquadName("");
    setSquadTags("");
    const firstEnabled = toolCandidates.find((candidate) => candidate.authorized) ?? toolCandidates[0];
    setSquadLeaderId(firstEnabled?.id ?? "");
    setSquadMemberIds([]);
    setWizardStep(1);
    setAdvancedOpen(false);
    setWizardOpen(true);
  }

  function toggleMember(memberId: string) {
    setSquadMemberIds((current) => (
      current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId]
    ));
  }

  function selectMember(candidate: ToolCandidate) {
    if (!candidate.authorized) {
      const cliTool = cliTools.find((tool) => tool.name === candidate.id);
      if (cliTool) {
        setPendingAuthorizeTool(cliTool);
        return;
      }
    }
    toggleMember(candidate.id);
  }

  async function confirmAuthorize(tool: CliTool) {
    setPendingAuthorizeTool(null);
    await run("authorize", async () => {
      const updated = await authorizeCliTool(tool.name);
      setCliTools((current) => current.map((entry) => entry.name === tool.name ? updated : entry));
      const toolCandidate = toolCandidates.find((candidate) => candidate.id === tool.name);
      if (toolCandidate && !squadMemberIds.includes(tool.name)) {
        setSquadMemberIds((current) => [...current, tool.name]);
      }
    }, text("好，codex 可以开始干活了。", "OK, it can start working."));
  }

  const defaultLeaderLabel = text("（自动选第一个已启用的工具）", " (auto-picks first enabled tool)");

  return (
    <section className="collab-panel is-open" aria-label={text("小组协作", "Team collaboration")}>
      <div className="collab-panel-bar">
        <button className="button primary collab-new-task" type="button" onClick={onCreateTask} title={text("新建任务", "Create task")}>
          <LinearIcon name="plus" />
          <span>{text("+ 新建任务", "+ New task")}</span>
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

      <div className="collab-panel-body">
          <div className="collab-zone-tabs" role="tablist" aria-label={text("小组协作分区", "Team deck zones")}>
            {ZONE_ORDER.map(({ id, labelZh, labelEn, icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={zone === id}
                className={`collab-zone-tab${zone === id ? " active" : ""}`}
                onClick={() => setZone(id)}
              >
                <LinearIcon name={icon} />
                <span>{text(labelZh, labelEn)}</span>
              </button>
            ))}
          </div>

          {zone === "agents" && (
            <div className="collab-zone collab-agents">
              <div className="collab-zone-head">
                <h2>{text("我的工具", "My tools")}</h2>
                <button className="button secondary compact" type="button" onClick={() => setRegisterOpen(true)}>
                  <LinearIcon name="plus" />
                  <span>{text("手动添加", "Add manually")}</span>
                </button>
              </div>

              <div className="collab-scan-bar" role="status">
                {cliScanning ? (
                  <span className="collab-scan-message">{text("正在检查你电脑里的工具…", "Checking tools on your computer…")}</span>
                ) : cliScanUnavailable ? (
                  <span className="collab-scan-message muted">{text("本机工具检测暂不可用（后端未就绪）。", "Local tool detection is unavailable (backend pending).")}</span>
                ) : (
                  <span className="collab-scan-message">{text(`已发现 ${cliCandidates.length} 个本机工具`, `Found ${cliCandidates.length} local tools`)}</span>
                )}
                <button className="button secondary compact" type="button" disabled={cliScanning} onClick={() => void loadCliTools()}>
                  <LinearIcon name="recurrence" />
                  <span>{text("刷新", "Refresh")}</span>
                </button>
              </div>

              {toolCandidates.length === 0 ? (
                <div className="collab-empty">
                  <p>{text("没找到本机工具。你可以手动添加一个，或者跳过这步直接建组。", "No local tools found. Add one manually, or skip this and create a team.")}</p>
                  <div className="collab-empty-actions">
                    <button className="button primary" type="button" onClick={() => setRegisterOpen(true)}>{text("手动添加", "Add manually")}</button>
                    <button className="button secondary" type="button" onClick={() => setZone("squads")}>{text("跳过，先建组", "Skip, create team")}</button>
                  </div>
                </div>
              ) : (
                <>
                  {cliCandidates.length > 0 && (
                    <div className="collab-tool-group">
                      <span className="collab-tool-group-title">{text("本机工具（自动发现）", "Local tools (auto-detected)")}</span>
                      <ul className="collab-agent-grid">
                        {cliCandidates.map((candidate) => (
                          <li className="collab-agent-chip" key={candidate.id}>
                            <span className="collab-avatar collab-avatar-terminal" aria-hidden="true"><LinearIcon name="terminal" /></span>
                            <span className="collab-agent-chip-name">{candidate.name}</span>
                            <span className="collab-tool-meta">
                              <span
                                className={`collab-tool-dot ${candidate.installed && candidate.signedIn !== false ? "is-ready" : candidate.installed ? "is-pending" : "is-missing"}`}
                                aria-hidden="true"
                              />
                              <span>{candidate.installed
                                ? (candidate.signedIn === false ? text("已安装未登录", "Installed, not signed in") : candidate.authorized ? text("已启用", "Enabled") : text("未启用", "Not enabled"))
                                : text("未安装", "Not installed")}</span>
                            </span>
                            {candidate.installed && <span className="collab-badge-auto">{text("自动识别", "Auto-detected")}</span>}
                            {candidate.installed && candidate.signedIn === false && (
                              <button
                                className="collab-login-hint"
                                type="button"
                                onClick={() => {
                                  if (candidate.authorized) {
                                    showToast(text(`打开 ${candidate.name} 登录…`, `Open ${candidate.name} to sign in…`));
                                  }
                                }}
                              >
                                {text("装好了但还没登录，点这里打开它登录", "Installed but not signed in — click to sign in")}
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {manualCandidates.length > 0 && (
                    <div className="collab-tool-group">
                      <span className="collab-tool-group-title">{text("手动添加", "Added manually")}</span>
                      <ul className="collab-agent-grid">
                        {manualCandidates.map((candidate) => (
                          <li className="collab-agent-chip" key={candidate.id} title={candidate.skills.length ? candidate.skills.join(", ") : undefined}>
                            <span className="collab-avatar">{candidate.name.trim()[0]?.toUpperCase() ?? "?"}</span>
                            <span className="collab-agent-chip-name">{candidate.name}</span>
                            <span className="collab-agent-chip-skills">
                              {candidate.skills.length > 0 ? candidate.skills.slice(0, 3).join(" · ") : text("无擅长", "No skills")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {zone === "squads" && (
            <div className="collab-zone collab-squads">
              <div className="collab-zone-head">
                <h2>{text("我的小组", "My teams")}</h2>
                <button className="button secondary compact" type="button" onClick={startWizard} disabled={toolCandidates.length === 0 || busy !== null}>
                  <LinearIcon name="plus" />
                  <span>{text("新建小组", "New team")}</span>
                </button>
              </div>

              {!wizardOpen && squads.length === 0 && (
                <div className="collab-empty">
                  <p>{text("还没有小组。三步建一个：起个名字 → 拉人进来 → 确认，然后就能派活了。", "No teams yet. Three steps: give it a name → pick helpers → confirm, then you can assign work.")}</p>
                  <div className="collab-empty-actions">
                    <button className="button primary" type="button" onClick={startWizard} disabled={toolCandidates.length === 0 || busy !== null}>
                      {text("新建小组", "Create a team")}
                    </button>
                    {toolCandidates.length === 0 && (
                      <button className="button secondary" type="button" onClick={() => setRegisterOpen(true)}>{text("先添加一个工具", "Add a tool first")}</button>
                    )}
                  </div>
                </div>
              )}

              {wizardOpen && (
                <div className="collab-wizard">
                  <div className="collab-wizard-steps" aria-label={text("建组步骤", "Team creation steps")}>
                    {[1, 2, 3].map((step) => (
                      <span key={step} className={`collab-wizard-step${wizardStep === step ? " active" : ""}${wizardStep > step ? " done" : ""}`}>
                        {step}
                      </span>
                    ))}
                  </div>

                  {wizardStep === 1 && (
                    <div className="collab-wizard-screen">
                      <h3>{text("起个名字", "Give it a name")}</h3>
                      <label>
                        <span>{text("小组名称", "Team name")}</span>
                        <input
                          className="collab-wizard-name-input"
                          value={squadName}
                          onChange={(event) => setSquadName(event.target.value)}
                          placeholder={text("比如：我的文案小组", "e.g. My writing team")}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && squadName.trim()) setWizardStep(2);
                          }}
                        />
                      </label>
                      <button className="button primary" type="button" onClick={() => setWizardStep(2)}>
                        {text("下一步", "Next")}
                      </button>
                    </div>
                  )}

                  {wizardStep === 2 && (
                    <div className="collab-wizard-screen">
                      <h3>{text("拉人进来", "Pick helpers")}</h3>
                      <span className="collab-member-picker-label">
                        {squadMemberIds.length > 0
                          ? text(`已选 ${squadMemberIds.length} 个帮手`, `${squadMemberIds.length} helper(s) selected`)
                          : text("点击下面的工具或帮手，选好了就下一步", "Click tools or helpers below")}
                      </span>
                      <ul className="collab-member-picker">
                        {toolCandidates.map((candidate) => {
                          const selected = squadMemberIds.includes(candidate.id) || candidate.id === squadLeaderId;
                          return (
                            <li key={candidate.id}>
                              <button
                                type="button"
                                className={`collab-member-option${selected ? " selected" : ""}${candidate.installed === false ? " is-missing" : ""}${candidate.authorized === false ? " is-unauthorized" : ""}`}
                                aria-pressed={selected}
                                onClick={() => selectMember(candidate)}
                              >
                                {candidate.kind === "cli"
                                  ? <span className="collab-avatar collab-avatar-terminal" aria-hidden="true"><LinearIcon name="terminal" /></span>
                                  : <span className="collab-avatar">{candidate.name.trim()[0]?.toUpperCase() ?? "?"}</span>}
                                <span>{candidate.name}</span>
                                {candidate.kind === "cli" && candidate.installed && (
                                  <span className="collab-badge-auto small">{candidate.authorized ? text("已启用", "on") : text("未启用", "off")}</span>
                                )}
                                {candidate.kind === "cli" && !candidate.installed && (
                                  <span className="collab-badge-auto small missing">{text("未安装", "not installed")}</span>
                                )}
                                {selected && <LinearIcon name="check" />}
                              </button>
                            </li>
                          );
                        })}
                        {toolCandidates.length === 0 && (
                          <li className="collab-member-picker-empty">
                            {text("还没有帮手，先到「我的工具」添加一个。", "No helpers yet — add one under My tools first.")}
                          </li>
                        )}
                      </ul>
                      <label className="collab-wizard-leader">
                        <span>{text("组长（负责派活）", "Leader (assigns work)")}</span>
                        <select value={squadLeaderId} onChange={(event) => setSquadLeaderId(event.target.value)}>
                          {toolCandidates.map((candidate) => (
                            <option value={candidate.id} key={candidate.id}>{candidate.name}</option>
                          ))}
                        </select>
                      </label>
                      <div className="collab-wizard-actions">
                        <button className="button secondary" type="button" onClick={() => setWizardStep(1)}>{text("上一步", "Back")}</button>
                        <button className="button secondary" type="button" onClick={() => setWizardStep(3)}>{text("跳过，先建组", "Skip, create team")}</button>
                        <button className="button primary" type="button" onClick={() => setWizardStep(3)}>{text("下一步", "Next")}</button>
                      </div>
                    </div>
                  )}

                  {wizardStep === 3 && (
                    <div className="collab-wizard-screen">
                      <h3>{text("确认", "Confirm")}</h3>
                      <dl className="collab-wizard-summary">
                        <dt>{text("组名", "Name")}</dt><dd>{squadName}</dd>
                        <dt>{text("组长", "Leader")}</dt><dd>{toolCandidates.find((candidate) => candidate.id === squadLeaderId)?.name ?? defaultLeaderLabel}</dd>
                        <dt>{text("帮手", "Helpers")}</dt><dd>{squadMemberIds.length ? `${squadMemberIds.length} 人` : text("暂无", "none")}</dd>
                      </dl>
                      <details className="collab-advanced">
                        <summary onClick={(event) => { event.preventDefault(); setAdvancedOpen((current) => !current); }}>
                          {text("高级设置", "Advanced settings")}
                        </summary>
                        {advancedOpen && (
                          <div className="collab-advanced-body">
                            <label>
                              <span>{text("擅长什么（可选）", "Good at (optional)")}</span>
                              <input value={squadTags} onChange={(event) => setSquadTags(event.target.value)} placeholder={text("比如：写文案、改图", "e.g. writing, design")} />
                            </label>
                          </div>
                        )}
                      </details>
                      <div className="collab-wizard-actions">
                        <button className="button secondary" type="button" onClick={() => setWizardStep(2)}>{text("上一步", "Back")}</button>
                        <button
                          className="button primary"
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void run("squad-create", async () => {
                            await createSquad({
                              name: squadName.trim(),
                              leaderAgentId: squadLeaderId,
                              memberAgentIds: squadMemberIds,
                              skillTags: tags(squadTags),
                            });
                            setWizardOpen(false);
                          }, text("小组建好啦 🎉", "Team created 🎉"))}
                        >
                          {busy === "squad-create" ? text("创建中…", "Creating…") : text("创建小组", "Create team")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!wizardOpen && squads.length > 0 && (
                <ul className="collab-squad-list">
                  {squads.map((squad) => (
                    <li className="collab-squad-card" key={squad.id}>
                      <div className="collab-squad-card-head">
                        <span className="collab-squad-avatar-wrap">
                          <span className="collab-avatar">{squad.name.trim()[0]?.toUpperCase() ?? "?"}</span>
                          <span className="collab-leader-badge" title={text("组长", "Leader")}>
                            <LinearIcon name="branch" />
                          </span>
                        </span>
                        <div>
                          <strong>{squad.name}</strong>
                          <small>{text(`${squad.members.length} 人 · ${squadCounts[squad.id] ?? 0} 个任务`, `${squad.members.length} members · ${squadCounts[squad.id] ?? 0} tasks`)}</small>
                        </div>
                      </div>
                      <div className="collab-squad-tags">
                        {squad.skillTags.length > 0
                          ? squad.skillTags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)
                          : <span className="muted">{text("暂无擅长", "No tags")}</span>}
                      </div>
                      <div className="collab-squad-actions">
                        <button
                          className="button primary compact"
                          type="button"
                          disabled={selectableTasks.length === 0 || busy !== null}
                          onClick={() => {
                            // 让队长安排: route the first selectable task to this team's leader agent.
                            const target = selectableTasks[0];
                            if (target && squad.leaderAgentId) {
                              void run("assign", async () => {
                                await assignTask(target, { agentId: squad.leaderAgentId, squadId: squad.id });
                              }, text(`已经让 ${squad.name} 的组长安排了。`, `Assigned to ${squad.name}'s leader.`));
                            }
                          }}
                        >
                          <LinearIcon name="play" />
                          <span>{text("让队长安排", "Let leader handle")}</span>
                        </button>
                        <button className="button secondary compact" type="button" onClick={() => { setAssignSquadId(squad.id); setAssignAgentId(""); setAssignModalTaskId(selectableTasks[0]?.id ?? ""); }}>
                          <LinearIcon name="branch" />
                          <span>{text("管理成员", "Members")}</span>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {zone === "tasks" && (
            <div className="collab-zone collab-tasks">
              <div className="collab-zone-head">
                <h2>{text("派活", "Assign work")}</h2>
              </div>
              <label>
                <span>{text("任务", "Task")}</span>
                <select value={selectedTask?.id ?? ""} onChange={(event) => setTaskId(event.target.value)}>
                  {selectableTasks.map((task) => (
                    <option value={task.id} key={task.id}>{task.identifier} - {task.title}</option>
                  ))}
                </select>
              </label>
              {selectedTask && (
                <div className="collab-task-state">
                  <span className={`collab-task-state-dot status-${selectedTask.status}`} />
                  <span>{selectedTask.status}</span>
                  {selectedTask.assignedAgentId && <span> · {text("帮手", "helper")}: {selectedTask.assignedAgentId}</span>}
                  {selectedTask.squadId && <span> · {text("小组", "team")}</span>}
                </div>
              )}
              <div className="collab-actions">
                <button className="button primary" type="button" disabled={!selectedTask || busy !== null} onClick={() => void run("claim", async () => {
                  await claimTask(selectedTask!, null);
                }, text("已经让 TA 去干了。", "Assigned — it's on it."))}>{text("⚡ 让 TA 干", "⚡ Let it run")}</button>
                <button className="button secondary" type="button" disabled={!selectedTask || busy !== null} onClick={() => { setAssignAgentId(agents[0]?.id ?? ""); setAssignSquadId(""); setAssignModalTaskId(selectedTask!.id); }}>
                  {text("指派/小组", "Assign")}
                </button>
                <button className="button secondary" type="button" disabled={!selectedTask || busy !== null} onClick={() => setBlockModalTaskId(selectedTask!.id)}>
                  {text("阻塞原因", "Block reason")}
                </button>
                <button className="button secondary" type="button" disabled={!selectedTask || !dependencyId || busy !== null} onClick={() => void run("dependency", async () => {
                  await addTaskDependency(selectedTask!, dependencyId);
                })}>{text("添加依赖", "Add dependency")}</button>
                <button className="button secondary" type="button" disabled={!selectedTask || busy !== null} onClick={() => void run("active", async () => {
                  await setTaskBlocked(selectedTask!, false, "");
                })}>{text("解除阻塞", "Unblock")}</button>
                <button className="button secondary" type="button" disabled={!selectedTask || busy !== null} onClick={() => void run("pause", async () => {
                  await controlTask(selectedTask!, "paused");
                })}>{text("暂停", "Pause")}</button>
                <button className="button danger" type="button" disabled={!selectedTask || busy !== null} onClick={() => void run("terminate", async () => {
                  await controlTask(selectedTask!, "terminated");
                })}>{text("终止", "Terminate")}</button>
                <button className="button primary" type="button" disabled={!selectedTask || !selectedTask.squadId || busy !== null} onClick={() => void run("autonomous", async () => {
                  await runAutonomousSquadStep(selectedTask!);
                })}>{text("小组自主推进", "Run team")}</button>
              </div>
              <label className="collab-dependency">
                <span>{text("前置依赖（用于「添加依赖」）", "Dependency (for add dependency)")}</span>
                <select value={dependencyId} onChange={(event) => setDependencyId(event.target.value)}>
                  <option value="">{text("未选择", "None")}</option>
                  {selectableTasks.filter((task) => task.id !== selectedTask?.id).map((task) => (
                    <option value={task.id} key={task.id}>{task.identifier} - {task.title}</option>
                  ))}
                </select>
              </label>
            </div>
          )}

        </div>

        <div className="collab-zone collab-activity">
          <div className="collab-zone-head">
            <h2>{text("最近动静", "Recent activity")}</h2>
          </div>
          {activities.length === 0 ? (
            <div className="collab-empty">
              <p>{text("还没有动静。有人接下任务、小组完成事情时，会实时出现在这里。", "No activity yet. When work is picked up or finished, it shows up here in real time.")}</p>
            </div>
          ) : (
            <ol className="collab-activity-list" ref={activityListRef}>
              {activities.map((activity) => (
                <li className="collab-activity-item" key={activity.id}>
                  <span className="collab-activity-time">{fieldDate(activity.createdAt)}</span>
                  <span className="collab-activity-icon" aria-hidden="true"><LinearIcon name="status" /></span>
                  <p>{activity.message}</p>
                </li>
              ))}
            </ol>
          )}
        </div>

      {toast && (
        <div className="collab-toast" role="status">{toast}</div>
      )}

      {registerOpen && (
        <div className="collab-modal-backdrop" role="presentation" onClick={() => setRegisterOpen(false)}>
          <div className="collab-modal" role="dialog" aria-modal="true" aria-label={text("手动添加", "Add manually")} onClick={(event) => event.stopPropagation()}>
            <h3>{text("手动添加帮手", "Add a helper manually")}</h3>
            <label>
              <span>{text("名称", "Name")}</span>
              <input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="Builder" />
            </label>
            <details className="collab-advanced">
              <summary onClick={(event) => { event.preventDefault(); setAdvancedOpen((current) => !current); }}>
                {text("高级设置", "Advanced settings")}
              </summary>
              {advancedOpen && (
                <div className="collab-advanced-body">
                  <label>
                    <span>{text("擅长什么（可选）", "Good at (optional)")}</span>
                    <input value={agentTags} onChange={(event) => setAgentTags(event.target.value)} />
                  </label>
                  <label>
                    <span>{text("工作文件夹（可选）", "Working folder (optional)")}</span>
                    <input value={agentWorkspace} onChange={(event) => setAgentWorkspace(event.target.value)} />
                  </label>
                </div>
              )}
            </details>
            <div className="collab-modal-actions">
              <button className="button secondary" type="button" onClick={() => setRegisterOpen(false)}>{text("取消", "Cancel")}</button>
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
                  setRegisterOpen(false);
                  setAgentName("");
                }, text("加好了。", "Added."))}
              >
                {busy === "agent" ? text("保存中...", "Saving...") : text("添加", "Add")}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingAuthorizeTool && (
        <div className="collab-modal-backdrop" role="presentation" onClick={() => setPendingAuthorizeTool(null)}>
          <div className="collab-modal" role="dialog" aria-modal="true" aria-label={text("启用工具", "Enable tool")} onClick={(event) => event.stopPropagation()}>
            <h3>{text(`让 ${pendingAuthorizeTool.name} 帮你干活？`, `Let ${pendingAuthorizeTool.name} help you?`)}</h3>
            <p className="collab-authorize-copy">
              {text(
                `它会：在你电脑上运行命令、读写你的工作文件夹。你可以随时在设置里关掉它。`,
                `It will: run commands on your computer and read/write your working folder. You can turn it off anytime in settings.`,
              )}
            </p>
            <div className="collab-modal-actions">
              <button className="button secondary" type="button" disabled={busy !== null} onClick={() => setPendingAuthorizeTool(null)}>
                {text("先不了", "Not now")}
              </button>
              <button
                className="button primary"
                type="button"
                disabled={busy !== null}
                onClick={() => void confirmAuthorize(pendingAuthorizeTool)}
              >
                {busy === "authorize" ? text("处理中…", "Working…") : text("同意，让它干活", "OK, let it work")}
              </button>
            </div>
          </div>
        </div>
      )}

      {managingSquad && (
        <div className="collab-modal-backdrop" role="presentation" onClick={() => setManagingSquadId(null)}>
          <div className="collab-modal" role="dialog" aria-modal="true" aria-label={text(`管理小组 ${managingSquad.name}`, `Manage team ${managingSquad.name}`)} onClick={(event) => event.stopPropagation()}>
            <h3>{text(`小组：${managingSquad.name}`, `Team: ${managingSquad.name}`)}</h3>
            <label>
              <span>{text("组长", "Leader")}</span>
              <select value={squadLeaderId} onChange={(event) => setSquadLeaderId(event.target.value)}>
                {toolCandidates.map((candidate) => (
                  <option value={candidate.id} key={candidate.id}>{candidate.name}</option>
                ))}
              </select>
            </label>
            <span className="collab-member-picker-label">{text("成员（点击增减）", "Members (click to toggle)")}</span>
            <ul className="collab-member-picker">
              {toolCandidates.filter((candidate) => candidate.id !== squadLeaderId).map((candidate) => {
                const selected = squadMemberIds.length === 0
                  ? managingSquad.members.some((member) => member.agentId === candidate.id)
                  : squadMemberIds.includes(candidate.id);
                return (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      className={`collab-member-option${selected ? " selected" : ""}`}
                      aria-pressed={selected}
                      onClick={() => toggleMember(candidate.id)}
                    >
                      {candidate.kind === "cli"
                        ? <span className="collab-avatar collab-avatar-terminal" aria-hidden="true"><LinearIcon name="terminal" /></span>
                        : <span className="collab-avatar">{candidate.name.trim()[0]?.toUpperCase() ?? "?"}</span>}
                      <span>{candidate.name}</span>
                      {selected && <LinearIcon name="check" />}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="collab-modal-actions">
              <button className="button secondary" type="button" onClick={() => { setManagingSquadId(null); setSquadMemberIds([]); }}>{text("取消", "Cancel")}</button>
              <button
                className="button primary"
                type="button"
                disabled={busy !== null}
                onClick={() => void run("squad-update", async () => {
                  await updateSquad(managingSquad.id, {
                    leaderAgentId: squadLeaderId,
                    memberAgentIds: squadMemberIds.length > 0 ? squadMemberIds : managingSquad.members.map((member) => member.agentId).filter((id) => id !== squadLeaderId),
                  });
                  setManagingSquadId(null);
                  setSquadMemberIds([]);
                }, text("成员更新好了。", "Members updated."))}
              >
                {busy === "squad-update" ? text("保存中...", "Saving...") : text("保存成员", "Save members")}
              </button>
            </div>
          </div>
        </div>
      )}

      {assignTaskTarget && assignModalTaskId !== null && (
        <div className="collab-modal-backdrop" role="presentation" onClick={() => setAssignModalTaskId(null)}>
          <div className="collab-modal" role="dialog" aria-modal="true" aria-label={text("派活", "Assign work")} onClick={(event) => event.stopPropagation()}>
            <h3>{text("派活", "Assign work")}</h3>
            <label>
              <span>{text("任务", "Task")}</span>
              <select value={assignTaskTarget.id} onChange={(event) => setAssignModalTaskId(event.target.value)}>
                {selectableTasks.map((task) => (
                  <option value={task.id} key={task.id}>{task.identifier} - {task.title}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{text("帮手", "Helper")}</span>
              <select value={assignAgentId} onChange={(event) => setAssignAgentId(event.target.value)}>
                <option value="">{text("不指定", "None")}</option>
                {toolCandidates.filter((candidate) => candidate.authorized).map((candidate) => (
                  <option value={candidate.id} key={candidate.id}>{candidate.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{text("小组", "Team")}</span>
              <select value={assignSquadId} onChange={(event) => setAssignSquadId(event.target.value)}>
                <option value="">{text("不指定", "None")}</option>
                {squads.map((squad) => (
                  <option value={squad.id} key={squad.id}>{squad.name}</option>
                ))}
              </select>
            </label>
            <div className="collab-modal-actions">
              <button className="button secondary" type="button" onClick={() => setAssignModalTaskId(null)}>{text("取消", "Cancel")}</button>
              <button
                className="button primary"
                type="button"
                disabled={busy !== null}
                onClick={() => void run("assign", async () => {
                  await assignTask(assignTaskTarget, { agentId: assignAgentId || null, squadId: assignSquadId || null });
                  setAssignModalTaskId(null);
                }, text(`已经派给${assignSquadId ? squads.find((squad) => squad.id === assignSquadId)?.name ?? "" : (assignAgentId || "帮手")}了。`, "Assigned."))}
              >
                {busy === "assign" ? text("派发中...", "Assigning...") : text("确认派活", "Assign")}
              </button>
            </div>
          </div>
        </div>
      )}

      {blockTaskTarget && blockModalTaskId !== null && (
        <div className="collab-modal-backdrop" role="presentation" onClick={() => setBlockModalTaskId(null)}>
          <div className="collab-modal" role="dialog" aria-modal="true" aria-label={text("标记阻塞", "Block task")} onClick={(event) => event.stopPropagation()}>
            <h3>{text(`阻塞：${blockTaskTarget.identifier}`, `Block ${blockTaskTarget.identifier}`)}</h3>
            <label>
              <span>{text("阻塞原因", "Block reason")}</span>
              <input
                value={blockReason}
                onChange={(event) => setBlockReason(event.target.value)}
                placeholder={text("例如：等待外部接口", "e.g. Waiting on external API")}
              />
            </label>
            <div className="collab-modal-actions">
              <button className="button secondary" type="button" onClick={() => setBlockModalTaskId(null)}>{text("取消", "Cancel")}</button>
              <button
                className="button danger"
                type="button"
                disabled={busy !== null}
                onClick={() => void run("block", async () => {
                  await setTaskBlocked(blockTaskTarget, true, blockReason);
                  setBlockModalTaskId(null);
                })}
              >
                {busy === "block" ? text("保存中...", "Saving...") : text("确认阻塞", "Block")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
