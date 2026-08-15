const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const combat = require('../lib/combat')

const STATE = Object.freeze({
  NORMAL: 'NORMAL',
  FLEEING: 'FLEEING',
  ENGAGING: 'ENGAGING',
  WATER_ESCAPE: 'WATER_ESCAPE',
  HAZARD: 'HAZARD',
  EMERGENCY: 'EMERGENCY'
})

const HOSTILE_NAMES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'husk', 'stray',
  'drowned', 'phantom', 'piglin', 'piglin_brute', 'zombified_piglin',
  'hoglin', 'zoglin', 'wither_skeleton', 'blaze', 'magma_cube', 'slime',
  'ghast', 'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite',
  'vex', 'warden', 'breeze', 'bogged'
])

const RANGED_HOSTILE_NAMES = new Set([
  'skeleton', 'stray', 'bogged', 'blaze', 'ghast', 'pillager', 'witch',
  'shulker', 'guardian', 'elder_guardian', 'phantom'
])
const NO_MELEE_HOSTILE_NAMES = new Set([
  'creeper', 'enderman', 'warden'
])
const DANGER_BLOCKS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'wither_rose'])
const WATER_BLOCKS = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'flowing_water'])

function posKey (pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
}

function distance3 (a, b) {
  return a.distanceTo(b)
}

function horizontalDistance (a, b) {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.hypot(dx, dz)
}

function round (n, digits = 2) {
  if (!Number.isFinite(n)) return null
  return Number(n.toFixed(digits))
}

function nearestHostile (bot, radius) {
  if (!bot.entity) return null
  let best = null
  const threats = []
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || entity === bot.entity) continue
    if (!HOSTILE_NAMES.has(entity.name)) continue
    const dist = distance3(bot.entity.position, entity.position)
    if (dist > radius) continue
    threats.push({ entity, distance: dist })
    if (!best || dist < best.distance) best = { entity, distance: dist }
  }
  if (!best) return null
  threats.sort((a, b) => a.distance - b.distance)
  best.threats = threats
  return best
}
function findNearestDryLand (bot, radius = 6) {
  if (!bot.entity) return null
  const p = bot.entity.position
  for (let r = 0; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        const x = Math.floor(p.x) + dx
        const y = Math.floor(p.y)
        const z = Math.floor(p.z) + dz
        const feet = bot.blockAt(new Vec3(x, y, z))
        const head = bot.blockAt(new Vec3(x, y + 1, z))
        const ground = bot.blockAt(new Vec3(x, y - 1, z))
        if (!feet || !head || !ground) continue
        if (WATER_BLOCKS.has(feet.name) || WATER_BLOCKS.has(head.name) || WATER_BLOCKS.has(ground.name)) continue
        if (!head.boundingBox || head.boundingBox !== 'empty') continue
        if (!ground.boundingBox || ground.boundingBox === 'empty') continue
        return { x, y, z }
      }
    }
  }
  return null
}

class ReactiveController {
  constructor (bot, cfg = {}, { pathfinderOwner, movements = null } = {}) {
    this.bot = bot
    this.cfg = cfg
    this.pathfinderOwner = pathfinderOwner
    this.movements = movements
    this.state = STATE.NORMAL
    this.lastTick = 0
    this.transitionCount = 0
    this.lastTransition = null
    this.transitionHistory = []
    this._tokenHandle = null
    this._fleeingFrom = null
    this._engaging = null
    this._exitClearSince = 0
    this._waterEscapeClearSince = 0
    this._hostileScanCounter = 0
    this._lastThreatPos = null
    this._lastEscapeTarget = null
    this._lastCloseFleeRepathAt = 0
    this._lastHazardLogAt = 0
    this._lastWaterLogAt = 0
    this._autoEatBusy = false
    this._autoEatAt = 0
    this._autoGearBusy = false
    this._autoGearAt = 0
    this._lastHealth = null
    this._lastDamagedAt = 0
    this._damageTaken = 0
    this._lastAttackAt = 0
    this._lastCombatMoveAt = 0
    this._combatMoveSign = 1
    this.shuttingDown = false

    bot.reactiveController = this
    this._bind('physicsTick', () => this._tick())
    this._bind('death', () => this._transition(STATE.NORMAL, 'death-reset'))
    this._bind('end', () => {
      this.shuttingDown = true
      this._releaseToken()
    })
  }

