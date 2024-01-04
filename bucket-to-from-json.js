const SECRETS_FILE = '/srv/secret.env';
const JSON_DB_FILE = '/srv/data.json';

const dotenv = require('dotenv'); //for storing secrets in an env file
dotenv.config({ path: SECRETS_FILE }) //bot API key and other info

// const subdir = 'prod';
// const subdir = 'qa';
const subdir = process.env.BUCKET_FOLDER;

const { JsonDB, Config } = require('node-json-db');
const BucketDB = require('./bucket-db');

// The first argument is the database filename. If no extension is used, '.json' is assumed and automatically added.
// The second argument is used to tell the DB to save after each push
// If you set the second argument to false, you'll have to call the save() method.
// The third argument is used to ask JsonDB to save the database in a human readable format. (default false)
// The last argument is the separator. By default it's slash (/)
const jdb = new JsonDB(new Config(JSON_DB_FILE, false, true, '/'));
const bdb = new BucketDB(process.env.BUCKET_ACCESS_KEY, process.env.BUCKET_SECRET_KEY, process.env.BUCKET_ENDPOINT, process.env.BUCKET_NAME, subdir);

async function bucketToJson() {
    await jdb.load();
    const all = await bdb.find_with_values();
    console.log(all);
    for (const key of Object.keys(all)) {
        // Object.keys(all).forEach(async key => {
        const value = all[key];
        // try {
        //     value = JSON.parse(value)
        // } catch (err) {
        //     console.error('error, falling back to raw string value:', err);
        // }
        console.log('PUSH', '/' + key, value);
        await jdb.push('/' + key, value);
    }
    await jdb.save();

    // await jdb.load();
    // const keys = await bdb.find();
    // console.log(keys);
    // for (const key of keys) {
    //     const value = await bdb.get(key);
    //     console.log('PUSH', '/' + key, value);
    //     await jdb.push('/' + key, value);
    // }
    // await jdb.save();
}
async function jsonToBucket() {
    const data = await jdb.getData('/');
    jsonToBucketAux('', data);
}

async function jsonToBucketAux(path, data) {
    console.log('path:', path);
    Object.keys(data).forEach(key => {
        const value = data[key];
        console.log(' ', key, better_typeof(value));
        if (better_typeof(value) === 'Object') {
            jsonToBucketAux(path + '/' + key, value);
        } else {
            console.log(' ', 'SET', path + '/' + key, value);
            bdb.set(path + '/' + key, value);
        }
    });
}

function better_typeof(data) {
    if (data?.constructor === Array) return 'Array';
    if (data?.constructor === Object) return 'Object';
    return typeof (data); //for example, 'string', 'number', 'undefined', etc.
}

async function clearBucket() {
    const all = await bdb.find();
    console.log('old bucket data:', all);
    all.forEach(item => bdb.delete(item));
}

// clearBucket(); //warning: will delete everything in the bucket
// jsonToBucket(); //warning: will overwrite what is already in the bucket
// bucketToJson(); //warning: will overwrite what is already in the json file
