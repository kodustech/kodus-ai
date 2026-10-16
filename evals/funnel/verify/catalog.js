// The nightly PRs of the frozen snapshot, each with the known bugs that reach verify.
const { catalogFor } = require('../catalog');

function catalog() {
    return catalogFor('verify', () => true);
}

module.exports = { catalog };
