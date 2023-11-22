const http = require('http');
const https = require('https');
const dotenv = require('dotenv'); //for storing secrets in an env file
const tmi = require('tmi.js'); //twitch chat https://dev.twitch.tv/docs/irc
const { LiveChat } = require("youtube-chat"); //youtube chat https://github.com/LinaTsukusu/youtube-chat#readme
const { Masterchat, stringify } = require("masterchat");
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
const DEFAULT_FWD_CMDS_YT_TWITCH = ['!sr', '!test'];
const YOUTUBE_MAX_MESSAGE_AGE = 10 * 1000; //10 seconds

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

app.post('/enabled', jsonParser, async (req, res) => {
    const channel = req.body.channel;
    if (req.session && req.session.passport && req.session.passport.user) {
        const is_super_admin = req.session.passport.user.is_super_admin;
        const login = req.session.passport.user.login;

        if (login === channel || is_super_admin) {
            console.log('auth success', req.body, login);
            await setEnabled(channel, req.body.isEnabled);
            connectToTwitchChat();
            send_event({ channel: channel, enabled: req.body.isEnabled });
            res.send('ok');
            return;
        }
    }
    console.log('auth error', req.body);
    res.send('auth error');
});

app.get('/fwd_cmds_yt_twitch', async (req, res) => { res.send(await getFwdCmdsYtTwitch(req.query.channel)) });
app.post('/fwd_cmds_yt_twitch', jsonParser, async (req, res) => {
    console.log(req.body)
    const channel = req.body.channel;
    if (req.session && req.session.passport && req.session.passport.user) {
        const is_super_admin = req.session.passport.user.is_super_admin;
        const login = req.session.passport.user.login;

        if (login === channel || is_super_admin) {
            console.log('auth success', req.body, login);
            if (Array.isArray(req.body.fwd_cmds_yt_twitch)) {
                await setFwdCmdsYtTwitch(channel, req.body.fwd_cmds_yt_twitch);
                send_event({ channel: channel, fwd_cmds_yt_twitch: req.body.fwd_cmds_yt_twitch });
                res.send('ok');
                return;
            } else {
                console.log('expected array', req.body);
                res.send('expected array');
                return
            }
        }
    }
    send_event({ channel: channel, fwd_cmds_yt_twitch: await getFwdCmdsYtTwitch(channel) });
    console.log('auth error', req.body);
    res.send('auth error');
});

