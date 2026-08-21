const assert = require('assert')
const { EventEmitter } = require('events')
const PathfinderOwner = require('../core/pathfinderOwner')
const Brain = require('../ai/brain')
const ChatCommander = require('../core/chatCommander')
const ReactiveController = require('../core/reactive')

function mockBotForPathfinder () {
  return {
    on () {},
    emit () {},
    pathfinder: {
      setMovements () {},
      setGoal () {},
      stop () {}
    }
  }
}

function mockBotForReactive () {
  return {
    on () {},
    emit () {},
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: {},
    heldItem: null,
    inventory: {
      items () {
        return [{ name: 'stone_sword', slot: 1 }]
      },
      slots: []
    },
    getEquipmentDestSlot () { return null },
    setControlState () {},
    activateItem () {},
    lookAt () {},
    attack () {},
    blockAt () { return null }
  }
}

// 1. PathfinderOwner enforces reactive-over-skill ownership.
{
  const owner = new PathfinderOwner(mockBotForPathfinder())
  const reactive = owner.acquire('reactive', { reason: 'test' })
  assert(reactive && reactive.token, 'reactive token should be granted')
  assert.strictEqual(owner.acquire('skill', { reason: 'test' }), null, 'skill cannot acquire while reactive owns pathfinder')
  assert.strictEqual(owner.setGoal(reactive.token, {}, { movements: {} }), true, 'valid reactive token can set goal')
  reactive.release()
  const skill = owner.acquire('skill', { reason: 'test' })
  assert(skill && skill.token, 'skill token should be granted after reactive release')
}

// 1b. A timeout carrying a partial path remains active until that route is walked.
{
  const bot = new EventEmitter()
  bot.pathfinder = {
    setMovements () {},
    setGoal () {},
    stop () {}
  }
  const owner = new PathfinderOwner(bot)
  const skill = owner.acquire('skill', { reason: 'partial-timeout-test' })
  owner.setGoal(skill.token, {})
  bot.emit('path_update', { status: 'timeout', path: [{ x: 1, y: 64, z: 0 }] })
  assert.strictEqual(owner.isIdle(), false, 'partial timeout path must not be discarded immediately')
  bot.emit('path_update', { status: 'timeout', path: [] })
  assert.strictEqual(owner.isIdle(), true, 'empty timeout path should mark pathfinder idle')
  owner.setGoal(skill.token, {})
  bot.emit('path_update', { status: 'noPath', path: [{ x: 1, y: 64, z: 0 }] })
  assert.strictEqual(owner.isIdle(), false, 'noPath with a best-effort route must be walked before replanning')
  bot.emit('path_update', { status: 'noPath', path: [] })
  assert.strictEqual(owner.isIdle(), true, 'empty noPath should mark pathfinder idle')
  const status = owner.status()
  assert.strictEqual(status.lastPathStatus, 'noPath', 'pathfinder diagnostics should expose the last A* status')
  assert.strictEqual(status.lastPathLength, 0, 'pathfinder diagnostics should expose the last path length')
  skill.release()
}

// 2. Brain forces a varied instruction after repeated identical plans.
{
  const executor = new EventEmitter()
  const agent = { executor, connected: true, snapshot () { return {} }, emit () {} }
  const brain = new Brain(agent, { intervalMs: 1500 })
  brain._forceVary = true
  const payload = brain._userPayload({})
  assert(payload.instruction.includes('必须换'), 'forced-vary instruction should tell the model to change plan')
  brain.destroy()
}

// 2a. AI request failures back off instead of hammering the provider every tick.
{
  const executor = new EventEmitter()
  const agent = { executor, connected: true, snapshot () { return {} }, emit () {} }
  const brain = new Brain(agent, { intervalMs: 1500 })
  brain.aiErrorStreak = 1
  assert.strictEqual(brain._setAiBackoff(new Error('AI API 429: rate limit')), 30000, 'rate limits should wait at least 30 seconds')
  brain.aiErrorStreak = 1
  assert.strictEqual(brain._setAiBackoff(new Error('request timed out')), 10000, 'timeouts should wait at least 10 seconds')
  brain.destroy()
}

