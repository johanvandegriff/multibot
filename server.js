const DEFAULT_PORT = 8080;
const JSON_DB_FILE = '/srv/data.json';
const SECRETS_FILE = '/srv/secret.env';
const CHAT_HISTORY_LENGTH = 100;
const chat_history = {};
const carl_history = {};
const HOUR_IN_MILLISECONDS = 1 * 60 * 60 * 1000;
const DEFAULT_CHANNEL_PROPERTIES = {
    'enabled': false,
    'fwd_cmds_yt_twitch': ['!sr', '!test'],
    'youtube_id': '',
    'max_nickname_length': 20,
    'greetz_threshold': 5 * HOUR_IN_MILLISECONDS,
    'greetz_wb_threshold': 0.75 * HOUR_IN_MILLISECONDS,
    'custom_greetz': {},
    'nickname': {},
}
const DEFAULT_VIEWER_PROPERTIES = {
    'custom_greetz': '',
    'last_seen': undefined,
}
const DEFAULT_BOT_NICKNAME = '🤖';
const YOUTUBE_MAX_MESSAGE_AGE = 10 * 1000; //10 seconds
const YOUTUBE_CHECK_FOR_LIVESTREAM_INTERVAL = 1 * 60 * 1000; //1 minute
const OWNCAST_CHECK_FOR_LIVESTREAM_INTERVAL = 1 * 60 * 1000; //1 minute
const EMOTE_STARTUP_DELAY = 2 * 60 * 1000; //2 minutes
const EMOTE_CACHE_TIME = 1 * 60 * 60 * 1000; //1 hour
const EMOTE_RETRY_TIME = 30 * 1000; //30 seconds
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

const http = require('http');
const https = require('https');
const WebSocketClient = require('websocket').client;
const dotenv = require('dotenv'); //for storing secrets in an env file
const tmi = require('tmi.js'); //twitch chat https://dev.twitch.tv/docs/irc
const { EmoteFetcher } = require('@mkody/twitch-emoticons');
const { fetchLivePage } = require("./node_modules/youtube-chat/dist/requests"); //get youtube live url by channel id https://github.com/LinaTsukusu/youtube-chat
const { Masterchat, stringify } = require("masterchat"); //youtube chat https://github.com/sigvt/masterchat
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const OAuth2Strategy = require('passport-oauth').OAuth2Strategy;
const request = require('request');
const handlebars = require('handlebars');
 const { JsonDB, Config } = require('node-json-db');
const bodyParser = require('body-parser')
// var Filter = require('bad-words'),
// filter = new Filter();
var filter = require('profanity-filter');
filter.seed('profanity');
filter.isProfane = (s) => s !== filter.clean(s);

const RANDOM_NICKNAMES_FILE = '/srv/random-nicknames.txt';
const RANDOM_NICKNAMES = [];

try {
    fs.readFileSync(RANDOM_NICKNAMES_FILE).toString().split("\n").forEach(line => {
        if (line !== '') {
            // console.log(line);
            RANDOM_NICKNAMES.push(line);
        }
    });
    console.log(`loaded ${RANDOM_NICKNAMES.length} random nicknames`)
} catch (err) {
    console.error('error reading ' + RANDOM_NICKNAMES_FILE);
}

dotenv.config({ path: SECRETS_FILE }) //bot API key and other info
const CALLBACK_URL = process.env.BASE_URL + '/auth/twitch/callback';

//credit to https://github.com/twitchdev/authentication-node-sample (apache 2.0 license) for the auth code
// Initialize Express and middlewares
const app = express();
const jsonParser = bodyParser.json()
const server = http.createServer(app);
const io = require('socket.io')(server);
app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
app.use(express.static('public'));
app.use(passport.initialize());
app.use(passport.session());

// Override passport profile function to get user profile from Twitch API
OAuth2Strategy.prototype.userProfile = function (accessToken, done) {
    const options = {
        url: 'https://api.twitch.tv/helix/users',
        method: 'GET',
        headers: {
            'Client-ID': process.env.TWITCH_CLIENT_ID,
            'Accept': 'application/vnd.twitchtv.v5+json',
            'Authorization': 'Bearer ' + accessToken
        }
    };

    request(options, function (error, response, body) {
        if (response && response.statusCode == 200) {
            done(null, JSON.parse(body));
        } else {
            done(JSON.parse(body));
        }
    });
}

passport.serializeUser(function (user, done) {
    done(null, user);
});

passport.deserializeUser(function (user, done) {
    done(null, user);
});


passport.use('twitch', new OAuth2Strategy({
    authorizationURL: 'https://id.twitch.tv/oauth2/authorize',
    tokenURL: 'https://id.twitch.tv/oauth2/token',
    clientID: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_SECRET,
    callbackURL: CALLBACK_URL,
    state: true
},
    function (accessToken, refreshToken, profile, done) {
        console.log(profile);

        const user = {};
        user.accessToken = accessToken;
        user.refreshToken = refreshToken;
        user.id = profile.data[0].id;
        user.login = profile.data[0].login;
        user.display_name = profile.data[0].display_name;
        user.profile_image_url = profile.data[0].profile_image_url;
        user.created_at = profile.data[0].created_at;
        user.is_super_admin = is_super_admin(user.login);
        console.log(`[twitch] user "${user.login}" logged in to the web interface with twitch`);
        // console.log(user);
        done(null, user);
    }
));

// Set route to start OAuth link, this is where you define scopes to request
app.get('/auth/twitch', passport.authenticate('twitch', { scope: ['user_read'] }));

// Set route for OAuth redirect
app.get('/auth/twitch/callback', passport.authenticate('twitch', { successRedirect: '/', failureRedirect: '/' }));

// Define a simple template to safely generate HTML with values from user's profile
const template = handlebars.compile(fs.readFileSync('index.html', 'utf8'));

