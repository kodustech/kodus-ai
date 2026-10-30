#!/usr/bin/env node
// funnel/severity: what reached AgentReviewStage.reclassifyAndFilterSeverity in
// the snapshot's review (snapshot.js), through that method again on the eval's
// model: the severity classifier, then the team's threshold (the default
// config's, as the team kept it). A known bug is lost when every finding that
// matches it comes out below the threshold.
const { main, onTheStage } = require('../stage-run');

main({
    id: 'severity',
    usesModel: true,
    controlInput: (candidates) => ({ candidates }),
    apply: (env, frozen) => onTheStage(env, frozen, async (stage, input, context) => stage.reclassifyAndFilterSeverity(input, context, [])),
});
