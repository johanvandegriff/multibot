# multibot
[botbot.jjv.sh](https://botbot.jjv.sh)

This is a livestream bot with multiple functions:
* aggregate chat - pull chat from twitch, youtube, owncast, and kick into a common chat page
* forward commands - listens for people typing commands on youtube and sends them over to twitch for your other bots to ingest, such as `!sr billy joel just the way u are`
* nicknames - chat members can set a nickname for the bot to greet them with
* admin page - log in with twitch to access your admin settings, specify which commands to forward, set up multichat, and change nicknames manually
* coming soon: chatbot - the bot will also reply when mentioned or replied to
* coming soon: livestream splitting - point OBS to this and have it forward the stream to twitch, youtube, owncast, etc. For now, you can use [this](https://codeberg.org/johanvandegriff/multistream) if you know how to use docker.
* coming soon: OBS hosting - run OBS in the cloud, good if you have a bad connection, such as IRL streams

## Add to Your Channel
Go to https://botbot.jjv.sh and click on "log in" at the top right. It will say `JJBotBot wants to access your account` (note that it only asks for permission to view your email and nothing else, so there is no way for it to change anything on your twitch account), click Authorize. Once you log in, click `sign up`, and after a few seconds it will redirect to your channel page.

You are done! Chat members will now be able to type `!nick mynickname` to pick a nickname, and `!botpage` to pull up the webpage with all the nicknames. The bot will greet users who enter the chat by their nicknames.

If you (the streamer) ever want to log in and edit/add a nickname manually, just type `!botpage` in chat and follow the link, then log in again and you can edit everything, and even disable the bot.

### (Optional) Multichat
You can choose to set up youtube chat and/or owncast chat to be combined into the multichat. First, type `!botpage` in your chat to get back to the bot page if you aren't already, and click `log in` at the top right to get to the admin page.

For youtube, enter your youtube channel where it says `enter youtube channel URL or ID` and click `find channel`. The next time you go live, it will automatically connect and youtube chat will also show up in the multichat. For owncast, put your owncast public server URL where it says `enter owncast URL` and click `connect`. It will also forward owncast chat to the multichat when you go live. For kick, enter your kick username where it tells you to and click `connect`.

To add the multichat to OBS, type `!multichat` in your twitch chat and the bot will reply with a link you can add to an OBS browser source. If you want to change the settings, then go to the bot page and change the `show usernames` and `show nicknames` checkboxes as desired, then copy the `pop-out` chat link near the top right of the page and add that to your OBS browser source instead.

### (Optional) Mod the Bot
Sometimes when there are a lot of users running commands, the bot sends messages too quickly and twitch doesn't display all of them. You can fix this by making the bot a moderator by typing `/mod JJBotBot` in chat. This is optional, but will avoid missing any messages.

# Technical Info for Nerds
Everything past this point is completely optional and geared towards programmers, going into detail on how to run a copy of the bot locally, deploy it to kubernetes in the cloud, and modify the code to do whatever you want.

This code is open source (AGPL-3.0 license), so you don't have to use my server at https://botbot.jjv.sh and instead you can choose to deploy the code to your own server. (Side note: the license also allows you to make  any changes you want to the code, provided you release your source code under the same license as well.)

Version 2 is rewritten with a different architecture to allow separating each streamer into their own tenant instance for better scalability. This also makes it easier to add new high power features in the future such as livestream splitting, by creating an extra container for an individual tenant that just does the RTMP multicasting.

Version 3 is rewritten from nodejs to golang, to be more efficient, especially using way less memory. It also has components broken out into packages, with some packages even being used in both containers. When the docker images are built, these common packages are included in both. Also, the docker images used to be ~200MB, now they are ~50MB thanks to the ability for docker to build in one container and copy artifacts to a completely empty container (`FROM scratch`). In fact, the golang binary is statically linked so it doesn't need anything else, so it accounts for all 50MB.

## Running Locally in Docker
You will need:
* **a twitch account for the bot**: The bot works by logging into a normal twitch account, which just happens to have the username `JJBotBot` for my setup, and reading and posting messages in the chat. So I recommend creating a new account for the bot, but you can use your own twitch account if you want it to post messages as your username.
* **a linux environment**: (might work on windows/mac but havent tested, if you do get it working let me know)
* **git**: `sudo apt install git` or download from https://git-scm.com/
* **golang**: `sudo apt install golang-go` or download from https://go.dev/
* **docker**: `sudo apt install docker-ce` or download from https://www.docker.com/get-started/

### Generate Twitch Credentials
Log in with **the bot's twitch account** (might be convenient to use a different browser or incognito to avoid logging out your main twitch account), then visit this page to generate an oauth token: https://twitchapps.com/tmi/

Also visit this page to generate app credentials: https://dev.twitch.tv/console/apps

For the callback URL, put `http://localhost:8000/api/auth/twitch/callback`

Keep those pages open, in the next section we will create a file to paste the credentials into.

### Add Credentials to the Bot
Clone the bot repo and create a file called `.env.local`:
```bash
git clone https://codeberg.org/johanvandegriff/multibot.git
cd mutibot
nano .env.local
```
Note: in nano, you can do Ctrl-S to save (or Ctrl-O, then enter), and Ctrl-X to exit.

And add the following (we will change the values shortly):
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

Note: make sure you DO NOT share the secrets with anyone, or they will be able to log in as the bot and do whatever they want as if they owned that twitch account. If you think the secrets have been leaked, go back to the 3 different pages where you generated them in the previous step, and regenerate new credentials.

For `TWITCH_SUPER_ADMIN_USERNAME`, put your twitch account, in all lowercase. Multiple people can log in with twitch once it's deployed, but only this account will have the highest level of admin when you log in. You could also put the bot's twitch account for this, but it could be less convenient since you probably won't stay logged in as the bot long term.

For `TWITCH_BOT_USERNAME`, put the username of the bot twitch account you made, and if you chose to use your own account, put that. This is CASE SENSITIVE!

For `TWITCH_BOT_OAUTH_TOKEN`, put the token you generated from https://twitchapps.com/tmi/ and make sure that you generated it while logged into the same account as `TWITCH_BOT_USERNAME`.

For `TWITCH_CLIENT_ID` and `TWITCH_SECRET`, enter the Client ID and Client Secret you generated from https://dev.twitch.tv/console/apps and again make sure you were logged in with `TWITCH_BOT_USERNAME`.

For `SESSION_SECRET`, this just needs to be random, nothing specific, so type a long string of numbers and letters on your keyboard.

For `STATE_DB_PASSWORD`, this also needs to be random, so type a different random string.


Make sure to save with Ctrl-S and exit nano with Ctrl-X.

### Run the Docker Container
Then do `./run-compose.sh` to build and run the various containers in docker.

Navigate to `http://localhost:8000` in your browser to see the app. The main page is hosted by `main-container`, which also has a router that proxys the streamer pages to the individual instances of `tenant-container`. They share data such as login sessions through a redis `state-db` container. When deploying, it is important to note that the main container can have replicas, but each tenant container can only have 1 instance because of the nature of the live chat connections.

After you have run it once with `./run-compose.sh`, you can use `./run-go.sh` to run it with golang directly (redis still runs in docker, but that never needs to be rebuilt) which is faster for testing small changes.

Running the app with docker or go directly has some limitations - it is hardcoded to run only on certain twitch channels, and the sign up function will not work since it has no way of creating more instances while running this way. If you want to use different channels, replace `jjvanvan` and `minecraft1167890` in `run-go.sh` and/or `compose.yaml`, or follow the next section to run it locally in kubernetes.

Note: I do publish builds of the docker containers, but the project is structured in a way that it is easier to just build them yourself since you already cloned the repo and the scripts are all set up that way.

## Running Locally in Kubernetes
To run it in a way that signups work, we will need to run it on kubernetes (k8s). To test this locally, you will need to [install minikube](https://minikube.sigs.k8s.io/docs/start/), then run `./run-minikube.sh` to start the app in k8s.

You can still get to it at `http://localhost:8000` and it still has the `main-container` and `tenant-container`s, but this time the main container has access to the k8s API to create and delete tenant containers as needed. So now you can log in with twitch and click the sign up button, and it will spin up a new tenant container just for your channel.

Another difference is that the main container can have multiple replicas and k8s will automatically split traffic between them with a load balancer. The tenant containers cannot have replicas because of the nature of the live chat connections. (The bot would start seeing every message twice!) In v1, everything was in one big container, which meant that it could not have replicas because it handled the chats for all the users. Now at least user A and user B can be assigned to different servers since their tenant containers are separate, and the main container can have a copy (or multiple copies) running on every server. The bottleneck becomes when there's a lot of chat messages per second, but any individual server just has to be powerful enough to process one channel's chat.

Although running in k8s is more complex, the benefit is that it will work with any cloud provider and will be able to autoscale as more people use it. (You can also run it on a home server, but that obviously cannot autoscale since you would have to run to the store and buy more computers to scale up whenever there was a lot of people using it.)

## Running in the Cloud in Kubernetes
You will need:
* **a docker hub account**: Create an account on https://hub.docker.com/ and then run `docker login` locally.
* **a domain name**: I used namesilo to buy one but any domain name service will work fine.
* **a cloud provider that supports kubernetes**: I use [DigitalOcean](https://m.do.co/c/f300a2838d1d) but you can use any cloud provider, or even host it at your house/apartment and port forward thru your router, but setting up kubernetes manually is out of the scope of this guide.

Make sure to add your cloud provider's nameservers, for example I logged into namesilo and added the NS records: `ns1.digitalocean.com`, `ns2.digitalocean.com`, and `ns3.digitalocean.com`.

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

For `EMAIL_ADDRESS`, put your email address. This will be used to send emails about SSL certificates renewing.

For `BASE_URL`, put your domain or subdomain, including the `https://`, and make sure there is NO slash at the end.

Go back to the twitch app page: https://dev.twitch.tv/console/apps

And add `https://your.domain.com/api/auth/twitch/callback` as a URL, making sure to use the your domain or subdomain.

Install kubectl. On Ubuntu, this is `sudo snap install kubectl --classic`
Create a digitalocean kubernetes (k8s) cluster, I put it in the NYC3 region and called it `jjbotbot-k8s-node-pool` for the node pool name and `jjbotbot-k8s-cluster` for the cluster name. I selected the cheapest plan for now, but with autoscaling enabled so that it can handle more users if needed. Go through the getting started steps:
* Connecting to Kubernetes - Choose manual, then click `download the cluster configuration file`, then run `kubectl --kubeconfig=~/Downloads/jjbotbot-k8s-cluster-kubeconfig.yaml get nodes` to make sure it can connect.

Replace `KUBECONFIG` in `.env.prod` with the path to the config file you downloaded.

For autoscaling, we need the metrics server, go [here](https://marketplace.digitalocean.com/apps/kubernetes-metrics-server) and click "Install App" (as instructed on the [autoscaling](https://docs.digitalocean.com/products/kubernetes/how-to/set-up-autoscaling/) guide).

Create a digitalocean (or whatever cloud provider you use) redis cluster in the same region, I called it `jjbotbot-redis` and go through the getting started steps:
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

Go to the load balancers in your cloud provider's UI and find the IP address, or use `kubectl --kubeconfig=$HOME/Downloads/jjbotbot-k8s-cluster-kubeconfig.yaml get -n ingress-nginx service` and find the EXTERNAL-IP of the LoadBalancer entry. Then go to your domain name and add an "A" record with that IP address to a domain or subdomain that you own, which should match `BASE_URL` in `.env.prod` (I used `botbot.jjv.sh`).

It may take a few minutes for the cert to be issued, you can check the progress with `kubectl --kubeconfig=$HOME/Downloads/jjbotbot-k8s-cluster-kubeconfig.yaml describe certificate letsencrypt-prod`. After it is done you should be able to go to your domain/subdomain (`botbot.jjv.sh` for me) and see the app running!
