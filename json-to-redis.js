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

import fs from 'fs';
import redis from 'redis';
const data = JSON.parse(fs.readFileSync('../prod-data.json').toString('utf-8'));
console.log(data)

const redis_client = redis.createClient({
    url: process.env.STATE_DB_URL,
    password: process.env.STATE_DB_PASSWORD
});
redis_client.on('error', err => console.log('Redis Client Error', err));

(async () => {
    await redis_client.connect();
    console.log(await redis_client.sMembers('channels'));
    Object.keys(data.channels).forEach(async channel => {
        console.log(channel);
        await redis_client.sAdd('channels', channel);
        await redis_client.set(`channels/${channel}/channel_props/did_first_run`, JSON.stringify(true));
        Object.keys(DEFAULT_CHANNEL_PROPS).forEach(async prop_name => {
            let prop_value = data.channels[channel][prop_name];
            if (prop_value !== undefined) {
                console.log('  ' + prop_name, prop_value);
                await redis_client.set(`channels/${channel}/channel_props/${prop_name}`, JSON.stringify(prop_value));
            }
        });
        const viewers = [];
        Object.keys(DEFAULT_VIEWER_PROPS).forEach(prop_name => {
            let prop_value = data.channels[channel][prop_name];
            if (prop_value !== undefined) {
                Object.keys(prop_value).forEach(viewer => {
                    if (!viewers.includes(viewer)) {
                        viewers.push(viewer);
                    }
                });
            }
        });
        console.log('  viewers:');
        viewers.forEach(viewer => {
            console.log('    ' + viewer);
            Object.keys(DEFAULT_VIEWER_PROPS).forEach(async prop_name => {
                if (data.channels[channel][prop_name] !== undefined && data.channels[channel][prop_name][viewer] !== undefined) {
                    const prop_value = data.channels[channel][prop_name][viewer];
                    console.log('      ' + prop_name, prop_value);
                    await redis_client.sAdd(`channels/${channel}/viewers`, viewer);
                    await redis_client.hSet(`channels/${channel}/viewers/${viewer}`, { [prop_name]: JSON.stringify(prop_value) });            
                }
            });
        });
    });
})();
