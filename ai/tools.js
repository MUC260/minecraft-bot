const TOOLS = [
  { type: 'function', function: { name: 'chat', description: 'Send a message in Minecraft public chat', parameters: { type: 'object', properties: { message: { type: 'string', description: 'Message content' } }, required: ['message'] } } },
  { type: 'function', function: { name: 'look', description: 'Turn to a yaw/pitch', parameters: { type: 'object', properties: { yaw: { type: 'number' }, pitch: { type: 'number' } } } } },
  { type: 'function', function: { name: 'lookAt', description: 'Look at an entity or player', parameters: { type: 'object', properties: { username: { type: 'string' }, name: { type: 'string' } } } } },
  { type: 'function', function: { name: 'move', description: 'Move in a direction for a short duration', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] }, ms: { type: 'number' } }, required: ['direction'] } } },
  { type: 'function', function: { name: 'stop', description: 'Stop movement and pathfinding', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'jump', description: 'Jump once', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'attack', description: 'Equip melee/shield and attack nearby target', parameters: { type: 'object', properties: { name: { type: 'string' }, username: { type: 'string' } } } } },
  { type: 'function', function: { name: 'use', description: 'Use currently held item', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'goto', description: 'Pathfind to coordinates or follow a player', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, range: { type: 'number' }, username: { type: 'string' }, distance: { type: 'number' } } } } },
  { type: 'function', function: { name: 'dig', description: 'Dig the block at coordinates', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] } } },
  { type: 'function', function: { name: 'place', description: 'Place a block against the target block', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, face: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } } }, required: ['x', 'y', 'z'] } } },
  { type: 'function', function: { name: 'collect', description: 'Collect nearest matching block or pick up nearby drops', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Block id such as oak_log or coal_ore; omit to pick up drops' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, radius: { type: 'number', description: 'Search radius, default 12' } } } } },
  { type: 'function', function: { name: 'chopTree', description: 'Find the nearest tree and chop connected log blocks', parameters: { type: 'object', properties: { radius: { type: 'number', description: 'Search radius, default 12, max 24' }, max: { type: 'number', description: 'Max log blocks, default 64, max 128' } } } } },
  { type: 'function', function: { name: 'mineOreVein', description: 'Find and mine a connected ore vein, optionally by block id', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Ore block id, e.g. coal_ore, iron_ore; omit for any ore' }, radius: { type: 'number', description: 'Search radius, default 12, max 24' }, max: { type: 'number', description: 'Max ore blocks, default 48, max 96' } } } } },
  { type: 'function', function: { name: 'hunt', description: 'Path to and repeatedly attack a target entity or player', parameters: { type: 'object', properties: { name: { type: 'string' }, username: { type: 'string' }, type: { type: 'string' }, max: { type: 'number', description: 'Max attacks, default 30' } } } } },
  { type: 'function', function: { name: 'protect', description: 'Guard a player: attack nearby hostiles or follow the player', parameters: { type: 'object', properties: { username: { type: 'string' }, radius: { type: 'number', description: 'Threat scan radius, default 12' } }, required: ['username'] } } },
  { type: 'function', function: { name: 'buildShelter', description: 'Build a quick 3x3 roof and corner pillars around the bot using available building blocks', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'equip', description: 'Equip an item in the main hand', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'armor', description: 'Auto-equip best armor', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'weapon', description: 'Auto-equip best melee weapon', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'shield', description: 'Equip shield to off-hand if available', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'eat', description: 'Eat a food item', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Optional food id' } } } } },
  { type: 'function', function: { name: 'wait', description: 'Wait for some milliseconds', parameters: { type: 'object', properties: { ms: { type: 'number' } } } } }
]

const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name))

module.exports = { TOOLS, TOOL_NAMES }
