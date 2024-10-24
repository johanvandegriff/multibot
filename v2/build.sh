#!/bin/bash
docker image rm --force main-container tenant-container
docker build -t main-container main-container
docker build -t tenant-container tenant-container
docker network create botnet
docker compose up --remove-orphans $@
