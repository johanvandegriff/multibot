#!/bin/bash
source .env.prod
if [[ -z "$KUBECONFIG" ]]; then
  echo '$KUBECONFIG not specified in .env.prod, please add it'
  exit 1
fi
export IMAGE_PULL_POLICY=Always
export KUBECONFIG
kubectl get nodes

#build and push docker images
git_commit_hash=$(git rev-parse --short HEAD) #e.g. 8f6d85b
git_tag=$(git tag --points-at HEAD | head -1)

if [[ ! -z "$git_tag" ]]; then
  docker_tag="$git_tag"
elif [[ ! -z "$git_commit_hash" ]]; then
  docker_tag="$git_commit_hash"
else
  echo 'no git tag or commit hash found'
  exit 1
fi

docker build -t "$DOCKER_USERNAME/multistream-bot-main:$docker_tag" -t "$DOCKER_USERNAME/multistream-bot-main:latest" main-container
docker build -t "$DOCKER_USERNAME/multistream-bot-tenant:$docker_tag" -t "$DOCKER_USERNAME/multistream-bot-tenant:latest" tenant-container

docker push "$DOCKER_USERNAME/multistream-bot-main:latest"
docker push "$DOCKER_USERNAME/multistream-bot-tenant:latest"

kubectl create secret generic app-secrets \
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

kubectl apply -f app-secrets.yaml
rm app-secrets.yaml

# https://cert-manager.io/docs/tutorials/acme/nginx-ingress/
# https://dev.to/chrisme/setting-up-nginx-ingress-w-automatically-generated-letsencrypt-certificates-on-kubernetes-4f1k
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.0-beta.0/deploy/static/provider/cloud/deploy.yaml
kubectl create namespace cert-manager
kubectl apply -f https://github.com/jetstack/cert-manager/releases/download/v1.16.1/cert-manager.yaml
cat prod-issuer.yaml | sed "s/{{EMAIL}}/$EMAIL_ADDRESS/g" | kubectl create -f -


# kubectl apply -f state-db.yaml
cat main-container.yaml | \
  sed "s,{{IMAGE}},$DOCKER_USERNAME/multistream-bot-main:latest,g" | \
  sed "s,{{IMAGE_PULL_POLICY}},$IMAGE_PULL_POLICY,g" | \
  sed "s,{{SERVICE_TYPE}},ClusterIP,g" | \
  kubectl apply -f -

#restart the pods to get the new container images
for deployment in $(kubectl get deployments -o custom-columns=NAME:.metadata.name --no-headers -l group=tenant-containers); do
  kubectl rollout restart deployment $deployment
done
kubectl rollout restart deployment main-container

DOMAIN_NAME=$(echo "$BASE_URL" | sed 's,https://,,g')
cat main-ingress.yaml | \
  sed "s,{{DOMAIN_NAME}},$DOMAIN_NAME,g" | \
  kubectl apply -f -

while kubectl get deployment | grep ' 0 '; do
  sleep 0.1
done
kubectl get deployment

kubectl logs --max-log-requests 20 --all-containers --ignore-errors --tail=-1 -f --prefix -l logging=my_group