// 2a2. Plan steps record failures and auto-skip after the configured limit.
{
  const executor = new EventEmitter()
  const agent = { executor, connected: true, snapshot () { return {} }, emit () {} }
  const brain = new Brain(agent, { intervalMs: 1500, stepFailLimit: 2 })
  brain.plan = brain._buildPlan('挖矿')
  brain.plan.activeStep = 0
  const step = brain.plan.steps[0]
  assert.strictEqual(step.failures || 0, 0, 'fresh step should have no failures')
  const first = brain._advancePlan({ name: 'inventory' }, { ok: false, reason: 'no path' })
  assert.strictEqual(brain.plan.steps[0].failures, 1, 'first failure should be recorded')
  assert.strictEqual(first, false, 'first failure should not advance yet')
  const second = brain._advancePlan({ name: 'inventory' }, { ok: false, reason: 'no path' })
  assert.strictEqual(brain.plan.steps[0].failures, 2, 'second failure should be recorded')
  assert.strictEqual(second, true, 'step should auto-skip after failing limit')
  assert.strictEqual(brain.plan.steps[0].done, true, 'failed step should be marked done (skip)')
  assert.ok(brain.plan.steps[0].lastFailReason, 'fail reason should be recorded')
  brain.destroy()
}

// 2a3. Survival priority short-circuits normal AI decisions when health is low.
{
  const executor = new EventEmitter()
  const agent = { executor, connected: true, snapshot () { return {} }, emit () {} }
  const brain = new Brain(agent, { intervalMs: 1500, apiKey: 'sk-valid' })
  const lowHealth = brain._survivalPriority({ bot: { health: 3, food: 20 }, nearbyHostiles: [], inventory: { items: [] } })
  assert.strictEqual(lowHealth[0].name, 'eat', 'low health should force eat')
  const lowFood = brain._survivalPriority({ bot: { health: 20, food: 4 }, nearbyHostiles: [], inventory: { items: [] } })
  assert.strictEqual(lowFood[0].name, 'eat', 'low food should force eat')
  const normal = brain._survivalPriority({ bot: { health: 20, food: 20 }, nearbyHostiles: [], inventory: { items: [{ name: 'iron_sword', count: 1 }] } })
  assert.strictEqual(normal, null, 'healthy bot should have no urgent action')
  brain.destroy()
}

// 2a4. Durability helpers work on prismarine-like items.
{
  const combat = require('../lib/combat')
  const wornTool = { name: 'iron_pickaxe', maxDurability: 250, durabilityUsed: 200 }
  const freshTool = { name: 'iron_pickaxe', maxDurability: 250, durabilityUsed: 10 }
  const nonTool = { name: 'dirt', maxDurability: 0, durabilityUsed: null }
  assert.strictEqual(combat.durabilityPercent(wornTool), 20, 'worn tool should report 20% durability')
  assert.strictEqual(combat.durabilityPercent(freshTool), 96, 'fresh tool should report 96% durability')
  assert.strictEqual(combat.durabilityPercent(nonTool), null, 'non-tool should report null durability')
  const worn = combat.wornTools([wornTool, freshTool, nonTool], 30)
  assert.strictEqual(worn.length, 1, 'only the worn tool should be flagged')
  assert.strictEqual(worn[0].pct, 20, 'worn tool percent should be 20')
}

// 2a5. Tool selection skips nearly-broken tools and picks the best usable one.
{
  const combat = require('../lib/combat')
  const brokenNetherite = { name: 'netherite_pickaxe', maxDurability: 2031, durabilityUsed: 2000, slot: 1 } // ~2%
  const freshStone = { name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 0, slot: 2 }
  const iron = { name: 'iron_pickaxe', maxDurability: 250, durabilityUsed: 5, slot: 3 }
  // 挖铁矿石：铁镐应该是首选（下界合金镐快坏了被跳过）
  const best = combat.toolForBlock('iron_ore', [brokenNetherite, iron, freshStone])
  assert.strictEqual(best.name, 'iron_pickaxe', 'should prefer fresh iron over broken netherite')
  // 挖石头（普通方块）也应匹配镐子
  const stoneBest = combat.toolForBlock('stone', [freshStone, brokenNetherite])
  assert.strictEqual(stoneBest.name, 'stone_pickaxe', 'plain stone should use a pickaxe')
  // 泥土用铲子
  const dirtBest = combat.toolForBlock('dirt', [{ name: 'stone_shovel', maxDurability: 131, durabilityUsed: 0, slot: 4 }])
  assert.strictEqual(dirtBest.name, 'stone_shovel', 'dirt should use a shovel')
  // 全部工具都坏时返回 null（空手）
  const allBroken = combat.toolForBlock('iron_ore', [{ name: 'iron_pickaxe', maxDurability: 250, durabilityUsed: 250 }])
  assert.strictEqual(allBroken, null, 'all broken tools should fall back to bare hands')
}

