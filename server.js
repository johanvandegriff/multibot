const BOT_NICKNAME = '🤖';
const CHAT_HISTORY_LENGTH = 100;
const DEFAULT_MAX_NICKNAME_LENGTH = 20;
const chat_history = {};
const carl_history = {};

const HOUR_IN_MILLISECONDS = 1 * 60 * 60 * 1000;
const DAY_IN_MILLISECONDS = 24 * HOUR_IN_MILLISECONDS;
const ACCOUNT_MIN_AGE = 10 * DAY_IN_MILLISECONDS;

const LAST_SEEN_GREETZ_THRESHOLD_MS = 5 * HOUR_IN_MILLISECONDS;
const LAST_SEEN_GREETZ_WB_THRESHOLD_MS = 0.25 * HOUR_IN_MILLISECONDS;
// const LAST_SEEN_GREETZ_THRESHOLD_MS = 10 * 1000; //10 seconds (for testing)
// const LAST_SEEN_GREETZ_WB_THRESHOLD_MS = 2.5 * 1000; //2.5 seconds (for testing)
// const LAST_SEEN_GREETZ_THRESHOLD_MS = 2 * 60 * 1000; //2 minutes (for testing)
// const LAST_SEEN_GREETZ_WB_THRESHOLD_MS = 1.01 * 60 * 1000; //1.01 minutes (for testing)

const GREETZ_DELAY_FOR_COMMAND = 2 * 1000; //wait 2 seconds to greet when the user ran a command

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
const dotenv = require('dotenv'); //for storing secrets in an env file
const tmi = require('tmi.js'); //twitch chat https://dev.twitch.tv/docs/irc
const fs = require('fs');
const { JsonDB, Config } = require('node-json-db');
var bodyParser = require('body-parser')
var jsonParser = bodyParser.json()

dotenv.config({ path: '/srv/secret-twitch.env' }) //bot API key and other info

//credit to https://github.com/twitchdev/authentication-node-sample (apache 2.0 license) for the auth code
// Define our dependencies
var express = require('express');
var session = require('express-session');
var passport = require('passport');
var OAuth2Strategy = require('passport-oauth').OAuth2Strategy;
var request = require('request');
var handlebars = require('handlebars');

// Define our constants, you will change these with your own
// const TWITCH_CLIENT_ID = '<YOUR CLIENT ID HERE>';
// const TWITCH_SECRET    = '<YOUR CLIENT SECRET HERE>';
// const SESSION_SECRET   = '<SOME SECRET HERE>';
// const CALLBACK_URL     = '<YOUR REDIRECT URL HERE>';  // You can run locally with - http://localhost:3000/auth/twitch/callback

// Initialize Express and middlewares
var app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);
app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
app.use(express.static('public'));
app.use(passport.initialize());
app.use(passport.session());

// Override passport profile function to get user profile from Twitch API
OAuth2Strategy.prototype.userProfile = function (accessToken, done) {
    var options = {
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


const CALLBACK_URL = process.env.BASE_URL + '/auth/twitch/callback';

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

        const created_at = new Date(user.created_at);
        const now = new Date();
        const account_age = now - created_at;
        console.log('[twitch] created_at', created_at);
        console.log('[twitch] account_age', msToTime(account_age));
        console.log('[twitch] ACCOUNT_MIN_AGE', msToTime(ACCOUNT_MIN_AGE), account_age >= ACCOUNT_MIN_AGE);
        const time_until_valid = ACCOUNT_MIN_AGE - account_age
        console.log('[twitch] time_until_valid', time_until_valid, msToTime(time_until_valid));
        //TODO validate account is old enough?
        // console.log('is_super_admin', user.is_super_admin, user.login);

        console.log(user);

        done(null, user);
    }
));

// Set route to start OAuth link, this is where you define scopes to request
app.get('/auth/twitch', passport.authenticate('twitch', { scope: ['user_read'] }));

// Set route for OAuth redirect
app.get('/auth/twitch/callback', passport.authenticate('twitch', { successRedirect: '/', failureRedirect: '/' }));

