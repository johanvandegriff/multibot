# JJBotBot
This is a twitch bot with multiple functions:
* aggregate chat - pull chat from twitch, youtube, owncast, and kick into a common chat page
* forward commands - listens for people typing commands on youtube and sends them over to twitch for your other bots to ingest, such as `!sr billy joel just the way u are`
* nicknames - chat members can set a nickname for the bot to greet them with
* chatbot - the bot will also reply when mentioned or replied to (NOTE: this feature is not implemented yet in v2)
* admin page - log in with twitch to access your admin settings, specify which commands to forward, set up multichat, and change nicknames manually

Version 2 is rewritten with a different architecture to allow separating each streamer into their own tenant instance for better scalability. Most of the features have been ported over with a few improvements. This document is mostly for future reference for myself, but it will be merged with the main README once v2 is deployed to prod.

## Running Locally
Clone the repo, and create the file `.env` in the `v2` directory (the one this README is in) with the following contents:
```
BASE_URL=http://localhost
STATE_DB_PASSWORD=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_SUPER_ADMIN_USERNAME=yourtwitchaccountlowercase
TWITCH_BOT_USERNAME=YourBotUsernameCaseSensitive
TWITCH_BOT_OAUTH_TOKEN=oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Replace all the secrets as described in the [main README](../README.md), ignoring the ones starting with `BUCKET_` since this version doesn't use a bucket.

Then run it in the terminal by changing into the v2 directory with `cd v2` and run `./run-compose.sh` to build and run the various containers in docker.

Navigate to `http://localhost:8000` in your browser to see the app. The main page is hosted by `main-container`, which also has a router that proxys the streamer pages to the individual instances of `tenant-container`. They share data such as login sessions through a redis `state-db` container. When deploying, it is important to note that the main container can have replicas, but each tenant container can only have 1 instance because of the nature of the live chat connections.

After you have run it once with `./run-compose.sh`, you can use `./run-node.sh` to run it with nodejs directly (redis which runs in docker, but that never needs to be rebuilt) which is faster for testing small changes.

Running the app with docker or node directly has some limitations - it is hardcoded to run only on certain twitch channels, and the sign up function will not work since it has no way of creating more instances while running this way. If you want to use different channels, replace `jjvanvan` and `minecraft1167890` in `run-node.sh` and/or `compose.yaml`.

### Running in Kubernetes
To run it in a way that signups work, we will need to run it on kubernetes (k8s). To test this locally, you will need to [install minikube](https://minikube.sigs.k8s.io/docs/start/), then run `./run-minikube.sh` to start the app in k8s.

You can still get to it at `http://localhost:8000` and it still has the `main-container` and `tenant-container`s, but this time the main container has access to the k8s API to create and delete tenant containers as needed. So now you can log in with twitch and click the sign up button, and it will spin up a new tenant container just for your channel.

Another difference is that the main container can have multiple replicas and k8s will automatically split traffic between them with a load balancer. The tenant containers cannot have replicas because of the nature of the live chat connections. (The bot would start seeing every message twice!) In v1, everything was in 1 big container, which meant that it could not have replicas because it handled the chats for all the users. Now at least user A and user B can be assigned to different servers since their tenant containers are separate, and the main container can have a copy (or multiple copies) running on every server. The bottleneck becomes when there's a lot of chat messages per second, but any individual server just has to be powerful enough to run 1 channel's tenant container.

I have yet to deploy it to a k8s cluster in the cloud, but the benefit of k8s is that it will work with any home server or cloud provider (I plan to use DigitalOcean) and will be able to autoscale as more people use it.
