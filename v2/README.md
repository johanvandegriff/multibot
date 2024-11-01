# JJBotBot
This is a twitch bot with multiple functions:
* aggregate chat - pull chat from twitch, youtube, owncast, and kick into a common chat page
* forward commands - listens for people typing commands on youtube and sends them over to twitch for your other bots to ingest, such as `!sr billy joel just the way u are`
* nicknames - chat members can set a nickname for the bot to greet them with
* chatbot - the bot will also reply when mentioned or replied to (NOTE: this feature is not implemented yet in v2)
* admin page - log in with twitch to access your admin settings, specify which commands to forward, set up multichat, and change nicknames manually

Version 2 is rewritten with a different architecture to allow separating each streamer into their own tenant instance for better scalability. Most of the features have been ported over with a few improvements. This document is mostly for future reference for myself, but it will be merged with the main README once v2 is deployed to prod.

## Running Locally in Docker
Clone the repo, and create the file `.env.local` in the `v2` directory (the one this README is in) with the following contents:
```
BASE_URL=http://localhost:8000
STATE_DB_URL=redis://state-db:6379
STATE_DB_PASSWORD=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_SUPER_ADMIN_USERNAME=yourtwitchaccountlowercase
TWITCH_BOT_USERNAME=YourBotUsernameCaseSensitive
TWITCH_BOT_OAUTH_TOKEN=oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DOCKER_USERNAME=YourDockerHubUsername
```

Replace all the secrets as described in the [main README](../README.md), ignoring the ones starting with `BUCKET_` since this version doesn't use a bucket. For `STATE_DB_PASSWORD` just put a long random string of letters and numbers.

Then run it in the terminal by changing into the v2 directory with `cd v2` and run `./run-compose.sh` to build and run the various containers in docker.

Navigate to `http://localhost:8000` in your browser to see the app. The main page is hosted by `main-container`, which also has a router that proxys the streamer pages to the individual instances of `tenant-container`. They share data such as login sessions through a redis `state-db` container. When deploying, it is important to note that the main container can have replicas, but each tenant container can only have 1 instance because of the nature of the live chat connections.

After you have run it once with `./run-compose.sh`, you can use `./run-node.sh` to run it with nodejs directly (redis which runs in docker, but that never needs to be rebuilt) which is faster for testing small changes.

Running the app with docker or node directly has some limitations - it is hardcoded to run only on certain twitch channels, and the sign up function will not work since it has no way of creating more instances while running this way. If you want to use different channels, replace `jjvanvan` and `minecraft1167890` in `run-node.sh` and/or `compose.yaml`, or follow the next section to run it locally in kubernetes.

## Running Locally in Kubernetes
To run it in a way that signups work, we will need to run it on kubernetes (k8s). To test this locally, you will need to [install minikube](https://minikube.sigs.k8s.io/docs/start/), then run `./run-minikube.sh` to start the app in k8s.

You can still get to it at `http://localhost:8000` and it still has the `main-container` and `tenant-container`s, but this time the main container has access to the k8s API to create and delete tenant containers as needed. So now you can log in with twitch and click the sign up button, and it will spin up a new tenant container just for your channel.

Another difference is that the main container can have multiple replicas and k8s will automatically split traffic between them with a load balancer. The tenant containers cannot have replicas because of the nature of the live chat connections. (The bot would start seeing every message twice!) In v1, everything was in one big container, which meant that it could not have replicas because it handled the chats for all the users. Now at least user A and user B can be assigned to different servers since their tenant containers are separate, and the main container can have a copy (or multiple copies) running on every server. The bottleneck becomes when there's a lot of chat messages per second, but any individual server just has to be powerful enough to process one channel's chat.

Although running in k8s is more complex, the benefit is that it will work with any cloud provider (I use DigitalOcean) and will be able to autoscale as more people use it. (You can also run it on a home server, but that obviously cannot autoscale since you would have to run to the store and buy more computers to scale up whenever there was a lot of people using it.)

## Running in the Cloud in Kubernetes
Create a file `.env.prod`, which we can fill in most of it now:
```
BASE_URL=https://your.subdomain.or.domain.com
EMAIL_ADDRESS=your-email@example.com
STATE_DB_URL=leave blank for now
STATE_DB_PASSWORD=leave blank for now
SESSION_SECRET=another random string
TWITCH_SUPER_ADMIN_USERNAME=same as .env.local
TWITCH_BOT_USERNAME=same as .env.local
TWITCH_BOT_OAUTH_TOKEN=same as .env.local
TWITCH_CLIENT_ID=same as .env.local
TWITCH_SECRET=same as .env.local
DOCKER_USERNAME=same as .env.local
KUBECONFIG=/home/user/Downloads/jjbotbot-k8s-cluster-kubeconfig.yaml
```

Install kubectl. On Ubuntu, this is `sudo snap install kubectl --classic`
Create a digitalocean kubernetes (k8s) cluster, I put it in the NYC3 region and called it `jjbotbot-k8s-node-pool` for the node pool name and `jjbotbot-k8s-cluster` for the cluster name. I selected the cheapest plan for now, but with autoscaling enabled so that it can handle more users if needed. Go through the getting started steps:
* Connecting to Kubernetes - Choose manual, then click `download the cluster configuration file`, then run `kubectl --kubeconfig=~/Downloads/jjbotbot-k8s-cluster-kubeconfig.yaml get nodes` to make sure it can connect.

Make sure your `.env.prod` file's `KUBECONFIG` variable has the correct path to the downloaded config file.

Create a digitalocean redis cluster in the same region, I called it `jjbotbot-redis` and go through the getting started steps:
* Restrict inbound connections to only the k8s cluster and node pool
* Set the eviction policy to `noeviction` to make it not throw away data when the memory limit is reached. We are using redis as more of a key value store instead of a cache, so we don't want to lose data
* Copy the connection details for VPC network to give to k8s later

Add the info from your connection details to `.env.prod`. For example if your connection details look like this:
```
username = default
password = xxxxxxxxxxxx
host = jjbotbot-redis-do-user-0000000-0.f.db.ondigitalocean.com
port = 25061
```
Then the relevant entries in `.env.prod` should look like this (note that the port becomes part of the connection string, and you add `rediss://` at the beginning):
```
STATE_DB_URL=rediss://private-jjbotbot-redis-do-user-0000000-0.f.db.ondigitalocean.com:25061
STATE_DB_PASSWORD=xxxxxxxxxxxx
```

Run `./deploy-k8s-cloud.sh` which will build and push the docker images, deploy the app, add a load balancer, and configure HTTPS certs for your domain (once the DNS is added in the next step).

Go to the load balancers in your cloud provider's UI and find the IP address, or use `kubectl --kubeconfig=$HOME/Downloads/jjbotbot-k8s-cluster-kubeconfig.yaml get -n ingress-nginx service` and find the EXTERNAL-IP of the LoadBalancer entry. Then go to your domain name and add an A record with that IP address to a domain or subdomain that you own, which should match `BASE_URL` in `.env.prod` (I used `v2.botbot.jjv.sh`).

It may take a few minutes for the cert to be issued, you can check the progress with `kubectl --kubeconfig=$HOME/Downloads/jjbotbot-k8s-cluster-kubeconfig.yaml describe certificate letsencrypt-prod`. After it is done you should be able to go to your domain/subdomain (`v2.botbot.jjv.sh` for me) and see the app running!
