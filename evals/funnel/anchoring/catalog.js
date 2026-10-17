// The controlled PRs of the frozen snapshot, each with the known bugs that reach anchoring, and its control pair.
const { catalogFor } = require('../catalog');

function catalog() {
    return catalogFor('anchoring');
}

module.exports = { catalog };
