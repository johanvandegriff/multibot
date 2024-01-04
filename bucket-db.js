const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, S3Client } = require('@aws-sdk/client-s3');

const streamToString = async (stream) => {
    const chunks = [];

    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString("utf-8");
}

const sanatizePath = (path) => {
    if (path.startsWith('/')) {
        path = path.replace('/', '');
    }
    return path.replaceAll('//', '/');
}

class BucketDB {
    constructor(accessKey, secretKey, endpoint, bucketName, subdir) {
        this.accessKey = accessKey;
        this.secretKey = secretKey;
        this.endpoint = endpoint;
        this.bucketName = bucketName;
        this.subdir = subdir;
        if (this.subdir !== '' && !this.subdir.endsWith('/')) {
            this.subdir += '/';
        }
        this.region = this.endpoint.replace('https://', '').replace('http://', '').split('.')[0]; // https://nyc3.digitaloceanspaces.com -> nyc3
        this.s3Client = new S3Client({
            endpoint: this.endpoint, // Find your endpoint in the control panel, under Settings. Prepend "https://".
            forcePathStyle: false, // Configures to use subdomain/virtual calling format.
            region: this.region, // Must be "us-east-1" when creating new Spaces. Otherwise, use the region in your endpoint (for example, nyc3).
            credentials: {
                accessKeyId: this.accessKey, // Access key pair. You can create access key pairs using the control panel or API.
                secretAccessKey: this.secretKey // Secret access key defined through an environment variable.
            }
        });
    }

    async set(path, value, json = true) {
        try {
            if (json) {
                value = JSON.stringify(value);
            }
            const params = {
                Bucket: this.bucketName, // The path to the directory you want to upload the object to, starting with your Space name.
                Key: sanatizePath(this.subdir + path), // Object key, referenced whenever you want to access this file later.
                Body: value, // The object's contents. This variable is an object, not a string.
                ACL: 'private', // Defines ACL permissions, such as private or public.
                // Metadata: { // Defines metadata tags.
                //     'x-amz-meta-my-key': 'your-value'
                // }
            };
            await this.s3Client.send(new PutObjectCommand(params));
        } catch (err) {
            console.error('[BucketDB] set error:', err);
        }
    }

    async get(path, default_value = undefined, json = true) {
        try {
            const data = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: sanatizePath(this.subdir + path) }));
            const res = await streamToString(data.Body);
            if (json) {
                return JSON.parse(res);
            } else {
                return res;
            }
        } catch (err) {
            if (err.Code !== 'NoSuchKey') { //don't log errors where there was simply no value stored yet
                console.error('[BucketDB] get error:', err);
            }
            return default_value;
        }
    }

    async find(path = '') {
        try {
            const data = await this.s3Client.send(new ListObjectsV2Command({ Bucket: this.bucketName, Prefix: sanatizePath(this.subdir + path) }));
            return (data.Contents ?? []).map(obj => obj.Key.replace(this.subdir, ''));
        } catch (err) {
            console.error('[BucketDB] find error:', err);
            return [];
        }
    }

    async find_with_values(path = '', json = true) {
        const res = {};
        for (const key of await this.find(path)) {
            res[key] = await this.get(key, undefined, json);
        }
        return res;
    }

    async list(path = '', indicate_dir = true) {
        if (!path.endsWith('/')) {
            path = path + '/';
        }
        path = sanatizePath(this.subdir + path);
        try {
            const data = await this.s3Client.send(new ListObjectsV2Command({ Bucket: this.bucketName, Prefix: path, Delimiter: '/' }));
            const res = [];
            (data.CommonPrefixes ?? []).forEach(p => res.push((p.Prefix.endsWith('/') && !indicate_dir) ? p.Prefix.slice(0, -1) : p.Prefix));
            (data.Contents ?? []).forEach(k => res.push(k.Key));
            return res.map(item => item.replace(path, ''));
        } catch (err) {
            console.error('[BucketDB] list error:', err);
            return [];
        }
    }

    async list_with_values(path = '', indicate_dir = true, json = true) {
        const res = {};
        for (const key of await this.list(path, indicate_dir)) {
            res[key] = await this.get(path + '/' + key, undefined, json);
        }
        return res;
    }

    async delete(path) {
        try {
            await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: sanatizePath(this.subdir + path) }));
        } catch (err) {
            console.error('[BucketDB] delete error:', err);
        }
    }
}

module.exports = BucketDB;
