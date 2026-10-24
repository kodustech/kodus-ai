const fs = require('fs');
const os = require('os');
const path = require('path');

function valueFromFile(content, key) {
    for (const line of content.split('\n')) {
        const match = line.match(
            new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)`),
        );
        if (match) {
            return match[1]
                .replace(/\s+#.*$/, '')
                .trim()
                .replace(/^["']|["']$/g, '');
        }
    }
    return null;
}

function valueFromSources(key, { env, paths, readFile }) {
    if (env[key]) {
        return env[key];
    }
    for (const file of paths) {
        try {
            const value = valueFromFile(readFile(file, 'utf8'), key);
            if (value) {
                return value;
            }
        } catch {}
    }
    return null;
}

function loadLangfuseConfig(options = {}) {
    const root = options.root || path.resolve(__dirname, '../..');
    const paths = options.paths || [
        path.join(os.homedir(), '.kodus-dev', 'config'),
        path.join(root, '.env'),
    ];
    const source = {
        env: options.env || process.env,
        paths,
        readFile: options.readFile || fs.readFileSync,
    };
    return {
        publicKey: valueFromSources('LANGFUSE_PUBLIC_KEY', source),
        secretKey: valueFromSources('LANGFUSE_SECRET_KEY', source),
        baseUrl: (
            valueFromSources('LANGFUSE_BASE_URL', source) ||
            'https://us.cloud.langfuse.com'
        ).replace(/\/$/, ''),
    };
}

module.exports = { loadLangfuseConfig };