// If user has an authenticated session, display it, otherwise display link to authenticate
app.get('/', function (req, res) { res.send(template({ channel: '', user: req.session?.passport?.user })); });
app.get('/chat', (req, res) => { res.send(template({ is_chat_fullscreen: true, channel: req.query.channel, bgcolor: req.query.bgcolor || 'transparent', show_usernames: req.query.show_usernames, show_nicknames: req.query.show_nicknames })) });

app.get('/logout', function (req, res, next) {
    req.logout(function (err) {
        if (err) { return next(err); }
        res.redirect('/' + (req.query.returnTo || ''));
    });
});

//expose js libraries to client so they can run in the browser
app.get('/vue.js', (req, res) => { res.sendFile(__dirname + '/node_modules/vue/dist/vue.global.prod.js') });
app.get('/color-hash.js', (req, res) => { res.sendFile(__dirname + '/node_modules/color-hash/dist/color-hash.js') });
app.use('/tmi-utils', express.static(__dirname + '/node_modules/tmi-utils/dist/esm', { 'extensions': ['js'] })); //add .js if not specified
app.get('/favicon.ico', (req, res) => { res.sendFile(__dirname + '/favicon.ico') });
app.get('/favicon.png', (req, res) => { res.sendFile(__dirname + '/favicon.png') });

//expose the static dir
app.use('/static', express.static('static'));

//expose the list of channels
app.get('/channels', async (req, res) => { res.send(JSON.stringify({ channels: await getEnabledChannels(), all_channels: await getChannels() })) });
app.get('/chat_history', async (req, res) => { res.send(JSON.stringify(chat_history[req.query.channel] || [])) });

function channel_auth_middleware(req, res, next) {
    const login = req.session?.passport?.user?.login;
    if (login === req.body.channel || is_super_admin(login)) {
        console.log('auth success', req.body, login, is_super_admin(login));
        next();
    } else {
        console.error('access denied', req.body);
        res.status(403).end(); //403 Forbidden
    }
}

function better_typeof(data) {
    if (data?.constructor === Array) return 'Array';
    if (data?.constructor === Object) return 'Object';
    return typeof (data); //for example, 'string', 'number', 'undefined', etc.
}

function validate_middleware(param_name, param_types, validator = undefined) {
    if (better_typeof(param_types) !== 'Array') {
        param_types = [param_types];
    }
    return (req, res, next) => {
        const data = req.body[param_name];
        if (param_types.includes(better_typeof(data))) {
            if (!validator || validator(data)) {
                next();
            } else {
                console.error('invalid data, failed validator:', data);
                res.status(400).send('invalid data, failed validator'); //400 Bad Request
            }
        } else {
            console.error('invalid data, expected ' + param_types + ' but got:', data);
            res.status(400).send('invalid data, expected ' + param_types); //400 Bad Request
        }
    }
}

const enabled_timeouts = {
    // 'channel': new Date(),
};
app.post('/enabled', jsonParser, channel_auth_middleware, validate_middleware('enabled', 'boolean'), async (req, res) => {
    const channel = req.body.channel;
    const enabled = req.body.enabled;
    const now = new Date();
    //only allow enabling/disabling every 5 seconds
    if (!enabled_timeouts[channel] || now - enabled_timeouts[channel] > ENABLED_COOLDOWN) {
        enabled_timeouts[channel] = now;
        const old_enabled = await getChannelProperty(channel, 'enabled');
        if (old_enabled !== enabled) {
            await setChannelProperty(channel, 'enabled', enabled);
            if (enabled) {
                if (!await getViewerProperty(channel, 'nickname', process.env.TWITCH_BOT_USERNAME)) {
                    await setViewerProperty(channel, 'nickname', process.env.TWITCH_BOT_USERNAME, DEFAULT_BOT_NICKNAME);
                    send_nickname(channel, process.env.TWITCH_BOT_USERNAME, DEFAULT_BOT_NICKNAME);
                }
                connect_to_youtube(channel);
            } else {
                disconnect_from_youtube(channel);
            }
            connectToTwitchChat();
            send_global_event({ channel: channel, enabled: enabled });
        }
        res.end();
    } else {
        res.send('wait');
    }
});

function add_api_channel_property(property_name, property_types, validator = undefined) {
    app.get('/' + property_name, async (req, res) => { res.send(JSON.stringify(await getChannelProperty(req.query.channel, property_name))) });
    app.post('/' + property_name, jsonParser, channel_auth_middleware, validate_middleware(property_name, property_types, validator), async (req, res) => {
        const channel = req.body.channel;
        const property_value = req.body[property_name];
        await setChannelProperty(channel, property_name, property_value);
        send_event(channel, { [property_name]: property_value });
        res.end();
    });
}

add_api_channel_property('max_nickname_length', 'number', validator = x => x > 0);
add_api_channel_property('fwd_cmds_yt_twitch', 'Array');
add_api_channel_property('greetz_threshold', 'number');
add_api_channel_property('greetz_wb_threshold', 'number');

function add_api_viewer_property(property_name, property_types, validator = undefined) {
    app.get('/' + property_name, async (req, res) => { res.send(JSON.stringify(await getViewerProperty(req.query.channel, property_name, req.query.username))) });
    app.post('/' + property_name, jsonParser, channel_auth_middleware, validate_middleware(property_name, property_types, validator), async (req, res) => {
        const channel = req.body.channel;
        const username = req.body.username;
        const property_value = req.body[property_name];
        await setViewerProperty(channel, property_name, username, property_value);
        send_event(channel, { username: username, [property_name]: property_value });
        res.end();
    });
}

add_api_viewer_property('custom_greetz', 'string');

app.get('/nickname', async (req, res) => { res.send(JSON.stringify(await getViewerProperty(req.query.channel, 'nickname', req.query.username))) });
app.post('/nickname', jsonParser, channel_auth_middleware, validate_middleware('nickname', ['string', 'undefined']), async (req, res) => {
    const channel = req.body.channel;
    const username = req.body.username;
    const nickname = req.body.nickname;
    const caller_display_name = req.session.passport.user.display_name;

    await setViewerProperty(channel, 'nickname', username, nickname);
    send_nickname(channel, username, nickname);
    if (nickname) {
        twitch_try_say(channel, `admin ${caller_display_name} set ${username} 's nickname to ${nickname}`);
    } else {
        await setViewerProperty(channel, 'custom_greetz', username, undefined);
        twitch_try_say(channel, `admin ${caller_display_name} removed ${username} 's nickname`);
    }
    updateChatHistory(channel);
    res.end();
});

