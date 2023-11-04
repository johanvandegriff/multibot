const express = require('express');
const app = express();
const http = require('http');
const https = require('https');
const server = http.createServer(app);
const io = require('socket.io')(server);
const dotenv = require('dotenv'); //for storing secrets in an env file
const tmi = require('tmi.js'); //twitch chat https://dev.twitch.tv/docs/irc
const { JsonDB, Config } = require('node-json-db');

const CHAT_HISTORY_LENGTH = 100;
const chat_history = {};

const HOUR_IN_MILLISECONDS = 1 * 60 * 60 * 1000;
const LAST_SEEN_GREETZ_THRESHOLD_MS = 5 * HOUR_IN_MILLISECONDS;
const LAST_SEEN_GREETZ_WB_THRESHOLD_MS = 0.5 * HOUR_IN_MILLISECONDS;
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

const carl_history = {};

//expose js libraries to client so they can run in the browser
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html') });
app.get('/favicon.ico', (req, res) => { res.sendFile(__dirname + '/favicon.ico') });
app.get('/favicon.png', (req, res) => { res.sendFile(__dirname + '/favicon.png') });
app.get('/vue.js', (req, res) => { res.sendFile(__dirname + '/node_modules/vue/dist/vue.global.prod.js') });
app.get('/color-hash.js', (req, res) => { res.sendFile(__dirname + '/node_modules/color-hash/dist/color-hash.js') });

//expose the static dir with CSS and images
app.use('/static', express.static('static'));

//expose the list of nicknames
app.get('/nicknames.json', (req, res) => { res.sendFile('/srv/nicknames.json') });

// app.get('/*', (req, res) => { res.sendFile(__dirname + '/index.html') });

// The first argument is the database filename. If no extension is used, '.json' is assumed and automatically added.
// The second argument is used to tell the DB to save after each push
// If you set the second argument to false, you'll have to call the save() method.
// The third argument is used to ask JsonDB to save the database in a human readable format. (default false)
// The last argument is the separator. By default it's slash (/)
var db = new JsonDB(new Config("/srv/nicknames", true, true, '/'));

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
    console.log('[socket.io] a user connected:');
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
    //     io.emit('chat message', iomsg);
    // }
}

function send_nickname(channel, username, nickname) {
    console.log(`[socket.io] SEND NICKNAME ${nickname} = ${username}`);
    io.emit(channel + '/nickname', { username: username, nickname: nickname });
}

//twitch chat stuff
dotenv.config({ path: '/srv/secret-twitch.env' }) //bot API key and other info
//the /srv/secret-twitch.env file should look like:
//TWITCH_BOT_USERNAME=JJsNicknameBot (create an account for the bot and put the username here)
//TWITCH_BOT_OAUTH_TOKEN=oauth:blah blah blah
//TWITCH_BOT_CHANNELS=jjvantheman,minecraft1167890

// Define configuration options
const opts = {
    identity: {
        username: process.env.TWITCH_BOT_USERNAME,
        password: process.env.TWITCH_BOT_OAUTH_TOKEN
    },
    channels: process.env.TWITCH_BOT_CHANNELS.split(',')
};

// console.log("[twitch] SECRETS:" + JSON.stringify(opts));

// Create a client with our options
const client = new tmi.client(opts);

