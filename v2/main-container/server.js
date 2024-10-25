import redis from 'redis';
import http from 'http';
import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import passport from 'passport';
import { OAuth2Strategy } from 'passport-oauth';
import request from 'request';
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

//credit to https://github.com/twitchdev/authentication-node-sample (apache 2.0 license) for the auth code
const CALLBACK_URL = process.env.BASE_URL + '/twitch-auth/callback';
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
        console.log(`[twitch] user "${user.login}" logged in to the web interface with twitch`);
        // console.log(user);
        done(null, user);
    }
));

// Set route to start OAuth link, this is where you define scopes to request
app.get('/twitch-auth', passport.authenticate('twitch', { scope: ['user_read'] }));

// Set route for OAuth redirect
app.get('/twitch-auth/callback', passport.authenticate('twitch', { failureRedirect: '/' }), function (req, res) { res.redirect('/' + req.session?.passport?.user?.login) });

app.get('/log-out', function (req, res, next) {
    req.logout(function (err) {
        if (err) { return next(err); }
        res.redirect('/' + (req.query.returnTo ?? ''));
    });
});

//expose js libraries to client so they can run in the browser
app.use('/vue.js', express.static('node_modules/vue/dist/vue.global.prod.js'));

// Define a simple template to safely generate HTML with values from user's profile
const template = handlebars.compile(fs.readFileSync('index.html', 'utf8'));

// If user has an authenticated session, display it, otherwise display link to authenticate
app.get('/', async function (req, res) { res.send(template({ channels: await redis_client.sMembers('channels'), user: req.session?.passport?.user })); });

//start the http server
server.listen(process.env.PORT ?? 80, () => {
    console.log('listening on *:' + process.env.PORT ?? 80);
});
