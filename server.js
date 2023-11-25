const http = require('http');
const https = require('https');
const dotenv = require('dotenv'); //for storing secrets in an env file
const tmi = require('tmi.js'); //twitch chat https://dev.twitch.tv/docs/irc
const { fetchLivePage } = require("./node_modules/youtube-chat/dist/requests") //get youtube live url by channel id https://github.com/LinaTsukusu/youtube-chat
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


dotenv.config({ path: '/srv/secret.env' }) //bot API key and other info
const DEFAULT_PORT = 8080;
const JSON_DB_FILE = '/srv/channels.json';
const CHAT_HISTORY_LENGTH = 100;
const chat_history = {};
const CALLBACK_URL = process.env.BASE_URL + '/auth/twitch/callback';
const DEFAULT_CHANNEL_PROPERTIES = {
    'enabled': false,
    'fwd_cmds_yt_twitch': ['!sr', '!test'],
    'youtube_id': '',
}
const YOUTUBE_MAX_MESSAGE_AGE = 10 * 1000; //10 seconds
const YOUTUBE_CHECK_FOR_LIVESTREAM_INTERVAL = 1 * 60 * 1000; //1 minute

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
        user.is_super_admin = profile.data[0].login === process.env.TWITCH_SUPER_ADMIN_USERNAME.toLowerCase();
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
app.get('/', function (req, res) {
    if (req.session && req.session.passport && req.session.passport.user) {
        res.send(template(req.session.passport.user));
    } else {
        res.send(template({})); //render the template with no user data
    }
});

