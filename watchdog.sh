#!/bin/bash
# MC Bot 看门狗 - 进程/API 连续失败后自动重启
# 状态记录：watchdog-state.log（区分 API 慢 / 进程崩溃 / 服务器断连）
set -u
cd /home/yaner/minecraft-bot

BOT_PID=""
FAILURES=0
MAX_FAILURES=3
RESTART_COOLDOWN=60
STATE_LOG="watchdog-state.log"

state() {
  # 记录结构化状态：时间 | 类型 | 详情
  echo "$(date -Iseconds) | $1 | $2" >> "$STATE_LOG"
  echo "[$(date)] $2"
}

start_bot() {
  state "start" "启动机器人"
  fuser -k 28080/tcp 2>/dev/null || true
  sleep 1
  nohup node index.js >> bot_output.log 2>&1 &
  BOT_PID=$!
  FAILURES=0
  state "start" "机器人 PID: $BOT_PID"
}

check_alive() {
  if ! kill -0 "$BOT_PID" 2>/dev/null; then
    state "proc_dead" "进程已退出（PID=$BOT_PID）"
    return 1
  fi

  local status
  status=$(curl -fsS --connect-timeout 2 --max-time 8 http://127.0.0.1:28080/api/status 2>/dev/null || true)
  if [ -z "$status" ]; then
    state "api_slow" "API 暂时无响应（进程仍存活，可能是 AI 请求阻塞）"
    return 1
  fi

  # API 能返回 JSON 即视为进程健康；游戏断线由 agent 自己的重连逻辑处理。
  if ! printf '%s' "$status" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try { const x=JSON.parse(s); process.exit(x && typeof x.connected === 'boolean' ? 0 : 1) } catch { process.exit(1) }})"; then
    state "api_invalid" "API 返回内容无效"
    return 1
  fi

  # 记录游戏连接状态（不触发重启，只做观测）
  local conn
  conn=$(printf '%s' "$status" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const x=JSON.parse(s);console.log(x.connected?'connected':'disconnected')}catch{console.log('unknown')}})")
  if [ "$conn" = "disconnected" ]; then
    state "mc_disconnect" "游戏连接断开（agent 会自动重连，看门狗不干预）"
  fi
  return 0
}

start_bot
while true; do
  sleep 45
  if check_alive; then
    FAILURES=0
    continue
  fi

  FAILURES=$((FAILURES + 1))
  state "check_fail" "健康检查失败 ${FAILURES}/${MAX_FAILURES}"
  if [ "$FAILURES" -lt "$MAX_FAILURES" ]; then
    continue
  fi

  state "restart" "连续失败，重启机器人"
  kill -TERM "$BOT_PID" 2>/dev/null || true
  sleep 5
  kill -KILL "$BOT_PID" 2>/dev/null || true
  fuser -k 28080/tcp 2>/dev/null || true
  sleep "$RESTART_COOLDOWN"
  start_bot
done
