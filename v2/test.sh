#!/bin/bash
#sudo apt install caddy redis
#sudo systemctl disable --now caddy
#sudo systemctl disable --now redis-server

set -a # automatically export all variables
source .env
set +a

# set -m
export BASE_URL=http://localhost:8000
docker compose start state-db
cd main-container
PORT=8080 node server.js &
cd ..
cd tenant-container
PORT=8081 TWITCH_CHANNEL=jjvanvan node server.js &
PORT=8082 TWITCH_CHANNEL=minecraft1167890 node server.js &
cd ..
caddy run --config router-container/test-Caddyfile --adapter caddyfile --watch #&

# idle waiting for Ctrl-C from user
# read -r -d '' _ </dev/tty
# fg
killall node -9
