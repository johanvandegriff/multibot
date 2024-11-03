const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL; //the channel that this tenant container is set to operate on
const CHAT_HISTORY_LENGTH = 100;
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
const DEFAULT_VIEWER_PROPS = {
    nickname: undefined,
    custom_greetz: undefined,
}

const DEFAULT_BOT_NICKNAME = '🤖';
const YOUTUBE_MAX_MESSAGE_AGE = 10 * 1000; //10 seconds
const YOUTUBE_CHECK_FOR_LIVESTREAM_INTERVAL = 1 * 60 * 1000; //1 minute
const OWNCAST_CHECK_FOR_LIVESTREAM_INTERVAL = 1 * 60 * 1000; //1 minute
const KICK_CHECK_FOR_LIVESTREAM_INTERVAL = 1 * 60 * 1000; //1 minute
const EMOTE_STARTUP_DELAY = 2 * 60 * 1000; //2 minutes
const EMOTE_CACHE_TIME = 1 * 60 * 60 * 1000; //1 hour
const EMOTE_RETRY_TIME = 30 * 1000; //30 seconds
const PRONOUN_CACHE_TIME = 24 * 60 * 60 * 1000; //1 day
const PRONOUN_RETRY_TIME = 30 * 1000; //30 seconds
const GREETZ_DELAY_FOR_COMMAND = 2 * 1000; //wait 2 seconds to greet when the user ran a command
const TWITCH_MESSAGE_DELAY = 500; //time to wait between twitch chats for both to go thru
const ENABLED_COOLDOWN = 5 * 1000; //only let users enable/disable their channel every 5 seconds

const GREETZ = [
    'yo #',
    'yo #',
    'yo yo #',
    'yo yo yo #',
    'yo yo yo # whats up!',
    'heyo #',
    'yooo # good to see u',
    'good to see u #',
    'hi #',
    'hello #',
    'helo #',
    'whats up #',
    'hey #, whats up?',
    'welcome #',
    'welcome in, #',
    'greetings #',
    'hows it going #',
    'hey whats new with you #',
    'how have you been #',
    '#!',
];

const GREETZ_ALSO = [
    'also hi #',
    'also hi # whats up!',
    'also its good to see u #',
    'also whats up #',
    'also, whats up #?',
    'also welcome #',
    'also welcome in, #',
    'also welcome to chat, #',
    'also welcome to the stream, #',
    'also hows it going #',
    'also how have you been #',
];


const GREETZ_WELCOME_BACK = [
    'welcome back #',
    'welcome back in, #',
    'welcome back to chat, #',
    'good to see u again #',
    'hello again #',
    'hi again #',
];

const GREETZ_WELCOME_BACK_ALSO = [
    'also welcome back #',
    'also welcome back in, #',
    'also welcome back to chat, #',
    'also good to see u again #',
    'also hello again #',
    'also hi again #',
];


import tmi from 'tmi.js'; //twitch chat https://dev.twitch.tv/docs/irc
import TwitchEmoticons from '@mkody/twitch-emoticons';
const { EmoteFetcher, EmoteParser } = TwitchEmoticons;
import { Masterchat, stringify } from '@stu43005/masterchat'; //youtube chat https://www.npmjs.com/package/@stu43005/masterchat
import filter from 'leo-profanity';
filter.isProfane = (s) => s !== filter.clean(s);

import { inspect } from 'util'
import redis from 'redis';
import http from 'http';
import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import fs from 'fs';
import crypto from 'crypto';
import handlebars from 'handlebars';
import bodyParser from 'body-parser';
import ws, { WebSocketServer } from 'ws';
import pkg from 'websocket';
const { client: WebSocketClient } = pkg;
import { Events, Kient } from 'kient'; //kick chat https://www.npmjs.com/package/kient

// Initialize Express and middlewares
const app = express();
const json_parser = bodyParser.json();
const server = http.createServer(app);

const wss = new WebSocketServer({ server });
wss.on('connection', (client) => {
    console.log('[websocket] client connected!');
    broadcast('page_hash', { page_hash: index_page_hash }, [client]);
    // client.on('message', (msg) => {
    //     console.log('[websocket] message: ' + msg);
    //     // msg = JSON.parse(msg);
    //     // broadcast(msg.type, msg.content);
    // });
});
function broadcast(msg_type, msg_content, clients = wss.clients) {
    const msg = JSON.stringify({ type: msg_type, content: msg_content });
    for (const client of clients) {
        if (client.readyState === ws.OPEN) {
            client.send(msg);
        }
    }
}

const redis_client = redis.createClient({
    url: process.env.STATE_DB_URL,
    password: process.env.STATE_DB_PASSWORD
});

redis_client.on('error', err => console.log('Redis Client Error', err));
(async () => {
    await redis_client.connect();
    if (!await get_channel_prop('did_first_run')) {
        console.log('FIRST RUN');
        for (const username of await list_viewers()) {
            await redis_client.del(`channels/${TWITCH_CHANNEL}/viewers/${username}`); //delete viewer data
        }
        await redis_client.del(`channels/${TWITCH_CHANNEL}/viewers`); //delete viewer list

        for (const prop_name in DEFAULT_CHANNEL_PROPS) {
            await redis_client.del(`channels/${TWITCH_CHANNEL}/channel_props/${prop_name}`); //delete channel prop
        }
        await set_viewer_prop(process.env.TWITCH_BOT_USERNAME, 'nickname', DEFAULT_BOT_NICKNAME);
        await set_channel_prop('did_first_run', true);
    }
})();


//credit to https://github.com/twitchdev/authentication-node-sample (apache 2.0 license) for the auth code
app.use(session({
    store: new RedisStore({ client: redis_client }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        maxAge: 1000 * 60 * 1 // Session expiration time (1min)
    }
}));
// app.use(express.static('public'));

function channel_auth_middleware(req, res, next) {
    const login = req.session?.passport?.user?.login;
    if (login === TWITCH_CHANNEL || is_super_admin(login)) {
        console.log('auth success', req.originalUrl, req.body, login, is_super_admin(login));
        next();
    } else {
        console.error('access denied', req.originalUrl, req.body, login, is_super_admin(login));
        res.status(403).end(); //403 Forbidden
    }
}

//expose js libraries to client so they can run in the browser
app.use('/vue.js', express.static('node_modules/vue/dist/vue.esm-browser.prod.js'));
app.use('/color-hash.js', express.static('node_modules/color-hash/dist/esm.js'));
app.use('/tmi-utils', express.static('node_modules/tmi-utils/dist/esm', { 'extensions': ['js'] })); //add .js if not specified

// Define a simple template to safely generate HTML with values from user's profile
const index_page = fs.readFileSync('index.html', 'utf8');
const index_page_hash = crypto.createHash('sha256').update(index_page).digest('hex');
const template = handlebars.compile(index_page);

