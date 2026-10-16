// Loads every spec in ./cases and builds the cases (see build.js).
const fs = require('fs');
const path = require('path');
const { build, problems } = require('./build');

function loadSpecs() {
    const dir = path.join(__dirname, 'cases');
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.js'))
        .sort()
        .flatMap((f) => require(path.join(dir, f)).map((s) => ({ ...s, source: f })));
}

function prodShapeCases() {
    return loadSpecs().flatMap(build);
}

module.exports = { loadSpecs, prodShapeCases, problems };
