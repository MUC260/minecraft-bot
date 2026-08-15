const assert = require('assert')
const { EventEmitter } = require('events')
const PathfinderOwner = require('../core/pathfinderOwner')
const Brain = require('../ai/brain')
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

// 3. ReactiveController refuses unsafe melee engagements.
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

console.log('smoke: OK')