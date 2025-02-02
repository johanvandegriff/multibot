#!/bin/bash
set -a # automatically export all variables
source .env.local
set +a

docker compose start state-db
export STATE_DB_URL=redis://localhost:6379

cd tenant-container
go mod tidy
PORT=8081 TWITCH_CHANNEL=jjvanvan go run src/*.go &
PORT=8082 TWITCH_CHANNEL=minecraft1167890 go run src/*.go &
cd ..

cd main-container
go mod tidy
export PROXY_OVERRIDES='{"jjvanvan":"http://localhost:8081","minecraft1167890":"http://localhost:8082"}'
PORT=8000 DISABLE_K8S=true go run src/*.go &
cd ..

# idle waiting for Ctrl-C from user
read -r -d '' _ </dev/tty
