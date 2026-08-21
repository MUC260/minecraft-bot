# 项目交接文档 / Handoff

## 项目概览
- 项目路径：`D:\minecraft-bot`
- GitHub：`https://github.com/MUC260/minecraft-bot`（当前为公开仓库）
- 协作者：`BCZZB`
- 最新已推送提交：`5535c8c feat: @ai 唤醒词 + AI 成员白名单功能`
- 当前分支：`main`
- 当前状态：本轮修复已提交到本地 `main`，已通过 `npm run check` 和 `npm test`

## 产品目标
做一个轻量、可用的 Windows GUI 软件，让 AI 通过 API 接收游戏状态，并操作 Minecraft Java 版机器人。
- 必须交付 GUI EXE，双击不弹黑色控制台。
- 可部署到服务器跑核心程序。
- AI 尽量自主决策，不写死大量规则。
- 包体控制在 100MB 左右，避免几百 MB。

## 已交付文件
- GUI：`D:\minecraft-bot\dist\minecraft-bot-gui.exe`（约 97 MiB）
- 核心可执行：`D:\minecraft-bot\dist\minecraft-bot.exe`（约 96 MiB）
- 源码入口：`D:\minecraft-bot\index.js`

## 核心架构
- `index.js`：启动核心、日志、AI、聊天指令、API 服务。
- `core/agent.js`：创建 Minecraft Bot、连接/重连、生命周期、状态快照。
- `core/executor.js`：动作队列、技能超时、被生存系统抢占后的恢复。
- `core/actions.js`：实际动作实现（采集、砍树、挖矿、移动、保护等）。
- `core/observations.js`：把游戏状态转成 AI 可读 JSON。
- `core/reactive.js`：低血量、敌对生物、危险环境等生存反应。
- `core/pathfinderOwner.js`：统一管理寻路占用，生存系统优先级高于技能。
- `core/chatCommander.js`：识别主人聊天指令并设定目标。
- `ai/brain.js`：AI 决策循环。
- `ai/provider.js`：调用 OpenAI 兼容 API、解析工具调用、获取模型列表。
- `ai/tools.js`：AI function calling 工具定义。
- `ai/prompts/system.md`：AI 系统提示词。
- `ui/`：GUI 页面和交互逻辑。
- `lib/config.js`：配置解析。
- `scripts/`：构建、检查、冒烟测试脚本。

## 最近一次修复重点

### 未提交的工作树改动（当前待提交）
本轮继续修复以下问题，已通过 `npm run check` 与 `npm test`：
- 不说话也会自己动：`ai/brain.js` 在附近有掉落物时自动插入 `collect`，避免 AI 空转；一次性命令结束后恢复自主行动，不再永久 hold。
- 跟随会突然停：`core/chatCommander.js` 的 follow 只排一次，`ai/brain.js` 不再重复 enqueue，避免两个任务互相打断。
- 自动拾取掉落物：`core/actions.js` 的 `pickupNearbyDrops` 默认半径 8、循环 24；砍树/挖矿/做装备前先捡掉落物。
- 会做工作台/装备并检查背包：`core/actions.js` 强化 `craftGear`、`ensureCraftingTable`，缺原木时先砍树合成木板，缺门/火把/工作台时自动补做。
- 建筑更好看：`houseLayout` 加斜顶/屋脊，`buildTowerPositions` 加箭窗和城垛，桥加低围栏，墙加门洞和顶部城垛。
- 被玩家打会还手：`core/reactive.js` 新增 `_resolvePlayerEntity`，反击窗口提升到 120 秒，低血量时先装备武器/盾牌再反击，不逃跑。
- 自动进食不丢副手盾牌：`lib/combat.js` 的 `consumePreserveLoadout` 保存/恢复手持物与副手盾牌。
- UI 主人命令重复显示：`ui/app.js` 对聊天和事件日志按键去重，历史日志加载前清空事件去重集合。
- 禁止隔空挖矿：`core/actions.js` 的 `blockVisible`/`findNearestBlockBy`/`digConnected`/`collect`/`mineOreVein` 在挖掘前先检查 `bot.canSeeBlock`，不可见就靠近或放弃。
- 主人命令加前缀：`core/chatCommander.js` 默认只处理 `!` / `！` 开头的聊天，普通聊天不再逐条分析；`lib/config.js`/`config.example.json`/`ui/app.js` 增加 `mc.commandPrefix`。
- AI 监工持续任务：`ai/prompts/system.md` 增加监工/长期目标/失败换路/不可隔空挖矿约束；停止词扩展到完成/好了/可以了/结束/完毕/done/complete/finish。

### 历史提交 `9ccc124` 修复了用户反馈的主要问题：
1. `bot.pathfinderOwner` 未挂到 bot 实例，导致采集/寻路技能报“pathfinderOwner 未初始化”。
2. `collect` 无目标时只会找掉落物，找不到就失败，导致“让他采集就不动”。
3. AI 看不到附近可采集方块，无法自主决策。
4. `protect` 低血量路径读取 `bot.reactiveController` 的问题。
5. 聊天重复发送。
6. 部分日志和报错文案是乱码/问号。

