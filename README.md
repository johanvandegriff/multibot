# multistream-bot
This is a twitch bot with multiple functions:
* aggregate chat - pull chat from twitch, youtube, and owncast into a common chat page
* forward commands - listens for people typing commands on youtube and sends them over to twitch for your other bots to ingest, such as `!sr billy joel just the way u are`
* nicknames - chat members can set a nickname for the bot to greet them with
* chatbot - the bot will also reply when mentioned or replied to
* admin page - log in with twitch to access your admin settings, specify which commands to forward, set up multichat, and change nicknames manually

## Add to Your Channel
Go to https://botbot.jjv.sh and click on "log in" at the top right. It will say `JJBotBot wants to access your account` (note that it only asks for permission to view your email and nothing else, so there is no way for it to change anything on your twitch account), click Authorize. After you log in it will say `The bot is NOT enabled on your channel`, so click ENABLE to start using it.

You are done! Chat members will now be able to type `!setnickname mynickname` to pick a nickname, `!nickname` to check their nickname, `!nickname username` to check another user's nickname, and `!botpage` to pull up the webpage with all the nicknames.

If you (the streamer) ever want to log in and edit/add a nickname manually, just type `!botpage` in chat and follow the link, then log in again and you can edit everything, and even disable the bot.

### (Optional) Multichat
You can choose to set up youtube chat and/or owncast chat to be combined into the multichat. First, type `!botpage` in your chat to get back to the bot page if you aren't already, and click `log in` at the top right to get to the admin page.

For youtube, enter your youtube channel where it says `enter youtube channel URL or ID` and click `find channel`. The next time you go live, it will automatically connect and youtube chat will also show up in the multichat. For owncast, put your owncast public server URL where it says `enter owncast URL` and click `connect`. It will also forward owncast chat to the multichat when you go live.

To add the multichat to OBS, type `!multichat` in your twitch chat and the bot will reply with a link you can add to an OBS browser source. If you want to change the settings, then go to the bot page and change the `show usernames` and `show nicknames` checkboxes as desired, then copy the `pop-out` chat link near the top right of the page and add that to your OBS browser source instead.

### (Optional) Mod the Bot
Sometimes when there are a lot of users running commands, the bot sends messages too quickly and twitch doesn't display all of them. You can fix this my making the bot a mod by typing `/mod JJBotBot` in chat. This is optional, but will avoid missing any messages.

# Technical Info for Nerds
Everything past this point is completely optional and geared towards programmers, going into detail on how to create a copy of the entire bot and set it up on your own site, run it locally, and even modify the code to do whatever you want with it.

## Deploying
This code is open source (AGPL-3.0 license), so you don't have to use my server at https://botbot.jjv.sh and instead you can choose to deploy the code to your own server. (Side note: the license also allows you to make any changes you want to the code, provided you release your source code under the same license as well.)

