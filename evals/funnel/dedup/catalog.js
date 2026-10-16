// The nightly PRs of the frozen snapshot, each with the known bugs that reach dedup, and its control pair.
const { catalogFor } = require('../catalog');

function catalog() {
    return catalogFor('dedup');
}

module.exports = { catalog };