关键改动：
- `core/agent.js`：`bot.pathfinderOwner = this.pathfinderOwner`
- `core/actions.js`：
  - 新增 `isCollectibleLike`
  - 新增 `explore`
  - 重写 `collect`，无目标时自动扫描并随机短距离探索
  - 路径接近改为 `pathNearXZ`，避免垂直卡点
  - chat 20 秒去重
- `core/observations.js`：
  - 新增 `isCollectibleBlock`
  - 新增 `nearbyTargets`
  - 快照中加入 `nearbyTargets`
- `ai/tools.js`：新增 `explore`，更新 `collect` 描述
- `ai/prompts/system.md`：强化自主推进、禁止空转、模糊指令直接调用采集

## 已验证命令
```powershell
cd D:\minecraft-bot
npm run check
npm test
```

## 构建 EXE
先关闭正在运行的程序，避免文件被占用：
```powershell
Get-Process | Where-Object { $_.ProcessName -like 'minecraft-bot*' -or $_.ProcessName -like 'electron*' } | Stop-Process -Force
```

构建核心 EXE：
```powershell
cd D:\minecraft-bot
npm run build:exe
```

构建 GUI EXE：
```powershell
cd D:\minecraft-bot
npm run build:gui
```

也可以：
```powershell
npm run build:all
```

