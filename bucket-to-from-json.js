const SECRETS_FILE = '/srv/secret.env';
const JSON_DB_FILE = '/srv/data.json';

const fs = require('fs');
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
    for (const item of all) {
        await bdb.delete(item);
    }
}

async function clearJson() {
    fs.writeFileSync(JSON_DB_FILE, JSON.stringify({}));
}

(async () => {
    const start = + new Date();

    // const all = await bdb.find();
    // console.log('find', all);
    // // all.forEach(item => bdb.delete(item));

    // await bdb.set('test/123.txt', 'abcd');
    // console.log(await bdb.get('test/1234.txt'));
    // await bdb.delete('test/123.txt');
    // console.log(await bdb.get('test/123.txt', 'geese'));

    // console.log('find', await bdb.find());
    // console.log('list', await bdb.list('channels', false));
    // console.log('list', await bdb.list('channels/jjvanvan', false));
    // console.log('list', await bdb.list('channels/jjvanvan', true));
    // console.log('list', await bdb.list('channels/jjvanvan/nickname', true));


    // console.log('find', await bdb.find('channels/jjvanvan'));
    // console.log('list', await bdb.list('channels/jjvanvan'));
    // console.log('list', await bdb.list('channels/jjvanvan/nickname'));
    // console.log(await bdb.get('channels/jjvanvan/enabled'));
    // console.log(await bdb.get('channels/jjvanvan/nickname/JJvanTheMan'));

    // // NOTE: find_with_values is very slow and gets slower with more data in the bucket
    // console.log(await bdb.find_with_values());

    // // NOTE: list_with_values is somewhat slow and gets slower with more data in the folder being listed
    // console.log(await bdb.list_with_values());
    // console.log(await bdb.list_with_values('channels'));
    // console.log(await bdb.list_with_values('channels/jjvanvan'));
    // console.log(await bdb.list_with_values('channels/jjvanvan/nickname'));

    // let val = [1,2,3];
    // await bdb.set('test/123.txt', val);
    // console.log(await bdb.get('test/123.txt'));
    // await bdb.delete('test/123.txt');
    // console.log(val);

    // await clearBucket(); //warning: will delete everything in the bucket
    // await jsonToBucket(); //warning: will overwrite what is already in the bucket

    await clearJson(); //warning: will delete everything in the json file
    await bucketToJson(); //warning: will overwrite what is already in the json file

    console.log(+ new Date() - start);
})();