app.get('/youtube_id', async (req, res) => { res.send(await getChannelProperty(req.query.channel, 'youtube_id')) });
app.post('/youtube_id', jsonParser, channel_auth_middleware, validate_middleware('youtube_id', 'string'), async (req, res) => {
    const channel = req.body.channel;
    const youtube_id = req.body.youtube_id;
    const old_youtube_id = await getChannelProperty(channel, 'youtube_id');
    if (old_youtube_id !== youtube_id) {
        await setChannelProperty(channel, 'youtube_id', youtube_id);
        connect_to_youtube(channel);
    }
    res.end();
});
app.get('/youtube_status', async (req, res) => { res.send(youtube_chats[req.query.channel] || {}) });

app.get('/owncast_url', async (req, res) => { res.send(await getChannelProperty(req.query.channel, 'owncast_url')) });
app.post('/owncast_url', jsonParser, channel_auth_middleware, validate_middleware('owncast_url', 'string'), async (req, res) => {
    const channel = req.body.channel;
    const owncast_url = req.body.owncast_url;
    const old_owncast_url = await getChannelProperty(channel, 'owncast_url');
    if (old_owncast_url !== owncast_url) {
        await setChannelProperty(channel, 'owncast_url', owncast_url);
        connect_to_owncast(channel);
    }
    res.end();
});
app.get('/owncast_status', async (req, res) => { res.send(owncast_chats[req.query.channel] || {}) });
app.get('/emotes_status', async (req, res) => {
    const emote_cache_copy = JSON.parse(JSON.stringify(emote_cache[req.query.channel] || {}));
    delete emote_cache_copy.emotes;
    res.send(emote_cache_copy);
});
app.post('/clear_chat', jsonParser, channel_auth_middleware, async (req, res) => {
    const channel = req.body.channel;
    clear_chat(channel);
    update_emote_cache(channel);
    res.end();
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
        //https://www.youtube.com/@jjvan
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

// The first argument is the database filename. If no extension is used, '.json' is assumed and automatically added.
// The second argument is used to tell the DB to save after each push
// If you set the second argument to false, you'll have to call the save() method.
// The third argument is used to ask JsonDB to save the database in a human readable format. (default false)
// The last argument is the separator. By default it's slash (/)
 const db = new JsonDB(new Config(JSON_DB_FILE, true, true, '/'));

async function getChannels() {
    try {
        const channels = await db.getData('/channels/');
        return Object.keys(channels);
    } catch (error) {
        return [];
    }
}
async function getEnabledChannels() {
    try {
        const channels = await db.getData('/channels/');
        return Object.keys(channels).filter(k => channels[k].enabled);
    } catch (error) {
        return [];
    }
}

async function getChannelProperty(channel, property_name) {
    try {
        return await db.getData('/channels/' + channel + '/' + property_name);
    } catch (error) {
        return DEFAULT_CHANNEL_PROPERTIES[property_name];
    }
}
async function setChannelProperty(channel, property_name, property_value) {
    return await db.push('/channels/' + channel + '/' + property_name, property_value);
}


async function getViewerProperty(channel, property_name, username) {
    if (username) {
        try {
            return await db.getData('/channels/' + channel + '/' + property_name + '/' + username);
        } catch (error) {
            return DEFAULT_VIEWER_PROPERTIES[property_name];
        }
    } else {
        return await getChannelProperty(channel, property_name);
    }
}
async function setViewerProperty(channel, property_name, username, property_value) {
    if (property_value) {
        await db.push('/channels/' + channel + '/' + property_name + '/' + username, property_value);
    } else {
        await db.delete('/channels/' + channel + '/' + property_name + '/' + username);
    }
}


function random_choice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

async function parse_greetz(stock_greetz_array, channel, username) {
    const nickname = await getViewerProperty(channel, 'nickname', username);
    const custom_greetz = await getViewerProperty(channel, 'custom_greetz', username);
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


//use socket.io to make a simple live chatroom
io.on('connection', (socket) => {
    console.log('[socket.io] a user connected');
    socket.on('disconnect', () => {
        console.log('[socket.io] a user disconnected');
    });

    //when client sends an 'init' message
    socket.on('init', async (msg) => {
        const channel = msg.channel;
        console.log(`[socket.io] INIT ${channel}`);
    });
});

function send_chat(channel, username, nickname, color, text, emotes) {
    if (!emotes) {
        emotes = {};
    }
    try {
        const emotes_3rd_party = find_3rd_party_emotes(channel, text);
        emotes = Object.assign(emotes_3rd_party, emotes); //put the original emotes last so they don't get overwritten
    } catch (err) {
        console.error('[emotes] error finding 3rd party emotes:', channel, text, err);
    }
    const iomsg = { username: username, nickname: nickname, color: color, emotes: emotes, text: text };
    if (!chat_history[channel]) {
        chat_history[channel] = [];
    }
    chat_history[channel].push(iomsg);
    if (chat_history[channel].length > CHAT_HISTORY_LENGTH) {
        chat_history[channel].shift();
    }
    console.log(`[socket.io] SEND CHAT [${channel}] ${username} (nickname: ${nickname} color: ${color} emotes: ${JSON.stringify(emotes)}): ${text}`);
    io.emit(channel + '/chat', iomsg);
}

function send_nickname(channel, username, nickname) {
    console.log(`[socket.io] SEND NICKNAME [${channel}] ${nickname} = ${username}`);
    io.emit(channel + '/nickname', { username: username, nickname: nickname });
}

function send_event(channel, msg) {
    console.log(`[socket.io] SEND EVENT [${channel}]`, msg);
    io.emit(channel + '/event', msg);
}

function send_global_event(msg) {
    console.log(`[socket.io] SEND GLOBAL EVENT`, msg);
    io.emit('global_event', msg);
}

//3rd party emotes
//if any of this fails, the send_chat code will fall back to just twitch emotes
// https://github.com/mkody/twitch-emoticons
const emote_cache = {
    // 'jjvanvan': {
    //     emotes: {
    //         catJAM: 'https://cdn.7tv.app/emote/60ae7316f7c927fad14e6ca2/1x.webp',
    //     },
    //     lastUpdated: 123456, //or undefined if never
    //     startedUpdating: 123456, //or undefined if done
    // }
}

async function update_emote_cache(channel) {
    console.log('[emotes] updating emote cache for channel:', channel);
    if (!emote_cache[channel]) {
        emote_cache[channel] = {}
    }
    emote_cache[channel].startedUpdating = + new Date();
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

        if (channel !== undefined) {
            //get the channel emotes for each service - optional, so continue if any fail
            try {
                const helixUser = await fetcher.apiClient.users.getUserByName(channel);
                console.log('[emotes] helixUser:', helixUser, channel);
                const channelId = parseInt(helixUser.id);
                console.log('[emotes] channelId', channelId, channel);
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
                    console.error('[emotes] bttv channel emotes error:', channel, JSON.stringify(err));
                }
                try {
                    await fetcher.fetchSevenTVEmotes(channelId); // 7TV channel
                    connections.channel_7tv = true;
                } catch (err) {
                    console.error('[emotes] 7tv channel emotes error:', channel, JSON.stringify(err));
                }
                try {
                    await fetcher.fetchFFZEmotes(channelId); // FFZ channel
                    connections.channel_ffz = true;
                } catch (err) {
                    console.error('[emotes] ffz channel emotes error:', channel, JSON.stringify(err));
                }
            } catch (err) {
                console.error('[emotes] error getting channel emotes:', channel, err);
            }
        }

        const now = + new Date();
        const emote_lookup = {};
        fetcher.emotes.forEach(emote => { emote_lookup[emote.code] = emote.toLink() });
        emote_cache[channel] = {
            emotes: emote_lookup,
            lastUpdated: now,
            connections: connections,
        };
        // console.log(emote_cache);
        console.log('[emotes] done updating emote cache for channel:', channel);
    } catch (err) {
        console.error('[emotes] error:', channel, err);
    }
}

async function update_emote_cache_if_needed(channel) {
    const now = + new Date();
    const lastUpdated = emote_cache[channel]?.lastUpdated || 0;
    const startedUpdating = emote_cache[channel]?.startedUpdating || 0;
    console.log('[emotes] emote cache status:', channel, now, lastUpdated, EMOTE_CACHE_TIME, startedUpdating, EMOTE_RETRY_TIME);
    if (now > lastUpdated + EMOTE_CACHE_TIME && now > startedUpdating + EMOTE_RETRY_TIME) {
        await update_emote_cache(channel);
    }
}

function find_3rd_party_emotes(channel, msg) {
    update_emote_cache_if_needed(channel); //this update will run in the background and will not help for this time
    const emotes = {};
    let pos = 0;
    const emote_lookup = emote_cache[channel]?.emotes || emote_cache[undefined]?.emotes || {}; //emote_cache[undefined] is the global cache
    msg.split(' ').forEach(word => {
        // console.log(word, pos);
        if (emote_lookup[word]) {
            if (!emotes[emote_lookup[word]]) {
                emotes[emote_lookup[word]] = [];
            }
            const start = pos;
            const end = pos + word.length - 1;
            emotes[emote_lookup[word]].push(`${start}-${end}`);
        }
        pos += word.length + 1;
    });
    return emotes;
}

update_emote_cache(undefined); //update the global emote cache

//after running for a bit, update all the emote caches. this will prevent spamming the API during testing
setTimeout(async () => {
    await update_emote_cache_if_needed(undefined);
    (await getEnabledChannels()).forEach(async channel => await update_emote_cache_if_needed(channel));
}, EMOTE_STARTUP_DELAY);

//twitch chat stuff
var tmi_client = undefined;

function twitch_try_say(channel, message) {
    if (tmi_client) {
        tmi_client.say(channel, message).catch(error => console.error('[twitch] tmi say error:', error));
    }
}

async function connectToTwitchChat() {
    if (tmi_client) {
        tmi_client.disconnect();
    }
    // Define configuration options
    const opts = {
        identity: {
            username: process.env.TWITCH_BOT_USERNAME,
            password: process.env.TWITCH_BOT_OAUTH_TOKEN
        },
        channels: await getEnabledChannels()
    };

    // console.log("[twitch] SECRETS:", JSON.stringify(opts));
    console.log("[twitch] CHANNELS:", JSON.stringify(opts.channels));

    // Create a client with our options
    tmi_client = new tmi.client(opts);

    // Register our event handlers (defined below)
    tmi_client.on('message', onMessageHandler);
    tmi_client.on('connected', onConnectedHandler);
    // Connect to Twitch:
    tmi_client.connect().catch(error => console.error('[twitch] tmi connect error:', error));
}

(async () => {
    connectToTwitchChat();
})();


// Called every time the bot connects to Twitch chat
function onConnectedHandler(addr, port) {
    console.log(`[twitch] connected to ${addr}:${port}`);
}
// Called every time a message comes in
async function onMessageHandler(target, context, msg, self) {
    console.log(`[twitch] TARGET: ${target} SELF: ${self} CONTEXT: ${JSON.stringify(context)}`);
    const username = context['display-name'];
    console.log(`[twitch] ${username}: ${msg}`);
    const channel = target.replace('#', '');

    // Ignore whispers
    if (context["message-type"] === "whisper") { return; }

    const nickname = await getViewerProperty(channel, 'nickname', username);

    //forward message to socket chat
    send_chat(channel, username, nickname, context.color, msg, context.emotes);

    if (self) { return; } // Ignore messages from the bot
    const [valid_command, carl_command] = await handleCommand(target, context, msg, username);

    //keep track of when the last message was
    if (username.toLowerCase() !== process.env.TWITCH_BOT_USERNAME.toLowerCase()) {
        if (nickname !== undefined) {
            if (!carl_command) { //carl already replies, no need for double
                const lastSeen = await getViewerProperty(channel, 'lastseen', username);
                const now = + new Date();
                console.log('[greetz]', username, now - lastSeen);
                if (lastSeen === undefined || now - lastSeen > await getChannelProperty(channel, 'greetz_threshold')) {
                    if (valid_command) { //if the user was running a command, wait a few seconds, then greet them, but with an "also" added
                        console.log('[greetz] user has been away a long time, but issued a command, so sending initial greeting in a few seconds');
                        setTimeout(async () => {
                            twitch_try_say(target, await parse_greetz(GREETZ_ALSO, channel, username));
                        }, GREETZ_DELAY_FOR_COMMAND);
                    } else {
                        console.log('[greetz] user has been away a long time, sending initial greeting');
                        twitch_try_say(target, await parse_greetz(GREETZ, channel, username));
                    }
                } else if (lastSeen === undefined || now - lastSeen > await getChannelProperty(channel, 'greetz_wb_threshold')) {
                    if (valid_command) { //if the user was running a command, wait a few seconds, then greet them, but with an "also" added
                        console.log('[greetz] user has been away a short time, but issued a command, so sending welcome back greeting in a few seconds');
                        setTimeout(async () => {
                            twitch_try_say(target, await parse_greetz(GREETZ_WELCOME_BACK_ALSO, channel, username));
                        }, GREETZ_DELAY_FOR_COMMAND);
                    } else {
                        console.log('[greetz] user has been away a short time, sending welcome back greeting');
                        twitch_try_say(target, await parse_greetz(GREETZ_WELCOME_BACK, channel, username));
                    }
                }
            }
            setViewerProperty(channel, 'lastseen', username, + new Date());
        }
    }
}

function is_super_admin(username) {
    return username?.toLowerCase() === process.env.TWITCH_SUPER_ADMIN_USERNAME.toLowerCase();
}

function has_permission(context) {
    return is_super_admin(context?.username) || context?.badges?.broadcaster === '1' || context?.badges?.moderator === '1';
}

async function getNicknameMsg(channel, username) {
    const nickname = await getViewerProperty(channel, 'nickname', username);
    if (nickname === undefined) {
        if (filter.isProfane(username)) {
            return `that user has not set a nickname yet (with !setnickname)`;
        } else {
            return `user ${username} has not set a nickname yet (with !setnickname)`;
        }
    }
    return `${username} 's nickname is ${nickname}`;
}

async function getUsername(channel, nickname) {
    const nicknames = await getChannelProperty(channel, 'nickname');
    let found = undefined;
    Object.keys(nicknames).forEach(username => {
        if (nicknames[username] === nickname) {
            found = username;
        }
    });
    return found;
}

async function getUsernameMsg(channel, nickname) {
    const username = await getUsername(channel, nickname);
    if (username === undefined) {
        if (filter.isProfane(nickname)) {
            return `that nickname does not belong to anyone, and furthermore is profane and cannot be used`;
        } else {
            return `nickname "${nickname}" does not belong to anyone (claim it with !setnickname)`;
        }
    }
    return `${nickname} is the nickname for ${username}`;
    // return `${username} 's nickname is ${nickname}`;
}

async function nicknameAlreadyTaken(channel, nickname) {
    const nicknames = Object.values(await getChannelProperty(channel, 'nickname'));
    return nicknames.includes(nickname);
}

async function updateChatHistory(channel) {
    if (chat_history[channel]) {
        const nicknames = await getChannelProperty(channel, 'nickname');
        chat_history[channel].forEach(msg => {
            msg.nickname = nicknames[msg.username];
        });
    }
}

async function handleCommand(target, context, msg, username) {
    // Remove whitespace and 7TV bypass from chat message
    const command = msg.replaceAll(' 󠀀', '').trim();
    const channel = target.replace('#', '');

    var valid = true;
    var carl = false;
    // If the command is known, let's execute it
    if (command === '!help' || command === '!commands') {
        twitch_try_say(target, `commands: !botpage - link to the page with nicknames and other info; !multichat - link to the combined youtube/twitch chat; !clear - clear the multichat; !setnickname - set your nickname; !nickname - view your nickname; !nickname user - view another user's nickname; !username nickname - look up who owns a nickname; !unsetnickname - delete your nickname`);
    } else if (command === '!botpage') {
        twitch_try_say(target, `see the nicknames and other bot info at ${process.env.BASE_URL}/${target}`);
    } else if (command === '!multichat') {
        twitch_try_say(target, `see the multichat at ${process.env.BASE_URL}/chat?channel=${channel} and even add it as an OBS browser source`);
        // } else if (command === '!ytconnect') {
        //     if (has_permission(context)) {
        //         const result = await connect_to_youtube(channel);
        //         console.log('[youtube] ytconnect result:', result);
        //         if (result === 'no id') twitch_try_say(channel, `no youtube account linked, log in with twitch here to add your youtube channel: ${process.env.BASE_URL}/${target}`);
        //         if (result === 'no live') twitch_try_say(channel, 'failed to find youtube livestream on your channel: youtube.com/channel/' + await getChannelProperty(channel, 'youtube_id') + '/live');
        //     }
        // } else if (command === '!ytdisconnect') {
        //     if (has_permission(context)) {
        //         disconnect_from_youtube(channel);
        //     }
    } else if (command === '!clear') {
        if (has_permission(context)) {
            clear_chat(channel);
            update_emote_cache(channel);
        }
    } else if (command === '!nickname') { //retrieve the nickname of the user who typed it
        twitch_try_say(target, await getNicknameMsg(channel, username));
    } else if (command.startsWith('!nickname ')) { //retrieve a nickname for a specific user
        const lookup_username = command.replace('!nickname', '').trim();
        twitch_try_say(target, await getNicknameMsg(channel, lookup_username));
    } else if (command.startsWith('!username ')) { //retrieve a username based on a nickname
        const nickname = command.replace('!username', '').trim();
        twitch_try_say(target, await getUsernameMsg(channel, nickname));
    } else if (command === '!unsetnickname') {
        const nickname = await getViewerProperty(channel, 'nickname', username);
        if (nickname) {
            await setViewerProperty(channel, 'nickname', username, undefined); //delete the nickname
            send_nickname(channel, username, undefined);
            updateChatHistory(channel);
            twitch_try_say(target, `@${username} removed nickname, sad to see you go`);
        } else {
            twitch_try_say(target, `@${username} you already don't have a nickname`);
        }
    } else if (command === '!setnickname') {
        const used_nicknames = Object.values(await getViewerProperty(channel, 'nickname', undefined));
        console.log(used_nicknames);
        const remaining_random_nicknames = JSON.parse(JSON.stringify(RANDOM_NICKNAMES)).filter(nickname => !used_nicknames.includes(nickname));
        if (remaining_random_nicknames.length > 0) {
            const nickname = random_choice(remaining_random_nicknames);
            await setViewerProperty(channel, 'nickname', username, nickname);
            send_nickname(channel, username, nickname);
            updateChatHistory(channel);
            twitch_try_say(target, `@${username} no nickname provided, your random nickname is ${nickname}`);
        } else {
            twitch_try_say(target, `out of random nicknames to assign, please provide a nickname with the !setnickname command`);
        }
    } else if (command.startsWith('!setnickname ')) {
        const nickname = command.replace('!setnickname', '').trim();
        const max_nickname_length = await getChannelProperty(channel, 'max_nickname_length')
        if (filter.isProfane(nickname)) {
            twitch_try_say(target, `@${username} no profanity allowed in nickname, use a different one or ask the streamer/admin to log in to the link at !botpage and set it for you`);
        } else if (await getViewerProperty(channel, 'nickname', username) === nickname) {
            twitch_try_say(target, `@${username} you already have that nickname`);
        } else if (nickname.length > max_nickname_length) {
            twitch_try_say(target, `@${username} nickname "${nickname}" is too long, must be ${max_nickname_length} letters`);
        } else if (await nicknameAlreadyTaken(channel, nickname)) {
            twitch_try_say(target, `@${username} nickname "${nickname}" is already taken, see !botpage for the list`);
        } else {
            await setViewerProperty(channel, 'nickname', username, nickname);
            send_nickname(channel, username, nickname);
            updateChatHistory(channel);
            twitch_try_say(target, `@${username} set nickname to ${nickname}`);
        }
    } else if (command.includes(`@${process.env.TWITCH_BOT_USERNAME}`) || command.includes(`@${process.env.TWITCH_BOT_USERNAME}`.toLowerCase())) {
        const message = command
            .replaceAll(` @${process.env.TWITCH_BOT_USERNAME} `, '')
            .replaceAll(` @${process.env.TWITCH_BOT_USERNAME} `.toLowerCase(), '')
            .replaceAll(` @${process.env.TWITCH_BOT_USERNAME}`, '')
            .replaceAll(` @${process.env.TWITCH_BOT_USERNAME}`.toLowerCase(), '')
            .replaceAll(`@${process.env.TWITCH_BOT_USERNAME} `, '')
            .replaceAll(`@${process.env.TWITCH_BOT_USERNAME} `.toLowerCase(), '')
            .replaceAll(`@${process.env.TWITCH_BOT_USERNAME}`, '')
            .replaceAll(`@${process.env.TWITCH_BOT_USERNAME}`.toLowerCase(), '');
        console.log(`[bot] asking CARL: ${message}`);
        let url = 'https://games.johanv.net/carl_api?user=' + encodeURIComponent(message);
        const reply_parent = context['reply-parent-msg-body'];
        if (reply_parent) {
            const carl_said = carl_history[reply_parent];
            if (carl_said) {
                url = 'https://games.johanv.net/carl_api?carl=' + encodeURIComponent(carl_said) + '&user=' + encodeURIComponent(message);
                console.log(`[bot] found reply parent in carl_history: "${reply_parent}" => ${carl_said}`);
            }
        }
        const response = await fetch(url);
        const data = await response.text();
        if (response.status === 200) {
            console.log("[bot] CARL:", data);
            let display_data = data;
            if (data.includes('CARL') || data.includes('Carl') || data.includes('carl')) {
                const nickname = await getViewerProperty(channel, 'nickname', username);
                display_data = data.replaceAll('CARL', nickname).replaceAll('Carl', nickname).replaceAll('carl', nickname);
                console.log("[bot] CARL (edited): ", display_data);
            }
            if (filter.isProfane(display_data) || display_data.toLowerCase().includes('stupid') || display_data.toLowerCase().includes('dumb') || display_data.toLowerCase().includes('idiot')) {
                display_data = `<3`;
            }
            const reply = `@${username} ${display_data}`
            twitch_try_say(target, reply);
            carl_history[reply] = data;
            console.log(`[bot] saved to carl_history: "${reply}" => "${data}"`);
        } else {
            console.log('[bot] error', response.status, data);
            twitch_try_say(target, `@${username} hey <3`);
        }
        carl = true;
    } else {
        valid = false;
        console.log(`[bot] Unknown command: ${command}`);
    }

    if (valid) {
        console.log(`[bot] Executed command: ${command}`);
    }
    return [valid, carl];

}

async function clear_chat(channel) {
    chat_history[channel] = [];
    console.log(`[socket.io] CLEAR CHAT ${channel}`);
    io.emit(channel + '/chat', { clear_chat: true });
}


//youtube chat stuff
async function getLiveVideoId(youtube_id) {
    try {
        return (await fetchLivePage({ channelId: youtube_id })).liveId;
    } catch (error) {
        // console.error(error);
        return '';
    }
}

const youtube_chats = {
    // 'jjvanvan': { 
    //     youtube_id: 'UCmrLaVZneWG3kJyPqp-RFJQ',
    //     listener: await Masterchat.init("IKRQQAMYnrM"),
    // }
};

async function disconnect_from_youtube(channel) { //channel is a twitch channel
    if (youtube_chats[channel]) {
        youtube_chats[channel].listener.stop();
        delete youtube_chats[channel];
    }
}

async function connect_to_youtube(channel) { //channel is a twitch channel
    disconnect_from_youtube(channel);
    const youtube_id = await getChannelProperty(channel, 'youtube_id');
    if (!youtube_id) {
        console.error('[youtube] no youtube channel id associated with twitch channel ' + channel);
        return 'no id';
    }

    const liveVideoId = await getLiveVideoId(youtube_id);
    console.log(`[youtube] channel: ${channel} youtube_id: ${youtube_id} liveVideoId: ${liveVideoId}`);
    if (liveVideoId === '') {
        console.error('[youtube] falied to find livestream');
        return 'no live';
    }
    console.log(`[youtube] connected to youtube chat: youtu.be/${liveVideoId}`);
    //delay the message a bit to allow the disconnect message to come thru first
    setTimeout(() => twitch_try_say(channel, `connected to youtube chat: youtu.be/${liveVideoId}`), TWITCH_MESSAGE_DELAY);

    const mc = await Masterchat.init(liveVideoId);
    // Listen for live chat
    mc.on("chat", async (chat) => {
        const timestamp = new Date(chat.timestamp);
        const now = new Date();
        const message_age = now - timestamp;
        // console.log(message_age);
        if (message_age <= YOUTUBE_MAX_MESSAGE_AGE) {
            const author = chat.authorName;
            const message = stringify(chat.message);
            console.log(`[youtube] [for twitch.tv/${channel}] ${author}: ${message}`);
            if (message !== undefined) {
                send_chat(channel, author, undefined, undefined, message, undefined);
                const fwd_cmds_yt_twitch = await getChannelProperty(channel, 'fwd_cmds_yt_twitch');
                fwd_cmds_yt_twitch.forEach(command => {
                    if (message.startsWith(command)) {
                        twitch_try_say(channel, filter.clean(message));
                    }
                });

                // twitch_try_say(channel, `[youtube] ${author}: ${message}`);
                // handleCommand(message);
            }
        }
    });

    // Listen for any events
    //   See below for a list of available action types
    mc.on("actions", (actions) => {
        const chats = actions.filter(
            (action) => action.type === "addChatItemAction"
        );
        const superChats = actions.filter(
            (action) => action.type === "addSuperChatItemAction"
        );
        const superStickers = actions.filter(
            (action) => action.type === "addSuperStickerItemAction"
        );
        // ...
    });

    // Handle errors
    mc.on("error", (err) => {
        console.log(`[youtube] [for twitch.tv/${channel}] ${err.code}`);
        // "disabled" => Live chat is disabled
        // "membersOnly" => No permission (members-only)
        // "private" => No permission (private video)
        // "unavailable" => Deleted OR wrong video id
        // "unarchived" => Live stream recording is not available
        // "denied" => Access denied (429)
        // "invalid" => Invalid request
    });

    // Handle end event
    mc.on("end", () => {
        console.log(`[youtube] [for twitch.tv/${channel}] live stream has ended or chat was disconnected`);
        delete youtube_chats[channel];
        twitch_try_say(channel, `disconnected from youtube chat`);
    });

    // Start polling live chat API
    mc.listen();

    youtube_chats[channel] = {
        youtube_id: youtube_id,
        listener: mc,
    }

    return '';
}


async function connect_to_all_youtubes() {
    console.log('[youtube] attempting to connect to all youtube chats');
    (await getEnabledChannels()).forEach(async channel => {
        if (youtube_chats[channel]) {
            console.log('[youtube] already connected to youtube live chat for twitch channel ' + channel);
        } else {
            connect_to_youtube(channel);
        }
    });
}

//periodically attempt to connect to youtube chats
setInterval(connect_to_all_youtubes, YOUTUBE_CHECK_FOR_LIVESTREAM_INTERVAL);


//owncast chat stuff
const owncast_chats = {
    // 'jjvanvan': { 
    //     owncast_url: 'johanv.net',
    //     listener: ???,
    // }
};

async function disconnect_from_owncast(channel) { //channel is a twitch channel
    if (owncast_chats[channel]) {
        owncast_chats[channel].listener.close();
        delete owncast_chats[channel];
    }
}

async function connect_to_owncast(channel) { //channel is a twitch channel
    disconnect_from_owncast(channel);
    const owncast_url = await getChannelProperty(channel, 'owncast_url');
    if (!owncast_url) {
        console.error('[owncast] no owncast url associated with twitch channel ' + channel);
        return 'no url';
    }

    const onErrorOrClose = () => {
        disconnect_from_owncast(channel);
    }

    const onMessageReceived = (message) => {
        //message received
        console.log("[owncast] Received: '" + JSON.stringify(message) + "'");
        //user joins:
        //Received: '{"id":"dZl60kLng","timestamp":"2022-02-27T23:37:24.330263605Z","type":"USER_JOINED","user":{"id":"_R_eAkL7g","displayName":"priceless-roentgen2","displayColor":123,"createdAt":"2022-02-27T23:37:24.250217566Z","previousNames":["priceless-roentgen2"]}}'
        //message:
        // Received: '{"body":"hello world","id":"En3e0kY7g","timestamp":"2022-02-27T23:37:28.502353829Z","type":"CHAT","user":{"id":"_R_eAkL7g","displayName":"priceless-roentgen2","displayColor":123,"createdAt":"2022-02-27T23:37:24.250217566Z","previousNames":["priceless-roentgen2"]},"visible":true}'
        // Received: '{"body":"<p>Johan :tux:  liked that this stream went live.</p>\n","id":"uep4JgKIg","image":"https://cdn.fosstodon.org/accounts/avatars/000/002/248/original/e68dc0e84d281224.png","link":"https://fosstodon.org/users/johanv","timestamp":"2023-12-30T16:29:25.371196748Z","title":"johanv@fosstodon.org","type":"FEDIVERSE_ENGAGEMENT_LIKE","user":{"displayName":"johanv.net"}}'
        //simplified: {"body": "hello world", "user": {"displayName": "priceless-roentgen"}}
        if ("body" in message && "user" in message && "displayName" in message.user) {
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
            send_chat(channel, name, undefined, color, text, emotes);
        }
    }

    try {
        // process.env.TWITCH_BOT_USERNAME DEFAULT_BOT_NICKNAME

        // const liveVideoId = await getLiveVideoId(youtube_id);
        const res = await fetch('https://' + owncast_url + '/api/chat/register', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ "displayName": DEFAULT_BOT_NICKNAME }),
        });

        const res_json = await res.json();

        console.log('[owncast] Status:', res.status);
        console.log('[owncast] JSON:', res_json);

        var token = res_json.accessToken;

        var client = new WebSocketClient();

        client.on('connectFailed', function (error) {
            console.log('[owncast] Connect Error: ' + error.toString());
            onErrorOrClose();
        });

        client.on('connect', function (connection) {
            console.log('[owncast] WebSocket Client Connected');
            connection.on('error', function (error) {
                console.log("[owncast] Connection Error: " + error.toString());
                onErrorOrClose();
            });
            connection.on('close', function () {
                console.log('[owncast] Connection Closed');
                onErrorOrClose();
            });
            connection.on('message', function (message) {
                if (message.type === 'utf8') {
                    // console.log("Received: '" + message.utf8Data + "'");

                    //multiple json objects can be sent in the same message, separated by newlines
                    message.utf8Data.split("\n").forEach(text => onMessageReceived(JSON.parse(text)));
                    // onMessageReceived({ "body": "<p>Johan :tux:  liked that this stream went live.</p>\n", "id": "uep4JgKIg", "image": "https://cdn.fosstodon.org/accounts/avatars/000/002/248/original/e68dc0e84d281224.png", "link": "https://fosstodon.org/users/johanv", "timestamp": "2023-12-30T16:29:25.371196748Z", "title": "johanv@fosstodon.org", "type": "FEDIVERSE_ENGAGEMENT_LIKE", "user": { "displayName": "johanv.net" } });
                }
            });

            owncast_chats[channel] = {
                owncast_url: owncast_url,
                listener: connection
            };
            console.log(`[owncast] connected to owncast chat: https://${owncast_url}`);
            //delay the message a bit to allow the disconnect message to come thru first
            setTimeout(() => twitch_try_say(channel, `connected to owncast chat: https://${owncast_url}`), TWITCH_MESSAGE_DELAY);
        });

        client.connect('wss://' + owncast_url + '/ws?accessToken=' + token);
    } catch (err) {
        console.error('[owncast] error: ' + err);
        onErrorOrClose();
    }
    return '';
}

