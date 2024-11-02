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
}
const DEFAULT_VIEWER_PROPS = {
    nickname: undefined,
    custom_greetz: undefined,
}

const fs = require('fs');
const redis = require('./main-container/node_modules/redis');

const data = JSON.parse(fs.readFileSync('prod-data.json').toString('utf-8'));
console.log(data);

const redis_client = redis.createClient({
    url: process.env.STATE_DB_URL,
    password: process.env.STATE_DB_PASSWORD
});
redis_client.on('error', err => console.log('Redis Client Error', err));

(async () => {
    try {
        await redis_client.connect();
        console.log(await redis_client.sMembers('channels'));

        for (const channel of Object.keys(data.channels)) {
            console.log(channel);
            await redis_client.sAdd('channels', channel);
            await redis_client.set(`channels/${channel}/channel_props/did_first_run`, JSON.stringify(true));

            for (const prop_name of Object.keys(DEFAULT_CHANNEL_PROPS)) {
                let prop_value = data.channels[channel][prop_name];
                if (prop_value !== undefined) {
                    console.log('  ' + prop_name, prop_value);
                    await redis_client.set(`channels/${channel}/channel_props/${prop_name}`, JSON.stringify(prop_value));
                }
            }

            const viewers = [];
            for (const prop_name of Object.keys(DEFAULT_VIEWER_PROPS)) {
                let prop_value = data.channels[channel][prop_name];
                if (prop_value !== undefined) {
                    for (const viewer of Object.keys(prop_value)) {
                        if (!viewers.includes(viewer)) {
                            viewers.push(viewer);
                        }
                    }
                }
            }

            console.log('  viewers:');
            for (const viewer of viewers) {
                console.log('    ' + viewer);
                for (const prop_name of Object.keys(DEFAULT_VIEWER_PROPS)) {
                    if (data.channels[channel][prop_name] !== undefined && data.channels[channel][prop_name][viewer] !== undefined) {
                        const prop_value = data.channels[channel][prop_name][viewer];
                        console.log('      ' + prop_name, prop_value);
                        await redis_client.sAdd(`channels/${channel}/viewers`, viewer);
                        await redis_client.hSet(`channels/${channel}/viewers/${viewer}`, { [prop_name]: JSON.stringify(prop_value) });
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await redis_client.disconnect();
    }
})();