// Register our event handlers (defined below)
client.on('message', onMessageHandler);
client.on('connected', onConnectedHandler);
// Connect to Twitch:
client.connect();

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

    const nickname = await getNickname(channel, username);

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
                            // client.say(target, 'also ' + parse_greetz(random_choice(GREETZ), username, nickname));
                            client.say(target, parse_greetz(random_choice(GREETZ_ALSO), username, nickname));
                        }, GREETZ_DELAY_FOR_COMMAND);
                    } else {
                        console.log('[greetz] user has been away a long time, sending initial greeting');
                        client.say(target, parse_greetz(random_choice(GREETZ), username, nickname));
                    }
                } else if (lastSeen === undefined || now - lastSeen > LAST_SEEN_GREETZ_WB_THRESHOLD_MS) {
                    if (valid_command) { //if the user was running a command, wait a few seconds, then greet them, but with an "also" added
                        console.log('[greetz] user has been away a short time, but issued a command, so sending welcome back greeting in a few seconds');
                        setTimeout(() => {
                            // client.say(target, 'also ' + parse_greetz(random_choice(GREETZ_WELCOME_BACK), username, nickname));
                            client.say(target, parse_greetz(random_choice(GREETZ_WELCOME_BACK_ALSO), username, nickname));
                        }, GREETZ_DELAY_FOR_COMMAND);
                    } else {
                        console.log('[greetz] user has been away a short time, sending welcome back greeting');
                        client.say(target, parse_greetz(random_choice(GREETZ_WELCOME_BACK), username, nickname));
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
    return nicknames.includes(nickname);
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
        client.say(target, await getNicknameMsg(channel, username));
    } else if (commandName.startsWith('!nickname ')) { //retrieve a nickname for a specific user
        const lookup_username = commandName.replace('!nickname', '').trim();
        client.say(target, await getNicknameMsg(channel, lookup_username));
    } else if (commandName.startsWith('!username ')) { //retrieve a username based on a nickname
        const nickname = commandName.replace('!username', '').trim();
        client.say(target, await getUsernameMsg(channel, nickname));
    } else if (commandName === '!unsetnickname') {
        await deleteNickname(channel, username);
        send_nickname(channel, username, undefined);
        updateChatHistory(channel);
        client.say(target, `${username} removed nickname, sad to see you go`);
    } else if (commandName === '!setnickname') {
        client.say(target, `please provide a nickname with the !setnickname command`);
    } else if (commandName.startsWith('!setnickname ')) {
        const nickname = commandName.replace('!setnickname', '').trim();
        if (nickname.length > 2) {
            client.say(target, `@${username} nickname "${nickname}" is too long, must be 2 letters`);
        } else if (await nicknameAlreadyTaken(channel, nickname) && !await getNickname(channel, username) === nickname) {
            client.say(target, `@${username} nickname "${nickname}" is already taken, see !nicknames for the list`);
        } else {
            await setNickname(channel, username, nickname);
            send_nickname(channel, username, nickname);
            updateChatHistory(channel);
            client.say(target, `${username} set nickname to ${nickname}`);
        }
    } else if (commandName === '!nicknames') {
        client.say(target, `see all the nicknames at https://nicknames.johanv.net/${target}`);
    } else if (commandName.includes(`@${process.env.TWITCH_BOT_USERNAME}`) || commandName.includes(`@${process.env.TWITCH_BOT_USERNAME}`.toLowerCase())) {
        const message = commandName
            .replace(`@${process.env.TWITCH_BOT_USERNAME}`, '')
            .replace(`@${process.env.TWITCH_BOT_USERNAME}`.toLowerCase(), '')
            .replace(` @${process.env.TWITCH_BOT_USERNAME}`, '')
            .replace(` @${process.env.TWITCH_BOT_USERNAME}`.toLowerCase(), '')
            .replace(`@${process.env.TWITCH_BOT_USERNAME} `, '')
            .replace(`@${process.env.TWITCH_BOT_USERNAME} `.toLowerCase(), '');
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
                    if (data.includes('Carl') || data.includes('carl')) {
                        const nickname = await getNickname(channel, username);
                        display_data = data.replace('Carl', nickname).replace('carl', nickname);
                        console.log("[bot] CARL (edited): ", display_data);
                    }
                    const reply = `@${username} ${display_data}`
                    client.say(target, reply); //`CARL says: ${data} (https://jjv.sh/carl)`);
                    carl_history[reply] = data;
                    console.log(`[bot] saved to carl_history: "${reply}" => "${data}"`);
                } else {
                    client.say(target, `@${username} hey <3`);
                }
            });
        });
        request.on('error', (error) => {
            console.log('[bot] error', error);
            client.say(target, `@${username} hey <3`);
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

//TODO add a README with setup instructions and change package name and version
//TODO only show chat for 1 channel