// If user has an authenticated session, display it, otherwise display link to authenticate
app.get('/', async (req, res) => {
    const user = req.session?.passport?.user;
    res.send(template({
        page_hash: index_page_hash,
        user: user,
        channel: TWITCH_CHANNEL,
        channels: await list_channels(),
        is_super_admin: is_super_admin(user?.login),
        enabled_cooldown: ENABLED_COOLDOWN,
    }));
});

app.get('/chat', async (req, res) => {
    const user = req.session?.passport?.user;
    res.send(template({
        page_hash: index_page_hash,
        user: user,
        channel: TWITCH_CHANNEL,
        channels: await list_channels(),
        is_super_admin: is_super_admin(user?.login),
        enabled_cooldown: ENABLED_COOLDOWN,

        is_chat_fullscreen: true,
        bgcolor: req.query.bgcolor ?? 'transparent',
    }));
});

//how many websocket clients are connected
app.get('/ws/num_clients', (req, res) => { res.send(`${wss.clients.size}`); });


const channel_prop_listeners = {
    // youtube_id: [
    //     (old_value, new_value) => {...},
    //     (old_value, new_value) => {...},
    // ],
};

const viewer_prop_listeners = {
    // nickname: [
    //     (username, old_value, new_value) => {...},
    //     (username, old_value, new_value) => {...},
    // ],
};

function add_channel_prop_listener(prop_name, func) {
    if (!channel_prop_listeners[prop_name]) {
        channel_prop_listeners[prop_name] = [];
    }
    channel_prop_listeners[prop_name].push(func);
}

function add_viewer_prop_listener(prop_name, func) {
    if (!viewer_prop_listeners[prop_name]) {
        viewer_prop_listeners[prop_name] = [];
    }
    viewer_prop_listeners[prop_name].push(func);
}

// add_channel_prop_listener('enabled', (old_value, new_value) => console.log('CHANNEL LISTENER', old_value, new_value));
// add_viewer_prop_listener('nickname', (username, old_value, new_value) => console.log('VIEWER LISTENER', username, old_value, new_value));


async function list_viewers() {
    return await redis_client.sMembers(`channels/${TWITCH_CHANNEL}/viewers`);
}

async function list_channels() {
    return await redis_client.sMembers('channels');
}

async function delete_viewer(username) {
    await redis_client.sRem(`channels/${TWITCH_CHANNEL}/viewers`, username);
    await redis_client.del(`channels/${TWITCH_CHANNEL}/viewers/${username}`);
    broadcast('delete_viewer', { username: username });
}

async function get_channel_prop(prop_name) {
    const prop_value = await redis_client.get(`channels/${TWITCH_CHANNEL}/channel_props/${prop_name}`);
    if (prop_value === null) {
        return DEFAULT_CHANNEL_PROPS[prop_name];
    } else {
        return JSON.parse(prop_value);
    }
}

async function set_channel_prop(prop_name, prop_value) {
    let old_prop_value;
    //only retrieve the old value if there is at least 1 listener that needs it
    if (channel_prop_listeners[prop_name]) {
        old_prop_value = await get_channel_prop(prop_name);
    }
    if (prop_value === undefined) {
        await redis_client.del(`channels/${TWITCH_CHANNEL}/channel_props/${prop_name}`);
    } else {
        await redis_client.set(`channels/${TWITCH_CHANNEL}/channel_props/${prop_name}`, JSON.stringify(prop_value));
    }
    //make sure to run the listeners after the value is changed in redis
    if (channel_prop_listeners[prop_name]) {
        if (old_prop_value !== prop_value) {
            channel_prop_listeners[prop_name].forEach(func => func(old_prop_value, prop_value));
        }
    }
    broadcast('channel_prop', { prop_name: prop_name, prop_value: prop_value });
}

async function get_viewer_prop(username, prop_name) {
    const prop_value = await redis_client.hGet(`channels/${TWITCH_CHANNEL}/viewers/${username}`, prop_name);
    if (prop_value === null) {
        return DEFAULT_VIEWER_PROPS[prop_name];
    } else {
        return JSON.parse(prop_value);
    }
}
async function get_viewer_props(username) {
    const viewer_props = await redis_client.hGetAll(`channels/${TWITCH_CHANNEL}/viewers/${username}`);
    for (const prop_name of Object.keys(viewer_props)) {
        viewer_props[prop_name] = JSON.parse(viewer_props[prop_name]);
    }
    return viewer_props;
}

async function set_viewer_prop(username, prop_name, prop_value) {
    let old_prop_value;
    //only retrieve the old value if there is at least 1 listener that needs it
    if (viewer_prop_listeners[prop_name]) {
        old_prop_value = await get_viewer_prop(username, prop_name);
    }
    if (prop_value === undefined) {
        await redis_client.hDel(`channels/${TWITCH_CHANNEL}/viewers/${username}`, prop_name); //delete just 1 prop
    } else {
        await redis_client.sAdd(`channels/${TWITCH_CHANNEL}/viewers`, username);
        await redis_client.hSet(`channels/${TWITCH_CHANNEL}/viewers/${username}`, { [prop_name]: JSON.stringify(prop_value) });
    }
    //make sure to run the listeners after the value is changed in redis
    if (viewer_prop_listeners[prop_name]) {
        if (old_prop_value !== prop_value) {
            viewer_prop_listeners[prop_name].forEach(func => func(username, old_prop_value, prop_value));
        }
    }
    broadcast('viewer_prop', { username: username, prop_name: prop_name, prop_value: prop_value });
}


app.get('/channel_props/:prop_name', async function (req, res) {
    res.send(JSON.stringify(await get_channel_prop(req.params.prop_name)));
});

let enabled_timeout = undefined;
app.post('/channel_props/:prop_name', json_parser, channel_auth_middleware, async function (req, res) {
    const prop_name = req.params.prop_name;
    const prop_value = req.body.prop_value;
    if (!(prop_name in DEFAULT_CHANNEL_PROPS)) {
        res.status(400).send('invalid prop_name'); //400 Bad Request
    } else {
        if (prop_name === 'enabled') {
            const now = new Date();
            if (!enabled_timeout || now - enabled_timeout > ENABLED_COOLDOWN) {
                enabled_timeout = now;
            } else {
                res.send('wait');
                return;
            }
        }
        set_channel_prop(prop_name, prop_value);
        res.send('ok');
    }
});


app.get('/viewers', async function (req, res) {
    const viewers = await list_viewers();
    const viewer_data = {};
    for (const username of viewers) {
        viewer_data[username] = await get_viewer_props(username);
    }
    res.send(JSON.stringify(viewer_data));
});

//not used in client yet
app.get('/viewers/:username/:prop_name', channel_auth_middleware, async function (req, res) {
    res.send(JSON.stringify(await get_viewer_prop(req.params.username, req.params.prop_name)));
});