// 2b. Brain offline fallback keeps the bot busy when no valid API key is configured.
{
  const executor = new EventEmitter()
  const agent = { executor, connected: true, snapshot () { return {} }, emit () {} }
  const brain = new Brain(agent, { intervalMs: 1500, apiKey: 'sk-xxx' })
  assert.strictEqual(brain._hasValidApiKey(), false, 'placeholder API key should be treated as offline')
  const plan = brain._offlineActions({ bot: { food: 20 }, nearbyTargets: [], nearbyDrops: [], nearbyHostiles: [], inventory: null })
  assert(Array.isArray(plan) && plan.length > 0, 'offline fallback should produce a plan')
  brain.destroy()
}

// 2c. Brain offline autonomous build plan triggers when enough materials.
{
  const executor = new EventEmitter()
  const agent = { executor, connected: true, snapshot () { return {} }, emit () {} }
  const brain = new Brain(agent, { intervalMs: 1500, apiKey: 'sk-xxx' })
  brain._offlineStep = 5
  const houseState = { bot: { food: 20 }, nearbyTargets: [], nearbyDrops: [], nearbyHostiles: [], inventory: { items: [{ name: 'oak_planks', count: 70 }] } }
  const housePlan = brain._offlineActions(houseState)
  assert.strictEqual(housePlan[0].name, 'buildHouse', 'offline mode should autonomously build a house when enough planks are available')
  brain._offlineStep = 11
  const shelterState = { bot: { food: 20 }, nearbyTargets: [], nearbyDrops: [], nearbyHostiles: [], inventory: { items: [{ name: 'cobblestone', count: 20 }] } }
  const shelterPlan = brain._offlineActions(shelterState)
  assert.strictEqual(shelterPlan[0].name, 'buildShelter', 'offline mode should build a shelter with enough cobblestone')
  brain.destroy()
}

// 3. ChatCommander parses owner chat commands.
{
  const agent = new EventEmitter()
  const brain = { setGoal () {}, nudge () {} }
  const cm = new ChatCommander(agent, brain, { mc: { ownerName: 'Steve' } })
  assert.strictEqual(cm.isOwner('Steve'), true)
  assert.strictEqual(cm.isOwner('Alex'), false)
  const chop = cm.parse('砍树', 'Steve')
  assert.strictEqual(chop.action.name, 'chopTree')
  const follow = cm.parse('跟我走', 'Steve')
  assert.strictEqual(follow.action.name, 'follow')
  assert.strictEqual(follow.action.args.username, 'Steve')
  const stop = cm.parse('停止', 'Steve')
  for (const msg of ['跟住我', '跟紧我', '跟我来', '跟我一起', '过来', '来这边', '到我这里', 'follow me', 'come to me']) {
    const parsed = cm.parse(msg, 'Steve')
    assert.strictEqual(parsed.action && parsed.action.name, 'follow', 'should parse follow: ' + msg)
  }
  for (const msg of ['盖房子', '建个房子', '造房子', '搭房子', 'build house', 'build me a house']) {
    const parsed = cm.parse(msg, 'Steve')
    assert.strictEqual(parsed.action && parsed.action.name, 'buildHouse', 'should parse buildHouse: ' + msg)
  }
  for (const msg of ['建塔', '造个塔', '盖塔', 'build tower']) {
    const parsed = cm.parse(msg, 'Steve')
    assert.strictEqual(parsed.action && parsed.action.name, 'buildTower', 'should parse buildTower: ' + msg)
  }
  for (const msg of ['搭桥', '修桥', 'build bridge']) {
    const parsed = cm.parse(msg, 'Steve')
    assert.strictEqual(parsed.action && parsed.action.name, 'buildBridge', 'should parse buildBridge: ' + msg)
  }
  for (const msg of ['造墙', '砌墙', '修围墙', '围起来', 'build wall']) {
    const parsed = cm.parse(msg, 'Steve')
    assert.strictEqual(parsed.action && parsed.action.name, 'buildWall', 'should parse buildWall: ' + msg)
  }
  const stop2 = cm.parse('stop', 'Steve')
  assert.strictEqual(stop2.action && stop2.action.name, 'stop')
  const stop3 = cm.parse('别乱动', 'Steve')
  assert.strictEqual(stop3.action && stop3.action.name, 'stop')

  assert.strictEqual(stop.action.name, 'stop')
  const diamond = cm.parse('去找钻石', 'Steve')
  assert.strictEqual(diamond.action && diamond.action.name, 'mineOreVein')
  assert.strictEqual(diamond.action.args.name, 'diamond_ore')
  const goal = cm.parse('讲个笑话', 'Steve')
  assert.strictEqual(goal.action, undefined)
  assert.strictEqual(goal.goal.includes('主人指令'), true)

  const countedIron = cm.parse('挖10个铁矿石给我', 'Steve')
  assert.strictEqual(countedIron.action.name, 'mineOreVein')
  assert.strictEqual(countedIron.action.args.name, 'iron_ore')
  assert.strictEqual(countedIron.action.args.targetCount, 10)
  const countedChinese = cm.parse('挖十个铁矿石', 'Steve')
  assert.strictEqual(countedChinese.action.args.targetCount, 10)
}

