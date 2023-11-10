Note: this readme is out of date and will be updated when the bot is done. TODO

# twitch-nickname-bot
This is a twitch bot that allows chat members to set a nickname, then it will greet them using that nickname, and the bot will reply when mentioned or replied to. 

## Add to Your Channel
Go to https://nicknames.johanv.net and click on "log in" at the top right. It will say `JJ's nickname bot wants to access your account`, click Authorize. Then it says `The bot is NOT enabled on your channel`, so click ENABLE.

Sometimes when there are a lot of users running commands, the bot sends messages too quickly and twitch doesn't display all of them. You can fix this my making the bot a mod by typing `/mod JJsNicknameBot` in chat. This is optional, but will avoid missing any messages.

You are done! Chat members will now be able to type `!setnickname mynickname` to pick a nickname, `!nickname` to check their nickname, `!nickname username` to check another user's nickname, and `!nicknames` to pull up the webpage with all the nicknames.

If you (the streamer) ever want to log in and edit/add a nickname manually, just type `!nicknames` in chat and follow the link, then log in again and you can edit everything, and even disable the bot.


## Deploying
This code is open source (AGPL-3.0 license), so you don't have to use my server at https://nicknames.johanv.net and instead you can choose to deploy the code to your own server.

You will need:
* __a domain name__: I use namesilo but any domain name service will work fine.
* __a server with a public IP address and docker installed__: I use [digitalocean](https://m.do.co/c/f300a2838d1d) but you can use any cloud provider, or even host it at your house/apartment and port forward thru your router. Make sure to log into your domain name service and point the domain or subdomain at the public IP address of the server.
* __a twitch account for the bot__: I recommend creating a new account for the bot, but you can use your own twitch account if you want.

### Generate Credentials
Log in with the bot's twitch account, then visit this page to generate an oauth token: https://twitchapps.com/tmi/

Also visit this page to generate app credentials: https://dev.twitch.tv/console/apps

The callback URL will depend on your domain name, for example `https://your-domain-name.com/auth/twitch/callback`

On your server, make a directory for the files to be kept:
```bash
mkdir ~/twitch-nickname-bot
```

Then create a config file in that directory:
```bash
nano secret-twitch.env
```
Note: in nano, you can do Ctrl-S to save (or Ctrl-O enter if Ctrl-S doesn't work), and Ctrl-X to exit.

And add the following (we will change the values shortly):
```
TWITCH_SUPER_ADMIN_USERNAME=jjvantheman
TWITCH_BOT_USERNAME=JJsNicknameBot
TWITCH_BOT_OAUTH_TOKEN=oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BASE_URL=https://your-domain-name.com
```

For `TWITCH_SUPER_ADMIN_USERNAME`, put your twitch account. Multiple people can log in with twitch once it's deployed, but only you will have the highest level of admin when you log in. You could also put the bot's twitch account for this, but it could be less convenient since you probably won't stay logged in as the bot long term.

For `TWITCH_BOT_USERNAME`, put the username of the bot twitch account you made, and if you chose to use your own account, put that. This is CASE SENSITIVE!

For `TWITCH_BOT_OAUTH_TOKEN`, put the token you generated from https://twitchapps.com/tmi/ and make sure that you generated it while logged into the same account as `TWITCH_BOT_USERNAME`.

For `TWITCH_CLIENT_ID` and `TWITCH_SECRET`, enter the Client ID and Client Secret you generated from https://dev.twitch.tv/console/apps and again make sure you were logged in with `TWITCH_BOT_USERNAME`.

For `SESSION_SECRET`, this just needs to be random, nothing specific, so type a long string of numbers and letters on your keyboard.

Again, `BASE_URL` will depend on your domain name, for example `https://your-domain-name.com` and make sure there is NO slash at the end.

Make sure to save with Ctrl-S (or Ctrl-O) and exit nano with Ctrl-X.

At this point, you should have a directory called `twitch-nickname-bot` with a file `secret-twitch.env` inside it. Run these commands to double check:

```bash
ls twitch-nickname-bot
cat twitch-nickname-bot/secret-twitch.env
```

### Run the Docker Container
Create a docker virtual network. This will be useful for later when we make a SSL proxy. You can call it whatever you want, or just keep it as `mynetwork`, it doesn't matter.
```bash
docker network create mynetwork
```

Now we need to pull the latest image and run it, which we can do in one command. First check for the latest tag on https://hub.docker.com/r/johanvandegriff/twitch-nickname-bot/tags

Let's say the latest was `build7`, then the command would be:

```bash
docker run --name twitch-nickname-bot -d --restart unless-stopped --net mynetwork -v ~/twitch-nickname-bot:/srv johanvandegriff/twitch-nickname-bot:build7
```

Check that the container started up fine with:
```bash
docker logs twitch-nickname-bot
```

Also, it will create a JSON file to hold all the nicknames and other info, you can check that file with:

```bash
cat twitch-nickname-bot/nicknames.json
```

### Set up an SSL Proxy for HTTPS
We will be using [Caddy](https://caddyserver.com/) as the proxy, however you can use whatever proxy you want if you know what you're doing.

Create a directory for Caddy to store the files it will generate:
```bash
mkdir caddy-data
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
        reverse_proxy twitch-nickname-bot:8080
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

At this point, follow the instructions in just the "Generate Credentials" section, except whenever it says to use `~/twitch-nickname-bot`, use `/srv` instead, and for the callback URL, use `http://localhost:8080/auth/twitch/callback` instead, and `BASE_URL`, use `http://localhost:8080` instead. After the "Generate Credentials" section, come back here.

```bash
git clone https://codeberg.org/johanvandegriff/twitch-nickname-bot
cd twitch-nickname-bot
npm install
npm start #or node server.js
```

Then go to `http://localhost:8080` in your browser to see the app running locally.

## Building a Docker Image
Once you have it running locally and have made some changes, you can build it into a docker container so you can deploy it somewhere.

Sign up for a docker hub account at https://hub.docker.com/

Run the following command, changing `johanvandegriff` to your docker hub username, and changing `build7` to whatever tag you want, I usually just start at `build1` and go up from there:
```bash
docker build . -t johanvandegriff/twitch-nickname-bot:build7
docker push johanvandegriff/twitch-nickname-bot:build7
```

Then you can modify your `docker run` command from the deploying section accordingly, to deploy your new container instead of the one I built.