You will need:
* __a domain name__: I use namesilo but any domain name service will work fine.
* __a server with a public IP address and docker installed__: I use [DigitalOcean](https://m.do.co/c/f300a2838d1d) but you can use any cloud provider, or even host it at your house/apartment and port forward thru your router. Make sure to log into your domain name service and point the domain or subdomain at the public IP address of the server with a DNS "A" record.
* __an S3 compatible storage bucket__: I use DigitalOcean's [spaces](https://www.digitalocean.com/products/spaces) but you can use any S3 compatible product.
* __a twitch account for the bot__: I recommend creating a new account for the bot, but you can use your own twitch account if you want.

Make sure you have all these before continuing.

### Generate Credentials
Log in with the bot's twitch account, then visit this page to generate an oauth token: https://twitchapps.com/tmi/

Also visit this page to generate app credentials: https://dev.twitch.tv/console/apps

The callback URL will depend on your domain name, for example `https://your-domain-name.com/auth/twitch/callback`

Go to https://cloud.digitalocean.com/account/api/spaces or the equivalent for whatever S3 provider you chose and click `Generate New Key`, put whatever name you want, for example `my stream bot key`. You will need both the access key and the secret key.

On your server, make a directory for the files to be kept:
```bash
mkdir ~/multistream-bot
```

Then create a config file in that directory:
```bash
nano ~/multistream-bot/secret.env
```
Note: in nano, you can do Ctrl-S to save (or Ctrl-O, then enter), and Ctrl-X to exit.

And add the following (we will change the values shortly):
```
TWITCH_SUPER_ADMIN_USERNAME=yourtwitchaccountlowercase
TWITCH_BOT_USERNAME=YourBotUsernameCaseSensitive
TWITCH_BOT_OAUTH_TOKEN=oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BASE_URL=https://your-domain-name.com
BUCKET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxx
BUCKET_SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BUCKET_ENDPOINT=https://nyc3.digitaloceanspaces.com
BUCKET_NAME=yourbucket
BUCKET_FOLDER=prod
```

Note: make sure you DO NOT share the secrets with anyone, or they will be able to log in as the bot and do whatever they want as if they owned that twitch account. If you think the secrets have been leaked, go back to the 3 different pages where you generated them in the previous step, and regenerate new credentials.

For `TWITCH_SUPER_ADMIN_USERNAME`, put your twitch account, in all lowercase. Multiple people can log in with twitch once it's deployed, but only this account will have the highest level of admin when you log in. You could also put the bot's twitch account for this, but it could be less convenient since you probably won't stay logged in as the bot long term.

For `TWITCH_BOT_USERNAME`, put the username of the bot twitch account you made, and if you chose to use your own account, put that. This is CASE SENSITIVE!

For `TWITCH_BOT_OAUTH_TOKEN`, put the token you generated from https://twitchapps.com/tmi/ and make sure that you generated it while logged into the same account as `TWITCH_BOT_USERNAME`.

For `TWITCH_CLIENT_ID` and `TWITCH_SECRET`, enter the Client ID and Client Secret you generated from https://dev.twitch.tv/console/apps and again make sure you were logged in with `TWITCH_BOT_USERNAME`.

For `SESSION_SECRET`, this just needs to be random, nothing specific, so type a long string of numbers and letters on your keyboard.

Again, `BASE_URL` will depend on your domain name, for example `https://your-domain-name.com` and make sure there is NO slash at the end.

For `BUCKET_ACCESS_KEY`, put the access key you got from digitalocean.

For `BUCKET_SECRET_KEY`, put the secret key you got from digitalocean.

For `BUCKET_ENDPOINT`, put `https://nyc3.digitaloceanspaces.com` if you used digitalocean with the default region, otherwise adjust it to your region/provider.

For `BUCKET_NAME`, put the name you used when you created the bucket (not the bucket access key).

For `BUCKET_FOLDER`, put `prod`, but this can really be whatever, it's just the folder inside the bucket you want the app to put all its data in.

Make sure to save with Ctrl-S and exit nano with Ctrl-X.

At this point, you should have a directory called `multistream-bot` with a file `secret.env` inside it. Run these commands to double check:

```bash
ls ~/multistream-bot
cat ~/multistream-bot/secret.env
```

### Run the Docker Container
Create a docker virtual network. This will be useful for later when we make a SSL proxy. You can call it whatever you want, or just keep it as `mynetwork`, it doesn't matter. Just make sure to use the same name in all your future docker commands.
```bash
docker network create mynetwork
```

Now we need to pull the latest image and run it, which we can do in one command. First check for the latest tag on https://hub.docker.com/r/johanvandegriff/multistream-bot/tags

Let's say the latest was `build13`, then the command would be:

```bash
docker run --name multistream-bot -d --restart unless-stopped --net mynetwork -v ~/multistream-bot:/srv johanvandegriff/multistream-bot:build13
```

Check that the container started up fine with:
```bash
docker logs multistream-bot
```

Also, it will create a JSON file to hold all the settings, nicknames, and other info, you can check that file with:

```bash
cat ~/multistream-bot/data.json
```

### Set up an SSL Proxy for HTTPS
We will be using [Caddy](https://caddyserver.com/) as the proxy, however you can use whatever proxy you want if you know what you're doing.

Create a directory for Caddy to store the files it will generate:
```bash
mkdir ~/caddy-data
```

Then create a Caddyfile:
```bash
nano ~/Caddyfile
```

And add the following (we will change the values shortly):
```
{
        email youremail@yourdomain.com
}

your-domain-name.com {
        encode gzip
        reverse_proxy multistream-bot:8080
}
```

Replace `youremail@yourdomain.com` with your actual email, this will be used for registering the SSL certificates with letsencrypt.

Replace `your-domain-name.com` with your actual domain. Note that this can even be a subdomain, but make sure it is the same as the `BASE_URL` from earlier, except without the `https://` at the beginning.

Now run Caddy with:
```bash
docker run --name caddy -d --restart unless-stopped --net mynetwork -p 80:80 -p 443:443 -v ~/Caddyfile:/etc/caddy/Caddyfile -v ~/caddy-data:/data caddy
```

The nice thing is that if you want to run any other services, you can just run the docker container (making sure to use `--net mynetwork`), add a section to the Caddyfile to link the docker container to a domain or subdomain, `docker restart caddy`, and Caddy will handle the rest and your app will magically show up on that (sub)domain with HTTPS and everything.


## Running Locally
If you want to make changes to the code and test them, you might want a way to run it locally.

You will need:
* __git__: `sudo apt install git` or download from https://git-scm.com/
* __nodejs__: `sudo apt install nodejs` or download from https://nodejs.org/
* __a linux environment__: (might work on windows/mac but havent tested, if you do get it working let me know)

```bash
sudo chmod 777 /srv
```

At this point, follow the instructions in just the "Generate Credentials" section, except whenever it says to use `~/multistream-bot`, use `/srv` instead, and for the callback URL, use `http://localhost:8080/auth/twitch/callback` instead, and `BASE_URL`, use `http://localhost:8080` instead. After the "Generate Credentials" section, come back here.

```bash
git clone https://codeberg.org/johanvandegriff/multistream-bot
cd multistream-bot
npm install
npm start #or node server.js
```

Then go to `http://localhost:8080` in your browser to see the app running locally.

## Building a Docker Image
Once you have it running locally and have made some changes, you can build it into a docker container so you can deploy it somewhere.

Sign up for a docker hub account at https://hub.docker.com/

Run the following command, changing `johanvandegriff` to your docker hub username, and changing `build13` to whatever tag you want, I usually just start at `build1` and go up from there:
```bash
docker build . -t johanvandegriff/multistream-bot:build13
docker push johanvandegriff/multistream-bot:build13
```

Then you can modify your `docker run` command from the deploying section accordingly, to deploy your new container instead of the one I built.
