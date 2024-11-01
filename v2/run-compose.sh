#!/bin/bash
set -a # automatically export all variables
source .env.local
set +a

docker image rm --force "$DOCKER_USERNAME/multistream-bot-main:latest" "$DOCKER_USERNAME/multistream-bot-tenant:latest"
docker build -t "$DOCKER_USERNAME/multistream-bot-main:latest" main-container
docker build -t "$DOCKER_USERNAME/multistream-bot-tenant:latest" tenant-container
docker network create botnet

docker compose up --remove-orphans $@
