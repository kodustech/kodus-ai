#!/usr/bin/env node
// funnel/severity: the frozen candidates that survived verify (snapshot.js)
// through the production severity pass — `classifySeverity` on the PR's
// findings in one call, then `survivesSeverityFilter` at the default threshold
// (`severityLevelFilter: medium`, default-kodus-config.yml), as
// agent-review.stage.ts runs them. A known bug is lost when every finding that
// matches it comes out below the threshold.
const { main } = require('../stage-run');
const { withCallErrors } = require('../../shared/eval-kit');

// The default threshold: medium and above survive.
const ACCEPTED = ['critical', 'high', 'medium'];

main({
    id: 'severity',
    usesModel: true,
    apply: async (input) => {
        const { classifySeverity } = require('../../../libs/code-review/infrastructure/agents/engine/classify-severity.ts');
        const { survivesSeverityFilter } = require('../../../libs/code-review/infrastructure/agents/engine/survives-severity-filter.ts');
        const { classifyLLMError, LlmErrorCategory } = require('../../../libs/llm/error-classifier.ts');
        const findings = input.map(({ finding: f }) => ({
            relevantFile: f.relevantFile || '',
            suggestionContent: f.suggestionContent || '',
            oneSentenceSummary: f.oneSentenceSummary || '',
            existingCode: f.existingCode || '',
            improvedCode: f.improvedCode || '',
        }));
        const { result: severities, errors } = await withCallErrors(() => classifySeverity(findings, undefined, undefined, 'funnel-eval'));
        // The classifier answers every finding 'medium' when its call fails, which
        // would read as a measurement; a refusal is a case that did not measure.
        const refused = errors.find((e) => ['AUTH_INVALID', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'MODEL_NOT_FOUND', 'MODEL_ACCESS_DENIED'].map((c) => LlmErrorCategory[c]).includes(classifyLLMError(e).category));
        if (refused) throw new Error(`severity call refused: ${String(refused.message || refused).slice(0, 160)}`);
        return input
            .map(({ finding }, k) => (survivesSeverityFilter({ ...finding, severity: severities.get(k) ?? finding.severity }, ACCEPTED, false) ? k : -1))
            .filter((k) => k >= 0);
    },
});
