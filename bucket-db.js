const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, S3Client } = require('@aws-sdk/client-s3');

// Helper function to convert stream to string
const streamToString = (stream) => new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
});

const sanatizePath = (path) => {
    if (path.startsWith('/')) {
        path = path.replace('/', '');
    }
    return path.replaceAll('//', '/');
}

// const validatePath = (path) => {
//     if (path.startsWith('/')) {
//         throw 'error: path starts with /: ' + path;
//     }
//     if (path.includes('//')) {
//         throw 'error: // in path: ' + path;
//     }
// }

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

    async set(path, value) {
        // validatePath(path);
        try {
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

    async get(path, default_value = undefined) {
        // validatePath(path);
        try {
            const data = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: sanatizePath(this.subdir + path), }));
            return await streamToString(data.Body);
        } catch (err) {
            if (err.Code !== 'NoSuchKey') { //don't log errors where there was simply no value stored yet
                console.error('[BucketDB] get error:', err);
            }
            return default_value;
        }
    }

    async find(path = '') {
        // validatePath(path);
        try {
            const data = await this.s3Client.send(new ListObjectsV2Command({ Bucket: this.bucketName, Prefix: sanatizePath(this.subdir + path), }));
            return (data.Contents ?? []).map(obj => obj.Key.replace(this.subdir, ''));
        } catch (err) {
            console.error('[BucketDB] get error:', err);
            return [];
        }
    }

    async list(path = '') {
        const found = await this.find(path);
        path = sanatizePath(path);
        const result = new Set();
        if (path !== '' && !path.endsWith('/')) {
            path += '/';
        }
        found.forEach(filePath => {
            if (filePath.startsWith(path)) {
                const subPath = filePath.slice(path.length);
                const firstSlashIndex = subPath.indexOf('/');
                if (firstSlashIndex !== -1) {
                    result.add(subPath.slice(0, firstSlashIndex));
                } else {
                    result.add(subPath);
                }
            }
        });
        return Array.from(result);
    }

    async delete(path) {
        // validatePath(path);
        try {
            await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: sanatizePath(this.subdir + path), }));
        } catch (err) {
            console.error('[BucketDB] delete error:', err);
        }
    }
}

module.exports = BucketDB;
