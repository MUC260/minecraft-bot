module.exports = {
  apps: [
    {
      name: 'minecraft-bot',
      script: 'index.js',
      autorestart: true,
      max_restarts: 5,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}