app.post('/viewers/:username/:prop_name', json_parser, channel_auth_middleware, async function (req, res) {
    const username = req.params.username;
    const prop_name = req.params.prop_name;
    const prop_value = req.body.prop_value;
    if (!(prop_name in DEFAULT_VIEWER_PROPS)) {
        res.status(400).send('invalid prop_name'); //400 Bad Request
    } else {
        set_viewer_prop(username, prop_name, prop_value);
        res.send('ok');
    }
});

app.delete('/viewers/:username', channel_auth_middleware, async function (req, res) {
    const username = req.params.username;
    await delete_viewer(username);
    res.send('ok');
});


app.get('/find_youtube_id', async (req, res) => {
    var channel = req.query.channel; //could be a url or a handle

    console.log('[youtube] looking up', channel);
    if (channel.startsWith('http://www.youtube.com/') || channel.startsWith('http://youtube.com/')) {
        channel = channel.replace('http://', '');
    }
    if (channel.startsWith('www.youtube.com/') || channel.startsWith('youtube.com/')) {
        channel = 'https://' + channel;
    }
    //handle the handle
    if (channel.startsWith('@')) {
        // https://www.youtube.com/@jjvan
        channel = 'https://www.youtube.com/' + channel;
    } else if (!channel.startsWith('https://') && !channel.startsWith('http://')) {
        channel = 'https://www.youtube.com/@' + channel;
    }
    if (channel.startsWith('https://www.youtube.com/channel/') || channel.startsWith('https://youtube.com/channel/') || channel.startsWith('https://www.youtube.com/@') || channel.startsWith('https://youtube.com/@')) {
        const text = await (await fetch(channel)).text();
        // <link rel="canonical" href="https://www.youtube.com/channel/UC3G4BWSWvZZSKAkj-qb7KKQ">
        const regex = /\<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([^"]*)"\>/
        const match = regex.exec(text);
        if (match) {
            console.log('[youtube] found ID:', match[1], 'for channel:', channel);
            res.send(match[1]);
        } else {
            console.error('[youtube] error finding channel ID for:', channel);
            res.status(500).send('error'); //500 Internal Server Error
        }
    } else {
        console.error('[youtube] invalid URL or handle provided:', channel);
        res.status(400).send('invalid');
    }
});

app.get('/status/twitch', async (req, res) => { res.send(inspect(twitch_listener)); });
app.get('/status/youtube', async (req, res) => { res.send(JSON.stringify({ listener: youtube_listener })); });
app.get('/status/owncast', async (req, res) => { res.send(JSON.stringify({ listener: owncast_listener })); });
app.get('/status/kick', async (req, res) => { res.send(inspect(kick_listener?._wsClient?.pusher)); });
app.get('/status/emotes', async (req, res) => {
    const emote_cache_copy = {};
    for (const k of Object.keys(emote_cache)) {
        if (k === 'emotes') {
            emote_cache_copy['num_' + k] = Object.keys(emote_cache[k]).length
        } else {
            emote_cache_copy[k] = emote_cache[k];
        }
    }
    res.send(emote_cache_copy);
});

app.post('/clear_chat', channel_auth_middleware, async (req, res) => {
    clear_chat();
    res.send('ok');
});

app.get('/chat_history', async (req, res) => { res.send(JSON.stringify(chat_history)); });

const chat_history = [
    // { "source": "twitch", "username": "JJVanVan", "nickname": "JJ", "pronouns": "Any", "color": "#8A2BE2", "emotes": { "emotesv2_30050f4353aa4322b25b6b044703e5d1": ["5-12"] }, "text": "test PogBones abc123" },
    // { "source": "twitch", "username": "JJBotBot", "nickname": "🤖", "pronouns": "It/Its", "color": null, "emotes": {}, "text": "yo yo JJ" },
];
async function clear_chat(channel) {
    chat_history.length = 0;
    console.log(`CLEAR CHAT`);
    broadcast('command', { command: 'clear' });
}

function send_chat(source, username, nickname, color, text, emotes, pronouns) {
    if (!emotes) {
        emotes = {};
    }
    try {
        emotes = Object.assign(find_3rd_party_emotes(text), emotes); //put the original emotes last so they don't get overwritten
    } catch (err) {
        console.error('[emotes] error finding 3rd party emotes:', text, err);
    }
    const msg = { source: source, username: username, nickname: nickname, pronouns: pronouns, color: color, emotes: emotes, text: text };
    chat_history.push(msg);
    if (chat_history.length > CHAT_HISTORY_LENGTH) {
        chat_history.shift();
    }
    console.log(`[websocket] [${source}] SEND CHAT ${username} (nickname: ${nickname} pronouns: ${pronouns} color: ${color} emotes: ${JSON.stringify(emotes)}): ${text}`);
    broadcast('chat', msg);
}




//pronouns - https://pronouns.alejo.io/
const possible_pronouns = {
    aeaer: "Ae/Aer",
    any: "Any",
    eem: "E/Em",
    faefaer: "Fae/Faer",
    hehim: "He/Him",
    heshe: "He/She",
    hethem: "He/They",
    itits: "It/Its",
    other: "Other",
    perper: "Per/Per",
    sheher: "She/Her",
    shethem: "She/They",
    theythem: "They/Them",
    vever: "Ve/Ver",
    xexem: "Xe/Xem",
    ziehir: "Zie/Hir",
};
(async () => {
    const response = await fetch('https://pronouns.alejo.io/api/pronouns');
    const data = await response.json();
    //[{"name":"aeaer","display":"Ae/Aer"},{"name":"any","display":"Any"},{"name":"eem","display":"E/Em"},{"name":"faefaer","display":"Fae/Faer"},{"name":"hehim","display":"He/Him"},{"name":"heshe","display":"He/She"},{"name":"hethem","display":"He/They"},{"name":"itits","display":"It/Its"},{"name":"other","display":"Other"},{"name":"perper","display":"Per/Per"},{"name":"sheher","display":"She/Her"},{"name":"shethem","display":"She/They"},{"name":"theythem","display":"They/Them"},{"name":"vever","display":"Ve/Ver"},{"name":"xexem","display":"Xe/Xem"},{"name":"ziehir","display":"Zie/Hir"}]
    for (const item of data) {
        possible_pronouns[item.name] = item.display;
    }
    console.log('[pronouns] fetched pronoun list of length', Object.keys(possible_pronouns).length);
})();

const pronoun_cache = {
    // jjvanvan: {
    //     pronouns: 'Any', //display name, looked up from possible_pronouns['any']
    //     pronouns: undefined, //if there are none associated with this user
    //     lastUpdated: 123456, //or undefined if never
    //     startedUpdating: 123456, //or undefined if done updating
    // },
    // user: undefined //if pronouns haven't been looked up yet
}

function get_pronouns(username) {
    const now = + new Date();
    const lastUpdated = pronoun_cache[username]?.lastUpdated ?? 0;
    const startedUpdating = pronoun_cache[username]?.startedUpdating ?? 0;
    console.log('[pronouns] pronoun cache status:', username, now, lastUpdated, PRONOUN_CACHE_TIME, startedUpdating, PRONOUN_RETRY_TIME);
    if (now > lastUpdated + PRONOUN_CACHE_TIME && now > startedUpdating + PRONOUN_RETRY_TIME) { //if the pronoun has expired
        //update the cache in the background
        (async () => {
            if (!pronoun_cache[username]) {
                pronoun_cache[username] = {}
            }
            pronoun_cache[username].startedUpdating = now;

            const response = await fetch('https://pronouns.alejo.io/api/users/' + username); //[{"id":"501240813","login":"jjvanvan","pronoun_id":"any"}]
            const data = await response.json();
            const pronoun_id = data[0]?.pronoun_id;
            const pronouns = possible_pronouns[pronoun_id] ?? pronoun_id;
            pronoun_cache[username] = {
                pronouns: pronouns,
                lastUpdated: now,
            };
            //send the pronouns to retroactively apply to any chat messages that don't have them
            broadcast('pronouns', { username: username, pronouns: pronouns });

            //also apply it to the chat history
            chat_history.forEach(msg => {
                if (msg.username === username && msg.pronouns === undefined) {
                    msg.pronouns = pronouns;
                }
            });
        })();
    }
    return pronoun_cache[username]?.pronouns;
}


//3rd party emotes
//if any of this fails, the send_chat code will fall back to just twitch emotes
// https://github.com/mkody/twitch-emoticons
const emote_cache = {
    // emotes: {
    //     catJAM: 'https://cdn.7tv.app/emote/60ae7316f7c927fad14e6ca2/1x.webp',
    // },
    // lastUpdated: 123456, //or undefined if never
    // startedUpdating: 123456, //or undefined if done updating
    // "connections": {
    //     "global_bttv": true,
    //     "global_7tv": true,
    //     "global_ffz": true,
    //     "channel_bttv": false,
    //     "channel_7tv": false,
    //     "channel_ffz": false
    // },
}

async function update_emote_cache_if_needed() {
    const now = + new Date();
    const lastUpdated = emote_cache.lastUpdated ?? 0;
    const startedUpdating = emote_cache.startedUpdating ?? 0;
    console.log('[emotes] emote cache status:', now, lastUpdated, EMOTE_CACHE_TIME, startedUpdating, EMOTE_RETRY_TIME);
    if (now > lastUpdated + EMOTE_CACHE_TIME && now > startedUpdating + EMOTE_RETRY_TIME) {
        console.log('[emotes] updating emote cache');
        emote_cache.startedUpdating = + new Date();
        const fetcher = new EmoteFetcher(process.env.TWITCH_CLIENT_ID, process.env.TWITCH_SECRET);

        try {
            //get the global emotes for each service - required, so abort if any fail
            await Promise.all([
                // fetcher.fetchTwitchEmotes(), // Twitch global //we will let twitch handle these
                fetcher.fetchBTTVEmotes(), // BTTV global
                fetcher.fetchSevenTVEmotes(), // 7TV global
                fetcher.fetchFFZEmotes(), // FFZ global
            ]);
            const connections = {
                // global_twitch: true,
                global_bttv: true,
                global_7tv: true,
                global_ffz: true,
                channel_bttv: false,
                channel_7tv: false,
                channel_ffz: false,
            }

            //get the channel emotes for each service - optional, so continue if any fail
            try {
                const helixUser = await fetcher.apiClient.users.getUserByName(TWITCH_CHANNEL);
                console.log('[emotes] helixUser:', helixUser, TWITCH_CHANNEL);
                const channelId = parseInt(helixUser.id);
                console.log('[emotes] channelId', channelId, TWITCH_CHANNEL);
                // try {
                //     await fetcher.fetchTwitchEmotes(channelId); // Twitch channel
                //     connections.channel_twitch = true;
                // } catch (err) {
                //     connections.channel_twitch = false;
                //     console.error('[emotes] twitch channel emotes error:', channel, err);
                // }
                try {
                    await fetcher.fetchBTTVEmotes(channelId); // BTTV channel
                    connections.channel_bttv = true;
                } catch (err) {
                    console.error('[emotes] bttv channel emotes error:', JSON.stringify(err));
                }
                try {
                    await fetcher.fetchSevenTVEmotes(channelId); // 7TV channel
                    connections.channel_7tv = true;
                } catch (err) {
                    console.error('[emotes] 7tv channel emotes error:', JSON.stringify(err));
                }
                try {
                    await fetcher.fetchFFZEmotes(channelId); // FFZ channel
                    connections.channel_ffz = true;
                } catch (err) {
                    console.error('[emotes] ffz channel emotes error:', JSON.stringify(err));
                }
            } catch (err) {
                console.error('[emotes] error getting channel emotes:', err);
            }

            const emote_lookup = await youtube_emotes();
            fetcher.emotes.forEach(emote => { emote_lookup[emote.code] = emote.toLink(); });
            emote_cache.emotes = emote_lookup;
            emote_cache.lastUpdated = + new Date();
            emote_cache.connections = connections;
            // console.log(emote_cache);
            console.log('[emotes] done updating emote cache');
        } catch (err) {
            console.error('[emotes] error:', err);
        }
    }
}

async function youtube_emotes() {
    //for now get them from this random page instead of from youtube itself
    // https://raw.githubusercontent.com/EthMC/EmoteJson/refs/heads/main/yt.json
    const filename = 'yt.json';
    const emote_lookup = {};
    try {
        JSON.parse(fs.readFileSync(filename).toString()).forEach(item => emote_lookup[item.code] = item.id);
    } catch (err) {
        console.error('error reading ' + filename);
    }
    return emote_lookup;

    // //the old way
    // const response = await fetch('https://emojis.wiki/youtube/');
    // const data = await response.text();

    // console.log(data.length);

    // const matches = Array.from(data.matchAll(/<img alt="(:[a-zA-Z0-9\-]*:) [^"]*" src="([^"]*)"\/>/g)); //<img alt=":yt: YouTube" src="https://cdn-0.emojis.wiki/uploads/2020/11/photo_2020-11-05_16-28-41.jpg"/>
    // const emote_lookup = {};
    // for (const match of matches) {
    //     emote_lookup[match[1]] = match[2];
    // }
    // return emote_lookup;
}

function find_3rd_party_emotes(msg) {
    update_emote_cache_if_needed(); //this update will run in the background and will not help for this time
    const emotes = {};
    let pos = 0;
    const emote_lookup = emote_cache.emotes ?? {};
    msg.split(' ').forEach(word => {
        // console.log(word, pos);
        const url = emote_lookup[word];
        if (url) {
            if (!emotes[url]) {
                emotes[url] = [];
            }
            const start = pos;
            const end = pos + word.length - 1;
            emotes[url].push(`${start}-${end}`);
        }
        pos += word.length + 1;
    });

    //look for youtube emotes that are not separated by spaces, for example in:
    //:tf: 123 abc:elbowcough:abc:elbowcough: 123
    const matches = Array.from(msg.matchAll(/:[a-zA-Z\-]+:/g));

    for (const match of matches) {
        const emote = match[0];
        const start = match.index;
        const end = start + emote.length - 1;
        const url = emote_lookup[emote];

        if (url) {
            // console.log(match, emote, start, end, url);
            if (!emotes[url]) {
                emotes[url] = []
            }
            const range = `${start}-${end}`;
            if (!emotes[url].includes(range)) { //make sure it was not already added
                emotes[url].push(range);
            }
        }
    }
    return emotes;
}

//after running for a bit, update all the emote caches. this will prevent spamming the API during testing
setTimeout(async () => { await update_emote_cache_if_needed(); }, EMOTE_STARTUP_DELAY);



//twitch chat stuff
let twitch_listener = undefined; //new tmi.client(...);

function disconnect_from_twitch() {
    if (twitch_listener !== undefined) {
        twitch_listener.disconnect();
        twitch_listener = undefined;
    }
}

async function connect_to_twitch() {
    if (!await get_channel_prop('enabled')) {
        console.log('[youtube] bot is disabled, will not connect');
        return;
    }
    if (twitch_listener !== undefined) {
        console.log('[twitch] already connected');
        return;
    }

    const tmi_client = new tmi.client({
        identity: {
            username: process.env.TWITCH_BOT_USERNAME,
            password: process.env.TWITCH_BOT_OAUTH_TOKEN
        },
        channels: [TWITCH_CHANNEL]
    });

    tmi_client.on('message', async (target, context, msg, self) => {
        console.log(`[twitch] TARGET: ${target} SELF: ${self} CONTEXT: ${JSON.stringify(context)}`);
        const username = context['display-name'];
        console.log(`[twitch] ${username}: ${msg}`);
        // const channel = target.replace('#', '');

        if (context['message-type'] === 'whisper') { //ignore whispers
            return;
        }

        if (!username) { //ignore messages with no username
            console.error('[twitch] no username in message:', JSON.stringify(context));
            return;
        }

        const nickname = await get_viewer_prop(username, 'nickname');

        //forward message to socket chat
        send_chat('twitch', username, nickname, context.color, msg, context.emotes, get_pronouns(username));

        if (self) { return; } // Ignore messages from the bot
        const [valid_command, should_reply] = await handle_command(context, msg, username);
        greetz(username, valid_command, should_reply);
    });
    tmi_client.on('connected', (addr, port) => console.log(`[twitch] connected to ${addr}:${port}`));
    // Connect to Twitch:
    tmi_client.connect().catch(error => console.error('[twitch] tmi connect error:', error));

    twitch_listener = tmi_client;
}

function twitch_try_say(message) {
    if (twitch_listener) {
        twitch_listener.say(TWITCH_CHANNEL, message).catch(error => console.error('[twitch] tmi say error:', error));
    }
}

function is_super_admin(username) {
    return username?.toLowerCase() === process.env.TWITCH_SUPER_ADMIN_USERNAME.toLowerCase();
}

function has_permission(context) {
    return is_super_admin(context?.username) || context?.badges?.broadcaster === '1' || context?.badges?.moderator === '1';
}

async function nickname_already_taken(nickname) {
    const viewers = await list_viewers();
    for (const username of viewers) {
        if (nickname === await get_viewer_prop(username, 'nickname')) {
            return true;
        }
    }
    return false;
}

add_viewer_prop_listener('nickname', (username, old_value, new_value) => {
    console.log('nickname', username, old_value, new_value);
    chat_history.forEach(msg => {
        if (msg.username === username) {
            msg.nickname = new_value;
        }
    });
});

async function handle_command(context, msg, username) {
    // Remove whitespace and 7TV bypass from chat message
    const command = msg.replaceAll(' 󠀀', '').trim();

    let valid = true;
    let should_reply = true;
    // If the command is known, let's execute it
    if (command === '!help' || command === '!commands') {
        twitch_try_say(`commands: !nick - set your nickname; !botpage - link to the page with nicknames and other info; !multichat - link to the combined chat; !clear - clear the multichat;`);
    } else if (command === '!botpage') {
        twitch_try_say(`see the nicknames and other bot info at ${process.env.BASE_URL}/${TWITCH_CHANNEL}`);
    } else if (command === '!multichat') {
        twitch_try_say(`see the multichat at ${process.env.BASE_URL}/${TWITCH_CHANNEL}/chat (change the font and show/hide options on the !botpage)`);
    } else if (command === '!clear') {
        if (has_permission(context)) {
            clear_chat();
            // update_emote_cache();
            should_reply = false;
        }
    } else if (command === '!nick') {
        const nickname = await get_viewer_prop(username, 'nickname');
        if (nickname) {
            await set_viewer_prop(username, 'nickname', undefined); //delete the nickname
            twitch_try_say(`@${username} removed nickname, sad to see you go`);
        } else {
            // twitch_try_say(`@${username} you already don't have a nickname`);
            twitch_try_say(`@${username} please provide a nickname`);
        }
        // } else if (command === '!setnickname') {
        //     const used_nicknames = Object.values(getViewerProperty('nickname'));
        //     console.log(used_nicknames);
        //     const remaining_random_nicknames = JSON.parse(JSON.stringify(RANDOM_NICKNAMES)).filter(nickname => !used_nicknames.includes(nickname));
        //     if (remaining_random_nicknames.length > 0) {
        //         const nickname = random_choice(remaining_random_nicknames);
        //         await setViewerProperty('nickname', username, nickname);
        //         send_nickname(username, nickname);
        //         update_chat_history(username, nickname);
        //         twitch_try_say(`@${username} no nickname provided, your random nickname is ${nickname}`);
        //     } else {
        //         twitch_try_say(`out of random nicknames to assign, please provide a nickname with the !setnickname command`);
        //     }
    } else if (command.startsWith('!nick ')) {
        const nickname = command.replace('!nick', '').trim();
        const max_nickname_length = await get_channel_prop('max_nickname_length');
        if (filter.isProfane(nickname)) {
            twitch_try_say(`@${username} no profanity allowed in nickname, use a different one or ask the streamer/admin to log in to the link at !botpage and set it for you`);
        } else if (await get_viewer_prop(username, 'nickname') === nickname) {
            twitch_try_say(`@${username} you already have that nickname`);
        } else if (nickname.length > max_nickname_length) {
            twitch_try_say(`@${username} nickname "${nickname}" is too long, must be ${max_nickname_length} letters`);
        } else if (await nickname_already_taken(nickname)) {
            twitch_try_say(`@${username} nickname "${nickname}" is already taken, see !botpage for the list`);
        } else {
            await set_viewer_prop(username, 'nickname', nickname);
            twitch_try_say(`@${username} set nickname to ${nickname}`);
        }
        // } else if (username.toLowerCase() !== 'nightbot' && command.toLowerCase().includes(`@${process.env.TWITCH_BOT_USERNAME}`.toLowerCase())) {
        //     const message = command
        //         .replaceAll(` @${process.env.TWITCH_BOT_USERNAME} `, '')
        //         .replaceAll(` @${process.env.TWITCH_BOT_USERNAME} `.toLowerCase(), '')
        //         .replaceAll(` @${process.env.TWITCH_BOT_USERNAME}`, '')
        //         .replaceAll(` @${process.env.TWITCH_BOT_USERNAME}`.toLowerCase(), '')
        //         .replaceAll(`@${process.env.TWITCH_BOT_USERNAME} `, '')
        //         .replaceAll(`@${process.env.TWITCH_BOT_USERNAME} `.toLowerCase(), '')
        //         .replaceAll(`@${process.env.TWITCH_BOT_USERNAME}`, '')
        //         .replaceAll(`@${process.env.TWITCH_BOT_USERNAME}`.toLowerCase(), '');
        //     console.log(`[bot] asking CARL: ${message}`);
        //     let url = 'https://games.jjv.sh/carl_api?user=' + encodeURIComponent(message);
        //     const reply_parent = context['reply-parent-msg-body'];
        //     if (reply_parent) {
        //         const carl_said = carl_history[reply_parent];
        //         if (carl_said) {
        //             url = 'https://games.jjv.sh/carl_api?carl=' + encodeURIComponent(carl_said) + '&user=' + encodeURIComponent(message);
        //             console.log(`[bot] found reply parent in carl_history: "${reply_parent}" => "${carl_said}"`);
        //         }
        //     }
        //     const response = await fetch(url);
        //     const data = await response.text();
        //     if (response.status === 200) {
        //         console.log('[bot] CARL:', data);
        //         let display_data = data;
        //         if (data.includes('CARL') || data.includes('Carl') || data.includes('carl')) {
        //             const nickname = await getViewerProperty('nickname', username);
        //             display_data = data.replaceAll('CARL', nickname).replaceAll('Carl', nickname).replaceAll('carl', nickname);
        //             console.log('[bot] CARL (edited): ', display_data);
        //         }
        //         let save_to_history = true;
        //         if (filter.isProfane(display_data) || display_data.toLowerCase().includes('stupid') || display_data.toLowerCase().includes('stoopid') || display_data.toLowerCase().includes('dumb') || display_data.toLowerCase().includes('idiot')) {
        //             display_data = `<3`;
        //             save_to_history = false;
        //         }
        //         const reply = `@${username} ${display_data}`
        //         twitch_try_say(reply);
        //         if (save_to_history) {
        //             carl_history[reply] = data;
        //             console.log(`[bot] saved to carl_history: "${reply}" => "${data}"`);
        //         } else {
        //             console.log(`[bot] not saving to carl_history: "${reply}" => "${data}"`);
        //         }
        //     } else {
        //         console.log('[bot] error', response.status, data);
        //         twitch_try_say(`@${username} hey <3`);
        //     }
        //     should_reply = false;
    } else {
        valid = false;
    }
    console.log('[bot] valid:', valid, 'should_reply:', should_reply, 'command:', command);
    return [valid, should_reply];
}

const last_seens = {
    // 'JJBotBot': 123456, //chatter -> last seen timestamp
    // 'JJVanVan': 123456,
};

async function greetz(username, valid_command, should_reply) {
    const nickname = await get_viewer_prop(username, 'nickname');
    //keep track of when the last message was
    if (username.toLowerCase() !== process.env.TWITCH_BOT_USERNAME.toLowerCase()) {
        if (nickname !== undefined) {
            if (should_reply) {
                const last_seen = last_seens[username];
                const now = + new Date();
                console.log('[greetz]', username, now - last_seen);
                if (last_seen === undefined || now - last_seen > await get_channel_prop('greetz_threshold')) {
                    if (valid_command) { //if the user was running a command, wait a few seconds, then greet them, but with an "also" added
                        console.log('[greetz] user has been away a long time, but issued a command, so sending initial greeting in a few seconds');
                        setTimeout(async () => {
                            twitch_try_say(await parse_greetz(GREETZ_ALSO, username));
                        }, GREETZ_DELAY_FOR_COMMAND);
                    } else {
                        console.log('[greetz] user has been away a long time, sending initial greeting');
                        twitch_try_say(await parse_greetz(GREETZ, username));
                    }
                } else if (last_seen === undefined || now - last_seen > await get_channel_prop('greetz_wb_threshold')) {
                    if (valid_command) { //if the user was running a command, wait a few seconds, then greet them, but with an "also" added
                        console.log('[greetz] user has been away a short time, but issued a command, so sending welcome back greeting in a few seconds');
                        setTimeout(async () => {
                            twitch_try_say(await parse_greetz(GREETZ_WELCOME_BACK_ALSO, username));
                        }, GREETZ_DELAY_FOR_COMMAND);
                    } else {
                        console.log('[greetz] user has been away a short time, sending welcome back greeting');
                        twitch_try_say(await parse_greetz(GREETZ_WELCOME_BACK, username));
                    }
                }
            }
            last_seens[username] = + new Date();
            console.log('last_seens', last_seens);
        }
    }
}

function random_choice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

async function parse_greetz(stock_greetz_array, username) {
    const nickname = await get_viewer_prop(username, 'nickname');
    const custom_greetz = await get_viewer_prop(username, 'custom_greetz');
    let message;
    if (custom_greetz) {
        message = custom_greetz;
    } else {
        message = random_choice(stock_greetz_array);
    }
    // return '@' + username + ' ' + message.replaceAll('#', nickname);
    return message.replaceAll('@', '@' + username).replaceAll('#', nickname);
    // return '@' + username + ' ' + message.replaceAll('@', '@' + username).replaceAll('#', nickname);
}

function reconnect_to_twitch() {
    disconnect_from_twitch();
    connect_to_twitch();
}

(async () => {
    connect_to_twitch();
})();


//youtube chat stuff
function searchAllJSON(json, key) {
    let results = [];
    function recursiveSearch(obj) {
        if (obj.hasOwnProperty(key)) {
            results.push(obj[key]);
        }
        for (let k in obj) {
            if (obj[k] && typeof obj[k] === 'object') {
                recursiveSearch(obj[k]);
            }
        }
    }
    recursiveSearch(json);
    return results;
}

async function getYtInitialData(youtube_id, sub_url = '') {
    const url = `https://www.youtube.com/channel/${youtube_id}/${sub_url}`;
    const data = await (await fetch(url)).text(); // the entire webpage text
    return JSON.parse(data.match(/var ytInitialData = ([^;]*);/)[1]); //match the var definition then parse the json of it's contents
}

async function getYoutubeLiveVideoIds(youtube_id) {
    const data = await getYtInitialData(youtube_id, 'streams');
    const live_vids = [];
    searchAllJSON(data, 'videoRenderer').forEach(videoData => {
        for (const i in (videoData.thumbnailOverlays ?? [])) {
            if (videoData.thumbnailOverlays[i].thumbnailOverlayTimeStatusRenderer?.style == 'LIVE') {
                live_vids.push(videoData.videoId);
            }
        }
    });
    return live_vids;
}

async function getYoutubeLiveVideoId(youtube_id) {
    try {
        // return (await fetchLivePage({ channelId: youtube_id })).liveId; // the "youtube-chat" node module's "fetchLivePage" is broken so i wrote my own
        return (await getYoutubeLiveVideoIds(youtube_id))[0];
    } catch (error) {
        // console.error(error);
        return undefined;
    }
}

let youtube_listener = undefined; //await Masterchat.init('IKRQQAMYnrM'), //will be undefined if not connected

function disconnect_from_youtube() {
    if (youtube_listener !== undefined) {
        youtube_listener.stop();
        youtube_listener = undefined;
    }
}

async function connect_to_youtube() {
    if (!await get_channel_prop('enabled')) {
        console.log('[youtube] bot is disabled, will not connect');
        return;
    }
    if (youtube_listener !== undefined) {
        console.log('[youtube] already connected');
        return;
    }
    const youtube_id = await get_channel_prop('youtube_id');
    if (!youtube_id) {
        console.error('[youtube] no youtube channel id associated with twitch channel');
        return;
    }

    const liveVideoId = await getYoutubeLiveVideoId(youtube_id);
    console.log(`[youtube] youtube_id: ${youtube_id} liveVideoId: ${liveVideoId}`);
    if (liveVideoId === undefined) {
        console.error('[youtube] falied to find livestream');
        return;
    }
    console.log(`[youtube] connected to youtube chat: youtu.be/${liveVideoId}`);
    //delay the message a bit to allow the disconnect message to come thru first
    setTimeout(() => twitch_try_say(`connected to youtube chat: youtu.be/${liveVideoId}`), TWITCH_MESSAGE_DELAY);

    const mc = await Masterchat.init(liveVideoId);
    // Listen for live chat
    mc.on('chat', async (chat) => {
        const timestamp = new Date(chat.timestamp);
        const now = new Date();
        const message_age = now - timestamp;
        // console.log(message_age);
        if (message_age <= YOUTUBE_MAX_MESSAGE_AGE) {
            const author = chat.authorName;
            const message = stringify(chat.message);
            console.log(`[youtube] ${author}: ${message}`);
            if (message !== undefined) {
                send_chat('youtube', author, undefined, undefined, message, undefined, undefined);
                const fwd_cmds_yt_twitch = await get_channel_prop('fwd_cmds_yt_twitch');
                fwd_cmds_yt_twitch.forEach(command => {
                    if (message.startsWith(command)) {
                        twitch_try_say(filter.clean(message));
                    }
                });

                // twitch_try_say(`[youtube] ${author}: ${message}`);
                // handle_command(message);
            }
        }
    });

    // Listen for any events
    //   See below for a list of available action types
    mc.on('actions', (actions) => {
        const chats = actions.filter(
            (action) => action.type === 'addChatItemAction'
        );
        const superChats = actions.filter(
            (action) => action.type === 'addSuperChatItemAction'
        );
        const superStickers = actions.filter(
            (action) => action.type === 'addSuperStickerItemAction'
        );
        // ...
    });

    // Handle errors
    mc.on('error', (err) => {
        console.log(`[youtube] ${err.code}`);
        // 'disabled' => Live chat is disabled
        // 'membersOnly' => No permission (members-only)
        // 'private' => No permission (private video)
        // 'unavailable' => Deleted OR wrong video id
        // 'unarchived' => Live stream recording is not available
        // 'denied' => Access denied (429)
        // 'invalid' => Invalid request
    });

    // Handle end event
    mc.on('end', () => {
        console.log(`[youtube] live stream has ended or chat was disconnected`);
        youtube_listener = undefined;
        twitch_try_say(`disconnected from youtube chat`);
    });

    // Start polling live chat API
    mc.listen();

    youtube_listener = mc;
}

function reconnect_to_youtube() {
    disconnect_from_youtube();
    connect_to_youtube();
}

//attempt to disconnect and reconnect to youtube chat when youtube_id changes
add_channel_prop_listener('youtube_id', reconnect_to_youtube);

//periodically attempt to connect to youtube chat
setInterval(connect_to_youtube, YOUTUBE_CHECK_FOR_LIVESTREAM_INTERVAL);



//owncast chat stuff
let owncast_listener = undefined;

async function disconnect_from_owncast() {
    if (owncast_listener !== undefined) {
        owncast_listener.close();
        owncast_listener = undefined;
    }
}

async function connect_to_owncast() {
    if (!await get_channel_prop('enabled')) {
        console.log('[owncast] bot is disabled, will not connect');
        return;
    }
    if (owncast_listener !== undefined) {
        console.log('[owncast] already connected');
        return;
    }
    const owncast_url = await get_channel_prop('owncast_url');
    if (!owncast_url) {
        console.error('[owncast] no owncast url associated with twitch channel');
        return;
    }

    const on_message_received = (message) => {
        //message received
        console.log('[owncast] Received:', JSON.stringify(message));
        //user joins:
        //Received: {"id":"dZl60kLng","timestamp":"2022-02-27T23:37:24.330263605Z","type":"USER_JOINED","user":{"id":"_R_eAkL7g","displayName":"priceless-roentgen2","displayColor":123,"createdAt":"2022-02-27T23:37:24.250217566Z","previousNames":["priceless-roentgen2"]}}
        //message:
        // Received: {"body":"hello world","id":"En3e0kY7g","timestamp":"2022-02-27T23:37:28.502353829Z","type":"CHAT","user":{"id":"_R_eAkL7g","displayName":"priceless-roentgen2","displayColor":123,"createdAt":"2022-02-27T23:37:24.250217566Z","previousNames":["priceless-roentgen2"]},"visible":true}
        // Received: {"body":"<p>Johan :tux:  liked that this stream went live.</p>\n","id":"uep4JgKIg","image":"https://cdn.fosstodon.org/accounts/avatars/000/002/248/original/e68dc0e84d281224.png","link":"https://fosstodon.org/users/johanv","timestamp":"2023-12-30T16:29:25.371196748Z","title":"johanv@fosstodon.org","type":"FEDIVERSE_ENGAGEMENT_LIKE","user":{"displayName":"jjv.sh"}}
        //simplified: {"body": "hello world", "user": {"displayName": "priceless-roentgen"}}
        if ('body' in message && 'user' in message && 'displayName' in message.user) {
            const name = message.user.displayName;
            let text = message.body;
            let emotes = undefined;
            let color = `hsla(${message.user.displayColor}, 100%, 60%, 0.85)`;
            if (message.user.displayColor === undefined) {
                color = 'rgb(255, 255, 255)';
            }
            if (message.type !== 'CHAT') {
                text = text.replace('<p>', '').replace('</p>', '').replace('\n', ' ');
            }
            if (message.type === 'FEDIVERSE_ENGAGEMENT_LIKE') {
                // text += '(' + message.title + ' ';
                // const start = text.length;
                // text += message.image
                // const end = text.length - 1;
                // text += ' )';
                text = `${message.title} ${message.image} ${text}`
                const start = text.indexOf(message.image);
                const end = start + message.image.length - 1;
                emotes = { [message.image]: [`${start}-${end}`] };
            }
            send_chat('owncast', name, undefined, color, text, emotes, undefined);
        }
    }

    try {
        const res = await fetch('https://' + owncast_url + '/api/chat/register', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 'displayName': DEFAULT_BOT_NICKNAME }), // process.env.TWITCH_BOT_USERNAME
        });

        const res_json = await res.json();

        console.log('[owncast] Status:', res.status);
        console.log('[owncast] JSON:', res_json);

        var token = res_json.accessToken;

        var client = new WebSocketClient();

        client.on('connectFailed', function (error) {
            console.log('[owncast] Connect Error: ' + error.toString());
            disconnect_from_owncast();
        });

        client.on('connect', function (connection) {
            console.log('[owncast] WebSocket Client Connected');
            connection.on('error', function (error) {
                console.log('[owncast] Connection Error: ' + error.toString());
                disconnect_from_owncast();
            });
            connection.on('close', function () {
                console.log(`[owncast] disconnected from owncast chat: https://${owncast_url}`);
                twitch_try_say(`disconnected from owncast chat: https://${owncast_url}`);
                disconnect_from_owncast();
            });
            connection.on('message', function (message) {
                if (message.type === 'utf8') {
                    // console.log("Received: '" + message.utf8Data + "'");

                    //multiple json objects can be sent in the same message, separated by newlines
                    message.utf8Data.split('\n').forEach(text => on_message_received(JSON.parse(text)));
                    // on_message_received({ "body": "<p>Johan :tux:  liked that this stream went live.</p>\n", "id": "uep4JgKIg", "image": "https://cdn.fosstodon.org/accounts/avatars/000/002/248/original/e68dc0e84d281224.png", "link": "https://fosstodon.org/users/johanv", "timestamp": "2023-12-30T16:29:25.371196748Z", "title": "johanv@fosstodon.org", "type": "FEDIVERSE_ENGAGEMENT_LIKE", "user": { "displayName": "jjv.sh" } });
                }
            });

            owncast_listener = connection;
            console.log(`[owncast] connected to owncast chat: https://${owncast_url}`);
            //delay the message a bit to allow the disconnect message to come thru first
            setTimeout(() => twitch_try_say(`connected to owncast chat: https://${owncast_url}`), TWITCH_MESSAGE_DELAY);
        });

        client.connect('wss://' + owncast_url + '/ws?accessToken=' + token);
    } catch (err) {
        console.error('[owncast] error: ' + err);
        disconnect_from_owncast();
    }
    return '';
}

