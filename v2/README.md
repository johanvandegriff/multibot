# JJBotBot
This is a multi-function twitch bot.

Version 2 is rewritten with a different architecture to allow separating each streamer into their own instance for better scalability and uptime.

v2 is currently a prototype and many things are hardcoded, such as the channels (currently enabled only on twitch channels `jjvanvan` and `minecraft1167890` so if you want to change that, search and replace those usernames in the code). It uses docker-compose currently, with plans to migrate to kubernetes in the cloud. It is also missing a lot of features from v1 since it is in the proof of concept stage. So most of this is just for future reference for myself at this point.

## Running Locally
Clone the code, and create the file `.env` in the `v2` directory (the one this README is in) with the following contents:
```
BASE_URL=http://localhost
EMAIL_ADDRESS=your_email_address@example.com
STATE_DB_PASSWORD=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_SUPER_ADMIN_USERNAME=yourtwitchaccountlowercase
TWITCH_BOT_USERNAME=YourBotUsernameCaseSensitive
TWITCH_BOT_OAUTH_TOKEN=oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
YOUTUBE_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Replace all the secrets as described in the [main README](../README.md), ignoring the ones starting with `BUCKET_` since this version doesn't use a bucket.

Then run it in the terminal by changing into the v2 directory with `cd v2` and building/running the docker images with `./build.sh`

Navigate to `http://localhost` in your browser to see the app. The main page is hosted by `main-container` and the streamer pages are hosted by instances of `tenant-container`. They share data such as login sessions through a redis `state-db` container. The `router-container` handles sending the different URLs to the different containers.
