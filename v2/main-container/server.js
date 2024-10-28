const CHECK_FOR_CHANNEL_CHANGES_INTERVAL = 10 * 1000; //10 seconds

import redis from 'redis';
import http from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import passport from 'passport';
import { OAuth2Strategy } from 'passport-oauth';
import fs from 'fs';
import handlebars from 'handlebars';
import k8s from '@kubernetes/client-node';
import yaml from 'js-yaml';

const kc = new k8s.KubeConfig();
kc.loadFromCluster();

const appsV1Api = kc.makeApiClient(k8s.AppsV1Api);
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

async function create_tenant_container(channel) {
    const deployment = yaml.load(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tenant-container-${channel}
  labels:
    app: tenant-container-${channel}
    group: tenant-containers
    logging: my_group
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tenant-container-${channel}
  template:
    metadata:
      labels:
        app: tenant-container-${channel}
        group: tenant-containers
        logging: my_group
    spec:
      containers:
      - name: tenant-container-${channel}
        image: tenant-container
        imagePullPolicy: IfNotPresent
        env:
        - name: TWITCH_CHANNEL
          value: "${channel}"
        - name: TWITCH_BOT_USERNAME
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: TWITCH_BOT_USERNAME
        - name: TWITCH_BOT_OAUTH_TOKEN
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: TWITCH_BOT_OAUTH_TOKEN
        - name: BASE_URL
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: BASE_URL
        - name: TWITCH_SUPER_ADMIN_USERNAME
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: TWITCH_SUPER_ADMIN_USERNAME
        - name: TWITCH_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: TWITCH_CLIENT_ID
        - name: TWITCH_SECRET
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: TWITCH_SECRET
        - name: SESSION_SECRET
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: SESSION_SECRET
        - name: STATE_DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: STATE_DB_PASSWORD
        - name: STATE_DB_URL
          value: "redis://state-db:6379"
      restartPolicy: Always
    `);

    const service = yaml.load(`
apiVersion: v1
kind: Service
metadata:
  name: tenant-container-${channel}
spec:
  selector:
    app: tenant-container-${channel}
  ports:
  - protocol: TCP
    port: 8000
    targetPort: 80
  type: ClusterIP
    `);

    let worked = true;
    try {
        console.log('creating deployment...');
        const deployment_res = await appsV1Api.createNamespacedDeployment('default', deployment);
        console.log('created deployment:', deployment_res.body);
    } catch (err) {
        worked = false;
        console.error(err.body);
    }
    try {
        console.log('creating service...');
        const service_res = await coreV1Api.createNamespacedService('default', service);
        console.log('created service:', service_res.body);
    } catch (err) {
        worked = false;
        console.error(err.body);
    }
    return worked;
}

async function create_tenant_proxy(channel) {
    //set up a proxy to the container on the app route /channel
    let url = 'http://tenant-container-' + channel + ':8000';
    if (proxy_overrides[channel]) {
        url = proxy_overrides[channel];
    }
    console.log('[proxy]', channel, url);
    app.use('/' + channel, createProxyMiddleware({
        target: url,
        changeOrigin: false,
        ws: true,
    }));
}

async function delete_tenant_container(channel) {
    const name = `tenant-container-${channel}`;
    let worked = true;
    try {
        console.log('deleting deployment...');
        const deployment_res = await appsV1Api.deleteNamespacedDeployment(name, 'default');
        console.log('deleted deployment:', deployment_res.body);
    } catch (err) {
        worked = false;
        console.error(err.body);
    }
    try {
        console.log('deleting service...');
        const service_res = await coreV1Api.deleteNamespacedService(name, 'default');
        console.log('deleted service:', service_res.body);
    } catch (err) {
        worked = false;
        console.error(err.body);
    }
    return worked;
}

async function delete_tenant_proxy(channel) {
    //remove the proxy to the container from the app routes (using a bit of a hacky method)
    // https://stackoverflow.com/questions/18602578/proper-way-to-remove-middleware-from-the-express-stack
    // console.log('BEFORE:', channel, app._router.stack);
    const regexp_str = '/^\\/' + channel + '\\/?(?=\\/|$)/i'; // String(/^\/minecraft1167890\/?(?=\/|$)/i);
    app._router.stack = app._router.stack.filter(layer => String(layer.regexp) !== regexp_str);
    // console.log('AFTER:', channel, app._router.stack);
}


// Initialize Express and middlewares
const app = express();
const server = http.createServer(app);


const redis_client = redis.createClient({
    url: process.env.STATE_DB_URL,
    password: process.env.STATE_DB_PASSWORD
});
redis_client.on('error', err => console.log('Redis Client Error', err));

const proxy_overrides = JSON.parse(process.env.PROXY_OVERRIDES ?? '{}');
(async () => {
    await redis_client.connect();
    for (const channel in proxy_overrides) {
        await redis_client.sAdd('channels', channel);
    }
    const channels = await redis_client.sMembers('channels');
    console.log('channels onboarded:', channels);
    for (const channel of channels) {
        //don't await, start them in parallel
        create_tenant_container(channel);
        create_tenant_proxy(channel);
    }
    old_channels = channels;
})();

let old_channels = [];
async function check_for_channel_changes() {
    const channels = await redis_client.sMembers('channels');
    const added = channels.filter(c => !old_channels.includes(c));
    const removed = old_channels.filter(c => !channels.includes(c));

    for (const channel of added) {
        console.log('channel added:', channel);
        create_tenant_proxy(channel);
    }
    for (const channel of removed) {
        console.log('channel removed:', channel);
        delete_tenant_proxy(channel);
    }

    old_channels = channels;
}

setInterval(check_for_channel_changes, CHECK_FOR_CHANNEL_CHANGES_INTERVAL);

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
app.get('/api/auth/twitch/callback', passport.authenticate('twitch', { failureRedirect: '/' }), async function (req, res) {
    const login = req.session?.passport?.user?.login
    if (await redis_client.sIsMember('channels', login)) {
        //if the channel has a tenant container, go there
        res.redirect('/' + login);
    } else {
        //otherwise go to the homepage which has instructions to sign up
        res.redirect('/');
    }
});

function channel_auth_middleware(req, res, next) {
    const login = req.session?.passport?.user?.login;
    const channel = req.params.channel; //channel must be a url param for this to work
    if (login === channel || is_super_admin(login)) {
        console.log('auth success', req.originalUrl, req.body, login, is_super_admin(login));
        next();
    } else {
        console.error('access denied', req.originalUrl, req.body, login, is_super_admin(login));
        res.status(403).end(); //403 Forbidden
    }
}

app.get('/api/onboard/', async function (req, res) {
    res.status(400).send('missing channel'); //400 Bad Request
});

app.get('/api/onboard/:channel', channel_auth_middleware, async function (req, res) {
    const channel = req.params.channel;
    if (!channel) {
        res.status(400).send('invalid channel'); //400 Bad Request
        return;
    }
    if (await redis_client.sIsMember('channels', channel)) {
        res.status(409).send('channel already onboarded'); //409 Conflict
        return;
    }
    if (!await create_tenant_container(channel)) { //spin up the container and route
        res.status(500).send('error creating tenant'); //500 Internal Server Error
        return;
    }
    // await create_tenant_proxy(channel); //will be detected by the polling
    await redis_client.sAdd('channels', channel); //add it to the list of channels in redis
    console.log('onboarded', channel);
    res.send('ok');
});

app.get('/api/offboard/', async function (req, res) {
    res.status(400).send('missing channel'); //400 Bad Request
});

app.get('/api/offboard/:channel', channel_auth_middleware, async function (req, res) {
    const channel = req.params.channel;
    if (!channel) {
        res.status(400).send('invalid channel'); //400 Bad Request
        return;
    }
    if (!await redis_client.sIsMember('channels', channel)) {
        res.status(409).send('channel not onboarded'); //409 Conflict
        return;
    }
    if (!await delete_tenant_container(channel)) { //delete the container and route
        res.status(500).send('error deleting tenant'); //500 Internal Server Error
        return;
    }
    // await delete_tenant_proxy(channel); //will be detected by the polling
    await redis_client.del(`channels/${channel}/channel_props/did_first_run`); //remove the first run prop so it will execute the first run again if onboarded
    await redis_client.sRem('channels', channel); //remove it from the list of channels in redis
    console.log('offboarded', channel);
    res.send('ok');
});

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
        CHECK_FOR_CHANNEL_CHANGES_INTERVAL: CHECK_FOR_CHANNEL_CHANGES_INTERVAL,
    }));
});

// disabled for now as it interferes with the proxy routes being added later
// app.use((req, res) => {
//     const now = + new Date();
//     console.log('[main] 404', now, req.originalUrl);
//     res.status(404).send(`<h1>404 - Not Found</h1>
// <p>The requested URL was not found on this server.</p>
// <p>If this is your username, <a href="/api/auth/twitch">log in</a> to activate it.</p>
// <p><a href="/">back to homepage</a></p>
// <p>[main] timestamp: ${now}</p>`)
// });

//start the http server
server.listen(process.env.PORT ?? 80, () => {
    console.log('listening on *:' + (process.env.PORT ?? 80));
});
