#!/usr/bin/env node
// funnel/anchoring: what reached AgentReviewStage.anchorSuggestionsToDiff in
// the snapshot's review (snapshot.js), through that method again on the PR's
// changed files as FetchChangedFilesStage renders them: a finding is snapped
// to a changed hunk, or dropped when its lines touch none. A known bug is lost
// when every finding that matches it is dropped. No model call.
const { main, onTheStage } = require('../stage-run');

main({
    id: 'anchoring',
    controlInput: (candidates) => ({ candidates, kodyRules: [] }),
    apply: (env, frozen) =>
        onTheStage(env, frozen, async (stage, input, context) => stage.anchorSuggestionsToDiff(input, context.changedFiles, frozen.kodyRules || [], [])),
});
