#!/bin/bash
set -a # automatically export all variables
source .env
set +a

export BASE_URL=http://localhost:8000
docker compose start state-db
cd tenant-container
PORT=8081 TWITCH_CHANNEL=jjvanvan node server.js &
PORT=8082 TWITCH_CHANNEL=minecraft1167890 node server.js &
cd ..

cd main-container
PORT=8000 PROXY_OVERRIDES='{"jjvanvan":"http://localhost:8081","minecraft1167890":"http://localhost:8082"}' node server.js &
cd ..

# when Ctrl-C is pressed, kill node and exit
trap 'killall node -9; exit' INT

# idle waiting for Ctrl-C from user
read -r -d '' _ </dev/tty
