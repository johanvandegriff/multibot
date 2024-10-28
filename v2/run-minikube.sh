#!/bin/bash
eval $(minikube docker-env)
docker image rm --force main-container tenant-container
docker build -t main-container main-container
docker build -t tenant-container tenant-container

# kubectl delete deployment state-db
# kubectl delete service state-db
kubectl delete deployment main-container
kubectl delete service main-container
for deployment in $(kubectl get deployments -o custom-columns=NAME:.metadata.name --no-headers -l group=tenant-containers); do
  kubectl delete deployment $deployment
  kubectl delete service $deployment
done

source .env
kubectl create secret generic app-secrets \
  --from-literal=BASE_URL=$BASE_URL \
  --from-literal=TWITCH_SUPER_ADMIN_USERNAME=$TWITCH_SUPER_ADMIN_USERNAME \
  --from-literal=TWITCH_CLIENT_ID=$TWITCH_CLIENT_ID \
  --from-literal=TWITCH_SECRET=$TWITCH_SECRET \
  --from-literal=SESSION_SECRET=$SESSION_SECRET \
  --from-literal=STATE_DB_PASSWORD=$STATE_DB_PASSWORD \
  --from-literal=TWITCH_BOT_USERNAME=$TWITCH_BOT_USERNAME \
  --from-literal=TWITCH_BOT_OAUTH_TOKEN=$TWITCH_BOT_OAUTH_TOKEN \
  --dry-run=client -o yaml > app-secrets.yaml

kubectl apply -f app-secrets.yaml
rm app-secrets.yaml

kubectl apply -f state-db.yaml
kubectl apply -f main-container.yaml
kubectl get deployment
while kubectl get deployment | grep ' 0 '; do
  sleep 0.1
done
kubectl get deployment

USE_LOAD_BALANCER=true
# USE_LOAD_BALANCER=false

if [[ "$USE_LOAD_BALANCER" == true ]]; then
  minikube tunnel &
  ip_and_port=pending
  while echo $ip_and_port | grep pending > /dev/null; do
      ip_and_port=$(kubectl get services main-container | awk '{split($5,a,":"); print $4 ":" a[1]}' | tail -1)
      # ip=$(kubectl get services main-container | awk 'print $4' | tail -1)
      echo "$ip_and_port"
      sleep 0.1
  done

  echo "
  http://localhost:8000 {
      reverse_proxy $ip_and_port
  }
  " > Caddyfile
  caddy run --config Caddyfile --adapter caddyfile --watch &
else
  # kubectl expose deployment main-container --type=NodePort --port=8000
  kubectl port-forward service/main-container 8000:8000 > /dev/null &
fi
kubectl logs --max-log-requests 20 --all-containers --ignore-errors --tail=-1 -f --prefix -l logging=my_group
# read a