app.get('/youtube_id', async (req, res) => { res.send(await getYoutubeId(req.query.channel)) });
app.post('/youtube_id', jsonParser, async (req, res) => {
    console.log(req.body)
    const channel = req.body.channel;
    if (req.session && req.session.passport && req.session.passport.user) {
        const is_super_admin = req.session.passport.user.is_super_admin;
        const login = req.session.passport.user.login;

        if (login === channel || is_super_admin) {
            console.log('auth success', req.body, login);
            await setYoutubeId(channel, req.body.youtube_id);
            res.send('ok');
            return;
        }
    }
    console.log('auth error', req.body);
    res.send('auth error');
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
        fetch(channel)
            .then(res => res.text())
            .then(text => {
                // <link rel="canonical" href="https://www.youtube.com/channel/UC3G4BWSWvZZSKAkj-qb7KKQ">
                const regex = /\<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([^"]*)"\>/
                const match = regex.exec(text);
                if (match) {
                    console.log('[youtube] found ID:', match[1], 'for channel:', channel);
                    res.send(match[1]);
                } else {
                    console.log('[youtube] error finding channel ID for:', channel);
                    res.send('error');
                }
            });
    } else {
        console.log('[youtube] invalid URL or handle provided:', channel);
        res.send('invalid');
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

async function setEnabled(channel, isEnabled) {
    await db.push('/channels/' + channel + '/enabled/', isEnabled);
}


async function getYoutubeId(channel) {
    try {
        return await db.getData('/channels/' + channel + '/youtube_id');
    } catch (error) {
        return '';
    }
}

async function setYoutubeId(channel, youtube_id) {
    const old_youtube_id = await getYoutubeId(channel);
    if (old_youtube_id !== youtube_id) {
        if (youtube_chats[youtube_id]) {
            youtube_chats[youtube_id].stop();
            delete youtube_chats[youtube_id];
        }
        await db.push('/channels/' + channel + '/youtube_id/', youtube_id);
        // connect_to_youtube(channel);
    }
}

async function getFwdCmdsYtTwitch(channel) {
    try {
        return await db.getData('/channels/' + channel + '/fwd_cmds_yt_twitch');
    } catch (error) {
        return DEFAULT_FWD_CMDS_YT_TWITCH;
    }
}

async function setFwdCmdsYtTwitch(channel, fwd_cmds_yt_twitch) {
    return await db.push('/channels/' + channel + '/fwd_cmds_yt_twitch', fwd_cmds_yt_twitch);
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

function send_chat(channel, username, color, text) {
    const iomsg = { username: username, color: color, text: text };
    if (!chat_history[channel]) {
        chat_history[channel] = [];
    }
    chat_history[channel].push(iomsg);
    if (chat_history[channel].length > CHAT_HISTORY_LENGTH) {
        chat_history[channel].shift();
    }
    console.log(`[socket.io] SEND CHAT ${username} (${color}): ${text}`);
    io.emit(channel + '/chat', iomsg);
}

function send_event(msg) {
    console.log(`[socket.io] SEND EVENT`, msg);
    io.emit('events', msg);
}

//twitch chat stuff
var tmi_client = undefined;
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
    tmi_client.connect();
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
    send_chat(channel, username, context.color, msg);

    if (self) { return; } // Ignore messages from the bot
    await handleCommand(target, context, msg, username);
}

function has_permission(context) {
    return context.username === process.env.TWITCH_SUPER_ADMIN_USERNAME.toLowerCase() || context && context.badges && (context.badges.broadcaster === '1' || context.badges.moderator === '1');
}

async function handleCommand(target, context, msg, username) {
    // Remove whitespace and 7TV bypass from chat message
    const commandName = msg.replace(' 󠀀', '').trim();
    const channel = target.replace('#', '');

    var valid = true;
    // If the command is known, let's execute it
    if (commandName === '!help') {
        tmi_client.say(target, `commands: !multichat - get the link to the combined youtube/twitch chat; !ytconnect - connect to the youtube chat once you have started stream; !ytdisconnect - disconnect from the youtube chat`);
    } else if (commandName === '!multichat') {
        tmi_client.say(target, `see the multichat at ${process.env.BASE_URL}/${target}`);
    } else if (commandName === '!ytconnect') {
        if (has_permission(context)) {
            connect_to_youtube(channel);
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
    return new Promise(async (resolve, reject) => {
        const yt = new LiveChat({ channelId: youtube_id });
        console.log(yt);
        yt.on('start', (liveId) => {
            console.log('[youtube] chat connection started with liveId:', liveId);
            // tmi_client.say(channel, `connected to youtube chat: youtu.be/${liveId}`);
            yt.stop();
            resolve(liveId);
        });
        yt.on('end', (reason) => {
            console.log('[youtube] chat connection ended with reason:', reason);
            // tmi_client.say(channel, `disconnected from youtube chat`);
        });
        yt.on('chat', (chatItem) => {
            console.log('[youtube] (temporary connection got a chat message) chatItem', chatItem);
        });
        yt.on('error', (err) => {
            console.error('[youtube] chat connection ERROR:', err);
            // tmi_client.say(channel, `youtube chat ERROR: ${err}`);
        });
        const ok = await yt.start()
        if (!ok) {
            console.error('[youtube] falied to connect to chat');
            // tmi_client.say(channel, 'youtube falied to connect to chat');
            resolve('');
        }
        setTimeout(() => {
            yt.stop();
            resolve('');
        }, 10000); //stop after 10s if nothing happened
    });
}

const youtube_chats = {
    // 'UCmrLaVZneWG3kJyPqp-RFJQ': await Masterchat.init("IKRQQAMYnrM")
};

async function disconnect_from_youtube(channel) {
    tmi_client.say(channel, `disconnecting from youtube chat`);
    const youtube_id = await getYoutubeId(channel);
    if (!youtube_id) {
        return;
    }
    if (youtube_chats[youtube_id]) {
        youtube_chats[youtube_id].stop();
        delete youtube_chats[youtube_id];
    }
}

async function connect_to_youtube(channel) { //TODO this is twitch channel, either refactor or rename var
    const youtube_id = await getYoutubeId(channel);
    if (!youtube_id) {
        return;
    }
    if (youtube_chats[youtube_id]) {
        youtube_chats[youtube_id].stop();
        delete youtube_chats[youtube_id];
    }

    const liveVideoId = await getLiveVideoId(youtube_id);
    console.log('[youtube] liveVideoId:', liveVideoId);
    if (liveVideoId === '') {
        console.error('[youtube] falied to find livestream');
        tmi_client.say(channel, 'youtube falied to find livestream');
        return;
    }
    console.log(`[youtube] connected to youtube chat: youtu.be/${liveVideoId}`);
    tmi_client.say(channel, `connected to youtube chat: youtu.be/${liveVideoId}`);

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
            console.log(`[youtube] ${author}: ${message}`);
            if (message !== undefined) {
                send_chat(channel, author, undefined, message);
                const fwd_cmds_yt_twitch = await getFwdCmdsYtTwitch(channel);
                fwd_cmds_yt_twitch.forEach(command => {
                    if (message.startsWith(command)) {
                        tmi_client.say(channel, filter.clean(message));
                    }
                });

                // tmi_client.say(channel, `[youtube] ${author}: ${message}`);
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
        console.log('[youtube]', err.code);
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
        console.log("[youtube] live stream has ended");
    });

    // Start polling live chat API
    mc.listen();

    youtube_chats[youtube_id] = mc;
}


//start the http server
server.listen(process.env.PORT || DEFAULT_PORT, () => {
    console.log('listening on *:' + (process.env.PORT || DEFAULT_PORT));
});


//TODO allow mods to use the admin page for the streamer
//TODO link to source code on the page
//TODO give the bot "watching without audio/video" badge
//TODO autoscroll when chat history loads
//TODO merge in the nickname bot
//TODO twitch global emotes
//TODO twitch BTTV, FFZ, 7TV emotes
//TODO youtube emotes
//TODO clear chat automatically?
//TODO remove deleted messages (timeouts, bans, individually deleted messages)
//TODO check all "replace" and see if it should be "replaceAll"