app.get('/logout', function (req, res, next) {
    req.logout(function (err) {
        if (err) { return next(err); }
        if (req.query.returnTo) {
            res.redirect('/' + req.query.returnTo);
        } else {
            res.redirect('/');
        }
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

const chat_template = handlebars.compile(fs.readFileSync('chat.html', 'utf8'));
app.get('/chat', (req, res) => { res.send(chat_template({ channel: req.query.channel, bgcolor: req.query.bgcolor || 'transparent' })) });

//expose the list of channels
app.get('/channels', async (req, res) => { res.send(JSON.stringify({ channels: await getEnabledChannels(), all_channels: await getChannels() })) });
app.get('/chat_history', async (req, res) => {
    if (chat_history[req.query.channel]) {
        res.send(JSON.stringify(chat_history[req.query.channel]));
    } else {
        res.send(JSON.stringify([]));
    }
});

function channel_auth_middleware(req, res, next) {
    const login = req.session?.passport?.user?.login;
    const is_super_admin = req.session?.passport?.user?.is_super_admin;
    if (login === req.body.channel || is_super_admin) {
        console.log('auth success', req.body, login, is_super_admin);
        next();
    } else {
        console.error('access denied', req.body);
        res.status(403).end(); //403 Forbidden
    }
}

function validate_middleware(param_name, param_type) {
    return (req, res, next) => {
        const data = req.body[param_name];
        if (
            (param_type === 'Array' && data.constructor === Array) ||
            (param_type === 'Object' && data.constructor === Object) ||
            typeof data === param_type //for example, 'string', 'number', 'object' (which matches Array or Object)
        ) {
            next();
        } else {
            console.error('invalid data, expected ' + type + 'but got:', data);
            res.status(400).send('invalid data, expected ' + type); //400 Bad Request
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
    if (!enabled_timeouts[channel] || now - enabled_timeouts[channel] > 5000) {
        enabled_timeouts[channel] = now;
        const old_enabled = await getChannelProperty(channel, 'enabled');
        if (old_enabled !== enabled) {
            await setChannelProperty(channel, 'enabled', enabled);
            if (enabled) {
                connect_to_youtube(channel);
            } else {
                disconnect_from_youtube(channel);
            }
            connectToTwitchChat();
            send_event({ channel: channel, enabled: enabled });
        }
        res.end();
    } else {
        res.send('wait');
    }
});

app.get('/fwd_cmds_yt_twitch', async (req, res) => { res.send(await getChannelProperty(req.query.channel, 'fwd_cmds_yt_twitch')) });
app.post('/fwd_cmds_yt_twitch', jsonParser, channel_auth_middleware, validate_middleware('fwd_cmds_yt_twitch', 'Array'), async (req, res) => {
    const channel = req.body.channel;
    const fwd_cmds_yt_twitch = req.body.fwd_cmds_yt_twitch;
    await setChannelProperty(channel, 'fwd_cmds_yt_twitch', fwd_cmds_yt_twitch);
    send_event({ channel: channel, fwd_cmds_yt_twitch: fwd_cmds_yt_twitch });
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

function getYoutubeStatus(channel) {
    return youtube_chats[channel] || {};
}
app.get('/youtube_status', async (req, res) => { res.send(getYoutubeStatus(req.query.channel)) });


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

function send_chat(channel, username, color, text, emotes) {
    const iomsg = { username: username, color: color, emotes: emotes, text: text };
    if (!chat_history[channel]) {
        chat_history[channel] = [];
    }
    chat_history[channel].push(iomsg);
    if (chat_history[channel].length > CHAT_HISTORY_LENGTH) {
        chat_history[channel].shift();
    }
    console.log(`[socket.io] SEND CHAT ${username} (color: ${color} emotes: ${JSON.stringify(emotes)}): ${text}`);
    io.emit(channel + '/chat', iomsg);
}

function send_event(msg) {
    console.log(`[socket.io] SEND EVENT`, msg);
    io.emit('events', msg);
}

//twitch chat stuff
var tmi_client = undefined;

function twitch_try_say(channel, message) {
    tmi_client.say(channel, message).catch(error => console.error('[twitch] tmi say error:', error));
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

    //forward message to socket chat
    send_chat(channel, username, context.color, msg, context.emotes);

    if (self) { return; } // Ignore messages from the bot
    await handleCommand(target, context, msg, username);
}

function has_permission(context) {
    return context.username === process.env.TWITCH_SUPER_ADMIN_USERNAME.toLowerCase() || context && context.badges && (context.badges.broadcaster === '1' || context.badges.moderator === '1');
}

async function handleCommand(target, context, msg, username) {
    // Remove whitespace and 7TV bypass from chat message
    const commandName = msg.replaceAll(' 󠀀', '').trim();
    const channel = target.replace('#', '');

    var valid = true;
    // If the command is known, let's execute it
    if (commandName === '!help') {
        twitch_try_say(target, `commands: !multichat - get the link to the combined youtube/twitch chat; !clear - clear the multichat; SOON TO BE DEPRECATED: !ytconnect - connect to the youtube chat once you have started stream (now happens automatically); !ytdisconnect - disconnect from the youtube chat`);
    } else if (commandName === '!multichat') {
        twitch_try_say(target, `see the multichat at ${process.env.BASE_URL}/${target}`);
    } else if (commandName === '!ytconnect') {
        if (has_permission(context)) {
            const result = await connect_to_youtube(channel);
            console.log('[youtube] ytconnect result:', result);
            if (result === 'no id') twitch_try_say(channel, `no youtube account linked, log in with twitch here to add your youtube channel: ${process.env.BASE_URL}/${target}`);
            if (result === 'no live') twitch_try_say(channel, 'failed to find youtube livestream on your channel: youtube.com/channel/' + await getChannelProperty(channel, 'youtube_id') + '/live');
        }
    } else if (commandName === '!ytdisconnect') {
        if (has_permission(context)) {
            disconnect_from_youtube(channel);
        }
    } else if (commandName === '!clear') {
        if (has_permission(context)) {
            clear_chat(channel);
        }
    } else {
        valid = false;
        console.log(`[bot] Unknown command: ${commandName}`);
    }

    if (valid) {
        console.log(`[bot] Executed command: ${commandName}`);
    }
    return valid;
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
    // 'jjvantheman': { 
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
        console.error('[youtube] no channel id associated with twitch channel ' + channel);
        return 'no id';
    }

    const liveVideoId = await getLiveVideoId(youtube_id);
    console.log(`[youtube] channel: ${channel} youtube_id: ${youtube_id} liveVideoId: ${liveVideoId}`);
    if (liveVideoId === '') {
        console.error('[youtube] falied to find livestream');
        return 'no live';
    }
    console.log(`[youtube] connected to youtube chat: youtu.be/${liveVideoId}`);
    twitch_try_say(channel, `connected to youtube chat: youtu.be/${liveVideoId}`);

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
                send_chat(channel, author, undefined, message);
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
            console.log('[youtube] already connected to youtube livestream for twitch channel ' + channel);
        } else {
            connect_to_youtube(channel);
        }
    });
}

//periodically attempt to connect to youtube chats
setInterval(connect_to_all_youtubes, YOUTUBE_CHECK_FOR_LIVESTREAM_INTERVAL);


//start the http server
server.listen(process.env.PORT || DEFAULT_PORT, () => {
    console.log('listening on *:' + (process.env.PORT || DEFAULT_PORT));
});


//TODO allow mods to use the admin page for the streamer
//TODO link to source code on the page
//TODO give the bot "watching without audio/video" badge
//TODO merge in the nickname bot
//TODO twitch BTTV, FFZ, 7TV emotes
//TODO youtube emotes
//TODO clear chat automatically?
//TODO remove deleted messages (timeouts, bans, individually deleted messages)
//TODO abstract out the sharing of state thru sockets?
//TODO failed to get chat messages after saying it was connected on the 1min timer
//TODO bot missing username when enabled and already has youtube_id ": connected to youtube chat"
