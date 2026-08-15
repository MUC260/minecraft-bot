# Cairn 深挖笔记与我们的落地映射

> 2026-08-15 追加。结论用于把 `minecraft-bot` 从“框架 demo”改成真正可用、可靠优先的机器人。

## 一、Cairn 的架构（最重要参考）

Cairn 是 reliability-first：**LLM 只做战略规划，生存和寻路全由确定性子系统控制**。

### 1. 三条 loop
1. **Reactive loop**
   - 每个 `physicsTick` 跑，但内部做节流（便宜检查约每 50ms）。
   - 纯硬编码 FSM，LLM 不允许进入。
   - 优先级：`EMERGENCY_LOGOUT -> WATER_ESCAPE -> FLEE_OR_ENGAGE -> HAZARD_ABORT -> NORMAL`。
   - Reactive 永远优先于 skill/advisor，通过 `bot.pathfinderOwner` 抢占寻路令牌。
2. **Skill executor loop**
   - 严格串行，一次只跑一个技能。
   - 每个技能返回 `{ ok, reason, state }`；被 reactive 抢占时返回 `{ preempted: true, ... }`，不算失败。
   - 抢占后不是直接丢弃，而是等待路径归零并重新执行同一个 call。
3. **Advisor loop**
   - LLM 只做规划，输出冻结技能词汇表里的调用。
   - 计划执行前会用最新世界快照再次校验，非法技能不执行。
   - 技能失败才 replan。

### 2. 寻路归属权：PathfinderOwner
所有 `bot.pathfinder.setGoal/stop` 必须经过同一个 owner：
- `acquire('reactive')` 永远成功，会中止当前 skill 信号并 `pathfinder.stop()`。
- `acquire('skill')` 在 reactive 持有时返回 `null`，skill 返回 `preempted`。
- token 是不透明对象，只做身份比较；过期 token 写路径只警告不执行。
- owner 追踪 `isIdle()`，executor 等待 `isIdle() + resumeDebounceMs` 后再继续，避免 reactive 刚释放又被打断。

### 3. 战斗/逃跑决策（combat_policy.js）
`chooseCombatResponse` 的核心决策顺序：
1. creeper：默认 flee（或远程/换远程武器）。
2. player threat：默认 flee（不开玩家 PVP）。
3. `health <= lowHealthFleeThreshold`：flee。
4. 不可近战怪（skeleton/blaze/ghast 等）：flee 或远程。
5. 多威胁集合：按 creeper/远程威胁/多怪压力处理。
6. 若 `engageOverFlee=false`：flee。
7. 武器/护甲/生存时间/击杀窗口校验，通过才 engage，否则 flee。

`estimateMeleeSurvival` 会算：
- `armorReduction`、`resistanceReduction`、`regenerationHps`、`absorptionHealth`
- `estimatedIncomingDps`（理论 DPS 和近期实际受伤 DPS 取较大）
- `secondsToLowHealth`、`secondsToDeath`、`hitsToLowHealth`
- 近战击杀所需 `secondsToKill`

### 4. FleeGoal
- `isEnd()` 恒为 `false`：路径查找器永远不会认为“逃完了”。
- `hasChanged()`：威胁移动超过 4 格才触发重规划。
- `heuristic`：负的“离威胁距离”，A* 自动选更远路线。
- Reactive 负责在退出半径 + 消抖后停止寻路、释放 token。

## 二、我们对 Cairn 的取舍

### 采纳
- `PathfinderOwner` 作为所有寻路写入的唯一入口。
- `ReactiveController` 硬编码生存 FSM。
- `SkillExecutor` 串行队列 + `{ ok / preempted / fail }` 返回。
- `Advisor` 只规划、走冻结 schema。
- 世界状态快照紧凑 JSON。
- 逃跑用“可验证路径”而不是盲目跑。

### 按用户最新要求调整
用户原话：**“也不是非要逃跑，如果真打不过了就逃跑，就是血量低，但也确信自己能跑的时候再跑。”**

因此我们不照抄 Cairn 的“看到怪就默认跑”。我们的逻辑是：
1. 血量不低时，可以打、可以守、可以继续任务，不自动跑。
2. 只有 `health <= lowHealthFleeThreshold` 才进入逃跑判断。
3. 进入逃跑前必须做 **escape confidence 校验**：
   - 当前威胁距离 >= `fleeMinThreatDistance`
   - 用 `pathfinder.getPathTo` 从当前位置向远离威胁方向探测一条路径
   - 路径状态为 `success` 或足够长的 `partial`
   - 路径长度 >= `fleeMinPathLength`
   - 找不到可逃路径就 **不跑**，避免“逃不动还转身被背刺”。
4. `criticalHealthLogoutThreshold` 作为最后保底：极低血量直接下线，而不是犹豫。

### 简化
- 不照搬 Cairn 的 Java Fabric 客户端、水桶放置、远程武器细节、海量 skill。
- 先做可靠的最小生存层 + 常用技能层，体积控制住，后续再增量加 skill。

## 三、我们自己的目标架构（落地版）

```
index.js
  ├─ BotAgent (mineflayer + pathfinder + PathfinderOwner + Reactive + Executor)
  ├─ ReactiveController (硬编码生存 FSM，最高优先级)
  │    ├─ criticalHealthLogout
  │    ├─ waterEscape
  │    ├─ immediateHazard
  │    └─ hostileDecision:
  │          lowHealth + canEscape  => flee
  │          lowHealth + !canEscape => 不跑，尝试战斗/原地保命
  │          !lowHealth + canWin    => 可 engage（按配置）
  │          !lowHealth + !canWin   => 不主动逃跑，保持/继续技能
  ├─ PathfinderOwner (寻路令牌唯一入口)
  ├─ SkillExecutor (动作队列，preempt 后恢复)
  ├─ Brain/Advisor (只规划，schema 校验，失败 replan)
  ├─ Actions/Skills (goto/dig/place/collect/equip/chat 等)
  ├─ Observations (标准 world-state snapshot)
  └─ API/UI (REST + WS 控制面板)
```

## 四、配置优先级建议（后面写入 config）

```json
"reactive": {
  "lowHealthFleeThreshold": 8,
  "criticalHealthLogoutThreshold": 4,
  "hostileScanRadius": 16,
  "hostileExitRadius": 42,
  "hostileExitDebounceMs": 500,
  "engageOverFlee": false,
  "fleeRange": 12,
  "fleeMinThreatDistance": 2.5,
  "fleeMinPathLength": 5,
  "fleeEscapeTestDistance": 10,
  "maxInterruptionsPerTarget": 3,
  "resumeDebounceMs": 1000
}
```

## 五、exe 体积控制（不变）
- 后端纯 Node，最终用 `@yao-pkg/pkg` 单 exe 或 Tauri sidecar。
- 目标 50–90MB，上限 150MB；不用 Electron。
- 插件只加真正需要的，避免把一个完整浏览器打包进去。
