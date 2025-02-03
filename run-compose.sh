#!/bin/bash
set -e # exit when any error happens
set -a # automatically export all variables
source .env.local
set +a
set -x # show commands running

docker image rm --force "$DOCKER_USERNAME/multibot-main:latest" "$DOCKER_USERNAME/multibot-tenant:latest"
docker build -t "$DOCKER_USERNAME/multibot-main:latest" -f main-container/Dockerfile .
docker build -t "$DOCKER_USERNAME/multibot-tenant:latest" -f tenant-container/Dockerfile .
docker network create botnet || :

docker compose up --remove-orphans $@
