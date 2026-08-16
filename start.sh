#!/bin/bash
cd /tmp/minecraft-bot
export DEBUG_AI=1
nohup node index.js > /tmp/mc-bot.log 2>&1 &
echo $!
