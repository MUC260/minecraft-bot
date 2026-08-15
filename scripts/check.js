const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const files = [path.join(root, 'index.js'), path.join(root, 'ecosystem.config.js')]
for (const dir of ['lib', 'core', 'ai', 'api', 'scripts']) {
  const p = path.join(root, dir)
  if (!fs.existsSync(p)) continue
  for (const f of fs.readdirSync(p)) {
    if (f.endsWith('.js')) files.push(path.join(p, f))
  }
}

let failed = false
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  } catch {
    failed = true
  }
}
console.log(failed ? 'check: FAILED' : 'check: OK (' + files.length + ' files)')
process.exit(failed ? 1 : 0)
