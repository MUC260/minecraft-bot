# Minecraft AI Bot

AI 驱动的 Minecraft 机器人。核心思路：**机器人观察游戏状态 → 通过 API 交给 AI → AI 返回动作 → 机器人执行**。

- 轻量：核心依赖只有 mineflayer + express + ws，桌面端用系统 WebView2/Edge，无需 Electron/Rust
- 舒服：自带深色控制面板，可看状态、聊天、实时观测、手动控制
- 可用：内置常用动作（移动、寻路、挖掘、放置、采集、攻击、自动装备、进食等）
- 可部署：可跑在本机，也可用 Docker / PM2 部署到服务器
- 可打包：默认 SEA 打包为单个 Windows exe，约 96 MiB，不依赖本机 Node

## 架构

```
ui/            控制面板（静态网页，由 api 服务托管）
api/           控制面：REST + WebSocket，供 UI/远程调用
ai/            AI 决策：OpenAI 兼容接口 + 工具定义 + 决策循环
core/          机器人：mineflayer 连接、观测、动作、生存反应
lib/           配置、日志、战斗/装备工具
scripts/       启动/检查/打包脚本
desktop/       桌面端说明
```

数据流：

```
Minecraft 服务器
      │
core/agent.js  ← 观测(observations.js)
      │           动作(actions.js)
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

编辑 `config.json`：

```json
{
  "mc": {
    "host": "localhost",
    "port": 25565,
    "username": "MyBot",
    "password": "",
    "auth": "offline"
  },
  "ai": {
    "enabled": true,
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-xxx",
    "model": "gpt-4o-mini",
    "temperature": 0.2,
    "maxTokens": 1200,
    "intervalMs": 1500
  },
  "api": {
    "host": "127.0.0.1",
    "port": 8787
  }
}
```

也支持 `.env` 环境变量覆盖（参考 `.env.example`）。

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

运行 exe 时，把 `config.json` 放在 exe 同目录，双击即可启动；没有面板时从浏览器打开 `http://127.0.0.1:8787`。

## 配置说明

| 配置 | 说明 |
| --- | --- |
| `mc.host` / `mc.port` | Minecraft 服务器地址和端口 |
| `mc.username` | 机器人名字 |
| `mc.auth` | `offline`（离线服）或 `microsoft` |
| `mc.password` | 正版账号密码，离线留空 |
| `ai.baseUrl` | OpenAI 兼容 API 地址 |
| `ai.apiKey` | API Key |
| `ai.model` | 模型名 |
| `ai.intervalMs` | 决策间隔（毫秒） |
| `api.host` / `api.port` | 控制面板监听地址和端口 |
| `reactive.*` | 生存兜底参数，详见 `config.example.json` |

## 内置动作

| 动作 | 参数 | 说明 |
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
- 非低血量时不逃跑，除非显式开启 `reactive.engageOverFlee`，并满足武器/护甲条件才自动接敌。
- 落水会自动向最近干燥地面游；脚下危险会停止移动；血线过低会紧急下线。
- 参数可在 `config.json` 的 `reactive` 段覆盖，常用项：
  - `lowHealthFleeThreshold`：默认 8
  - `criticalHealthLogoutThreshold`：默认 4
  - `hostileScanRadius`：默认 16
  - `fleeMinPathLength`：默认 5
  - `fleeEscapeTestDistance`：默认 10
  - `fleeMinThreatDistance`：默认 2.5

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 连接/AI/生存状态 |
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
│  ├─ agent.js              机器人连接与事件
│  ├─ observations.js       游戏状态观测
│  ├─ actions.js            动作执行器
│  └─ reactive.js           生存/战斗兜底
├─ ai/
│  ├─ brain.js              决策循环
│  ├─ provider.js           OpenAI 兼容请求
│  ├─ tools.js              工具定义
│  └─ prompts/system.md     系统提示词
├─ api/
│  ├─ server.js             HTTP + WS
│  └─ routes.js             REST 路由
├─ lib/
│  ├─ combat.js             装备/武器/盾牌
│  ├─ config.js             配置
│  └─ logger.js             日志
├─ ui/                      控制面板
├─ scripts/                 启动/检查/打包脚本
├─ desktop/                 桌面端说明
└─ Dockerfile / docker-compose.yml / ecosystem.config.js
```
