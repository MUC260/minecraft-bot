#!/bin/bash
# MC Bot 看门狗 - 自动重启+监控
cd /home/yaner/minecraft-bot

start_bot() {
  echo "[$(date)] 启动机器人..."
  fuser -k 28080/tcp 2>/dev/null
  sleep 1
  nohup node index.js >> bot_output.log 2>&1 &
  BOT_PID=$!
  echo "[$(date)] 机器人 PID: $BOT_PID"
}

check_alive() {
  # 检查进程是否还活着
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "[$(date)] ⚠️ 进程已死，重启中..."
    return 1
  fi
  # 检查API是否响应
  RESP=$(curl -s --max-time 15 http://localhost:28080/api/status 2>/dev/null)
  if [ -z "$RESP" ]; then
    echo "[$(date)] ⚠️ API无响应，等待20秒..."
    sleep 20
    RESP2=$(curl -s --max-time 15 http://localhost:28080/api/status 2>/dev/null)
    if [ -z "$RESP2" ]; then
      echo "[$(date)] ⚠️ API持续无响应，重启中..."
      return 1
    fi
  fi
  return 0
}

start_bot

while true; do
  sleep 45
  if ! check_alive; then
    kill -9 $BOT_PID 2>/dev/null
    fuser -k 28080/tcp 2>/dev/null
    sleep 3
    start_bot
  fi
done