// 3b. Deterministic owner commands work without ! while ordinary chat is ignored.
{
  const agent = new EventEmitter()
  const enqueued = []
  const said = []
  agent.connected = true
  agent.bot = { username: 'Bot', chat (message) { said.push(message) } }
  agent.executor = {
    currentCall: null,
    clear () {},
    enqueue (call) { enqueued.push(call) }
  }
  const brain = {
    setGoal () {},
    alignPlanToAction () {},
    recordAction () {},
    clearFollow () {},
    setHold () {},
    setFollow () {},
    nudge () {}
  }
  const cm = new ChatCommander(agent, brain, { mc: { ownerName: 'Steve', commandPrefix: '!' } })
  cm.onChat({ username: 'Steve', message: '跟随我' })
  assert.strictEqual(enqueued[0].name, 'follow', 'follow should work without command prefix')
  cm.onChat({ username: 'Steve', message: '挖10个铁矿石给我' })
  assert.strictEqual(enqueued[1].name, 'mineOreVein', 'counted mining should work without command prefix')
  assert.strictEqual(enqueued[1].args.targetCount, 10)
  cm.onChat({ username: 'Steve', message: '今天天气不错' })
  assert.strictEqual(enqueued.length, 2, 'ordinary owner chat should not become a command without prefix')
  assert(said.some(message => message.includes('持续跟随')), 'owner should receive immediate acknowledgement')
}

// 3c. Persistent follow is re-enqueued after the executor is replaced on reconnect.
{
  const firstExecutor = new EventEmitter()
  firstExecutor.queue = []
  firstExecutor.enqueue = function (call) { this.queue.push(call) }
  const agent = { executor: firstExecutor, connected: true, snapshot () { return {} }, emit () {} }
  const brain = new Brain(agent, { intervalMs: 1500 })
  brain.setFollow('Steve', 2)
  const nextExecutor = new EventEmitter()
  nextExecutor.queue = []
  nextExecutor.enqueue = function (call) { this.queue.push(call) }
  brain.setExecutor(nextExecutor)
  brain._clearFollowRetry()
  brain._reFollow()
  assert.strictEqual(nextExecutor.queue.length, 1)
  assert.strictEqual(nextExecutor.queue[0].name, 'follow')
  brain.destroy()
}

// 3d. Tool selection recognizes ordinary stone as pickaxe work.
{
  const combat = require('../lib/combat')
  const woodenPickaxe = { name: 'wooden_pickaxe', type: 270, slot: 1 }
  const woodenAxe = { name: 'wooden_axe', type: 271, slot: 2 }
  assert.strictEqual(combat.toolForBlock('stone', [woodenAxe, woodenPickaxe]), woodenPickaxe)
}

// 3e. Unreachable drops enter a cross-action cooldown and become eligible again after moving.
{
  const { Vec3 } = require('vec3')
  const actions = require('../core/actions')
  const drop = {
    id: 91,
    name: 'item',
    type: 'object',
    isValid: true,
    position: new Vec3(0, 72, 0),
    getDroppedItem () { return { name: 'coal' } }
  }
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: { 91: drop }
  }
  assert.strictEqual(actions._test.nearestItemDrop(bot, 12).entity, drop)
  actions._test.markDropPickupFailure(drop, 'height-gap', 60000)
  assert.strictEqual(actions._test.nearestItemDrop(bot, 12), null, 'cooling-down drop must be skipped by the next collect action')
  drop.position = new Vec3(0, 68, 0)
  assert.strictEqual(actions._test.nearestItemDrop(bot, 12).entity, drop, 'a moved drop should be retried before cooldown expires')
}

// 3f. Observation drops are local; distant entities must not force autonomous collect.
{
  const observations = require('../core/observations')
  const { Vec3 } = require('vec3')
  const drop = {
    id: 92,
    name: 'item',
    type: 'object',
    position: new Vec3(30, 64, 0),
    getDroppedItem () { return { name: 'coal' } }
  }
  const bot = {
    username: 'Bot',
    entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, onGround: true, distanceTo () { return 0 } },
    players: {},
    entities: { 92: drop },
    inventory: { items () { return [] } },
    health: 20,
    food: 20,
    foodSaturation: 5,
    game: { gameMode: 0, dimension: 'overworld' },
    time: { timeOfDay: 1000 }
  }
  const snapshot = observations.build(bot)
  assert.strictEqual(snapshot.nearbyDrops.length, 0, 'distant item entities must not trigger collect')
}

