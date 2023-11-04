```bash
mkdir ~/twitch-nickname-bot

#change all the values below:
cat <<EOF > ~/twitch-nickname-bot/secret-twitch.env
TWITCH_BOT_USERNAME=JJsNicknameBot
TWITCH_BOT_OAUTH_TOKEN=oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_BOT_CHANNELS=jjvantheman,minecraft1167890
TWITCH_BOT_MAX_NICKNAME_LENGTHS=3,100
EOF

docker run --name twitch-nickname-bot -d --restart unless-stopped --net johanvnet -v ~/twitch-nickname-bot:/srv johanvandegriff/twitch-nickname-bot:build6
```