  setMovements (movements) {
    this.movements = movements
  }

  _bind (event, listener) {
    try {
      this.bot.on(event, listener)
    } catch {}
  }

  _ensureToken (reason) {
    if (this._tokenHandle) return this._tokenHandle
    if (!this.pathfinderOwner) return null
    this._tokenHandle = this.pathfinderOwner.acquire('reactive', { reason })
    return this._tokenHandle
  }

  _releaseToken () {
    if (!this._tokenHandle) return
    this._stopOwnedPath('reactive-release')
    try { this._tokenHandle.release() } catch {}
    this._tokenHandle = null
  }

  _stopOwnedPath (reason) {
    if (!this._tokenHandle || !this.pathfinderOwner) return
    this.pathfinderOwner.stop(this._tokenHandle.token)
  }

  _transition (next, reason, extra = {}) {
    if (this.state === next) return
    const prev = this.state
    if (prev === STATE.ENGAGING) this._stopCombatControls()
    this.state = next
    this.transitionCount++
    const t = { from: prev, to: next, reason, ...extra, at: Date.now() }
    this.lastTransition = t
    this.transitionHistory.push(t)
    if (this.transitionHistory.length > 100) this.transitionHistory.shift()
    this.bot.emit('reactive:state', t)
    if (next === STATE.NORMAL) this._releaseToken()
  }

  _tick () {
    if (this.shuttingDown) return
    const now = Date.now()
    if (now - this.lastTick < 100) return
    this.lastTick = now

    if (!this.bot.entity || !Number.isFinite(this.bot.health)) return
    const previousHealth = this._lastHealth
    if (Number.isFinite(previousHealth) && this.bot.health < previousHealth) {
      this._lastDamagedAt = now
      this._damageTaken += previousHealth - this.bot.health
    }
    this._lastHealth = this.bot.health

    // 1. Critical health is handled inside _startFlee when no verified escape
    //    path exists. At critical health we still prefer a verified flee path
    //    over immediately logging out.
    // 2. Water escape
    if (this._scanWater()) {
      this._waterEscapeClearSince = 0
      if (this.state !== STATE.WATER_ESCAPE) {
        this._transition(STATE.WATER_ESCAPE, 'water-escape', {
          inWater: this.bot.entity.isInWater === true,
          oxygenLevel: this.bot.oxygenLevel ?? null
        })
      }
      this._applyWaterEscape(now)
      return
    }
    if (this.state === STATE.WATER_ESCAPE) {
      if (this._waterEscapeClearSince === 0) this._waterEscapeClearSince = now
      if (now - this._waterEscapeClearSince >= 800) {
        this._waterEscapeClearSince = 0
        this._transition(STATE.NORMAL, 'water-cleared')
      }
      return
    }

    // 3. Immediate hazard
    const hazard = this._scanImmediateHazard()
    if (hazard) {
      if (this.state !== STATE.HAZARD) {
        this._transition(STATE.HAZARD, 'hazard-detected', { block: hazard.name })
        this._ensureToken('HAZARD')
      }
      this._applyHazard()
      return
    }
    if (this.state === STATE.HAZARD) this._transition(STATE.NORMAL, 'hazard-cleared')

    // 3.5 Auto gear before combat decision
    this._autoGear(now)

    // 4. Hostile decision
    this._handleHostile(now)

    // 5. Auto eat when nothing survival-critical is happening.
    this._autoEat(now)
  }

  _scanWater () {
    const b = this.bot
    if (b.entity.isInWater === true || (b.entity.isInLava === true)) return true
    if (Number.isFinite(b.oxygenLevel) && b.oxygenLevel < 15) return true
    const feet = b.blockAt(b.entity.position)
    return !!(feet && WATER_BLOCKS.has(feet.name))
  }

  _scanImmediateHazard () {
    const b = this.bot
    const positions = [
      b.entity.position,
      b.entity.position.offset(0, -1, 0),
      b.entity.position.offset(0, 1, 0)
    ]
    for (const pos of positions) {
      const block = b.blockAt(pos)
      if (block && DANGER_BLOCKS.has(block.name)) return block
    }
    return null
  }

  _applyHazard () {
    this._stopOwnedPath('hazard-stop')
    this.bot.setControlState('forward', false)
    this.bot.setControlState('jump', false)
  }