async function connect_to_all_owncasts() {
    console.log('[owncast] attempting to connect to all owncast chats');
    (await getEnabledChannels()).forEach(async channel => {
        if (owncast_chats[channel]) {
            console.log('[owncast] already connected to owncast live chat for twitch channel ' + channel);
        } else {
            connect_to_owncast(channel);
        }
    });
}

//periodically attempt to connect to owncast chats
setInterval(connect_to_all_owncasts, OWNCAST_CHECK_FOR_LIVESTREAM_INTERVAL);


//start the http server
server.listen(process.env.PORT || DEFAULT_PORT, () => {
    console.log('listening on *:' + (process.env.PORT || DEFAULT_PORT));
});

//===PRIORITY===
//TODO migrate from json db to digitalocean spaces with separated files per channel at least
//TODO function for super admin to import/export json
//TODO test latency of DO spaces vs storj + minio
//TODO maybe migrate to app platform? or cloudways or k8s since they have better autoscaling. either way will require refactoring the secrets storage
//TODO system to backup the data
//TODO fix the profanity filter console.log(filter.clean("It smells like wrongdog in here.")) //???? like -> l***
//TODO public dashboard page
//TODO keep track of version and if mismatch, send reload request
//TODO auto reload if popout chat or public dashboard page, otherwise ask to reload
//TODO bot able to post on youtube

