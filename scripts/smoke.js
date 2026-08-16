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