  _stopCombatControls () {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      this.bot.setControlState(c, false)
    }
  }

  _lookAtThreat (threat) {
    if (!threat || !threat.entity) return false
    try {
      const t = threat.entity
      const eye = t.position.offset(0, (t.height || 1.6) * 0.8, 0)
      this.bot.lookAt(eye, true)
      return true
    } catch {
      return false
    }
  }

  _canAttack (threat, now) {
    if (!threat || !threat.entity) return false
    const range = this.cfg.meleeAttackRange ?? 3.5
    if (threat.distance > range) return false
    return now - this._lastAttackAt >= (this.cfg.meleeAttackIntervalMs ?? 500)
  }

  _tryAttack (threat, now) {
    if (!this._canAttack(threat, now)) return false
    this._lookAtThreat(threat)
    try {
      this.bot.attack(threat.entity)
      this._lastAttackAt = now
      return true
    } catch {
      return false
    }
  }

  _strafe (now) {
    if (this.cfg.meleeStrafeEnabled === false) return
    const interval = this.cfg.meleeStrafeIntervalMs ?? 900
    if (now - this._lastCombatMoveAt < interval) return
    this._lastCombatMoveAt = now
    const sign = this._combatMoveSign
    this._combatMoveSign *= -1
    this.bot.setControlState('left', sign > 0)
    this.bot.setControlState('right', sign < 0)
    setTimeout(() => {
      if (this.state === STATE.ENGAGING || this.state === STATE.NORMAL) {
        this.bot.setControlState('left', false)
        this.bot.setControlState('right', false)
      }
    }, Math.min(260, Math.max(120, interval / 4)))
  }

  _updateEngagement (threat, now) {
    if (!threat || this.state !== STATE.ENGAGING) return
    this._lookAtThreat(threat)
    if (this.cfg.meleeStrafeEnabled !== false) this._strafe(now)
    if (threat.distance > (this.cfg.meleeAttackRange ?? 3.5)) {
      this.bot.setControlState('forward', true)
    } else {
      this.bot.setControlState('forward', false)
      this._tryAttack(threat, now)
    }
  }

  _defensiveCombat (threat, now) {
    if (!threat) return
    this._lookAtThreat(threat)
    if (combat.hasShield(this.bot)) {
      try { this.bot.activateItem(true) } catch {}
    }
    if (this.cfg.meleeStrafeEnabled !== false) this._strafe(now)
    const name = String(threat.entity.name || '')
    const canMelee = !RANGED_HOSTILE_NAMES.has(name) && !NO_MELEE_HOSTILE_NAMES.has(name)
    if (canMelee && threat.distance <= (this.cfg.defensiveAttackRange ?? 4)) {
      this._tryAttack(threat, now)
    }
  }
  _applyWaterEscape (now) {
    const land = findNearestDryLand(this.bot, 6)
    if (land && this.pathfinderOwner && this.movements) {
      const token = this._ensureToken('WATER_ESCAPE')
      if (token) {
        const goal = new goals.GoalNear(land.x, land.y, land.z, 1)
        this.pathfinderOwner.setGoal(token.token, goal, { movements: this.movements })
      }
    }
    if (!land) {
      this.bot.setControlState('jump', true)
    } else {
      this.bot.setControlState('jump', false)
    }
    if (now - this._lastWaterLogAt > 2000) {
      this.bot.emit('reactive:log', { level: 'warn', message: 'water escape active' })
      this._lastWaterLogAt = now
    }
  }

  _handleHostile (now) {
    this._hostileScanCounter = (this._hostileScanCounter + 1) % 3
    if (this._hostileScanCounter !== 0) return

    const enterRadius = this.cfg.hostileScanRadius ?? 16
    const exitRadius = this.cfg.hostileExitRadius ?? (enterRadius + 6)
    const debounce = this.cfg.hostileExitDebounceMs ?? 500
    let threat = null

    if (this.state === STATE.FLEEING && this._fleeingFrom) {
      threat = nearestHostile(this.bot, exitRadius)
      if (threat && threat.entity.id !== this._fleeingFrom.id) {
        threat = nearestHostile(this.bot, enterRadius)
      }
    } else {
      threat = nearestHostile(this.bot, enterRadius)
    }

    if (!threat) {
      if (this.state === STATE.FLEEING || this.state === STATE.ENGAGING) {
        if (this._exitClearSince === 0) this._exitClearSince = now
        if (now - this._exitClearSince >= debounce) {
          this._exitClearSince = 0
          this._fleeingFrom = null
          this._engaging = null
          this._transition(STATE.NORMAL, 'threat-cleared')
        }
      }
      return
    }

    this._exitClearSince = 0
    const health = this.bot.health ?? 20
    const lowHealth = health <= (this.cfg.lowHealthFleeThreshold ?? 8)

    // User preference: only flee when low health AND we can verify an escape path.
    if (lowHealth) {
      if (this.state === STATE.FLEEING && this._fleeingFrom && this._fleeingFrom.id === threat.entity.id) {
        if (this._shouldRepathFlee(threat) || this._shouldRepathCloseFlee(threat, now)) {
          this._lastCloseFleeRepathAt = now
          this._startFlee(threat, now)
        }
        return
      }
      this._startFlee(threat, now)
      return
    }

    // Not low health: do not flee. If currently fleeing, clear it.
    if (this.state === STATE.FLEEING) {
      this._fleeingFrom = null
      this._transition(STATE.NORMAL, 'health-recovered-while-fleeing')
      return
    }

    // Fight when explicitly configured, or when we recently took damage and are
    // capable of fighting the specific threat. Ranged/explosive threats never
    // trigger a melee rush; they get a shield/strafe defense instead.
    const recentlyAttacked = now - this._lastDamagedAt < (this.cfg.defendWhenAttackedWindowMs ?? 2000)
    const wantEngage = this.cfg.engageOverFlee === true || recentlyAttacked
    if (wantEngage) {
      if (this._canEngage(threat)) {
        if (this.state !== STATE.ENGAGING) {
          this._engaging = threat.entity
          this._transition(STATE.ENGAGING, 'hostile-engage', { entity: threat.entity.name, dist: round(threat.distance) })
        }
        this._updateEngagement(threat, now)
      } else {
        if (this.state === STATE.ENGAGING) {
          this._engaging = null
          this._transition(STATE.NORMAL, 'engage-policy-denied')
        }
        this._defensiveCombat(threat, now)
      }
    }
  }

  _canEngage (threat) {
    if (!threat?.entity) return false
    const name = String(threat.entity.name || '')
    if (RANGED_HOSTILE_NAMES.has(name) || NO_MELEE_HOSTILE_NAMES.has(name)) return false
    const threatCount = Array.isArray(threat.threats) && threat.threats.length ? threat.threats.length : 1
    if ((this.cfg.maxMeleeEngageThreatCount ?? 1) < threatCount) return false
    const held = this.bot.heldItem
    const best = combat.bestMeleeWeapon(this.bot.inventory.items())
    if (!best && !(held && combat.isMeleeWeapon(held))) return false
    if (this.cfg.requireShieldToEngage && !combat.hasShield(this.bot)) return false
    const currentArmor = combat.currentArmorScore(this.bot)
    if (currentArmor < (this.cfg.minArmorScoreToEngage ?? 0)) return false
    return true
  }
  _shouldRepathFlee (threat) {
    const last = this._lastThreatPos
    if (!last) return true
    const moved = horizontalDistance(threat.entity.position, last)
    return moved >= (this.cfg.fleeReplanThresholdBlocks ?? 4)
  }

  _shouldRepathCloseFlee (threat, now) {
    const distance = Number(threat?.distance)
    const threshold = Number.isFinite(this.cfg.fleeCloseRepathDistance) ? Math.max(0, this.cfg.fleeCloseRepathDistance) : 3
    if (!Number.isFinite(distance) || distance > threshold) return false
    try {
      if (this.pathfinderOwner?.isIdle?.() === true) return true
    } catch {}
    const replanMs = Number.isFinite(this.cfg.fleeCloseRepathMs) ? Math.max(100, this.cfg.fleeCloseRepathMs) : 500
    return now - this._lastCloseFleeRepathAt >= replanMs
  }
  _startFlee (threat, now) {
    if (!this.pathfinderOwner || !this.movements) return

    const escape = this._findEscapeTarget(threat)
    if (!escape) {
      // Low health but no verified path. Do NOT turn and run; stay/attack.
      if (this.state === STATE.FLEEING) {
        this._stopOwnedPath('no-escape-path')
        this._fleeingFrom = null
        this._transition(STATE.NORMAL, 'no-verified-escape-path')
      }
      this.bot.emit('reactive:log', { level: 'warn', message: `low-health-no-escape: staying to fight (${threat.entity.name} ${round(threat.distance)}m)` })
      if (this.bot.health > 0 && this.bot.health <= (this.cfg.criticalHealthLogoutThreshold ?? 4)) {
        if (!this.shuttingDown) {
          this._transition(STATE.EMERGENCY, 'critical-health-no-escape', { health: this.bot.health })
          this._ensureToken('EMERGENCY')
          this.bot.emit('reactive:emergency-logout', { health: this.bot.health, reason: 'critical-health-no-escape' })
          try { this.bot.quit('emergency:critical-health') } catch {}
          this.shuttingDown = true
        }
        return
      }
      this._prepareCombatLoadout(now)
      this._defensiveCombat(threat, now)
      return
    }

    const token = this._ensureToken('FLEEING')
    if (!token) return
    if (this.state !== STATE.FLEEING) {
      this._fleeingFrom = threat.entity
      this._transition(STATE.FLEEING, 'hostile-flee-verified', {
        entity: threat.entity.name,
        dist: round(threat.distance),
        pathLength: escape.pathLength
      })
    }
    this._lastThreatPos = threat.entity.position.clone()
    this._lastEscapeTarget = escape
    const goal = new goals.GoalNear(escape.target.x, escape.target.y, escape.target.z, 1)
    this.pathfinderOwner.setGoal(token.token, goal, { movements: this.movements })
    this.bot.emit('reactive:log', { level: 'warn', message: `逃跑已确认路径: ${threat.entity.name} ${round(threat.distance)}m -> (${escape.target.x},${escape.target.y},${escape.target.z})` })
  }

  _findEscapeTarget (threat) {
    if (!this.bot.pathfinder || !this.movements) return null
    if (!threat || !threat.entity) return null
    const minThreatDistance = this.cfg.fleeMinThreatDistance ?? 2.5
    const minPathLength = this.cfg.fleeMinPathLength ?? 5
    if (threat.distance < minThreatDistance) return null

    const p = this.bot.entity.position
    let dx = p.x - threat.entity.position.x
    let dz = p.z - threat.entity.position.z
    const len = Math.hypot(dx, dz)
    if (len < 0.0001) {
      dx = 1
      dz = 0
    } else {
      dx /= len
      dz /= len
    }

    const baseAngle = Math.atan2(dz, dx)
    const distances = [10, 14, 8]
    const candidates = []
    for (const dist of distances) {
      for (let i = 0; i < 8; i++) {
        const angle = baseAngle + (i - 3.5) * 0.4
        const x = Math.floor(p.x + Math.cos(angle) * dist)
        const z = Math.floor(p.z + Math.sin(angle) * dist)
        const y = Math.floor(p.y)
        const target = { x, y, z }
        let result = null
        try {
          result = this.bot.pathfinder.getPathTo(this.movements, new goals.GoalNear(x, y, z, 1), 500)
        } catch {
          continue
        }
        if (!result || !Array.isArray(result.path)) continue
        const pathLength = result.path.length
        const valid = result.status === 'success' && pathLength >= minPathLength
        if (!valid && !(result.status === 'partial' && pathLength >= minPathLength + 2)) continue

        const feet = this.bot.blockAt(new Vec3(x, y, z))
        const head = this.bot.blockAt(new Vec3(x, y + 1, z))
        const ground = this.bot.blockAt(new Vec3(x, y - 1, z))
        if (!ground || ground.boundingBox === 'empty') continue
        if (feet && (WATER_BLOCKS.has(feet.name) || DANGER_BLOCKS.has(feet.name))) continue
        if (head && (WATER_BLOCKS.has(head.name) || DANGER_BLOCKS.has(head.name))) continue
        if (ground && (WATER_BLOCKS.has(ground.name) || DANGER_BLOCKS.has(ground.name))) continue

        const threats = Array.isArray(threat.threats) && threat.threats.length ? threat.threats : [threat]
        let threatDist = Infinity
        for (const entry of threats) {
          const d = distance3(new Vec3(x, y, z), entry.entity.position)
          if (d < threatDist) threatDist = d
        }
        const safetyBonus = Math.max(0, 10 - threatDist)
        const score = pathLength * 1.0 - safetyBonus * 1.5 + (result.status === 'partial' ? 4 : 0)
        candidates.push({ target, pathLength, status: result.status, threatDist, score })
      }
    }

    if (!candidates.length) return null
    candidates.sort((a, b) => a.score - b.score)
    const best = candidates[0]
    return { target: best.target, pathLength: best.pathLength, status: best.status, threatDist: round(best.threatDist) }
  }

  _shouldGearForCombat () {
    if (this.state === STATE.ENGAGING || this.state === STATE.FLEEING) return true
    const health = this.bot.health ?? 20
    return health <= (this.cfg.lowHealthFleeThreshold ?? 8)
  }

  _autoGear (now) {
    if (this._autoGearBusy) return
    if (now - this._autoGearAt < 1500) return
    if (this.bot.skillExecutor && this.bot.skillExecutor.busy) return
    if (![STATE.NORMAL, STATE.ENGAGING, STATE.FLEEING].includes(this.state)) return

    this._autoGearBusy = true
    this._autoGearAt = now
    ;(async () => {
      try {
        const armor = await combat.equipBestArmor(this.bot)
        if (this._shouldGearForCombat()) {
          await combat.equipBestMelee(this.bot)
          if (this.cfg.requireShieldToEngage || this.bot.health <= (this.cfg.lowHealthFleeThreshold ?? 8)) {
            await combat.equipShield(this.bot)
          }
        }
        if (armor && armor.length) {
          this.bot.emit('reactive:log', { level: 'info', message: '自动装备护甲: ' + armor.join(', ') })
        }
      } catch (err) {
        this.bot.emit('reactive:log', { level: 'warn', message: '自动装备失败: ' + (err.message || err) })
      } finally {
        this._autoGearBusy = false
      }
    })()
  }

  _prepareCombatLoadout (now) {
    if (now - this._autoGearAt < 800) return
    this._autoGearAt = now
    ;(async () => {
      try {
        await combat.equipBestMelee(this.bot)
        await combat.equipShield(this.bot)
      } catch (err) {
        this.bot.emit('reactive:log', { level: 'warn', message: '战斗装备切换失败: ' + (err.message || err) })
      }
    })()
  }

  _autoEat (now) {
    if (!this.cfg.reactiveConsumablesEnabled) return
    if (this._autoEatBusy) return
    if (this.state !== STATE.NORMAL) return
    if (this.bot.skillExecutor && this.bot.skillExecutor.busy) return
    if (now - this._autoEatAt < 3000) return
    if (Number.isFinite(this.bot.food) && this.bot.food > (this.cfg.autoEatStartAt ?? 18)) return

    const food = this._pickFood()
    if (!food) return
    this._autoEatBusy = true
    this._autoEatAt = now
    ;(async () => {
      try {
        await this.bot.equip(food, 'hand')
        await this.bot.consume()
        this.bot.emit('reactive:log', { level: 'info', message: `自动进食 ${food.displayName || food.name}` })
      } catch (err) {
        this.bot.emit('reactive:log', { level: 'warn', message: `自动进食失败: ${err.message || err}` })
      } finally {
        this._autoEatBusy = false
      }
    })()
  }

  _pickFood () {
    const foods = new Set([
      'apple', 'golden_apple', 'enchanted_golden_apple', 'bread', 'cooked_beef', 'cooked_porkchop',
      'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'baked_potato',
      'carrot', 'melon_slice', 'sweet_berries', 'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon'
    ])
    const items = this.bot.inventory.items().filter(i => foods.has(i.name))
    items.sort((a, b) => {
      const score = n => /cooked_beef|cooked_porkchop|golden_apple/.test(n) ? 1 : 0
      return score(b.name) - score(a.name)
    })
    return items[0] || null
  }

  status () {
    return {
      state: this.state,
      transitionCount: this.transitionCount,
      lastTransition: this.lastTransition,
      fleeingFrom: this._fleeingFrom ? this._fleeingFrom.name : null,
      engaging: this._engaging ? this._engaging.name : null,
      escapeTarget: this._lastEscapeTarget?.target || null,
      combat: {
        armor: combat.armorSummary(this.bot),
        weapon: combat.heldWeaponSummary(this.bot),
        shield: combat.hasShield(this.bot)
      }
    }
  }
}

ReactiveController.STATE = STATE
module.exports = ReactiveController
module.exports.STATE = STATE