//===EASY===
//TODO replace || with ?? to prevent possible bugs, and test it
//TODO args to !multichat command to change the link, and tell it in message
//TODO link to source code on the page

//===BUGS===
//TODO failed to get chat messages after saying it was connected on the 1min timer
//TODO bot missing username when enabled and already has youtube_id ": connected to youtube chat"
//TODO bot keeps reconnecting to twitch chat, maybe every youtube check?

//===REFACTOR===
//TODO abstract out the sharing of state thru sockets?
//TODO rethink the api paths to something like /api/channels/:channel/nicknames/:username etc.
//TODO make it able to scale horizontally

//TODO allow mods to use the admin page for the streamer
//TODO give the bot "watching without audio/video" badge
//TODO youtube emotes
//TODO clear chat automatically?
//TODO remove deleted messages (timeouts, bans, individually deleted messages)
//TODO better UI for greetz threshold
//TODO maybe dont save to carl history if replaced with <3
//TODO maybe make nickname text slightly smaller
//TODO bot respond to alerts
//TODO separate vip chat
//TODO commands in the bot's chat to play videos on the 24/7 stream
//TODO a way for super admin to call an api to get/set/delete anything in the database, for example delete last seen time
//TODO twitch badges
//TODO twitch /me
//TODO twitch show replies
//TODO do an actual reply instead of @'ing the user
//TODO !songlist reply on youtube - You: !songlist Nightbot: @You -> The song list for this channel is available at https://nightbot.tv/t/streamer/song_requests
//TODO when !songlist is typed on youtube, reply with `The song list for this channel is available at https://nightbot.tv/t/[channel]/song_requests`
//TODO summary of youtube chat in twitch chat and vice versa? what about owncast? exponential combinatorics as more chats are added
//TODO command forwarding from owncast to twitch?
