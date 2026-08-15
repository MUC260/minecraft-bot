# Minecraft AI Bot

AI 驱动的 Minecraft 机器人框架。核心思路：**机器人观察游戏状态 → 通过 API 交给 AI → AI 返回动作 → 机器人执行**。

- 轻量：核心依赖只有 mineflayer + express + ws，桌面端用系统 WebView2/Edge，无需 Electron/Rust
- 舒服：自带深色控制面板，可看状态、聊天、实时观测、手动控制
- 可用：内置常用动作（移动、寻路、挖掘、放置、攻击、聊天、装备等）
- 可部署：可跑在本机，也可用 Docker / PM2 部署到服务器

## 架构

```
ui/            控制面板（静态网页，由 api 服务托管）
api/           控制面：REST + WebSocket，供 UI/远程调用
ai/            AI 决策：OpenAI 兼容接口 + 工具定义 + 决策循环
core/          机器人：mineflayer 连接、观测、动作执行
lib/           配置、日志
scripts/       启动脚本
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

## 内置动作

| 动作 | 参数 | 说明 |
| --- | --- | --- |
| `chat` | `message` | 公聊发言 |
| `look` | `yaw`, `pitch` | 转向 |
| `lookAt` | `username` / `name` | 看向玩家/实体 |
| `move` | `direction`, `ms` | 前后左右/跳/跑/潜行 |
| `stop` | - | 停止移动 |
| `jump` | - | 跳跃 |
| `attack` | `name` / `username` | 攻击目标 |
| `use` | - | 使用手持物品 |
| `goto` | `x,y,z` 或 `username` | 寻路 |
| `dig` | `x,y,z` | 挖掘方块 |
| `place` | `x,y,z` | 放置方块 |
| `equip` | `name` | 装备物品 |
| `wait` | `ms` | 等待 |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 连接/AI 状态 |
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
│  └─ actions.js            动作执行器
├─ ai/
│  ├─ brain.js              决策循环
│  ├─ provider.js           OpenAI 兼容请求
│  ├─ tools.js              工具定义
│  └─ prompts/system.md     系统提示词
├─ api/
│  ├─ server.js             HTTP + WS
│  └─ routes.js             REST 路由
├─ ui/                      控制面板
├─ scripts/                 启动脚本
├─ desktop/                 桌面端说明
└─ Dockerfile / docker-compose.yml / ecosystem.config.js
```