// Define a simple template to safely generate HTML with values from user's profile
var template = handlebars.compile(fs.readFileSync('index.html', 'utf8'));

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
app.get('/favicon.ico', (req, res) => { res.sendFile(__dirname + '/favicon.ico') });
app.get('/favicon.png', (req, res) => { res.sendFile(__dirname + '/favicon.png') });
app.get('/vue.js', (req, res) => { res.sendFile(__dirname + '/node_modules/vue/dist/vue.global.prod.js') });
app.get('/color-hash.js', (req, res) => { res.sendFile(__dirname + '/node_modules/color-hash/dist/color-hash.js') });

//expose the static dir with CSS and images
app.use('/static', express.static('static'));

//expose the list of nicknames
app.get('/nicknames.json', (req, res) => { res.sendFile('/srv/nicknames.json') });

app.get('/channels', async (req, res) => { res.send(JSON.stringify({channels: await getEnabledChannels(), all_channels: await getChannels()})) });
app.get('/max_nickname_length', async (req, res) => { res.send(JSON.stringify(await getMaxNicknameLength(req.query.channel))) });
app.post('/max_nickname_length', jsonParser, async (req, res) => {
    const channel = req.body.channel;
    if (req.session && req.session.passport && req.session.passport.user) {
        const is_super_admin = req.session.passport.user.is_super_admin;
        const login = req.session.passport.user.login;

        if (login === channel || is_super_admin) {
            console.log('auth success', req.body, login);

            const max_nickname_length = parseInt(req.body.max_nickname_length);
            if (max_nickname_length > 0) {
                await setMaxNicknameLength(channel, max_nickname_length);
                send_event({channel: channel, max_nickname_length: max_nickname_length});
                res.send('ok');
            } else {
                console.log(max_nickname_length);
                send_event({channel: channel, max_nickname_length: await getMaxNicknameLength(channel)});
                res.send('invalid value')
            }
            return;
        }
    }
    console.log('auth error', req.body);
    send_event({channel: channel, max_nickname_length: await getMaxNicknameLength(channel)});
    res.send('auth error');
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
            send_event({channel: channel, enabled: req.body.isEnabled});
            res.send('ok');
            return;
        }
    }
    console.log('auth error', req.body);
    res.send('auth error');
});

app.post('/nickname', jsonParser, async (req, res) => {
    const channel = req.body.channel;
    if (req.session && req.session.passport && req.session.passport.user) {
        const is_super_admin = req.session.passport.user.is_super_admin;
        const login = req.session.passport.user.login;
        const display_name = req.session.passport.user.display_name;

        if (login === channel || is_super_admin) {
            console.log('auth success', req.body, login);
            await setNickname(channel, req.body.username, req.body.nickname);
            send_nickname(channel, req.body.username, req.body.nickname);
            if (tmi_client) {
                if (req.body.nickname) {
                    tmi_client.say(channel, `admin ${display_name} set ${req.body.username} 's nickname to ${req.body.nickname}`);
                } else {
                    tmi_client.say(channel, `admin ${display_name} removed ${req.body.username} 's nickname`);
                }
            }
            res.send('ok');
            return;
        }
    }
    console.log('auth error', req.body);
    res.send('auth error');
});

function msToTime(duration) {
    const milliseconds = ((duration % 1000) + '').padStart(3, '0');
    const seconds = Math.floor((duration / 1000) % 60);
    const minutes = Math.floor((duration / (1000 * 60)) % 60);
    const hours = Math.floor((duration / (1000 * 60 * 60)) % 24);
    const days = Math.floor((duration / (1000 * 60 * 60 * 24)));
    return days + 'd, ' + hours + 'h, ' + minutes + 'm, ' + seconds + '.' + milliseconds + 's';
}

// The first argument is the database filename. If no extension is used, '.json' is assumed and automatically added.
// The second argument is used to tell the DB to save after each push
// If you set the second argument to false, you'll have to call the save() method.
// The third argument is used to ask JsonDB to save the database in a human readable format. (default false)
// The last argument is the separator. By default it's slash (/)
var db = new JsonDB(new Config("/srv/nicknames", true, true, '/'));

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