function reconnect_to_owncast() {
    disconnect_from_owncast();
    connect_to_owncast();
}

//attempt to disconnect and reconnect to owncast chat when owncast_url changes
add_channel_prop_listener('owncast_url', reconnect_to_owncast);

//periodically attempt to connect to owncast chat
setInterval(connect_to_owncast, OWNCAST_CHECK_FOR_LIVESTREAM_INTERVAL);


//kick chat stuff
let kick_listener = undefined;

function disconnect_from_kick() {
    if (kick_listener !== undefined) {
        kick_listener._wsClient.pusher.disconnect();
        kick_listener = undefined;
    }
}

async function connect_to_kick() {
    if (!await get_channel_prop('enabled')) {
        console.log('[kick] bot is disabled, will not connect');
        return;
    }
    if (kick_listener !== undefined) {
        console.log('[kick] already connected');
        return;
    }
    const kick_chatroom_id = await get_channel_prop('kick_chatroom_id');
    if (!kick_chatroom_id) {
        console.error('[kick] no kick username associated with twitch channel');
        return 'no url';
    }

    const on_message_received = (message) => {
        const messagedata = message.data;
        console.log(`[kick] ${JSON.stringify(messagedata)}`);
        const username = messagedata.sender.username;
        const color = messagedata.sender.identity.color;
        const content = messagedata.content;
        //forward message to socket chat
        send_chat('kick', username, undefined, color, content, undefined, undefined);
    }

    try {
        const kick_client = await Kient.create();
        // const kick_channel = await kick_client.api.channel.getChannel(kick_chatroom_id);
        await kick_client.ws.chatroom.listen(kick_chatroom_id);

        kick_client.on(Events.Chatroom.Message, on_message_received);

        kick_client.on(Events.Core.WebSocketDisconnected, (err) => {
            console.log('[kick] disconnected', kick_chatroom_id, err);
            disconnect_from_kick();
        });

        kick_listener = kick_client;
        console.log('[kick] connected to chat', kick_chatroom_id);
    } catch (err) {
        console.error('[kick] error', kick_chatroom_id, err);
        disconnect_from_kick();
    }
    return;
}

function reconnect_to_kick() {
    disconnect_from_kick();
    connect_to_kick();
}

//attempt to disconnect and reconnect to kick chat when kick_chatroom_id changes
add_channel_prop_listener('kick_chatroom_id', reconnect_to_kick);

//periodically attempt to connect to kick chat
setInterval(connect_to_kick, KICK_CHECK_FOR_LIVESTREAM_INTERVAL);


add_channel_prop_listener('enabled', async (old_value, new_value) => {
    console.log('enabled', old_value, new_value);
    reconnect_to_youtube();
    reconnect_to_owncast();
    reconnect_to_kick();
    reconnect_to_twitch();
});



app.use((req, res) => {
    const now = + new Date();
    console.log('[tenant] 404', now, 'channel:', TWITCH_CHANNEL, 'req.originalUrl:', req.originalUrl);
    res.status(404).send(`<h1>404 - Not Found</h1>
<p>The requested URL was not found on this server.</p>
<p><a href="/${TWITCH_CHANNEL}">back to channel page</a></p>
<p>[tenant] timestamp: ${now}</p>`);
});

//start the http server
server.listen(process.env.PORT ?? 80, () => {
    console.log('listening on *:' + (process.env.PORT ?? 80));
});
