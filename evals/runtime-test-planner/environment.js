const { devNull } = require('os');
const path = require('path');

/** Prevent production's transitive dotenv/config import from reading cwd/.env. */
function prepareEnvironment({ root, loadEnv = false, env = process.env, config }) {
    env.DOTENV_CONFIG_PATH = devNull;
    env.DOTENV_CONFIG_QUIET = 'true';
    if (!loadEnv) return;
    const load = config ?? require('dotenv').config;
    load({ path: path.join(root, '.env'), quiet: true, processEnv: env });
    load({ path: path.join(root, '.env.local'), override: true, quiet: true, processEnv: env });
    if (env.HOME) load({ path: path.join(env.HOME, '.kodus-dev/config'), override: true, quiet: true, processEnv: env });
    env.DOTENV_CONFIG_PATH = devNull;
    env.DOTENV_CONFIG_QUIET = 'true';
}

module.exports = { prepareEnvironment };
