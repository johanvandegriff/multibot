const ENV_FILE = '../.env.prod';

const REDIS_NAMESPACE = 'multibot';
const PREDIS = REDIS_NAMESPACE + ':';

const HOUR_IN_MILLISECONDS = 1 * 60 * 60 * 1000;
const DEFAULT_CHANNEL_PROPS = {
    enabled: true,
    did_first_run: false,
    fwd_cmds_yt_twitch: ['!sr', '!test'],
    max_nickname_length: 20,
    greetz_threshold: 5 * HOUR_IN_MILLISECONDS,
    greetz_wb_threshold: 0.75 * HOUR_IN_MILLISECONDS,
    youtube_id: '',
    owncast_url: '',
    kick_username: '',
    kick_chatroom_id: '',
    show_usernames: true,
    show_nicknames: true,
    show_pronouns: true,
    text_shadow: '1px 1px 2px black',
    font: `"Cabin", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif`,
}

require('dotenv').config({ path: ENV_FILE });
const fs = require('fs');
const redis = require('../main-container/node_modules/redis');
const argv = require('yargs/yargs')(process.argv.slice(2)).argv;
const clearRedis = argv.clearRedis || false;

if (!argv._[0]) {
    console.error('Please provide the path to the exported redis json file as the first argument.');
    process.exit(1);
}
const backupFilePath = argv._[0];

const redis_client = redis.createClient({
    url: process.env.STATE_DB_URL.replace('private-', ''),
    password: process.env.STATE_DB_PASSWORD,
});
redis_client.on('error', err => console.log('Redis Client Error', err));

(async () => {
    try {
        await redis_client.connect();

        if (clearRedis) {
            await redis_client.flushDb();
            console.log('Cleared existing Redis database');
        }

        const data = JSON.parse(fs.readFileSync(backupFilePath).toString('utf-8'));

        for (const channel of Object.keys(data.channels)) {
            await redis_client.sAdd(`${PREDIS}channels`, channel);

            for (const prop_name of Object.keys(DEFAULT_CHANNEL_PROPS)) {
                if (data.channels[channel][prop_name] !== undefined) {
                    await redis_client.set(`${PREDIS}channels/${channel}/channel_props/${prop_name}`, JSON.stringify(data.channels[channel][prop_name]));
                }
            }

            if (data.channels[channel].viewers) {
                for (const viewer of Object.keys(data.channels[channel].viewers)) {
                    await redis_client.sAdd(`${PREDIS}channels/${channel}/viewers`, viewer);
                    for (const prop_name of Object.keys(data.channels[channel].viewers[viewer])) {
                        await redis_client.hSet(`${PREDIS}channels/${channel}/viewers/${viewer}`, prop_name, JSON.stringify(data.channels[channel].viewers[viewer][prop_name]));
                    }
                }
            }
        }

        console.log('Restore completed successfully');
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await redis_client.disconnect();
    }
})();
