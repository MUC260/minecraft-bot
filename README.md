# Minecraft AI Bot

AI 驱动的 Minecraft 机器人。核心思路：**机器人观察游戏状态 → 通过 API 交给 AI → AI 返回动作 → 机器人执行**。

- 轻量：核心依赖只有 mineflayer + express + ws；桌面端是小型 Rust 原生 GUI 启动器，调用系统 WebView2，不打包 Electron
- 舒服：自带深色控制面板，可看状态、聊天、实时观测、手动控制
- 可用：内置常用动作和更长任务技能（移动、寻路、挖掘、放置、采集、砍树、采矿脉、狩猎、守卫、简易避难所、自动装备、进食等）
- 可部署：可跑在本机，也可用 Docker / PM2 部署到服务器
- 可打包：核心为 SEA 单文件，GUI 启动器把核心嵌入自身，最终约 97 MiB，不依赖本机 Node
- 可靠性：断线自动重连（指数退避）、文件日志、技能超时/看门狗、AI 重复失败换方案

## 架构

```
ui/            控制面板（静态网页，由 api 服务托管）
api/           控制面：REST + WebSocket，供 UI/远程调用
ai/            AI 决策：OpenAI 兼容接口 + 工具定义 + 决策循环
core/          机器人：mineflayer 连接、观测、动作、技能、生存反应
lib/           配置、日志、战斗/装备工具
scripts/       启动/检查/打包脚本
desktop/       桌面端说明
launcher/      Windows GUI 启动器（纯 GUI，无黑色控制台）
```

数据流：

```
Minecraft 服务器
      │
core/agent.js  ← 观测(observations.js)
      │           动作/技能(actions.js)
      ▼
ai/brain.js  ──►  OpenAI 兼容 API（OpenAI / DeepSeek / Kimi / Ollama）
      ▲
      │  工具调用结果
      └──► 执行动作
```

## 快速开始

1. 安装依赖：

```bash
npm install
```

2. 复制配置并修改：

```bash
cp config.example.json config.json
```

编辑 `config.json`，至少填 Minecraft 服务器和 AI API Key。完整模板见 `config.example.json`，也支持 `.env` 环境变量覆盖（参考 `.env.example`）。

3. 启动：

```bash
# 服务端 / 命令行模式
npm start

# 桌面窗口模式
npm run desktop
```

打开 http://127.0.0.1:8787

## 打包 Windows exe

```bash
npm run check
npm run build:win
```

输出：`dist/minecraft-bot.exe`，约 96 MiB。默认走 SEA 打包，不依赖本机 Node。首次打包会从 nodejs.org 下载对应 Node 基础包并缓存；如需传统打包可设 `PKG_SEA=0`，目标版本可用 `PKG_TARGET` 覆盖（默认 `node24-win-x64`）。

如需**不弹黑色控制台的纯 GUI 单文件 exe**：

```bash
npm run build:all
# 或分开执行
npm run build:exe
npm run build:gui
```

输出：`dist/minecraft-bot-gui.exe`，约 97 MiB，是纯 Windows GUI 子系统。双击后不会出现黑色控制台，会直接打开控制面板窗口。

GUI 启动器会把核心静默释放到 `%LOCALAPPDATA%\minecraft-bot\core`，配置也在该目录；所有配置都可以在面板 UI 里直接改，不必手写 `config.json`。依赖系统 WebView2 Runtime（Windows 10/11 通常已内置）。

如果仍要命令行/服务器模式，运行 `dist/minecraft-bot.exe` 并把 `config.json` 放在 exe 同目录，日志写入同目录 `logs/agent.log`。

## 配置说明

| 配置 | 说明 |
| --- | --- |
| `mc.host` / `mc.port` | Minecraft 服务器地址和端口 |
| `mc.username` | 机器人名字 |
| `mc.auth` | `offline`（离线服）或 `microsoft` |
| `mc.version` | 版本，留空自动识别 |
| `mc.password` | 正版账号密码，离线留空 |
| `mc.pluginPassword` | 插件服登录密码（AuthMe/nLogin 等） |
| `mc.pluginLoginCommands` | 登录指令，{password} 会被替换成密码，多个用 \| 分隔 |
| `mc.pluginRegisterCommands` | 首次注册指令，无账号时才填 |
| `mc.pluginAuthDelayMs` | 进入服务器后延迟多少 ms 发送认证指令 |
| `mc.reconnect` | 断线后是否自动重连，默认 `true` |
| `mc.reconnectBaseDelayMs` | 重连基础延迟，默认 `3000` |
| `mc.reconnectMaxDelayMs` | 重连最大延迟，默认 `60000` |
| `mc.reconnectMaxAttempts` | 最大重连次数，`-1` 表示无限，默认 `-1` |
| `ai.baseUrl` | OpenAI 兼容 API 地址 |
| `ai.apiKey` | API Key |
| `ai.model` | 模型名 |
| `ai.intervalMs` | 决策间隔（毫秒） |
| `api.host` / `api.port` | 控制面板监听地址和端口 |
| `logging.file` / `logging.dir` / `logging.name` | 文件日志开关与路径 |
| `reactive.*` | 生存兜底/战斗参数，详见 `config.example.json` |

