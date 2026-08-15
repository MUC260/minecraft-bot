# 调研结论与实施计划

## 一、已调研的同类项目

### 1. Mindcraft（mindcraft-bots/mindcraft）
- 结构：`profiles/*.json` 人物配置 + `src/agent/*` 动作/查询/记忆/视觉 + `src/models/*` 多模型映射。
- 可借鉴：多模型 Profile、技能库、全状态观测、视觉可选。

### 2. Cairn（VasilisDragon/cairn）
- 结构：`Reactive loop`（硬编码生存 FSM） + `Executor`（动作队列） + `Advisor`（LLM 只做规划）。
- 可借鉴：LLM 不直接驱动底层生存；每个 tick 用最新世界快照重新验证计划；固定技能 schema，防止模型幻觉动作。

### 3. MineAI（ailiujiarui/MineAI）
- 结构：`src/agent`、`src/autonomy`、`src/clientBridge`、`src/models` 等，多模型适配。
- 可借鉴：多模型适配层、Profile 配置、自主阶段推进。

### 4. awesome-mineflayer-mcp（G0Osey99/awesome-mineflayer-mcp）
- 结构：123 个强类型工具、26 个分组，基于 MCP。
- 可借鉴：工具分组、长任务可取消、新任务抢占旧任务、只读/命令白名单等安全边界、截图/地图视觉能力。

## 二、学到的核心结构

1. 分层：`观测 → 规划 → 执行 → 反馈`，不要让 AI 直接写底层循环。
2. LLM 只做规划：输出受固定动作 schema 约束的 JSON/function call。
3. 固定动作词汇表：所有动作必须在 `ai/tools.js` 注册，执行层二次校验，防止幻觉动作。
4. 动作队列 + 可取消长任务：寻路、挖矿等长任务要能被新任务抢占。
5. 生存兜底：自动吃饭、逃跑、危险中断、紧急下线，由硬编码逻辑处理，不依赖 LLM。
6. 状态快照反馈：动作执行后把结果和新观测再喂给 AI，形成闭环。
7. 安全边界：只读模式、命令白名单、主机白名单、聊天限流。
8. 视觉可选：截图/地图渲染用独立可选模块，默认关闭以控制体积和性能。

## 三、当前项目已具备

- `core/agent.js`：Mineflayer 连接与事件。
- `core/observations.js`：健康、饥饿、位置、玩家、实体、背包、聊天。
- `core/actions.js`：chat/look/move/goto/dig/place/attack/equip/wait 等动作。
- `ai/tools.js`：OpenAI function-call schema。
- `ai/brain.js`：定时决策循环。
- `api/server.js` + `ui/`：REST/WS 控制面板。
- 部署：Docker、PM2。

## 四、下一步改造计划（按优先级）

1. 新增 `core/reactive.js`：每 1 秒跑生存兜底：
   - 饥饿低时吃食物。
   - 生命低时逃跑或告警。
   - 被攻击/危险时中断当前任务。
2. 新增 `core/executor.js`：把当前 `actions.execute` 改成可取消任务队列：
   - `goto`/`dig`/长动作支持取消。
   - 新任务抢占旧任务。
   - 执行后返回结构化结果。
3. 重构 `ai/brain.js`：
   - 把动作结果和新观测拼进下一轮上下文。
   - 用 `tools.js` 固定 schema 校验并执行，不在执行层临时造动作。
4. 强化 `ai/tools.js`：
   - 增加 `getNearestBlock`、`craft`、`container`、`interact`、`follow`、`stopTask` 等常用能力，仍保持轻量。
5. 安全选项：
   - 配置 `readOnly`、`chatLimitPerMinute`、`commandWhitelist`。
6. 桌面 exe：
   - 后端保持纯 Node 项目，服务器部署不变。
   - Windows 桌面端用轻量外壳，最终目标是单个或安装包体积控制在约 60–100MB，不超过 150MB。

## 五、exe 打包方案

### 首选：Tauri + Node sidecar
- Tauri 外壳约 3MB，使用系统 WebView2，不内置 Chromium。
- 把 Node 后端用 `@yao-pkg/pkg` 打成 `minecraft-bot-backend.exe`，作为 Tauri sidecar。
- Tauri 启动时拉起 sidecar，加载 `http://127.0.0.1:8787`。
- 优点：窗口体验好、体积小、后端代码不变。
- 预期：后端 exe 约 50–80MB + Tauri 外壳 3–5MB，压缩安装包约 40–70MB。

### 备选：直接 `@yao-pkg/pkg` 单文件 exe
- `pkg index.js --targets node18-win-x64 --output dist/MinecraftBot.exe`。
- 启动后自动用系统 Edge App 模式打开面板，类似现有 `desktop.ps1`。
- 优点：最快落地，无 Rust 工具链。
- 预期：约 60–90MB。

### 不采用
- Electron（空应用约 364MB，体积不符合要求）。
- 把所有模型/浏览器打包进去（会到几百 MB）。

## 六、打包验证命令

```powershell
npm install -D @yao-pkg/pkg
npx pkg index.js --targets node18-win-x64 --output dist/MinecraftBot.exe
Get-Item dist/MinecraftBot.exe | Select-Object Name,Length
```

体积验收标准：单文件 ≤ 100MB 为合格，>150MB 就回到 Tauri sidecar 或继续裁剪依赖。
