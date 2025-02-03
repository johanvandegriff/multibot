#!/bin/bash
set -e # exit when any error happens
set -a # automatically export all variables
source .env.local
set +a

docker image rm --force "$DOCKER_USERNAME/multibot-main:latest" "$DOCKER_USERNAME/multibot-tenant:latest"
docker build -t "$DOCKER_USERNAME/multibot-main:latest" main-container
docker build -t "$DOCKER_USERNAME/multibot-tenant:latest" tenant-container
docker network create botnet || :

docker compose up --remove-orphans $@