// async function getEnabled(channel) {
//     try {
//         return await db.getData('/channels/' + channel + '/enabled');
//     } catch (error) {
//         return false;
//     }
// }

async function setEnabled(channel, isEnabled) {
    await db.push('/channels/' + channel + '/enabled/', isEnabled);
    if (isEnabled && !await getNickname(channel, process.env.TWITCH_BOT_USERNAME)) {
        await setNickname(channel, process.env.TWITCH_BOT_USERNAME, BOT_NICKNAME);
        send_nickname(channel, process.env.TWITCH_BOT_USERNAME, BOT_NICKNAME);
    }
}

async function getMaxNicknameLength(channel) {
    try {
        return await db.getData('/channels/' + channel + '/max_nickname_length');
    } catch (error) {
        return DEFAULT_MAX_NICKNAME_LENGTH;
    }
}

async function setMaxNicknameLength(channel, max_nickname_length) {
    await db.push('/channels/' + channel + '/max_nickname_length', max_nickname_length);
}

async function getNicknames(channel) {
    try {
        return await db.getData('/channels/' + channel + '/nicknames/');
    } catch (error) {
        return {};
    }
}
async function getNickname(channel, username) {
    try {
        return await db.getData('/channels/' + channel + '/nicknames/' + username);
    } catch (error) {
        return undefined;
    }
}

async function deleteNickname(channel, username) {
    await db.delete('/channels/' + channel + '/nicknames/' + username);
}

async function setNickname(channel, username, nickname) {
    await db.push('/channels/' + channel + '/nicknames/' + username, nickname);
}

async function getUsername(channel, nickname) {
    const nicknames = await getNicknames(channel);
    let found = undefined;
    Object.keys(nicknames).forEach(username => {
        if (nicknames[username] === nickname) {
            found = username;
        }
    });
    return found;
}


async function setLastSeenNow(channel, username) {
    await db.push('/channels/' + channel + '/lastseen/' + username, + new Date());
}

async function getLastSeen(channel, username) {
    try {
        return await db.getData('/channels/' + channel + '/lastseen/' + username);
    } catch (error) {
        return undefined;
    }
}

function random_choice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function parse_greetz(message, username, nickname) {
    // return message.replace('@', '@' + username);
    // return message.replace('#', nickname);
    // return '@' + username + ' ' + message.replace('#', nickname);
    return message.replace('@', '@' + username).replace('#', nickname);
    // return '@' + username + ' ' + message.replace('@', '@' + username).replace('#', nickname);
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
        const nicknames = await getNicknames(channel);
        Object.keys(nicknames).forEach(username => {
            const nickname = nicknames[username];
            send_nickname(channel, username, nickname);
        });
        //replay the chat history
        if (chat_history[channel]) {
            chat_history[channel].forEach(msg => send_chat(channel, ...msg, true));
        }
    });
});

function send_chat(channel, username, nickname, text, replaying) {
    if (!replaying) {
        if (!chat_history[channel]) {
            chat_history[channel] = [];
        }
        chat_history[channel].push([username, nickname, text]);
        if (chat_history[channel].length > CHAT_HISTORY_LENGTH) {
            chat_history[channel].shift();
        }
    }
    console.log(`[socket.io] SEND CHAT ${username} (${nickname}): ${text}`);
    io.emit(channel + '/chat', { username: username, nickname: nickname, text: text });
    // emit the message many times for testing CSS
    // let iomsg = { username: username, nickname: nickname, text: text }
    // iomsg.text = iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+
    //              iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text+iomsg.text;
    // for (i=0; i<30; i++) {
    //     io.emit(channel + '/chat', iomsg);
    // }
}

