const TOOLS = [
  { type: 'function', function: { name: 'chat', description: '在游戏公聊里发送消息', parameters: { type: 'object', properties: { message: { type: 'string', description: '要发送的内容' } }, required: ['message'] } } },
  { type: 'function', function: { name: 'look', description: '转向指定朝向', parameters: { type: 'object', properties: { yaw: { type: 'number' }, pitch: { type: 'number' } } } } },
  { type: 'function', function: { name: 'lookAt', description: '看向附近的实体或指定玩家', parameters: { type: 'object', properties: { username: { type: 'string' }, name: { type: 'string' } } } } },
  { type: 'function', function: { name: 'move', description: '按方向持续移动一段时间', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] }, ms: { type: 'number' } }, required: ['direction'] } } },
  { type: 'function', function: { name: 'stop', description: '停止移动和寻路', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'jump', description: '跳一下', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'attack', description: '自动装备最佳近战武器和盾牌，并攻击附近目标', parameters: { type: 'object', properties: { name: { type: 'string' }, username: { type: 'string' } } } } },
  { type: 'function', function: { name: 'use', description: '使用当前手持物品', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'goto', description: '寻路到坐标或跟随玩家', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, range: { type: 'number' }, username: { type: 'string' }, distance: { type: 'number' } } } } },
  { type: 'function', function: { name: 'dig', description: '挖掘指定坐标的方块', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] } } },
  { type: 'function', function: { name: 'place', description: '在目标方块相邻位置放置方块（face 默认上方）', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, face: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } } }, required: ['x', 'y', 'z'] } } },
  { type: 'function', function: { name: 'collect', description: '采集附近指定方块或拾取掉落物。可指定方块 ID，也可直接给坐标。', parameters: { type: 'object', properties: { name: { type: 'string', description: '方块 ID，例如 oak_log、coal_ore；不填则优先拾取掉落物' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, radius: { type: 'number', description: '搜索半径，默认 12' } } } } },
  { type: 'function', function: { name: 'equip', description: '装备背包中的指定物品到主手', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'armor', description: '自动装备背包里最好的护甲', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'weapon', description: '自动装备背包里最好的近战武器', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'shield', description: '装备盾牌到副手（如果支持）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'eat', description: '吃掉一种食物', parameters: { type: 'object', properties: { name: { type: 'string', description: '可选，具体食物 ID；不填则自动选' } } } } },
  { type: 'function', function: { name: 'wait', description: '等待一段时间', parameters: { type: 'object', properties: { ms: { type: 'number' } } } } }
]

const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name))

module.exports = { TOOLS, TOOL_NAMES }