## 推送 GitHub
本机网络环境需要走固定 IP + Host 头绕过 DNS/证书问题：
```powershell
cd D:\minecraft-bot
$credInput = "protocol=https`nhost=github.com`n`n"
$cred = ($credInput | git credential fill 2>$null) | Out-String
$user = [regex]::Match($cred, '(?m)^username=(.*)$').Groups[1].Value.Trim()
$pass = [regex]::Match($cred, '(?m)^password=(.*)$').Groups[1].Value.Trim()
$u = [uri]::EscapeDataString($user)
$p = [uri]::EscapeDataString($pass)
$url = "https://${u}:${p}@140.82.112.4/MUC260/minecraft-bot.git"
git -c http.sslVerify=false -c http.extraHeader="Host: github.com" push $url HEAD:refs/heads/main
```

提交前先 `git status --short`，确保只提交源码。

## 配置与敏感信息
- 不要把 `config.json`、`.env`、`logs/`、`dist/` 提交到仓库。
- 不要把真实 API Key、密码、服务器密码提交上去。
- 如果仓库历史里已经混入敏感信息，下一步应处理。
- 用户要求把能配置的东西尽量做进 GUI，减少手改文件。

## 日志与调试
- 日志文件：`D:\minecraft-bot\logs\agent.log`
- GUI 也显示技能开始/完成/失败、AI 决策失败、连接状态等日志。
- 调试时先看日志，按“连接失败 / AI 决策失败 / 技能失败 / 寻路失败 / 被生存系统抢占 / 超时”分类定位。
- 常用日志关键字：
  - `AI 决策失败`
  - `技能失败`
  - `pathfinder`
  - `reactive`
  - `无法到达`
  - `timeout`
  - `noPath`

## 用户关注点与后续待办
1. AI 目前还不够“聪明”，后续重点优化：
   - 给 AI 更完整的背包/目标/历史动作上下文。
   - 考虑多轮规划，而不是每轮零散动作。
   - 增加“目标拆解”，例如砍树后主动捡掉落物。
2. 技能稳定性仍要观察：
   - `collect` 现在会自动探索，但要确认寻路不会卡住或长时间超时。
   - `chopTree` / `mineOreVein` 目前会挖最多一定数量，可能还没捡掉落物就停。
   - `protect` 需要重点实测低血量场景。
3. 插件服登录：
   - 配置里已有插件服登录指令相关字段，需确认 GUI 中是否完全暴露。
4. 版本兼容：
   - 当前保留并裁剪了大量 Minecraft Java 版本数据，构建输出提示 1.8.8 到 1.21.11。
   - 实际是否能进所有版本，还需要按目标服务器版本继续测试。
5. 紧急低血下线：
   - 现有设计是低血且确认能跑才跑；无法确认逃跑路径时不会乱跑，也不会轻易退出服务器。
   - 如果用户还遇到“protect 后退出服务器”，先看日志里是 `reactive` 抢占、`critical-health` 还是连接被服务器踢出。
6. GUI 体验：
   - 用户希望打开后不弹黑窗，已满足。
   - 下一步可以继续改进设置界面、日志显示、手动连接/断开按钮。

## @ai 唤醒词 + AI 成员白名单功能（本次新增，commit 5535c8c）

### 需求
玩家在游戏聊天里 @机器人名字 即可唤醒 AI 对话；管理员可在游戏内管理成员权限和唤醒词。

### 实现

**唤醒词规则**：默认 `@机器人名字`（机器人叫什么名字就 @ 什么），支持自定义覆盖。
- config 不写 `aiMention` → 自动取 `@config.mc.username`
- config 写了 `aiMention` → 优先用自定义值
- `!ai setword xxx` → 动态修改，下次连接以自定义优先

**权限控制**：
- owner（主人）默认可用所有 @ai 指令
- `aiMembers` 白名单内的玩家可使用 @ai 对话
- 未授权玩家 → 机器人私聊提示"未授权使用 AI"

**核心文件改动**：
- `core/chatCommander.js`：
  - `_customAiMention` / `aiMention` 双字段：自定义优先，否则取 @机器人名
  - `onBotReady(username)`：连接成功后同步唤醒词
  - `_matchMention(raw)`：动态匹配 @机器人名（不区分大小写）
  - `_handleAiMention(item)`：白名单校验 + 调用 `brain.ask()`
  - `_handleAiAdmin(sub)`：!ai list/add/remove/clear/setword/help
  - `updateAiConfig(cfg)`：后台/API 修改后同步
- `ai/brain.js`：新增 `ask(message, username)` 方法
  - 暂停自主循环 → 调用 LLM 分析玩家指令 → 执行动作 → 恢复
- `api/routes.js`：新增 `GET/PUT /api/ai/config`、`GET /api/ai/players`
- `api/server.js`：传入 commander 支持配置同步
- `index.js`：监听 `commanderReady` 事件同步唤醒词
- `core/agent.js`：连接成功后 emit `commanderReady` 事件

**游戏内指令**：
```
!ai list          # 查看唤醒词和授权成员
!ai add 玩家名     # 授权使用 @ai
!ai remove 玩家名  # 移除授权
!ai clear         # 清空授权
!ai setword @自定义词  # 修改唤醒词
!ai help          # 帮助
```

**配置文件**（config.json）：
```json
"ai": {
  "aiMention": "@自定义唤醒词",  // 可选，不写则默认 @机器人名
  "aiMembers": ["玩家A", "玩家B"]
}
```

**API**：
- `GET /api/ai/config` — 查询唤醒词和成员列表
- `PUT /api/ai/config` — 修改唤醒词和成员列表（同步更新运行时）
- `GET /api/ai/players` — 获取在线玩家（方便后台管理）

## 下次继续做事的建议顺序
1. 先跑：
```powershell
cd D:\minecraft-bot
git pull
npm run check
npm test
```
2. 读 `HANDOFF.md` 和 `logs/agent.log`。
3. 让用户提供最新日志，先定位是哪种失败，再改对应模块。
4. 改完源码后：
```powershell
npm run check
npm test
git add <只加源码>
git commit -m "fix: ..."
# 使用上面的 GitHub 推送命令
npm run build:exe
npm run build:gui
```
5. 告诉用户重启：
```text
D:\minecraft-bot\dist\minecraft-bot-gui.exe
```

## 2026-08-17 寻路核心修复（待提交）

用户确认主要故障集中在寻路失败。本轮实服定位到根因：`mineflayer-pathfinder` 的 A* `timeout` 结果经常仍携带可用的部分路径，但旧逻辑立即把 timeout 当作空路径失败并释放寻路令牌；`follow` 同时把该状态判定为空闲，每 400ms 重设目标，导致部分路径还没走就被清除，并持续占用事件循环。

修复内容：
- `core/pathfinderOwner.js`：只有 `noPath/timeout` 且返回路径为空时才标记寻路空闲；保留 timeout 中的有效部分路径。
- `core/actions.js`：
  - `waitForGoal` 会让机器人先走完 A* 返回的部分路径。
  - 部分路径走完后从新位置自动重新规划，最多分段推进 4 次。
  - `pathNear` / `pathNearXZ` 根据实际坐标进展判断成功或继续，不再见到 timeout 就立即停止。
  - `follow` 检测部分路径是否已走完，间隔 2.5 秒重新规划，避免 400ms 高频重置。
- `core/agent.js`：降低单次寻路 CPU 占用；关闭实体碰撞索引和跑酷寻路，减少复杂山地/实体密集服务器上的 API 卡顿。
- 安全寻路默认值：`thinkTimeoutMs=700`、`tickTimeoutMs=6`、`searchRadius=24`。
- 本地 `config.json` 已同步以上参数；该文件仍不提交。
- `scripts/smoke.js` 增加 timeout 携带部分路径时不得立即丢弃的回归测试。

实服验证：
- `follow MUC260`：机器人从约 `313.6,88,-61.8` 连续爬升并移动到约 `313.5,103,-90.4`，12 秒动作正常完成。
- 寻路期间控制 API 连续响应约 34–90ms，没有再次出现面板卡死。
- `chopTree radius=16 max=8`：复杂山地中成功接近云杉并获得 3 个云杉原木，动作正常完成。
- `npm run check`、`npm test`、`git diff --check` 均通过。
- 已重新构建 `dist/minecraft-bot.exe` 与 `dist/minecraft-bot-gui.exe`。
- 当前机器人在线，自主循环暂停，动作队列空闲。