// 4. ReactiveController refuses unsafe melee engagements.
{
  const rc = new ReactiveController(mockBotForReactive(), { maxMeleeEngageThreatCount: 1, minArmorScoreToEngage: 0 }, {})
  const zombieThreat = {
    entity: { name: 'zombie', id: 1 },
    distance: 3,
    threats: [{ entity: { name: 'zombie', id: 1 }, distance: 3 }]
  }
  assert.strictEqual(rc._canEngage(zombieThreat), true, 'zombie with stone sword should be engageable')
  assert.strictEqual(rc._canEngage({ entity: { name: 'skeleton', id: 2 }, distance: 3, threats: [{ entity: { name: 'skeleton', id: 2 }, distance: 3 }] }), false, 'ranged threat should not be melee rushed')
  const many = {
    entity: { name: 'zombie', id: 3 },
    distance: 3,
    threats: [
      { entity: { name: 'zombie', id: 3 }, distance: 3 },
      { entity: { name: 'zombie', id: 4 }, distance: 4 }
    ]
  }
  assert.strictEqual(rc._canEngage(many), false, 'multiple threats should be denied by maxMeleeEngageThreatCount')
}

// 5. ReactiveController must not quit the server on critical health without an escape path.
{
  const bot = mockBotForReactive()
  bot.health = 2
  bot.quitCalls = 0
  bot.quit = function (reason) { this.quitCalls++; this.lastQuitReason = reason }
  bot.inventory.items = function () { return [{ name: 'stone_sword', slot: 1 }] }
  const rc = new ReactiveController(bot, { lowHealthFleeThreshold: 8, criticalHealthLogoutThreshold: 4 }, {})
  rc.pathfinderOwner = new PathfinderOwner(mockBotForPathfinder())
  rc.movements = {}
  rc._startFlee({
    entity: { name: 'zombie', id: 1, position: { x: 2, y: 64, z: 0, clone () { return this } } },
    distance: 2,
    threats: []
  }, Date.now())
  assert.strictEqual(bot.quitCalls, 0, 'critical health with no escape path must not call bot.quit')
  assert.strictEqual(rc.shuttingDown, false, 'critical health must not mark shuttingDown')
}

// 6. protect follows the owner instead of attacking when health is low.
{
  const actions = require('../core/actions')
  let attacked = 0
  const playerPos = { x: 0, y: 64, z: 0, distanceTo () { return 1 } }
  const bot = {
    health: 5,
    entity: { position: { x: 0, y: 64, z: 0, distanceTo () { return 1 } } },
    players: { Steve: { entity: { position: playerPos } } },
    reactiveController: { cfg: { lowHealthFleeThreshold: 8 } },
    attack () { attacked++ },
    lookAt () {},
    pathfinderOwner: null,
    pathfinder: null
  }
  const result = actions.handlers.protect(bot, { username: 'Steve', radius: 12 }, {})
  Promise.resolve(result).then((text) => {
    assert.strictEqual(attacked, 0, 'protect must not attack while low health')
    assert(text.includes('低血'), 'protect low-health result should mention following owner')
    
// 7. observations.build must tolerate missing chatBuffer (owner chat should not crash the core).
{
  const obs = require('../core/observations')
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, onGround: true, distanceTo () { return 0 } },
    players: {},
    entities: {},
    inventory: { items () { return [] } },
    username: 'Bot',
    health: 20,
    food: 20,
    foodSaturation: 5,
    game: { gameMode: 0, dimension: 'overworld' },
    time: { timeOfDay: 1000 }
  }
  const out = obs.build(bot, undefined)
  assert.strictEqual(out.connected, true)
  assert.strictEqual(Array.isArray(out.chat), true)
}

// 8. BotAgent can be manually disconnected before a bot exists without throwing.
{
  const BotAgent = require('../core/agent')
  const agent = new BotAgent({ mc: { host: '127.0.0.1', port: 25565, username: 'TestBot', auth: 'offline' }, reactive: {}, executor: {} })
  const st = agent.disconnect('test-disconnect')
  assert.strictEqual(st.connected, false)
  assert.strictEqual(agent.connected, false)
}
console.log('smoke: OK')
  }).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
