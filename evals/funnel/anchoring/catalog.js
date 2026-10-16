// The nightly PRs of the frozen snapshot, each with the known bugs that reach anchoring.
const { catalogFor } = require('../catalog');

function catalog() {
    return catalogFor('anchoring');
}

module.exports = { catalog };
