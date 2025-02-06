#!/bin/bash
set -e # exit when any error happens
source .env.local
set -x # show commands running

export IMAGE_PULL_POLICY=IfNotPresent
export KUBECONFIG=
ns=multibot #namespace

if ! minikube status | grep 'host: Running' > /dev/null; then
  minikube start
fi
alias kubectl='minikube kubectl --'
kubectl create namespace $ns || :
kubectl -n $ns get nodes

eval $(minikube docker-env)
docker image rm --force "$DOCKER_USERNAME/multibot-main:latest" "$DOCKER_USERNAME/multibot-tenant:latest"
docker build -t "$DOCKER_USERNAME/multibot-main:latest" -f main-container/Dockerfile .
docker build -t "$DOCKER_USERNAME/multibot-tenant:latest" -f tenant-container/Dockerfile .

# kubectl -n $ns delete deployment state-db
# kubectl -n $ns delete service state-db
kubectl -n $ns delete deployment main-container || :
kubectl -n $ns delete service main-container-svc || :
for deployment in $(kubectl -n $ns get deployments -o custom-columns=NAME:.metadata.name --no-headers -l group=tenant-containers); do
  kubectl -n $ns delete deployment $deployment
  kubectl -n $ns delete service $deployment-svc
done

set +x # hide commands temporarily for secrets
kubectl -n $ns create secret generic app-secrets \
  --from-literal=BASE_URL=$BASE_URL \
  --from-literal=TWITCH_SUPER_ADMIN_USERNAME=$TWITCH_SUPER_ADMIN_USERNAME \
  --from-literal=TWITCH_CLIENT_ID=$TWITCH_CLIENT_ID \
  --from-literal=TWITCH_SECRET=$TWITCH_SECRET \
  --from-literal=SESSION_SECRET=$SESSION_SECRET \
  --from-literal=STATE_DB_URL=$STATE_DB_URL \
  --from-literal=STATE_DB_PASSWORD=$STATE_DB_PASSWORD \
  --from-literal=TWITCH_BOT_USERNAME=$TWITCH_BOT_USERNAME \
  --from-literal=TWITCH_BOT_OAUTH_TOKEN=$TWITCH_BOT_OAUTH_TOKEN \
  --from-literal=DOCKER_USERNAME=$DOCKER_USERNAME \
  --from-literal=IMAGE_PULL_POLICY=$IMAGE_PULL_POLICY \
  --dry-run=client -o yaml > app-secrets.yaml
set -x #show commands again

kubectl -n $ns apply -f app-secrets.yaml
rm app-secrets.yaml

kubectl -n $ns apply -f state-db.yaml
cat main-container.yaml | \
  sed "s,{{IMAGE}},$DOCKER_USERNAME/multibot-main:latest,g" | \
  sed "s,{{IMAGE_PULL_POLICY}},$IMAGE_PULL_POLICY,g" | \
  sed "s,{{SERVICE_TYPE}},LoadBalancer,g" | \
  kubectl -n $ns apply -f -

while kubectl -n $ns get deployment | grep ' 0 '; do
  sleep 0.1
done
sleep 1
kubectl -n $ns get deployment

USE_LOAD_BALANCER=true
# USE_LOAD_BALANCER=false

if [[ "$USE_LOAD_BALANCER" == true ]]; then
  minikube tunnel &
  ip_and_port=pending
  while echo $ip_and_port | grep pending > /dev/null; do
      ip_and_port=$(kubectl -n $ns get services main-container-svc | awk '{split($5,a,":"); print $4 ":" a[1]}' | tail -1)
      # ip=$(kubectl -n $ns get services main-container-svc | awk 'print $4' | tail -1)
      echo "$ip_and_port"
      sleep 1
  done

  echo "
  http://localhost:8000 {
      reverse_proxy $ip_and_port
  }
  " > Caddyfile
  caddy run --config Caddyfile --adapter caddyfile --watch &
else
  # kubectl -n $ns expose deployment main-container --type=NodePort --port=8000
  kubectl -n $ns port-forward service/main-container-svc 8000:8000 > /dev/null &
fi
kubectl -n $ns logs --max-log-requests 20 --all-containers --ignore-errors --tail=-1 -f --prefix -l logging=my_group