function send_nickname(channel, username, nickname) {
    console.log(`[socket.io] SEND NICKNAME ${nickname} = ${username}`);
    io.emit(channel + '/nickname', { username: username, nickname: nickname });
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

    let nickname = await getNickname(channel, username);

    if (username === process.env.TWITCH_BOT_USERNAME) {
        nickname = BOT_NICKNAME;
    }

    //forward message to socket chat
    send_chat(channel, username, nickname, msg);

    if (self) { return; } // Ignore messages from the bot
    const [valid_command, carl_command] = await handleCommand(target, context, msg, username);

    //keep track of when the last message was
    if (username.toLowerCase() !== process.env.TWITCH_BOT_USERNAME.toLowerCase()) {
        if (nickname !== undefined) {
            if (!carl_command) { //carl already replies, no need for double
                const lastSeen = await getLastSeen(channel, username);
                const now = + new Date();
                console.log('[greetz]', username, now - lastSeen);
                if (lastSeen === undefined || now - lastSeen > LAST_SEEN_GREETZ_THRESHOLD_MS) {
                    if (valid_command) { //if the user was running a command, wait a few seconds, then greet them, but with an "also" added
                        console.log('[greetz] user has been away a long time, but issued a command, so sending initial greeting in a few seconds');
                        setTimeout(() => {
                            tmi_client.say(target, parse_greetz(random_choice(GREETZ_ALSO), username, nickname));
                        }, GREETZ_DELAY_FOR_COMMAND);
                    } else {
                        console.log('[greetz] user has been away a long time, sending initial greeting');
                        tmi_client.say(target, parse_greetz(random_choice(GREETZ), username, nickname));
                    }
                } else if (lastSeen === undefined || now - lastSeen > LAST_SEEN_GREETZ_WB_THRESHOLD_MS) {
                    if (valid_command) { //if the user was running a command, wait a few seconds, then greet them, but with an "also" added
                        console.log('[greetz] user has been away a short time, but issued a command, so sending welcome back greeting in a few seconds');
                        setTimeout(() => {
                            tmi_client.say(target, parse_greetz(random_choice(GREETZ_WELCOME_BACK_ALSO), username, nickname));
                        }, GREETZ_DELAY_FOR_COMMAND);
                    } else {
                        console.log('[greetz] user has been away a short time, sending welcome back greeting');
                        tmi_client.say(target, parse_greetz(random_choice(GREETZ_WELCOME_BACK), username, nickname));
                    }
                }
            }
            setLastSeenNow(channel, username);
        }
    }
}


async function getNicknameMsg(channel, username) {
    const nickname = await getNickname(channel, username);
    if (nickname === undefined) {
        return `${username} has not set a nickname yet (with !setnickname)`;
    }
    return `${username}'s nickname is ${nickname}`;
}

async function getUsernameMsg(channel, nickname) {
    const username = await getUsername(channel, nickname);
    if (username === undefined) {
        return `nickname "${nickname}" does not belong to anyone (claim it with !setnickname)`;
    }
    return `${nickname} is the nickname for ${username}`;
    // return `${username}'s nickname is ${nickname}`;
}

async function nicknameAlreadyTaken(channel, nickname) {
    const nicknames = Object.values(await getNicknames(channel));
    return nickname === BOT_NICKNAME || nicknames.includes(nickname);
}

async function updateChatHistory(channel) {
    if (chat_history[channel]) {
        const nicknames = await getNicknames(channel);
        chat_history[channel].forEach(msg => {
            msg[1] = nicknames[msg[0]];
        });
    }
}

