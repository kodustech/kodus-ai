#!/usr/bin/env node
// funnel/dedup: what reached AgentReviewStage.dedupSuggestionStreams in the
// snapshot's review (snapshot.js), through that method again on the eval's
// model: Kody Rule findings merged by rule, the others by the dedup model
// behind its merge guard (the platform's embedder for the semantic tier), then
// the cross-stream pass. A known bug is lost when every finding that matches it
// is merged away.
const { main, onTheStage } = require('../stage-run');

main({
    id: 'dedup',
    usesModel: true,
    embedder: true,
    controlInput: (candidates) => ({ candidates }),
    apply: (env, frozen) =>
        onTheStage(env, frozen, async (stage, input, context) => (await stage.dedupSuggestionStreams(input, context.pullRequest.number, context, undefined)).deduped),
});
