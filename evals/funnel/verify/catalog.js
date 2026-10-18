// The controlled PRs of the frozen snapshot, each with the known bugs that reach verify, and its control pair.
const { catalogFor } = require('../catalog');

function catalog() {
    return catalogFor('verify');
}

module.exports = { catalog };