async function handleCommand(target, context, msg, username) {
    // Remove whitespace and 7TV bypass from chat message
    const commandName = msg.replace(' 󠀀', '').trim();
    const channel = target.replace('#', '');

    var valid = true;
    var carl = false;
    // If the command is known, let's execute it
    if (commandName === '!nickname') { //retrieve the nickname of the user who typed it
        tmi_client.say(target, await getNicknameMsg(channel, username));
    } else if (commandName.startsWith('!nickname ')) { //retrieve a nickname for a specific user
        const lookup_username = commandName.replace('!nickname', '').trim();
        tmi_client.say(target, await getNicknameMsg(channel, lookup_username));
    } else if (commandName.startsWith('!username ')) { //retrieve a username based on a nickname
        const nickname = commandName.replace('!username', '').trim();
        tmi_client.say(target, await getUsernameMsg(channel, nickname));
    } else if (commandName === '!unsetnickname') {
        await deleteNickname(channel, username);
        send_nickname(channel, username, undefined);
        updateChatHistory(channel);
        tmi_client.say(target, `${username} removed nickname, sad to see you go`);
    } else if (commandName === '!setnickname') {
        tmi_client.say(target, `please provide a nickname with the !setnickname command`);
    } else if (commandName.startsWith('!setnickname ')) {
        const nickname = commandName.replace('!setnickname', '').trim();
        const max_nickname_length = await getMaxNicknameLength(channel)
        if (nickname.length > max_nickname_length) {
            tmi_client.say(target, `@${username} nickname "${nickname}" is too long, must be ${max_nickname_length} letters`);
        } else if (await getNickname(channel, username) === nickname) {
            tmi_client.say(target, `@${username} you already have that nickname`);
        } else if (await nicknameAlreadyTaken(channel, nickname)) {
            tmi_client.say(target, `@${username} nickname "${nickname}" is already taken, see !nicknames for the list`);
        } else {
            await setNickname(channel, username, nickname);
            send_nickname(channel, username, nickname);
            updateChatHistory(channel);
            tmi_client.say(target, `${username} set nickname to ${nickname}`);
        }
    } else if (commandName === '!nicknames') {
        tmi_client.say(target, `see all the nicknames at ${process.env.BASE_URL}/${target}`);
    } else if (commandName.includes(`@${process.env.TWITCH_BOT_USERNAME}`) || commandName.includes(`@${process.env.TWITCH_BOT_USERNAME}`.toLowerCase())) {
        const message = commandName
            .replace(` @${process.env.TWITCH_BOT_USERNAME} `, '')
            .replace(` @${process.env.TWITCH_BOT_USERNAME} `.toLowerCase(), '')
            .replace(` @${process.env.TWITCH_BOT_USERNAME}`, '')
            .replace(` @${process.env.TWITCH_BOT_USERNAME}`.toLowerCase(), '')
            .replace(`@${process.env.TWITCH_BOT_USERNAME} `, '')
            .replace(`@${process.env.TWITCH_BOT_USERNAME} `.toLowerCase(), '')
            .replace(`@${process.env.TWITCH_BOT_USERNAME}`, '')
            .replace(`@${process.env.TWITCH_BOT_USERNAME}`.toLowerCase(), '');
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
        const request = https.request(url, (response) => {
            let data = '';
            response.on('data', (chunk) => {
                data = data + chunk.toString();
            });
            response.on('end', async () => {
                // const body = JSON.parse(data);
                console.log("[bot] CARL:", data);
                if (response.statusCode === 200) {
                    let display_data = data;
                    if (data.includes('CARL') || data.includes('Carl') || data.includes('carl')) {
                        const nickname = await getNickname(channel, username);
                        display_data = data.replace('CARL', nickname).replace('Carl', nickname).replace('carl', nickname);
                        console.log("[bot] CARL (edited): ", display_data);
                    }
                    const reply = `@${username} ${display_data}`
                    tmi_client.say(target, reply); //`CARL says: ${data} (https://jjv.sh/carl)`);
                    carl_history[reply] = data;
                    console.log(`[bot] saved to carl_history: "${reply}" => "${data}"`);
                } else {
                    tmi_client.say(target, `@${username} hey <3`);
                }
            });
        });
        request.on('error', (error) => {
            console.log('[bot] error', error);
            tmi_client.say(target, `@${username} hey <3`);
        });
        request.end();
        carl = true;
    } else {
        valid = false;
        console.log(`[bot] Unknown command: ${commandName}`);
    }

    if (valid) {
        console.log(`[bot] Executed command: ${commandName}`);
    }
    return [valid, carl];
}


//start the http server
var default_port = 8080;
server.listen(process.env.PORT || default_port, () => {
    console.log('listening on *:' + (process.env.PORT || default_port));
});


//TODO allow mods to use the admin page for the streamer
//TODO on the admin page, able to set custom messages such as "good luck, 47"
//TODO let the greetz thresholds be configured by the admin
//TODO maybe show max_nickname_length when logged out?
//TODO maybe let users edit their own nickname when logged in with twitch?
