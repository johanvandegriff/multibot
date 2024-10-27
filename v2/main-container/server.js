import redis from 'redis';
import http from 'http';
import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import passport from 'passport';
import { OAuth2Strategy } from 'passport-oauth';
import fs from 'fs';
import handlebars from 'handlebars';
import bodyParser from 'body-parser';

// Initialize Express and middlewares
const app = express();
const jsonParser = bodyParser.json()
const server = http.createServer(app);


const redis_client = redis.createClient({
    url: process.env.STATE_DB_URL,
    password: process.env.STATE_DB_PASSWORD
});

redis_client.on('error', err => console.log('Redis Client Error', err));
(async () => {
    await redis_client.connect();
    await redis_client.sAdd('channels', ['jjvanvan', 'minecraft1167890']); //TODO
    console.log('channels (hardcoded for now):', await redis_client.sMembers('channels'));
})();

// for consideration of using channel URLs directly, and having non-channel URLs be invalid usernames:
// Your Twitch username must be between 4 and 25 characters—no more, no less. Secondly, only letters A-Z, numbers 0-9, and underscores (_) are allowed. All other special characters are prohibited, but users are increasingly calling for the restriction to be relaxed in the future.
// need to make sure non-channel URLs contain a "-" or are 3 chars long, e.g. "/twitch-auth", "/log-out", "/new", "/api", etc.
// if owncast is added as a primary login, make sure that the url has a "." in it, e.g. "johanv.net" to distinguish it from twitch

//credit to https://github.com/twitchdev/authentication-node-sample (apache 2.0 license) for the auth code
const CALLBACK_URL = process.env.BASE_URL + '/api/auth/twitch/callback';
app.use(session({
    store: new RedisStore({ client: redis_client }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        // maxAge: 1000 * 60 * 1 // Session expiration time (1min)
    }
}));
// app.use(express.static('public'));
app.use(passport.initialize());
app.use(passport.session());

function is_super_admin(username) {
    return username?.toLowerCase() === process.env.TWITCH_SUPER_ADMIN_USERNAME.toLowerCase();
}

// Override passport profile function to get user profile from Twitch API
OAuth2Strategy.prototype.userProfile = function (accessToken, done) {
    fetch('https://api.twitch.tv/helix/users', {
        method: 'GET',
        headers: {
            'Client-ID': process.env.TWITCH_CLIENT_ID,
            'Accept': 'application/vnd.twitchtv.v5+json',
            'Authorization': 'Bearer ' + accessToken
        }
    })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => Promise.reject(err));
            }
            return response.json();
        })
        .then(data => {
            done(null, data);
        })
        .catch(error => {
            done(error);
        });
};

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
        console.log(`[twitch] user "${user.login}" logged in to the web interface with twitch`);
        // console.log(user);
        done(null, user);
    }
));

// Set route to start OAuth link, this is where you define scopes to request
app.get('/api/auth/twitch', passport.authenticate('twitch', { scope: ['user_read'] }));

// Set route for OAuth redirect
app.get('/api/auth/twitch/callback', passport.authenticate('twitch', { failureRedirect: '/' }), function (req, res) { res.redirect('/' + req.session?.passport?.user?.login) });

app.get('/api/logout', function (req, res, next) {
    req.logout(function (err) {
        if (err) { return next(err); }
        res.redirect('/' + (req.query.returnTo ?? ''));
    });
});

//expose js libraries to client so they can run in the browser
app.use('/vue.js', express.static('node_modules/vue/dist/vue.esm-browser.prod.js'));
app.use('/favicon.ico', express.static('favicon.ico'));
app.use('/favicon.png', express.static('favicon.png'));

// Define a simple template to safely generate HTML with values from user's profile
const template = handlebars.compile(fs.readFileSync('index.html', 'utf8'));

// If user has an authenticated session, display it, otherwise display link to authenticate
app.get('/', async function (req, res) {
    const user = req.session?.passport?.user;
    res.send(template({
        channels: await redis_client.sMembers('channels'),
        is_super_admin: is_super_admin(user?.login),
        user: user,
    }));
});

app.use((req, res) => {
    res.status(404).send(`<h1>404 - Not Found</h1>
<p>The requested URL was not found on this server.</p>
<p>If this is your username, <a href="/api/auth/twitch">log in</a> to activate it.</p>
<a href="/">back to homepage</a>`)
});

//start the http server
server.listen(process.env.PORT ?? 80, () => {
    console.log('listening on *:' + process.env.PORT ?? 80);
});
