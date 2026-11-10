// The repo's .env, then .env.local over it. A value that is a 1Password
// reference (op://...) is resolved by `op run`, which has already put the key
// in the environment: it is never written over that key.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function loadEnv(root = path.join(__dirname, '../..')) {
    for (const [file, override] of [['.env', false], ['.env.local', true]]) {
        const full = path.join(root, file);
        if (!fs.existsSync(full)) continue;
        for (const [name, value] of Object.entries(dotenv.parse(fs.readFileSync(full)))) {
            if (value.startsWith('op://')) continue;
            if (override || process.env[name] === undefined) process.env[name] = value;
        }
    }
}

module.exports = { loadEnv };
