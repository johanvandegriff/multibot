#!/bin/bash
set -a # automatically export all variables
source .env.local
set +a

docker compose start state-db
export STATE_DB_URL=redis://localhost:6379

cd tenant-container
test ! -d node_modules && npm i
PORT=8081 TWITCH_CHANNEL=jjvanvan node server.js &
PORT=8082 TWITCH_CHANNEL=minecraft1167890 node server.js &
cd ..

cd main-container
test ! -d node_modules && npm i
PORT=8000 PROXY_OVERRIDES='{"jjvanvan":"http://localhost:8081","minecraft1167890":"http://localhost:8082"}' node server.js &
cd ..

# when Ctrl-C is pressed, kill node and exit
trap 'killall node -9; exit' INT

# idle waiting for Ctrl-C from user
read -r -d '' _ </dev/tty