## 内置动作与技能

| 动作/技能 | 参数 | 说明 |
| --- | --- | --- |
| `chat` | `message` | 公聊发言 |
| `look` | `yaw`, `pitch` | 转向 |
| `lookAt` | `username` / `name` | 看向玩家/实体 |
| `move` | `direction`, `ms` | 前后左右/跳/跑/潜行 |
| `stop` | - | 停止移动和寻路 |
| `jump` | - | 跳跃 |
| `attack` | `name` / `username` | 自动换最佳近战武器/盾牌后攻击 |
| `use` | - | 使用当前手持物品 |
| `goto` | `x,y,z` 或 `username` | 寻路 |
| `dig` | `x,y,z` | 挖掘方块 |
| `place` | `x,y,z`, `face` | 放置方块 |
| `collect` | `name` 或 `x,y,z` | 采集方块或拾取掉落物 |
| `chopTree` | `radius?`, `max?` | 找树并挖掘相连原木 |
| `mineOreVein` | `name?`, `radius?`, `max?` | 找矿并挖掘相连矿脉 |
| `hunt` | `name?`, `username?`, `type?`, `max?` | 追踪并连续攻击目标 |
| `protect` | `username`, `radius?` | 守卫玩家：附近有敌则攻击，否则跟随 |
| `buildShelter` | - | 用背包建材搭 3x3 屋顶和四角柱 |
| `equip` | `name` | 装备物品 |
| `armor` | - | 自动穿最好护甲 |
| `weapon` | - | 自动拿最好近战武器 |
| `shield` | - | 装备盾牌 |
| `eat` | `name?` | 进食 |
| `wait` | `ms` | 等待 |

## 生存/战斗行为

- 平时自动整理最好护甲；进入战斗或低血量时自动换最佳近战武器、按需装备盾牌。
- 只有**血量低且已验证出安全逃跑路径**时才逃跑；路径终点会检查不是水/岩浆/火/仙人掌等危险方块。
- 低血量但找不到可靠逃生路径时，不转身乱跑：停下、整理战斗装备、举盾，近距离才反击。
- 战斗时不再站桩：接敌状态会左右侧移；低血量防守时同样小范围侧移并只在近距反击。
- 非低血量时不逃跑，除非显式开启 `reactive.engageOverFlee`，并满足武器/护甲条件才自动接敌。
- 落水会自动向最近干燥地面游；脚下危险会停止移动；血线过低会紧急下线。
- 参数可在 `config.json` 的 `reactive` 段覆盖，常用项：
  - `lowHealthFleeThreshold`：默认 8
  - `criticalHealthLogoutThreshold`：默认 4
  - `hostileScanRadius`：默认 16
  - `fleeMinPathLength`：默认 5
  - `fleeEscapeTestDistance`：默认 10
  - `fleeMinThreatDistance`：默认 2.5
  - `meleeStrafeEnabled`：默认 `true`
  - `meleeStrafeIntervalMs`：默认 900
  - `meleeAttackRange`：默认 3.5
  - `defensiveAttackRange`：默认 4

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 连接/AI/生存/重连状态 |
| GET | `/api/observations` | 当前观测 |
| POST | `/api/actions` | 手动执行动作 `{name, args}` |
| POST | `/api/ai/start` | 启动 AI 循环 |
| POST | `/api/ai/stop` | 停止 AI 循环 |
| POST | `/api/ai/goal` | 设置目标 `{goal}` |
| POST | `/api/ai/tick` | 手动触发一次决策 |

WebSocket：`/ws`，推送 `status`、`chat`、`observation`、`log`、`aiResult`。

## 部署到服务器

Docker：

```bash
docker compose up -d --build
```

环境变量参考 `.env.example`。服务器上把 `API_HOST` 设为 `0.0.0.0`，并把 `MC_HOST` 指向你的 Minecraft 服务器。

PM2：

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

## 目录

```
.
├─ index.js                 入口
├─ core/
│  ├─ agent.js              机器人连接、断线重连
│  ├─ observations.js       游戏状态观测
│  ├─ actions.js            动作与技能执行器
│  ├─ executor.js           串行技能队列、超时看门狗
│  ├─ pathfinderOwner.js    寻路令牌唯一入口
│  └─ reactive.js           生存/战斗兜底
├─ ai/
│  ├─ brain.js              决策循环、重复失败换方案
│  ├─ provider.js           OpenAI 兼容请求
│  ├─ tools.js              工具定义
│  └─ prompts/system.md     系统提示词
├─ api/
│  ├─ server.js             HTTP + WS
│  └─ routes.js             REST 路由
├─ lib/
│  ├─ combat.js             装备/武器/盾牌
│  ├─ config.js             配置
│  └─ logger.js             控制台 + 文件日志
├─ ui/                      控制面板
├─ scripts/                 启动/检查/打包脚本
├─ launcher/               Windows GUI 启动器
├─ desktop/                 桌面端说明
└─ Dockerfile / docker-compose.yml / ecosystem.config.js
```



