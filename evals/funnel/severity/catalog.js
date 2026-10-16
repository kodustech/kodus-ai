// The nightly PRs of the frozen snapshot, each with the known bugs that reach severity, and its control pair.
const { catalogFor } = require('../catalog');

function catalog() {
    return catalogFor('severity');
}

module.exports = { catalog };
