#!/bin/bash
set -a # automatically export all variables
# source .env.local
source .env.prod
set +a

#docker compose start state-db
# kubectl -n multibot port-forward service/state-db 6379:6379 > /dev/null &
# export STATE_DB_URL=redis://localhost:6379
export STATE_DB_URL=rediss://jjbotbot-redis-do-user-4587946-0.f.db.ondigitalocean.com:25061

#node ../bucket-to-from-json.js
node tenant-container/json-to-redis.js
