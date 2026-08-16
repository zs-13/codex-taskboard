# Codex Taskboard 小白快速上手指南

> 本文面向第一次接触 Codex Taskboard 的普通用户。不用懂代码，按步骤跟着做就行。

## 1. 这是什么？能干什么？

一句话：**Codex Taskboard 是一个装在你电脑上的「任务面板」，可以挂到 Codex 窗口的侧边栏里，用来创建、分配和跟踪任务。**

举几个例子：

- 把「给网站加一个登录页」建成一个任务，指派给某个智能体（Agent）去做；
- 把任务在面板上从「待办」拖到「进行中」再拖到「完成」，随时知道谁在做什么、做到哪了；
- 多个智能体认领任务、写评论、汇报进度，所有改动在面板上实时同步。

## 2. 怎么安装？

先装两样东西（一次就行）：

- [Node.js](https://nodejs.org/)（22.5 或更高版本）；
- [Git](https://git-scm.com/)。

然后按你的系统来：

**Windows**

1. 打开「命令提示符」或「PowerShell」；
2. 复制下面两条命令，一行一行粘贴并回车：

   ```bat
   git clone https://github.com/zs-13/codex-taskboard.git
   cd codex-taskboard
   ```

3. 双击 `scripts\start-taskboard.bat`。

**macOS**

1. 打开「终端」；
2. 粘贴下面两条命令并回车：

   ```bash
   git clone https://github.com/zs-13/codex-taskboard.git
   cd codex-taskboard
   ```

3. 运行 `./scripts/start-taskboard.sh`。

> 第一次启动时依赖（`npm install`）会自动安装，不用你手动装。耐心等它跑完即可。

## 3. 怎么启动？

- **Windows**：双击 `scripts\start-taskboard.bat`；
- **macOS**：在终端里运行 `./scripts/start-taskboard.sh`，或运行 `npm run codex`；
- 也可以：在 Codex 应用里打开这个仓库文件夹，点击环境动作里的「启动」。

启动后会发生这些事：

1. 自动打开一个 Codex 窗口；
2. 窗口**右侧侧边栏**出现 **Taskboard** 面板；
3. 后台会自动运行服务和 agent runner——**关掉 Codex 窗口并不会停止任务面板**，任务进度会一直在后台跑。

## 4. 第一次打开怎么用？

1. **找到面板**：面板在「由启动脚本打开的那个 Codex 窗口」的右侧侧边栏。注意：**从开始菜单 / 应用图标直接打开的 Codex 窗口不会显示面板**——一定要用启动脚本打开 Codex。
2. **新建任务**：在面板里点「新建」，填标题（比如「修复登录页按钮」）、优先级（高 / 中 / 低）、状态（待办 / 进行中），保存即可。
3. **指派任务**：在任务详情里选执行者——可以是某个智能体，也可以是「小队」（一组智能体）。指派后，对方会收到任务并开始干活。
4. **跟踪进度**：在面板上看任务状态、读评论。智能体更新进度时，面板会实时变化。

## 5. 怎么关闭 / 彻底停止？

**只想关掉 Codex 窗口**：直接关窗口就行。面板和后台服务继续运行，数据不会丢。

**Windows —— 彻底停止**：运行 `scripts\stop-taskboard.bat`。它会停止启动器拉起的 Codex 窗口和后台的 node 进程（服务 / 注入器 / agent runner）。之后想再开，运行 `scripts\start-taskboard.bat` 即可。

**Windows —— 强制重启**：如果关掉 Codex 后进程残留、再启动时开不出新窗口，运行 `scripts\start-taskboard.bat -Force`。它会先清理残留的 Codex 和后台进程，再重新启动。

**macOS —— 停止**：在启动器的终端里按 `Ctrl-C`。

> 记住：关掉 Codex 窗口只是关窗口，任务数据存在本地，不会丢；**要彻底停止**才需要跑 stop 脚本（Windows）或按 `Ctrl-C`（macOS）。

## 6. 常见问题

**Q：双击启动后，Codex 没打开怎么办？**
A：多半是有残留进程占着端口，或之前用应用图标打开过 Codex。先运行 `scripts\stop-taskboard.bat`，再运行 `scripts\start-taskboard.bat`；还不行就试试 `scripts\start-taskboard.bat -Force`。另外，Windows 下如果没从 Microsoft Store 安装 Codex，启动脚本找不到 Codex，需要用 `-CodexAppPath` 参数指定路径。

**Q：任务标题 / 描述变成乱码（像 `��ϲ`）？**
A：这是 Windows PowerShell 用 ANSI 代码页（GBK）传中文导致的。解决办法：
- 创建含中文的任务 / 评论时，优先用文件传参：`--description-file <文件>` / `--content-file <文件>`（把内容保存为 UTF-8 文件）；
- 或者在执行命令前先运行 `chcp 65001`，并把 `$OutputEncoding` 设置为 UTF-8。

**Q：数据存在哪里？**
A：本地 SQLite 数据库，默认在仓库的 `.data\taskboard.sqlite`。关掉 Codex 不会丢数据。

**Q：怎么更新到最新版？**
A：在仓库目录里运行：

```bash
git pull
npm install
```

然后重新运行启动脚本即可。你的数据（`.data` 目录）会保留。

**Q：面板不显示怎么办？**
A：最常见的原因是用应用图标打开了 Codex，而不是用启动脚本。请始终用 `scripts\start-taskboard.bat`（Windows）或 `./scripts/start-taskboard.sh` / `npm run codex`（macOS）打开。

**Q：启动脚本每次都会弹出终端窗口，正常吗？**
A：正常。启动器需要一个终端窗口来运行。如果希望「双击就开、不用敲命令」，可以运行 `scripts\setup-taskboard-autostart.ps1`，它会创建「Codex Taskboard」桌面快捷方式并注册开机自启——之后双击桌面上的快捷方式即可打开面板（仍然会有一个终端窗口，但不用再敲命令）。
