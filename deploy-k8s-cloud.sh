#!/bin/bash
set -e # exit when any error happens
source .env.prod
set -x # show commands running

if [[ -z "$KUBECONFIG" ]]; then
  echo '$KUBECONFIG not specified in .env.prod, please add it'
  exit 1
fi
export IMAGE_PULL_POLICY=Always
export KUBECONFIG
ns=multibot #namespace

kubectl create namespace $ns || :
kubectl -n $ns get nodes

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

docker build -t "$DOCKER_USERNAME/multibot-main:$docker_tag" -t "$DOCKER_USERNAME/multibot-main:latest" -f main-container/Dockerfile .
docker build -t "$DOCKER_USERNAME/multibot-tenant:$docker_tag" -t "$DOCKER_USERNAME/multibot-tenant:latest" -f tenant-container/Dockerfile .

docker push "$DOCKER_USERNAME/multibot-main:latest"
docker push "$DOCKER_USERNAME/multibot-tenant:latest"

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

kubectl -n $ns apply -f app-secrets.yaml
rm app-secrets.yaml

# https://cert-manager.io/docs/tutorials/acme/nginx-ingress/
# https://dev.to/chrisme/setting-up-nginx-ingress-w-automatically-generated-letsencrypt-certificates-on-kubernetes-4f1k
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.0-beta.0/deploy/static/provider/cloud/deploy.yaml
kubectl create namespace cert-manager || :
kubectl apply -f https://github.com/jetstack/cert-manager/releases/download/v1.16.1/cert-manager.yaml

# patch it to add resource limits:
for deployment in cert-manager cert-manager-cainjector cert-manager-webhook; do
  kubectl patch deployment $deployment -n cert-manager \
    --type='json' -p='[
      {
        "op": "add",
        "path": "/spec/template/spec/containers/0/resources",
        "value": {
          "requests": {
            "cpu": "25m",
            "memory": "16Mi"
          },
          "limits": {
            "cpu": "100m",
            "memory": "256Mi"
          }
        }
      }
    ]'
done

#resolve DO operational readiness check:
#Validating webhook with a TimeoutSeconds value smaller than 1 second or greater than 29 seconds will block upgrades.
kubectl patch mutatingwebhookconfiguration cert-manager-webhook \
  --type='json' -p='[
    {
      "op": "add",
      "path": "/webhooks/0/timeoutSeconds",
      "value": 10
    }
  ]'
kubectl patch validatingwebhookconfiguration cert-manager-webhook \
  --type='json' -p='[
    {
      "op": "add",
      "path": "/webhooks/0/timeoutSeconds",
      "value": 10
    }
  ]'

cat prod-issuer.yaml | sed "s/{{EMAIL}}/$EMAIL_ADDRESS/g" | kubectl create -f - || :

# kubectl -n $ns delete deployment main-container
# kubectl -n $ns delete service main-container-svc
# for deployment in $(kubectl -n $ns get deployments -o custom-columns=NAME:.metadata.name --no-headers -l group=tenant-containers); do
#   kubectl -n $ns delete deployment $deployment
#   kubectl -n $ns delete service $deployment-svc
# done

# kubectl -n $ns apply -f state-db.yaml
cat main-container.yaml | \
  sed "s,{{IMAGE}},$DOCKER_USERNAME/multibot-main:latest,g" | \
  sed "s,{{IMAGE_PULL_POLICY}},$IMAGE_PULL_POLICY,g" | \
  sed "s,{{SERVICE_TYPE}},ClusterIP,g" | \
  kubectl -n $ns apply -f -

#restart the pods to get the new container images
for deployment in $(kubectl -n $ns get deployments -o custom-columns=NAME:.metadata.name --no-headers -l group=tenant-containers); do
  kubectl -n $ns rollout restart deployment $deployment
done
kubectl -n $ns rollout restart deployment main-container

DOMAIN_NAME=$(echo "$BASE_URL" | sed 's,https://,,g')
cat main-ingress.yaml | \
  sed "s,{{DOMAIN_NAME}},$DOMAIN_NAME,g" | \
  kubectl apply -f -

while kubectl -n $ns get deployment | grep ' 0 '; do
  sleep 0.1
done
sleep 1
kubectl -n $ns get deployment

kubectl -n $ns logs --max-log-requests 50 --all-containers --ignore-errors --tail=100 -f --prefix -l logging=my_group
