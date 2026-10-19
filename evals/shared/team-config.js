// A team's review config for an eval run, given as a visible argument
// (`--team-config=<file>`), never an environment variable: the file holds the
// keys a team saves (codeReviewConfig.configs, the shape production stores), the
// eval stores them the way production does, and the result records them and
// their hash, so what ran is never assumed (evals/README.md, "Experiments").
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The same JSON whatever order its keys were written in.
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

const teamConfigHash = (configs) => crypto.createHash('sha1').update(canonical(configs)).digest('hex').slice(0, 12);

/** The file's configs and their hash; throws when it is not a JSON object. */
function readTeamConfig(file) {
    const abs = path.resolve(file);
    let configs;
    try {
        configs = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (error) {
        throw new Error(`--team-config=${file}: not a readable JSON file (${error.message})`);
    }
    if (!configs || typeof configs !== 'object' || Array.isArray(configs) || !Object.keys(configs).length) {
        throw new Error(`--team-config=${file}: must be a JSON object of the review config keys a team saves`);
    }
    return { file: abs, configs, hash: teamConfigHash(configs) };
}

module.exports = { readTeamConfig, teamConfigHash, canonical };
